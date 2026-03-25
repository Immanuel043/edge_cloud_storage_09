"""
Activity anomaly detection service.

Reads from audit_logs (AuditLog ORM), creates SecurityAlert records.
Algorithms: volume anomaly, bulk deletion, time-of-day, auth failure spike.
"""
import logging
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from sqlalchemy import select, func, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.database import AuditLog, SecurityAlert
from ..config import settings

logger = logging.getLogger(__name__)

# Event types for file operations
_FILE_EVENT_TYPES = (
    "data.file.uploaded",
    "data.file.downloaded",
    "data.file.deleted",
)


async def check_volume_anomaly(db: AsyncSession) -> list[SecurityAlert]:
    """
    Flag users whose daily file operation count exceeds
    ANOMALY_VOLUME_MULTIPLIER × 30-day rolling average.
    """
    alerts = []
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    window_start = today_start - timedelta(days=30)

    try:
        # Get today's counts per user
        today_counts = await db.execute(
            select(AuditLog.user_id, func.count().label("cnt"))
            .filter(
                AuditLog.event_type.in_(_FILE_EVENT_TYPES),
                AuditLog.timestamp >= today_start,
            )
            .group_by(AuditLog.user_id)
        )

        for user_id, today_count in today_counts.all():
            if not user_id:
                continue

            # Get 30-day average
            avg_result = await db.execute(
                select(func.count().label("total"))
                .select_from(AuditLog)
                .filter(
                    AuditLog.user_id == user_id,
                    AuditLog.event_type.in_(_FILE_EVENT_TYPES),
                    AuditLog.timestamp >= window_start,
                    AuditLog.timestamp < today_start,
                )
            )
            total_30d = avg_result.scalar() or 0
            avg_daily = total_30d / 30.0

            threshold = avg_daily * settings.ANOMALY_VOLUME_MULTIPLIER
            if threshold < 5:
                threshold = 5  # Minimum threshold

            if today_count > threshold:
                alert = SecurityAlert(
                    id=uuid4(),
                    alert_type="volume_anomaly",
                    severity="medium",
                    status="open",
                    user_id=user_id,
                    title=f"Unusual file activity volume: {today_count} operations today",
                    description=(
                        f"User performed {today_count} file operations today, "
                        f"which is {today_count / max(avg_daily, 0.1):.1f}x the 30-day average "
                        f"({avg_daily:.1f}/day)."
                    ),
                    trigger_pattern="volume_anomaly",
                    evidence={
                        "today_count": today_count,
                        "avg_daily": round(avg_daily, 2),
                        "multiplier": settings.ANOMALY_VOLUME_MULTIPLIER,
                    },
                    risk_score=min(100, int(today_count / max(avg_daily, 0.1) * 20)),
                    first_seen=today_start,
                    last_seen=now,
                    detected_at=now,
                )
                db.add(alert)
                alerts.append(alert)

        if alerts:
            await db.commit()

    except Exception as e:
        logger.error(f"Volume anomaly check failed: {e}")
        try:
            await db.rollback()
        except Exception:
            pass

    return alerts


async def check_bulk_deletion(
    db: AsyncSession,
    user_id=None,
    file_id: str | None = None,
) -> SecurityAlert | None:
    """
    Real-time check: flag if user deleted > ANOMALY_BULK_DELETE_THRESHOLD
    files within the configured time window.
    """
    if not user_id:
        return None

    now = datetime.now(timezone.utc)
    window_start = now - timedelta(minutes=settings.ANOMALY_BULK_DELETE_WINDOW_MINUTES)

    try:
        result = await db.execute(
            select(func.count())
            .select_from(AuditLog)
            .filter(
                AuditLog.user_id == user_id,
                AuditLog.event_type == "data.file.deleted",
                AuditLog.timestamp >= window_start,
            )
        )
        delete_count = result.scalar() or 0

        if delete_count >= settings.ANOMALY_BULK_DELETE_THRESHOLD:
            alert = SecurityAlert(
                id=uuid4(),
                alert_type="bulk_deletion",
                severity="high",
                status="open",
                user_id=user_id,
                title=f"Bulk deletion detected: {delete_count} files in {settings.ANOMALY_BULK_DELETE_WINDOW_MINUTES} minutes",
                description=(
                    f"User deleted {delete_count} files within "
                    f"{settings.ANOMALY_BULK_DELETE_WINDOW_MINUTES} minutes "
                    f"(threshold: {settings.ANOMALY_BULK_DELETE_THRESHOLD})."
                ),
                trigger_pattern="bulk_deletion",
                evidence={
                    "delete_count": delete_count,
                    "window_minutes": settings.ANOMALY_BULK_DELETE_WINDOW_MINUTES,
                    "threshold": settings.ANOMALY_BULK_DELETE_THRESHOLD,
                    "latest_file_id": file_id,
                },
                risk_score=min(100, delete_count * 8),
                first_seen=window_start,
                last_seen=now,
                detected_at=now,
            )
            db.add(alert)
            await db.commit()
            return alert

    except Exception as e:
        logger.error(f"Bulk deletion check failed: {e}")
        try:
            await db.rollback()
        except Exception:
            pass

    return None


