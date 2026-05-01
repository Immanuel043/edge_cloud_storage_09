"""
Storage Reconciliation Worker

Periodically walks `Object` rows and verifies their referenced chunk files
still exist on disk. If chunks have gone missing (manual rm, disk error,
out-of-band cleanup), the Object is marked `health_status='degraded'` so
downstream code can short-circuit downloads instead of failing mid-stream,
and a HIGH-severity audit event is emitted for forensic visibility.

Runs every 6 hours by default. Pages through Objects in batches of 100 to
keep memory bounded on installations with millions of files. Skips deleted
Objects (`is_deleted=True`) — those are handled by trash/permanent-delete
flows.
"""

import asyncio
import logging
import os
from datetime import datetime
from typing import Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import async_session
from ..models.database import Object
from ..services.audit_logging_service import (
    AuditEventType,
    AuditSeverity,
    audit_service as audit_logging_service,
)

logger = logging.getLogger(__name__)


def _resolve_chunk_paths_from_info(file_id: str, chunk_info: dict) -> list:
    """Same fallback layout used by routers/files.py:_resolve_chunk_paths.
    Replicated here to avoid pulling in router-layer imports.
    """
    if not chunk_info:
        return []
    upload_id = chunk_info.get("upload_id", str(file_id))
    chunk_count = chunk_info.get("count", 0)
    chunk_paths = chunk_info.get("paths", {})
    out = []
    for i in range(chunk_count):
        cp = chunk_paths.get(str(i))
        if not cp:
            shard = upload_id[:2] if len(upload_id) >= 2 else "00"
            cp = f"/app/storage/cache/{shard}/{upload_id}_chunk_{i}.enc"
        out.append(cp)
    return out


class StorageReconcileWorker:
    """Background worker that reconciles `objects.chunk_info` against on-disk state."""

    def __init__(self):
        self.worker_task: Optional[asyncio.Task] = None
        self.is_running = False
        self.check_interval = 6 * 60 * 60  # 6 hours
        self.batch_size = 100

    async def start(self):
        if self.is_running:
            logger.warning("Storage reconcile worker already running")
            return
        self.is_running = True
        self.worker_task = asyncio.create_task(self._run_worker())
        logger.info("Storage reconcile worker started")

    async def stop(self):
        self.is_running = False
        if self.worker_task:
            self.worker_task.cancel()
            try:
                await self.worker_task
            except asyncio.CancelledError:
                pass
        logger.info("Storage reconcile worker stopped")

    async def _run_worker(self):
        while self.is_running:
            try:
                await self._reconcile_cycle()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Storage reconcile cycle failed: %s", e, exc_info=True)
            await asyncio.sleep(self.check_interval)

    async def _reconcile_cycle(self):
        offset = 0
        scanned = 0
        degraded = 0
        broken = 0
        recovered = 0  # files previously flagged that are now healthy again

        while self.is_running:
            async with async_session() as db:
                rows = await self._scan_batch(db, offset)
                if not rows:
                    break

                for obj in rows:
                    scanned += 1
                    new_status = await self._check_object_health(obj)
                    if new_status != obj.health_status:
                        await self._update_status(db, obj, new_status)
                        if new_status == "degraded":
                            degraded += 1
                            await self._emit_audit(obj, "degraded")
                        elif new_status == "broken":
                            broken += 1
                            await self._emit_audit(obj, "broken")
                        elif new_status == "healthy":
                            recovered += 1
                    else:
                        # Refresh check timestamp without status change
                        await db.execute(
                            update(Object)
                            .where(Object.id == obj.id)
                            .values(health_checked_at=datetime.utcnow())
                        )

                await db.commit()

            offset += len(rows)
            if len(rows) < self.batch_size:
                break

        if scanned:
            logger.info(
                "Storage reconcile complete: scanned=%d degraded=%d broken=%d recovered=%d",
                scanned,
                degraded,
                broken,
                recovered,
            )

    async def _scan_batch(self, db: AsyncSession, offset: int):
        result = await db.execute(
            select(Object)
            .where(Object.is_deleted == False)  # noqa: E712
            .order_by(Object.id)
            .limit(self.batch_size)
            .offset(offset)
        )
        return result.scalars().all()

    async def _check_object_health(self, obj: Object) -> str:
        """Return 'healthy' | 'degraded' | 'broken' for the given Object."""
        # Inline / content-addressed types don't expose chunk paths via chunk_info.
        # CAS health is the deduplication GC's responsibility.
        if obj.storage_type == "single":
            if not obj.object_path:
                return "healthy"
            exists = await asyncio.to_thread(os.path.exists, obj.object_path)
            return "healthy" if exists else "broken"

        if obj.storage_type != "chunked":
            return "healthy"

        paths = _resolve_chunk_paths_from_info(str(obj.id), obj.chunk_info or {})
        if not paths:
            return "healthy"

        missing = 0
        for p in paths:
            if not await asyncio.to_thread(os.path.exists, p):
                missing += 1

        if missing == 0:
            return "healthy"
        # >50% gone = file unrecoverable; otherwise degraded but maybe partial-readable
        if missing >= len(paths) // 2:
            return "broken"
        return "degraded"

    async def _update_status(self, db: AsyncSession, obj: Object, new_status: str):
        await db.execute(
            update(Object)
            .where(Object.id == obj.id)
            .values(health_status=new_status, health_checked_at=datetime.utcnow())
        )

    async def _emit_audit(self, obj: Object, status: str):
        try:
            async with async_session() as audit_db:
                await audit_logging_service.log_event(
                    audit_db,
                    AuditEventType.SECURITY_VIOLATION,
                    user_id=obj.user_id,
                    resource_type="file",
                    resource_id=str(obj.id),
                    action="storage_reconcile",
                    result="failure",
                    severity=AuditSeverity.ERROR,
                    details={
                        "file_name": obj.file_name,
                        "storage_type": obj.storage_type,
                        "new_health_status": status,
                    },
                )
        except Exception as e:
            logger.warning("Failed to emit reconcile audit event for %s: %s", obj.id, e)


storage_reconcile_worker = StorageReconcileWorker()
