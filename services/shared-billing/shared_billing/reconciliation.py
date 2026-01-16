"""
Subscription Reconciliation Service

Performs daily synchronization between our database and payment gateway states
to detect and resolve data drift, missed webhooks, and state inconsistencies.

Features:
- Daily reconciliation job
- Stripe subscription sync
- Razorpay subscription sync
- Discrepancy detection and reporting
- Automatic corrections with audit trail
- Configurable reconciliation strategies

Usage:
    from shared_billing import ReconciliationService

    service = ReconciliationService(db_session)
    results = await service.run_full_reconciliation()
"""

import asyncio
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple, Any
from enum import Enum
from decimal import Decimal
import logging
from dataclasses import dataclass

from sqlalchemy import select, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

# Payment gateway clients
import stripe
import razorpay

from .models import UserSubscription, SubscriptionPlan
from .audit_logger import AuditLogger, AuditEventType

logger = logging.getLogger(__name__)


class DiscrepancyType(str, Enum):
    """Types of discrepancies found during reconciliation."""

    # Status mismatches
    STATUS_MISMATCH = "status_mismatch"  # DB says active, gateway says cancelled
    MISSING_IN_GATEWAY = "missing_in_gateway"  # In DB but not in gateway
    MISSING_IN_DB = "missing_in_db"  # In gateway but not in DB

    # Payment mismatches
    PAYMENT_AMOUNT_MISMATCH = "payment_amount_mismatch"
    PAYMENT_DATE_MISMATCH = "payment_date_mismatch"

    # Trial mismatches
    TRIAL_END_MISMATCH = "trial_end_mismatch"

    # Plan mismatches
    PLAN_MISMATCH = "plan_mismatch"


class ReconciliationAction(str, Enum):
    """Actions to take when discrepancy is found."""

    NO_ACTION = "no_action"  # Report only, no changes
    UPDATE_DB = "update_db"  # Update our database to match gateway
    UPDATE_GATEWAY = "update_gateway"  # Update gateway to match our DB
    MANUAL_REVIEW = "manual_review"  # Flag for human review
    CANCEL_SUBSCRIPTION = "cancel_subscription"  # Cancel orphaned subscription


@dataclass
class Discrepancy:
    """Represents a discrepancy found during reconciliation."""

    subscription_id: str
    user_id: str
    discrepancy_type: DiscrepancyType
    db_value: Any
    gateway_value: Any
    recommended_action: ReconciliationAction
    severity: str  # "low", "medium", "high", "critical"
    details: Dict[str, Any]


@dataclass
class ReconciliationResult:
    """Results from a reconciliation run."""

    started_at: datetime
    completed_at: datetime
    subscriptions_checked: int
    discrepancies_found: int
    discrepancies: List[Discrepancy]
    auto_fixed: int
    manual_review_required: int
    errors: List[str]

    @property
    def duration_seconds(self) -> float:
        """Calculate reconciliation duration."""
        return (self.completed_at - self.started_at).total_seconds()

    @property
    def success_rate(self) -> float:
        """Calculate percentage of subscriptions with no issues."""
        if self.subscriptions_checked == 0:
            return 100.0
        return ((self.subscriptions_checked - self.discrepancies_found) /
                self.subscriptions_checked * 100)


