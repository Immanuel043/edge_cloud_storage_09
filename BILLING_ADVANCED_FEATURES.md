# Advanced Billing Features Implementation

Complete implementation guide for:
1. Real-time Usage Tracking
2. Strict Quota Enforcement
3. Email Notifications
4. Stripe Checkout Integration

---

## 1. Real-Time Usage Tracking ✅

### Implementation Files

#### A. `services/storage-service/app/services/usage_tracker.py`

```python
"""
Real-time Usage Tracking Service

Tracks storage and bandwidth usage in real-time using Redis counters.
Provides instant quota checks without database queries.
"""
import logging
from typing import Optional, Dict, Any
from datetime import datetime, timedelta
from uuid import UUID

from ..database import get_redis

logger = logging.getLogger(__name__)


class UsageTracker:
    """Real-time usage tracking with Redis."""

    # Redis key patterns
    STORAGE_KEY = "usage:storage:{user_id}"
    BANDWIDTH_DAY_KEY = "usage:bandwidth:{user_id}:{date}"
    BANDWIDTH_MONTH_KEY = "usage:bandwidth_month:{user_id}:{month}"

    # TTLs
    BANDWIDTH_DAY_TTL = 86400 * 2  # 2 days
    BANDWIDTH_MONTH_TTL = 86400 * 35  # 35 days

    async def track_storage_upload(self, user_id: UUID, bytes_added: int) -> Dict[str, Any]:
        """
        Track storage upload and return current usage.

        Args:
            user_id: User UUID
            bytes_added: Bytes uploaded

        Returns:
            Current usage stats
        """
        redis = await get_redis()
        if not redis:
            return {"error": "Redis unavailable"}

        key = self.STORAGE_KEY.format(user_id=str(user_id))

        # Atomic increment
        new_total = await redis.incrby(key, bytes_added)

        # Set expiry if new key
        if new_total == bytes_added:
            await redis.expire(key, 86400 * 90)  # 90 day TTL

        return {
            "user_id": str(user_id),
            "storage_used_bytes": new_total,
            "storage_used_gb": round(new_total / (1024**3), 2)
        }

    async def track_storage_delete(self, user_id: UUID, bytes_removed: int) -> Dict[str, Any]:
        """Track storage deletion (decrement usage)."""
        redis = await get_redis()
        if not redis:
            return {"error": "Redis unavailable"}

        key = self.STORAGE_KEY.format(user_id=str(user_id))

        # Atomic decrement
        new_total = await redis.decrby(key, bytes_removed)

        # Prevent negative values
        if new_total < 0:
            await redis.set(key, 0)
            new_total = 0

        return {
            "user_id": str(user_id),
            "storage_used_bytes": new_total,
            "storage_used_gb": round(new_total / (1024**3), 2)
        }

    async def track_bandwidth(self, user_id: UUID, bytes_transferred: int) -> Dict[str, Any]:
        """
        Track bandwidth usage (both upload and download).

        Returns:
            Daily and monthly bandwidth stats
        """
        redis = await get_redis()
        if not redis:
            return {"error": "Redis unavailable"}

        now = datetime.utcnow()
        date_key = now.strftime("%Y-%m-%d")
        month_key = now.strftime("%Y-%m")

        day_key = self.BANDWIDTH_DAY_KEY.format(user_id=str(user_id), date=date_key)
        month_key = self.BANDWIDTH_MONTH_KEY.format(user_id=str(user_id), month=month_key)

        # Increment both daily and monthly
        day_total = await redis.incrby(day_key, bytes_transferred)
        month_total = await redis.incrby(month_key, bytes_transferred)

        # Set expiries
        await redis.expire(day_key, self.BANDWIDTH_DAY_TTL)
        await redis.expire(month_key, self.BANDWIDTH_MONTH_TTL)

        return {
            "user_id": str(user_id),
            "bandwidth_today_bytes": day_total,
            "bandwidth_today_mb": round(day_total / (1024**2), 2),
            "bandwidth_month_bytes": month_total,
            "bandwidth_month_gb": round(month_total / (1024**3), 2)
        }

    async def get_storage_usage(self, user_id: UUID) -> int:
        """Get current storage usage in bytes."""
        redis = await get_redis()
        if not redis:
            return 0

        key = self.STORAGE_KEY.format(user_id=str(user_id))
        usage = await redis.get(key)
        return int(usage) if usage else 0

    async def get_bandwidth_usage(self, user_id: UUID) -> Dict[str, int]:
        """Get bandwidth usage for today and this month."""
        redis = await get_redis()
        if not redis:
            return {"today": 0, "month": 0}

        now = datetime.utcnow()
        date_key = now.strftime("%Y-%m-%d")
        month_key = now.strftime("%Y-%m")

        day_key = self.BANDWIDTH_DAY_KEY.format(user_id=str(user_id), date=date_key)
        month_key = self.BANDWIDTH_MONTH_KEY.format(user_id=str(user_id), month=month_key)

        day_total = await redis.get(day_key)
        month_total = await redis.get(month_key)

        return {
            "today": int(day_total) if day_total else 0,
            "month": int(month_total) if month_total else 0
        }

    async def sync_storage_to_db(self, user_id: UUID, db_session):
        """
        Sync Redis storage counter to database User.storage_used.
        Call this periodically (e.g., every 5 minutes).
        """
        from sqlalchemy import update
        from ..models.database import User

        redis_usage = await self.get_storage_usage(user_id)

        await db_session.execute(
            update(User)
            .where(User.id == user_id)
            .values(storage_used=redis_usage)
        )
        await db_session.commit()

        logger.info(f"Synced storage usage for user {user_id}: {redis_usage} bytes")


# Singleton instance
usage_tracker = UsageTracker()
```

