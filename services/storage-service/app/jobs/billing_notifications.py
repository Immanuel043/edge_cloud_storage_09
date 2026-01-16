"""
Billing Notifications Background Job

Runs periodically to check for upcoming payments and send reminders.
"""
import asyncio
from datetime import datetime, timezone
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models.database import User
from shared_billing import BillingService
from shared_billing.notification_service import BillingNotificationService
from shared_billing.models import BillingNotification, UserSubscription

logger = logging.getLogger(__name__)


async def send_payment_reminder_email(
    user: User,
    notification: BillingNotification,
    subscription: UserSubscription,
    plan_name: str
):
    """
    Send payment reminder email to user.

    Args:
        user: User object
        notification: Notification details
        subscription: User subscription
        plan_name: Name of the plan
    """
    try:
        from app.services.email_service import EmailService
        email_service = EmailService()

        # Format payment date
        payment_date = notification.payment_due_date.strftime('%B %d, %Y')

        # Create email body
        subject = f"Payment Reminder: Your {plan_name} subscription renewal"

        body = f"""
        <html>
        <body style="font-family: Arial, sans-serif; color: #333;">
            <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
                <h2 style="color: #2563eb;">Payment Reminder</h2>

                <p>Hi {user.username},</p>

                <p>This is a friendly reminder that your <strong>{plan_name}</strong> subscription will renew in <strong>{notification.days_before_payment} days</strong>.</p>

                <div style="background-color: #f3f4f6; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <p style="margin: 5px 0;"><strong>Plan:</strong> {plan_name}</p>
                    <p style="margin: 5px 0;"><strong>Billing Cycle:</strong> {subscription.billing_cycle.replace('_', ' ').title()}</p>
                    <p style="margin: 5px 0;"><strong>Amount Due:</strong> ₹{notification.amount_due}</p>
                    <p style="margin: 5px 0;"><strong>Payment Date:</strong> {payment_date}</p>
                </div>

                <p>Your payment will be automatically processed on the payment date. Please ensure you have sufficient funds in your payment method.</p>

                <p>If you have any questions or need to update your payment method, please visit your account settings.</p>

                <p style="margin-top: 30px;">
                    Best regards,<br>
                    <strong>Edge Cloud Storage Team</strong>
                </p>

                <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">

                <p style="font-size: 12px; color: #6b7280;">
                    This is an automated notification. If you wish to cancel your subscription, please visit your account settings.
                </p>
            </div>
        </body>
        </html>
        """

        # Send email
        await email_service.send_email(
            to_email=user.email,
            subject=subject,
            body=body
        )

        logger.info(f"Sent payment reminder to {user.email} for subscription {subscription.id}")
        return True

    except Exception as e:
        logger.error(f"Failed to send payment reminder email to {user.email}: {e}")
        raise


async def process_billing_notifications():
    """
    Process billing notifications for all subscriptions.

    This function:
    1. Finds subscriptions with upcoming payments
    2. Creates reminder notifications based on billing cycle
    3. Sends email reminders to users
    """
    logger.info("Starting billing notification processing...")

    async with async_session() as db:
        try:
            # Initialize services
            billing_service = BillingService(db, service_type='normal')
            notification_service = BillingNotificationService(db, service_type='normal')

            # Get subscriptions needing reminders
            subscriptions = await notification_service.get_subscriptions_needing_reminders()

            logger.info(f"Found {len(subscriptions)} subscriptions with upcoming payments")

            # Process each subscription
            for subscription in subscriptions:
                try:
                    # Get plan details
                    plan = await billing_service.get_plan_by_code(subscription.plan.plan_code)

                    # Schedule reminders for this subscription
                    await notification_service.schedule_reminders_for_subscription(
                        subscription=subscription,
                        plan=plan
                    )

                except Exception as e:
                    logger.error(f"Failed to schedule reminders for subscription {subscription.id}: {e}")
                    continue

            # Get all pending notifications
            result = await db.execute(
                select(BillingNotification)
                .filter(BillingNotification.status == 'pending')
            )
            pending_notifications = result.scalars().all()

            logger.info(f"Processing {len(pending_notifications)} pending notifications")

            # Send emails for pending notifications
            sent_count = 0
            failed_count = 0

            for notification in pending_notifications:
                try:
                    # Get subscription with plan
                    sub_result = await db.execute(
                        select(UserSubscription)
                        .filter(UserSubscription.id == notification.subscription_id)
                    )
                    subscription = sub_result.scalar_one_or_none()

                    if not subscription:
                        logger.warning(f"Subscription not found for notification {notification.id}")
                        await notification_service.mark_notification_sent(
                            notification.id,
                            error_message="Subscription not found"
                        )
                        failed_count += 1
                        continue

                    # Get user
                    user_result = await db.execute(
                        select(User)
                        .filter(User.id == notification.user_id)
                    )
                    user = user_result.scalar_one_or_none()

                    if not user:
                        logger.warning(f"User not found for notification {notification.id}")
                        await notification_service.mark_notification_sent(
                            notification.id,
                            error_message="User not found"
                        )
                        failed_count += 1
                        continue

                    # Get plan
                    plan = await billing_service.get_plan_by_code(subscription.plan.plan_code)

                    # Send email
                    await send_payment_reminder_email(
                        user=user,
                        notification=notification,
                        subscription=subscription,
                        plan_name=plan.display_name
                    )

                    # Mark as sent
                    await notification_service.mark_notification_sent(notification.id)
                    sent_count += 1

                except Exception as e:
                    logger.error(f"Failed to send notification {notification.id}: {e}")
                    await notification_service.mark_notification_sent(
                        notification.id,
                        error_message=str(e)
                    )
                    failed_count += 1

            logger.info(
                f"Billing notification processing complete. "
                f"Sent: {sent_count}, Failed: {failed_count}"
            )

            return {
                'sent': sent_count,
                'failed': failed_count,
                'total_subscriptions': len(subscriptions)
            }

        except Exception as e:
            logger.error(f"Error processing billing notifications: {e}")
            raise


async def run_notification_scheduler():
    """
    Run the notification scheduler in a loop.

    Checks for notifications every hour.
    """
    while True:
        try:
            logger.info("Running billing notification check...")
            await process_billing_notifications()
            logger.info("Billing notification check complete. Sleeping for 1 hour...")

            # Sleep for 1 hour
            await asyncio.sleep(3600)

        except Exception as e:
            logger.error(f"Error in notification scheduler: {e}")
            # Sleep for 5 minutes before retrying
            await asyncio.sleep(300)


if __name__ == "__main__":
    # For testing purposes
    asyncio.run(process_billing_notifications())
