# services/storage-service/app/workers/prefetch_worker.py

"""
Prefetch Worker

Background service that:
1. Predicts which files users will access
2. Moves predicted files from cold → warm storage
3. Tracks prediction accuracy
"""

import asyncio
import logging
from datetime import datetime, timedelta
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import async_session
from ..services.access_predictor import access_predictor
from ..services.cold_storage_tiering import ColdStorageTieringService
from ..models.database import Object, User

logger = logging.getLogger(__name__)


class PrefetchWorker:
    """
    Background worker for predictive prefetching
    """

    def __init__(self):
        self.is_running = False
        self.worker_task = None
        self.aggressiveness = 0.5  # 0.0 = conservative, 1.0 = aggressive
        self.min_confidence = 0.4  # Minimum prediction confidence
        self.check_interval = 3600  # Check every hour

    async def start(self):
        """Start the prefetch worker"""
        if self.is_running:
            logger.warning("Prefetch worker already running")
            return

        self.is_running = True
        self.worker_task = asyncio.create_task(self._worker_loop())
        logger.info("Prefetch worker started")

    async def stop(self):
        """Stop the prefetch worker"""
        self.is_running = False
        if self.worker_task:
            self.worker_task.cancel()
            try:
                await self.worker_task
            except asyncio.CancelledError:
                pass
        logger.info("Prefetch worker stopped")

    async def _worker_loop(self):
        """Main worker loop"""
        logger.info(f"Prefetch worker loop started - checking every {self.check_interval}s")

        while self.is_running:
            try:
                await self._run_prefetch_cycle()

                # Sleep until next check
                await asyncio.sleep(self.check_interval)

            except asyncio.CancelledError:
                logger.info("Prefetch worker cancelled")
                break
            except Exception as e:
                logger.error(f"Prefetch worker error: {e}", exc_info=True)
                # Wait 5 minutes before retry on error
                await asyncio.sleep(300)

    async def _run_prefetch_cycle(self):
        """
        Run a single prefetch cycle

        Steps:
        1. Get active users
        2. Predict files for each user
        3. Store prefetch candidates
        4. Trigger tier promotion for high-confidence predictions
        """
        async with async_session() as db:
            try:
                # Get active users (accessed files in last 7 days)
                result = await db.execute(text("""
                    SELECT DISTINCT user_id
                    FROM file_access_log
                    WHERE accessed_at > NOW() - INTERVAL '7 days'
                    LIMIT 100
                """))

                active_users = [row.user_id for row in result.fetchall()]

                logger.info(f"Running prefetch for {len(active_users)} active users")

                # Process each user
                for user_id in active_users:
                    await self._prefetch_for_user(db, str(user_id))

                await db.commit()

                # Clean up old candidates
                await self._cleanup_old_candidates(db)

                logger.info("Prefetch cycle completed")

            except Exception as e:
                logger.error(f"Prefetch cycle failed: {e}")
                await db.rollback()

    async def _prefetch_for_user(self, db: AsyncSession, user_id: str):
        """
        Generate and store prefetch predictions for a user
        """
        try:
            # Get predictions using hybrid method
            predictions = await access_predictor.predict_next_files(
                db,
                user_id,
                method="hybrid"
            )

            # Filter by confidence threshold
            high_confidence = [
                p for p in predictions
                if p["confidence"] >= self.min_confidence
            ]

            if not high_confidence:
                return

            # Store as prefetch candidates
            for pred in high_confidence:
                await db.execute(text("""
                    INSERT INTO prefetch_candidates
                        (user_id, file_id, prediction_confidence, prediction_method, predicted_at, expires_at)
                    VALUES
                        (:user_id, :file_id, :confidence, :method, NOW(), NOW() + INTERVAL '24 hours')
                    ON CONFLICT (user_id, file_id)
                    DO UPDATE SET
                        prediction_confidence = EXCLUDED.prediction_confidence,
                        prediction_method = EXCLUDED.prediction_method,
                        predicted_at = NOW(),
                        expires_at = NOW() + INTERVAL '24 hours'
                """), {
                    "user_id": user_id,
                    "file_id": pred["file_id"],
                    "confidence": pred["confidence"],
                    "method": pred["method"]
                })

                # If very high confidence, trigger immediate prefetch
                if pred["confidence"] >= 0.7 and self.aggressiveness >= 0.5:
                    await self._trigger_prefetch(db, user_id, pred["file_id"])

            logger.debug(f"Stored {len(high_confidence)} prefetch candidates for user {user_id}")

        except Exception as e:
            logger.error(f"Failed to prefetch for user {user_id}: {e}")

    async def _trigger_prefetch(self, db: AsyncSession, user_id: str, file_id: str):
        """
        Trigger immediate prefetch (tier promotion) for a file
        """
        try:
            # Get file info
            result = await db.execute(
                select(Object).where(Object.id == file_id)
            )
            file_obj = result.scalar_one_or_none()

            if not file_obj:
                return

            # Only prefetch from cold storage
            if file_obj.storage_tier != "cold":
                return

            logger.info(f"Prefetching file {file_id} ({file_obj.file_name}) for user {user_id}")

            # Promote to warm tier
            tiering_service = ColdStorageTieringService()
            success = await tiering_service._promote_file(db, file_obj, "warm")

            if success:
                # Mark as prefetched
                await db.execute(text("""
                    UPDATE prefetch_candidates
                    SET prefetched = true,
                        prefetched_at = NOW()
                    WHERE user_id = :user_id
                      AND file_id = :file_id
                """), {
                    "user_id": user_id,
                    "file_id": file_id
                })

                logger.info(f"✅ Successfully prefetched {file_obj.file_name}")

        except Exception as e:
            logger.error(f"Failed to trigger prefetch: {e}")

    async def _cleanup_old_candidates(self, db: AsyncSession):
        """
        Clean up expired prefetch candidates
        """
        try:
            # Delete expired candidates
            result = await db.execute(text("""
                DELETE FROM prefetch_candidates
                WHERE expires_at < NOW()
                RETURNING id
            """))

            deleted_count = len(result.fetchall())

            if deleted_count > 0:
                logger.info(f"Cleaned up {deleted_count} expired prefetch candidates")

            await db.commit()

        except Exception as e:
            logger.error(f"Failed to cleanup candidates: {e}")
            await db.rollback()

    async def track_access_accuracy(self, db: AsyncSession, user_id: str, file_id: str):
        """
        Track if a prefetch prediction was accurate

        Call this when a file is accessed
        """
        try:
            # Check if this file was predicted
            result = await db.execute(text("""
                UPDATE prefetch_candidates
                SET accessed_after_prefetch = true
                WHERE user_id = :user_id
                  AND file_id = :file_id
                  AND prefetched = true
                  AND predicted_at > NOW() - INTERVAL '24 hours'
                RETURNING id
            """), {
                "user_id": user_id,
                "file_id": file_id
            })

            if result.rowcount > 0:
                logger.info(f"✅ Prediction was accurate: user {user_id} accessed predicted file {file_id}")

            await db.commit()

        except Exception as e:
            logger.error(f"Failed to track accuracy: {e}")
            await db.rollback()

    async def get_accuracy_stats(self, db: AsyncSession) -> dict:
        """
        Get prediction accuracy statistics
        """
        try:
            result = await db.execute(text("""
                SELECT
                    COUNT(*) FILTER (WHERE prefetched) as total_prefetched,
                    COUNT(*) FILTER (WHERE accessed_after_prefetch) as accurate_predictions,
                    ROUND(
                        COUNT(*) FILTER (WHERE accessed_after_prefetch)::numeric /
                        NULLIF(COUNT(*) FILTER (WHERE prefetched), 0) * 100,
                        2
                    ) as accuracy_percentage
                FROM prefetch_candidates
                WHERE predicted_at > NOW() - INTERVAL '30 days'
            """))

            stats = result.first()

            return {
                "total_prefetched": stats.total_prefetched or 0,
                "accurate_predictions": stats.accurate_predictions or 0,
                "accuracy_percentage": float(stats.accuracy_percentage or 0),
                "period_days": 30
            }

        except Exception as e:
            logger.error(f"Failed to get accuracy stats: {e}")
            return {"error": str(e)}


# Singleton instance
prefetch_worker = PrefetchWorker()
