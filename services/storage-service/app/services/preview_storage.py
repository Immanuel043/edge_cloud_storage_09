"""
Preview Storage - Disk persistence and invalidation for preview assets.

Provides:
- save_preview_to_disk / load_preview_from_disk / delete_previews_from_disk
- invalidate_preview (eager, BEFORE commit)
- should_persist_preview (two-layer freshness guard)
- preview_cache_ttl (shared TTL helper)
"""

import logging
import os
import shutil
from typing import Optional

from ..utils.executors import run_in_heavy_pool

logger = logging.getLogger(__name__)

# Base directory for preview storage (inside shared volume)
PREVIEW_DIR = "/app/storage/previews"

# Cache TTLs
_TTL_VIDEO = 604_800      # 7 days
_TTL_DEFAULT = 2_592_000  # 30 days

# Invalidation marker TTL
_INVALIDATION_MARKER_TTL = 30  # seconds


# ---------------------------------------------------------------------------
# TTL helper
# ---------------------------------------------------------------------------

def preview_cache_ttl(mime_type: Optional[str]) -> int:
    """Return cache TTL in seconds: 7 days for video, 30 days otherwise."""
    if mime_type and mime_type.startswith("video/"):
        return _TTL_VIDEO
    return _TTL_DEFAULT


# ---------------------------------------------------------------------------
# Disk I/O helpers
# ---------------------------------------------------------------------------

def save_preview_to_disk(
    file_id: str, size: str, preview_bytes: bytes, content_hash: str
) -> None:
    """Persist a preview JPEG and its content-hash sidecar to disk."""
    try:
        dir_path = os.path.join(PREVIEW_DIR, file_id)
        os.makedirs(dir_path, exist_ok=True)

        jpeg_path = os.path.join(dir_path, f"{size}.jpg")
        with open(jpeg_path, "wb") as f:
            f.write(preview_bytes)

        hash_path = os.path.join(dir_path, ".content_hash")
        with open(hash_path, "w") as f:
            f.write(content_hash)
    except Exception:
        logger.warning(
            "Failed to save preview to disk for file_id=%s size=%s",
            file_id, size, exc_info=True,
        )


def load_preview_from_disk(file_id: str, size: str) -> Optional[bytes]:
    """Load a preview JPEG from disk, or return None if absent."""
    try:
        jpeg_path = os.path.join(PREVIEW_DIR, file_id, f"{size}.jpg")
        with open(jpeg_path, "rb") as f:
            return f.read()
    except FileNotFoundError:
        return None
    except Exception:
        logger.warning(
            "Failed to load preview from disk for file_id=%s size=%s",
            file_id, size, exc_info=True,
        )
        return None


def get_disk_content_hash(file_id: str) -> Optional[str]:
    """Read the .content_hash sidecar file for a preview directory."""
    try:
        hash_path = os.path.join(PREVIEW_DIR, file_id, ".content_hash")
        with open(hash_path, "r") as f:
            return f.read().strip()
    except FileNotFoundError:
        return None
    except Exception:
        logger.warning(
            "Failed to read disk content hash for file_id=%s",
            file_id, exc_info=True,
        )
        return None


def delete_previews_from_disk(file_id: str) -> None:
    """Remove the entire preview directory for a file."""
    try:
        dir_path = os.path.join(PREVIEW_DIR, file_id)
        shutil.rmtree(dir_path, ignore_errors=False)
    except FileNotFoundError:
        pass  # Already gone — nothing to do
    except Exception:
        logger.warning(
            "Failed to delete preview directory for file_id=%s",
            file_id, exc_info=True,
        )


# ---------------------------------------------------------------------------
# Async wrappers (use these from request handlers / async code)
# ---------------------------------------------------------------------------

async def async_save_preview_to_disk(
    file_id: str, size: str, preview_bytes: bytes, content_hash: str
) -> None:
    await run_in_heavy_pool(save_preview_to_disk, file_id, size, preview_bytes, content_hash)


