"""
Stripe Billing Integration for Storage Service

Handles subscription management and webhook processing for
the Normal Storage service. The ZK service has its own
separate Stripe integration.
"""
import stripe
import logging
from fastapi import APIRouter, Depends, HTTPException, Request, Header
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import Optional

from ..dependencies import get_db, get_current_user
from ..models.database import User
from ..config import settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/billing", tags=["billing"])

# Initialize Stripe
stripe.api_key = settings.STRIPE_SECRET_KEY


@router.post("/create-checkout-session")
async def create_checkout_session(
    plan_type: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Create a Stripe Checkout session for upgrading plans.
    
    Args:
        plan_type: Target plan (basic, pro, team)
    
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
                metadata={"user_id": str(current_user.id)}
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
            success_url=f"{settings.FRONTEND_URL}/settings/billing?success=true",
            cancel_url=f"{settings.FRONTEND_URL}/settings/billing?canceled=true",
            metadata={
                "user_id": str(current_user.id),
                "plan_type": plan_type,
            }
        )
        
        return {"checkout_url": session.url, "session_id": session.id}
    
    except stripe.error.StripeError as e:
        logger.error(f"Stripe error: {e}", exc_info=True)
        raise HTTPException(500, "Failed to create checkout session")


@router.post("/create-portal-session")
async def create_portal_session(
    current_user: User = Depends(get_current_user)
):
    """
    Create a Stripe Customer Portal session for managing subscriptions.
    """
    if not settings.STRIPE_SECRET_KEY:
        raise HTTPException(503, "Billing not configured")
    
    if not current_user.stripe_customer_id:
        raise HTTPException(400, "No billing account found. Please upgrade first.")
    
    try:
        session = stripe.billing_portal.Session.create(
            customer=current_user.stripe_customer_id,
            return_url=f"{settings.FRONTEND_URL}/settings/billing",
        )
        return {"portal_url": session.url}
    
    except stripe.error.StripeError as e:
        logger.error(f"Stripe portal error: {e}", exc_info=True)
        raise HTTPException(500, "Failed to create portal session")


@router.get("/subscription")
async def get_subscription_status(
    current_user: User = Depends(get_current_user)
):
    """
    Get current subscription status.
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
    Handle Stripe webhook events.
    
    Events handled:
    - customer.subscription.created
    - customer.subscription.updated
    - customer.subscription.deleted
    - invoice.payment_succeeded
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
        logger.warning("Invalid Stripe webhook signature")
        raise HTTPException(400, "Invalid signature")
    
    logger.info(f"Received Stripe webhook: {event.type}")
    
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
        logger.error(f"Webhook processing error: {e}", exc_info=True)
        raise HTTPException(500, "Webhook processing failed")


async def handle_subscription_created(event, db: AsyncSession):
    """Handle new subscription creation."""
    subscription = event.data.object
    customer_id = subscription.customer
    
    # Find user by Stripe customer ID
    result = await db.execute(
        select(User).where(User.stripe_customer_id == customer_id)
    )
    user = result.scalar_one_or_none()
    
    if not user:
        logger.warning(f"No user found for Stripe customer: {customer_id}")
        return
    
    # Update subscription ID and plan
    user.stripe_subscription_id = subscription.id
    user.billing_status = "active"
    
    # Get plan from price ID
    price_id = subscription.items.data[0].price.id
    for plan_type, plan_info in settings.PLAN_LIMITS.items():
        if plan_info.get("stripe_price_id") == price_id:
            user.plan_type = plan_type
            user.storage_quota = plan_info["storage_bytes"]
            logger.info(f"User {user.id} upgraded to {plan_type}")
            break
    
    await db.commit()


async def handle_subscription_updated(event, db: AsyncSession):
    """Handle subscription plan changes."""
    subscription = event.data.object
    customer_id = subscription.customer
    
    result = await db.execute(
        select(User).where(User.stripe_customer_id == customer_id)
    )
    user = result.scalar_one_or_none()
    
    if not user:
        return
    
    # Check for plan change
    price_id = subscription.items.data[0].price.id
    for plan_type, plan_info in settings.PLAN_LIMITS.items():
        if plan_info.get("stripe_price_id") == price_id:
            if user.plan_type != plan_type:
                user.plan_type = plan_type
                user.storage_quota = plan_info["storage_bytes"]
                logger.info(f"User {user.id} plan changed to {plan_type}")
            break
    
    # Update status
    status_map = {
        "active": "active",
        "past_due": "past_due",
        "canceled": "canceled",
        "unpaid": "past_due",
    }
    user.billing_status = status_map.get(subscription.status, "active")
    
    await db.commit()


async def handle_subscription_deleted(event, db: AsyncSession):
    """Handle subscription cancellation."""
    subscription = event.data.object
    customer_id = subscription.customer
    
    result = await db.execute(
        select(User).where(User.stripe_customer_id == customer_id)
    )
    user = result.scalar_one_or_none()
    
    if not user:
        return
    
    # Downgrade to free tier
    free_plan = settings.PLAN_LIMITS["free"]
    user.plan_type = "free"
    user.storage_quota = free_plan["storage_bytes"]
    user.stripe_subscription_id = None
    user.billing_status = "canceled"
    
    logger.info(f"User {user.id} subscription canceled, downgraded to free")
    await db.commit()


async def handle_payment_failed(event, db: AsyncSession):
    """Handle failed payment."""
    invoice = event.data.object
    customer_id = invoice.customer
    
    result = await db.execute(
        select(User).where(User.stripe_customer_id == customer_id)
    )
    user = result.scalar_one_or_none()
    
    if not user:
        return
    
    user.billing_status = "past_due"
    logger.warning(f"Payment failed for user {user.id}")
    await db.commit()


@router.get("/plans")
async def get_available_plans():
    """
    Get all available subscription plans.
    """
    plans = []
    for plan_type, plan_info in settings.PLAN_LIMITS.items():
        plans.append({
            "type": plan_type,
            "name": plan_info.get("name", plan_type.title()),
            "storage_gb": round(plan_info["storage_bytes"] / (1024**3), 0),
            "bandwidth_mbps": plan_info.get("bandwidth_mbps", 5),
            "max_streams": plan_info.get("max_streams", 2),
            "has_price": plan_info.get("stripe_price_id") is not None,
        })
    
    return {"plans": plans}

