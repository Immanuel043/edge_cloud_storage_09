# services/storage-service/app/dependencies.py
import logging
from typing import AsyncGenerator, Optional, Tuple
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import Request, Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from sqlalchemy import select
from .database import AsyncSessionLocal
from .models.database import User, ActivityLog
from .config import settings

logger = logging.getLogger(__name__)

# Security - SECURITY FIX: Made optional to support cookie-based auth
security = HTTPBearer(auto_error=False)

async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Get database session"""
    async with AsyncSessionLocal() as session:
        yield session

async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db)
) -> User:
    """
    Get the current authenticated user from JWT token
    SECURITY FIX: Now supports both HTTP-only cookie AND Authorization header
    """
    token = None

    # SECURITY FIX: Try to get token from HTTP-only cookie first (preferred)
    cookie_token = request.cookies.get("access_token")
    if cookie_token:
        token = cookie_token
    # Fallback to Authorization header for backward compatibility
    elif credentials:
        token = credentials.credentials
    # Final fallback: explicit query token (used for signed download URLs)
    else:
        query_token = request.query_params.get("token")
        if query_token:
            token = query_token

    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        user_id = payload.get("sub")
        if user_id is None:
            raise HTTPException(status_code=401, detail="Invalid token")
        # Check token blocklist (logout revocation)
        jti = payload.get("jti")
        if jti:
            from .services.auth import auth_service
            if await auth_service.is_token_blocklisted(jti):
                raise HTTPException(status_code=401, detail="Token has been revoked")
    except JWTError as e:
        raise HTTPException(status_code=401, detail=f"Invalid token: {str(e)}")

    result = await db.execute(select(User).filter(User.id == user_id))
    user = result.scalar_one_or_none()

    if user is None:
        raise HTTPException(status_code=401, detail="User not found")

    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account deactivated")

    return user

async def require_admin(
    current_user: User = Depends(get_current_user),
) -> User:
    """Require current user to be an admin. Returns the user if admin."""
    if not getattr(current_user, 'is_admin', False):
        raise HTTPException(status_code=403, detail="Admin access required")
    return current_user


async def get_current_user_ws(token: str):
    """WebSocket authentication dependency"""
    from .database import get_db
    from .services.auth import auth_service
    
    async with get_db() as db:
        user = await auth_service.get_current_user_from_token(token, db)
        if not user:
            return None
        return user

async def log_activity(
    db: AsyncSession,
    user_id: str,
    action: str,
    object_id: str = None,
    metadata: dict = None,
    request: Request = None,
):
    """Log user activity"""
    activity = ActivityLog(
        user_id=user_id,
        action=action,
        object_id=object_id,
        ip_address=request.client.host if request else None,
        user_agent=request.headers.get("user-agent") if request else None,
        meta_data=metadata,
    )
    db.add(activity)
    await db.commit()


async def get_user_subscription(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get current user's active subscription with plan details.

    This is a dependency that can be injected into endpoints that need
    subscription information. It ensures the subscription exists and is
    eagerly loaded with plan details.

    Usage:
        @router.post("/upload")
        async def upload(subscription = Depends(get_user_subscription)):
            bandwidth_limit = subscription.plan.bandwidth_mbps
    """
    from shared_billing import BillingService, SubscriptionNotFoundError

    billing = BillingService(db, service_type='normal')

    try:
        subscription = await billing.get_user_subscription(current_user.id, include_plan=True)
        return subscription
    except SubscriptionNotFoundError:
        # User doesn't have subscription - create free tier
        subscription = await billing.create_subscription(
            user_id=current_user.id,
            plan_code='normal_free',
            billing_cycle=None
        )

        # Update user's quota
        current_user.storage_quota = subscription.plan.storage_bytes
        current_user.current_subscription_id = subscription.id
        await db.commit()

        return subscription


async def get_plan_quota(user: User, db: AsyncSession) -> Tuple[int, bool]:
    """Resolve quota from user's current subscription plan.

    Uses current_subscription_id (validated) for deterministic lookup.
    Falls back to status-based lookup with created_at DESC, id DESC tiebreak.
    Self-heals users.storage_quota and current_subscription_id with explicit flush.

    Returns:
        (plan_quota_bytes, did_heal) — caller must commit if did_heal is True.
    """
    from shared_billing.models import UserSubscription, SubscriptionPlan

    plan_quota = None
    healed = False

    # Primary: validated pointer lookup
    if user.current_subscription_id:
        result = await db.execute(
            select(SubscriptionPlan.storage_bytes)
            .join(UserSubscription, UserSubscription.plan_id == SubscriptionPlan.id)
            .where(
                UserSubscription.id == user.current_subscription_id,
                UserSubscription.user_id == user.id,
                UserSubscription.service_type == 'normal',
                UserSubscription.status.in_(['active', 'over_quota']),
            )
        )
        plan_quota = result.scalar_one_or_none()

    # Fallback: status-based with deterministic tiebreak
    if plan_quota is None:
        result = await db.execute(
            select(SubscriptionPlan.storage_bytes, UserSubscription.id)
            .join(UserSubscription, UserSubscription.plan_id == SubscriptionPlan.id)
            .where(
                UserSubscription.user_id == user.id,
                UserSubscription.service_type == 'normal',
                UserSubscription.status.in_(['active', 'over_quota']),
            )
            .order_by(UserSubscription.created_at.desc(), UserSubscription.id.desc())
        )
        rows = result.all()
        if len(rows) > 1:
            logger.warning(
                f"User {user.id} has {len(rows)} live normal subscriptions, "
                f"using most recent (id={rows[0][1]})"
            )
        if rows:
            plan_quota = rows[0][0]
            sub_id = rows[0][1]
            if user.current_subscription_id != sub_id:
                user.current_subscription_id = sub_id
                healed = True

    # Self-heal: flush if quota or pointer changed
    if plan_quota is not None and user.storage_quota != plan_quota:
        user.storage_quota = plan_quota
        healed = True

    if healed:
        await db.flush()

    return (plan_quota if plan_quota is not None else (user.storage_quota or 0), healed)
