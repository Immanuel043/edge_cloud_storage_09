"""
Preview Service - Central orchestrator for preview generation.

Provides two entry points:
1. generate_from_plaintext() - called at upload time (before encryption)
2. generate_on_demand()      - called on cache miss with singleflight dedup

Reuses existing preview_generator and preview_optimizer - no new generation logic.
"""

import asyncio
import logging
import os
import tempfile
import mimetypes
from typing import Optional, Tuple, Dict

import aiofiles

from .preview_generator import preview_generator
from .preview_optimizer import preview_optimizer

logger = logging.getLogger(__name__)

# Types eligible for preview generation (mirrors preview_generator supported types)
_PREVIEWABLE_MIMES = {
    'image/', 'video/', 'audio/', 'application/pdf',
}
_PREVIEWABLE_EXTS = (
    preview_generator.IMAGE_TYPES
    | preview_generator.VIDEO_TYPES
    | preview_generator.DOCUMENT_TYPES
    | preview_generator.AUDIO_TYPES
    | preview_generator.ARCHIVE_TYPES
    | preview_generator.CODE_TYPES
)

# Cache TTLs (match existing values in files.py)
_TTL_VIDEO = 604_800    # 7 days
_TTL_DEFAULT = 2_592_000  # 30 days

# Max file size for upload-time preview generation (larger files fall back to on-demand)
_MAX_PREVIEWABLE_SIZE = 25 * 1024 * 1024  # 25MB

# Singleflight timeout
_SINGLEFLIGHT_TIMEOUT = 30  # seconds


def _is_previewable(mime_type: Optional[str], file_name: Optional[str]) -> bool:
    """Check whether a file is eligible for preview generation."""
    mime = (mime_type or '').lower()
    ext = os.path.splitext((file_name or '').strip())[1].lower()

    if any(mime.startswith(prefix) for prefix in _PREVIEWABLE_MIMES):
        return True
    if ext in _PREVIEWABLE_EXTS:
        return True
    return False


def _cache_ttl(mime_type: Optional[str]) -> int:
    mime = (mime_type or '').lower()
    return _TTL_VIDEO if mime.startswith('video/') else _TTL_DEFAULT


