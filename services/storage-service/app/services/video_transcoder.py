"""Video transcoding helper to produce browser-friendly MP4 streams."""

import os
import asyncio
import logging
import subprocess
import copy
import json
import re
from types import SimpleNamespace
from typing import Optional, Dict, List
from dataclasses import dataclass

from .preview_optimizer import preview_optimizer

logger = logging.getLogger(__name__)


class VideoTranscodeError(Exception):
    """Base exception for video transcoder issues."""

    def __init__(self, message: str, status_code: int = 500):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


@dataclass
class TranscodePolicy:
    """
    Policy for selecting ffmpeg transcode settings based on file characteristics.

    Tiers:
    - Tier 1 (<100MB): veryfast preset, CRF 23, no bitrate cap
    - Tier 2 (<1GB): fast preset, CRF 24, 4M max bitrate
    - Tier 3 (>1GB): ultrafast preset, CRF 25, 5M max bitrate
    """
    preset: str
    crf: int
    max_bitrate: Optional[str]
    tier: str

    @staticmethod
    def select(file_size_mb: float, duration_sec: float = 0,
               resolution: Optional[tuple] = None) -> 'TranscodePolicy':
        """
        Select transcoding policy based on file characteristics.

        Args:
            file_size_mb: File size in megabytes
            duration_sec: Video duration in seconds (optional, for future use)
            resolution: (width, height) tuple (optional, for future use)

        Returns:
            TranscodePolicy with preset, CRF, and bitrate settings
        """
        tier1_max = int(os.getenv("TRANSCODE_TIER1_MAX_SIZE_MB", "100"))
        tier2_max = int(os.getenv("TRANSCODE_TIER2_MAX_SIZE_MB", "1000"))
        tier3_preset = os.getenv("TRANSCODE_TIER3_PRESET", "ultrafast")

        # Tier 1: Small files - prioritize quality
        if file_size_mb < tier1_max:
            return TranscodePolicy(
                preset="veryfast",
                crf=23,
                max_bitrate=None,
                tier="tier1"
            )

        # Tier 2: Medium files - balance quality and speed
        if file_size_mb < tier2_max:
            return TranscodePolicy(
                preset="fast",
                crf=24,
                max_bitrate="4M",
                tier="tier2"
            )

        # Tier 3: Large files - prioritize speed
        return TranscodePolicy(
            preset=tier3_preset,
            crf=25,
            max_bitrate="5M",
            tier="tier3"
        )

    def to_ffmpeg_args(self) -> List[str]:
        """Convert policy to ffmpeg command-line arguments."""
        args = ['-preset', self.preset, '-crf', str(self.crf)]
        if self.max_bitrate:
            args.extend(['-maxrate', self.max_bitrate, '-bufsize', self.max_bitrate])
        return args


