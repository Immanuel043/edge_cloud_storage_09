"""
Video Ingestion Service

Proactive video optimization coordinator.
Called immediately after successful upload to queue videos for background processing.

This ensures zero-latency playback by transcoding/optimizing videos BEFORE users click play,
instead of the reactive approach that caused 5+ second delays.

Pipeline:
1. Upload completes → on_upload_complete() queues job via Kafka
2. Background worker picks up job → process_video() runs
3. Smart decision tree:
   - Path A (Perfect): H.264+AAC MP4 → Apply faststart only (~2-5s)
   - Path B (Remux): Compatible codecs, wrong container → Fast remux (~5-10s)
   - Path C (Transcode): HEVC/Other → Full transcode (~1-5min)
   - Path D (Reject): Too large/corrupt → Mark as failed
4. User clicks Play → Instant stream from pre-optimized file
"""

import asyncio
import json
import logging
import os
import shutil
from datetime import datetime
from typing import Optional, Dict, Any

from aiokafka import AIOKafkaProducer

logger = logging.getLogger(__name__)


def _check_disk_space(required_bytes: int, path: str = '/tmp') -> bool:
    """Check if sufficient disk space is available for a temp file download."""
    try:
        usage = shutil.disk_usage(path)
        headroom = 1 * 1024 * 1024 * 1024  # 1GB headroom
        return usage.free >= (required_bytes + headroom)
    except OSError:
        return True  # Can't check → proceed optimistically