class PreviewService:
    """Central preview orchestrator with singleflight dedup."""

    def __init__(self):
        # singleflight state: file_id -> asyncio.Future
        self._inflight: Dict[str, asyncio.Future] = {}
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Layer 1: Upload-time generation from plaintext
    # ------------------------------------------------------------------

    async def generate_from_plaintext(
        self,
        file_id: str,
        plaintext_data: bytes,
        mime_type: Optional[str],
        file_name: str,
        redis_client,
    ) -> None:
        """
        Generate all 3 preview sizes from plaintext data (pre-encryption).

        Fire-and-forget, non-fatal. Errors are logged but never raised.
        """
        try:
            if not _is_previewable(mime_type, file_name):
                return

            if len(plaintext_data) > _MAX_PREVIEWABLE_SIZE:
                logger.info(
                    f"Skipping upload-time preview for {file_name} "
                    f"({len(plaintext_data) / 1024 / 1024:.1f}MB > "
                    f"{_MAX_PREVIEWABLE_SIZE / 1024 / 1024:.0f}MB limit) — "
                    f"will generate on-demand"
                )
                return

            # Write plaintext to temp file for preview_generator
            ext = os.path.splitext((file_name or '').strip())[1].lower()
            temp_fd, temp_path = tempfile.mkstemp(suffix=ext)
            os.close(temp_fd)

            try:
                async with aiofiles.open(temp_path, 'wb') as f:
                    await f.write(plaintext_data)

                cached_count = 0
                ttl = _cache_ttl(mime_type)

                for size_name in ('small', 'medium', 'large'):
                    try:
                        preview_bytes, content_type = await preview_generator.generate_preview(
                            file_path=temp_path,
                            mime_type=mime_type,
                            size=size_name,
                            file_name=file_name,
                        )
                        cache_key = f"preview:{file_id}:{size_name}"
                        await redis_client.setex(cache_key, ttl, preview_bytes)
                        cached_count += 1
                    except Exception as exc:
                        logger.warning(
                            f"Preview generation failed for {file_name} "
                            f"(size={size_name}): {exc}"
                        )

                logger.info(
                    f"Pre-generated {cached_count}/3 previews for "
                    f"{file_name} at upload time"
                )

            finally:
                if os.path.exists(temp_path):
                    try:
                        os.remove(temp_path)
                    except OSError:
                        pass

        except Exception as exc:
            logger.error(f"generate_from_plaintext failed for {file_id}: {exc}", exc_info=True)

    # ------------------------------------------------------------------
    # Layers 2+3: On-demand generation with singleflight
    # ------------------------------------------------------------------

    async def generate_on_demand(
        self,
        file_id: str,
        file_obj,
        requested_size: str,
        redis_client,
    ) -> Optional[Tuple[bytes, str]]:
        """
        Generate preview on cache miss with singleflight dedup.

        Concurrent requests for the same file_id share a single generation.
        All 3 sizes are generated and cached at once.

        Returns (preview_bytes, content_type) for requested_size, or None
        if generation is not possible (e.g. too-large video queued to Kafka).
        """
        from .encryption import encryption_service

        # Check if another request is already generating for this file
        is_leader = False
        async with self._lock:
            if file_id in self._inflight:
                existing_fut = self._inflight[file_id]
            else:
                existing_fut = asyncio.get_event_loop().create_future()
                self._inflight[file_id] = existing_fut
                is_leader = True

        if not is_leader:
            # Follower path: wait for leader to finish
            try:
                await asyncio.wait_for(
                    asyncio.shield(existing_fut),
                    timeout=_SINGLEFLIGHT_TIMEOUT,
                )
            except asyncio.TimeoutError:
                logger.warning(f"Singleflight timeout waiting for {file_id}")
                return None
            except Exception:
                pass  # Leader failed, fall through to check cache

            # Leader should have cached our size — read from cache
            cache_key = f"preview:{file_id}:{requested_size}"
            cached = await redis_client.get(cache_key)
            if cached:
                return cached, 'image/jpeg'
            return None

        # Leader path: do the actual generation
        try:
            result = await self._do_generate_all_sizes(
                file_id=file_id,
                file_obj=file_obj,
                redis_client=redis_client,
                encryption_service=encryption_service,
            )

            # Resolve the future so followers unblock
            async with self._lock:
                if file_id in self._inflight:
                    self._inflight[file_id].set_result(True)

            if result is None:
                return None

            # Return the requested size
            size_data = result.get(requested_size)
            if size_data:
                return size_data  # (bytes, content_type)
            return None

        except Exception as exc:
            logger.error(f"Singleflight generation failed for {file_id}: {exc}", exc_info=True)
            # Resolve future with exception so followers don't hang
            async with self._lock:
                if file_id in self._inflight:
                    try:
                        self._inflight[file_id].set_exception(exc)
                    except asyncio.InvalidStateError:
                        pass
            return None

        finally:
            # Cleanup singleflight entry
            async with self._lock:
                fut = self._inflight.pop(file_id, None)
                if fut and not fut.done():
                    fut.cancel()

    async def generate_on_demand_background(
        self,
        file_id: str,
        file_obj,
        redis_client,
    ) -> None:
        """
        Background variant for chunked non-video uploads.
        Generates all sizes, logs errors but never raises.
        """
        try:
            from .encryption import encryption_service

            if not _is_previewable(file_obj.mime_type, file_obj.file_name):
                return

            await self._do_generate_all_sizes(
                file_id=file_id,
                file_obj=file_obj,
                redis_client=redis_client,
                encryption_service=encryption_service,
            )
        except Exception as exc:
            logger.error(
                f"Background preview generation failed for {file_id}: {exc}",
                exc_info=True,
            )

    async def _do_generate_all_sizes(
        self,
        file_id: str,
        file_obj,
        redis_client,
        encryption_service,
    ) -> Optional[Dict[str, Tuple[bytes, str]]]:
        """
        Download/decrypt the file and generate all 3 preview sizes.

        Returns dict of {size_name: (bytes, content_type)} or None if
        preview is not possible synchronously.
        """
        temp_file_path = None
        use_transcoded = False

        try:
            # Check for transcoded video first
            from .video_transcoder import video_transcoder

            mime = (file_obj.mime_type or '').lower()
            ext = os.path.splitext(file_obj.file_name or '')[1].lower()
            is_video = mime.startswith('video/') or ext in preview_generator.VIDEO_TYPES

            _LARGE_VIDEO_THRESHOLD = 50 * 1024 * 1024  # 50MB
            if is_video and file_obj.file_size > _LARGE_VIDEO_THRESHOLD:
                logger.info(
                    f"Skipping synchronous preview for large video {file_id} "
                    f"({file_obj.file_size / 1024 / 1024:.1f}MB) - use Kafka worker"
                )
                return None

            if is_video and video_transcoder.is_cached(file_id):
                transcoded_path = os.path.join(
                    video_transcoder.OUTPUT_DIR, f"{file_id}.mp4"
                )
                if os.path.exists(transcoded_path):
                    logger.info(f"Using transcoded MP4 for preview: {file_obj.file_name}")
                    temp_file_path = transcoded_path
                    use_transcoded = True

            if not use_transcoded:
                result = await preview_optimizer.download_partial_for_preview(
                    file_obj=file_obj,
                    encryption_service=encryption_service,
                )
                if result.status != 'ok':
                    return None
                temp_file_path = result.temp_file_path

            # Generate all 3 sizes
            ttl = _cache_ttl(file_obj.mime_type)
            results: Dict[str, Tuple[bytes, str]] = {}

            for size_name in ('small', 'medium', 'large'):
                try:
                    preview_bytes, content_type = await preview_generator.generate_preview(
                        file_path=temp_file_path,
                        mime_type='video/mp4' if use_transcoded else file_obj.mime_type,
                        size=size_name,
                        file_name=file_obj.file_name,
                    )
                    cache_key = f"preview:{file_id}:{size_name}"
                    await redis_client.setex(cache_key, ttl, preview_bytes)
                    results[size_name] = (preview_bytes, content_type)
                except Exception as exc:
                    logger.warning(
                        f"Preview size {size_name} failed for {file_id}: {exc}"
                    )

            if results:
                logger.info(
                    f"Generated {len(results)}/3 preview sizes for "
                    f"{file_obj.file_name} (singleflight)"
                )

            return results if results else None

        finally:
            if temp_file_path and not use_transcoded and os.path.exists(temp_file_path):
                try:
                    os.remove(temp_file_path)
                except OSError:
                    pass


# Global instance
preview_service = PreviewService()
