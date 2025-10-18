# services/storage-service/app/routers/admin.py

"""
Admin API for Bandwidth Management

Endpoints for viewing and managing user/group bandwidth limits.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, text
from typing import List, Optional
from pydantic import BaseModel
from datetime import datetime, timedelta

from ..dependencies import get_db, get_current_user
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
    if not hasattr(current_user, 'user_type') or current_user.user_type != 'admin':
        raise HTTPException(
            status_code=403,
            detail="Admin access required"
        )
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
    result = await db.execute(
        select(User).where(User.id == user_id)
    )
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Get current usage from throttle service
    usage_stats = await bandwidth_throttle_service.get_usage_stats(user_id)

    # Get historical usage
    usage_result = await db.execute(text("""
        SELECT
            COALESCE(SUM(bytes_uploaded), 0) as total_uploaded,
            COALESCE(SUM(bytes_downloaded), 0) as total_downloaded
        FROM bandwidth_usage
        WHERE user_id = :user_id
          AND period_start > NOW() - INTERVAL '30 days'
    """), {"user_id": user_id})

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
        }
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
    result = await db.execute(
        select(User).where(User.id == update.user_id)
    )
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
    await bandwidth_throttle_service.set_user_limit(
        update.user_id,
        update.limit_mbps
    )

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
    result = await db.execute(
        select(User).where(User.id == user_id)
    )
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Reset to defaults
    user.bandwidth_limit_mbps = 10
    user.bandwidth_burst_mbps = 20
    await db.commit()

    # Clear Redis limit
    await bandwidth_throttle_service.clear_user_limit(user_id)

    return {
        "status": "success",
        "user_id": user_id,
        "reset_to_default": True,
        "default_limit_mbps": 10,
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
    result = await db.execute(text("""
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
    """), {"days": days})

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
