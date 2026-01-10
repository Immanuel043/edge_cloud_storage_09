#!/usr/bin/env python3
"""
Script to retrieve all subscription plans from both Normal Storage and ZK databases.

This script connects to both databases and retrieves:
1. Normal Storage plans from subscription_plans table (service_type = 'normal')
2. ZK plans from subscription_plans table (service_type = 'zk') or subscription_tiers table
"""
import asyncio
import os
import sys
from typing import List, Dict, Any
import json
from decimal import Decimal

# Add services to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'services'))

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker


# Database connection strings (defaults from docker-compose)
NORMAL_DB_URL = os.getenv(
    "NORMAL_DATABASE_URL",
    "postgresql+asyncpg://edge_admin:secure_password@localhost:5432/edge_cloud"
)

ZK_DB_URL = os.getenv(
    "ZK_DATABASE_URL", 
    "postgresql+asyncpg://zk_admin:zk_secure_password@localhost:5432/zk_db"
)


class DecimalEncoder(json.JSONEncoder):
    """Custom JSON encoder for Decimal types."""
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


async def get_normal_plans(db: AsyncSession) -> List[Dict[str, Any]]:
    """Get all Normal Storage plans from subscription_plans table."""
    try:
        # Query subscription_plans table for normal service type
        query = text("""
            SELECT 
                id,
                plan_code,
                service_type,
                tier_name,
                display_name,
                description,
                price_monthly,
                price_yearly,
                storage_bytes,
                bandwidth_mbps,
                bandwidth_burst_mbps,
                max_concurrent_streams,
                features,
                is_active,
                is_default,
                sort_order,
                created_at,
                updated_at
            FROM subscription_plans
            WHERE service_type = 'normal'
            ORDER BY sort_order, tier_name
        """)
        
        result = await db.execute(query)
        rows = result.fetchall()
        
        plans = []
        for row in rows:
            plan = {
                'id': str(row[0]),
                'plan_code': row[1],
                'service_type': row[2],
                'tier_name': row[3],
                'display_name': row[4],
                'description': row[5],
                'price_monthly': float(row[6]) if row[6] else None,
                'price_yearly': float(row[7]) if row[7] else None,
                'storage_bytes': int(row[8]) if row[8] else 0,
                'storage_gb': round(int(row[8]) / (1024**3), 2) if row[8] else 0,
                'bandwidth_mbps': int(row[9]) if row[9] else None,
                'bandwidth_burst_mbps': int(row[10]) if row[10] else None,
                'max_concurrent_streams': int(row[11]) if row[11] else None,
                'features': dict(row[12]) if row[12] else {},
                'is_active': bool(row[13]),
                'is_default': bool(row[14]),
                'sort_order': int(row[15]) if row[15] else 0,
                'created_at': row[16].isoformat() if row[16] else None,
                'updated_at': row[17].isoformat() if row[17] else None,
            }
            plans.append(plan)
        
        return plans
    except Exception as e:
        print(f"Error querying normal plans: {e}", file=sys.stderr)
        # Table might not exist, try to check
        try:
            check_query = text("SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'subscription_plans')")
            exists = await db.execute(check_query)
            if not exists.scalar():
                print("Table 'subscription_plans' does not exist in normal database", file=sys.stderr)
        except:
            pass
        return []


