"""
Modern Billing API - Database-driven subscription management

This is a greenfield implementation using the shared-billing library.
Replaces the old config-based billing system with a flexible, database-driven approach.

Features:
- Plan catalog management
- Subscription lifecycle (create, upgrade, downgrade, cancel)
- Usage-based upgrade recommendations
- Subscription history and audit trail
- Future-ready for Stripe integration (Phase-2)
"""
import logging
from typing import Optional, List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Header, Query, Request as FastAPIRequest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from pydantic import BaseModel, Field

# Shared billing library
# Note: shared-billing should be installed as a package via `pip install -e services/shared-billing`
from shared_billing import (
    BillingService,
    SubscriptionPlan,
    UserSubscription,
    PlanNotFoundError,
    SubscriptionNotFoundError,
    InvalidPlanChangeError,
    QuotaExceededError,
    PaymentService,
)
from shared_billing.models import SubscriptionHistory
from shared_billing.schemas import (
    SubscriptionPlanSchema,
    UserSubscriptionSchema,
    SubscriptionHistorySchema,
    PlanChangePreview,
    AvailablePlansResponse,
    SubscriptionResponse,
    SubscriptionHistoryResponse,
)

from ..dependencies import get_db, get_current_user
from ..models.database import User
from ..config import settings
from ..middleware.rate_limiter import RateLimitConfig

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/billing", tags=["billing-v2"])


# ===== Request/Response Models =====

class CreateSubscriptionRequest(BaseModel):
    """Request to create a new subscription."""
    plan_code: str = Field(..., description="Plan code (e.g., 'normal_basic')")
    billing_cycle: Optional[str] = Field(None, description="'monthly' or 'yearly'")


class ChangePlanRequest(BaseModel):
    """Request to change subscription plan."""
    new_plan_code: str = Field(..., description="Target plan code")


class PreviewChangeRequest(BaseModel):
    """Request to preview plan change."""
    new_plan_code: str = Field(..., description="Target plan code to preview")


class CreatePaymentRequest(BaseModel):
    """Request to create a payment."""
    plan_code: str = Field(..., description="Plan code")
    billing_cycle: str = Field(..., description="'monthly', 'six_months', or 'yearly'")
    payment_gateway: str = Field(..., description="'razorpay' or 'stripe'")


class VerifyPaymentRequest(BaseModel):
    """Request to verify a payment."""
    payment_id: str = Field(..., description="Payment ID from gateway")
    order_id: Optional[str] = Field(None, description="Order ID (for Razorpay)")
    signature: Optional[str] = Field(None, description="Payment signature (for Razorpay)")


class UpcomingPaymentResponse(BaseModel):
    """Response schema for upcoming payment information."""
    user_id: str
    plan_code: str
    plan_name: str
    billing_cycle: str
    payment_due_date: str  # ISO format
    amount_due: float
    currency: str
    days_until_payment: int
    status: str


# ===== Helper Functions =====

async def get_billing_service(db: AsyncSession) -> BillingService:
    """Get BillingService instance for Normal Storage."""
    return BillingService(db, service_type='normal')


async def get_user_subscription_or_create(
    user: User,
    db: AsyncSession
) -> UserSubscription:
    """
    Get user's subscription, or create free tier if none exists.

    This ensures every user always has a subscription.
    """
    billing = BillingService(db, service_type='normal')

    try:
        return await billing.get_user_subscription(user.id)
    except SubscriptionNotFoundError:
        # User doesn't have subscription - create free tier
        logger.info(f"Creating free subscription for user {user.id}")
        subscription = await billing.create_subscription(
            user_id=user.id,
            plan_code='normal_free',
            billing_cycle=None
        )

        # Update user's quota and subscription reference
        user.storage_quota = subscription.plan.storage_bytes
        user.current_subscription_id = subscription.id
        await db.commit()

        return subscription


async def apply_rate_limit(request: Request, rate_config: dict, endpoint_name: str):
    """
    Apply rate limiting to billing endpoints.

    Args:
        request: FastAPI request object
        rate_config: Rate limit configuration (requests, window)
        endpoint_name: Name of endpoint for tracking

    Raises:
        HTTPException: If rate limit exceeded
    """
    if hasattr(request.app.state, "rate_limiter"):
        await request.app.state.rate_limiter.apply_rate_limit(
            request=request,
            rate_limit_config=rate_config,
            endpoint_name=endpoint_name
        )


# ===== Plan Catalog Endpoints =====

