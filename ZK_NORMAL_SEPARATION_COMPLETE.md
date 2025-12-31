# ZK/Normal Storage Complete Separation

## Summary

Implemented full physical isolation between ZK Private Vault and Normal Storage services with completely separate:
- Databases
- User accounts  
- Authentication
- Billing/Subscriptions
- Plans and quotas

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         USER                                         │
└─────────────────────────────────────────────────────────────────────┘
           │                                    │
           │ app.yourservice.com                │ vault.yourservice.com
           ▼                                    ▼
┌─────────────────────────────┐    ┌─────────────────────────────┐
│    NORMAL STORAGE SERVICE   │    │   ZK PRIVATE VAULT SERVICE  │
├─────────────────────────────┤    ├─────────────────────────────┤
│ • Own user accounts         │    │ • Own user accounts         │
│ • Own authentication        │    │ • Own authentication        │
│ • Own Stripe billing        │    │ • Own Stripe billing        │
│ • Server-side encryption    │    │ • Client-side encryption    │
├─────────────────────────────┤    ├─────────────────────────────┤
│     PostgreSQL (storage_db) │    │     PostgreSQL (zk_db)      │
│     └── users               │    │     └── zk_users            │
│     └── objects             │    │     └── zk_objects          │
└─────────────────────────────┘    └─────────────────────────────┘
           │                                    │
           │ stripe_price_normal_*              │ stripe_price_zk_*
           ▼                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         STRIPE                                       │
│            (Two separate product lines)                              │
└─────────────────────────────────────────────────────────────────────┘
```

## Plan Structure

### Normal Storage Plans (app.yourservice.com)

| Plan | Storage | Bandwidth | Price |
|------|---------|-----------|-------|
| Free | 5 GB | 5 Mbps | $0 |
| Basic | 200 GB | 25 Mbps | $3.99/mo |
| Pro | 1 TB | 100 Mbps | $7.99/mo |
| Team | 5 TB | 500 Mbps | $19.99/mo |

### ZK Private Vault Plans (vault.yourservice.com)

| Plan | Storage | Price |
|------|---------|-------|
| Free | 1 GB | $0 |
| Personal | 50 GB | $4.99/mo |
| Professional | 200 GB | $9.99/mo |
| Enterprise | 1 TB | $29.99/mo |

## Files Changed

### Storage Service

1. **`services/storage-service/app/models/database.py`**
   - Removed: `zk_storage_quota`, `zk_storage_used`, `zk_enabled`
   - Removed: `encrypted_master_key`, `kdf_*` fields from User
   - Removed: `encrypted_file_key`, `file_key_iv` from Object
   - Added: `plan_type`, `stripe_customer_id`, `stripe_subscription_id`

2. **`services/storage-service/app/config.py`**
   - Updated PLAN_LIMITS to Normal-only plans (free, basic, pro, team)
   - Added Stripe configuration

3. **`services/storage-service/app/routers/auth.py`**
   - Changed `user_type` to `plan_type`
   - Removed ZK quota handling

4. **`services/storage-service/app/routers/upload.py`**
   - ZK uploads now rejected with redirect message to ZK service
   - Removed ZK-specific chunk handling

5. **`services/storage-service/app/routers/billing.py`** (NEW)
   - Stripe checkout session creation
   - Customer portal session
   - Webhook handlers for subscription events

### ZK Service

1. **`services/zk-encryption-service/app/models/database.py`**
   - New `ZKUser` model (separate from storage users)
   - New `ZKObject` model with encrypted file names
   - New `ZKFolder` model
   - New `ZKAuditLog` model

2. **`services/zk-encryption-service/app/config.py`**
   - New `ZK_DATABASE_URL` (separate database)
   - New `ZK_PLAN_LIMITS` (free, personal, professional, enterprise)
   - Stripe configuration for ZK billing

3. **`services/zk-encryption-service/app/routers/billing.py`** (NEW)
   - Independent Stripe integration for ZK subscriptions

### Migration

1. **`scripts/migrate_zk_to_separate_db.py`** (NEW)
   - Migrates ZK users from shared DB to separate ZK DB
   - Migrates ZK objects
   - Supports dry-run mode
   - Idempotent (safe to run multiple times)

## Deployment Steps

### 1. Start Infrastructure (with separate ZK database)
```bash
cd infrastructure
docker-compose up -d postgres zk-postgres redis
```

This starts:
- `postgres` - Storage service database (port 5432)
- `zk-postgres` - ZK service database (port 5433)
- `redis` - Shared cache

### 2. Run Storage Service Migrations
```bash
cd services/storage-service
alembic upgrade head
```

### 3. Run ZK Service Migrations
```bash
cd services/zk-encryption-service
alembic upgrade head
```

### 4. (Optional) Migrate Existing ZK Data
If you have existing ZK users in the old shared database:

```bash
# Dry run first
python scripts/migrate_zk_to_separate_db.py --dry-run \
    --source-db "postgresql://edge_admin:secure_password@localhost:5432/edge_cloud" \
    --target-db "postgresql://zk_admin:zk_secure_password@localhost:5433/zk_db"