async def check_auth_failure_spike(db: AsyncSession) -> list[SecurityAlert]:
    """
    Flag IPs with >5 auth failures in 10 minutes.
    """
    alerts = []
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(minutes=10)

    try:
        result = await db.execute(
            select(AuditLog.ip_address, func.count().label("cnt"))
            .filter(
                AuditLog.event_type == "auth.login.failure",
                AuditLog.timestamp >= window_start,
                AuditLog.ip_address.isnot(None),
            )
            .group_by(AuditLog.ip_address)
            .having(func.count() > 5)
        )

        for ip, count in result.all():
            alert = SecurityAlert(
                id=uuid4(),
                alert_type="auth_failure_spike",
                severity="high",
                status="open",
                ip_address=ip,
                title=f"Authentication brute force: {count} failures from {ip}",
                description=(
                    f"{count} failed login attempts from IP {ip} in the last 10 minutes."
                ),
                trigger_pattern="auth_failure_spike",
                evidence={
                    "ip_address": ip,
                    "failure_count": count,
                    "window_minutes": 10,
                },
                risk_score=min(100, count * 10),
                first_seen=window_start,
                last_seen=now,
                detected_at=now,
            )
            db.add(alert)
            alerts.append(alert)

        if alerts:
            await db.commit()

    except Exception as e:
        logger.error(f"Auth failure spike check failed: {e}")
        try:
            await db.rollback()
        except Exception:
            pass

    return alerts


async def check_time_of_day_anomaly(db: AsyncSession) -> list[SecurityAlert]:
    """
    Flag activity at unusual hours (>2σ deviation from user's 30-day hourly histogram).
    Requires >7 days of history.
    """
    alerts = []
    now = datetime.now(timezone.utc)
    current_hour = now.hour
    window_start = now - timedelta(days=30)
    min_history = now - timedelta(days=7)

    try:
        # Get users with sufficient history
        users_result = await db.execute(
            select(AuditLog.user_id)
            .filter(
                AuditLog.event_type.in_(_FILE_EVENT_TYPES),
                AuditLog.timestamp >= window_start,
                AuditLog.user_id.isnot(None),
            )
            .group_by(AuditLog.user_id)
            .having(func.min(AuditLog.timestamp) <= min_history)
        )

        for (user_id,) in users_result.all():
            # Build hourly histogram
            hist_result = await db.execute(
                select(
                    func.extract('hour', AuditLog.timestamp).label('hr'),
                    func.count().label('cnt'),
                )
                .filter(
                    AuditLog.user_id == user_id,
                    AuditLog.event_type.in_(_FILE_EVENT_TYPES),
                    AuditLog.timestamp >= window_start,
                )
                .group_by('hr')
            )

            histogram = {int(hr): cnt for hr, cnt in hist_result.all()}
            if not histogram:
                continue

            counts = list(histogram.values())
            mean = sum(counts) / len(counts)
            variance = sum((c - mean) ** 2 for c in counts) / len(counts)
            std = variance ** 0.5

            current_count = histogram.get(current_hour, 0)

            # Flag if current hour count exceeds mean + 2σ
            threshold = mean + 2 * std
            if std > 0 and current_count > threshold and current_count > 3:
                alert = SecurityAlert(
                    id=uuid4(),
                    alert_type="time_anomaly",
                    severity="low",
                    status="open",
                    user_id=user_id,
                    title=f"Unusual activity at hour {current_hour}:00 UTC",
                    description=(
                        f"User has {current_count} operations at hour {current_hour}, "
                        f"which exceeds their typical pattern (mean: {mean:.1f}, σ: {std:.1f})."
                    ),
                    trigger_pattern="time_of_day_anomaly",
                    evidence={
                        "hour": current_hour,
                        "count": current_count,
                        "mean": round(mean, 2),
                        "std": round(std, 2),
                        "threshold": round(threshold, 2),
                    },
                    risk_score=30,
                    first_seen=now,
                    last_seen=now,
                    detected_at=now,
                )
                db.add(alert)
                alerts.append(alert)

        if alerts:
            await db.commit()

    except Exception as e:
        logger.error(f"Time-of-day anomaly check failed: {e}")
        try:
            await db.rollback()
        except Exception:
            pass

    return alerts


async def run_batch_checks(db: AsyncSession) -> list[SecurityAlert]:
    """Run all batch anomaly checks. Called periodically (e.g., hourly)."""
    if not settings.ANOMALY_DETECTION_ENABLED:
        return []

    all_alerts = []
    all_alerts.extend(await check_volume_anomaly(db))
    all_alerts.extend(await check_auth_failure_spike(db))
    all_alerts.extend(await check_time_of_day_anomaly(db))
    return all_alerts


async def check_realtime_event(
    db: AsyncSession,
    event_type: str,
    user_id=None,
    resource_id: str | None = None,
) -> SecurityAlert | None:
    """
    Real-time anomaly check after a single event.
    Currently only checks bulk deletion.
    """
    if not settings.ANOMALY_DETECTION_ENABLED:
        return None

    if event_type == "data.file.deleted":
        return await check_bulk_deletion(db, user_id, resource_id)

    return None
