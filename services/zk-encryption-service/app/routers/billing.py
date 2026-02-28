"""
Unified Billing API for ZK Encryption Service

Uses the shared-billing library for subscription management.
This is separate from the Storage Service billing but uses the same unified schema.
"""
import logging
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Header, Query
from fastapi import Request as FastAPIRequest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import func, select
from pydantic import BaseModel, Field

from sqlalchemy.orm import selectinload

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
from shared_billing.models import SubscriptionHistory, Invoice
from shared_billing.schemas import (
    SubscriptionPlanSchema,
    UserSubscriptionSchema,
    PlanChangePreview,
    AvailablePlansResponse,
    SubscriptionResponse,
    InvoiceSchema,
    InvoiceListResponse,
)
from shared_billing.invoice_service import InvoiceService, CompanyConfig

from app.database import get_db
from app.dependencies import get_current_user
from app.models.database import ZKUser
from app.config import settings

logger = logging.getLogger(__name__)
router = APIRouter(tags=["billing"])

# ===== Request Models =====

class PreviewChangeRequest(BaseModel):
    """Request to preview plan change."""
    new_plan_code: str = Field(..., description="Target plan code to preview")


class ChangePlanRequest(BaseModel):
    """Request to change subscription plan."""
    new_plan_code: str = Field(..., description="Target plan code")


class CreateSubscriptionRequest(BaseModel):
    """Request to create a new subscription."""
    plan_code: str = Field(..., description="Plan code (e.g., 'zk_personal')")
    billing_cycle: Optional[str] = Field(None, description="'monthly' or 'yearly'")


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
    """Get BillingService instance for ZK Encryption."""
    return BillingService(db, service_type='zk')


async def _activate_zk_subscription_after_payment(
    db: AsyncSession,
    subscription: "UserSubscription",
    user: "ZKUser",
    payment_id: str,
    billing: "BillingService",
    source: str = "verify-payment",
) -> None:
    """
    Activate and upgrade ZK subscription after successful payment.

    Reads target plan from extra_metadata (stored during create-payment),
    upgrades plan_id, sets billing period dates, syncs user quotas.
    """
    from datetime import datetime as dt, timezone as tz
    from dateutil.relativedelta import relativedelta

    metadata = subscription.extra_metadata or {}
    target_plan_code = metadata.get('target_plan_code')
    target_billing_cycle = metadata.get('target_billing_cycle')

    now = dt.now(tz.utc)
    old_plan = subscription.plan

    if target_plan_code:
        try:
            new_plan = await billing.get_plan_by_code(target_plan_code)
        except PlanNotFoundError:
            logger.error(f"Target plan {target_plan_code} not found during activation")
            new_plan = None

        if new_plan and new_plan.id != subscription.plan_id:
            subscription.plan_id = new_plan.id
            subscription.price_snapshot = {
                'price_monthly': float(new_plan.price_monthly) if new_plan.price_monthly else None,
                'price_six_months': float(new_plan.price_six_months) if new_plan.price_six_months else None,
                'price_yearly': float(new_plan.price_yearly) if new_plan.price_yearly else None,
                'currency': new_plan.currency or 'INR',
                'captured_at': now.isoformat(),
            }
            history = SubscriptionHistory(
                user_id=subscription.user_id,
                service_type='zk',
                subscription_id=subscription.id,
                event_type='upgraded',
                from_plan_id=old_plan.id if old_plan else None,
                to_plan_id=new_plan.id,
                reason=f'payment_verified ({source})',
            )
            db.add(history)
            logger.info(
                f"Upgraded ZK subscription {subscription.id}: "
                f"{old_plan.plan_code if old_plan else '?'} -> {new_plan.plan_code}"
            )

    if target_billing_cycle:
        subscription.billing_cycle = target_billing_cycle
    subscription.current_period_start = now
    if subscription.billing_cycle == 'monthly':
        subscription.current_period_end = now + relativedelta(months=1)
    elif subscription.billing_cycle == 'six_months':
        subscription.current_period_end = now + relativedelta(months=6)
    elif subscription.billing_cycle == 'yearly':
        subscription.current_period_end = now + relativedelta(years=1)
    subscription.next_payment_at = subscription.current_period_end

    subscription.status = 'active'
    subscription.last_payment_at = now
    if subscription.payment_gateway == 'razorpay':
        subscription.razorpay_payment_id = payment_id

    await db.commit()

    # Reload plan relationship
    refreshed = await db.execute(
        select(UserSubscription)
        .options(selectinload(UserSubscription.plan))
        .filter(UserSubscription.id == subscription.id)
    )
    refreshed_sub = refreshed.scalar_one()
    subscription.plan = refreshed_sub.plan

    if user is not None:
        user.storage_quota = subscription.plan.storage_bytes
        await db.commit()

    # Generate invoice (best-effort — never blocks payment flow)
    try:
        active_plan = subscription.plan
        amount = metadata.get('target_plan_price')
        if amount is None:
            price_map = {
                'monthly': active_plan.price_monthly,
                'six_months': active_plan.price_six_months,
                'yearly': active_plan.price_yearly,
            }
            amount = price_map.get(subscription.billing_cycle) or active_plan.price_monthly or 0

        from decimal import Decimal
        inv_svc = InvoiceService(db, service_type="zk")
        invoice = await inv_svc.create_invoice(
            user_id=subscription.user_id,
            user_email=user.email if user else "",
            subscription_id=subscription.id,
            plan_code=active_plan.plan_code,
            plan_name=active_plan.display_name,
            billing_cycle=subscription.billing_cycle or "",
            amount=Decimal(str(amount)),
            currency=active_plan.currency or "INR",
            payment_gateway=subscription.payment_gateway or "",
            razorpay_payment_id=subscription.razorpay_payment_id,
            razorpay_order_id=subscription.razorpay_order_id,
            paid_at=now,
        )
        await db.commit()

        # Email the invoice (fire-and-forget)
        try:
            from app.services.email_service import email_service
            company = _get_company_config()
            pdf_bytes = inv_svc.generate_pdf(invoice, company)
            await email_service.send_invoice_email(
                to_email=user.email if user else "",
                invoice_number=invoice.invoice_number,
                plan_name=active_plan.display_name,
                amount=str(amount),
                currency=active_plan.currency or "INR",
                pdf_bytes=pdf_bytes,
            )
        except Exception as email_err:
            logger.warning(f"ZK invoice email failed (non-critical): {email_err}")

    except Exception as inv_err:
        logger.warning(f"ZK invoice generation failed (non-critical): {inv_err}")