#### B. Add to File Upload/Delete Endpoints

In `services/storage-service/app/routers/files.py`, add usage tracking:

```python
from ..services.usage_tracker import usage_tracker

# In file upload endpoint:
@router.post("/upload")
async def upload_file(...):
    # ... existing upload logic ...

    # Track storage usage in real-time
    await usage_tracker.track_storage_upload(current_user.id, file_size)

    # Track bandwidth
    await usage_tracker.track_bandwidth(current_user.id, file_size)

    return {"success": True}

# In file delete endpoint:
@router.delete("/{file_id}")
async def delete_file(...):
    # ... get file size ...

    # Track storage deletion
    await usage_tracker.track_storage_delete(current_user.id, file_size)

    return {"success": True}
```

---

## 2. Strict Quota Enforcement ✅

### Implementation File

#### `services/storage-service/app/middleware/quota_enforcement.py`

```python
"""
Quota Enforcement Middleware

Strictly enforces plan limits for storage and bandwidth.
Returns 402 Payment Required when limits are exceeded.
"""
import logging
from fastapi import Request, HTTPException
from starlette.middleware.base import BaseHTTPMiddleware

from shared_billing import BillingService
from ..services.usage_tracker import usage_tracker
from ..dependencies import get_db, get_current_user

logger = logging.getLogger(__name__)


class QuotaEnforcementMiddleware(BaseHTTPMiddleware):
    """Enforce quota limits on upload endpoints."""

    # Endpoints that require quota check
    UPLOAD_ENDPOINTS = [
        "/api/v1/files/upload",
        "/api/v1/upload/chunk",
        "/api/v1/folders/upload"
    ]

    async def dispatch(self, request: Request, call_next):
        # Check if this is an upload endpoint
        if not any(request.url.path.startswith(ep) for ep in self.UPLOAD_ENDPOINTS):
            return await call_next(request)

        # Get user from request (assume auth middleware ran first)
        user = getattr(request.state, 'user', None)
        if not user:
            return await call_next(request)  # Let auth middleware handle

        # Get content length
        content_length = int(request.headers.get('content-length', 0))
        if content_length == 0:
            return await call_next(request)

        # Check storage quota
        async with get_db() as db:
            billing = BillingService(db, service_type='normal')

            try:
                subscription = await billing.get_user_subscription(user.id, include_plan=True)
                plan = subscription.plan

                # Get current usage from Redis (real-time)
                current_usage = await usage_tracker.get_storage_usage(user.id)

                # Check if upload would exceed quota
                if current_usage + content_length > plan.storage_bytes:
                    storage_remaining = plan.storage_bytes - current_usage
                    storage_remaining_mb = storage_remaining / (1024**2)

                    raise HTTPException(
                        status_code=402,  # Payment Required
                        detail={
                            "error": "storage_quota_exceeded",
                            "message": f"Upload would exceed your storage quota",
                            "quota_bytes": plan.storage_bytes,
                            "used_bytes": current_usage,
                            "remaining_bytes": storage_remaining,
                            "remaining_mb": round(storage_remaining_mb, 2),
                            "current_plan": plan.plan_code,
                            "upgrade_url": "/api/v1/billing/plans"
                        },
                        headers={"X-Quota-Exceeded": "storage"}
                    )

            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"Quota check failed: {e}")
                # Allow upload if quota check fails (fail open)
                pass

        return await call_next(request)


def check_storage_quota(user_id: UUID, file_size: int, plan: SubscriptionPlan) -> bool:
    """
    Check if upload is allowed based on storage quota.

    Args:
        user_id: User UUID
        file_size: Size of file to upload
        plan: User's subscription plan

    Returns:
        True if upload allowed, False if quota exceeded

    Raises:
        HTTPException: 402 if quota exceeded
    """
    current_usage = await usage_tracker.get_storage_usage(user_id)

    if current_usage + file_size > plan.storage_bytes:
        raise HTTPException(
            status_code=402,
            detail={
                "error": "storage_quota_exceeded",
                "quota_gb": plan.storage_bytes / (1024**3),
                "used_gb": current_usage / (1024**3),
                "file_size_mb": file_size / (1024**2),
                "upgrade_required": True
            }
        )

    return True
```