@router.get("/plans", response_model=AvailablePlansResponse)
async def get_available_plans(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get all available subscription plans for Normal Storage.

    Returns:
    - List of all active plans
    - User's current subscription (if exists)
    - Upgrade recommendations based on usage
    """
    billing = await get_billing_service(db)

    # Get all available plans
    plans = await billing.get_available_plans(active_only=True)

    # Get user's current subscription
    try:
        current_subscription = await billing.get_user_subscription(current_user.id)
    except SubscriptionNotFoundError:
        current_subscription = None

    # TODO: Calculate upgrade recommendations based on usage
    upgrade_recommendation = None
    if current_subscription and current_user.storage_used > 0:
        usage_percent = (current_user.storage_used / current_user.storage_quota) * 100
        if usage_percent > 80:
            upgrade_recommendation = {
                "reason": f"Storage usage at {usage_percent:.1f}%",
                "recommended_plan": "normal_basic" if current_subscription.plan.tier_name == "free" else None,
                "urgency": "high" if usage_percent > 95 else "medium"
            }

    return AvailablePlansResponse(
        service_type='normal',
        plans=[SubscriptionPlanSchema.from_orm(p) for p in plans],
        current_subscription=UserSubscriptionSchema.from_orm(current_subscription) if current_subscription else None,
        upgrade_recommendation=upgrade_recommendation
    )


@router.get("/plans/{plan_code}", response_model=SubscriptionPlanSchema)
async def get_plan_details(
    plan_code: str,
    db: AsyncSession = Depends(get_db)
):
    """Get details of a specific plan."""
    billing = await get_billing_service(db)

    try:
        plan = await billing.get_plan_by_code(plan_code)
        return SubscriptionPlanSchema.from_orm(plan)
    except PlanNotFoundError:
        raise HTTPException(404, f"Plan not found: {plan_code}")


# ===== Subscription Management Endpoints =====

@router.get("/subscription", response_model=UserSubscriptionSchema)
async def get_current_subscription(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get user's current subscription with full details.

    Includes:
    - Plan details (quotas, pricing, features)
    - Subscription status and dates
    - Usage statistics
    """
    subscription = await get_user_subscription_or_create(current_user, db)
    return UserSubscriptionSchema.from_orm(subscription)


@router.post("/subscribe", response_model=SubscriptionResponse, status_code=201)
async def create_subscription(
    request: CreateSubscriptionRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Create a new subscription (usually called during registration).

    For Phase-1: Free plans are activated immediately.
    For Phase-2: Paid plans will redirect to Stripe checkout.
    """
    billing = await get_billing_service(db)

    try:
        # Check if user already has subscription
        existing = await billing.get_user_subscription(current_user.id, include_plan=False)
        raise HTTPException(400, f"User already has subscription: {existing.id}")
    except SubscriptionNotFoundError:
        pass  # Expected - proceed with creation

    try:
        plan = await billing.get_plan_by_code(request.plan_code)

        # Create subscription
        subscription = await billing.create_subscription(
            user_id=current_user.id,
            plan_code=request.plan_code,
            billing_cycle=request.billing_cycle
        )

        # Update user's quota
        current_user.storage_quota = plan.storage_bytes
        current_user.current_subscription_id = subscription.id
        await db.commit()

        logger.info(f"Created subscription {subscription.id} for user {current_user.id}")

        return SubscriptionResponse(
            subscription=UserSubscriptionSchema.from_orm(subscription),
            message=f"Successfully subscribed to {plan.display_name}"
        )

    except PlanNotFoundError:
        raise HTTPException(404, f"Plan not found: {request.plan_code}")


@router.post("/preview-change", response_model=PlanChangePreview)
async def preview_plan_change(
    request: PreviewChangeRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Preview what would happen if user changes to a different plan.

    Shows:
    - Current vs new plan comparison
    - Quota changes
    - Warnings (e.g., usage exceeds new quota)
    - Pricing changes (Phase-2)
    """
    billing = await get_billing_service(db)

    try:
        preview = await billing.preview_change(current_user.id, request.new_plan_code)

        # Add current usage context
        warnings = preview.get('warnings', [])
        if preview['change_type'] == 'downgrade':
            new_plan = preview['new_plan']
            if current_user.storage_used > new_plan.storage_bytes:
                warnings.append(
                    f"⚠️ Your current storage usage ({current_user.storage_used / (1024**3):.2f} GB) "
                    f"exceeds the new plan's quota ({new_plan.storage_bytes / (1024**3):.0f} GB). "
                    f"You'll need to delete files before downgrading."
                )

        return PlanChangePreview(
            current_plan=SubscriptionPlanSchema.from_orm(preview['current_plan']),
            new_plan=SubscriptionPlanSchema.from_orm(preview['new_plan']),
            change_type=preview['change_type'],
            storage_change_gb=preview['storage_change_gb'],
            bandwidth_change_mbps=preview['bandwidth_change_mbps'],
            warnings=warnings
        )

    except PlanNotFoundError as e:
        raise HTTPException(404, str(e))
    except SubscriptionNotFoundError as e:
        raise HTTPException(404, str(e))


@router.post("/upgrade", response_model=SubscriptionResponse)
async def upgrade_subscription(
    request: ChangePlanRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Upgrade subscription to a higher tier.

    For free plans, upgrades immediately.
    For paid plans, use /create-payment endpoint instead.
    In DEV_MODE, all plans upgrade immediately.
    """
    billing = await get_billing_service(db)

    try:
        # Get the plan to check if it's free
        plan = await billing.get_plan_by_code(request.new_plan_code)
        
        # Check if plan is free (no monthly price) or DEV_MODE is enabled
        is_free = plan.price_monthly is None or float(plan.price_monthly) == 0
        
        if is_free or settings.DEV_MODE:
            # Free plan or DEV_MODE - upgrade immediately
            subscription = await billing.upgrade_subscription(
                user_id=current_user.id,
                new_plan_code=request.new_plan_code,
                reason='user_request'
            )

            # Update user's quota
            current_user.storage_quota = subscription.plan.storage_bytes
            await db.commit()

            logger.info(f"User {current_user.id} upgraded to {request.new_plan_code} (DEV_MODE={settings.DEV_MODE})")

            message = f"Successfully upgraded to {subscription.plan.display_name}"
            if settings.DEV_MODE and not is_free:
                message += " (DEV_MODE: payment bypassed)"

            return SubscriptionResponse(
                subscription=UserSubscriptionSchema.from_orm(subscription),
                message=message
            )
        else:
            # Paid plan - redirect to payment
            raise HTTPException(
                400,
                "This is a paid plan. Please use /create-payment endpoint to proceed with payment."
            )

    except PlanNotFoundError as e:
        raise HTTPException(404, str(e))
    except SubscriptionNotFoundError as e:
        raise HTTPException(404, str(e))
    except InvalidPlanChangeError as e:
        raise HTTPException(400, str(e))


@router.post("/downgrade", response_model=SubscriptionResponse)
async def downgrade_subscription(
    request: ChangePlanRequest,
    immediate: bool = Query(False, description="Apply immediately or at period end"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Downgrade subscription to a lower tier.

    Validates that current usage doesn't exceed new plan's quota.
    """
    billing = await get_billing_service(db)

    try:
        subscription = await billing.downgrade_subscription(
            user_id=current_user.id,
            new_plan_code=request.new_plan_code,
            current_usage_bytes=current_user.storage_used,
            immediate=immediate,
            reason='user_request'
        )

        # Update user's quota
        current_user.storage_quota = subscription.plan.storage_bytes
        await db.commit()

        logger.info(f"User {current_user.id} downgraded to {request.new_plan_code}")

        return SubscriptionResponse(
            subscription=UserSubscriptionSchema.from_orm(subscription),
            message=f"Successfully downgraded to {subscription.plan.display_name}"
        )

    except PlanNotFoundError as e:
        raise HTTPException(404, str(e))
    except SubscriptionNotFoundError as e:
        raise HTTPException(404, str(e))
    except InvalidPlanChangeError as e:
        raise HTTPException(400, str(e))
    except QuotaExceededError as e:
        raise HTTPException(400, str(e))


@router.post("/cancel", response_model=SubscriptionResponse)
async def cancel_subscription(
    immediate: bool = Query(False, description="Cancel immediately or at period end"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Cancel subscription.

    For free plans: Converts to default free tier
    For paid plans: Cancels at period end (or immediately if requested)
    """
    billing = await get_billing_service(db)

    try:
        subscription = await billing.cancel_subscription(
            user_id=current_user.id,
            immediate=immediate,
            reason='user_request'
        )

        logger.info(f"User {current_user.id} cancelled subscription")

        return SubscriptionResponse(
            subscription=UserSubscriptionSchema.from_orm(subscription),
            message="Subscription cancelled" + (" immediately" if immediate else " at period end")
        )

    except SubscriptionNotFoundError as e:
        raise HTTPException(404, str(e))


@router.get("/history", response_model=SubscriptionHistoryResponse)
async def get_subscription_history(
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get subscription change history for audit trail.

    Returns all subscription events: created, upgraded, downgraded, cancelled, etc.
    """
    billing = await get_billing_service(db)

    history = await billing.get_subscription_history(
        user_id=current_user.id,
        limit=limit,
        offset=offset
    )

    # Get total count
    result = await db.execute(
        select(func.count()).select_from(
            select(1).where(
                SubscriptionHistory.user_id == current_user.id,
                SubscriptionHistory.service_type == 'normal'
            ).subquery()
        )
    )
    total = result.scalar() or 0

    return SubscriptionHistoryResponse(
        history=[SubscriptionHistorySchema.from_orm(h) for h in history],
        total=total
    )


@router.get("/upcoming-payment", response_model=UpcomingPaymentResponse)
async def get_upcoming_payment(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get upcoming payment information for dashboard banner.

    Returns payment due date, amount, and days until payment.
    Only returns data if payment is within 7 days.
    Returns 404 if no upcoming payment or user is on free plan.
    """
    from datetime import datetime, timezone

    billing = await get_billing_service(db)

    try:
        subscription = await billing.get_user_subscription(
            current_user.id,
            include_plan=True
        )
    except SubscriptionNotFoundError:
        raise HTTPException(
            status_code=404,
            detail="No active subscription found"
        )

    # Check if user is on free plan (no payment required)
    if not subscription.next_payment_at or subscription.billing_cycle is None:
        raise HTTPException(
            status_code=404,
            detail="No upcoming payment - free plan"
        )

    # Calculate days until payment
    now = datetime.now(timezone.utc)
    days_until = (subscription.next_payment_at - now).days

    # Only return if within 7 days
    if days_until > 7:
        raise HTTPException(
            status_code=404,
            detail="No payment due within 7 days"
        )

    # Get amount for current billing cycle
    plan = subscription.plan
    if subscription.billing_cycle == 'monthly':
        amount = float(plan.price_monthly) if plan.price_monthly else 0
    elif subscription.billing_cycle == 'six_months':
        amount = float(plan.price_six_months) if plan.price_six_months else 0
    elif subscription.billing_cycle == 'yearly':
        amount = float(plan.price_yearly) if plan.price_yearly else 0
    else:
        amount = 0

    return UpcomingPaymentResponse(
        user_id=str(current_user.id),
        plan_code=plan.plan_code,
        plan_name=plan.display_name,
        billing_cycle=subscription.billing_cycle,
        payment_due_date=subscription.next_payment_at.isoformat(),
        amount_due=amount,
        currency="INR",
        days_until_payment=days_until,
        status=subscription.status
    )


# ===== Usage & Recommendations =====

@router.get("/usage")
async def get_usage_stats(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get detailed usage statistics relative to plan quotas.
    """
    subscription = await get_user_subscription_or_create(current_user, db)
    plan = subscription.plan

    storage_percent = (current_user.storage_used / plan.storage_bytes * 100) if plan.storage_bytes > 0 else 0

    return {
        "storage": {
            "used_bytes": current_user.storage_used,
            "quota_bytes": plan.storage_bytes,
            "used_gb": round(current_user.storage_used / (1024**3), 2),
            "quota_gb": round(plan.storage_bytes / (1024**3), 2),
            "percentage": round(storage_percent, 1),
            "available_gb": round((plan.storage_bytes - current_user.storage_used) / (1024**3), 2)
        },
        "bandwidth": {
            "limit_mbps": plan.bandwidth_mbps,
            "burst_mbps": plan.bandwidth_burst_mbps,
        },
        "streams": {
            "max_concurrent": plan.max_concurrent_streams
        },
        "plan": {
            "code": plan.plan_code,
            "name": plan.display_name,
            "tier": plan.tier_name
        }
    }


@router.get("/recommendations")
async def get_upgrade_recommendations(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get personalized upgrade recommendations based on usage patterns.
    """
    subscription = await get_user_subscription_or_create(current_user, db)
    plan = subscription.plan

    recommendations = []

    # Check storage usage
    if plan.storage_bytes > 0:
        usage_percent = (current_user.storage_used / plan.storage_bytes) * 100

        if usage_percent > 80:
            # Get next tier plan
            billing = await get_billing_service(db)
            all_plans = await billing.get_available_plans()
            next_plan = next((p for p in all_plans if p.sort_order == plan.sort_order + 1), None)

            if next_plan:
                recommendations.append({
                    "type": "storage_limit",
                    "severity": "high" if usage_percent > 95 else "medium",
                    "message": f"You've used {usage_percent:.1f}% of your storage quota",
                    "recommended_plan": next_plan.plan_code,
                    "recommended_plan_name": next_plan.display_name,
                    "benefit": f"Upgrade to get {next_plan.storage_bytes / (1024**3):.0f}GB storage"
                })

    return {
        "has_recommendations": len(recommendations) > 0,
        "recommendations": recommendations
    }


# ===== Stripe Webhook Handler =====

# ===== Payment Gateway Endpoints =====

@router.get("/payment-gateways")
async def get_payment_gateways():
    """
    Get available payment gateways and their status.
    
    Returns list of enabled payment gateways with their capabilities.
    """
    gateways = []
    
    # Razorpay
    if settings.RAZORPAY_ENABLED and settings.RAZORPAY_KEY_ID:
        gateways.append({
            "id": "razorpay",
            "name": "Razorpay",
            "enabled": True,
            "supported_currencies": ["INR"],
            "supported_methods": ["card", "netbanking", "upi", "wallet"],
            "publishable_key": settings.RAZORPAY_KEY_ID
        })
    
    # Stripe
    if settings.STRIPE_ENABLED and settings.STRIPE_SECRET_KEY:
        gateways.append({
            "id": "stripe",
            "name": "Stripe",
            "enabled": True,
            "supported_currencies": ["USD", "EUR", "INR"],
            "supported_methods": ["card"],
            "publishable_key": settings.STRIPE_PUBLISHABLE_KEY
        })
    
    return {"gateways": gateways}


@router.post("/create-payment")
async def create_payment(
    payment_request: CreatePaymentRequest,
    http_request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
):
    """
    Create a payment for subscription upgrade.

    For free plans, upgrades immediately without payment.
    For paid plans, creates payment with selected gateway and returns payment URL.
    In DEV_MODE, all plans upgrade immediately without payment.

    Supports Idempotency-Key header to prevent duplicate payments on retry.

    Rate Limited: 10 requests per hour per user
    """
    # Apply rate limiting
    await apply_rate_limit(http_request, RateLimitConfig.PAYMENT_CREATE, "payment_create")

    # Idempotency check: return cached result if same key was used before
    if idempotency_key:
        from ..database import redis_client
        if redis_client:
            cache_key = f"idem:payment:{current_user.id}:{idempotency_key}"
            cached_result = await redis_client.get(cache_key)
            if cached_result:
                import json as _json
                if isinstance(cached_result, bytes):
                    cached_result = cached_result.decode("utf-8")
                logger.info(f"Idempotent payment request: returning cached result for key {idempotency_key}")
                return _json.loads(cached_result)

    billing = await get_billing_service(db)
    
    # Get the plan
    try:
        plan = await billing.get_plan_by_code(payment_request.plan_code)
    except PlanNotFoundError:
        raise HTTPException(404, f"Plan not found: {payment_request.plan_code}")

    # Check if plan is free
    price_field = f"price_{payment_request.billing_cycle}" if payment_request.billing_cycle != "six_months" else "price_six_months"
    plan_price = getattr(plan, price_field, None)

    # DEV_MODE: Bypass payment for all plans
    if settings.DEV_MODE:
        try:
            subscription = await billing.upgrade_subscription(
                user_id=current_user.id,
                new_plan_code=payment_request.plan_code,
                reason='user_request'
            )

            # Update user's quota
            current_user.storage_quota = subscription.plan.storage_bytes
            await db.commit()

            logger.info(f"DEV_MODE: Upgraded user {current_user.id} to {payment_request.plan_code} without payment")
            
            return {
                "success": True,
                "free_plan": False,
                "dev_mode": True,
                "subscription": UserSubscriptionSchema.from_orm(subscription),
                "message": f"Successfully upgraded to {subscription.plan.display_name} (DEV_MODE: payment bypassed)"
            }
        except Exception as e:
            logger.error(f"Failed to upgrade plan in DEV_MODE: {e}")
            raise HTTPException(500, f"Failed to upgrade: {str(e)}")
    
    if plan_price is None or float(plan_price) == 0:
        # Free plan - upgrade immediately
        try:
            subscription = await billing.upgrade_subscription(
                user_id=current_user.id,
                new_plan_code=payment_request.plan_code,
                reason='user_request'
            )
            
            # Update user's quota
            current_user.storage_quota = subscription.plan.storage_bytes
            await db.commit()
            
            return {
                "success": True,
                "free_plan": True,
                "subscription": UserSubscriptionSchema.from_orm(subscription),
                "message": f"Successfully upgraded to {subscription.plan.display_name}"
            }
        except Exception as e:
            logger.error(f"Failed to upgrade free plan: {e}")
            raise HTTPException(500, f"Failed to upgrade: {str(e)}")
    
    # Paid plan - create payment
    # Get gateway-specific plan ID
    if payment_request.payment_gateway == 'razorpay':
        plan_id_field = f"razorpay_plan_id_{payment_request.billing_cycle}" if payment_request.billing_cycle != "six_months" else "razorpay_plan_id_six_months"
        plan_id = getattr(plan, plan_id_field, None)
        if not plan_id:
            raise HTTPException(400, f"Razorpay plan ID not configured for {payment_request.billing_cycle} billing cycle")
    elif payment_request.payment_gateway == 'stripe':
        plan_id_field = f"stripe_price_id_{payment_request.billing_cycle}" if payment_request.billing_cycle != "six_months" else "stripe_price_id_six_months"
        plan_id = getattr(plan, plan_id_field, None)
        if not plan_id:
            raise HTTPException(400, f"Stripe price ID not configured for {payment_request.billing_cycle} billing cycle")
    else:
        raise HTTPException(400, f"Unsupported payment gateway: {payment_request.payment_gateway}")
    
    # Initialize payment service
    try:
        payment_service = PaymentService(
            gateway=payment_request.payment_gateway,
            razorpay_key_id=settings.RAZORPAY_KEY_ID,
            razorpay_key_secret=settings.RAZORPAY_KEY_SECRET,
            razorpay_webhook_secret=settings.RAZORPAY_WEBHOOK_SECRET,
            stripe_secret_key=settings.STRIPE_SECRET_KEY,
            stripe_webhook_secret=settings.STRIPE_WEBHOOK_SECRET,
            stripe_publishable_key=settings.STRIPE_PUBLISHABLE_KEY
        )
    except ValueError as e:
        raise HTTPException(400, f"Payment gateway configuration error: {str(e)}")
    
    # Create payment
    try:
        payment_result = await payment_service.create_payment(
            amount=plan_price,
            currency=plan.currency or 'INR',
            plan_code=payment_request.plan_code,
            billing_cycle=payment_request.billing_cycle,
            user_id=str(current_user.id),
            user_email=current_user.email,
            success_url=settings.PAYMENT_SUCCESS_URL,
            cancel_url=settings.PAYMENT_FAILURE_URL,
            plan_id=plan_id
        )
        
        # Store pending subscription
        # Create subscription with pending_payment status
        try:
            current_subscription = await billing.get_user_subscription(current_user.id)
            # Update existing subscription
            current_subscription.status = 'pending_payment'
            current_subscription.payment_gateway = payment_request.payment_gateway
            if payment_request.payment_gateway == 'razorpay':
                current_subscription.razorpay_order_id = payment_result.get('order_id')
                current_subscription.razorpay_subscription_id = payment_result.get('subscription_id')
            elif payment_request.payment_gateway == 'stripe':
                current_subscription.stripe_customer_id = payment_result.get('customer_id')
                current_subscription.stripe_subscription_id = payment_result.get('subscription_id')
            await db.commit()
        except SubscriptionNotFoundError:
            # Create new pending subscription
            from shared_billing.models import UserSubscription as UserSubscriptionModel
            pending_subscription = UserSubscriptionModel(
                user_id=current_user.id,
                service_type='normal',
                plan_id=plan.id,
                status='pending_payment',
                billing_cycle=payment_request.billing_cycle,
                payment_gateway=payment_request.payment_gateway
            )
            if payment_request.payment_gateway == 'razorpay':
                pending_subscription.razorpay_order_id = payment_result.get('order_id')
                pending_subscription.razorpay_subscription_id = payment_result.get('subscription_id')
            elif payment_request.payment_gateway == 'stripe':
                pending_subscription.stripe_customer_id = payment_result.get('customer_id')
                pending_subscription.stripe_subscription_id = payment_result.get('subscription_id')
            db.add(pending_subscription)
            await db.commit()
            await db.refresh(pending_subscription)
        
        result = {
            "success": True,
            "free_plan": False,
            "payment_url": payment_result.get('payment_url'),
            "order_id": payment_result.get('order_id'),
            "session_id": payment_result.get('session_id'),
            "gateway": payment_request.payment_gateway,
            "gateway_data": payment_result
        }

        # Cache result for idempotency (1 hour TTL)
        if idempotency_key:
            from ..database import redis_client
            import json as _json
            if redis_client:
                cache_key = f"idem:payment:{current_user.id}:{idempotency_key}"
                try:
                    await redis_client.setex(cache_key, 3600, _json.dumps(result, default=str))
                except Exception:
                    pass  # Non-critical

        return result
    except Exception as e:
        logger.error(f"Failed to create payment: {e}")
        raise HTTPException(500, f"Failed to create payment: {str(e)}")


@router.post("/verify-payment")
async def verify_payment(
    verify_request: VerifyPaymentRequest,
    http_request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Verify a payment after completion.

    This endpoint is called by the frontend after payment completion
    to verify the payment and activate the subscription.

    Rate Limited: 20 requests per hour per user
    """
    # Apply rate limiting
    await apply_rate_limit(http_request, RateLimitConfig.PAYMENT_VERIFY, "payment_verify")

    billing = await get_billing_service(db)
    
    # Get current subscription
    try:
        subscription = await billing.get_user_subscription(current_user.id)
    except SubscriptionNotFoundError:
        raise HTTPException(404, "No subscription found")
    
    if not subscription.payment_gateway:
        raise HTTPException(400, "No payment gateway associated with subscription")
    
    # Initialize payment service
    try:
        payment_service = PaymentService(
            gateway=subscription.payment_gateway,
            razorpay_key_id=settings.RAZORPAY_KEY_ID,
            razorpay_key_secret=settings.RAZORPAY_KEY_SECRET,
            razorpay_webhook_secret=settings.RAZORPAY_WEBHOOK_SECRET,
            stripe_secret_key=settings.STRIPE_SECRET_KEY,
            stripe_webhook_secret=settings.STRIPE_WEBHOOK_SECRET,
            stripe_publishable_key=settings.STRIPE_PUBLISHABLE_KEY
        )
    except ValueError as e:
        raise HTTPException(400, f"Payment gateway configuration error: {str(e)}")
    
    # Verify payment
    try:
        is_verified = await payment_service.verify_payment(
            payment_id=verify_request.payment_id,
            order_id=verify_request.order_id,
            signature=verify_request.signature
        )

        if not is_verified:
            raise HTTPException(400, "Payment verification failed")

        # Update subscription status
        subscription.status = 'active'
        subscription.razorpay_payment_id = verify_request.payment_id if subscription.payment_gateway == 'razorpay' else None
        await db.commit()
        
        # Update user quota
        current_user.storage_quota = subscription.plan.storage_bytes
        await db.commit()
        
        return {
            "success": True,
            "verified": True,
            "subscription": UserSubscriptionSchema.from_orm(subscription)
        }
    except Exception as e:
        logger.error(f"Payment verification failed: {e}")
        raise HTTPException(400, f"Payment verification failed: {str(e)}")


@router.post("/webhooks/razorpay")
async def razorpay_webhook(
    request: FastAPIRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    Handle Razorpay webhook events.
    
    Processes payment events and updates subscription status.
    """
    # Get webhook signature
    signature = request.headers.get("X-Razorpay-Signature")
    if not signature:
        raise HTTPException(400, "Missing webhook signature")
    
    # Get payload
    payload = await request.body()
    payload_str = payload.decode('utf-8')
    
    # Initialize payment service
    try:
        payment_service = PaymentService(
            gateway='razorpay',
            razorpay_key_id=settings.RAZORPAY_KEY_ID,
            razorpay_key_secret=settings.RAZORPAY_KEY_SECRET,
            razorpay_webhook_secret=settings.RAZORPAY_WEBHOOK_SECRET,
            stripe_secret_key="",
            stripe_webhook_secret="",
            stripe_publishable_key=""
        )
    except ValueError as e:
        raise HTTPException(400, f"Payment gateway configuration error: {str(e)}")
    
    # Verify webhook
    try:
        event = payment_service.verify_webhook(payload, signature)
    except ValueError as e:
        logger.error(f"Invalid Razorpay webhook signature: {e}")
        raise HTTPException(400, "Invalid webhook signature")
    
    # Process webhook event
    event_type = event.get('event')

    # Deduplicate webhook events using Redis
    event_id = event.get('event_id') or event.get('id')
    if event_id:
        from ..database import redis_client
        if redis_client:
            dedup_key = f"webhook:razorpay:{event_id}"
            already_processed = await redis_client.set(dedup_key, "1", ex=86400, nx=True)
            if not already_processed:
                # NX returned None = key already existed = duplicate event
                logger.info(f"Skipping duplicate Razorpay webhook event: {event_id}")
                return {"status": "ok", "duplicate": True}

    if event_type == 'payment.captured':
        payment_data = event.get('payload', {}).get('payment', {}).get('entity', {})
        payment_id = payment_data.get('id')
        order_id = payment_data.get('order_id')

        # Find subscription by order_id
        result = await db.execute(
            select(UserSubscription).filter(
                UserSubscription.razorpay_order_id == order_id
            )
        )
        subscription = result.scalar_one_or_none()

        if subscription:
            subscription.status = 'active'
            subscription.razorpay_payment_id = payment_id
            subscription.last_payment_at = func.now()
            await db.commit()
            logger.info(f"Razorpay payment captured for subscription {subscription.id}")

    return {"status": "ok"}


@router.post("/webhook/stripe")
async def handle_stripe_webhook(
    request: Request,
    db: AsyncSession = Depends(get_db),
    stripe_signature: str = Header(None, alias="Stripe-Signature")
):
    """
    Handle Stripe webhook events for subscription lifecycle.

    Supported events:
    - customer.subscription.created
    - customer.subscription.updated
    - customer.subscription.deleted
    - invoice.payment_succeeded
    - invoice.payment_failed
    """
    if not settings.STRIPE_WEBHOOK_SECRET:
        raise HTTPException(status_code=503, detail="Stripe webhooks not configured")

    # Get raw body for signature verification
    payload = await request.body()

    try:
        import stripe
        stripe.api_key = settings.STRIPE_SECRET_KEY

        # Verify webhook signature
        event = stripe.Webhook.construct_event(
            payload, stripe_signature, settings.STRIPE_WEBHOOK_SECRET
        )
    except ValueError:
        logger.error("Invalid Stripe webhook payload")
        raise HTTPException(status_code=400, detail="Invalid payload")
    except stripe.error.SignatureVerificationError:
        logger.error("Invalid Stripe webhook signature")
        raise HTTPException(status_code=400, detail="Invalid signature")

    event_type = event['type']
    data = event['data']['object']

    logger.info(f"Received Stripe webhook: {event_type}")

    # Handle different event types
    if event_type == 'customer.subscription.created':
        await _handle_subscription_created(db, data)
    elif event_type == 'customer.subscription.updated':
        await _handle_subscription_updated(db, data)
    elif event_type == 'customer.subscription.deleted':
        await _handle_subscription_deleted(db, data)
    elif event_type == 'invoice.payment_succeeded':
        await _handle_payment_succeeded(db, data)
    elif event_type == 'invoice.payment_failed':
        await _handle_payment_failed(db, data)
    else:
        logger.info(f"Unhandled webhook event type: {event_type}")

    return {"status": "success"}


async def _handle_subscription_created(db: AsyncSession, stripe_subscription: dict):
    """Handle new Stripe subscription creation."""
    customer_id = stripe_subscription['customer']
    stripe_sub_id = stripe_subscription['id']
    stripe_price_id = stripe_subscription['items']['data'][0]['price']['id']

    # Find user by Stripe customer ID
    result = await db.execute(
        select(User).where(User.stripe_customer_id == customer_id)
    )
    user = result.scalar_one_or_none()

    if not user:
        logger.error(f"User not found for Stripe customer {customer_id}")
        return

    # Find plan by Stripe price ID
    result = await db.execute(
        select(SubscriptionPlan).where(
            (SubscriptionPlan.stripe_price_id_monthly == stripe_price_id) |
            (SubscriptionPlan.stripe_price_id_yearly == stripe_price_id)
        )
    )
    plan = result.scalar_one_or_none()

    if not plan:
        logger.error(f"Plan not found for Stripe price {stripe_price_id}")
        return

    # Create subscription
    billing = BillingService(db, service_type='normal')

    try:
        subscription = await billing.create_subscription(
            user_id=user.id,
            plan_code=plan.plan_code,
            billing_cycle='monthly' if 'monthly' in stripe_price_id else 'yearly'
        )

        # Update with Stripe IDs
        subscription.stripe_subscription_id = stripe_sub_id
        subscription.stripe_customer_id = customer_id
        await db.commit()

        logger.info(f"Created subscription {subscription.id} from Stripe webhook for user {user.id}")
    except Exception as e:
        logger.error(f"Error creating subscription from webhook: {e}")
        await db.rollback()


async def _handle_subscription_updated(db: AsyncSession, stripe_subscription: dict):
    """Handle Stripe subscription updates."""
    stripe_sub_id = stripe_subscription['id']
    status = stripe_subscription['status']

    # Find subscription
    result = await db.execute(
        select(UserSubscription).where(
            UserSubscription.stripe_subscription_id == stripe_sub_id
        )
    )
    subscription = result.scalar_one_or_none()

    if not subscription:
        logger.warning(f"Subscription not found for Stripe ID {stripe_sub_id}")
        return

    # Update status based on Stripe status
    status_map = {
        'active': 'active',
        'past_due': 'past_due',
        'unpaid': 'past_due',
        'canceled': 'cancelled',
        'incomplete': 'pending',
        'incomplete_expired': 'cancelled',
        'trialing': 'active',
    }

    new_status = status_map.get(status, 'active')

    if subscription.status != new_status:
        old_status = subscription.status
        subscription.status = new_status
        await db.commit()

        logger.info(f"Updated subscription {subscription.id} status: {old_status} -> {new_status}")


async def _handle_subscription_deleted(db: AsyncSession, stripe_subscription: dict):
    """Handle Stripe subscription cancellation."""
    stripe_sub_id = stripe_subscription['id']

    # Find subscription
    result = await db.execute(
        select(UserSubscription).where(
            UserSubscription.stripe_subscription_id == stripe_sub_id
        )
    )
    subscription = result.scalar_one_or_none()

    if not subscription:
        logger.warning(f"Subscription not found for Stripe ID {stripe_sub_id}")
        return

    # Cancel subscription
    billing = BillingService(db, service_type='normal')

    try:
        await billing.cancel_subscription(
            user_id=subscription.user_id,
            reason="Cancelled via Stripe webhook"
        )
        logger.info(f"Cancelled subscription {subscription.id} from Stripe webhook")
    except Exception as e:
        logger.error(f"Error cancelling subscription from webhook: {e}")


async def _handle_payment_succeeded(db: AsyncSession, invoice: dict):
    """Handle successful payment."""
    stripe_sub_id = invoice.get('subscription')

    if not stripe_sub_id:
        return

    # Find subscription
    result = await db.execute(
        select(UserSubscription).where(
            UserSubscription.stripe_subscription_id == stripe_sub_id
        )
    )
    subscription = result.scalar_one_or_none()

    if subscription:
        # Ensure subscription is active
        if subscription.status != 'active':
            subscription.status = 'active'
            await db.commit()
            logger.info(f"Reactivated subscription {subscription.id} after successful payment")


async def _handle_payment_failed(db: AsyncSession, invoice: dict):
    """Handle failed payment."""
    stripe_sub_id = invoice.get('subscription')

    if not stripe_sub_id:
        return

    # Find subscription
    result = await db.execute(
        select(UserSubscription).where(
            UserSubscription.stripe_subscription_id == stripe_sub_id
        )
    )
    subscription = result.scalar_one_or_none()

    if subscription:
        # Mark as past due
        subscription.status = 'past_due'
        await db.commit()
        logger.warning(f"Marked subscription {subscription.id} as past_due after payment failure")


# ===== Billing Portal =====

@router.post("/portal")
async def create_billing_portal_session(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Create Stripe billing portal session for subscription management.

    Allows customers to:
    - Update payment methods
    - View billing history
    - Download invoices
    - Update billing information

    Returns:
        dict: Contains 'url' field with portal session URL

    Raises:
        HTTPException: 400 if no Stripe customer found
        HTTPException: 503 if Stripe not configured
        HTTPException: 500 if portal creation fails
    """
    if not settings.STRIPE_SECRET_KEY:
        raise HTTPException(
            status_code=503,
            detail="Stripe billing portal not configured"
        )

    try:
        # Get user's subscription
        billing_service = BillingService(db, service_type='normal')
        subscription = await billing_service.get_user_subscription(current_user.id)

        if not subscription:
            raise HTTPException(
                status_code=404,
                detail="No subscription found. Please subscribe to a plan first."
            )

        if not subscription.stripe_customer_id:
            raise HTTPException(
                status_code=400,
                detail="No Stripe customer found. This feature is only available for Stripe customers."
            )

        # Create portal session
        import stripe
        stripe.api_key = settings.STRIPE_SECRET_KEY

        session = stripe.billing_portal.Session.create(
            customer=subscription.stripe_customer_id,
            return_url=f"{settings.PAYMENT_SUCCESS_URL.rsplit('/', 1)[0]}/dashboard"
        )

        logger.info(f"Created billing portal session for user {current_user.id}")

        return {"url": session.url}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to create billing portal: {e}")
        raise HTTPException(
            status_code=500,
            detail="Failed to create billing portal session. Please try again later."
        )


# ===== Admin Endpoints (Future) =====

# TODO: Add admin endpoints for plan management
# POST /admin/plans - Create new plan
# PUT /admin/plans/{id} - Update plan
# DELETE /admin/plans/{id} - Deactivate plan
# POST /admin/users/{id}/subscription - Admin subscription override
