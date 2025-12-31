"""
Stripe Billing Integration for ZK Private Vault Service

Handles subscription management and webhook processing for
the Zero-Knowledge Private Vault service. This is completely
separate from the Storage Service billing.
"""
import stripe
import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, Header
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_db
from app.models.database import ZKUser
from app.config import settings

logger = structlog.get_logger()
router = APIRouter(prefix="/billing", tags=["billing"])

# Initialize Stripe with ZK-specific key
stripe.api_key = settings.STRIPE_SECRET_KEY


async def get_current_zk_user(
    # This would use your ZK auth mechanism
    # Simplified for now - you'd integrate with auth_zk.py
    db: AsyncSession = Depends(get_db)
) -> ZKUser:
    """Get current authenticated ZK user."""
    # This is a placeholder - integrate with your actual ZK auth
    raise HTTPException(401, "Authentication required")


@router.post("/create-checkout-session")
async def create_checkout_session(
    plan_type: str,
    current_user: ZKUser = Depends(get_current_zk_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Create a Stripe Checkout session for upgrading ZK plans.
    
    Args:
        plan_type: Target plan (personal, professional, enterprise)
    
    Returns:
        Checkout session URL
    """
    if not settings.STRIPE_SECRET_KEY:
        raise HTTPException(503, "Billing not configured")
    
    plan = settings.PLAN_LIMITS.get(plan_type)
    if not plan or not plan.get("stripe_price_id"):
        raise HTTPException(400, f"Invalid plan: {plan_type}")
    
    try:
        # Get or create Stripe customer
        if not current_user.stripe_customer_id:
            customer = stripe.Customer.create(
                email=current_user.email,
                metadata={
                    "zk_user_id": str(current_user.id),
                    "service": "zk-vault"
                }
            )
            current_user.stripe_customer_id = customer.id
            await db.commit()
        
        # Create checkout session
        session = stripe.checkout.Session.create(
            customer=current_user.stripe_customer_id,
            payment_method_types=["card"],
            line_items=[{
                "price": plan["stripe_price_id"],
                "quantity": 1,
            }],
            mode="subscription",
            success_url="https://vault.yourservice.com/settings/billing?success=true",
            cancel_url="https://vault.yourservice.com/settings/billing?canceled=true",
            metadata={
                "zk_user_id": str(current_user.id),
                "plan_type": plan_type,
                "service": "zk-vault"
            }
        )
        
        return {"checkout_url": session.url, "session_id": session.id}
    
    except stripe.error.StripeError as e:
        logger.error("stripe_error", error=str(e))
        raise HTTPException(500, "Failed to create checkout session")


@router.post("/create-portal-session")
async def create_portal_session(
    current_user: ZKUser = Depends(get_current_zk_user)
):
    """
    Create a Stripe Customer Portal session for managing ZK subscriptions.
    """
    if not settings.STRIPE_SECRET_KEY:
        raise HTTPException(503, "Billing not configured")
    
    if not current_user.stripe_customer_id:
        raise HTTPException(400, "No billing account found. Please upgrade first.")
    
    try:
        session = stripe.billing_portal.Session.create(
            customer=current_user.stripe_customer_id,
            return_url="https://vault.yourservice.com/settings/billing",
        )
        return {"portal_url": session.url}
    
    except stripe.error.StripeError as e:
        logger.error("stripe_portal_error", error=str(e))
        raise HTTPException(500, "Failed to create portal session")


@router.get("/subscription")
async def get_subscription_status(
    current_user: ZKUser = Depends(get_current_zk_user)
):
    """
    Get current ZK subscription status.
    """
    plan = settings.PLAN_LIMITS.get(current_user.plan_type, settings.PLAN_LIMITS["free"])
    
    return {
        "plan_type": current_user.plan_type,
        "plan_name": plan.get("name", "Free"),
        "storage_quota": current_user.storage_quota,
        "storage_used": current_user.storage_used,
        "storage_quota_gb": round(current_user.storage_quota / (1024**3), 2),
        "storage_used_gb": round(current_user.storage_used / (1024**3), 2),
        "usage_percent": round(
            (current_user.storage_used / current_user.storage_quota * 100)
            if current_user.storage_quota > 0 else 0, 1
        ),
        "billing_status": current_user.billing_status,
        "has_subscription": current_user.stripe_subscription_id is not None,
    }


@router.post("/webhooks/stripe")
async def handle_stripe_webhook(
    request: Request,
    stripe_signature: str = Header(None, alias="stripe-signature"),
    db: AsyncSession = Depends(get_db)
):
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


@router.get("/plans")
async def get_available_plans():
    """
    Get all available ZK subscription plans.
    """
    plans = []
    for plan_type, plan_info in settings.PLAN_LIMITS.items():
        plans.append({
            "type": plan_type,
            "name": plan_info.get("name", plan_type.title()),
            "storage_gb": round(plan_info["storage_bytes"] / (1024**3), 0),
            "has_price": plan_info.get("stripe_price_id") is not None,
            "description": get_plan_description(plan_type),
        })
    
    return {"plans": plans}


def get_plan_description(plan_type: str) -> str:
    """Get description for ZK plan."""
    descriptions = {
        "free": "1 GB of zero-knowledge encrypted storage. Try the private vault.",
        "personal": "50 GB for personal privacy needs. Medical records, tax docs, private photos.",
        "professional": "200 GB for professionals. Client files, legal docs, sensitive data.",
        "enterprise": "1 TB for business compliance. Team-ready zero-knowledge storage.",
    }
    return descriptions.get(plan_type, "")