# Execute migration
python scripts/migrate_zk_to_separate_db.py --execute \
    --source-db "postgresql://edge_admin:secure_password@localhost:5432/edge_cloud" \
    --target-db "postgresql://zk_admin:zk_secure_password@localhost:5433/zk_db"
```

### 5. Start All Services
```bash
cd infrastructure
docker-compose up -d
```

### 6. Configure Stripe Products

Create two separate product lines in Stripe:

**Normal Storage Products:**
- `price_normal_basic` - Basic ($3.99/mo)
- `price_normal_pro` - Pro ($7.99/mo)
- `price_normal_team` - Team ($19.99/mo)

**ZK Private Vault Products:**
- `price_zk_personal` - Personal ($4.99/mo)
- `price_zk_professional` - Professional ($9.99/mo)
- `price_zk_enterprise` - Enterprise ($29.99/mo)

### 7. Set Environment Variables

Add to your `.env` file:

```bash
# Storage Service Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# ZK Service Stripe (SEPARATE keys)
ZK_STRIPE_SECRET_KEY=sk_live_...
ZK_STRIPE_WEBHOOK_SECRET=whsec_...

# ZK Service Auth (SEPARATE from storage)
ZK_SECRET_KEY=your-zk-jwt-secret-here
```

### 8. Verify Separation

Test that services are isolated:

```bash
# Storage service should NOT have ZK tables
docker exec edge-postgres psql -U edge_admin -d edge_cloud \
    -c "SELECT column_name FROM information_schema.columns WHERE table_name='users';"

# ZK service should have zk_users table
docker exec edge-zk-postgres psql -U zk_admin -d zk_db \
    -c "SELECT * FROM zk_users LIMIT 1;"
```

## Key Benefits

1. **Complete Isolation** - ZK and Normal share nothing
2. **Independent Scaling** - Scale each service independently
3. **Separate Billing** - Users subscribe to each service separately
4. **Security** - Breach of one doesn't affect the other
5. **Compliance** - Clear audit boundaries
6. **Cost Clarity** - Users pay for what they use

## Environment Variables

### Storage Service
```env
DATABASE_URL=postgresql+asyncpg://edge_admin:password@storage-postgres:5432/storage_db
STRIPE_SECRET_KEY=sk_live_normal_...
STRIPE_WEBHOOK_SECRET=whsec_normal_...
```

### ZK Service
```env
ZK_DATABASE_URL=postgresql+asyncpg://zk_admin:password@zk-postgres:5432/zk_db
ZK_SECRET_KEY=your-zk-jwt-secret
ZK_STRIPE_SECRET_KEY=sk_live_zk_...
ZK_STRIPE_WEBHOOK_SECRET=whsec_zk_...
```

## User Experience

### Normal Storage Dashboard
```
┌─────────────────────────────────────────────────────┐
│  Pro Plan                                            │
├─────────────────────────────────────────────────────┤
│  📦 Storage        850 GB / 1 TB            [▓▓▓░░] │
│  📊 Bandwidth      100 Mbps                          │
├─────────────────────────────────────────────────────┤
│  $7.99/mo                    [Manage Subscription]   │
└─────────────────────────────────────────────────────┘
```

### ZK Private Vault Dashboard
```
┌─────────────────────────────────────────────────────┐
│  Personal Plan                                       │
├─────────────────────────────────────────────────────┤
│  🔐 Vault Storage   12 GB / 50 GB           [▓░░░░] │
├─────────────────────────────────────────────────────┤
│  $4.99/mo                    [Manage Subscription]   │
└─────────────────────────────────────────────────────┘
```

## No Cross-Service Communication

```
Storage Service ←✗→ ZK Service

They don't know about each other.
They don't share anything.
A user on one may or may not exist on the other.
Same email can register on both independently.
```

