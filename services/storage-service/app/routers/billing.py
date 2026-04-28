"""
Billing API Router

Handles user subscription and billing information.
"""

from datetime import datetime
from typing import Optional

import structlog
from app.database import get_db
from app.models.database import User
from app.routers.auth import get_current_user
from fastapi import APIRouter, Depends, HTTPException, status
from shared_billing import BillingService
from shared_billing.exceptions import SubscriptionNotFoundError
from sqlalchemy.ext.asyncio import AsyncSession

logger = structlog.get_logger()

router = APIRouter(prefix="/api/v1/billing", tags=["billing"])


@router.get("/subscription")
async def get_subscription_details(
    current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """
    Get current user's subscription details.

    Returns:
        - plan_code: Current plan code
        - plan_name: Display name of the plan
        - billing_cycle: monthly/six_months/yearly
        - status: Subscription status
        - current_period_start: Start of current billing period
        - current_period_end: End of current billing period
        - next_payment_at: Next payment date
        - next_payment_amount: Amount of next payment
        - storage_quota: Storage quota in bytes
        - bandwidth_limit: Bandwidth limit in Mbps
    """
    try:
        billing = BillingService(db, service_type="normal")

        # Get user subscription with plan details
        subscription = await billing.get_user_subscription(current_user.id, include_plan=True)

        if not subscription or not subscription.plan:
            # User has no subscription, return default free plan info
            return {
                "plan_code": "normal_free",
                "plan_name": "Free Plan",
                "billing_cycle": None,
                "status": "active",
                "current_period_start": None,
                "current_period_end": None,
                "next_payment_at": None,
                "next_payment_amount": None,
                "storage_quota": 5 * 1024**3,  # 5GB
                "bandwidth_limit": 5,
                "currency": "INR",
            }

        plan = subscription.plan

        # Get next payment amount based on billing cycle
        next_payment_amount = None
        if subscription.billing_cycle == "monthly":
            next_payment_amount = float(plan.price_monthly) if plan.price_monthly else None
        elif subscription.billing_cycle == "six_months":
            next_payment_amount = float(plan.price_six_months) if plan.price_six_months else None
        elif subscription.billing_cycle == "yearly":
            next_payment_amount = float(plan.price_yearly) if plan.price_yearly else None

        return {
            "plan_code": plan.plan_code,
            "plan_name": plan.display_name,
            "billing_cycle": subscription.billing_cycle,
            "status": subscription.status,
            "current_period_start": (
                subscription.current_period_start.isoformat()
                if subscription.current_period_start
                else None
            ),
            "current_period_end": (
                subscription.current_period_end.isoformat()
                if subscription.current_period_end
                else None
            ),
            "next_payment_at": (
                subscription.next_payment_at.isoformat() if subscription.next_payment_at else None
            ),
            "next_payment_amount": next_payment_amount,
            "storage_quota": plan.storage_bytes,
            "bandwidth_limit": plan.bandwidth_mbps,
            "currency": plan.currency,
        }

    except SubscriptionNotFoundError:
        # Return default free plan info
        return {
            "plan_code": "normal_free",
            "plan_name": "Free Plan",
            "billing_cycle": None,
            "status": "active",
            "current_period_start": None,
            "current_period_end": None,
            "next_payment_at": None,
            "next_payment_amount": None,
            "storage_quota": 5 * 1024**3,  # 5GB
            "bandwidth_limit": 5,
            "currency": "INR",
        }
    except Exception as e:
        logger.error(
            "Failed to get subscription details", error=str(e), user_id=str(current_user.id)
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve subscription details",
        )