class VideoTranscoder:
    """
    Ensures videos are streamable by browsers that lack HEVC/MOV support.

    Strategy:
    - Detect problematic containers (MOV/QuickTime/etc.)
    - Transcode once to H.264/AAC MP4 with ffmpeg (async background job)
    - Cache results under /app/storage/transcoded
    - Serve cached artifact for future requests
    """

    INCOMPATIBLE_EXTS = {'.mov', '.qt', '.m4v', '.3gp', '.3g2', '.hevc'}
    INCOMPATIBLE_MIMES = {
        'video/quicktime',
        'video/x-m4v',
        'video/3gpp',
        'video/3gpp2',
        'video/hevc'
    }
    OUTPUT_DIR = "/app/storage/transcoded"
    MAX_TRANSCODE_SIZE = 5 * 1024 * 1024 * 1024  # 5GB safety limit

    def __init__(self):
        os.makedirs(self.OUTPUT_DIR, exist_ok=True)
        self._locks: Dict[str, asyncio.Lock] = {}
        self._inflight: Dict[str, asyncio.Task] = {}
        self._progress: Dict[str, dict] = {}  # Track transcoding progress

        # Global concurrency control
        max_concurrent = int(os.getenv("MAX_CONCURRENT_TRANSCODES", "2"))
        self._transcode_semaphore = asyncio.Semaphore(max_concurrent)

        # Queue for waiting requests
        max_queue_size = int(os.getenv("TRANSCODE_QUEUE_MAX_SIZE", "5"))
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=max_queue_size)
        self._queue_position: Dict[str, int] = {}

    def _lock_for(self, file_id: str) -> asyncio.Lock:
        if file_id not in self._locks:
            self._locks[file_id] = asyncio.Lock()
        return self._locks[file_id]

    def _target_path(self, file_obj) -> str:
        return os.path.join(self.OUTPUT_DIR, f"{file_obj.id}.mp4")

    def _needs_transcode(self, file_obj, probe_data: Optional[Dict] = None) -> str:
        """
        Determine if file needs transcoding based on probe data and heuristics.

        Args:
            file_obj: File object with metadata
            probe_data: Optional ffprobe metadata

        Returns:
            'skip': No transcode needed (already MP4 with h264+aac)
            'remux': Compatible codecs but incompatible container (fast copy)
            'transcode': Needs full re-encoding
            'reject': File exceeds limits (too large/long)
        """
        # Check size and duration limits first (reject early)
        max_size_gb = float(os.getenv("TRANSCODE_MAX_SIZE_GB", "2"))
        max_duration_min = int(os.getenv("TRANSCODE_MAX_DURATION_MINUTES", "30"))

        file_size_gb = (file_obj.file_size or 0) / (1024 ** 3)
        if file_size_gb > max_size_gb:
            return 'reject'

        if probe_data:
            duration_min = probe_data.get('duration', 0) / 60
            if duration_min > max_duration_min:
                return 'reject'

            # Check if codecs are compatible (h264+aac)
            codec = probe_data.get('codec_name', '').lower()
            audio_codec = probe_data.get('audio_codec', '').lower()

            if codec == 'h264' and audio_codec in ('aac', 'mp4a'):
                # Check if remux optimization is enabled
                enable_remux = os.getenv("ENABLE_REMUX_OPTIMIZATION", "true").lower() == "true"

                # Check container format
                ext = os.path.splitext(file_obj.file_name or '')[1].lower()
                mime = (file_obj.mime_type or '').lower()

                # If compatible codecs but incompatible container, use fast remux
                if enable_remux and (ext in self.INCOMPATIBLE_EXTS or mime in self.INCOMPATIBLE_MIMES):
                    logger.info(f"⚡ Fast remux for {file_obj.file_name} - h264+aac in {ext} container")
                    return 'remux'

                # Already in compatible format (MP4 with h264+aac)
                logger.info(f"✓ Skipping transcode for {file_obj.file_name} - already MP4 with h264+aac")
                return 'skip'

        # Fallback to extension/MIME check (existing logic)
        mime = (file_obj.mime_type or '').lower()
        ext = os.path.splitext(file_obj.file_name or '')[1].lower()

        if mime in self.INCOMPATIBLE_MIMES or ext in self.INCOMPATIBLE_EXTS:
            return 'transcode'

        return 'skip'

    def _snapshot(self, file_obj):
        return SimpleNamespace(
            id=str(file_obj.id),
            file_name=file_obj.file_name,
            file_size=file_obj.file_size,
            mime_type=file_obj.mime_type,
            encryption_key=file_obj.encryption_key,
            storage_type=file_obj.storage_type,
            chunk_info=copy.deepcopy(file_obj.chunk_info),
            file_metadata=copy.deepcopy(file_obj.file_metadata),
            object_path=file_obj.object_path
        )

    async def _probe_file_metadata(self, file_obj, encryption_service) -> Optional[Dict]:
        """
        Fast ffprobe inspection to extract codec, duration, resolution.
        Falls back to None if probe fails (encrypted, corrupted, etc.).

        Returns dict with: codec_name, audio_codec, duration, width, height, bitrate
        Returns None on failure (don't block transcode)
        """
        if not os.getenv("ENABLE_SMART_TRANSCODE", "true").lower() == "true":
            return None

        probe_path = None
        try:
            # For chunked files, download just first chunk (fast path)
            if file_obj.storage_type in ("chunked", "content_addressed"):
                # Skip probe for chunked - too complex to handle encrypted chunks
                return None

            # For single files, try probing the file directly
            if file_obj.storage_type == "single" and file_obj.object_path:
                probe_path = file_obj.object_path
            else:
                # Can't probe inline or complex storage
                return None

            # Run ffprobe (timeout after 5 seconds)
            cmd = [
                'ffprobe',
                '-v', 'quiet',
                '-print_format', 'json',
                '-show_format',
                '-show_streams',
                probe_path
            ]

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=5
            )

            if result.returncode != 0:
                return None

            data = json.loads(result.stdout)
            video_stream = next((s for s in data.get('streams', []) if s.get('codec_type') == 'video'), None)
            audio_stream = next((s for s in data.get('streams', []) if s.get('codec_type') == 'audio'), None)
            format_info = data.get('format', {})

            if not video_stream:
                return None

            return {
                'codec_name': video_stream.get('codec_name'),
                'audio_codec': audio_stream.get('codec_name') if audio_stream else None,
                'duration': float(format_info.get('duration', 0)),
                'width': video_stream.get('width'),
                'height': video_stream.get('height'),
                'bitrate': int(format_info.get('bit_rate', 0))
            }

        except (subprocess.TimeoutExpired, json.JSONDecodeError, Exception) as e:
            logger.debug(f"Probe failed for {file_obj.file_name}, falling back to extension check: {e}")
            return None

    async def get_or_create_stream(self, file_obj, encryption_service) -> Optional[str]:
        """Return path to compatible MP4 stream, or None if not needed."""

        # Probe file metadata (with fallback to None if probe fails)
        probe_data = await self._probe_file_metadata(file_obj, encryption_service)

        # Make transcode decision based on probe data
        decision = self._needs_transcode(file_obj, probe_data)

        if decision == 'skip':
            # File is already compatible or doesn't need transcoding
            return None

        if decision == 'reject':
            # File exceeds size or duration limits
            max_size_gb = float(os.getenv("TRANSCODE_MAX_SIZE_GB", "2"))
            max_duration_min = int(os.getenv("TRANSCODE_MAX_DURATION_MINUTES", "30"))
            raise VideoTranscodeError(
                f"Video exceeds transcoding limits (max {max_size_gb}GB, {max_duration_min} minutes). Please download to play.",
                status_code=413
            )

        # decision == 'remux' or 'transcode' - proceed with processing
        if file_obj.file_size and file_obj.file_size > self.MAX_TRANSCODE_SIZE:
            raise VideoTranscodeError(
                "Video is too large to transcode automatically. Please download to play.",
                status_code=413
            )

        file_id = str(file_obj.id)
        target_path = self._target_path(file_obj)
        lock = self._lock_for(file_id)

        async with lock:
            if os.path.exists(target_path):
                logger.info(f"🎬 Using cached compatible stream for {file_obj.file_name}")
                return target_path

            task = self._inflight.get(file_id)
            if task:
                if task.done():
                    del self._inflight[file_id]
                    exc = task.exception()
                    if exc:
                        if isinstance(exc, VideoTranscodeError):
                            raise exc
                        raise VideoTranscodeError(
                            "Failed to prepare compatible video stream.",
                            status_code=500
                        )
                    if os.path.exists(target_path):
                        return target_path
                else:
                    raise VideoTranscodeError(
                        "Transcoding in progress. Please retry shortly.",
                        status_code=202
                    )

            # Check if transcode slot is available (non-blocking check)
            if self._transcode_semaphore.locked():
                # Calculate queue position
                queue_size = self._queue.qsize()
                position = queue_size + 1

                # Check if queue is full
                if queue_size >= self._queue.maxsize:
                    raise VideoTranscodeError(
                        "Transcoding system at capacity. Please try again later.",
                        status_code=429
                    )

                # Estimate wait time (5 minutes per position)
                est_wait_min = position * 5

                raise VideoTranscodeError(
                    f"Transcoding queue is full. Position: #{position}. "
                    f"Estimated wait: {est_wait_min} minutes. "
                    f"Keep this window open - transcoding will start automatically.",
                    status_code=202
                )

            snapshot = self._snapshot(file_obj)

            # Log appropriate message based on operation type
            if decision == 'remux':
                logger.info(f"⚡ Starting async remux for {snapshot.file_name}")
                user_message = "Fast container conversion started. This should complete in seconds."
            else:
                logger.info(f"🎬 Starting async transcode for {snapshot.file_name}")
                user_message = "Transcoding started. This can take a couple of minutes for large HEVC files."

            # Create task wrapped with semaphore
            async def transcode_with_semaphore():
                async with self._transcode_semaphore:
                    await self._transcode_snapshot(snapshot, encryption_service, target_path, decision)

            task = asyncio.create_task(transcode_with_semaphore())
            self._inflight[file_id] = task
            raise VideoTranscodeError(
                user_message,
                status_code=202
            )

    def _extract_field(self, buffer: str, pattern: str) -> Optional[str]:
        """Extract a field from ffmpeg progress output using regex."""
        match = re.search(pattern, buffer)
        return match.group(1) if match else None

    def _parse_time(self, time_str: str) -> float:
        """Parse ffmpeg time format (HH:MM:SS.MS) to seconds."""
        try:
            parts = time_str.split(':')
            if len(parts) == 3:
                hours, minutes, seconds = parts
                return float(hours) * 3600 + float(minutes) * 60 + float(seconds)
        except (ValueError, AttributeError):
            pass
        return 0.0

    async def _parse_ffmpeg_progress(self, stderr_reader, file_id: str, total_duration: float = 0):
        """Parse ffmpeg -progress output and update self._progress dict."""
        import time

        last_update = 0
        buffer = ""

        try:
            while True:
                chunk = await stderr_reader.read(1024)
                if not chunk:
                    break

                buffer += chunk.decode('utf-8', errors='ignore')

                # Rate limit: Update progress every 2 seconds
                now = time.time()
                if now - last_update > 2:
                    # Extract progress fields
                    frame = self._extract_field(buffer, r'frame=\s*(\d+)')
                    fps = self._extract_field(buffer, r'fps=\s*([\d.]+)')
                    time_str = self._extract_field(buffer, r'time=\s*([\d:\.]+)')

                    if frame and time_str:
                        elapsed = self._parse_time(time_str)
                        percent = (elapsed / total_duration * 100) if total_duration > 0 else 0
                        percent = min(percent, 99)  # Cap at 99% until done

                        eta_seconds = None
                        if fps and float(fps) > 0 and total_duration > 0:
                            remaining = total_duration - elapsed
                            eta_seconds = int(remaining / (elapsed / (now - self._progress[file_id].get('started_at', now))))

                        self._progress[file_id].update({
                            "frame": int(frame) if frame else 0,
                            "fps": float(fps) if fps else 0,
                            "elapsed": elapsed,
                            "percent": percent,
                            "eta_seconds": eta_seconds
                        })
                        last_update = now

        except Exception as e:
            logger.warning(f"Progress parsing error for {file_id}: {e}")

    def get_progress(self, file_id: str) -> Optional[dict]:
        """Get current transcoding progress for a file."""
        return self._progress.get(file_id)

    def is_cached(self, file_id: str) -> bool:
        """Check if transcoded file exists in cache."""
        target_path = os.path.join(self.OUTPUT_DIR, f"{file_id}.mp4")
        return os.path.exists(target_path)

    async def _transcode_snapshot(self, snapshot, encryption_service, target_path: str, decision: str = 'transcode'):
        file_id = snapshot.id
        temp_source = None

        try:
            # Fast path: Remux (copy codecs, fix container)
            if decision == 'remux':
                logger.info(f"⚡ Using fast remux path for {snapshot.file_name}")

                # Download full file to temp
                temp_source = await preview_optimizer.download_full_file_for_transcode(
                    file_obj=snapshot,
                    encryption_service=encryption_service
                )

                # Remux without re-encoding
                await self._remux_without_transcode(temp_source, target_path, file_id)
                logger.info(f"⚡ Compatible MP4 ready via remux for {snapshot.file_name}")
                return

            # Standard transcode path
            # Select transcoding policy based on file size
            file_size_mb = snapshot.file_size / (1024 * 1024)
            policy = TranscodePolicy.select(file_size_mb)

            # Log policy selection for observability
            logger.info(
                f"🎯 Selected transcode policy: {policy.tier} "
                f"(preset={policy.preset}, crf={policy.crf}) "
                f"for {snapshot.file_name} ({file_size_mb:.1f}MB)"
            )

            # Try streaming if feature flag is enabled and storage type supports it
            use_streaming = (
                os.getenv("ENABLE_STREAMING_DECRYPT", "false").lower() == "true"
                and snapshot.storage_type in ("chunked", "content_addressed", "deduplicated_reference")
            )

            if use_streaming:
                try:
                    logger.info(f"🚰 Attempting streaming transcode for {snapshot.file_name}")
                    await self._transcode_streaming(snapshot, encryption_service, target_path, policy, file_id)
                    logger.info(f"✓ Streaming transcode succeeded for {snapshot.file_name}")
                    return  # Success - exit early
                except Exception as e:
                    logger.warning(
                        f"⚠️ Streaming transcode failed for {snapshot.file_name}, "
                        f"falling back to temp file: {e}"
                    )
                    # Clean up partial output if it exists
                    if os.path.exists(target_path):
                        try:
                            os.remove(target_path)
                        except OSError:
                            pass
                    # Fall through to temp file approach

            # Default path: Download full file to temp, then transcode
            temp_source = await preview_optimizer.download_full_file_for_transcode(
                file_obj=snapshot,
                encryption_service=encryption_service
            )

            await self._run_ffmpeg(temp_source, target_path, policy, file_id)
            logger.info(f"🎬 Compatible MP4 ready for file {snapshot.file_name}")

        finally:
            if temp_source and os.path.exists(temp_source):
                try:
                    os.remove(temp_source)
                except OSError as exc:
                    logger.warning(f"Failed to remove temp video source {temp_source}: {exc}")
            self._inflight.pop(file_id, None)
            self._progress.pop(file_id, None)  # Cleanup progress tracking

    async def _run_ffmpeg(self, source_path: str, target_path: str,
                         policy: TranscodePolicy, file_id: str):
        """Execute ffmpeg transcode with async subprocess and progress tracking."""
        import time

        cmd = [
            'ffmpeg',
            '-y',
            '-i', source_path,
            '-c:v', 'libx264',
            *policy.to_ffmpeg_args(),  # Dynamic preset/crf from policy
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-max_muxing_queue_size', '1024',
            '-progress', 'pipe:2',  # Progress to stderr
            target_path
        ]

        logger.info(f"🎬 Starting ffmpeg transcode: {' '.join(cmd)}")

        # Initialize progress tracking
        self._progress[file_id] = {
            "percent": 0,
            "fps": 0,
            "frame": 0,
            "status": "transcoding",
            "started_at": time.time()
        }

        process = None
        try:
            # Create async subprocess
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )

            # Parse progress in background task
            parse_task = asyncio.create_task(
                self._parse_ffmpeg_progress(process.stderr, file_id, total_duration=0)
            )

            # Wait for completion with timeout
            returncode = await asyncio.wait_for(
                process.wait(),
                timeout=3600  # 1 hour timeout
            )

            # Ensure progress parser finishes
            await parse_task

            if returncode != 0:
                stderr = await process.stderr.read()
                logger.error(
                    f"ffmpeg failed for {source_path}: returncode={returncode}, "
                    f"stderr={stderr.decode('utf-8', errors='ignore')[:500]}"
                )
                # Clean up failed output
                if os.path.exists(target_path):
                    try:
                        os.remove(target_path)
                    except OSError:
                        pass
                raise VideoTranscodeError(
                    "Failed to prepare a browser-compatible video stream.",
                    status_code=500
                )

            # Validate output file
            await self._validate_output(target_path)

            # Update progress to 100%
            file_size = os.path.getsize(target_path)
            self._progress[file_id].update({
                "percent": 100,
                "status": "complete"
            })
            logger.info(f"🎬 Transcoding successful, output size: {file_size / (1024*1024):.1f}MB")

        except asyncio.TimeoutError:
            logger.error(f"ffmpeg timeout after 1 hour for {source_path}")
            if process and process.returncode is None:
                process.kill()
                await process.wait()
            if os.path.exists(target_path):
                try:
                    os.remove(target_path)
                except OSError:
                    pass
            raise VideoTranscodeError(
                "Video transcoding timed out. File may be too large or complex.",
                status_code=413
            )

        finally:
            # Ensure process is killed on any error
            if process and process.returncode is None:
                process.kill()
                await process.wait()

    async def _validate_output(self, target_path: str):
        """Validate transcoded output file."""
        # Check file exists
        if not os.path.exists(target_path):
            raise VideoTranscodeError(
                "Transcoding completed but output file is missing.",
                status_code=500
            )

        # Check file size
        file_size = os.path.getsize(target_path)
        if file_size < 1024:  # Less than 1KB is definitely corrupt
            logger.error(f"Transcoded file too small ({file_size} bytes), likely corrupt")
            os.remove(target_path)
            raise VideoTranscodeError(
                "Transcoding produced invalid output file.",
                status_code=500
            )

        # Verify moov atom using ffprobe
        verify_cmd = [
            'ffprobe',
            '-v', 'error',
            '-show_entries', 'format=format_name',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            target_path
        ]
        result = subprocess.run(verify_cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0 or not result.stdout.strip():
            logger.error(f"Transcoded file validation failed: {result.stderr}")
            os.remove(target_path)
            raise VideoTranscodeError(
                "Transcoding produced corrupted output file.",
                status_code=500
            )

    async def _remux_without_transcode(self, source_path: str, target_path: str, file_id: str):
        """
        Fast container remux without re-encoding (2-5 seconds for 400MB).

        Copies video/audio streams directly while fixing container format for browser compatibility.
        This is 100-500x faster than full transcoding for files already in H.264+AAC.
        """
        import time

        cmd = [
            'ffmpeg',
            '-y',
            '-i', source_path,
            '-c:v', 'copy',  # Copy video stream without re-encoding
            '-c:a', 'copy',  # Copy audio stream without re-encoding
            '-movflags', '+faststart',  # Enable streaming
            target_path
        ]

        logger.info(f"⚡ Starting fast remux (copy mode): {' '.join(cmd)}")

        # Initialize progress tracking
        self._progress[file_id] = {
            "percent": 50,  # Remux is so fast we just show 50% then 100%
            "fps": 0,
            "frame": 0,
            "status": "remuxing",
            "started_at": time.time()
        }

        process = None
        try:
            # Create async subprocess
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )

            # Wait for completion with timeout (remux should be very fast)
            returncode = await asyncio.wait_for(
                process.wait(),
                timeout=300  # 5 minute timeout (generous for large files)
            )

            if returncode != 0:
                stderr = await process.stderr.read()
                logger.error(
                    f"ffmpeg remux failed for {source_path}: returncode={returncode}, "
                    f"stderr={stderr.decode('utf-8', errors='ignore')[:500]}"
                )
                # Clean up failed output
                if os.path.exists(target_path):
                    try:
                        os.remove(target_path)
                    except OSError:
                        pass
                raise VideoTranscodeError(
                    "Failed to prepare browser-compatible container.",
                    status_code=500
                )

            # Validate output file
            await self._validate_output(target_path)

            # Update progress to 100%
            elapsed = time.time() - self._progress[file_id]['started_at']
            file_size = os.path.getsize(target_path)
            self._progress[file_id].update({
                "percent": 100,
                "status": "complete"
            })
            logger.info(f"⚡ Remux successful in {elapsed:.1f}s, output size: {file_size / (1024*1024):.1f}MB")

        except asyncio.TimeoutError:
            logger.error(f"ffmpeg remux timeout after 5 minutes for {source_path}")
            if process and process.returncode is None:
                process.kill()
                await process.wait()
            if os.path.exists(target_path):
                try:
                    os.remove(target_path)
                except OSError:
                    pass
            raise VideoTranscodeError(
                "Container remux timed out.",
                status_code=413
            )

        finally:
            # Ensure process is killed on any error
            if process and process.returncode is None:
                process.kill()
                await process.wait()


    async def _transcode_streaming(self, snapshot, encryption_service, target_path: str, policy: TranscodePolicy, file_id: str):
        """
        Stream 32MB chunks directly to ffmpeg stdin (no temp file).

        This eliminates temp file creation, saving 50% disk space and starting
        encoding while downloading chunks.
        """
        import aiofiles

        # Only works for chunked storage
        if snapshot.storage_type not in ("chunked", "content_addressed", "deduplicated_reference"):
            raise ValueError(f"Streaming not supported for storage_type: {snapshot.storage_type}")

        chunk_info = snapshot.chunk_info
        if not chunk_info:
            raise ValueError("Chunk info not found for chunked file")

        file_key = encryption_service.decrypt_key(snapshot.encryption_key)
        chunk_count = chunk_info.get("count", 0)
        chunk_paths = chunk_info.get("paths", {})

        logger.info(f"🚰 Starting streaming transcode for {snapshot.file_name} ({chunk_count} chunks)")

        cmd = [
            'ffmpeg',
            '-y',
            '-i', 'pipe:0',  # Read from stdin
            '-c:v', 'libx264',
            *policy.to_ffmpeg_args(),
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-max_muxing_queue_size', '1024',
            '-progress', 'pipe:2',
            target_path
        ]

        logger.info(f"🎬 Starting streaming ffmpeg: {' '.join(cmd)}")

        # Initialize progress tracking
        import time
        self._progress[file_id] = {
            "percent": 0,
            "fps": 0,
            "frame": 0,
            "status": "transcoding",
            "started_at": time.time()
        }

        process = None
        try:
            # Create async subprocess
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )

            # Parse progress in background
            parse_task = asyncio.create_task(
                self._parse_ffmpeg_progress(process.stderr, file_id, total_duration=0)
            )

            # Stream chunks to stdin
            was_compressed = chunk_info.get("compressed", False)

            for chunk_idx in range(chunk_count):
                chunk_path = chunk_paths.get(str(chunk_idx))
                if not chunk_path:
                    raise ValueError(f"Chunk {chunk_idx} path not found")

                # Load encrypted chunk (32MB)
                async with aiofiles.open(chunk_path, 'rb') as f:
                    encrypted_chunk = await f.read()

                # Decrypt chunk
                decrypted = encryption_service.decrypt_chunk(
                    encrypted_chunk, file_key, chunk_idx
                )

                # Decompress if needed
                if was_compressed:
                    from ..utils.compression import compressor
                    decrypted = compressor.decompress(decrypted)

                # Write to ffmpeg stdin with back-pressure handling
                process.stdin.write(decrypted)
                await process.stdin.drain()  # Wait if buffer is full

                # Log progress every 10 chunks
                if chunk_idx % 10 == 0:
                    logger.debug(f"Streamed {chunk_idx}/{chunk_count} chunks to ffmpeg")

            # Close stdin to signal EOF
            process.stdin.close()
            await process.stdin.wait_closed()

            logger.info(f"✓ Streamed all {chunk_count} chunks to ffmpeg, waiting for completion...")

            # Wait for completion with timeout
            returncode = await asyncio.wait_for(
                process.wait(),
                timeout=3600  # 1 hour timeout
            )

            # Ensure progress parser finishes
            await parse_task

            if returncode != 0:
                stderr = await process.stderr.read()
                raise VideoTranscodeError(
                    f"Streaming transcode failed: {stderr.decode('utf-8', errors='ignore')[:500]}",
                    status_code=500
                )

            # Validate output
            await self._validate_output(target_path)

            # Update progress to 100%
            file_size = os.path.getsize(target_path)
            self._progress[file_id].update({
                "percent": 100,
                "status": "complete"
            })
            logger.info(f"🚰 Streaming transcode successful, output size: {file_size / (1024*1024):.1f}MB")

        except asyncio.TimeoutError:
            logger.error(f"Streaming transcode timeout after 1 hour for {snapshot.file_name}")
            if process and process.returncode is None:
                process.kill()
                await process.wait()
            if os.path.exists(target_path):
                try:
                    os.remove(target_path)
                except OSError:
                    pass
            raise VideoTranscodeError(
                "Video transcoding timed out.",
                status_code=413
            )

        finally:
            # Ensure process is killed on any error
            if process and process.returncode is None:
                process.kill()
                await process.wait()


video_transcoder = VideoTranscoder()