async def get_zk_plans_unified(db: AsyncSession) -> List[Dict[str, Any]]:
    """Get ZK plans from unified subscription_plans table."""
    try:
        query = text("""
            SELECT 
                id,
                plan_code,
                service_type,
                tier_name,
                display_name,
                description,
                price_monthly,
                price_yearly,
                storage_bytes,
                bandwidth_mbps,
                bandwidth_burst_mbps,
                max_concurrent_streams,
                features,
                is_active,
                is_default,
                sort_order,
                created_at,
                updated_at
            FROM subscription_plans
            WHERE service_type = 'zk'
            ORDER BY sort_order, tier_name
        """)
        
        result = await db.execute(query)
        rows = result.fetchall()
        
        plans = []
        for row in rows:
            plan = {
                'id': str(row[0]),
                'plan_code': row[1],
                'service_type': row[2],
                'tier_name': row[3],
                'display_name': row[4],
                'description': row[5],
                'price_monthly': float(row[6]) if row[6] else None,
                'price_yearly': float(row[7]) if row[7] else None,
                'storage_bytes': int(row[8]) if row[8] else 0,
                'storage_gb': round(int(row[8]) / (1024**3), 2) if row[8] else 0,
                'bandwidth_mbps': int(row[9]) if row[9] else None,
                'bandwidth_burst_mbps': int(row[10]) if row[10] else None,
                'max_concurrent_streams': int(row[11]) if row[11] else None,
                'features': dict(row[12]) if row[12] else {},
                'is_active': bool(row[13]),
                'is_default': bool(row[14]),
                'sort_order': int(row[15]) if row[15] else 0,
                'created_at': row[16].isoformat() if row[16] else None,
                'updated_at': row[17].isoformat() if row[17] else None,
            }
            plans.append(plan)
        
        return plans
    except Exception as e:
        print(f"Error querying unified ZK plans: {e}", file=sys.stderr)
        return []


async def get_zk_plans_legacy(db: AsyncSession) -> List[Dict[str, Any]]:
    """Get ZK plans from legacy subscription_tiers table."""
    try:
        query = text("""
            SELECT 
                id,
                name,
                display_name,
                price_monthly,
                price_yearly,
                storage_quota_bytes,
                features,
                is_active,
                sort_order,
                created_at,
                updated_at
            FROM subscription_tiers
            ORDER BY sort_order, name
        """)
        
        result = await db.execute(query)
        rows = result.fetchall()
        
        plans = []
        for row in rows:
            storage_bytes = int(row[5]) if row[5] else 0
            plan = {
                'id': str(row[0]),
                'plan_code': f'zk_{row[1]}',  # Construct plan code
                'service_type': 'zk',
                'tier_name': row[1],
                'display_name': row[2],
                'description': None,
                'price_monthly': float(row[3]) if row[3] else None,
                'price_yearly': float(row[4]) if row[4] else None,
                'storage_bytes': storage_bytes,
                'storage_gb': round(storage_bytes / (1024**3), 2) if storage_bytes > 0 else 0,
                'bandwidth_mbps': None,
                'bandwidth_burst_mbps': None,
                'max_concurrent_streams': None,
                'features': dict(row[6]) if row[6] else {},
                'is_active': bool(row[7]),
                'is_default': False,
                'sort_order': int(row[8]) if row[8] else 0,
                'created_at': row[9].isoformat() if row[9] else None,
                'updated_at': row[10].isoformat() if row[10] else None,
            }
            plans.append(plan)
        
        return plans
    except Exception as e:
        print(f"Error querying legacy ZK plans: {e}", file=sys.stderr)
        return []


