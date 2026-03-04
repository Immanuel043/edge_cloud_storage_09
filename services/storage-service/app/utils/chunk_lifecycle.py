"""
Redis-based chunk hold system for coordinating cleanup with preview generation.

Prevents race condition where background deduplication deletes chunk files
while preview workers are still reading them.

Keys:
    chunk_hold:{upload_id}:{holder_id} → "1" with TTL

Usage:
    hold_id = await acquire_chunk_hold(redis, upload_id, "preview_worker")
    try:
        ... read chunks ...
    finally:
        await release_chunk_hold(redis, upload_id, hold_id)
"""

import asyncio
import logging
import time
import uuid

logger = logging.getLogger(__name__)

HOLD_TTL_SECONDS = 600  # 10 minutes — auto-expire if worker crashes
GRACE_PERIOD_SECONDS = 300  # 5 minutes after upload completes
MAX_WAIT_SECONDS = 660  # 11 minutes total wait, then proceed anyway
POLL_INTERVAL_SECONDS = 10


async def acquire_chunk_hold(redis, upload_id: str, holder: str) -> str:
    """Acquire a hold on chunks for the given upload_id.

    Returns a unique hold_id that must be passed to release_chunk_hold().
    """
    hold_id = f"{holder}_{uuid.uuid4().hex[:8]}"
    key = f"chunk_hold:{upload_id}:{hold_id}"
    await redis.setex(key, HOLD_TTL_SECONDS, "1")
    logger.info(f"Acquired chunk hold: {key} (TTL={HOLD_TTL_SECONDS}s)")
    return hold_id


async def release_chunk_hold(redis, upload_id: str, hold_id: str) -> None:
    """Release a previously acquired chunk hold."""
    key = f"chunk_hold:{upload_id}:{hold_id}"
    deleted = await redis.delete(key)
    if deleted:
        logger.info(f"Released chunk hold: {key}")
    else:
        logger.debug(f"Chunk hold already expired: {key}")


async def can_cleanup_chunks(redis, upload_id: str, upload_completed_at: float) -> bool:
    """Check if it's safe to clean up chunks for the given upload.

    Returns True only when:
    1. No active holds exist for this upload_id
    2. The grace period since upload completion has elapsed
    """
    # Check grace period
    elapsed = time.time() - upload_completed_at
    if elapsed < GRACE_PERIOD_SECONDS:
        logger.debug(
            f"Grace period not elapsed for {upload_id}: "
            f"{elapsed:.0f}s / {GRACE_PERIOD_SECONDS}s"
        )
        return False

    # Check for active holds
    pattern = f"chunk_hold:{upload_id}:*"
    cursor = b"0"
    while True:
        cursor, keys = await redis.scan(cursor=cursor, match=pattern, count=100)
        if keys:
            logger.debug(f"Active holds found for {upload_id}: {len(keys)} keys")
            return False
        if cursor == b"0" or cursor == 0:
            break

    return True


async def wait_for_cleanup_ready(
    redis,
    upload_id: str,
    upload_completed_at: float,
) -> bool:
    """Poll until chunks are safe to clean up.

    Returns True when cleanup can proceed, or True after MAX_WAIT_SECONDS
    (forced cleanup to avoid permanent hold leaks).
    """
    start = time.time()

    while (time.time() - start) < MAX_WAIT_SECONDS:
        if await can_cleanup_chunks(redis, upload_id, upload_completed_at):
            logger.info(f"Chunks ready for cleanup: {upload_id}")
            return True
        logger.info(
            f"Waiting for chunk holds to clear: {upload_id} "
            f"(elapsed={time.time() - start:.0f}s)"
        )
        await asyncio.sleep(POLL_INTERVAL_SECONDS)

    logger.warning(
        f"Max wait exceeded for {upload_id} ({MAX_WAIT_SECONDS}s). "
        f"Proceeding with cleanup (possible stale holds)."
    )
    return True
