"""
Cold Storage Tiering Service
Automatically moves files between storage tiers based on access patterns
"""

import asyncio
import logging
import os
import shutil
from datetime import datetime, timedelta

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import async_session
from ..models.database import Object

logger = logging.getLogger(__name__)


class ColdStorageTieringService:
    """Manages automatic file tiering between cache, warm, and cold storage"""

    def __init__(self):
        self.is_running = False
        self.worker_task = None

        # Tiering thresholds (configurable)
        self.cache_to_warm_days = int(os.getenv("CACHE_TO_WARM_DAYS", 7))
        self.warm_to_cold_days = int(os.getenv("WARM_TO_COLD_DAYS", 30))
        self.cold_retention_days = int(os.getenv("COLD_RETENTION_DAYS", 365))

        # Access-based promotion
        self.promote_on_access = os.getenv("PROMOTE_ON_ACCESS", "true").lower() == "true"

        # Tier definitions
        self.tiers = {
            "cache": {
                "path": settings.CACHE_PATH,
                "max_size_gb": 500,
                "priority": 1,
                "next_tier": "warm",
                "age_threshold_days": self.cache_to_warm_days,
            },
            "warm": {
                "path": settings.WARM_PATH,
                "max_size_gb": 3200,
                "priority": 2,
                "next_tier": "cold",
                "age_threshold_days": self.warm_to_cold_days,
            },
            "cold": {
                "path": settings.COLD_PATH,
                "max_size_gb": 4000,
                "priority": 3,
                "next_tier": None,
                "age_threshold_days": self.cold_retention_days,
            },
        }

        logger.info(
            f"Tiering thresholds: cache→warm: {self.cache_to_warm_days}d, "
            f"warm→cold: {self.warm_to_cold_days}d, retention: {self.cold_retention_days}d"
        )

    async def start(self):
        """Start the background tiering worker"""
        if self.is_running:
            logger.warning("Tiering service already running")
            return

        self.is_running = True
        self.worker_task = asyncio.create_task(self._tiering_worker())
        logger.info("Cold storage tiering service started")

    async def stop(self):
        """Stop the background worker"""
        self.is_running = False
        if self.worker_task:
            self.worker_task.cancel()
            try:
                await self.worker_task
            except asyncio.CancelledError:
                pass
        logger.info("Cold storage tiering service stopped")

    async def _tiering_worker(self):
        """Background worker that runs tiering checks"""
        logger.info("Tiering worker started - checking every 4 hours")

        while self.is_running:
            try:
                # Run tiering cycle
                await self._run_tiering_cycle()

                # Sleep for 4 hours before next check
                await asyncio.sleep(4 * 3600)

            except asyncio.CancelledError:
                logger.info("Tiering worker cancelled")
                break
            except Exception as e:
                logger.error(f"Tiering worker error: {e}", exc_info=True)
                # Wait 10 minutes before retry on error
                await asyncio.sleep(600)

    async def _run_tiering_cycle(self):
        """Run a complete tiering cycle"""
        logger.info("Starting tiering cycle")
        start_time = datetime.utcnow()

        async with async_session() as db:
            # Tier 1: Move cache → warm (files older than 7 days)
            moved_to_warm = await self._tier_files(
                db, from_tier="cache", to_tier="warm", age_days=self.cache_to_warm_days
            )

            # Tier 2: Move warm → cold (files older than 30 days)
            moved_to_cold = await self._tier_files(
                db, from_tier="warm", to_tier="cold", age_days=self.warm_to_cold_days
            )

            # Check tier capacity and force-tier if needed
            await self._check_tier_capacity(db)

            # Commit all changes
            await db.commit()

        duration = (datetime.utcnow() - start_time).total_seconds()
        logger.info(
            f"Tiering cycle complete: {moved_to_warm} to warm, "
            f"{moved_to_cold} to cold in {duration:.2f}s"
        )

    async def _tier_files(
        self, db: AsyncSession, from_tier: str, to_tier: str, age_days: int, limit: int = 100
    ) -> int:
        """Move files from one tier to another based on age"""

        # Find files ready to be tiered
        threshold_date = datetime.utcnow() - timedelta(days=age_days)

        query = (
            select(Object)
            .where(
                and_(
                    Object.storage_tier == from_tier,
                    Object.last_accessed < threshold_date,
                    Object.object_path.isnot(None),  # Must have a file path
                )
            )
            .limit(limit)
        )

        result = await db.execute(query)
        files_to_tier = result.scalars().all()

        if not files_to_tier:
            logger.debug(f"No files ready to tier from {from_tier} to {to_tier}")
            return 0

        logger.info(f"Found {len(files_to_tier)} files to tier from {from_tier} to {to_tier}")

        moved_count = 0
        for file_obj in files_to_tier:
            try:
                success = await self._move_file_to_tier(file_obj, to_tier, db)
                if success:
                    moved_count += 1
            except Exception as e:
                logger.error(f"Failed to tier file {file_obj.id}: {e}")
                continue

        return moved_count

    async def _move_file_to_tier(
        self, file_obj: Object, target_tier: str, db: AsyncSession
    ) -> bool:
        """Move a single file to target tier"""

        # Get source and destination paths
        source_tier = file_obj.storage_tier
        source_path = file_obj.object_path

        if not source_path or not os.path.exists(source_path):
            logger.warning(f"Source file not found: {source_path}")
            return False

        # Build destination path
        tier_config = self.tiers[target_tier]
        tier_base_path = tier_config["path"]

        # Maintain same relative path structure
        relative_path = os.path.basename(source_path)
        dest_path = os.path.join(tier_base_path, "objects", relative_path)

        # Ensure destination directory exists
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)

        # Cold-tier compression: opt-in only (see config.COLD_TIER_COMPRESSION_ENABLED).
        # When enabled we write a `.zst` file and flag it in file_metadata so the
        # download path can decompress. Currently OFF by default because Object
        # download paths don't yet honor the flag — enabling without that wiring
        # would silently truncate downloads.
        compress_on_move = (
            target_tier == "cold"
            and settings.COLD_TIER_COMPRESSION_ENABLED
            and not (file_obj.file_metadata or {}).get("cold_compressed")
        )

        try:
            if compress_on_move:
                import zstandard as zstd  # lazy import — zstandard is already a

                # transitive dep via CAS; failure here
                # falls through to a plain move.
                dest_path = dest_path + ".zst"
                cctx = zstd.ZstdCompressor(level=settings.COLD_TIER_COMPRESSION_LEVEL)

                def _compress_move():
                    with open(source_path, "rb") as src, open(dest_path, "wb") as dst:
                        cctx.copy_stream(src, dst)
                    os.remove(source_path)

                await asyncio.to_thread(_compress_move)

                meta = dict(file_obj.file_metadata or {})
                meta["cold_compressed"] = True
                meta["cold_compressed_at"] = datetime.utcnow().isoformat()
                file_obj.file_metadata = meta
            else:
                # Plain move (use shutil.move for efficiency)
                await asyncio.to_thread(shutil.move, source_path, dest_path)

            # Update database
            file_obj.storage_tier = target_tier
            file_obj.object_path = dest_path

            logger.info(
                f"Tiered file {file_obj.file_name} ({file_obj.id}) "
                f"from {source_tier} to {target_tier}"
                f"{' (zstd)' if compress_on_move else ''}"
            )

            return True

        except Exception as e:
            logger.error(f"Failed to move file {source_path} to {dest_path}: {e}")
            return False

    async def _check_tier_capacity(self, db: AsyncSession):
        """Check if any tier is over capacity and force-tier oldest files"""

        for tier_name, tier_config in self.tiers.items():
            # Calculate current usage
            query = select(func.sum(Object.file_size)).where(Object.storage_tier == tier_name)
            result = await db.execute(query)
            current_size_bytes = result.scalar() or 0
            current_size_gb = current_size_bytes / (1024**3)

            max_size_gb = tier_config["max_size_gb"]
            usage_percent = (current_size_gb / max_size_gb) * 100

            logger.info(
                f"Tier {tier_name}: {current_size_gb:.2f}GB / {max_size_gb}GB ({usage_percent:.1f}%)"
            )

            # If over 90% capacity, force-tier oldest files
            if usage_percent > 90 and tier_config["next_tier"]:
                logger.warning(f"Tier {tier_name} at {usage_percent:.1f}% capacity - force tiering")

                # Find oldest files regardless of age
                query = (
                    select(Object)
                    .where(Object.storage_tier == tier_name)
                    .order_by(Object.last_accessed.asc())
                    .limit(50)
                )

                result = await db.execute(query)
                oldest_files = result.scalars().all()

                for file_obj in oldest_files:
                    await self._move_file_to_tier(file_obj, tier_config["next_tier"], db)

    async def promote_file_on_access(self, file_id: str, db: AsyncSession):
        """Promote a file to cache tier when accessed (if enabled)"""

        if not self.promote_on_access:
            return

        try:
            query = select(Object).where(Object.id == file_id)
            result = await db.execute(query)
            file_obj = result.scalar_one_or_none()

            if not file_obj:
                return

            # Only promote if file is in warm or cold tier
            if file_obj.storage_tier in ["warm", "cold"]:
                logger.info(
                    f"Promoting file {file_obj.file_name} from "
                    f"{file_obj.storage_tier} to cache on access"
                )

                await self._move_file_to_tier(file_obj, "cache", db)
                await db.commit()

        except Exception as e:
            logger.error(f"Failed to promote file {file_id}: {e}")


# Global service instance
cold_storage_service = ColdStorageTieringService()
