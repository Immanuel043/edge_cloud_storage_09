"""
Quota Analytics Router

API endpoints for ML-based quota prediction and analytics:
- Get quota predictions
- View usage history and trends
- Manage quota alerts
- Trigger prediction updates
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, desc
from typing import List, Optional
from datetime import datetime, timedelta
import logging

from ..dependencies import get_db, get_current_user
from ..models.database import User, QuotaPrediction, QuotaAlert, StorageUsageHistory
from ..utils.rate_limiter_v2 import create_rate_limiter, RateLimitConfig
from ..models.schemas import (
    QuotaPredictionResponse,
    QuotaAlertResponse,
    UsageHistoryResponse,
    UsageHistoryPoint,
    DismissAlertRequest
)
from ..services.quota_predictor import quota_predictor
from ..workers.quota_prediction_worker import quota_prediction_worker
from ..monitoring.metrics import metrics_collector

router = APIRouter(prefix="/api/v1/quota", tags=["quota-analytics"])
logger = logging.getLogger(__name__)


@router.get("/prediction", response_model=QuotaPredictionResponse, dependencies=[Depends(create_rate_limiter(**RateLimitConfig.ML_PREDICTION))])
async def get_quota_prediction(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    force_refresh: bool = Query(False, description="Force regenerate prediction")
):
    """
    Get ML-based quota prediction for current user

    Returns predictions for 7, 14, and 30 days with confidence scores.
    Includes days until quota is expected to be full.

    Args:
        force_refresh: If True, regenerate prediction instead of using cached

    Returns:
        QuotaPredictionResponse with predictions and confidence scores
    """
    try:
        # Check for existing prediction (less than 24 hours old)
        if not force_refresh:
            result = await db.execute(
                select(QuotaPrediction)
                .where(QuotaPrediction.user_id == current_user.id)
                .where(QuotaPrediction.prediction_date >= datetime.utcnow() - timedelta(hours=24))
                .order_by(desc(QuotaPrediction.prediction_date))
                .limit(1)
            )
            existing_prediction = result.scalar_one_or_none()

            if existing_prediction:
                logger.info(f"Returning cached prediction for user {current_user.id}")
                metrics_collector.increment_counter('quota_prediction_cache_hits_total')

                usage_percent = (current_user.storage_used / current_user.storage_quota) if current_user.storage_quota > 0 else 0.0
                will_exceed = False

                if existing_prediction.days_until_full is not None:
                    will_exceed = existing_prediction.days_until_full <= 30

                return QuotaPredictionResponse(
                    user_id=str(current_user.id),
                    current_usage_bytes=current_user.storage_used or 0,
                    quota_bytes=current_user.storage_quota,
                    usage_percent=usage_percent,
                    predicted_7d=existing_prediction.predicted_7d,
                    predicted_14d=existing_prediction.predicted_14d,
                    predicted_30d=existing_prediction.predicted_30d,
                    confidence_7d=existing_prediction.confidence_7d,
                    confidence_14d=existing_prediction.confidence_14d,
                    confidence_30d=existing_prediction.confidence_30d,
                    days_until_full=existing_prediction.days_until_full,
                    will_exceed_quota=will_exceed,
                    model_type=existing_prediction.model_type,
                    prediction_date=existing_prediction.prediction_date
                )

        # Generate new prediction
        logger.info(f"Generating new prediction for user {current_user.id}")
        metrics_collector.increment_counter('quota_prediction_cache_misses_total')

        prediction_data = await quota_predictor.predict_user_quota(
            user_id=str(current_user.id),
            db=db
        )

        if not prediction_data:
            raise HTTPException(
                status_code=400,
                detail="Insufficient usage history for prediction. Need at least 7 days of data."
            )

        # Save prediction to database
        prediction = QuotaPrediction(
            user_id=current_user.id,
            predicted_7d=prediction_data.get('predicted_7d'),
            predicted_14d=prediction_data.get('predicted_14d'),
            predicted_30d=prediction_data.get('predicted_30d'),
            confidence_7d=prediction_data.get('confidence_7d'),
            confidence_14d=prediction_data.get('confidence_14d'),
            confidence_30d=prediction_data.get('confidence_30d'),
            days_until_full=prediction_data.get('days_until_full'),
            model_type=prediction_data.get('model_type'),
            prediction_date=datetime.utcnow()
        )
        db.add(prediction)
        await db.commit()

        usage_percent = (current_user.storage_used / current_user.storage_quota) if current_user.storage_quota > 0 else 0.0
        will_exceed = False

        if prediction_data.get('days_until_full') is not None:
            will_exceed = prediction_data['days_until_full'] <= 30

        metrics_collector.increment_counter('quota_predictions_api_generated_total')

        return QuotaPredictionResponse(
            user_id=str(current_user.id),
            current_usage_bytes=prediction_data['current_usage_bytes'],
            quota_bytes=prediction_data['quota_bytes'],
            usage_percent=usage_percent,
            predicted_7d=prediction_data.get('predicted_7d'),
            predicted_14d=prediction_data.get('predicted_14d'),
            predicted_30d=prediction_data.get('predicted_30d'),
            confidence_7d=prediction_data.get('confidence_7d'),
            confidence_14d=prediction_data.get('confidence_14d'),
            confidence_30d=prediction_data.get('confidence_30d'),
            days_until_full=prediction_data.get('days_until_full'),
            will_exceed_quota=will_exceed,
            model_type=prediction_data.get('model_type'),
            prediction_date=datetime.utcnow()
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get prediction for user {current_user.id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to generate prediction: {str(e)}")


@router.get("/history", response_model=UsageHistoryResponse)
async def get_usage_history(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    days: int = Query(30, ge=7, le=365, description="Number of days of history")
):
    """
    Get storage usage history for current user

    Returns daily storage usage data for trend analysis and visualization.

    Args:
        days: Number of days of history to retrieve (7-365)

    Returns:
        UsageHistoryResponse with daily usage data points
    """
    try:
        start_date = datetime.utcnow() - timedelta(days=days)

        # Get usage history
        result = await db.execute(
            select(StorageUsageHistory)
            .where(StorageUsageHistory.user_id == current_user.id)
            .where(StorageUsageHistory.date >= start_date)
            .order_by(StorageUsageHistory.date)
        )
        history = result.scalars().all()

        data_points = [
            UsageHistoryPoint(
                date=h.date,
                storage_used=h.storage_used,
                file_count=h.file_count,
                cache_used=h.cache_used,
                warm_used=h.warm_used,
                cold_used=h.cold_used
            )
            for h in history
        ]

        logger.info(f"Retrieved {len(data_points)} usage history points for user {current_user.id}")

        return UsageHistoryResponse(
            user_id=str(current_user.id),
            start_date=start_date,
            end_date=datetime.utcnow(),
            data_points=data_points,
            total_points=len(data_points)
        )

    except Exception as e:
        logger.error(f"Failed to get usage history for user {current_user.id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to retrieve usage history: {str(e)}")


@router.get("/alerts", response_model=List[QuotaAlertResponse])
async def get_quota_alerts(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    include_dismissed: bool = Query(False, description="Include dismissed alerts")
):
    """
    Get quota alerts for current user

    Returns all active alerts about quota usage and predictions.

    Args:
        include_dismissed: If True, include previously dismissed alerts

    Returns:
        List of QuotaAlertResponse
    """
    try:
        query = select(QuotaAlert).where(QuotaAlert.user_id == current_user.id)

        if not include_dismissed:
            query = query.where(QuotaAlert.is_dismissed == False)

        query = query.order_by(desc(QuotaAlert.created_at))

        result = await db.execute(query)
        alerts = result.scalars().all()

        # Generate human-readable messages
        alert_messages = {
            '70_percent': "Your storage is 70% full. Consider cleaning up unused files.",
            '85_percent': "Your storage is 85% full. You're approaching your quota limit.",
            '95_percent': "Your storage is 95% full! Please free up space soon.",
            'predicted_full': "Based on your usage patterns, you'll run out of storage soon."
        }

        response = []
        for alert in alerts:
            message = alert_messages.get(alert.alert_type, "Storage alert")

            if alert.alert_type == 'predicted_full' and alert.predicted_days_remaining:
                message = f"Your storage is predicted to be full in {alert.predicted_days_remaining} days."

            response.append(QuotaAlertResponse(
                id=str(alert.id),
                alert_type=alert.alert_type,
                current_usage_bytes=alert.current_usage_bytes,
                quota_bytes=alert.quota_bytes,
                usage_percent=alert.usage_percent,
                threshold_percent=alert.threshold_percent,
                predicted_days_remaining=alert.predicted_days_remaining,
                is_dismissed=alert.is_dismissed,
                created_at=alert.created_at,
                message=message
            ))

        logger.info(f"Retrieved {len(response)} alerts for user {current_user.id}")
        return response

    except Exception as e:
        logger.error(f"Failed to get alerts for user {current_user.id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to retrieve alerts: {str(e)}")


@router.post("/alerts/dismiss")
async def dismiss_alert(
    dismiss_data: DismissAlertRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Dismiss a quota alert

    Marks an alert as dismissed so it won't be shown again.

    Args:
        dismiss_data: Alert ID to dismiss

    Returns:
        Success message
    """
    try:
        # Get alert
        result = await db.execute(
            select(QuotaAlert).where(
                QuotaAlert.id == dismiss_data.alert_id,
                QuotaAlert.user_id == current_user.id
            )
        )
        alert = result.scalar_one_or_none()

        if not alert:
            raise HTTPException(status_code=404, detail="Alert not found")

        # Mark as dismissed
        alert.is_dismissed = True
        await db.commit()

        logger.info(f"Dismissed alert {dismiss_data.alert_id} for user {current_user.id}")
        metrics_collector.increment_counter('quota_alerts_dismissed_total')

        return {"status": "success", "message": "Alert dismissed"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to dismiss alert {dismiss_data.alert_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to dismiss alert: {str(e)}")


@router.post("/alerts/dismiss-all")
async def dismiss_all_alerts(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Dismiss all quota alerts for current user

    Marks all active alerts as dismissed.

    Returns:
        Success message with count of dismissed alerts
    """
    try:
        # Get all active alerts
        result = await db.execute(
            select(QuotaAlert).where(
                QuotaAlert.user_id == current_user.id,
                QuotaAlert.is_dismissed == False
            )
        )
        alerts = result.scalars().all()

        # Mark all as dismissed
        for alert in alerts:
            alert.is_dismissed = True

        await db.commit()

        logger.info(f"Dismissed {len(alerts)} alerts for user {current_user.id}")
        metrics_collector.increment_counter('quota_alerts_dismissed_total', len(alerts))

        return {
            "status": "success",
            "message": f"Dismissed {len(alerts)} alerts",
            "count": len(alerts)
        }

    except Exception as e:
        logger.error(f"Failed to dismiss all alerts for user {current_user.id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to dismiss alerts: {str(e)}")


@router.get("/stats")
async def get_quota_stats(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Get quota statistics and insights

    Returns comprehensive statistics about storage usage and predictions.

    Returns:
        Statistics including growth rate, trends, and recommendations
    """
    try:
        # Get recent usage history (last 30 days)
        start_date = datetime.utcnow() - timedelta(days=30)
        result = await db.execute(
            select(StorageUsageHistory)
            .where(StorageUsageHistory.user_id == current_user.id)
            .where(StorageUsageHistory.date >= start_date)
            .order_by(StorageUsageHistory.date)
        )
        history = result.scalars().all()

        # Calculate growth rate
        growth_rate = 0.0
        if len(history) >= 2:
            first_usage = history[0].storage_used
            last_usage = history[-1].storage_used
            days_diff = (history[-1].date - history[0].date).days
            if days_diff > 0 and first_usage > 0:
                growth_rate = ((last_usage - first_usage) / first_usage) * 100

        # Get latest prediction
        pred_result = await db.execute(
            select(QuotaPrediction)
            .where(QuotaPrediction.user_id == current_user.id)
            .order_by(desc(QuotaPrediction.prediction_date))
            .limit(1)
        )
        latest_prediction = pred_result.scalar_one_or_none()

        # Count active alerts
        alert_result = await db.execute(
            select(func.count(QuotaAlert.id))
            .where(QuotaAlert.user_id == current_user.id)
            .where(QuotaAlert.is_dismissed == False)
        )
        active_alerts = alert_result.scalar() or 0

        usage_percent = (current_user.storage_used / current_user.storage_quota) if current_user.storage_quota > 0 else 0.0

        stats = {
            "current_usage": {
                "bytes": current_user.storage_used or 0,
                "quota": current_user.storage_quota,
                "percent": usage_percent,
                "available": current_user.storage_quota - (current_user.storage_used or 0)
            },
            "trends": {
                "growth_rate_30d": round(growth_rate, 2),
                "data_points": len(history),
                "tracking_since": history[0].date if history else None
            },
            "predictions": {
                "available": latest_prediction is not None,
                "days_until_full": latest_prediction.days_until_full if latest_prediction else None,
                "model_used": latest_prediction.model_type if latest_prediction else None,
                "last_updated": latest_prediction.prediction_date if latest_prediction else None
            },
            "alerts": {
                "active_count": active_alerts,
                "has_warnings": active_alerts > 0
            },
            "recommendations": []
        }

        # Generate recommendations
        if usage_percent > 0.85:
            stats["recommendations"].append("Consider deleting unused files or upgrading your storage plan")
        if latest_prediction and latest_prediction.days_until_full and latest_prediction.days_until_full < 14:
            stats["recommendations"].append("You're running out of storage quickly. Take action soon!")
        if growth_rate > 50:
            stats["recommendations"].append("Your storage usage is growing rapidly. Monitor your uploads.")

        logger.info(f"Generated quota stats for user {current_user.id}")
        return stats

    except Exception as e:
        logger.error(f"Failed to get quota stats for user {current_user.id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to retrieve statistics: {str(e)}")


# Admin endpoints

@router.post("/admin/trigger-worker", tags=["admin"])
async def trigger_prediction_worker(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Manually trigger quota prediction worker (admin only)

    Runs the prediction worker immediately instead of waiting for scheduled run.

    Returns:
        Status message
    """
    # TODO: Add admin check
    # if current_user.user_type != 'admin':
    #     raise HTTPException(status_code=403, detail="Admin access required")

    try:
        logger.info(f"Manually triggering quota prediction worker by user {current_user.id}")

        # Run worker once
        await quota_prediction_worker.run_once()

        metrics_collector.increment_counter('quota_prediction_worker_manual_triggers_total')

        return {
            "status": "success",
            "message": "Quota prediction worker executed successfully"
        }

    except Exception as e:
        logger.error(f"Failed to trigger quota prediction worker: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Worker execution failed: {str(e)}")
