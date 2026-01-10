# Shared Billing Library

Unified subscription management system for Edge Cloud Storage (Normal Storage + ZK Encryption).

## Features

- **Database-driven plans**: No more hardcoded PLAN_LIMITS
- **Flexible subscription management**: Create, upgrade, downgrade, cancel
- **Audit trail**: Complete subscription history tracking
- **Future-ready**: Prepared for Stripe integration (Phase-2)
- **Polymorphic design**: Supports both Normal Storage and ZK Encryption users

## Installation

```bash
# Install dependencies
pip install sqlalchemy asyncpg pydantic

# The library is a local package, add to your service requirements
# In services/storage-service/requirements.txt:
# -e ../shared-billing
```

## Usage

### Basic Example

```python
from sqlalchemy.ext.asyncio import AsyncSession
from shared_billing import BillingService

# Initialize service
billing = BillingService(db, service_type='normal')

# Get available plans
plans = await billing.get_available_plans()

# Create subscription
subscription = await billing.create_subscription(
    user_id=user_id,
    plan_code='normal_basic',
    billing_cycle='monthly'
)

# Upgrade subscription
subscription = await billing.upgrade_subscription(
    user_id=user_id,
    new_plan_code='normal_pro'
)

# Get subscription
subscription = await billing.get_user_subscription(user_id)
print(f"Plan: {subscription.plan.display_name}")
print(f"Storage: {subscription.plan.storage_bytes / (1024**3)}GB")
```

## Database Schema

### subscription_plans
Stores plan definitions (unified for Normal + ZK services).

| Column | Type | Description |
|--------|------|-------------|
| plan_code | VARCHAR(50) | Unique code: 'normal_free', 'zk_personal' |
| service_type | VARCHAR(20) | 'normal' or 'zk' |
| tier_name | VARCHAR(50) | 'free', 'basic', 'pro', etc. |
| storage_bytes | BIGINT | Storage quota |
| bandwidth_mbps | INTEGER | Bandwidth limit |
| features | JSONB | Feature flags |

### user_subscriptions
Tracks user subscriptions (polymorphic user reference).

| Column | Type | Description |
|--------|------|-------------|
| user_id | UUID | Reference to users or zk_users |
| service_type | VARCHAR(20) | 'normal' or 'zk' |
| plan_id | UUID | FK to subscription_plans |
| status | VARCHAR(20) | 'active', 'pending_payment', 'cancelled' |
| stripe_subscription_id | VARCHAR(255) | Stripe ID (Phase-2) |

### subscription_history
Audit trail of all subscription changes.

## API Endpoints (via billing_v2.py)

### Plan Catalog
- `GET /api/v1/billing/plans` - List all available plans
- `GET /api/v1/billing/plans/{plan_code}` - Get plan details

### Subscription Management
- `GET /api/v1/billing/subscription` - Get current subscription
- `POST /api/v1/billing/subscribe` - Create subscription
- `POST /api/v1/billing/preview-change` - Preview plan change
- `POST /api/v1/billing/upgrade` - Upgrade to higher tier
- `POST /api/v1/billing/downgrade` - Downgrade to lower tier
- `POST /api/v1/billing/cancel` - Cancel subscription

### Usage & Analytics
- `GET /api/v1/billing/usage` - Get usage statistics
- `GET /api/v1/billing/recommendations` - Get upgrade recommendations
- `GET /api/v1/billing/history` - Get subscription history

## Testing

```bash
# Run migrations
cd services/storage-service
alembic upgrade head

# Test plan queries
python -c "
import asyncio
from app.database import AsyncSessionLocal
from shared_billing import BillingService

async def test():
    async with AsyncSessionLocal() as db:
        billing = BillingService(db, 'normal')
        plans = await billing.get_available_plans()
        for plan in plans:
            print(f'{plan.plan_code}: {plan.display_name}')

asyncio.run(test())
"
```

## Architecture

```
services/
├── shared-billing/              # This library
│   ├── models.py                # SQLAlchemy models
│   ├── service.py               # BillingService
│   ├── schemas.py               # Pydantic schemas
│   └── exceptions.py            # Custom exceptions
│
├── storage-service/
│   └── app/
│       ├── routers/
│       │   └── billing_v2.py    # API endpoints (uses this library)
│       └── dependencies.py      # get_user_subscription() helper
│
└── zk-encryption-service/
    └── app/
        └── routers/
            └── billing_v2.py    # Same endpoints, service_type='zk'
```

## Future Enhancements (Phase-2)

- [ ] Stripe payment integration
- [ ] Proration calculations
- [ ] Invoice management
- [ ] Team/multi-user plans
- [ ] Usage-based pricing
- [ ] Regional pricing
- [ ] Discount codes/promotions

## License

Proprietary - Edge Cloud Storage MVP