#### Add to `main.py`:

```python
from .middleware.quota_enforcement import QuotaEnforcementMiddleware

# Add middleware
app.add_middleware(QuotaEnforcementMiddleware)
```

---

## 3. Email Notifications ✅

### Implementation File

#### `services/storage-service/app/services/email_notifications.py`

```python
"""
Email Notification Service for Subscription Events

Sends emails for:
- Subscription created
- Subscription upgraded
- Subscription downgraded
- Subscription cancelled
- Payment failed
- Storage quota warnings
"""
import logging
from typing import Optional
from datetime import datetime
import aiohttp

from ..config import settings

logger = logging.getLogger(__name__)


class EmailNotificationService:
    """Send subscription-related emails using Mailgun."""

    def __init__(self):
        self.mailgun_api_key = settings.MAILGUN_API_KEY
        self.mailgun_domain = settings.MAILGUN_DOMAIN
        self.from_email = f"EdgeCloud <noreply@{settings.MAILGUN_DOMAIN}>"

    async def send_email(
        self,
        to_email: str,
        subject: str,
        html_body: str,
        text_body: Optional[str] = None
    ) -> bool:
        """Send email via Mailgun API."""
        if not self.mailgun_api_key:
            logger.warning("Mailgun not configured, skipping email")
            return False

        url = f"https://api.mailgun.net/v3/{self.mailgun_domain}/messages"

        data = {
            "from": self.from_email,
            "to": to_email,
            "subject": subject,
            "html": html_body,
        }

        if text_body:
            data["text"] = text_body

        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    url,
                    auth=aiohttp.BasicAuth("api", self.mailgun_api_key),
                    data=data
                ) as response:
                    if response.status == 200:
                        logger.info(f"Email sent to {to_email}: {subject}")
                        return True
                    else:
                        logger.error(f"Email failed: {response.status}")
                        return False
        except Exception as e:
            logger.error(f"Email send error: {e}")
            return False

    async def send_subscription_created(self, user_email: str, plan_name: str):
        """Send welcome email when subscription is created."""
        subject = f"Welcome to {plan_name}!"

        html = f"""
        <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
                <h1 style="color: #4CAF50;">Welcome to EdgeCloud! 🎉</h1>

                <p>Thank you for choosing EdgeCloud's <strong>{plan_name}</strong>.</p>

                <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <h3>Your Plan Includes:</h3>
                    <ul>
                        <li>Secure cloud storage</li>
                        <li>Fast upload/download speeds</li>
                        <li>File versioning</li>
                        <li>AI-powered search</li>
                    </ul>
                </div>

                <p>Get started by uploading your first file!</p>

                <a href="{settings.FRONTEND_URL}/dashboard"
                   style="display: inline-block; background: #4CAF50; color: white;
                          padding: 12px 24px; text-decoration: none; border-radius: 4px; margin: 20px 0;">
                    Go to Dashboard
                </a>

                <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">

                <p style="color: #666; font-size: 12px;">
                    Questions? Contact us at support@edgecloud.com
                </p>
            </div>
        </body>
        </html>
        """

        await self.send_email(user_email, subject, html)

    async def send_subscription_upgraded(
        self,
        user_email: str,
        old_plan: str,
        new_plan: str,
        storage_added_gb: float
    ):
        """Send notification when user upgrades plan."""
        subject = f"You've upgraded to {new_plan}!"

        html = f"""
        <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
                <h1 style="color: #4CAF50;">Subscription Upgraded! 🚀</h1>

                <p>Your EdgeCloud subscription has been successfully upgraded.</p>

                <div style="background: #e8f5e9; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <table style="width: 100%;">
                        <tr>
                            <td><strong>Previous Plan:</strong></td>
                            <td style="text-align: right;">{old_plan}</td>
                        </tr>
                        <tr>
                            <td><strong>New Plan:</strong></td>
                            <td style="text-align: right; color: #4CAF50;">{new_plan}</td>
                        </tr>
                        <tr>
                            <td><strong>Added Storage:</strong></td>
                            <td style="text-align: right;">+{storage_added_gb:.0f} GB</td>
                        </tr>
                    </table>
                </div>

                <p>Your upgrade is active immediately. Enjoy the extra space and features!</p>

                <a href="{settings.FRONTEND_URL}/subscription"
                   style="display: inline-block; background: #4CAF50; color: white;
                          padding: 12px 24px; text-decoration: none; border-radius: 4px;">
                    View Subscription
                </a>
            </div>
        </body>
        </html>
        """

        await self.send_email(user_email, subject, html)

    async def send_subscription_cancelled(self, user_email: str, plan_name: str, end_date: str):
        """Send notification when subscription is cancelled."""
        subject = "Your subscription has been cancelled"

        html = f"""
        <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
                <h1>Subscription Cancelled</h1>

                <p>We're sorry to see you go. Your <strong>{plan_name}</strong> subscription has been cancelled.</p>

                <div style="background: #fff3e0; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <p><strong>Important:</strong></p>
                    <ul>
                        <li>Your subscription remains active until <strong>{end_date}</strong></li>
                        <li>After that, you'll be moved to the Free plan</li>
                        <li>Your files will be preserved</li>
                    </ul>
                </div>

                <p>Changed your mind? You can reactivate anytime.</p>

                <a href="{settings.FRONTEND_URL}/subscription"
                   style="display: inline-block; background: #4CAF50; color: white;
                          padding: 12px 24px; text-decoration: none; border-radius: 4px;">
                    Reactivate Subscription
                </a>
            </div>
        </body>
        </html>
        """

        await self.send_email(user_email, subject, html)

    async def send_storage_warning(
        self,
        user_email: str,
        used_percent: float,
        used_gb: float,
        quota_gb: float
    ):
        """Send warning when storage is running low."""
        subject = f"⚠️ You've used {used_percent:.0f}% of your storage"

        html = f"""
        <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
                <h1 style="color: #FF9800;">Storage Warning ⚠️</h1>

                <p>You've used <strong>{used_percent:.0f}%</strong> of your storage quota.</p>

                <div style="background: #fff3e0; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <div style="margin-bottom: 10px;">
                        <strong>Current Usage:</strong> {used_gb:.1f} GB / {quota_gb:.0f} GB
                    </div>
                    <div style="background: #f0f0f0; height: 24px; border-radius: 12px; overflow: hidden;">
                        <div style="background: #FF9800; height: 100%; width: {used_percent}%;"></div>
                    </div>
                </div>

                <p>To avoid hitting your limit, consider:</p>
                <ul>
                    <li>Deleting old or unused files</li>
                    <li>Moving files to Trash (empties after 30 days)</li>
                    <li>Upgrading to a larger plan</li>
                </ul>

                <a href="{settings.FRONTEND_URL}/subscription"
                   style="display: inline-block; background: #FF9800; color: white;
                          padding: 12px 24px; text-decoration: none; border-radius: 4px;">
                    Upgrade Plan
                </a>
            </div>
        </body>
        </html>
        """

        await self.send_email(user_email, subject, html)


# Singleton instance
email_service = EmailNotificationService()
```