# ===== Plan Catalog Endpoints =====

@router.get("/plans", response_model=AvailablePlansResponse)
async def get_available_plans(
    current_user: ZKUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get all available subscription plans for ZK Encryption.
    """
    billing = await get_billing_service(db)
    
    # Get all available plans
    plans = await billing.get_available_plans(active_only=True)
    
    # Get user's current subscription
    try:
        current_subscription = await billing.get_user_subscription(current_user.id)
    except SubscriptionNotFoundError:
        current_subscription = None
    
    return AvailablePlansResponse(
        service_type='zk',
        plans=[SubscriptionPlanSchema.from_orm(p) for p in plans],
        current_subscription=UserSubscriptionSchema.from_orm(current_subscription) if current_subscription else None,
        upgrade_recommendation=None  # TODO: Add usage-based recommendations
    )


@router.get("/subscription", response_model=UserSubscriptionSchema)
async def get_current_subscription(
    current_user: ZKUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get user's current subscription with full details.
    """
    billing = await get_billing_service(db)

    try:
        subscription = await billing.get_user_subscription(current_user.id, include_plan=True)
        return UserSubscriptionSchema.from_orm(subscription)
    except SubscriptionNotFoundError:
        # Create default subscription if none exists
        subscription = await billing.create_subscription(current_user.id, 'zk_free')
        return UserSubscriptionSchema.from_orm(subscription)


@router.get("/upcoming-payment", response_model=UpcomingPaymentResponse)
async def get_upcoming_payment(
    current_user: ZKUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get upcoming payment information for dashboard banner.

    Returns payment due date, amount, and days until payment.
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

    if not subscription.next_payment_at or subscription.billing_cycle is None:
        raise HTTPException(
            status_code=404,
            detail="No upcoming payment - free plan"
        )

    now = datetime.now(timezone.utc)
    days_until = (subscription.next_payment_at - now).days

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
        currency=plan.currency or "INR",
        days_until_payment=days_until,
        status=subscription.status
    )


@router.post("/preview-change", response_model=PlanChangePreview)
async def preview_plan_change(
    request: PreviewChangeRequest,
    current_user: ZKUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Preview what would happen if user changes to a different plan.
    
    Shows:
    - Current vs new plan comparison
    - Quota changes
    - Warnings (e.g., usage exceeds new quota)
    """
    billing = await get_billing_service(db)
    
    try:
        preview = await billing.preview_change(current_user.id, request.new_plan_code)
        
        # Add current usage context
        warnings = preview.get('warnings', [])
        if preview['change_type'] == 'downgrade':
            new_plan = preview['new_plan']
            if current_user.storage_used > new_plan.storage_bytes and new_plan.storage_bytes != -1:
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
    except SubscriptionNotFoundError:
        raise HTTPException(404, "No active subscription found")
    except PlanNotFoundError:
        raise HTTPException(404, f"Plan not found: {request.new_plan_code}")


@router.post("/upgrade", response_model=SubscriptionResponse)
async def upgrade_subscription(
    request: ChangePlanRequest,
    current_user: ZKUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Upgrade subscription to a higher tier.
    
    For free plans, upgrades immediately.
    For paid plans, use /create-payment endpoint instead.
    """
    billing = await get_billing_service(db)
    
    try:
        # Get the plan to check if it's free
        plan = await billing.get_plan_by_code(request.new_plan_code)
        
        # Check if plan is free (no monthly price)
        if plan.price_monthly is None or float(plan.price_monthly) == 0:
            # Free plan - upgrade immediately
            subscription = await billing.upgrade_subscription(
                user_id=current_user.id,
                new_plan_code=request.new_plan_code,
                reason='user_request'
            )
            
            # Update user's quota
            current_user.storage_quota = subscription.plan.storage_bytes
            await db.commit()
            
            logger.info(f"User {current_user.id} upgraded to {request.new_plan_code}")
            
            return SubscriptionResponse(
                subscription=UserSubscriptionSchema.from_orm(subscription),
                message=f"Successfully upgraded to {subscription.plan.display_name}"
            )
        else:
            # Paid plan - redirect to payment
            raise HTTPException(
                400,
                "This is a paid plan. Please use /create-payment endpoint to proceed with payment."
            )
    except SubscriptionNotFoundError as e:
        raise HTTPException(404, str(e))
    except PlanNotFoundError as e:
        raise HTTPException(404, str(e))
    except InvalidPlanChangeError as e:
        raise HTTPException(400, str(e))


@router.post("/downgrade", response_model=SubscriptionResponse)
async def downgrade_subscription(
    request: ChangePlanRequest,
    immediate: bool = Query(True, description="Apply immediately or at period end"),
    current_user: ZKUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Downgrade subscription to a lower tier.
    
    Args:
        immediate: If True, apply immediately. If False, apply at period end.
    """
    billing = await get_billing_service(db)
    
    try:
        subscription = await billing.downgrade_subscription(
            user_id=current_user.id,
            new_plan_code=request.new_plan_code,
            current_usage_bytes=current_user.storage_used,
            immediate=immediate
        )
        
        # Update user's quota
        current_user.storage_quota = subscription.plan.storage_bytes
        await db.commit()
        
        logger.info(f"User {current_user.id} downgraded to {request.new_plan_code}")
        
        return SubscriptionResponse(
            subscription=UserSubscriptionSchema.from_orm(subscription),
            message=f"Successfully downgraded to {subscription.plan.display_name}"
        )
    except SubscriptionNotFoundError as e:
        raise HTTPException(404, str(e))
    except PlanNotFoundError as e:
        raise HTTPException(404, str(e))
    except InvalidPlanChangeError as e:
        raise HTTPException(400, str(e))
    except QuotaExceededError as e:
        raise HTTPException(400, f"Cannot downgrade: {str(e)}")


@router.post("/change-plan", response_model=SubscriptionResponse)
async def change_plan(
    request: ChangePlanRequest,
    current_user: ZKUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Change user's subscription plan (upgrade or downgrade).
    """
    billing = await get_billing_service(db)
    
    try:
        current_subscription = await billing.get_user_subscription(current_user.id)
        new_plan = await billing.get_plan_by_code(request.new_plan_code)
        
        # Determine if upgrade or downgrade
        if new_plan.sort_order > current_subscription.plan.sort_order:
            subscription = await billing.upgrade_subscription(
                user_id=current_user.id,
                new_plan_code=request.new_plan_code
            )
        elif new_plan.sort_order < current_subscription.plan.sort_order:
            subscription = await billing.downgrade_subscription(
                user_id=current_user.id,
                new_plan_code=request.new_plan_code,
                current_usage_bytes=current_user.storage_used,
                immediate=True
            )
        else:
            raise HTTPException(400, "Already on this plan")
        
        # Update user's quota
        current_user.storage_quota = subscription.plan.storage_bytes
        await db.commit()
        
        return SubscriptionResponse(
            subscription=UserSubscriptionSchema.from_orm(subscription),
            message=f"Successfully changed to {new_plan.display_name}"
        )
    except SubscriptionNotFoundError:
        raise HTTPException(404, "No active subscription found")
    except PlanNotFoundError:
        raise HTTPException(404, f"Plan not found: {request.new_plan_code}")
    except InvalidPlanChangeError as e:
        raise HTTPException(400, str(e))
    except QuotaExceededError as e:
        raise HTTPException(400, f"Cannot downgrade: {str(e)}")


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
    request: CreatePaymentRequest,
    current_user: ZKUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Create a payment for subscription upgrade.
    
    For free plans, upgrades immediately without payment.
    For paid plans, creates payment with selected gateway and returns payment URL.
    In DEV_MODE, all plans upgrade immediately without payment.
    """
    billing = await get_billing_service(db)
    
    # Get the plan
    try:
        plan = await billing.get_plan_by_code(request.plan_code)
    except PlanNotFoundError:
        raise HTTPException(404, f"Plan not found: {request.plan_code}")
    
    # Check if plan is free
    price_field = f"price_{request.billing_cycle}" if request.billing_cycle != "six_months" else "price_six_months"
    plan_price = getattr(plan, price_field, None)
    
    # DEV_MODE: Bypass payment for all plans
    if settings.DEV_MODE:
        try:
            subscription = await billing.upgrade_subscription(
                user_id=current_user.id,
                new_plan_code=request.plan_code,
                reason='user_request'
            )
            
            # Update user's quota
            current_user.storage_quota = subscription.plan.storage_bytes
            await db.commit()
            
            logger.info(f"DEV_MODE: Upgraded user {current_user.id} to {request.plan_code} without payment")
            
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
                new_plan_code=request.plan_code,
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
    
    # Paid plan - get gateway-specific plan ID
    plan_id = None
    if request.payment_gateway == 'razorpay':
        plan_id_field = f"razorpay_plan_id_{request.billing_cycle}" if request.billing_cycle != "six_months" else "razorpay_plan_id_six_months"
        plan_id = getattr(plan, plan_id_field, None)
        if not plan_id:
            logger.info(f"No Razorpay plan ID for {request.billing_cycle}; using order-based payment")
    elif request.payment_gateway == 'stripe':
        plan_id_field = f"stripe_price_id_{request.billing_cycle}" if request.billing_cycle != "six_months" else "stripe_price_id_six_months"
        plan_id = getattr(plan, plan_id_field, None)
        if not plan_id:
            raise HTTPException(400, f"Stripe price ID not configured for {request.billing_cycle} billing cycle")
    else:
        raise HTTPException(400, f"Unsupported payment gateway: {request.payment_gateway}")

    try:
        payment_service = PaymentService(
            gateway=request.payment_gateway,
            razorpay_key_id=settings.RAZORPAY_KEY_ID,
            razorpay_key_secret=settings.RAZORPAY_KEY_SECRET,
            razorpay_webhook_secret=settings.RAZORPAY_WEBHOOK_SECRET,
            stripe_secret_key=settings.STRIPE_SECRET_KEY,
            stripe_webhook_secret=settings.STRIPE_WEBHOOK_SECRET,
            stripe_publishable_key=settings.STRIPE_PUBLISHABLE_KEY
        )
    except ValueError as e:
        raise HTTPException(400, f"Payment gateway configuration error: {str(e)}")

    try:
        payment_result = await payment_service.create_payment(
            amount=plan_price,
            currency=plan.currency or 'INR',
            plan_code=request.plan_code,
            billing_cycle=request.billing_cycle,
            user_id=str(current_user.id),
            user_email=current_user.email,
            success_url=settings.PAYMENT_SUCCESS_URL,
            cancel_url=settings.PAYMENT_FAILURE_URL,
            plan_id=plan_id
        )

        # Store target plan info for upgrade after payment
        pending_metadata = {
            'target_plan_code': request.plan_code,
            'target_plan_id': str(plan.id),
            'target_billing_cycle': request.billing_cycle,
            'target_plan_price': float(plan_price),
            'target_plan_currency': plan.currency or 'INR',
        }
        try:
            current_subscription = await billing.get_user_subscription(current_user.id)
            current_subscription.status = 'pending_payment'
            current_subscription.payment_gateway = request.payment_gateway
            current_subscription.extra_metadata = pending_metadata
            if request.payment_gateway == 'razorpay':
                current_subscription.razorpay_order_id = payment_result.get('order_id')
                current_subscription.razorpay_subscription_id = payment_result.get('subscription_id')
            elif request.payment_gateway == 'stripe':
                current_subscription.stripe_customer_id = payment_result.get('customer_id')
                current_subscription.stripe_subscription_id = payment_result.get('subscription_id')
            await db.commit()
        except SubscriptionNotFoundError:
            from shared_billing.models import UserSubscription as UserSubscriptionModel
            pending_subscription = UserSubscriptionModel(
                user_id=current_user.id,
                service_type='zk',
                plan_id=plan.id,
                status='pending_payment',
                billing_cycle=request.billing_cycle,
                payment_gateway=request.payment_gateway,
                extra_metadata=pending_metadata,
            )
            if request.payment_gateway == 'razorpay':
                pending_subscription.razorpay_order_id = payment_result.get('order_id')
                pending_subscription.razorpay_subscription_id = payment_result.get('subscription_id')
            elif request.payment_gateway == 'stripe':
                pending_subscription.stripe_customer_id = payment_result.get('customer_id')
                pending_subscription.stripe_subscription_id = payment_result.get('subscription_id')
            db.add(pending_subscription)
            await db.commit()
            await db.refresh(pending_subscription)

        return {
            "success": True,
            "free_plan": False,
            "payment_url": payment_result.get('payment_url'),
            "order_id": payment_result.get('order_id'),
            "session_id": payment_result.get('session_id'),
            "gateway": request.payment_gateway,
            "gateway_data": payment_result
        }
    except Exception as e:
        logger.error(f"Failed to create payment: {e}")
        raise HTTPException(500, f"Failed to create payment: {str(e)}")


@router.post("/verify-payment")
async def verify_payment(
    request: VerifyPaymentRequest,
    current_user: ZKUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Verify a payment after completion.
    
    This endpoint is called by the frontend after payment completion
    to verify the payment and activate the subscription.
    """
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
            payment_id=request.payment_id,
            order_id=request.order_id,
            signature=request.signature
        )

        if not is_verified:
            raise HTTPException(400, "Payment verification failed")

        await _activate_zk_subscription_after_payment(
            db=db,
            subscription=subscription,
            user=current_user,
            payment_id=request.payment_id,
            billing=billing,
        )

        return {
            "success": True,
            "verified": True,
            "subscription": UserSubscriptionSchema.from_orm(subscription)
        }
    except HTTPException:
        raise
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
    import json as _json

    signature = request.headers.get("X-Razorpay-Signature")
    payload = await request.body()
    payload_str = payload.decode('utf-8')

    is_test_mode = settings.RAZORPAY_KEY_ID.startswith('rzp_test_')
    if settings.RAZORPAY_WEBHOOK_SECRET:
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
            event = payment_service.verify_webhook(payload, signature)
        except (ValueError, Exception) as e:
            logger.error(f"Invalid Razorpay webhook signature: {e}")
            raise HTTPException(400, "Invalid webhook signature")
    elif is_test_mode:
        logger.warning("RAZORPAY_WEBHOOK_SECRET not set — skipping signature check (TEST MODE ONLY)")
        event = _json.loads(payload_str)
    else:
        logger.error("RAZORPAY_WEBHOOK_SECRET not configured for production")
        raise HTTPException(400, "Webhook secret not configured")

    event_type = event.get('event')

    if event_type == 'payment.captured':
        payment_data = event.get('payload', {}).get('payment', {}).get('entity', {})
        payment_id = payment_data.get('id')
        order_id = payment_data.get('order_id')

        from shared_billing.models import UserSubscription as UserSubscriptionModel
        result = await db.execute(
            select(UserSubscriptionModel)
            .options(selectinload(UserSubscriptionModel.plan))
            .filter(UserSubscriptionModel.razorpay_order_id == order_id)
        )
        subscription = result.scalar_one_or_none()

        if subscription:
            if subscription.status == 'active' and subscription.razorpay_payment_id == payment_id:
                logger.info(f"Subscription {subscription.id} already activated for payment {payment_id}")
            else:
                billing = BillingService(db, service_type='zk')
                user_result = await db.execute(select(ZKUser).filter(ZKUser.id == subscription.user_id))
                user_obj = user_result.scalar_one_or_none()
                await _activate_zk_subscription_after_payment(
                    db=db,
                    subscription=subscription,
                    user=user_obj,
                    payment_id=payment_id,
                    billing=billing,
                    source="webhook:payment.captured",
                )
                logger.info(f"Razorpay payment captured — ZK subscription {subscription.id} activated")

    return {"status": "ok"}


@router.post("/webhooks/stripe")
async def stripe_webhook(
    request: FastAPIRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    Handle Stripe webhook events.
    
    Processes payment events and updates subscription status.
    """
    # Get webhook signature
    signature = request.headers.get("Stripe-Signature")
    if not signature:
        raise HTTPException(400, "Missing webhook signature")
    
    # Get payload
    payload = await request.body()
    
    # Initialize payment service
    try:
        payment_service = PaymentService(
            gateway='stripe',
            razorpay_key_id="",
            razorpay_key_secret="",
            razorpay_webhook_secret="",
            stripe_secret_key=settings.STRIPE_SECRET_KEY,
            stripe_webhook_secret=settings.STRIPE_WEBHOOK_SECRET,
            stripe_publishable_key=settings.STRIPE_PUBLISHABLE_KEY
        )
    except ValueError as e:
        raise HTTPException(400, f"Payment gateway configuration error: {str(e)}")
    
    # Verify webhook
    try:
        event = payment_service.verify_webhook(payload, signature)
    except ValueError as e:
        logger.error(f"Invalid Stripe webhook signature: {e}")
        raise HTTPException(400, "Invalid webhook signature")
    
    # Process webhook event
    event_type = event.get('type')
    
    if event_type == 'checkout.session.completed':
        session = event.get('data', {}).get('object', {})
        subscription_id = session.get('subscription')
        
        if subscription_id:
            # Find subscription by Stripe subscription ID
            from sqlalchemy import select
            from shared_billing.models import UserSubscription as UserSubscriptionModel
            
            result = await db.execute(
                select(UserSubscriptionModel).filter(
                    UserSubscriptionModel.stripe_subscription_id == subscription_id
                )
            )
            subscription = result.scalar_one_or_none()
            
            if subscription:
                subscription.status = 'active'
                subscription.last_payment_at = func.now()
                await db.commit()
                logger.info(f"Stripe payment completed for subscription {subscription.id}")
    
    return {"status": "ok"}


# ===== Legacy Stripe Endpoints (Phase-2 - not yet implemented) =====

@router.post("/create-checkout-session")
async def create_checkout_session(
    plan_type: str,
    current_user: ZKUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Create a Stripe Checkout session (Phase-2 - not yet implemented).
    Use /api/v1/billing/change-plan for now.
    """
    raise HTTPException(501, "Stripe checkout not yet implemented. Use /api/v1/billing/change-plan")


@router.post("/create-portal-session")
async def create_portal_session(
    current_user: ZKUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Create a Stripe Customer Portal session (Phase-2 - not yet implemented).
    """
    raise HTTPException(501, "Stripe portal not yet implemented")


# Legacy endpoint - now uses unified billing
@router.get("/subscription/legacy")
async def get_subscription_status_legacy(
    current_user: ZKUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Legacy endpoint for subscription status (backward compatibility).
    Use /api/v1/billing/subscription instead.
    """
    billing = await get_billing_service(db)
    
    try:
        subscription = await billing.get_user_subscription(current_user.id, include_plan=True)
        plan = subscription.plan
    except SubscriptionNotFoundError:
        # Return default free plan info
        return {
            "plan_type": "free",
            "plan_name": "Free",
            "storage_quota": current_user.storage_quota,
            "storage_used": current_user.storage_used,
            "storage_quota_gb": round(current_user.storage_quota / (1024**3), 2),
            "storage_used_gb": round(current_user.storage_used / (1024**3), 2),
            "usage_percent": round(
                (current_user.storage_used / current_user.storage_quota * 100)
                if current_user.storage_quota > 0 else 0, 1
            ),
            "billing_status": "active",
            "has_subscription": False,
        }
    
    return {
        "plan_type": plan.tier_name,
        "plan_name": plan.display_name,
        "storage_quota": plan.storage_bytes,
        "storage_used": current_user.storage_used,
        "storage_quota_gb": round(plan.storage_bytes / (1024**3), 2),
        "storage_used_gb": round(current_user.storage_used / (1024**3), 2),
        "usage_percent": round(
            (current_user.storage_used / plan.storage_bytes * 100)
            if plan.storage_bytes > 0 else 0, 1
        ),
        "billing_status": subscription.status,
        "has_subscription": True,
    }


@router.post("/webhooks/stripe")
async def handle_stripe_webhook(
    request: FastAPIRequest,
    stripe_signature: str = Header(None, alias="stripe-signature"),
    db: AsyncSession = Depends(get_db)
):
    """
    Handle Stripe webhook events (Phase-2 - not yet implemented).
    """
    # TODO: Implement Stripe webhook handling for Phase-2
    raise HTTPException(501, "Stripe webhooks not yet implemented")
    """
    Handle Stripe webhook events for ZK service.
    
    Events handled:
    - customer.subscription.created
    - customer.subscription.updated
    - customer.subscription.deleted
    - invoice.payment_failed
    """
    if not settings.STRIPE_WEBHOOK_SECRET:
        raise HTTPException(503, "Webhook not configured")
    
    payload = await request.body()
    
    try:
        event = stripe.Webhook.construct_event(
            payload, stripe_signature, settings.STRIPE_WEBHOOK_SECRET
        )
    except stripe.error.SignatureVerificationError:
        logger.warning("invalid_stripe_signature")
        raise HTTPException(400, "Invalid signature")
    
    logger.info("stripe_webhook_received", event_type=event.type)
    
    # Only process events for ZK service
    metadata = event.data.object.get("metadata", {})
    if metadata.get("service") != "zk-vault":
        # Not for us, ignore
        return {"status": "ignored", "reason": "not_zk_service"}
    
    try:
        if event.type == "customer.subscription.created":
            await handle_subscription_created(event, db)
        elif event.type == "customer.subscription.updated":
            await handle_subscription_updated(event, db)
        elif event.type == "customer.subscription.deleted":
            await handle_subscription_deleted(event, db)
        elif event.type == "invoice.payment_failed":
            await handle_payment_failed(event, db)
        
        return {"status": "ok"}
    
    except Exception as e:
        logger.error("webhook_processing_error", error=str(e), exc_info=True)
        raise HTTPException(500, "Webhook processing failed")


async def handle_subscription_created(event, db: AsyncSession):
    """Handle new ZK subscription creation."""
    subscription = event.data.object
    customer_id = subscription.customer
    
    result = await db.execute(
        select(ZKUser).where(ZKUser.stripe_customer_id == customer_id)
    )
    user = result.scalar_one_or_none()
    
    if not user:
        logger.warning("zk_user_not_found", customer_id=customer_id)
        return
    
    user.stripe_subscription_id = subscription.id
    user.billing_status = "active"
    
    price_id = subscription.items.data[0].price.id
    for plan_type, plan_info in settings.PLAN_LIMITS.items():
        if plan_info.get("stripe_price_id") == price_id:
            user.plan_type = plan_type
            user.storage_quota = plan_info["storage_bytes"]
            logger.info("zk_user_upgraded", user_id=str(user.id), plan=plan_type)
            break
    
    await db.commit()


async def handle_subscription_updated(event, db: AsyncSession):
    """Handle ZK subscription plan changes."""
    subscription = event.data.object
    customer_id = subscription.customer
    
    result = await db.execute(
        select(ZKUser).where(ZKUser.stripe_customer_id == customer_id)
    )
    user = result.scalar_one_or_none()
    
    if not user:
        return
    
    price_id = subscription.items.data[0].price.id
    for plan_type, plan_info in settings.PLAN_LIMITS.items():
        if plan_info.get("stripe_price_id") == price_id:
            if user.plan_type != plan_type:
                user.plan_type = plan_type
                user.storage_quota = plan_info["storage_bytes"]
                logger.info("zk_plan_changed", user_id=str(user.id), plan=plan_type)
            break
    
    status_map = {
        "active": "active",
        "past_due": "past_due",
        "canceled": "canceled",
        "unpaid": "past_due",
    }
    user.billing_status = status_map.get(subscription.status, "active")
    
    await db.commit()


async def handle_subscription_deleted(event, db: AsyncSession):
    """Handle ZK subscription cancellation."""
    subscription = event.data.object
    customer_id = subscription.customer
    
    result = await db.execute(
        select(ZKUser).where(ZKUser.stripe_customer_id == customer_id)
    )
    user = result.scalar_one_or_none()
    
    if not user:
        return
    
    free_plan = settings.PLAN_LIMITS["free"]
    user.plan_type = "free"
    user.storage_quota = free_plan["storage_bytes"]
    user.stripe_subscription_id = None
    user.billing_status = "canceled"
    
    logger.info("zk_subscription_canceled", user_id=str(user.id))
    await db.commit()


async def handle_payment_failed(event, db: AsyncSession):
    """Handle failed ZK payment."""
    invoice = event.data.object
    customer_id = invoice.customer
    
    result = await db.execute(
        select(ZKUser).where(ZKUser.stripe_customer_id == customer_id)
    )
    user = result.scalar_one_or_none()
    
    if not user:
        return
    
    user.billing_status = "past_due"
    logger.warning("zk_payment_failed", user_id=str(user.id))
    await db.commit()


# Legacy plans endpoint - now uses unified billing
@router.get("/plans/legacy")
async def get_available_plans_legacy(
    db: AsyncSession = Depends(get_db)
):
    """
    Legacy endpoint for plans (backward compatibility).
    Use /api/v1/billing/plans instead.
    """
    billing = await get_billing_service(db)
    plans = await billing.get_available_plans(active_only=True)
    
    return {
        "plans": [
            {
                "type": p.tier_name,
                "name": p.display_name,
                "storage_gb": round(p.storage_bytes / (1024**3), 0),
                "has_price": p.price_monthly is not None and p.price_monthly > 0,
                "description": p.description or "",
            }
            for p in plans
        ]
    }


# ── Invoice Endpoints ─────────────────────────────────────────────────────────

def _get_company_config() -> CompanyConfig:
    return CompanyConfig(
        name=settings.COMPANY_NAME,
        address=settings.COMPANY_ADDRESS,
        email=settings.COMPANY_EMAIL or settings.MAILGUN_FROM_EMAIL,
        phone=settings.COMPANY_PHONE,
        gst=settings.COMPANY_GST,
        logo_url=settings.COMPANY_LOGO_URL,
    )


@router.get("/invoices", response_model=InvoiceListResponse)
async def list_invoices(
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    current_user: ZKUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List invoices for the current ZK user."""
    svc = InvoiceService(db, service_type="zk")
    invoices = await svc.get_user_invoices(current_user.id, limit=limit, offset=offset)

    result = await db.execute(
        select(func.count())
        .select_from(Invoice)
        .where(Invoice.user_id == current_user.id,
               Invoice.service_type == "zk")
    )
    total = result.scalar() or 0

    return InvoiceListResponse(
        invoices=[InvoiceSchema.from_orm(inv) for inv in invoices],
        total=total,
    )


@router.get("/invoices/{invoice_id}/download")
async def download_invoice(
    invoice_id: UUID,
    current_user: ZKUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Download a PDF invoice."""
    from fastapi.responses import StreamingResponse
    import io

    svc = InvoiceService(db, service_type="zk")
    invoice = await svc.get_invoice_by_id(invoice_id, current_user.id)
    if not invoice:
        raise HTTPException(404, "Invoice not found")

    pdf_bytes = svc.generate_pdf(invoice, _get_company_config())
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{invoice.invoice_number}.pdf"'
        },
    )
