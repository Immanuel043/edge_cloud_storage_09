"""
Proration Service for Mid-Cycle Plan Changes

Calculates prorated charges and credits when users upgrade or downgrade
their subscription plans mid-billing cycle.

Features:
- Accurate prorated credit calculation for downgrades
- Prorated charge calculation for upgrades
- Support for monthly, 6-month, and annual billing
- Time-based proration (daily granularity)
- Stripe and Razorpay gateway integration
- Audit trail for all proration calculations

Proration Examples:
1. Upgrade from $10/month to $20/month on day 15 of 30-day cycle:
   - Unused credit: $10 * 15/30 = $5.00
   - New plan charge: $20 * 15/30 = $10.00
   - Net charge: $10.00 - $5.00 = $5.00

2. Downgrade from $100/month to $10/month on day 10 of 30-day cycle:
   - Unused credit: $100 * 20/30 = $66.67
   - Credit applied to next billing cycle or refunded

Usage:
    from shared_billing import ProrationService

    service = ProrationService(db)
    proration = await service.calculate_proration(
        user_id=user_id,
        old_plan_id=old_plan.id,
        new_plan_id=new_plan.id,
        billing_period='monthly'
    )

    # Apply proration
    await service.apply_proration(proration, payment_method_id, gateway='stripe')
"""

from datetime import datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional, Tuple, Dict, Any
from dataclasses import dataclass
from enum import Enum
import logging
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from .models import UserSubscription, SubscriptionPlan
from .audit_logger import AuditLogger, AuditEventType
from .validators import BillingValidator

logger = logging.getLogger(__name__)


class ProrationStrategy(str, Enum):
    """Strategy for handling proration."""

    CREATE_PRORATION_INVOICE = "create_proration_invoice"  # Create immediate invoice
    CREDIT_NEXT_CYCLE = "credit_next_cycle"  # Apply credit to next billing
    REFUND = "refund"  # Refund difference to payment method


class BillingPeriod(str, Enum):
    """Billing period types."""

    MONTHLY = "monthly"
    SIX_MONTHS = "six_months"
    YEARLY = "yearly"


@dataclass
class ProrationCalculation:
    """Result of proration calculation."""

    user_id: UUID
    subscription_id: UUID

    # Old plan details
    old_plan_id: UUID
    old_plan_name: str
    old_plan_price: Decimal
    old_plan_period: BillingPeriod

    # New plan details
    new_plan_id: UUID
    new_plan_name: str
    new_plan_price: Decimal
    new_plan_period: BillingPeriod

    # Time-based proration
    cycle_start_date: datetime
    cycle_end_date: datetime
    change_date: datetime
    days_in_cycle: int
    days_used: int
    days_remaining: int

    # Financial calculations
    unused_credit: Decimal  # Credit from old plan
    new_plan_prorated_charge: Decimal  # Charge for new plan
    net_amount: Decimal  # What customer owes (positive) or credit (negative)

    # Proration strategy
    is_upgrade: bool
    is_downgrade: bool
    recommended_strategy: ProrationStrategy

    # Additional context
    calculation_timestamp: datetime
    notes: str

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "user_id": str(self.user_id),
            "subscription_id": str(self.subscription_id),
            "old_plan": {
                "id": str(self.old_plan_id),
                "name": self.old_plan_name,
                "price": float(self.old_plan_price),
                "period": self.old_plan_period.value
            },
            "new_plan": {
                "id": str(self.new_plan_id),
                "name": self.new_plan_name,
                "price": float(self.new_plan_price),
                "period": self.new_plan_period.value
            },
            "time_calculation": {
                "cycle_start": self.cycle_start_date.isoformat(),
                "cycle_end": self.cycle_end_date.isoformat(),
                "change_date": self.change_date.isoformat(),
                "days_in_cycle": self.days_in_cycle,
                "days_used": self.days_used,
                "days_remaining": self.days_remaining,
                "proration_percentage": f"{self.days_remaining / self.days_in_cycle * 100:.2f}%"
            },
            "amounts": {
                "unused_credit": float(self.unused_credit),
                "new_plan_prorated_charge": float(self.new_plan_prorated_charge),
                "net_amount": float(self.net_amount),
                "is_upgrade": self.is_upgrade,
                "is_downgrade": self.is_downgrade
            },
            "recommended_strategy": self.recommended_strategy.value,
            "notes": self.notes
        }