class ReconciliationService:
    """
    Subscription reconciliation service for detecting and fixing data drift.

    Reconciliation Strategy:
    1. Fetch all active subscriptions from DB
    2. For each subscription, query payment gateway
    3. Compare status, amounts, dates, plans
    4. Detect discrepancies
    5. Apply auto-fix rules or flag for manual review
    6. Log all actions to audit trail
    """

    def __init__(
        self,
        db: AsyncSession,
        stripe_api_key: Optional[str] = None,
        razorpay_key_id: Optional[str] = None,
        razorpay_key_secret: Optional[str] = None,
        audit_logger: Optional[AuditLogger] = None,
        auto_fix: bool = True
    ):
        """
        Initialize reconciliation service.

        Args:
            db: Database session
            stripe_api_key: Stripe API key
            razorpay_key_id: Razorpay key ID
            razorpay_key_secret: Razorpay key secret
            audit_logger: Audit logger instance
            auto_fix: Whether to automatically fix discrepancies (vs report only)
        """
        self.db = db
        self.auto_fix = auto_fix
        self.audit_logger = audit_logger or AuditLogger(db)

        # Initialize payment gateway clients
        if stripe_api_key:
            stripe.api_key = stripe_api_key

        if razorpay_key_id and razorpay_key_secret:
            self.razorpay_client = razorpay.Client(
                auth=(razorpay_key_id, razorpay_key_secret)
            )
        else:
            self.razorpay_client = None

    async def run_full_reconciliation(self) -> ReconciliationResult:
        """
        Run full reconciliation across all active subscriptions.

        Returns:
            ReconciliationResult with summary and discrepancies
        """
        started_at = datetime.utcnow()
        discrepancies: List[Discrepancy] = []
        errors: List[str] = []
        auto_fixed = 0
        manual_review = 0

        logger.info("Starting full subscription reconciliation")

        try:
            # Get all active and recently cancelled subscriptions
            cutoff_date = datetime.utcnow() - timedelta(days=90)
            stmt = select(UserSubscription).where(
                or_(
                    UserSubscription.status.in_(['active', 'trial', 'past_due']),
                    and_(
                        UserSubscription.status == 'cancelled',
                        UserSubscription.cancelled_at >= cutoff_date
                    )
                )
            )
            result = await self.db.execute(stmt)
            subscriptions = result.scalars().all()

            logger.info(f"Reconciling {len(subscriptions)} subscriptions")

            # Check each subscription
            for subscription in subscriptions:
                try:
                    sub_discrepancies = await self._reconcile_subscription(subscription)

                    for disc in sub_discrepancies:
                        discrepancies.append(disc)

                        # Apply auto-fix if enabled and recommended
                        if (self.auto_fix and
                            disc.recommended_action != ReconciliationAction.MANUAL_REVIEW):
                            try:
                                await self._apply_fix(subscription, disc)
                                auto_fixed += 1
                            except Exception as e:
                                logger.error(f"Failed to auto-fix discrepancy: {e}")
                                disc.recommended_action = ReconciliationAction.MANUAL_REVIEW
                                manual_review += 1
                        elif disc.recommended_action == ReconciliationAction.MANUAL_REVIEW:
                            manual_review += 1

                except Exception as e:
                    error_msg = f"Error reconciling subscription {subscription.id}: {str(e)}"
                    logger.error(error_msg)
                    errors.append(error_msg)

            # Log reconciliation summary
            await self.audit_logger.log_event(
                event_type=AuditEventType.SYSTEM_RECONCILIATION_COMPLETED,
                user_id=None,
                resource_type="reconciliation",
                resource_id="full",
                event_data={
                    "subscriptions_checked": len(subscriptions),
                    "discrepancies_found": len(discrepancies),
                    "auto_fixed": auto_fixed,
                    "manual_review_required": manual_review
                },
                status="success",
                gateway=None
            )

        except Exception as e:
            error_msg = f"Fatal error during reconciliation: {str(e)}"
            logger.error(error_msg)
            errors.append(error_msg)

        completed_at = datetime.utcnow()

        result = ReconciliationResult(
            started_at=started_at,
            completed_at=completed_at,
            subscriptions_checked=len(subscriptions),
            discrepancies_found=len(discrepancies),
            discrepancies=discrepancies,
            auto_fixed=auto_fixed,
            manual_review_required=manual_review,
            errors=errors
        )

        logger.info(
            f"Reconciliation complete: {result.subscriptions_checked} checked, "
            f"{result.discrepancies_found} issues found, "
            f"{result.auto_fixed} auto-fixed, "
            f"{result.manual_review_required} need manual review"
        )

        return result

    async def _reconcile_subscription(
        self,
        subscription: UserSubscription
    ) -> List[Discrepancy]:
        """
        Reconcile a single subscription with payment gateway.

        Args:
            subscription: Database subscription record

        Returns:
            List of discrepancies found
        """
        discrepancies: List[Discrepancy] = []

        # Skip if no gateway subscription ID
        if not subscription.stripe_subscription_id and not subscription.razorpay_subscription_id:
            # This is okay for free plans or manual subscriptions
            return discrepancies

        # Reconcile with Stripe
        if subscription.stripe_subscription_id:
            stripe_discs = await self._reconcile_with_stripe(subscription)
            discrepancies.extend(stripe_discs)

        # Reconcile with Razorpay
        if subscription.razorpay_subscription_id:
            razorpay_discs = await self._reconcile_with_razorpay(subscription)
            discrepancies.extend(razorpay_discs)

        return discrepancies

    async def _reconcile_with_stripe(
        self,
        subscription: UserSubscription
    ) -> List[Discrepancy]:
        """
        Reconcile subscription with Stripe.

        Args:
            subscription: Database subscription record

        Returns:
            List of discrepancies found
        """
        discrepancies: List[Discrepancy] = []

        try:
            # Fetch subscription from Stripe
            stripe_sub = stripe.Subscription.retrieve(
                subscription.stripe_subscription_id
            )

            # Check status mismatch
            stripe_status = self._map_stripe_status(stripe_sub.status)
            if stripe_status != subscription.status:
                discrepancies.append(Discrepancy(
                    subscription_id=str(subscription.id),
                    user_id=str(subscription.user_id),
                    discrepancy_type=DiscrepancyType.STATUS_MISMATCH,
                    db_value=subscription.status,
                    gateway_value=stripe_status,
                    recommended_action=ReconciliationAction.UPDATE_DB,
                    severity="high",
                    details={
                        "gateway": "stripe",
                        "stripe_subscription_id": subscription.stripe_subscription_id
                    }
                ))

            # Check trial end date mismatch
            if stripe_sub.trial_end and subscription.trial_end:
                stripe_trial_end = datetime.fromtimestamp(stripe_sub.trial_end)
                db_trial_end = subscription.trial_end

                # Allow 1 minute tolerance for timestamp differences
                if abs((stripe_trial_end - db_trial_end).total_seconds()) > 60:
                    discrepancies.append(Discrepancy(
                        subscription_id=str(subscription.id),
                        user_id=str(subscription.user_id),
                        discrepancy_type=DiscrepancyType.TRIAL_END_MISMATCH,
                        db_value=db_trial_end.isoformat(),
                        gateway_value=stripe_trial_end.isoformat(),
                        recommended_action=ReconciliationAction.UPDATE_DB,
                        severity="low",
                        details={"gateway": "stripe"}
                    ))

        except stripe.error.InvalidRequestError as e:
            # Subscription not found in Stripe
            if "No such subscription" in str(e):
                discrepancies.append(Discrepancy(
                    subscription_id=str(subscription.id),
                    user_id=str(subscription.user_id),
                    discrepancy_type=DiscrepancyType.MISSING_IN_GATEWAY,
                    db_value=subscription.status,
                    gateway_value=None,
                    recommended_action=ReconciliationAction.MANUAL_REVIEW,
                    severity="critical",
                    details={
                        "gateway": "stripe",
                        "error": str(e),
                        "stripe_subscription_id": subscription.stripe_subscription_id
                    }
                ))
            else:
                raise

        return discrepancies

    async def _reconcile_with_razorpay(
        self,
        subscription: UserSubscription
    ) -> List[Discrepancy]:
        """
        Reconcile subscription with Razorpay.

        Args:
            subscription: Database subscription record

        Returns:
            List of discrepancies found
        """
        discrepancies: List[Discrepancy] = []

        if not self.razorpay_client:
            return discrepancies

        try:
            # Fetch subscription from Razorpay
            razorpay_sub = self.razorpay_client.subscription.fetch(
                subscription.razorpay_subscription_id
            )

            # Check status mismatch
            razorpay_status = self._map_razorpay_status(razorpay_sub['status'])
            if razorpay_status != subscription.status:
                discrepancies.append(Discrepancy(
                    subscription_id=str(subscription.id),
                    user_id=str(subscription.user_id),
                    discrepancy_type=DiscrepancyType.STATUS_MISMATCH,
                    db_value=subscription.status,
                    gateway_value=razorpay_status,
                    recommended_action=ReconciliationAction.UPDATE_DB,
                    severity="high",
                    details={
                        "gateway": "razorpay",
                        "razorpay_subscription_id": subscription.razorpay_subscription_id
                    }
                ))

        except Exception as e:
            # Check if subscription not found
            if "not found" in str(e).lower():
                discrepancies.append(Discrepancy(
                    subscription_id=str(subscription.id),
                    user_id=str(subscription.user_id),
                    discrepancy_type=DiscrepancyType.MISSING_IN_GATEWAY,
                    db_value=subscription.status,
                    gateway_value=None,
                    recommended_action=ReconciliationAction.MANUAL_REVIEW,
                    severity="critical",
                    details={
                        "gateway": "razorpay",
                        "error": str(e),
                        "razorpay_subscription_id": subscription.razorpay_subscription_id
                    }
                ))
            else:
                raise

        return discrepancies

    async def _apply_fix(
        self,
        subscription: UserSubscription,
        discrepancy: Discrepancy
    ) -> None:
        """
        Apply automatic fix for a discrepancy.

        Args:
            subscription: Database subscription record
            discrepancy: Discrepancy to fix
        """
        if discrepancy.recommended_action == ReconciliationAction.UPDATE_DB:
            # Update database to match gateway
            old_status = subscription.status

            if discrepancy.discrepancy_type == DiscrepancyType.STATUS_MISMATCH:
                subscription.status = discrepancy.gateway_value
                subscription.updated_at = datetime.utcnow()

                await self.db.commit()

                # Log the change
                await self.audit_logger.log_event(
                    event_type=AuditEventType.SYSTEM_RECONCILIATION_FIX,
                    user_id=subscription.user_id,
                    resource_type="subscription",
                    resource_id=str(subscription.id),
                    event_data={
                        "discrepancy_type": discrepancy.discrepancy_type.value,
                        "old_status": old_status,
                        "new_status": discrepancy.gateway_value,
                        "gateway": discrepancy.details.get("gateway")
                    },
                    previous_state={"status": old_status},
                    new_state={"status": discrepancy.gateway_value},
                    status="success",
                    gateway=discrepancy.details.get("gateway")
                )

                logger.info(
                    f"Auto-fixed subscription {subscription.id}: "
                    f"{old_status} -> {discrepancy.gateway_value}"
                )

    def _map_stripe_status(self, stripe_status: str) -> str:
        """
        Map Stripe subscription status to our internal status.

        Args:
            stripe_status: Stripe status (active, trialing, past_due, canceled, etc.)

        Returns:
            Our internal status
        """
        status_map = {
            'active': 'active',
            'trialing': 'trial',
            'past_due': 'past_due',
            'canceled': 'cancelled',
            'unpaid': 'cancelled',
            'incomplete': 'pending',
            'incomplete_expired': 'cancelled'
        }
        return status_map.get(stripe_status, 'unknown')

    def _map_razorpay_status(self, razorpay_status: str) -> str:
        """
        Map Razorpay subscription status to our internal status.

        Args:
            razorpay_status: Razorpay status (created, authenticated, active, etc.)

        Returns:
            Our internal status
        """
        status_map = {
            'created': 'pending',
            'authenticated': 'pending',
            'active': 'active',
            'pending': 'pending',
            'halted': 'past_due',
            'cancelled': 'cancelled',
            'completed': 'cancelled',
            'expired': 'cancelled'
        }
        return status_map.get(razorpay_status, 'unknown')


async def run_daily_reconciliation(
    db: AsyncSession,
    stripe_api_key: str,
    razorpay_key_id: Optional[str] = None,
    razorpay_key_secret: Optional[str] = None
) -> ReconciliationResult:
    """
    Convenience function to run daily reconciliation.

    Usage in cron job or scheduler:
        result = await run_daily_reconciliation(db, stripe_key, razorpay_id, razorpay_secret)
        if result.discrepancies_found > 0:
            send_alert_to_admin(result)

    Args:
        db: Database session
        stripe_api_key: Stripe API key
        razorpay_key_id: Razorpay key ID (optional)
        razorpay_key_secret: Razorpay key secret (optional)

    Returns:
        ReconciliationResult
    """
    service = ReconciliationService(
        db=db,
        stripe_api_key=stripe_api_key,
        razorpay_key_id=razorpay_key_id,
        razorpay_key_secret=razorpay_key_secret,
        auto_fix=True
    )

    return await service.run_full_reconciliation()