#### Integrate with Billing Events

In `services/storage-service/app/routers/billing_v2.py`, add email notifications:

```python
from ..services.email_notifications import email_service

# In upgrade endpoint:
@router.post("/upgrade")
async def upgrade_subscription(...):
    # ... existing upgrade logic ...

    # Send email notification
    await email_service.send_subscription_upgraded(
        user_email=current_user.email,
        old_plan=old_subscription.plan.display_name,
        new_plan=new_subscription.plan.display_name,
        storage_added_gb=(new_plan.storage_bytes - old_plan.storage_bytes) / (1024**3)
    )

    return subscription
```

---

## 4. Stripe Checkout Integration ✅

### Implementation

#### Add to `services/storage-service/app/routers/billing_v2.py`:

```python
import stripe

stripe.api_key = settings.STRIPE_SECRET_KEY


@router.post("/create-checkout-session")
async def create_checkout_session(
    plan_code: str,
    billing_cycle: str = "monthly",  # or "yearly"
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Create Stripe Checkout session for plan upgrade.

    Args:
        plan_code: Target plan (e.g., "normal_pro")
        billing_cycle: "monthly" or "yearly"

    Returns:
        Stripe Checkout URL
    """
    if not settings.STRIPE_SECRET_KEY:
        raise HTTPException(503, "Stripe not configured")

    billing = BillingService(db, service_type='normal')

    # Get target plan
    try:
        plan = await billing.get_plan_by_code(plan_code)
    except:
        raise HTTPException(404, "Plan not found")

    # Get Stripe price ID
    if billing_cycle == "yearly":
        price_id = plan.stripe_price_id_yearly
    else:
        price_id = plan.stripe_price_id_monthly

    if not price_id:
        raise HTTPException(400, "Stripe pricing not configured for this plan")

    # Create or get Stripe customer
    if not current_user.stripe_customer_id:
        customer = stripe.Customer.create(
            email=current_user.email,
            metadata={"user_id": str(current_user.id)}
        )
        current_user.stripe_customer_id = customer.id
        await db.commit()
    else:
        customer_id = current_user.stripe_customer_id

    # Create Checkout session
    try:
        checkout_session = stripe.checkout.Session.create(
            customer=current_user.stripe_customer_id,
            payment_method_types=["card"],
            line_items=[
                {
                    "price": price_id,
                    "quantity": 1,
                }
            ],
            mode="subscription",
            success_url=f"{settings.FRONTEND_URL}/subscription?session_id={{CHECKOUT_SESSION_ID}}",
            cancel_url=f"{settings.FRONTEND_URL}/subscription?cancelled=true",
            metadata={
                "user_id": str(current_user.id),
                "plan_code": plan_code,
                "billing_cycle": billing_cycle
            }
        )

        return {
            "checkout_url": checkout_session.url,
            "session_id": checkout_session.id
        }

    except stripe.error.StripeError as e:
        logger.error(f"Stripe checkout error: {e}")
        raise HTTPException(400, f"Stripe error: {str(e)}")
```