class VideoIngestionService:
    """
    Proactive video optimization coordinator.

    Orchestrates the video optimization pipeline by:
    1. Detecting if uploaded file is a video
    2. Queuing for background processing via Kafka
    3. Coordinating transcode/optimize operations
    4. Updating database status throughout
    """

    KAFKA_TOPIC = 'video-processing'
    OPTIMIZED_DIR = '/app/storage/optimized'

    # Size limits
    MAX_TRANSCODE_SIZE_GB = float(os.getenv('MAX_TRANSCODE_SIZE_GB', '2'))
    MAX_DURATION_MINUTES = int(os.getenv('MAX_TRANSCODE_DURATION_MINUTES', '30'))

    VIDEO_MIMETYPES = {
        'video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska',
        'video/webm', 'video/x-m4v', 'video/3gpp', 'video/3gpp2',
        'video/hevc', 'video/mpeg', 'video/ogg'
    }

    def __init__(self):
        os.makedirs(self.OPTIMIZED_DIR, exist_ok=True)

    def is_video(self, mime_type: Optional[str], file_name: Optional[str] = None) -> bool:
        """Check if file is a video based on MIME type or extension."""
        if mime_type and mime_type.lower() in self.VIDEO_MIMETYPES:
            return True

        if mime_type and mime_type.lower().startswith('video/'):
            return True

        if file_name:
            ext = os.path.splitext(file_name)[1].lower()
            video_exts = {'.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v',
                         '.3gp', '.3g2', '.hevc', '.mpeg', '.mpg', '.ogv', '.wmv'}
            if ext in video_exts:
                return True

        return False

    async def on_upload_complete(
        self,
        file_id: str,
        user_id: str,
        file_name: str,
        file_size: int,
        mime_type: Optional[str],
        kafka_producer: Optional[AIOKafkaProducer] = None
    ) -> Dict[str, Any]:
        """
        Main entry point - called immediately after successful upload.

        Fire-and-forget: Queues video for background processing and returns immediately.
        The upload HTTP request completes instantly for the user.

        Args:
            file_id: UUID of uploaded file
            user_id: UUID of file owner
            file_name: Original filename
            file_size: File size in bytes
            mime_type: MIME type of file
            kafka_producer: Kafka producer for queuing jobs

        Returns:
            {
                'queued': bool,
                'reason': str,
                'file_id': str
            }
        """
        # Check if this is a video file
        if not self.is_video(mime_type, file_name):
            return {
                'queued': False,
                'reason': 'not_video',
                'file_id': file_id
            }

        # Check user's video optimization preference
        # (This will be checked in the worker, but we can skip early if disabled)
        # For now, we always queue - worker will check preference

        # Check size limits
        file_size_gb = file_size / (1024 ** 3)
        if file_size_gb > self.MAX_TRANSCODE_SIZE_GB:
            logger.info(
                f"Video {file_name} ({file_size_gb:.1f}GB) exceeds transcode limit "
                f"({self.MAX_TRANSCODE_SIZE_GB}GB), skipping optimization"
            )
            return {
                'queued': False,
                'reason': 'too_large',
                'file_id': file_id,
                'size_gb': file_size_gb,
                'limit_gb': self.MAX_TRANSCODE_SIZE_GB
            }

        # Queue for background processing via Kafka
        if kafka_producer:
            try:
                message = {
                    'file_id': file_id,
                    'user_id': user_id,
                    'file_name': file_name,
                    'file_size': file_size,
                    'mime_type': mime_type,
                    'timestamp': datetime.utcnow().isoformat(),
                    'priority': self._calculate_priority(file_size)
                }

                await kafka_producer.send_and_wait(
                    self.KAFKA_TOPIC,
                    json.dumps(message).encode('utf-8')
                )

                logger.info(
                    f"Queued video for optimization: {file_name} "
                    f"({file_size / (1024*1024):.1f}MB) [file_id={file_id}]"
                )

                return {
                    'queued': True,
                    'reason': 'queued_for_processing',
                    'file_id': file_id,
                    'kafka_topic': self.KAFKA_TOPIC
                }

            except Exception as e:
                logger.error(f"Failed to queue video for processing: {e}")
                return {
                    'queued': False,
                    'reason': 'kafka_error',
                    'file_id': file_id,
                    'error': str(e)
                }
        else:
            logger.warning(
                f"Kafka producer not available, cannot queue video: {file_name}"
            )
            return {
                'queued': False,
                'reason': 'kafka_unavailable',
                'file_id': file_id
            }

    def _calculate_priority(self, file_size: int) -> int:
        """
        Calculate processing priority based on file size.

        Smaller files get higher priority (lower number = higher priority).
        This ensures quick videos are ready faster while large ones process in background.

        Priority levels:
        - 1: < 50MB (instant optimization expected)
        - 2: 50-200MB (quick optimization)
        - 3: 200MB-500MB (medium)
        - 4: 500MB-1GB (slow)
        - 5: > 1GB (very slow)
        """
        mb = file_size / (1024 * 1024)

        if mb < 50:
            return 1
        elif mb < 200:
            return 2
        elif mb < 500:
            return 3
        elif mb < 1024:
            return 4
        else:
            return 5

    def _get_optimization_mode(self, plan_features: dict | None) -> str:
        """Determine video optimization mode from plan features."""
        if not plan_features:
            return 'no_optimization'
        mode = plan_features.get('video_optimization', False)
        if mode in ('optimized', 'keep_both'):
            return mode
        return 'no_optimization'

    async def process_video(
        self,
        file_obj,
        user,
        encryption_service,
        db_session,
        plan_features: dict | None = None
    ) -> Dict[str, Any]:
        """
        Background processor - called by Kafka consumer worker.

        Executes the smart decision tree:
        1. Set DB status to 'processing'
        2. Probe file with ffprobe
        3. Route to appropriate path (skip/remux/transcode/reject)
        4. Generate thumbnails
        5. Handle storage preference (keep/replace)
        6. Set DB status to 'ready' or 'failed'

        Args:
            file_obj: Object model instance
            user: User model instance
            encryption_service: For decrypting file
            db_session: Database session for status updates

        Returns:
            {
                'success': bool,
                'action': str,  # 'skipped', 'faststart', 'remux', 'transcode', 'failed'
                'optimized_path': str,
                'optimized_size': int,
                'duration_seconds': float,
                'error': str (if failed)
            }
        """
        from .video_transcoder import video_transcoder, TranscodePolicy, VideoTranscodeError
        from .video_optimizer import video_optimizer
        from .preview_optimizer import preview_optimizer
        from .preview_generator import preview_generator

        file_id = str(file_obj.id)
        result = {
            'success': False,
            'action': 'pending',
            'file_id': file_id,
            'optimized_path': None,
            'optimized_size': None,
            'duration_seconds': 0
        }

        start_time = datetime.utcnow()

        try:
            # Check plan-derived optimization mode
            optimization_mode = self._get_optimization_mode(plan_features)
            if optimization_mode == 'no_optimization':
                logger.info(f"User {user.id} has video optimization disabled, skipping {file_obj.file_name}")
                file_obj.video_processing_status = 'skipped'
                await db_session.commit()
                result['action'] = 'skipped'
                result['success'] = True
                return result

            # Per-file lock: exclude concurrent dedup on the same file
            from ..utils.file_locks import get_file_lock

            lock = get_file_lock(file_id)

            async with lock:
                # Refresh file_obj from DB — if dedup ran while we waited on
                # the lock, chunk metadata and storage paths have changed.
                await db_session.refresh(file_obj)

                # Update status to processing
                file_obj.video_processing_status = 'processing'
                file_obj.video_processing_progress = 0
                await db_session.commit()

                logger.info(f"Processing video: {file_obj.file_name} ({file_obj.file_size / (1024*1024):.1f}MB)")

                # Step 1: Probe file to get codec info
                probe_data = await video_transcoder._probe_file_metadata(file_obj, encryption_service)

                # Step 2: Determine action
                decision = video_transcoder._needs_transcode(file_obj, probe_data)
                logger.info(f"Transcode decision for {file_obj.file_name}: {decision}")

                file_obj.video_processing_progress = 10
                await db_session.commit()

                # Step 3: Execute based on decision
                target_path = os.path.join(self.OPTIMIZED_DIR, f"{file_id}.mp4")

                if decision == 'skip':
                    result['action'] = 'skipped'
                    moov_at_end = probe_data.get('moov_at_end', False) if probe_data else False
                    is_fragmented = probe_data.get('is_fragmented', False) if probe_data else False

                    if (not moov_at_end and not is_fragmented
                            and file_obj.storage_type in ('chunked', 'content_addressed')):
                        # ---- OPTIMIZED PATH: moov-at-front + non-fMP4 + chunked/CAS ----
                        # Lightweight partial download (~64MB) for thumbnails only.
                        # No faststart needed (moov already at front).
                        # fMP4 excluded: fragmented MP4 needs all moof boxes for frame extraction.
                        partial_path = f"/tmp/skip_thumb_{file_id}.partial"
                        try:
                            built = await video_transcoder._build_thumbnail_probe_file(
                                file_obj, encryption_service, probe_data, partial_path,
                            )
                            if built:
                                try:
                                    sizes_cached = await video_transcoder._generate_thumbnails_for_transcoded(
                                        file_id, partial_path,
                                        source_hash=getattr(file_obj, 'content_hash', None),
                                        user_id=str(file_obj.user_id),
                                    )
                                    if sizes_cached > 0:
                                        file_obj.preview_generated_at = datetime.utcnow()
                                        file_obj.preview_content_hash = getattr(file_obj, 'content_hash', None)
                                except Exception as e:
                                    logger.warning(f"Thumbnail generation from partial failed for {file_id}: {e}")
                            else:
                                logger.warning(f"Could not build partial probe for {file_id}, thumbnails deferred")
                        finally:
                            if os.path.exists(partial_path):
                                os.remove(partial_path)

                    else:
                        # ---- FULL PATH: moov-at-end, fMP4, OR non-chunked storage ----
                        # Full download required for faststart (moov-at-end) or decryption (single).
                        if not _check_disk_space(file_obj.file_size or 0):
                            logger.error(f"Insufficient disk for skip-path of {file_obj.file_name}")
                            if moov_at_end:
                                # Moov-at-end REQUIRES faststart for acceptable playback.
                                # Reactive path returns None for skip, so without faststart
                                # the user would have to buffer the entire file. Fail so the
                                # job can be retried when disk space is available.
                                result['action'] = 'failed'
                                result['error'] = (
                                    f"Insufficient disk space for required faststart "
                                    f"({(file_obj.file_size or 0) / (1024**3):.1f}GB)"
                                )
                                file_obj.video_processing_status = 'failed'
                                file_obj.video_processing_error = result['error']
                                await db_session.commit()
                                return result
                            # moov-at-front / fMP4 / single: video is still playable
                            # from the original file, just skip thumbnails.
                        else:
                            temp_path = await preview_optimizer.download_full_file_for_transcode(
                                file_obj, encryption_service, db=db_session
                            )
                            try:
                                # Apply faststart if moov at end (uses probe flag, not buggy detect_moov)
                                if moov_at_end:
                                    try:
                                        success, optimized_path = await video_optimizer.apply_faststart(
                                            temp_path, target_path
                                        )
                                        if success:
                                            result['action'] = 'faststart'
                                            result['optimized_path'] = optimized_path
                                            result['optimized_size'] = os.path.getsize(optimized_path)
                                    except Exception as e:
                                        logger.warning(f"Faststart failed for {file_obj.file_name}: {e}")

                                # If faststart produced a separate optimized file, delete the
                                # source temp file now — thumbnails use optimized_path.
                                # Saves ~1.7GB of temp disk during thumbnail generation.
                                if result.get('optimized_path') and temp_path != result['optimized_path']:
                                    if os.path.exists(temp_path):
                                        os.remove(temp_path)
                                        logger.info(
                                            f"Early cleanup of temp source "
                                            f"({file_obj.file_size / (1024**3):.1f}GB) before thumbnail gen"
                                        )

                                # Generate thumbnails from best available path
                                thumb_path = result.get('optimized_path') or temp_path
                                if os.path.exists(thumb_path):
                                    try:
                                        sizes_cached = await video_transcoder._generate_thumbnails_for_transcoded(
                                            file_id, thumb_path,
                                            source_hash=getattr(file_obj, 'content_hash', None),
                                            user_id=str(file_obj.user_id),
                                        )
                                        if sizes_cached > 0:
                                            file_obj.preview_generated_at = datetime.utcnow()
                                            file_obj.preview_content_hash = getattr(file_obj, 'content_hash', None)
                                    except Exception as e:
                                        logger.warning(f"Thumbnail generation failed for {file_id}: {e}")
                            finally:
                                if os.path.exists(temp_path):
                                    os.remove(temp_path)

                elif decision == 'remux':
                    # Fast container remux (H.264+AAC in wrong container)
                    file_obj.video_processing_progress = 20
                    await db_session.commit()

                    if not _check_disk_space(file_obj.file_size or 0):
                        result['action'] = 'failed'
                        result['error'] = f"Insufficient disk space for remux ({(file_obj.file_size or 0) / (1024**3):.1f}GB)"
                        file_obj.video_processing_status = 'failed'
                        file_obj.video_processing_error = result['error']
                        await db_session.commit()
                        return result

                    temp_path = await preview_optimizer.download_full_file_for_transcode(
                        file_obj, encryption_service, db=db_session
                    )
                    try:
                        await video_transcoder._remux_without_transcode(
                            temp_path, target_path, file_id
                        )
                        result['action'] = 'remux'
                        result['optimized_path'] = target_path
                        result['optimized_size'] = os.path.getsize(target_path)
                    finally:
                        if os.path.exists(temp_path):
                            os.remove(temp_path)

                elif decision == 'transcode':
                    # Full re-encoding needed
                    file_obj.video_processing_progress = 20
                    await db_session.commit()

                    if not _check_disk_space(file_obj.file_size or 0):
                        result['action'] = 'failed'
                        result['error'] = f"Insufficient disk space for transcode ({(file_obj.file_size or 0) / (1024**3):.1f}GB)"
                        file_obj.video_processing_status = 'failed'
                        file_obj.video_processing_error = result['error']
                        await db_session.commit()
                        return result

                    # Select policy based on file size
                    file_size_mb = file_obj.file_size / (1024 * 1024)
                    policy = TranscodePolicy.select(file_size_mb)

                    temp_path = await preview_optimizer.download_full_file_for_transcode(
                        file_obj, encryption_service, db=db_session
                    )
                    try:
                        await video_transcoder._run_ffmpeg(
                            temp_path, target_path, policy, file_id
                        )
                        result['action'] = 'transcode'
                        result['optimized_path'] = target_path
                        result['optimized_size'] = os.path.getsize(target_path)
                    finally:
                        if os.path.exists(temp_path):
                            os.remove(temp_path)

                elif decision == 'reject':
                    # File exceeds limits
                    result['action'] = 'failed'
                    result['error'] = f"Video exceeds limits (max {self.MAX_TRANSCODE_SIZE_GB}GB or {self.MAX_DURATION_MINUTES} minutes)"
                    file_obj.video_processing_status = 'failed'
                    file_obj.video_processing_error = result['error']
                    await db_session.commit()
                    return result

                else:
                    result['action'] = 'failed'
                    result['error'] = f"Unknown transcode decision: {decision}"
                    file_obj.video_processing_status = 'failed'
                    file_obj.video_processing_error = result['error']
                    await db_session.commit()
                    return result

                file_obj.video_processing_progress = 80
                await db_session.commit()

                # Step 4: Generate thumbnails
                try:
                    if result['optimized_path'] and os.path.exists(result['optimized_path']):
                        sizes_cached = await video_transcoder._generate_thumbnails_for_transcoded(
                            file_id, result['optimized_path'],
                            source_hash=getattr(file_obj, 'content_hash', None),
                            user_id=str(file_obj.user_id),
                        )
                        if sizes_cached > 0:
                            file_obj.preview_generated_at = datetime.utcnow()
                            file_obj.preview_content_hash = getattr(file_obj, 'content_hash', None)
                except Exception as e:
                    logger.warning(f"Thumbnail generation failed for {file_id}: {e}")

                file_obj.video_processing_progress = 90
                await db_session.commit()

                # Step 5: Storage mode is plan-gated (always keep both files on disk)
                # "optimized" plans: only optimized served to user
                # "keep_both" plans: user can also download original

                # Step 6: Update final status
                end_time = datetime.utcnow()
                duration = (end_time - start_time).total_seconds()
                result['duration_seconds'] = duration

                file_obj.video_processing_status = 'ready'
                file_obj.video_processing_progress = 100
                file_obj.video_processing_error = None
                file_obj.optimized_path = result['optimized_path']
                file_obj.optimized_size = result['optimized_size']
                file_obj.video_processed_at = end_time
                await db_session.commit()

                result['success'] = True

                logger.info(
                    f"Video optimization complete: {file_obj.file_name} "
                    f"[action={result['action']}, duration={duration:.1f}s, "
                    f"optimized_size={(result.get('optimized_size') or 0) / (1024*1024):.1f}MB]"
                )

                return result

        except VideoTranscodeError as e:
            logger.error(f"VideoTranscodeError for {file_obj.file_name}: {e.message}")
            result['action'] = 'failed'
            result['error'] = e.message

            file_obj.video_processing_status = 'failed'
            file_obj.video_processing_error = e.message
            file_obj.video_processing_progress = None
            await db_session.commit()

            return result

        except Exception as e:
            logger.exception(f"Unexpected error processing video {file_obj.file_name}: {e}")
            result['action'] = 'failed'
            result['error'] = str(e)

            file_obj.video_processing_status = 'failed'
            file_obj.video_processing_error = str(e)[:500]  # Truncate long errors
            file_obj.video_processing_progress = None
            await db_session.commit()

            return result

    async def get_processing_status(self, file_obj) -> Dict[str, Any]:
        """
        Get current processing status for a video file.

        Used by frontend for polling progress.

        Returns:
            {
                'status': str,  # 'queued', 'processing', 'ready', 'failed', 'skipped', None
                'progress': int,  # 0-100
                'optimized_ready': bool,
                'error': str (if failed)
            }
        """
        status = file_obj.video_processing_status

        return {
            'status': status,
            'progress': file_obj.video_processing_progress or 0,
            'optimized_ready': status == 'ready' and file_obj.optimized_path is not None,
            'optimized_path': file_obj.optimized_path if status == 'ready' else None,
            'optimized_size': file_obj.optimized_size,
            'processed_at': file_obj.video_processed_at.isoformat() if file_obj.video_processed_at else None,
            'error': file_obj.video_processing_error if status == 'failed' else None
        }


# Global instance
video_ingestion_service = VideoIngestionService()