async def main():
    """Main function to retrieve all plans."""
    output_format = os.getenv('OUTPUT_FORMAT', 'json')  # json or table
    
    # Connect to Normal Storage database
    print("Connecting to Normal Storage database...", file=sys.stderr)
    normal_engine = create_async_engine(NORMAL_DB_URL, echo=False)
    normal_session = async_sessionmaker(normal_engine, class_=AsyncSession, expire_on_commit=False)
    
    # Connect to ZK database
    print("Connecting to ZK database...", file=sys.stderr)
    zk_engine = create_async_engine(ZK_DB_URL, echo=False)
    zk_session = async_sessionmaker(zk_engine, class_=AsyncSession, expire_on_commit=False)
    
    try:
        async with normal_session() as normal_db:
            normal_plans = await get_normal_plans(normal_db)
        
        async with zk_session() as zk_db:
            # Try unified subscription_plans table first
            zk_plans = await get_zk_plans_unified(zk_db)
            
            # If no plans found, try legacy subscription_tiers table
            if not zk_plans:
                print("No ZK plans in subscription_plans, trying subscription_tiers...", file=sys.stderr)
                zk_plans = await get_zk_plans_legacy(zk_db)
            
            # Also check if subscription_plans exists in normal DB for ZK plans
            if not zk_plans:
                print("Checking normal DB for ZK plans...", file=sys.stderr)
                async with normal_session() as normal_db:
                    zk_plans = await get_zk_plans_unified(normal_db)
        
        # Combine results
        result = {
            'normal_plans': normal_plans,
            'zk_plans': zk_plans,
            'summary': {
                'total_normal_plans': len(normal_plans),
                'total_zk_plans': len(zk_plans),
                'normal_active_plans': len([p for p in normal_plans if p['is_active']]),
                'zk_active_plans': len([p for p in zk_plans if p['is_active']]),
            }
        }
        
        # Output results
        if output_format == 'json':
            print(json.dumps(result, indent=2, cls=DecimalEncoder))
        else:
            # Table format
            print("\n" + "="*80)
            print("NORMAL STORAGE PLANS")
            print("="*80)
            if normal_plans:
                for plan in normal_plans:
                    status = "✓ ACTIVE" if plan['is_active'] else "✗ INACTIVE"
                    default = " [DEFAULT]" if plan['is_default'] else ""
                    print(f"\n{plan['display_name']} ({plan['plan_code']}) {status}{default}")
                    print(f"  Tier: {plan['tier_name']}")
                    print(f"  Storage: {plan['storage_gb']} GB ({plan['storage_bytes']:,} bytes)")
                    if plan['price_monthly']:
                        print(f"  Price: ${plan['price_monthly']}/month, ${plan['price_yearly']}/year")
                    if plan['bandwidth_mbps']:
                        print(f"  Bandwidth: {plan['bandwidth_mbps']} Mbps (burst: {plan['bandwidth_burst_mbps']} Mbps)")
                    if plan['max_concurrent_streams']:
                        print(f"  Max Concurrent Streams: {plan['max_concurrent_streams']}")
                    if plan['features']:
                        print(f"  Features: {', '.join(plan['features'].keys())}")
            else:
                print("  No plans found")
            
            print("\n" + "="*80)
            print("ZK ENCRYPTION PLANS")
            print("="*80)
            if zk_plans:
                for plan in zk_plans:
                    status = "✓ ACTIVE" if plan['is_active'] else "✗ INACTIVE"
                    default = " [DEFAULT]" if plan['is_default'] else ""
                    print(f"\n{plan['display_name']} ({plan['plan_code']}) {status}{default}")
                    print(f"  Tier: {plan['tier_name']}")
                    print(f"  Storage: {plan['storage_gb']} GB ({plan['storage_bytes']:,} bytes)")
                    if plan['price_monthly']:
                        print(f"  Price: ${plan['price_monthly']}/month, ${plan['price_yearly']}/year")
                    if plan['bandwidth_mbps']:
                        print(f"  Bandwidth: {plan['bandwidth_mbps']} Mbps (burst: {plan['bandwidth_burst_mbps']} Mbps)")
                    if plan['max_concurrent_streams']:
                        print(f"  Max Concurrent Streams: {plan['max_concurrent_streams']}")
                    if plan['features']:
                        print(f"  Features: {', '.join(plan['features'].keys())}")
            else:
                print("  No plans found")
            
            print("\n" + "="*80)
            print("SUMMARY")
            print("="*80)
            print(f"Normal Plans: {result['summary']['total_normal_plans']} total, {result['summary']['normal_active_plans']} active")
            print(f"ZK Plans: {result['summary']['total_zk_plans']} total, {result['summary']['zk_active_plans']} active")
        
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        await normal_engine.dispose()
        await zk_engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
