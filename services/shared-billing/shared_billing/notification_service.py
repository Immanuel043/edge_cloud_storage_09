"""
Billing Notification Service

Handles sending payment reminders and renewal notifications to users.
"""
from datetime import datetime, timedelta, timezone
from typing import List, Optional
from uuid import UUID
import logging

from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .models import UserSubscription, SubscriptionPlan, BillingNotification
from .exceptions import SubscriptionNotFoundError

logger = logging.getLogger(__name__)


class BillingNotificationService:
    """Service for managing billing notifications"""

    def __init__(self, db: AsyncSession, service_type: str = 'normal'):
        """
        Initialize notification service.

        Args:
            db: Database session
            service_type: 'normal' or 'zk'
        """
        self.db = db
        self.service_type = service_type

        # Notification schedule based on billing cycle
        self.reminder_schedule = {
            'monthly': [3, 1],  # 3 days before, 1 day before
            'six_months': [7, 3, 1],  # 7 days, 3 days, 1 day before
            'yearly': [14, 7, 3, 1]  # 14 days, 7 days, 3 days, 1 day before
        }

    async def get_subscriptions_needing_reminders(self) -> List[UserSubscription]:
        """
        Get subscriptions that need payment reminders.

        Returns:
            List of subscriptions needing reminders
        """
        now = datetime.now(timezone.utc)
        max_days_ahead = 14  # Check up to 14 days in advance

        # Get active subscriptions with next_payment_at set
        result = await self.db.execute(
            select(UserSubscription)
            .join(SubscriptionPlan)
            .options(selectinload(UserSubscription.plan))
            .filter(
                and_(
                    UserSubscription.service_type == self.service_type,
                    UserSubscription.status == 'active',
                    UserSubscription.billing_cycle.isnot(None),
                    UserSubscription.next_payment_at.isnot(None),
                    UserSubscription.next_payment_at > now,
                    UserSubscription.next_payment_at <= now + timedelta(days=max_days_ahead)
                )
            )
        )

        return result.scalars().all()

    async def should_send_reminder(
        self,
        subscription: UserSubscription,
        days_before: int
    ) -> bool:
        """
        Check if a reminder should be sent for this subscription.

        Args:
            subscription: User subscription
            days_before: Days before payment date

        Returns:
            True if reminder should be sent
        """
        if not subscription.next_payment_at or not subscription.billing_cycle:
            return False

        now = datetime.now(timezone.utc)
        days_until_payment = (subscription.next_payment_at - now).days

        # Check if we're within the reminder window
        if days_until_payment != days_before:
            return False

        # Check if we've already sent this reminder
        result = await self.db.execute(
            select(BillingNotification)
            .filter(
                and_(
                    BillingNotification.subscription_id == subscription.id,
                    BillingNotification.notification_type == 'payment_reminder',
                    BillingNotification.days_before_payment == days_before,
                    BillingNotification.status.in_(['pending', 'sent'])
                )
            )
        )

        existing_notification = result.scalar_one_or_none()
        return existing_notification is None

    async def create_payment_reminder(
        self,
        subscription: UserSubscription,
        days_before: int,
        amount_due: float,
        currency: str = 'INR'
    ) -> BillingNotification:
        """
        Create a payment reminder notification.

        Args:
            subscription: User subscription
            days_before: Days before payment date
            amount_due: Amount to be charged
            currency: Currency code

        Returns:
            Created notification
        """
        notification = BillingNotification(
            user_id=subscription.user_id,
            service_type=self.service_type,
            subscription_id=subscription.id,
            notification_type='payment_reminder',
            billing_cycle=subscription.billing_cycle,
            days_before_payment=days_before,
            amount_due=amount_due,
            currency=currency,
            payment_due_date=subscription.next_payment_at,
            status='pending'
        )

        self.db.add(notification)
        await self.db.commit()
        await self.db.refresh(notification)

        logger.info(
            f"Created payment reminder for user {subscription.user_id}, "
            f"{days_before} days before payment"
        )

        return notification

    async def mark_notification_sent(
        self,
        notification_id: UUID,
        error_message: Optional[str] = None
    ):
        """
        Mark a notification as sent or failed.

        Args:
            notification_id: Notification ID
            error_message: Error message if sending failed
        """
        result = await self.db.execute(
            select(BillingNotification)
            .filter(BillingNotification.id == notification_id)
        )

        notification = result.scalar_one_or_none()
        if not notification:
            return

        if error_message:
            notification.status = 'failed'
            notification.error_message = error_message
        else:
            notification.status = 'sent'
            notification.sent_at = datetime.now(timezone.utc)

        await self.db.commit()

    async def process_pending_notifications(
        self,
        email_service
    ) -> dict:
        """
        Process all pending notifications and send emails.

        Args:
            email_service: Email service instance for sending emails

        Returns:
            Dictionary with sent/failed counts
        """
        # Get all pending notifications
        result = await self.db.execute(
            select(BillingNotification)
            .filter(
                and_(
                    BillingNotification.service_type == self.service_type,
                    BillingNotification.status == 'pending'
                )
            )
        )

        pending_notifications = result.scalars().all()

        sent_count = 0
        failed_count = 0

        for notification in pending_notifications:
            try:
                # Get subscription and plan details
                subscription_result = await self.db.execute(
                    select(UserSubscription)
                    .join(SubscriptionPlan)
                    .options(selectinload(UserSubscription.plan))
                    .filter(UserSubscription.id == notification.subscription_id)
                )
                subscription = subscription_result.scalar_one_or_none()

                if not subscription or not subscription.plan:
                    logger.warning(f"Subscription not found for notification {notification.id}")
                    continue

                # Get user email (need to query user table)
                # This will be implemented by the calling service since it has access to User model

                # For now, mark as ready to send
                # The actual email sending will be done by a background job
                await self.mark_notification_sent(notification.id)
                sent_count += 1

            except Exception as e:
                logger.error(f"Failed to process notification {notification.id}: {e}")
                await self.mark_notification_sent(notification.id, error_message=str(e))
                failed_count += 1

        return {
            'sent': sent_count,
            'failed': failed_count,
            'total': len(pending_notifications)
        }

    async def schedule_reminders_for_subscription(
        self,
        subscription: UserSubscription,
        plan: SubscriptionPlan
    ):
        """
        Schedule all reminders for a subscription based on billing cycle.

        Args:
            subscription: User subscription
            plan: Subscription plan
        """
        if not subscription.billing_cycle or not subscription.next_payment_at:
            return

        # Get reminder schedule for this billing cycle
        reminder_days = self.reminder_schedule.get(subscription.billing_cycle, [])

        # Get the amount for this billing cycle
        if subscription.billing_cycle == 'monthly':
            amount = plan.price_monthly
        elif subscription.billing_cycle == 'six_months':
            amount = plan.price_six_months
        elif subscription.billing_cycle == 'yearly':
            amount = plan.price_yearly
        else:
            amount = 0

        if not amount:
            return

        # Create reminders for each day in the schedule
        for days_before in reminder_days:
            should_send = await self.should_send_reminder(subscription, days_before)

            if should_send:
                await self.create_payment_reminder(
                    subscription=subscription,
                    days_before=days_before,
                    amount_due=float(amount),
                    currency=plan.currency
                )

    async def get_user_notifications(
        self,
        user_id: UUID,
        limit: int = 10
    ) -> List[BillingNotification]:
        """
        Get notification history for a user.

        Args:
            user_id: User ID
            limit: Maximum number of notifications to return

        Returns:
            List of notifications
        """
        result = await self.db.execute(
            select(BillingNotification)
            .filter(
                and_(
                    BillingNotification.user_id == user_id,
                    BillingNotification.service_type == self.service_type
                )
            )
            .order_by(BillingNotification.created_at.desc())
            .limit(limit)
        )

        return result.scalars().all()
