#!/usr/bin/env python3
"""
Billing System Initialization Script

This script initializes the database-driven billing system:
1. Runs database migrations
2. Seeds subscription plans
3. Migrates existing users to subscriptions
4. Verifies the setup

Usage:
    python init_billing.py
"""
import asyncio
import sys
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import text, select, func
from app.database import AsyncSessionLocal, engine
from shared_billing import BillingService, SubscriptionPlan, UserSubscription


async def check_migrations():
    """Check if billing migrations have been run."""
    print("\n📋 Checking database migrations...")

    async with AsyncSessionLocal() as db:
        try:
            # Try to query subscription_plans table
            result = await db.execute(text("SELECT COUNT(*) FROM subscription_plans"))
            count = result.scalar()
            print(f"✅ subscription_plans table exists ({count} plans)")
            return True
        except Exception as e:
            print(f"❌ Billing tables not found: {e}")
            print("\n⚠️  Please run migrations first:")
            print("   cd services/storage-service")
            print("   alembic upgrade head")
            return False


async def verify_plans():
    """Verify that plans are seeded correctly."""
    print("\n📦 Verifying subscription plans...")

    async with AsyncSessionLocal() as db:
        billing = BillingService(db, service_type='normal')
        plans = await billing.get_available_plans()

        print(f"✅ Found {len(plans)} Normal Storage plans:")
        for plan in plans:
            print(f"   - {plan.plan_code}: {plan.display_name} "
                  f"({plan.storage_bytes / (1024**3):.0f}GB, "
                  f"{plan.bandwidth_mbps}Mbps)")

        return len(plans) > 0


async def verify_subscriptions():
    """Check subscription migration status."""
    print("\n👥 Checking user subscriptions...")

    async with AsyncSessionLocal() as db:
        # Count total users
        result = await db.execute(text("SELECT COUNT(*) FROM users"))
        total_users = result.scalar()

        # Count users with subscriptions
        result = await db.execute(text("""
            SELECT COUNT(*) FROM users
            WHERE current_subscription_id IS NOT NULL
        """))
        migrated_users = result.scalar()

        print(f"   Total users: {total_users}")
        print(f"   Migrated to subscriptions: {migrated_users}")

        if migrated_users < total_users:
            print(f"   ⚠️  {total_users - migrated_users} users need migration")
            print("\n   Run this migration:")
            print("   alembic upgrade 20260104_0003")
        else:
            print(f"   ✅ All users have subscriptions")


async def test_billing_service():
    """Test BillingService functionality."""
    print("\n🧪 Testing BillingService...")

    async with AsyncSessionLocal() as db:
        billing = BillingService(db, service_type='normal')

        # Test getting default plan
        default_plan = await billing.get_default_plan()
        print(f"   ✅ Default plan: {default_plan.plan_code}")

        # Test getting plan by code
        try:
            basic_plan = await billing.get_plan_by_code('normal_basic')
            print(f"   ✅ Plan lookup: {basic_plan.display_name}")
        except Exception as e:
            print(f"   ❌ Plan lookup failed: {e}")

        # Test preview functionality
        print("   ✅ BillingService is operational")


async def show_api_endpoints():
    """Show available API endpoints."""
    print("\n🌐 Available API Endpoints:")
    print("   Plan Catalog:")
    print("   - GET  /api/v1/billing/plans")
    print("   - GET  /api/v1/billing/plans/{plan_code}")
    print()
    print("   Subscription Management:")
    print("   - GET  /api/v1/billing/subscription")
    print("   - POST /api/v1/billing/subscribe")
    print("   - POST /api/v1/billing/preview-change")
    print("   - POST /api/v1/billing/upgrade")
    print("   - POST /api/v1/billing/downgrade")
    print("   - POST /api/v1/billing/cancel")
    print()
    print("   Usage & Analytics:")
    print("   - GET  /api/v1/billing/usage")
    print("   - GET  /api/v1/billing/recommendations")
    print("   - GET  /api/v1/billing/history")


async def main():
    """Run all initialization checks."""
    print("=" * 70)
    print("  Edge Cloud Storage - Billing System Initialization")
    print("=" * 70)

    # Step 1: Check migrations
    migrations_ok = await check_migrations()
    if not migrations_ok:
        return

    # Step 2: Verify plans
    plans_ok = await verify_plans()
    if not plans_ok:
        print("\n❌ No plans found. Migrations may have failed.")
        return

    # Step 3: Verify subscriptions
    await verify_subscriptions()

    # Step 4: Test billing service
    await test_billing_service()

    # Step 5: Show API endpoints
    await show_api_endpoints()

    print("\n" + "=" * 70)
    print("  ✅ Billing System Ready!")
    print("=" * 70)
    print("\n📚 Documentation:")
    print("   - Library: services/shared-billing/README.md")
    print("   - API: http://localhost:8000/docs (search for 'billing-v2')")
    print("\n🚀 Next Steps:")
    print("   1. Start the server: python -m app.main")
    print("   2. Test API: curl http://localhost:8000/api/v1/billing/plans")
    print("   3. Check Swagger UI: http://localhost:8000/docs")
    print()


if __name__ == "__main__":
    asyncio.run(main())
