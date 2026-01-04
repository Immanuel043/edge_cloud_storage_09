"""
Background tasks for ZK storage cleanup
"""
import asyncio
from datetime import datetime, timedelta
from pathlib import Path
import shutil
import structlog

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db_context
from app.models.database import ZKObject
from app.config import settings

logger = structlog.get_logger(__name__)


async def cleanup_old_trash_files():
    """
    Permanently delete files that have been in trash for more than 30 days.
    Runs as a background task.
    """
    logger.info("cleanup_old_trash_start")

    # Calculate cutoff date (30 days ago)
    cutoff_date = datetime.utcnow() - timedelta(days=30)

    deleted_count = 0
    freed_bytes = 0

    try:
        async with get_db_context() as db:
            # Find files deleted more than 30 days ago
            result = await db.execute(
                select(ZKObject).where(
                    ZKObject.is_deleted == True,
                    ZKObject.updated_at < cutoff_date  # Using updated_at as deleted_at
                )
            )
            old_files = result.scalars().all()

            if not old_files:
                logger.info("cleanup_old_trash_complete", deleted_count=0)
                return

            logger.info(
                "cleanup_old_trash_found",
                file_count=len(old_files),
                cutoff_date=cutoff_date.isoformat()
            )

            # Delete each file
            for file_obj in old_files:
                try:
                    # Delete file data from storage
                    storage_dir = Path(settings.ZK_STORAGE_PATH) / str(file_obj.user_id) / str(file_obj.id)
                    if storage_dir.exists():
                        shutil.rmtree(storage_dir)
                        freed_bytes += file_obj.file_size
                        logger.info(
                            "cleanup_old_trash_file_deleted",
                            file_id=str(file_obj.id),
                            user_id=str(file_obj.user_id),
                            size=file_obj.file_size
                        )

                    # Delete database record
                    await db.delete(file_obj)
                    deleted_count += 1

                except Exception as e:
                    logger.error(
                        "cleanup_old_trash_file_failed",
                        file_id=str(file_obj.id),
                        user_id=str(file_obj.user_id),
                        error=str(e)
                    )

            # Commit deletions
            await db.commit()

            logger.info(
                "cleanup_old_trash_complete",
                deleted_count=deleted_count,
                freed_bytes=freed_bytes
            )

    except Exception as e:
        logger.error("cleanup_old_trash_error", error=str(e))


async def run_cleanup_tasks():
    """
    Run all cleanup tasks periodically
    """
    logger.info("cleanup_tasks_start")

    while True:
        try:
            # Run cleanup every 24 hours
            await cleanup_old_trash_files()

            # Wait 24 hours before next run
            await asyncio.sleep(24 * 60 * 60)

        except Exception as e:
            logger.error("cleanup_tasks_error", error=str(e))
            # Wait 1 hour before retrying on error
            await asyncio.sleep(60 * 60)
