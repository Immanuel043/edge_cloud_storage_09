"""Backup Worker

Periodically walks `Object` rows whose `backup_status='pending'` and copies
their source blobs into the local-disk backup tree at
``{BACKUP_PATH}/<sha[:2]>/<sha>.enc``. Idempotent and content-addressed:
two rows that share `content_hash` deduplicate to a single backup blob.

Status transitions emitted by this worker:

  pending -> completed             # blob copied (or already present)
  pending -> source_missing        # source blob is gone on disk
  pending -> unsupported           # storage_type has no local backup path yet
  pending -> failed                # unexpected error during copy

`unsupported` and `source_missing` are deliberately distinct from `failed`
so an operator can grep them independently — `failed` should be empty in a
healthy steady state, while `unsupported` is just an inventory line.

This worker does NOT mark `health_status='broken'` on missing sources.
That's the storage_reconcile_worker's job (every 6h); double-attribution
would muddy the audit trail. We just record the symptom in `backup_status`
and let reconcile handle the health classification on its own cadence.
"""

import asyncio
import logging
import os
from datetime import datetime
from typing import Optional

from sqlalchemy import select, update

from ..config import settings
from ..database import async_session
from ..models.database import Object
from ..monitoring.worker_heartbeat import record_heartbeat
from ..monitoring.metrics import (
    storage_backup_completed_total,
    storage_backup_failed_total,
    storage_backup_source_missing_total,
    storage_backup_unsupported_total,
)
from ..services.backup import backup_service

logger = logging.getLogger(__name__)


class BackupWorker:
    """Background worker that drives `objects.backup_status` to a terminal value."""

    def __init__(self):
        self.worker_task: Optional[asyncio.Task] = None
        self.is_running = False
        self.check_interval = int(os.getenv("BACKUP_WORKER_INTERVAL", "300"))
        self.batch_size = int(os.getenv("BACKUP_WORKER_BATCH_SIZE", "50"))

    async def start(self):
        if self.is_running:
            logger.warning("Backup worker already running")
            return
        self.is_running = True
        self.worker_task = asyncio.create_task(self._run_worker())
        logger.info(
            "Backup worker started (interval=%ss, batch=%d)",
            self.check_interval,
            self.batch_size,
        )

    async def stop(self):
        self.is_running = False
        if self.worker_task:
            self.worker_task.cancel()
            try:
                await self.worker_task
            except asyncio.CancelledError:
                pass
        logger.info("Backup worker stopped")

    async def _run_worker(self):
        while self.is_running:
            status, err, counts = "ok", None, {}
            try:
                counts = await self._cycle() or {}
            except asyncio.CancelledError:
                break
            except Exception as e:
                status, err = "error", e
                logger.error("Backup worker cycle failed: %s", e, exc_info=True)
            await record_heartbeat(
                "backup", status, self.check_interval, counts=counts, last_error=err
            )
            await asyncio.sleep(self.check_interval)

    async def _cycle(self):
        completed = unsupported = source_missing = failed = 0

        while self.is_running:
            async with async_session() as db:
                stmt = (
                    select(Object)
                    .where(
                        Object.backup_status == "pending",
                        Object.is_deleted.is_(False),
                        Object.health_status != "broken",
                    )
                    .order_by(Object.created_at)
                    .limit(self.batch_size)
                )
                rows = (await db.execute(stmt)).scalars().all()

                if not rows:
                    break

                for obj in rows:
                    new_status, location = await self._backup_one(obj)
                    await db.execute(
                        update(Object)
                        .where(Object.id == obj.id)
                        .values(backup_status=new_status, backup_location=location)
                    )
                    if new_status == "completed":
                        completed += 1
                        storage_backup_completed_total.labels(
                            storage_type=obj.storage_type or "unknown"
                        ).inc()
                    elif new_status == "unsupported":
                        unsupported += 1
                        storage_backup_unsupported_total.labels(
                            storage_type=obj.storage_type or "unknown"
                        ).inc()
                    elif new_status == "source_missing":
                        source_missing += 1
                        storage_backup_source_missing_total.inc()
                    else:
                        failed += 1
                        storage_backup_failed_total.inc()

                await db.commit()

            if len(rows) < self.batch_size:
                break

        if completed or unsupported or source_missing or failed:
            logger.info(
                "Backup cycle: completed=%d unsupported=%d source_missing=%d failed=%d",
                completed,
                unsupported,
                source_missing,
                failed,
            )

        return {
            "completed": completed,
            "unsupported": unsupported,
            "source_missing": source_missing,
            "failed": failed,
        }

    async def _backup_one(self, obj: Object) -> tuple[str, Optional[str]]:
        try:
            location = await backup_service.backup_to_local_disk(obj)
            return ("completed", location)
        except FileNotFoundError as e:
            logger.warning(
                "Backup source missing for %s (%s): %s",
                obj.id,
                obj.file_name,
                e,
            )
            return ("source_missing", None)
        except NotImplementedError:
            return ("unsupported", None)
        except Exception as e:
            logger.error(
                "Backup failed for %s (%s): %s",
                obj.id,
                obj.file_name,
                e,
                exc_info=True,
            )
            return ("failed", None)


backup_worker = BackupWorker()
