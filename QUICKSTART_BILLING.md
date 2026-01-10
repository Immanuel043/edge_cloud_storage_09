# 🚀 Billing System - 5 Minute Quick Start

## Prerequisites
- PostgreSQL database running
- Python 3.9+
- Edge Cloud Storage codebase

## Step 1: Run Migrations (2 minutes)

```bash
cd services/storage-service

# Run migrations to create tables and seed plans
alembic upgrade head
```

Expected: 3 new migrations executed
- ✅ Created subscription_plans, user_subscriptions, subscription_history tables
- ✅ Seeded 4 Normal Storage plans
- ✅ Migrated existing users to subscriptions

## Step 2: Verify Setup (1 minute)

```bash
# Run verification script
python init_billing.py
```

Expected output:
```
✅ subscription_plans table exists (4 plans)
✅ Found 4 Normal Storage plans:
   - normal_free: Free Storage (5GB, 5Mbps)
   - normal_basic: Basic Storage (200GB, 25Mbps)
   - normal_pro: Pro Storage (1TB, 100Mbps)
   - normal_team: Team Storage (5TB, 500Mbps)
✅ All users have subscriptions
✅ BillingService is operational
✅ Billing System Ready!
```

## Step 3: Start the Server (1 minute)

```bash
# From services/storage-service
uvicorn app.main:app --reload --port 8000
```

## Step 4: Test the API (1 minute)

### Option A: Browser (Swagger UI)
1. Open: http://localhost:8000/docs
2. Search for "billing-v2"
3. Try "GET /api/v1/billing/plans"

### Option B: cURL

```bash
# Get all available plans (no auth required)
curl http://localhost:8000/api/v1/billing/plans

# Get your subscription (requires auth token)
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     http://localhost:8000/api/v1/billing/subscription

# Get usage stats
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     http://localhost:8000/api/v1/billing/usage
```

## That's It! 🎉

Your billing system is now running with:
- ✅ 4 subscription plans (database-driven)
- ✅ 15 API endpoints
- ✅ All existing users migrated
- ✅ Complete audit trail
- ✅ Ready for Stripe integration (Phase-2)

## What You Can Do Now

### 1. View All Plans
```bash
GET /api/v1/billing/plans
```

### 2. Check Your Subscription
```bash
GET /api/v1/billing/subscription
```

### 3. Upgrade/Downgrade
```bash
POST /api/v1/billing/upgrade
Body: {"new_plan_code": "normal_pro"}
```

### 4. View History
```bash
GET /api/v1/billing/history
```

## Common Issues

### "Billing tables not found"
→ Run migrations: `alembic upgrade head`

### "No plans found"
→ Migration seed failed. Check migration logs.

### "No subscription found"
→ User migration didn't run. Run: `alembic upgrade 20260104_0003`

## Next Steps

1. **Test thoroughly**: Try all endpoints in Swagger UI
2. **Integrate**: Use `get_user_subscription()` dependency in your endpoints
3. **Customize**: Update plan quotas/pricing in database
4. **Frontend**: Add plan selection UI (optional)
5. **Phase-2**: Integrate Stripe for real payments

## Documentation

- Full implementation: `BILLING_IMPLEMENTATION.md`
- Library docs: `services/shared-billing/README.md`
- API docs: http://localhost:8000/docs

## Support

Questions? Check these files:
1. `BILLING_IMPLEMENTATION.md` - Complete implementation details
2. `services/shared-billing/README.md` - Library documentation
3. `init_billing.py` - Run to verify setup

---

**Time to Production**: ✅ 5 minutes  
**Lines of Code**: ~2,500  
**API Endpoints**: 15  
**Database Tables**: 3

*You're ready to go!* 🚀
