"""
Orphan Cleanup Worker

Periodically cleans up expired upload sessions and their orphaned chunk files.
When upload sessions expire (1-hour TTL) without completion, encrypted chunk
files remain on disk forever. This worker reclaims that storage.

Runs every 5 minutes inside the main application lifespan.
"""

import asyncio
import os
import logging
from datetime import datetime
from typing import Optional

from sqlalchemy import select, delete as sa_delete
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.database import UploadSession
from ..database import async_session, get_redis

logger = logging.getLogger(__name__)


class OrphanCleanupWorker:
    """Background worker that cleans up expired upload sessions and orphan chunks."""

    def __init__(self):
        self.worker_task: Optional[asyncio.Task] = None
        self.is_running = False
        self.check_interval = 300  # 5 minutes

    async def start(self):
        if self.is_running:
            logger.warning("Orphan cleanup worker already running")
            return
        self.is_running = True
        self.worker_task = asyncio.create_task(self._run_worker())
        logger.info("Orphan cleanup worker started")

    async def stop(self):
        self.is_running = False
        if self.worker_task:
            self.worker_task.cancel()
            try:
                await self.worker_task
            except asyncio.CancelledError:
                pass
        logger.info("Orphan cleanup worker stopped")

    async def _run_worker(self):
        while self.is_running:
            try:
                await self._cleanup_cycle()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Orphan cleanup cycle failed: {e}", exc_info=True)
            await asyncio.sleep(self.check_interval)

    async def _cleanup_cycle(self):
        """Single cleanup cycle: find expired sessions, delete chunks, release quota."""
        redis_client = await get_redis()

        async with async_session() as db:
            # Find expired sessions
            result = await db.execute(
                select(UploadSession).where(
                    UploadSession.expires_at < datetime.utcnow()
                )
            )
            expired_sessions = result.scalars().all()

            if not expired_sessions:
                return

            logger.info(f"Found {len(expired_sessions)} expired upload sessions to clean up")

            cleaned = 0
            chunks_deleted = 0
            bytes_freed = 0

            for session_row in expired_sessions:
                try:
                    session_data = session_row.session_data
                    if not session_data:
                        # No data, just delete the row
                        await db.execute(
                            sa_delete(UploadSession).where(
                                UploadSession.upload_id == session_row.upload_id
                            )
                        )
                        cleaned += 1
                        continue

                    # Delete chunk files from disk
                    chunk_paths = session_data.get("chunk_paths", {})
                    for idx, path in chunk_paths.items():
                        if path and os.path.exists(path):
                            try:
                                file_size = os.path.getsize(path)
                                os.remove(path)
                                chunks_deleted += 1
                                bytes_freed += file_size
                            except OSError as e:
                                logger.warning(f"Failed to delete orphan chunk {path}: {e}")

                    # Also clean up single/inline storage paths
                    storage_path = session_data.get("storage_path")
                    if storage_path and os.path.exists(storage_path):
                        try:
                            file_size = os.path.getsize(storage_path)
                            os.remove(storage_path)
                            chunks_deleted += 1
                            bytes_freed += file_size
                        except OSError as e:
                            logger.warning(f"Failed to delete orphan file {storage_path}: {e}")

                    # Release quota reservation
                    user_id = session_data.get("user")
                    file_size = session_data.get("size", 0)
                    if user_id and file_size > 0:
                        try:
                            await redis_client.decrby(f"quota_reserved:{user_id}", file_size)
                        except Exception:
                            pass

                    # Delete the Redis key (may already be gone due to TTL)
                    try:
                        await redis_client.delete(f"up:{session_row.upload_id}")
                    except Exception:
                        pass

                    # Delete the DB row
                    await db.execute(
                        sa_delete(UploadSession).where(
                            UploadSession.upload_id == session_row.upload_id
                        )
                    )
                    cleaned += 1

                except Exception as e:
                    logger.error(
                        f"Failed to clean up session {session_row.upload_id}: {e}",
                        exc_info=True,
                    )

            await db.commit()

            if cleaned > 0:
                logger.info(
                    f"Orphan cleanup complete: {cleaned} sessions removed, "
                    f"{chunks_deleted} chunk files deleted, "
                    f"{bytes_freed / (1024 * 1024):.2f} MB freed"
                )


orphan_cleanup_worker = OrphanCleanupWorker()