async def async_load_preview_from_disk(file_id: str, size: str) -> Optional[bytes]:
    return await run_in_heavy_pool(load_preview_from_disk, file_id, size)


async def async_get_disk_content_hash(file_id: str) -> Optional[str]:
    return await run_in_heavy_pool(get_disk_content_hash, file_id)


async def async_delete_previews_from_disk(file_id: str) -> None:
    await run_in_heavy_pool(delete_previews_from_disk, file_id)


# ---------------------------------------------------------------------------
# Async invalidation (call BEFORE db.commit)
# ---------------------------------------------------------------------------

async def invalidate_preview(
    file_id: str,
    old_content_hash: str,
    redis,
    db_session=None,
) -> None:
    """Eagerly invalidate all cached/persisted preview assets for a file.

    Must be called BEFORE the DB transaction commits so that any in-flight
    preview generation still sees the old content_hash and gets blocked.

    Steps:
      1. Set identity-based Redis invalidation marker (30 s TTL).
      2. Delete Redis preview data keys (small / medium / large).
      3. Delete Redis preview status key.
      4. Delete disk preview files.
      5. (Optional) Null out preview columns on the Object row.
    """
    # 1. Invalidation marker keyed to the OLD content hash
    await redis.set(
        f"preview:blocked:{file_id}",
        old_content_hash,
        ex=_INVALIDATION_MARKER_TTL,
    )

    # 2. Delete cached preview data
    for size in ("small", "medium", "large"):
        await redis.delete(f"preview:{file_id}:{size}")

    # 3. Delete status key and notification guard
    await redis.delete(f"preview:status:{file_id}")
    await redis.delete(f"preview:notified:{file_id}")

    # 4. Disk cleanup (offloaded to thread pool)
    await async_delete_previews_from_disk(file_id)

    # 5. Null out DB preview columns if a session was provided
    if db_session is not None:
        try:
            from ..models.database import Object
            from sqlalchemy import update

            await db_session.execute(
                update(Object)
                .where(Object.id == file_id)
                .values(preview_generated_at=None, preview_content_hash=None)
            )
        except Exception:
            logger.warning(
                "Failed to null preview columns for file_id=%s",
                file_id, exc_info=True,
            )


# ---------------------------------------------------------------------------
# Two-layer freshness guard
# ---------------------------------------------------------------------------

async def _get_current_content_hash(file_id: str) -> Optional[str]:
    """Query the DB for the current content_hash of an Object row."""
    from ..database import async_session
    from ..models.database import Object
    from sqlalchemy import select

    async with async_session() as session:
        result = await session.execute(
            select(Object.content_hash).filter(Object.id == file_id)
        )
        row = result.scalar_one_or_none()
        return row  # Returns the content_hash string or None


async def should_persist_preview(
    file_id: str,
    source_hash: str,
    redis,
    allow_missing_row: bool = False,
) -> bool:
    """Two-layer freshness check before persisting a generated preview.

    Layer 1 - Redis invalidation marker with identity:
        If the marker exists AND its value matches *source_hash*, the writer
        is stale (the file was updated after this preview started generating).
        If the marker value differs, a new version was already committed and
        this generation is for the fresh content — allow through.

    Layer 2 - DB content_hash comparison:
        The Object row's current content_hash must still match source_hash.
        If the row is missing, *allow_missing_row* controls the outcome
        (True only for the upload-time path where the row may not yet exist).
    """
    # Layer 1 — Redis invalidation marker
    blocked_hash = await redis.get(f"preview:blocked:{file_id}")
    if blocked_hash is not None:
        blocked_hash = (
            blocked_hash.decode() if isinstance(blocked_hash, bytes) else blocked_hash
        )
        if blocked_hash == source_hash:
            return False  # This writer is stale
        # else: source_hash != blocked_hash -> fresh generation, allow through

    # Layer 2 — DB content_hash comparison
    current_hash = await _get_current_content_hash(file_id)
    if current_hash is None:
        return allow_missing_row  # True only for upload-time path
    return current_hash == source_hash
