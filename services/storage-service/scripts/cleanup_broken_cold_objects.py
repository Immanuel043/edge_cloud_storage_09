"""One-off soft-delete for cold-tier rows whose .enc blob is missing on disk.

The cold-tiering worker marks `health_status='broken'` when its preflight
finds the source blob missing. Those rows are not auto-removed by any worker
and continue to surface in the user's file list as orphans. This script
soft-deletes them with a clear audit cause.

For each broken row, an informational audit detail names a healthy sibling
row sharing the same `content_hash` (if one exists) so the operator has a
breadcrumb to a possible re-upload source.

Idempotent: re-running it is a no-op once the rows are already soft-deleted.

Usage:
    docker cp scripts/cleanup_broken_cold_objects.py infrastructure-storage-service-1:/tmp/cleanup.py
    docker exec -e PYTHONPATH=/app infrastructure-storage-service-1 python /tmp/cleanup.py
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime

from sqlalchemy import select

from app.database import async_session
from app.models.database import Object
from app.services.audit_logging_service import AuditEventType
from app.services.audit_logging_service import audit_service as audit_logging_service

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("cleanup_broken_cold_objects")


async def _find_sibling(db, obj: Object):
    if not obj.content_hash:
        return None
    stmt = select(Object).where(
        Object.content_hash == obj.content_hash,
        Object.is_deleted.is_(False),
        Object.id != obj.id,
        Object.health_status == "healthy",
    )
    return (await db.execute(stmt)).scalars().first()


async def main() -> int:
    soft_deleted = 0
    skipped = 0

    async with async_session() as db:
        stmt = select(Object).where(
            Object.health_status == "broken",
            Object.is_deleted.is_(False),
            Object.storage_tier == "cold",
        )
        rows = (await db.execute(stmt)).scalars().all()

        if not rows:
            logger.info("No broken cold-tier rows to clean up.")
            return 0

        logger.info("Found %d broken cold-tier row(s) to soft-delete", len(rows))

        for obj in rows:
            sibling = await _find_sibling(db, obj)

            obj.is_deleted = True
            obj.deleted_at = datetime.utcnow()
            await db.commit()

            details = {
                "file_name": obj.file_name,
                "cause": "cold_tier_blob_missing",
                "object_path": obj.object_path,
                "content_hash": obj.content_hash,
                "admin_action": "soft_delete_broken_row",
                "recovery_sibling_id": str(sibling.id) if sibling else None,
                "recovery_sibling_name": sibling.file_name if sibling else None,
                "recovery_sibling_tier": sibling.storage_tier if sibling else None,
            }
            try:
                await audit_logging_service.log_event(
                    db,
                    AuditEventType.FILE_DELETED,
                    user_id=obj.user_id,
                    resource_type="file",
                    resource_id=str(obj.id),
                    action="admin_soft_delete",
                    details=details,
                )
            except Exception as e:
                logger.warning("audit emit failed for %s: %s", obj.id, e)

            soft_deleted += 1
            logger.info(
                "soft-deleted %s (%s) sibling=%s",
                obj.id,
                obj.file_name,
                sibling.id if sibling else "none",
            )

    print(
        f"\nSummary: soft_deleted={soft_deleted}, skipped={skipped}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
