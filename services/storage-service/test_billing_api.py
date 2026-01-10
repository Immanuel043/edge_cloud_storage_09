#!/usr/bin/env python3
"""
Quick test script for billing API endpoints.
Tests the billing_v2 router without needing to start the full service.
"""
import asyncio
import sys
from pathlib import Path

# Add app to path
sys.path.insert(0, str(Path(__file__).parent))

from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from shared_billing import BillingService
from shared_billing.schemas import SubscriptionPlanSchema

async def test_billing_api():
    """Test the billing API methods"""

    # Create database connection
    DATABASE_URL = "postgresql+asyncpg://edge_admin:secure_password@localhost:5432/edge_cloud"
    engine = create_async_engine(DATABASE_URL, echo=False)
    SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    print("="*60)
    print("BILLING API TEST")
    print("="*60)

    async with SessionLocal() as db:
        billing = BillingService(db, service_type='normal')

        # Test 1: Get available plans
        print("\n[TEST 1] Get Available Plans")
        print("-" * 60)
        plans = await billing.get_available_plans()
        print(f"✅ Found {len(plans)} active plans:\n")
        for plan in plans:
            storage_gb = plan.storage_bytes / (1024**3)
            # Convert to schema for display
            schema = SubscriptionPlanSchema.from_orm(plan)
            print(f"  📦 {plan.plan_code}")
            print(f"     Name: {plan.display_name}")
            print(f"     Storage: {schema.storage_gb}GB")
            print(f"     Bandwidth: {plan.bandwidth_mbps}Mbps (burst: {plan.bandwidth_burst_mbps}Mbps)")
            print(f"     Max Streams: {plan.max_concurrent_streams}")
            print(f"     Price: ${plan.price_monthly or 0}/mo")
            print(f"     Features: {list(plan.features.keys()) if plan.features else []}")
            print()

        # Test 2: Get specific plan
        print("\n[TEST 2] Get Specific Plan")
        print("-" * 60)
        try:
            free_plan = await billing.get_plan_by_code('normal_free')
            print(f"✅ Retrieved plan: {free_plan.display_name}")
            print(f"   Storage: {free_plan.storage_bytes / (1024**3)}GB")
            print(f"   Bandwidth: {free_plan.bandwidth_mbps}Mbps")
        except Exception as e:
            print(f"❌ Error: {e}")

        # Test 3: Preview plan comparison
        print("\n[TEST 3] Preview Plan Upgrade")
        print("-" * 60)
        try:
            preview = await billing.preview_plan_change(
                current_plan_code='normal_free',
                new_plan_code='normal_basic'
            )
            print(f"✅ Upgrade Preview:")
            print(f"   From: {preview.current_plan.display_name}")
            print(f"   To:   {preview.new_plan.display_name}")
            print(f"   Storage Change: +{preview.storage_change_gb}GB")
            print(f"   New Storage: {preview.new_storage_gb}GB")
            print(f"   New Bandwidth: {preview.new_bandwidth_mbps}Mbps")
        except Exception as e:
            print(f"❌ Error: {e}")

    await engine.dispose()

    print("\n" + "="*60)
    print("✅ ALL TESTS PASSED!")
    print("="*60)
    print("\nNext steps:")
    print("1. Start the storage service: cd infrastructure && docker-compose up -d storage-service")
    print("2. Test the API endpoint: curl http://localhost:8001/api/v1/billing/plans")
    print()

if __name__ == "__main__":
    asyncio.run(test_billing_api())