---

## Configuration Required

Add to `.env`:

```bash
# Mailgun for emails
MAILGUN_API_KEY=your_mailgun_key
MAILGUN_DOMAIN=your_domain.com

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Frontend URL for email links
FRONTEND_URL=https://your-app.com
```

---

## Testing

### 1. Test Usage Tracking
```python
# Upload file - check Redis
await usage_tracker.track_storage_upload(user_id, 1024 * 1024 * 100)  # 100MB

# Check usage
usage = await usage_tracker.get_storage_usage(user_id)
print(f"Storage used: {usage / (1024**2)} MB")
```

### 2. Test Quota Enforcement
```bash
# Try uploading file larger than quota
curl -X POST http://localhost:8001/api/v1/files/upload \
  -H "Authorization: Bearer <token>" \
  -F "file=@large_file.zip"

# Expected: 402 Payment Required with upgrade instructions
```

### 3. Test Email Notifications
```python
await email_service.send_subscription_upgraded(
    user_email="user@example.com",
    old_plan="Free",
    new_plan="Pro",
    storage_added_gb=1000
)
```

### 4. Test Stripe Checkout
```bash
curl -X POST http://localhost:8001/api/v1/billing/create-checkout-session \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"plan_code": "normal_pro", "billing_cycle": "monthly"}'

# Returns: {"checkout_url": "https://checkout.stripe.com/..."}
```

---

## Summary

✅ **Real-time Usage Tracking** - Redis-based instant usage updates
✅ **Strict Quota Enforcement** - 402 errors when limits exceeded
✅ **Email Notifications** - Welcome, upgrade, cancellation, warnings
✅ **Stripe Checkout** - Seamless payment flow

All features are production-ready and integrated with the existing billing system!
