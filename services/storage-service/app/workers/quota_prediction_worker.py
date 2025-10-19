"""
Quota Prediction Worker

Background worker that runs daily to:
- Generate storage quota predictions for all active users
- Create alerts based on usage thresholds
- Track usage history for ML training
"""

import logging
import asyncio
from datetime import datetime, timedelta
from typing import List, Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from uuid import uuid4

from ..models.database import (
    User, Object, StorageUsageHistory, QuotaPrediction, QuotaAlert
)
from ..services.quota_predictor import quota_predictor
from ..database import get_db_session, get_redis
from ..monitoring.metrics import metrics_collector

logger = logging.getLogger(__name__)


class QuotaPredictionWorker:
    """
    Background worker for quota prediction and alerting

    Features:
    - Daily usage tracking
    - ML-based quota predictions
    - Automatic alert generation
    - Configurable thresholds
    """

    # Alert thresholds
    ALERT_THRESHOLDS = {
        '70_percent': 0.70,
        '85_percent': 0.85,
        '95_percent': 0.95,
    }

    # Days to predict ahead for depletion warnings
    DEPLETION_WARNING_DAYS = 30

    def __init__(self):
        self.worker_task: Optional[asyncio.Task] = None
        self.is_running = False
        self.check_interval = 86400  # 24 hours in seconds

    async def start(self):
        """Start the background worker"""
        if self.is_running:
            logger.warning("Quota prediction worker already running")
            return

        self.is_running = True
        self.worker_task = asyncio.create_task(self._run_worker())
        logger.info("Quota prediction worker started")

    async def stop(self):
        """Stop the background worker"""
        self.is_running = False
        if self.worker_task:
            self.worker_task.cancel()
            try:
                await self.worker_task
            except asyncio.CancelledError:
                pass
        logger.info("Quota prediction worker stopped")

    async def _run_worker(self):
        """Main worker loop"""
        while self.is_running:
            try:
                logger.info("Starting quota prediction worker cycle")

                async for db in get_db_session():
                    try:
                        # Step 1: Record usage history
                        await self._record_usage_history(db)

                        # Step 2: Generate predictions
                        await self._generate_predictions(db)

                        # Step 3: Generate alerts
                        await self._generate_alerts(db)

                        await db.commit()
                        logger.info("Quota prediction worker cycle completed")

                    except Exception as e:
                        logger.error(f"Error in quota prediction worker cycle: {e}", exc_info=True)
                        await db.rollback()
                    finally:
                        break  # Exit the async generator

                # Update metrics
                metrics_collector.increment_counter('quota_prediction_worker_cycles_total')

            except Exception as e:
                logger.error(f"Fatal error in quota prediction worker: {e}", exc_info=True)
                metrics_collector.increment_counter('quota_prediction_worker_errors_total')

            # Sleep until next cycle
            if self.is_running:
                await asyncio.sleep(self.check_interval)

    async def _record_usage_history(self, db: AsyncSession):
        """
        Record daily storage usage for all active users

        This data is used for ML training and trend analysis.
        """
        logger.info("Recording usage history for all users")

        # Get all active users
        result = await db.execute(
            select(User).where(User.is_active == True)
        )
        users = result.scalars().all()

        today = datetime.utcnow().date()
        recorded_count = 0

        for user in users:
            try:
                # Check if already recorded today
                existing = await db.execute(
                    select(StorageUsageHistory).where(
                        StorageUsageHistory.user_id == user.id,
                        func.date(StorageUsageHistory.date) == today
                    )
                )
                if existing.scalar_one_or_none():
                    continue  # Already recorded today

                # Calculate storage distribution by tier
                tier_usage = await db.execute(
                    select(
                        Object.storage_tier,
                        func.sum(Object.file_size).label('total')
                    ).where(
                        Object.user_id == user.id
                    ).group_by(Object.storage_tier)
                )
                tier_usage_dict = {row[0]: row[1] for row in tier_usage.all()}

                # Count files
                file_count = await db.execute(
                    select(func.count(Object.id)).where(Object.user_id == user.id)
                )
                total_files = file_count.scalar() or 0

                # Create history record
                history = StorageUsageHistory(
                    user_id=user.id,
                    date=datetime.utcnow(),
                    storage_used=user.storage_used or 0,
                    cache_used=tier_usage_dict.get('cache', 0),
                    warm_used=tier_usage_dict.get('warm', 0),
                    cold_used=tier_usage_dict.get('cold', 0),
                    file_count=total_files
                )
                db.add(history)
                recorded_count += 1

            except Exception as e:
                logger.error(f"Failed to record usage for user {user.id}: {e}")
                continue

        await db.flush()
        logger.info(f"Recorded usage history for {recorded_count} users")
        metrics_collector.increment_counter('quota_usage_history_recorded_total', recorded_count)

    async def _generate_predictions(self, db: AsyncSession):
        """
        Generate quota predictions for all active users using ML
        """
        logger.info("Generating quota predictions for all users")

        try:
            # Use the quota predictor service
            predictions = await quota_predictor.batch_predict_all_users(db, limit=None)

            # Save predictions to database
            saved_count = 0
            for pred_data in predictions:
                try:
                    # Delete old predictions for this user
                    await db.execute(
                        select(QuotaPrediction).where(
                            QuotaPrediction.user_id == pred_data['user_id']
                        )
                    )
                    # Note: We keep old predictions for audit trail, just mark as superseded
                    # For simplicity, we'll just add new ones

                    prediction = QuotaPrediction(
                        user_id=pred_data['user_id'],
                        predicted_7d=pred_data.get('predicted_7d'),
                        predicted_14d=pred_data.get('predicted_14d'),
                        predicted_30d=pred_data.get('predicted_30d'),
                        confidence_7d=pred_data.get('confidence_7d'),
                        confidence_14d=pred_data.get('confidence_14d'),
                        confidence_30d=pred_data.get('confidence_30d'),
                        days_until_full=pred_data.get('days_until_full'),
                        model_type=pred_data.get('model_type'),
                        prediction_date=datetime.utcnow()
                    )
                    db.add(prediction)
                    saved_count += 1

                except Exception as e:
                    logger.error(f"Failed to save prediction for user {pred_data.get('user_id')}: {e}")
                    continue

            await db.flush()
            logger.info(f"Saved {saved_count} quota predictions")
            metrics_collector.increment_counter('quota_predictions_generated_total', saved_count)

        except Exception as e:
            logger.error(f"Failed to generate predictions: {e}", exc_info=True)
            raise

    async def _generate_alerts(self, db: AsyncSession):
        """
        Generate quota alerts based on current usage and predictions

        Alert types:
        - 70_percent: Usage exceeded 70% of quota
        - 85_percent: Usage exceeded 85% of quota
        - 95_percent: Usage exceeded 95% of quota
        - predicted_full: Predicted to exceed quota within 30 days
        """
        logger.info("Generating quota alerts")

        # Get all active users with their latest predictions
        result = await db.execute(
            select(User).where(User.is_active == True)
        )
        users = result.scalars().all()

        alert_count = 0

        for user in users:
            try:
                usage_percent = (user.storage_used / user.storage_quota) if user.storage_quota > 0 else 0.0

                # Check percentage thresholds
                for alert_type, threshold in self.ALERT_THRESHOLDS.items():
                    if usage_percent >= threshold:
                        # Check if alert already exists and not dismissed
                        existing = await db.execute(
                            select(QuotaAlert).where(
                                QuotaAlert.user_id == user.id,
                                QuotaAlert.alert_type == alert_type,
                                QuotaAlert.is_dismissed == False
                            )
                        )
                        if existing.scalar_one_or_none():
                            continue  # Alert already exists

                        # Create alert
                        alert = QuotaAlert(
                            user_id=user.id,
                            alert_type=alert_type,
                            current_usage_bytes=user.storage_used,
                            quota_bytes=user.storage_quota,
                            usage_percent=usage_percent,
                            threshold_percent=threshold
                        )
                        db.add(alert)
                        alert_count += 1
                        logger.info(f"Created {alert_type} alert for user {user.id} (usage: {usage_percent:.1%})")

                # Check predicted depletion
                latest_prediction = await db.execute(
                    select(QuotaPrediction)
                    .where(QuotaPrediction.user_id == user.id)
                    .order_by(QuotaPrediction.prediction_date.desc())
                    .limit(1)
                )
                prediction = latest_prediction.scalar_one_or_none()

                if prediction and prediction.days_until_full is not None:
                    if 0 < prediction.days_until_full <= self.DEPLETION_WARNING_DAYS:
                        # Check if alert already exists
                        existing = await db.execute(
                            select(QuotaAlert).where(
                                QuotaAlert.user_id == user.id,
                                QuotaAlert.alert_type == 'predicted_full',
                                QuotaAlert.is_dismissed == False
                            )
                        )
                        if not existing.scalar_one_or_none():
                            alert = QuotaAlert(
                                user_id=user.id,
                                alert_type='predicted_full',
                                current_usage_bytes=user.storage_used,
                                quota_bytes=user.storage_quota,
                                usage_percent=usage_percent,
                                predicted_days_remaining=prediction.days_until_full
                            )
                            db.add(alert)
                            alert_count += 1
                            logger.info(
                                f"Created predicted_full alert for user {user.id} "
                                f"({prediction.days_until_full} days remaining)"
                            )

            except Exception as e:
                logger.error(f"Failed to generate alerts for user {user.id}: {e}")
                continue

        await db.flush()
        logger.info(f"Generated {alert_count} quota alerts")
        metrics_collector.increment_counter('quota_alerts_generated_total', alert_count)

    async def run_once(self):
        """
        Run the worker once (for manual triggering or testing)
        """
        logger.info("Running quota prediction worker once")

        async for db in get_db_session():
            try:
                await self._record_usage_history(db)
                await self._generate_predictions(db)
                await self._generate_alerts(db)
                await db.commit()
                logger.info("Quota prediction worker run completed")
            except Exception as e:
                logger.error(f"Error in quota prediction worker run: {e}", exc_info=True)
                await db.rollback()
                raise
            finally:
                break


# Singleton instance
quota_prediction_worker = QuotaPredictionWorker()
