# Webhook Idempotency Integration Guide

## Overview

This guide shows how to integrate the newly implemented webhook idempotency tracking into your Stripe and Razorpay webhook handlers.

## Prerequisites

✅ Database migration completed: `20260109_0003_create_webhook_events_table.py`
✅ WebhookIdempotencyService implemented
✅ shared-billing package installed

## Integration Steps

### 1. Update Webhook Handlers in billing_v2.py

#### Stripe Webhook Handler

**Location**: [services/storage-service/app/routers/billing_v2.py:881](services/storage-service/app/routers/billing_v2.py#L881)

Add this at the beginning of your Stripe webhook handler:

```python
from shared_billing import WebhookIdempotencyService
from datetime import datetime

@router.post("/webhook/stripe")
async def stripe_webhook(
    http_request: Request,
    db: AsyncSession = Depends(get_db)
):
    """Handle Stripe webhooks with idempotency protection."""

    # Apply rate limiting
    await apply_rate_limit(http_request, RateLimitConfig.WEBHOOK_STRIPE, "webhook_stripe")

    # Get request body and headers
    payload = await http_request.body()
    signature = http_request.headers.get("stripe-signature")
    client_ip = http_request.client.host

    # Initialize idempotency service
    idempotency = WebhookIdempotencyService(db)

    # Verify webhook signature (existing code)
    payment_service = PaymentService(gateway='stripe', ...)
    try:
        event = payment_service.stripe_service.verify_webhook_signature(
            payload=payload,
            signature=signature
        )
    except ValueError as e:
        logger.error(f"Stripe webhook signature verification failed: {e}")
        raise HTTPException(status_code=400, detail="Invalid signature")

    # Extract event details
    event_id = event['id']
    event_type = event['type']
    event_timestamp = datetime.fromtimestamp(event['created'])

    # 1. Check for duplicate event
    if await idempotency.is_duplicate_event(event_id, "stripe"):
        logger.info(f"Duplicate Stripe webhook event: {event_id}")
        return {"status": "already_processed", "event_id": event_id}

    # 2. Validate timestamp (replay protection)
    is_valid, error = idempotency.validate_timestamp(event_timestamp, max_age_seconds=300)
    if not is_valid:
        logger.warning(f"Stripe webhook timestamp validation failed: {error}")
        await idempotency.record_webhook_event(
            event_id=event_id,
            gateway="stripe",
            event_type=event_type,
            payload=event,
            ip_address=client_ip,
            status="failed",
            error_message=error
        )
        raise HTTPException(status_code=400, detail=error)

    # 3. Validate source IP (production only)
    if settings.ENVIRONMENT == "production":
        is_valid, error = idempotency.validate_source_ip(client_ip, "stripe", allow_local=False)
        if not is_valid:
            logger.warning(f"Stripe webhook IP validation failed: {error}")
            await idempotency.record_webhook_event(
                event_id=event_id,
                gateway="stripe",
                event_type=event_type,
                payload=event,
                ip_address=client_ip,
                status="failed",
                error_message=error
            )
            raise HTTPException(status_code=403, detail="Unauthorized IP address")

    # Process webhook (existing business logic)
    try:
        # Handle different event types
        if event_type == 'checkout.session.completed':
            # ... existing code ...
            pass
        elif event_type == 'customer.subscription.updated':
            # ... existing code ...
            pass
        elif event_type == 'customer.subscription.deleted':
            # ... existing code ...
            pass
        # ... other event types ...

        # Record successful processing
        await idempotency.record_webhook_event(
            event_id=event_id,
            gateway="stripe",
            event_type=event_type,
            payload=event,
            ip_address=client_ip,
            status="processed",
            error_message=None
        )

        return {"status": "success", "event_id": event_id}

    except Exception as e:
        logger.error(f"Error processing Stripe webhook: {e}", exc_info=True)

        # Record failed processing
        await idempotency.record_webhook_event(
            event_id=event_id,
            gateway="stripe",
            event_type=event_type,
            payload=event,
            ip_address=client_ip,
            status="failed",
            error_message=str(e)
        )

        raise HTTPException(status_code=500, detail=f"Webhook processing failed: {str(e)}")
```

#### Razorpay Webhook Handler

**Location**: [services/storage-service/app/routers/billing_v2.py:815](services/storage-service/app/routers/billing_v2.py#L815)

Add similar protection to Razorpay webhook:

```python
@router.post("/webhooks/razorpay")
async def razorpay_webhook(
    http_request: Request,
    db: AsyncSession = Depends(get_db)
):
    """Handle Razorpay webhooks with idempotency protection."""

    # Apply rate limiting
    await apply_rate_limit(http_request, RateLimitConfig.WEBHOOK_RAZORPAY, "webhook_razorpay")

    # Get request body and headers
    payload = await http_request.body()
    signature = http_request.headers.get("X-Razorpay-Signature")
    client_ip = http_request.client.host

    # Initialize idempotency service
    idempotency = WebhookIdempotencyService(db)

    # Parse webhook data
    webhook_data = await http_request.json()

    # Verify signature (existing code)
    payment_service = PaymentService(gateway='razorpay', ...)
    try:
        is_valid = payment_service.razorpay_service.verify_webhook_signature(
            payload=payload.decode('utf-8'),
            signature=signature
        )
        if not is_valid:
            raise ValueError("Invalid webhook signature")
    except ValueError as e:
        logger.error(f"Razorpay webhook signature verification failed: {e}")
        raise HTTPException(status_code=400, detail="Invalid signature")

    # Extract event details
    event_id = webhook_data.get('event')  # Razorpay event ID
    event_type = webhook_data.get('event', '').split('.')[0]  # e.g., 'payment' from 'payment.captured'
    event_timestamp = datetime.fromtimestamp(webhook_data.get('created_at', 0))

    # 1. Check for duplicate event
    if await idempotency.is_duplicate_event(event_id, "razorpay"):
        logger.info(f"Duplicate Razorpay webhook event: {event_id}")
        return {"status": "already_processed", "event_id": event_id}

    # 2. Validate timestamp
    is_valid, error = idempotency.validate_timestamp(event_timestamp, max_age_seconds=300)
    if not is_valid:
        logger.warning(f"Razorpay webhook timestamp validation failed: {error}")
        await idempotency.record_webhook_event(
            event_id=event_id,
            gateway="razorpay",
            event_type=event_type,
            payload=webhook_data,
            ip_address=client_ip,
            status="failed",
            error_message=error
        )
        raise HTTPException(status_code=400, detail=error)

    # 3. Validate source IP (production only)
    if settings.ENVIRONMENT == "production":
        is_valid, error = idempotency.validate_source_ip(client_ip, "razorpay", allow_local=False)
        if not is_valid:
            logger.warning(f"Razorpay webhook IP validation failed: {error}")
            await idempotency.record_webhook_event(
                event_id=event_id,
                gateway="razorpay",
                event_type=event_type,
                payload=webhook_data,
                ip_address=client_ip,
                status="failed",
                error_message=error
            )
            raise HTTPException(status_code=403, detail="Unauthorized IP address")

    # Process webhook (existing business logic)
    try:
        event_name = webhook_data.get('event')

        if event_name == 'payment.captured':
            # ... existing code ...
            pass
        elif event_name == 'subscription.charged':
            # ... existing code ...
            pass
        elif event_name == 'subscription.cancelled':
            # ... existing code ...
            pass
        # ... other event types ...

        # Record successful processing
        await idempotency.record_webhook_event(
            event_id=event_id,
            gateway="razorpay",
            event_type=event_type,
            payload=webhook_data,
            ip_address=client_ip,
            status="processed",
            error_message=None
        )

        return {"status": "success", "event_id": event_id}

    except Exception as e:
        logger.error(f"Error processing Razorpay webhook: {e}", exc_info=True)

        # Record failed processing
        await idempotency.record_webhook_event(
            event_id=event_id,
            gateway="razorpay",
            event_type=event_type,
            payload=webhook_data,
            ip_address=client_ip,
            status="failed",
            error_message=str(e)
        )

        raise HTTPException(status_code=500, detail=f"Webhook processing failed: {str(e)}")
```

### 2. Add Import Statements

At the top of [billing_v2.py](services/storage-service/app/routers/billing_v2.py), add:

```python
from shared_billing import WebhookIdempotencyService
from datetime import datetime
```

### 3. Update Environment Configuration

Add to [services/storage-service/app/config.py](services/storage-service/app/config.py):

```python
class Settings:
    # ... existing fields ...

    # Environment (for IP whitelist validation)
    ENVIRONMENT: str = os.getenv("ENVIRONMENT", "development")
```

### 4. Run Database Migration

```bash
cd services/storage-service
alembic upgrade head
```

This will create the `webhook_events` table.

### 5. Development vs Production Settings

#### Development (.env)
```bash
ENVIRONMENT=development
# IP validation disabled in development
```

#### Production (.env.production)
```bash
ENVIRONMENT=production
# IP validation ENABLED - only official Stripe/Razorpay IPs allowed
```

## Testing

### Test Duplicate Event Detection

```bash
# Send same webhook twice
curl -X POST http://localhost:8001/api/v1/billing/webhook/stripe \
  -H "Content-Type: application/json" \
  -H "stripe-signature: VALID_SIGNATURE" \
  -d '{"id": "evt_test123", "type": "checkout.session.completed", ...}'

# First call: processes normally
# Second call: returns {"status": "already_processed"}
```

### Test Timestamp Validation

```bash
# Send webhook with old timestamp (> 5 minutes ago)
curl -X POST http://localhost:8001/api/v1/billing/webhook/stripe \
  -H "Content-Type: application/json" \
  -H "stripe-signature: VALID_SIGNATURE" \
  -d '{"id": "evt_old", "type": "test", "created": 1234567890, ...}'

# Should return: 400 Bad Request - "Webhook timestamp too old"
```

### Test IP Whitelisting (Production Only)

```bash
# In production, webhooks from unauthorized IPs are rejected
# Set ENVIRONMENT=production and test from non-whitelisted IP
# Should return: 403 Forbidden - "Unauthorized IP address"
```

### Check Webhook History

Query the database to see all processed webhooks:

```sql
SELECT
    event_id,
    gateway,
    event_type,
    status,
    ip_address,
    processed_at,
    error_message
FROM webhook_events
ORDER BY processed_at DESC
LIMIT 20;
```

Or use the service:

```python
from shared_billing import WebhookIdempotencyService

idempotency = WebhookIdempotencyService(db)
history = await idempotency.get_webhook_history(gateway="stripe", limit=50)
```

## Monitoring

### Key Metrics to Track

1. **Duplicate Event Rate**:
   ```sql
   SELECT COUNT(*) as duplicate_count
   FROM webhook_events
   WHERE event_id IN (
       SELECT event_id FROM webhook_events
       GROUP BY event_id HAVING COUNT(*) > 1
   );
   ```

2. **Failed Webhooks**:
   ```sql
   SELECT gateway, event_type, COUNT(*) as failures
   FROM webhook_events
   WHERE status = 'failed'
   GROUP BY gateway, event_type
   ORDER BY failures DESC;
   ```

3. **IP Violations** (if tracking in logs):
   - Search logs for "Webhook from unauthorized IP"
   - Alert on multiple violations from same IP

4. **Timestamp Violations**:
   ```sql
   SELECT COUNT(*) as replay_attempts
   FROM webhook_events
   WHERE error_message LIKE '%timestamp too old%';
   ```

## Maintenance

### Cleanup Old Events

Run periodically (e.g., weekly cron job):

```python
from shared_billing import WebhookIdempotencyService

async def cleanup_webhooks():
    idempotency = WebhookIdempotencyService(db)
    deleted_count = await idempotency.cleanup_old_events(days_to_keep=90)
    logger.info(f"Cleaned up {deleted_count} old webhook events")
```

Or via SQL:

```sql
DELETE FROM webhook_events
WHERE processed_at < NOW() - INTERVAL '90 days';
```

## Security Considerations

1. **Rate Limiting**: Already applied via `RateLimitConfig.WEBHOOK_STRIPE` and `RateLimitConfig.WEBHOOK_RAZORPAY`

2. **IP Whitelisting**:
   - Development: Disabled (allow localhost)
   - Production: Enabled (only official IPs)
   - Update IP whitelist if payment providers change IPs

3. **Signature Verification**: Always required, service won't start without webhook secrets

4. **Timestamp Validation**: Prevents replay attacks (5-minute window)

5. **Audit Trail**: All webhook attempts logged for compliance

## Troubleshooting

### Issue: "Webhook timestamp too old"

**Cause**: Server time drift or webhook delivery delay

**Solution**:
```bash
# Check server time
date -u

# Sync with NTP
sudo ntpdate -s time.nist.gov

# Or adjust max_age_seconds if needed
is_valid, error = idempotency.validate_timestamp(
    event_timestamp,
    max_age_seconds=600  # Allow 10 minutes instead of 5
)
```

### Issue: "Unauthorized IP address"

**Cause**: Webhook sent from IP not in whitelist

**Solution**:
1. Check if payment provider updated their IPs
2. Update `WEBHOOK_IP_WHITELIST` in `webhook_idempotency.py`
3. For development, ensure `ENVIRONMENT=development` in `.env`

### Issue: Database lock on webhook_events

**Cause**: High concurrent webhook volume

**Solution**:
- Index on `event_id` already created
- Consider partitioning table by `processed_at` for high volume
- Monitor query performance

## Next Steps

1. ✅ Integrate idempotency checks into webhook handlers (follow this guide)
2. ✅ Run database migration
3. ✅ Test in development environment
4. ✅ Deploy to staging and test with actual webhooks
5. ✅ Monitor webhook_events table growth
6. ✅ Set up automated cleanup job
7. ✅ Configure alerts for high failure rates

---

**Implementation Status**: Infrastructure ready, integration required
**Estimated Integration Time**: 30-45 minutes per webhook handler
**Testing Time**: 1-2 hours
**Production Ready**: After integration and testing