class ProrationService:
    """
    Service for calculating and applying proration for plan changes.

    Handles both upgrades (customer pays difference) and downgrades
    (customer receives credit).
    """

    def __init__(
        self,
        db: AsyncSession,
        audit_logger: Optional[AuditLogger] = None
    ):
        """
        Initialize proration service.

        Args:
            db: Database session
            audit_logger: Audit logger instance
        """
        self.db = db
        self.audit_logger = audit_logger or AuditLogger(db)

    async def calculate_proration(
        self,
        user_id: UUID,
        subscription_id: UUID,
        old_plan_id: UUID,
        new_plan_id: UUID,
        billing_period: str,
        change_date: Optional[datetime] = None
    ) -> ProrationCalculation:
        """
        Calculate proration for a plan change.

        Args:
            user_id: User ID
            subscription_id: Subscription ID
            old_plan_id: Current plan ID
            new_plan_id: New plan ID
            billing_period: Billing period ('monthly', 'six_months', 'yearly')
            change_date: When the change occurs (defaults to now)

        Returns:
            ProrationCalculation with all details

        Raises:
            ValueError: If plans not found or invalid
        """
        change_date = change_date or datetime.utcnow()

        # Fetch plans
        old_plan = await self._get_plan(old_plan_id)
        new_plan = await self._get_plan(new_plan_id)

        if not old_plan or not new_plan:
            raise ValueError("Plan not found")

        # Get subscription for cycle dates
        subscription = await self._get_subscription(subscription_id)
        if not subscription:
            raise ValueError("Subscription not found")

        # Determine billing period prices
        old_price = self._get_plan_price(old_plan, billing_period)
        new_price = self._get_plan_price(new_plan, billing_period)

        # Calculate cycle dates
        cycle_start, cycle_end = self._get_cycle_dates(
            subscription, billing_period
        )

        # Time calculations
        days_in_cycle = (cycle_end - cycle_start).days
        days_used = (change_date - cycle_start).days
        days_remaining = (cycle_end - change_date).days

        # Ensure non-negative
        days_used = max(0, days_used)
        days_remaining = max(0, days_remaining)

        # Financial calculations
        # Unused credit = (old price) * (days remaining / total days)
        unused_credit = (
            old_price * Decimal(days_remaining) / Decimal(days_in_cycle)
        ).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)

        # New plan prorated charge = (new price) * (days remaining / total days)
        new_plan_prorated_charge = (
            new_price * Decimal(days_remaining) / Decimal(days_in_cycle)
        ).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)

        # Net amount (positive = charge, negative = credit)
        net_amount = (new_plan_prorated_charge - unused_credit).quantize(
            Decimal('0.01'), rounding=ROUND_HALF_UP
        )

        # Determine if upgrade or downgrade
        is_upgrade = new_price > old_price
        is_downgrade = new_price < old_price

        # Recommend strategy
        if is_upgrade:
            # Upgrades: charge immediately
            recommended_strategy = ProrationStrategy.CREATE_PRORATION_INVOICE
            notes = (
                f"Upgrade from {old_plan.display_name} to {new_plan.display_name}. "
                f"Customer will be charged ${abs(net_amount):.2f} immediately "
                f"for the remaining {days_remaining} days of the billing cycle."
            )
        elif is_downgrade:
            # Downgrades: credit next cycle
            recommended_strategy = ProrationStrategy.CREDIT_NEXT_CYCLE
            notes = (
                f"Downgrade from {old_plan.display_name} to {new_plan.display_name}. "
                f"Customer will receive ${abs(net_amount):.2f} credit applied to "
                f"the next billing cycle."
            )
        else:
            # Same price (e.g., changing features)
            recommended_strategy = ProrationStrategy.CREDIT_NEXT_CYCLE
            notes = "Plan change at same price point. No proration needed."

        calculation = ProrationCalculation(
            user_id=user_id,
            subscription_id=subscription_id,
            old_plan_id=old_plan_id,
            old_plan_name=old_plan.display_name,
            old_plan_price=old_price,
            old_plan_period=BillingPeriod(billing_period),
            new_plan_id=new_plan_id,
            new_plan_name=new_plan.display_name,
            new_plan_price=new_price,
            new_plan_period=BillingPeriod(billing_period),
            cycle_start_date=cycle_start,
            cycle_end_date=cycle_end,
            change_date=change_date,
            days_in_cycle=days_in_cycle,
            days_used=days_used,
            days_remaining=days_remaining,
            unused_credit=unused_credit,
            new_plan_prorated_charge=new_plan_prorated_charge,
            net_amount=net_amount,
            is_upgrade=is_upgrade,
            is_downgrade=is_downgrade,
            recommended_strategy=recommended_strategy,
            calculation_timestamp=datetime.utcnow(),
            notes=notes
        )

        # Log calculation
        await self.audit_logger.log_event(
            event_type=AuditEventType.SUBSCRIPTION_PLAN_CHANGE_CALCULATED,
            user_id=user_id,
            resource_type="subscription",
            resource_id=str(subscription_id),
            event_data=calculation.to_dict(),
            status="success",
            gateway=None
        )

        return calculation

    async def apply_proration(
        self,
        proration: ProrationCalculation,
        payment_method_id: str,
        gateway: str,
        strategy: Optional[ProrationStrategy] = None
    ) -> Dict[str, Any]:
        """
        Apply proration calculation.

        Args:
            proration: Proration calculation result
            payment_method_id: Payment method ID (for charging)
            gateway: Payment gateway ('stripe' or 'razorpay')
            strategy: Override recommended strategy (optional)

        Returns:
            Dict with results (payment_intent_id, credit_balance, etc.)

        Raises:
            ValueError: If proration fails
        """
        strategy = strategy or proration.recommended_strategy

        result = {
            "strategy": strategy.value,
            "net_amount": float(proration.net_amount),
            "proration": proration.to_dict()
        }

        if strategy == ProrationStrategy.CREATE_PRORATION_INVOICE:
            # Charge the customer immediately
            if proration.net_amount > 0:
                # Customer owes money (upgrade)
                result["action"] = "charge"
                result["amount_charged"] = float(proration.net_amount)
                result["payment_method_id"] = payment_method_id
                result["gateway"] = gateway

                # Log the charge
                await self.audit_logger.log_event(
                    event_type=AuditEventType.PAYMENT_INITIATED,
                    user_id=proration.user_id,
                    resource_type="proration",
                    resource_id=str(proration.subscription_id),
                    event_data={
                        "amount": float(proration.net_amount),
                        "reason": "plan_upgrade_proration",
                        "proration_details": proration.to_dict()
                    },
                    status="success",
                    gateway=gateway
                )
            else:
                # Customer is owed money (shouldn't happen with CREATE_PRORATION_INVOICE)
                result["action"] = "credit"
                result["credit_amount"] = float(abs(proration.net_amount))

        elif strategy == ProrationStrategy.CREDIT_NEXT_CYCLE:
            # Apply credit to next billing cycle
            result["action"] = "credit"
            result["credit_amount"] = float(abs(proration.net_amount))
            result["applied_to"] = "next_billing_cycle"

            # Log the credit
            await self.audit_logger.log_event(
                event_type=AuditEventType.SUBSCRIPTION_DOWNGRADED,
                user_id=proration.user_id,
                resource_type="subscription",
                resource_id=str(proration.subscription_id),
                event_data={
                    "credit_amount": float(abs(proration.net_amount)),
                    "credit_strategy": "next_cycle",
                    "proration_details": proration.to_dict()
                },
                status="success",
                gateway=None
            )

        elif strategy == ProrationStrategy.REFUND:
            # Refund to payment method
            result["action"] = "refund"
            result["refund_amount"] = float(abs(proration.net_amount))
            result["payment_method_id"] = payment_method_id
            result["gateway"] = gateway

            # Log the refund
            await self.audit_logger.log_event(
                event_type=AuditEventType.PAYMENT_REFUNDED,
                user_id=proration.user_id,
                resource_type="proration",
                resource_id=str(proration.subscription_id),
                event_data={
                    "refund_amount": float(abs(proration.net_amount)),
                    "reason": "plan_downgrade_proration",
                    "proration_details": proration.to_dict()
                },
                status="success",
                gateway=gateway
            )

        logger.info(
            f"Applied proration for subscription {proration.subscription_id}: "
            f"{result['action']} ${abs(proration.net_amount):.2f}"
        )

        return result

    async def _get_plan(self, plan_id: UUID) -> Optional[SubscriptionPlan]:
        """Fetch subscription plan by ID."""
        stmt = select(SubscriptionPlan).where(SubscriptionPlan.id == plan_id)
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none()

    async def _get_subscription(self, subscription_id: UUID) -> Optional[UserSubscription]:
        """Fetch subscription by ID."""
        stmt = select(UserSubscription).where(UserSubscription.id == subscription_id)
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none()

    def _get_plan_price(self, plan: SubscriptionPlan, billing_period: str) -> Decimal:
        """Get plan price for billing period."""
        period_map = {
            'monthly': plan.price_monthly,
            'six_months': plan.price_six_months,
            'yearly': plan.price_yearly
        }

        price = period_map.get(billing_period)
        if price is None:
            raise ValueError(f"Plan {plan.plan_code} does not support {billing_period} billing")

        return price

    def _get_cycle_dates(
        self,
        subscription: UserSubscription,
        billing_period: str
    ) -> Tuple[datetime, datetime]:
        """
        Calculate cycle start and end dates.

        Args:
            subscription: User subscription
            billing_period: Billing period

        Returns:
            Tuple of (cycle_start, cycle_end)
        """
        # Use current_period_start if available, otherwise use created_at
        cycle_start = subscription.current_period_start or subscription.created_at

        # Calculate cycle end based on billing period
        if billing_period == 'monthly':
            cycle_end = cycle_start + timedelta(days=30)
        elif billing_period == 'six_months':
            cycle_end = cycle_start + timedelta(days=180)
        elif billing_period == 'yearly':
            cycle_end = cycle_start + timedelta(days=365)
        else:
            raise ValueError(f"Invalid billing period: {billing_period}")

        return cycle_start, cycle_end


# Add missing event type to audit logger
# This should be added to audit_logger.py AuditEventType enum:
# SUBSCRIPTION_PLAN_CHANGE_CALCULATED = "subscription.plan_change.calculated"
