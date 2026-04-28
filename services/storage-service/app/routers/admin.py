# services/storage-service/app/routers/admin.py

"""
Admin API for Bandwidth Management

Endpoints for viewing and managing user/group bandwidth limits.
"""

from datetime import datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_current_user, get_db
from ..models.database import User
from ..services.bandwidth_throttle import bandwidth_throttle_service

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])


# ============================================================================
# SCHEMAS
# ============================================================================


class BandwidthLimitUpdate(BaseModel):
    user_id: str
    limit_mbps: float
    burst_mbps: Optional[float] = None


class UserBandwidthInfo(BaseModel):
    user_id: str
    username: str
    email: str
    bandwidth_limit_mbps: int
    current_usage: dict


class BandwidthStats(BaseModel):
    total_users: int
    active_transfers: int
    avg_utilization: float
    top_users: List[dict]


# ============================================================================
# ADMIN AUTHENTICATION
# ============================================================================


async def require_admin(current_user: User = Depends(get_current_user)):
    """Require admin role"""
    if not hasattr(current_user, "plan_type") or current_user.plan_type != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return current_user


# ============================================================================
# BANDWIDTH MANAGEMENT ENDPOINTS
# ============================================================================


@router.get("/bandwidth/stats", response_model=BandwidthStats)
async def get_bandwidth_stats(
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """
    Get system-wide bandwidth statistics

    Requires admin role.
    """
    # Get total users
    result = await db.execute(select(func.count(User.id)))
    total_users = result.scalar()

    # Get top bandwidth consumers (from database)
    top_users_result = await db.execute(text("""
        SELECT
            u.id,
            u.username,
            u.bandwidth_limit_mbps,
            bu.total_transfer
        FROM user_bandwidth_summary bu
        JOIN users u ON u.id = bu.user_id
        ORDER BY bu.total_transfer DESC
        LIMIT 10
    """))

    top_users = [
        {
            "user_id": str(row.id),
            "username": row.username,
            "limit_mbps": row.bandwidth_limit_mbps,
            "total_transfer_bytes": row.total_transfer,
        }
        for row in top_users_result.fetchall()
    ]

    return {
        "total_users": total_users,
        "active_transfers": 0,  # Would need real-time tracking
        "avg_utilization": 0.0,  # Would need real-time tracking
        "top_users": top_users,
    }


@router.get("/bandwidth/users/{user_id}")
async def get_user_bandwidth_info(
    user_id: str,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """
    Get bandwidth information for a specific user

    Returns:
        - Current bandwidth limit
        - Usage statistics
        - Active transfers (if any)
    """
    # Get user from database
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Get current usage from throttle service
    usage_stats = await bandwidth_throttle_service.get_usage_stats(user_id)

    # Get historical usage
    usage_result = await db.execute(
        text("""
        SELECT
            COALESCE(SUM(bytes_uploaded), 0) as total_uploaded,
            COALESCE(SUM(bytes_downloaded), 0) as total_downloaded
        FROM bandwidth_usage
        WHERE user_id = :user_id
          AND period_start > NOW() - INTERVAL '30 days'
    """),
        {"user_id": user_id},
    )

    historical = usage_result.first()

    return {
        "user_id": user_id,
        "username": user.username,
        "email": user.email,
        "bandwidth_limit_mbps": user.bandwidth_limit_mbps or 10,
        "bandwidth_burst_mbps": user.bandwidth_burst_mbps or 20,
        "current_usage": usage_stats,
        "historical_usage": {
            "total_uploaded": historical.total_uploaded if historical else 0,
            "total_downloaded": historical.total_downloaded if historical else 0,
            "period_days": 30,
        },
    }


@router.post("/bandwidth/limits")
async def set_user_bandwidth_limit(
    update: BandwidthLimitUpdate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """
    Set bandwidth limit for a user

    Args:
        - user_id: Target user ID
        - limit_mbps: Bandwidth limit in Mbps
        - burst_mbps: Burst capacity in Mbps (optional)

    Requires admin role.
    """
    # Validate user exists
    result = await db.execute(select(User).where(User.id == update.user_id))
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Update database
    user.bandwidth_limit_mbps = int(update.limit_mbps)
    if update.burst_mbps:
        user.bandwidth_burst_mbps = int(update.burst_mbps)
    else:
        user.bandwidth_burst_mbps = int(update.limit_mbps * 2)

    await db.commit()

    # Update runtime limit in Redis
    await bandwidth_throttle_service.set_user_limit(update.user_id, update.limit_mbps)

    return {
        "status": "success",
        "user_id": update.user_id,
        "new_limit_mbps": update.limit_mbps,
        "new_burst_mbps": user.bandwidth_burst_mbps,
    }


@router.delete("/bandwidth/limits/{user_id}")
async def reset_user_bandwidth_limit(
    user_id: str,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """
    Reset user to default bandwidth limit

    Requires admin role.
    """
    # Validate user exists
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Reset to plan defaults (not hardcoded values)
    plan_limits = bandwidth_throttle_service.get_plan_limits(user.plan_type or "free")
    user.bandwidth_limit_mbps = plan_limits["bandwidth_mbps"]
    user.bandwidth_burst_mbps = plan_limits["burst_mbps"]
    await db.commit()

    # Clear Redis limit
    await bandwidth_throttle_service.clear_user_limit(user_id)

    return {
        "status": "success",
        "user_id": user_id,
        "reset_to_default": True,
        "default_limit_mbps": plan_limits["bandwidth_mbps"],
    }


@router.get("/bandwidth/usage/summary")
async def get_bandwidth_usage_summary(
    days: int = 30,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """
    Get bandwidth usage summary for all users

    Args:
        - days: Number of days to include (default: 30)

    Requires admin role.
    """
    result = await db.execute(
        text("""
        SELECT
            u.id,
            u.username,
            u.bandwidth_limit_mbps,
            COALESCE(SUM(bu.bytes_uploaded), 0) as total_uploaded,
            COALESCE(SUM(bu.bytes_downloaded), 0) as total_downloaded,
            COALESCE(SUM(bu.bytes_uploaded + bu.bytes_downloaded), 0) as total_transfer
        FROM users u
        LEFT JOIN bandwidth_usage bu ON u.id = bu.user_id
            AND bu.period_start > NOW() - INTERVAL ':days days'
        GROUP BY u.id, u.username, u.bandwidth_limit_mbps
        ORDER BY total_transfer DESC
        LIMIT 100
    """),
        {"days": days},
    )

    users = [
        {
            "user_id": str(row.id),
            "username": row.username,
            "limit_mbps": row.bandwidth_limit_mbps,
            "total_uploaded_bytes": row.total_uploaded,
            "total_downloaded_bytes": row.total_downloaded,
            "total_transfer_bytes": row.total_transfer,
        }
        for row in result.fetchall()
    ]

    return {
        "period_days": days,
        "total_users": len(users),
        "users": users,
    }


# ============================================================================
# REAL-TIME MONITORING ENDPOINTS (NEW)
# ============================================================================


@router.get("/bandwidth/realtime")
async def get_realtime_bandwidth_stats(
    admin: User = Depends(require_admin),
):
    """
    Get real-time bandwidth statistics from Redis.

    Returns:
        - All active users with current bandwidth usage
        - Total active streams across system
        - Users approaching or at their limits

    Uses Redis SCAN for non-blocking O(1) per-call operation
    (Fix #5: Avoids O(N) blocking KEYS command)

    Requires admin role.
    """
    # Get all active users from bandwidth throttle service
    all_stats = await bandwidth_throttle_service.get_all_active_users_stats()

    if "error" in all_stats:
        return {
            "status": "error",
            "message": all_stats["error"],
            "active_users": 0,
            "total_streams": 0,
            "users": [],
        }

    users = all_stats.get("users", {})

    # Calculate totals
    total_streams = sum(user.get("stream_count", 0) for user in users.values())

    # Find users at high utilization (>80%)
    high_utilization_users = [
        user_id for user_id, stats in users.items() if stats.get("utilization_percent", 0) > 80
    ]

    # Find users at stream limit
    at_stream_limit = [
        user_id
        for user_id, stats in users.items()
        if stats.get("stream_count", 0) >= stats.get("max_streams", 5)
    ]

    return {
        "status": "ok",
        "timestamp": datetime.utcnow().isoformat(),
        "active_users": all_stats.get("active_user_count", 0),
        "total_streams": total_streams,
        "high_utilization_users": high_utilization_users,
        "users_at_stream_limit": at_stream_limit,
        "users": users,
    }


@router.get("/bandwidth/streams")
async def get_active_streams(
    admin: User = Depends(require_admin),
):
    """
    Get all active upload/download streams across all users.

    Returns:
        - Per-user stream counts
        - Total active streams
        - Users near their stream limit

    Requires admin role.
    """
    from ..database import get_redis

    redis_client = await get_redis()
    if not redis_client:
        return {"status": "error", "message": "Redis unavailable", "total_streams": 0, "users": []}

    users_streams = {}
    total_streams = 0

    try:
        # Use SCAN instead of KEYS (Fix #5)
        async for key in redis_client.scan_iter("bandwidth:streams:*", count=100):
            key_str = key.decode() if isinstance(key, bytes) else key
            user_id = key_str.split(":")[-1]

            stream_count = await redis_client.get(key)
            if stream_count:
                count = int(stream_count)
                users_streams[user_id] = {
                    "stream_count": count,
                    "max_streams": 5,
                    "at_limit": count >= 5,
                }
                total_streams += count

    except Exception as e:
        return {"status": "error", "message": str(e), "total_streams": 0, "users": {}}

    # Find users at limit
    at_limit = [uid for uid, data in users_streams.items() if data["at_limit"]]

    return {
        "status": "ok",
        "timestamp": datetime.utcnow().isoformat(),
        "total_streams": total_streams,
        "active_users": len(users_streams),
        "users_at_limit": at_limit,
        "users": users_streams,
    }


@router.post("/bandwidth/limits/bulk")
async def set_bulk_bandwidth_limits(
    updates: List[BandwidthLimitUpdate],
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """
    Set bandwidth limits for multiple users at once.

    Args:
        - updates: List of BandwidthLimitUpdate objects

    Requires admin role.
    """
    results = []

    for update in updates:
        try:
            # Validate user exists
            result = await db.execute(select(User).where(User.id == update.user_id))
            user = result.scalar_one_or_none()

            if not user:
                results.append(
                    {"user_id": update.user_id, "status": "error", "message": "User not found"}
                )
                continue

            # Update database
            user.bandwidth_limit_mbps = int(update.limit_mbps)
            if update.burst_mbps:
                user.bandwidth_burst_mbps = int(update.burst_mbps)
            else:
                user.bandwidth_burst_mbps = int(update.limit_mbps * 2)

            # Update runtime limit in Redis
            await bandwidth_throttle_service.set_user_limit(update.user_id, update.limit_mbps)

            results.append(
                {
                    "user_id": update.user_id,
                    "status": "success",
                    "new_limit_mbps": update.limit_mbps,
                }
            )

        except Exception as e:
            results.append({"user_id": update.user_id, "status": "error", "message": str(e)})

    await db.commit()

    success_count = sum(1 for r in results if r["status"] == "success")

    return {
        "status": "complete",
        "total_updates": len(updates),
        "successful": success_count,
        "failed": len(updates) - success_count,
        "results": results,
    }
