"""
Trial Period Management with Auto-Conversion

Manages free trial periods with automatic conversion to paid plans.

Features:
- Trial period tracking
- Auto-conversion at trial end
- Payment method requirement
- Trial extensions (admin only)
- Cancellation handling
"""

import logging
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
from uuid import UUID

from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession

from .models import UserSubscription, SubscriptionPlan
from .exceptions import SubscriptionNotFoundError
from .audit_logger import AuditLogger, AuditEventType

logger = logging.getLogger(__name__)


class TrialManager:
    """
    Manages trial periods and auto-conversion logic.

    Trial Flow:
    1. User signs up → Gets free trial (14 days default)
    2. Payment method required upfront
    3. Trial expires → Auto-converts to paid plan
    4. If payment fails → Subscription cancelled
    """

    DEFAULT_TRIAL_DAYS = 14

    def __init__(self, db: AsyncSession):
        self.db = db
        self.audit_logger = AuditLogger(db)

    async def start_trial(
        self,
        user_id: UUID,
        plan_id: UUID,
        trial_days: int = DEFAULT_TRIAL_DAYS,
        payment_method_id: Optional[str] = None,
        gateway: Optional[str] = None
    ) -> UserSubscription:
        """
        Start a free trial period.

        Args:
            user_id: User ID
            plan_id: Plan to trial
            trial_days: Trial duration in days
            payment_method_id: Payment method for auto-conversion
            gateway: Payment gateway ('stripe' or 'razorpay')

        Returns:
            Subscription with trial status

        Raises:
            ValueError: If payment method not provided (required for trials)
        """
        # Payment method required for trials (for auto-conversion)
        if not payment_method_id or not gateway:
            raise ValueError(
                "Payment method required for trial. "
                "This ensures seamless conversion when trial ends."
            )

        # Calculate trial end date
        trial_start = datetime.utcnow()
        trial_end = trial_start + timedelta(days=trial_days)

        # Create subscription in trial status
        subscription = UserSubscription(
            user_id=user_id,
            plan_id=plan_id,
            status='trial',
            trial_start=trial_start,
            trial_end=trial_end,
            payment_gateway=gateway,
            billing_cycle='monthly'  # Default after trial
        )

        # Store payment method for auto-conversion
        if gateway == 'stripe':
            subscription.stripe_payment_method_id = payment_method_id
        elif gateway == 'razorpay':
            subscription.razorpay_payment_method_id = payment_method_id

        self.db.add(subscription)
        await self.db.commit()
        await self.db.refresh(subscription)

        # Audit log
        await self.audit_logger.log_event(
            event_type=AuditEventType.SUBSCRIPTION_CREATED,
            user_id=user_id,
            resource_type='subscription',
            resource_id=str(subscription.id),
            gateway=gateway,
            event_data={
                'trial_days': trial_days,
                'trial_end': trial_end.isoformat(),
                'has_payment_method': True
            },
            notes=f"Started {trial_days}-day trial"
        )

        logger.info(
            f"Trial started for user {user_id}",
            extra={
                "user_id": str(user_id),
                "trial_days": trial_days,
                "trial_end": trial_end.isoformat()
            }
        )

        return subscription

    async def convert_trial_to_paid(
        self,
        subscription: UserSubscription,
        charge_payment: bool = True
    ) -> Dict[str, Any]:
        """
        Convert trial subscription to paid.

        Called when:
        - Trial period expires (automatic)
        - User upgrades early (manual)

        Args:
            subscription: Trial subscription to convert
            charge_payment: Whether to charge payment method (default: True)

        Returns:
            Conversion result with payment status

        Raises:
            ValueError: If subscription is not in trial status
        """
        if subscription.status != 'trial':
            raise ValueError(f"Subscription is not in trial status: {subscription.status}")

        # Get plan for pricing
        result = await self.db.execute(
            select(SubscriptionPlan).where(SubscriptionPlan.id == subscription.plan_id)
        )
        plan = result.scalar_one()

        conversion_result = {
            'success': False,
            'subscription_id': str(subscription.id),
            'user_id': str(subscription.user_id),
            'plan_code': plan.plan_code,
            'trial_converted': True,
            'payment_charged': False,
            'error': None
        }

        try:
            # Charge payment if required
            if charge_payment:
                payment_result = await self._charge_trial_conversion(subscription, plan)
                conversion_result['payment_charged'] = payment_result['success']
                conversion_result['payment_id'] = payment_result.get('payment_id')

                if not payment_result['success']:
                    # Payment failed - cancel subscription
                    subscription.status = 'cancelled'
                    subscription.cancelled_at = datetime.utcnow()
                    conversion_result['error'] = payment_result.get('error')

                    await self.audit_logger.log_event(
                        event_type=AuditEventType.PAYMENT_FAILED,
                        user_id=subscription.user_id,
                        resource_type='subscription',
                        resource_id=str(subscription.id),
                        gateway=subscription.payment_gateway,
                        status='failed',
                        error_message=payment_result.get('error'),
                        notes="Trial conversion payment failed - subscription cancelled"
                    )

                    logger.warning(
                        f"Trial conversion payment failed for subscription {subscription.id}",
                        extra={"subscription_id": str(subscription.id), "error": payment_result.get('error')}
                    )

                    await self.db.commit()
                    conversion_result['success'] = False
                    return conversion_result

            # Payment successful (or not required) - activate subscription
            subscription.status = 'active'
            subscription.current_period_start = datetime.utcnow()
            subscription.current_period_end = datetime.utcnow() + timedelta(days=30)  # Monthly

            await self.db.commit()
            await self.db.refresh(subscription)

            # Audit log
            await self.audit_logger.log_subscription_change(
                event_type=AuditEventType.SUBSCRIPTION_RENEWED,
                user_id=subscription.user_id,
                subscription_id=subscription.id,
                old_plan_code=plan.plan_code,
                new_plan_code=plan.plan_code,
                old_status='trial',
                new_status='active',
                reason='trial_conversion',
                gateway=subscription.payment_gateway
            )

            logger.info(
                f"Trial converted to paid subscription {subscription.id}",
                extra={"subscription_id": str(subscription.id), "user_id": str(subscription.user_id)}
            )

            conversion_result['success'] = True
            return conversion_result

        except Exception as e:
            logger.error(f"Error converting trial: {e}", exc_info=True)
            conversion_result['error'] = str(e)
            return conversion_result

    async def _charge_trial_conversion(
        self,
        subscription: UserSubscription,
        plan: SubscriptionPlan
    ) -> Dict[str, Any]:
        """
        Charge payment method for trial conversion.

        Args:
            subscription: Subscription to charge
            plan: Plan being subscribed to

        Returns:
            Payment result
        """
        # Import payment service
        from .payment_service import PaymentService

        # Get payment method
        if subscription.payment_gateway == 'stripe':
            payment_method_id = subscription.stripe_payment_method_id
        elif subscription.payment_gateway == 'razorpay':
            payment_method_id = subscription.razorpay_payment_method_id
        else:
            return {'success': False, 'error': 'Unknown payment gateway'}

        if not payment_method_id:
            return {'success': False, 'error': 'No payment method on file'}

        try:
            # Initialize payment service
            payment_service = PaymentService(gateway=subscription.payment_gateway)

            # Charge for monthly subscription (trial conversion always starts monthly)
            amount = plan.price_monthly
            currency = plan.currency or 'USD'

            # Create charge
            result = await payment_service.charge_payment_method(
                payment_method_id=payment_method_id,
                amount=amount,
                currency=currency,
                description=f"Trial conversion - {plan.display_name}",
                metadata={
                    'subscription_id': str(subscription.id),
                    'user_id': str(subscription.user_id),
                    'plan_code': plan.plan_code,
                    'trial_conversion': True
                }
            )

            return {
                'success': result.get('success', False),
                'payment_id': result.get('payment_id'),
                'error': result.get('error')
            }

        except Exception as e:
            logger.error(f"Error charging trial conversion: {e}", exc_info=True)
            return {'success': False, 'error': str(e)}

    async def check_expiring_trials(
        self,
        days_before_expiry: int = 3
    ) -> list[UserSubscription]:
        """
        Get trials expiring soon (for reminder emails).

        Args:
            days_before_expiry: How many days before expiry to check

        Returns:
            List of subscriptions expiring soon
        """
        cutoff_date = datetime.utcnow() + timedelta(days=days_before_expiry)

        result = await self.db.execute(
            select(UserSubscription).where(
                and_(
                    UserSubscription.status == 'trial',
                    UserSubscription.trial_end <= cutoff_date,
                    UserSubscription.trial_end >= datetime.utcnow()
                )
            )
        )

        return result.scalars().all()

    async def process_expired_trials(self) -> Dict[str, int]:
        """
        Process all expired trials (auto-conversion or cancellation).

        Should be run as a daily cron job.

        Returns:
            Statistics on processed trials
        """
        stats = {
            'total_expired': 0,
            'converted_success': 0,
            'converted_failed': 0,
            'errors': 0
        }

        # Get all expired trials
        result = await self.db.execute(
            select(UserSubscription).where(
                and_(
                    UserSubscription.status == 'trial',
                    UserSubscription.trial_end <= datetime.utcnow()
                )
            )
        )

        expired_trials = result.scalars().all()
        stats['total_expired'] = len(expired_trials)

        logger.info(f"Processing {len(expired_trials)} expired trials")

        for subscription in expired_trials:
            try:
                result = await self.convert_trial_to_paid(subscription, charge_payment=True)

                if result['success']:
                    stats['converted_success'] += 1
                else:
                    stats['converted_failed'] += 1

            except Exception as e:
                logger.error(
                    f"Error processing expired trial {subscription.id}: {e}",
                    exc_info=True
                )
                stats['errors'] += 1

        logger.info(
            f"Expired trial processing complete",
            extra=stats
        )

        return stats

    async def cancel_trial(
        self,
        subscription: UserSubscription,
        reason: str = 'user_request'
    ) -> UserSubscription:
        """
        Cancel a trial subscription.

        Args:
            subscription: Trial subscription to cancel
            reason: Cancellation reason

        Returns:
            Cancelled subscription
        """
        if subscription.status != 'trial':
            raise ValueError(f"Subscription is not in trial status: {subscription.status}")

        subscription.status = 'cancelled'
        subscription.cancelled_at = datetime.utcnow()

        await self.db.commit()
        await self.db.refresh(subscription)

        # Audit log
        await self.audit_logger.log_event(
            event_type=AuditEventType.SUBSCRIPTION_CANCELLED,
            user_id=subscription.user_id,
            resource_type='subscription',
            resource_id=str(subscription.id),
            gateway=subscription.payment_gateway,
            event_data={'reason': reason, 'during_trial': True},
            notes=f"Trial cancelled: {reason}"
        )

        logger.info(
            f"Trial cancelled: {subscription.id}",
            extra={"subscription_id": str(subscription.id), "reason": reason}
        )

        return subscription

    async def extend_trial(
        self,
        subscription: UserSubscription,
        additional_days: int,
        admin_id: UUID,
        admin_email: str,
        reason: str
    ) -> UserSubscription:
        """
        Extend trial period (admin only).

        Args:
            subscription: Trial subscription to extend
            additional_days: Days to add to trial
            admin_id: Admin performing action
            admin_email: Admin email
            reason: Reason for extension

        Returns:
            Updated subscription
        """
        if subscription.status != 'trial':
            raise ValueError(f"Subscription is not in trial status: {subscription.status}")

        old_trial_end = subscription.trial_end
        subscription.trial_end = subscription.trial_end + timedelta(days=additional_days)

        await self.db.commit()
        await self.db.refresh(subscription)

        # Audit log (admin action)
        await self.audit_logger.log_admin_action(
            event_type=AuditEventType.ADMIN_SUBSCRIPTION_MODIFIED,
            admin_id=admin_id,
            admin_email=admin_email,
            user_id=subscription.user_id,
            action='extend_trial',
            details={
                'subscription_id': str(subscription.id),
                'additional_days': additional_days,
                'old_trial_end': old_trial_end.isoformat(),
                'new_trial_end': subscription.trial_end.isoformat(),
                'reason': reason
            }
        )

        logger.info(
            f"Trial extended by {additional_days} days",
            extra={
                "subscription_id": str(subscription.id),
                "admin_id": str(admin_id),
                "additional_days": additional_days
            }
        )

        return subscription

    async def get_trial_status(
        self,
        subscription: UserSubscription
    ) -> Dict[str, Any]:
        """
        Get detailed trial status information.

        Args:
            subscription: Subscription to check

        Returns:
            Trial status details
        """
        if subscription.status != 'trial':
            return {
                'is_trial': False,
                'status': subscription.status
            }

        now = datetime.utcnow()
        days_remaining = (subscription.trial_end - now).days
        hours_remaining = (subscription.trial_end - now).total_seconds() / 3600

        return {
            'is_trial': True,
            'status': 'trial',
            'trial_start': subscription.trial_start.isoformat() if subscription.trial_start else None,
            'trial_end': subscription.trial_end.isoformat() if subscription.trial_end else None,
            'days_remaining': max(0, days_remaining),
            'hours_remaining': max(0, hours_remaining),
            'is_expired': now >= subscription.trial_end,
            'has_payment_method': bool(
                subscription.stripe_payment_method_id or subscription.razorpay_payment_method_id
            ),
            'will_auto_convert': True  # Always true if payment method exists
        }
