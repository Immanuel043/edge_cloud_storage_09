"""Create subscription tables for unified billing system

This migration creates the subscription management tables:
1. subscription_plans - Plan definitions (unified for Normal + ZK)
2. user_subscriptions - User subscription tracking
3. subscription_history - Audit trail of subscription changes

Revision ID: create_subscription_tables
Revises: separate_zk_cleanup
Create Date: 2026-01-04
"""

from datetime import datetime

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers
revision = "create_subscription_tables"
down_revision = "add_email_verification_fields"
branch_labels = None
depends_on = None


def upgrade():
    # =========================================================================
    # 1. CREATE subscription_plans TABLE (idempotent)
    # =========================================================================

    op.execute("""
        CREATE TABLE IF NOT EXISTS subscription_plans (
            id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
            plan_code VARCHAR(50) NOT NULL UNIQUE,
            service_type VARCHAR(20) NOT NULL,
            tier_name VARCHAR(50) NOT NULL,
            display_name VARCHAR(100) NOT NULL,
            description TEXT,
            price_monthly NUMERIC(10, 2),
            price_yearly NUMERIC(10, 2),
            stripe_price_id_monthly VARCHAR(255),
            stripe_price_id_yearly VARCHAR(255),
            currency VARCHAR(3) DEFAULT 'USD',
            storage_bytes BIGINT NOT NULL,
            bandwidth_mbps INTEGER NOT NULL,
            bandwidth_burst_mbps INTEGER NOT NULL,
            max_concurrent_streams INTEGER NOT NULL,
            features JSONB DEFAULT '{}',
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            is_default BOOLEAN NOT NULL DEFAULT FALSE,
            sort_order INTEGER DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT now(),
            updated_at TIMESTAMPTZ,
            CONSTRAINT valid_storage_quota CHECK (storage_bytes > 0 OR storage_bytes = -1),
            CONSTRAINT unique_service_tier UNIQUE (service_type, tier_name)
        )
    """)

    # Add any missing columns if table existed with old schema
    op.execute(
        "ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS stripe_price_id_monthly VARCHAR(255)"
    )
    op.execute(
        "ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS stripe_price_id_yearly VARCHAR(255)"
    )
    op.execute(
        "ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'USD'"
    )
    op.execute(
        "ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE"
    )
    op.execute(
        "ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0"
    )

    # Indexes for subscription_plans (idempotent)
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_plans_service_active ON subscription_plans(service_type, is_active)"
    )
    op.execute("CREATE INDEX IF NOT EXISTS idx_plans_code ON subscription_plans(plan_code)")

    # =========================================================================
    # 2. CREATE user_subscriptions TABLE (idempotent)
    # =========================================================================

    op.execute("""
        CREATE TABLE IF NOT EXISTS user_subscriptions (
            id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
            user_id UUID NOT NULL,
            service_type VARCHAR(20) NOT NULL,
            plan_id UUID NOT NULL REFERENCES subscription_plans(id),
            status VARCHAR(20) NOT NULL DEFAULT 'active',
            billing_cycle VARCHAR(20),
            started_at TIMESTAMPTZ DEFAULT now(),
            current_period_start TIMESTAMPTZ,
            current_period_end TIMESTAMPTZ,
            cancelled_at TIMESTAMPTZ,
            trial_ends_at TIMESTAMPTZ,
            stripe_subscription_id VARCHAR(255),
            stripe_customer_id VARCHAR(255),
            payment_method VARCHAR(50),
            last_payment_at TIMESTAMPTZ,
            next_payment_at TIMESTAMPTZ,
            extra_metadata JSONB DEFAULT '{}',
            created_at TIMESTAMPTZ DEFAULT now(),
            updated_at TIMESTAMPTZ
        )
    """)

    # Add any missing columns if table existed with old schema (e.g. from 20251101_0000 which had tier_id, not plan_id)
    op.execute(
        "ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES subscription_plans(id)"
    )
    op.execute(
        "ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS service_type VARCHAR(20) NOT NULL DEFAULT 'normal'"
    )
    op.execute("ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(20)")
    op.execute(
        "ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255)"
    )
    op.execute(
        "ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255)"
    )
    op.execute(
        "ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMPTZ"
    )
    op.execute(
        "ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ"
    )
    op.execute("ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ")
    op.execute("ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ")
    op.execute("ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50)")
    op.execute(
        "ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS last_payment_at TIMESTAMPTZ"
    )
    op.execute(
        "ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS next_payment_at TIMESTAMPTZ"
    )
    op.execute(
        "ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS extra_metadata JSONB DEFAULT '{}'"
    )

    # Indexes for user_subscriptions (idempotent)
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON user_subscriptions(user_id, service_type)"
    )
    op.execute("CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON user_subscriptions(status)")
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe ON user_subscriptions(stripe_subscription_id)"
    )

    # =========================================================================
    # 3. CREATE subscription_history TABLE (idempotent)
    # =========================================================================

    op.execute("""
        CREATE TABLE IF NOT EXISTS subscription_history (
            id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
            user_id UUID NOT NULL,
            service_type VARCHAR(20) NOT NULL,
            subscription_id UUID REFERENCES user_subscriptions(id),
            event_type VARCHAR(50) NOT NULL,
            from_plan_id UUID REFERENCES subscription_plans(id),
            to_plan_id UUID REFERENCES subscription_plans(id),
            reason VARCHAR(100),
            performed_by UUID,
            notes TEXT,
            extra_metadata JSONB DEFAULT '{}',
            created_at TIMESTAMPTZ DEFAULT now()
        )
    """)

    # Add any missing columns if table existed with old schema
    op.execute(
        "ALTER TABLE subscription_history ADD COLUMN IF NOT EXISTS service_type VARCHAR(20) NOT NULL DEFAULT 'normal'"
    )
    op.execute("ALTER TABLE subscription_history ADD COLUMN IF NOT EXISTS from_plan_id UUID")
    op.execute("ALTER TABLE subscription_history ADD COLUMN IF NOT EXISTS to_plan_id UUID")
    op.execute("ALTER TABLE subscription_history ADD COLUMN IF NOT EXISTS reason VARCHAR(100)")
    op.execute("ALTER TABLE subscription_history ADD COLUMN IF NOT EXISTS performed_by UUID")
    op.execute("ALTER TABLE subscription_history ADD COLUMN IF NOT EXISTS notes TEXT")
    op.execute(
        "ALTER TABLE subscription_history ADD COLUMN IF NOT EXISTS extra_metadata JSONB DEFAULT '{}'"
    )

    # Indexes for subscription_history (idempotent)
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_history_user ON subscription_history(user_id, service_type)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_history_subscription ON subscription_history(subscription_id)"
    )
    op.execute("CREATE INDEX IF NOT EXISTS idx_history_created ON subscription_history(created_at)")

    # =========================================================================
    # 4. SEED subscription_plans WITH NORMAL STORAGE PLANS
    # =========================================================================

    # Insert Normal Storage plans from PLAN_LIMITS
    plans_data = [
        {
            "plan_code": "normal_free",
            "service_type": "normal",
            "tier_name": "free",
            "display_name": "Free Storage",
            "description": "Free tier with basic storage and bandwidth",
            "price_monthly": 0,
            "price_yearly": 0,
            "storage_bytes": 5 * 1024**3,  # 5GB
            "bandwidth_mbps": 5,
            "bandwidth_burst_mbps": 10,
            "max_concurrent_streams": 2,
            "stripe_price_id_monthly": None,
            "stripe_price_id_yearly": None,
            "features": '{"support": "community", "ai_features": false}',
            "is_active": True,
            "is_default": True,
            "sort_order": 0,
        },
        {
            "plan_code": "normal_basic",
            "service_type": "normal",
            "tier_name": "basic",
            "display_name": "Basic Storage",
            "description": "Perfect for personal use with 200GB storage",
            "price_monthly": 4.99,
            "price_yearly": 49.99,
            "storage_bytes": 200 * 1024**3,  # 200GB
            "bandwidth_mbps": 25,
            "bandwidth_burst_mbps": 50,
            "max_concurrent_streams": 5,
            "stripe_price_id_monthly": "price_normal_basic_monthly",
            "stripe_price_id_yearly": "price_normal_basic_yearly",
            "features": '{"support": "email", "ai_features": false, "versioning": 10}',
            "is_active": True,
            "is_default": False,
            "sort_order": 1,
        },
        {
            "plan_code": "normal_pro",
            "service_type": "normal",
            "tier_name": "pro",
            "display_name": "Pro Storage",
            "description": "Advanced features with 1TB storage",
            "price_monthly": 9.99,
            "price_yearly": 99.99,
            "storage_bytes": 1 * 1024**4,  # 1TB
            "bandwidth_mbps": 100,
            "bandwidth_burst_mbps": 200,
            "max_concurrent_streams": 10,
            "stripe_price_id_monthly": "price_normal_pro_monthly",
            "stripe_price_id_yearly": "price_normal_pro_yearly",
            "features": '{"support": "priority", "ai_features": true, "versioning": 50}',
            "is_active": True,
            "is_default": False,
            "sort_order": 2,
        },
        {
            "plan_code": "normal_team",
            "service_type": "normal",
            "tier_name": "team",
            "display_name": "Team Storage",
            "description": "Collaboration features with 5TB storage",
            "price_monthly": 24.99,
            "price_yearly": 249.99,
            "storage_bytes": 5 * 1024**4,  # 5TB
            "bandwidth_mbps": 500,
            "bandwidth_burst_mbps": 1000,
            "max_concurrent_streams": 25,
            "stripe_price_id_monthly": "price_normal_team_monthly",
            "stripe_price_id_yearly": "price_normal_team_yearly",
            "features": '{"support": "24/7", "ai_features": true, "versioning": 100, "team_sharing": true}',
            "is_active": True,
            "is_default": False,
            "sort_order": 3,
        },
    ]

    for plan in plans_data:
        op.execute(f"""
            INSERT INTO subscription_plans (
                plan_code, service_type, tier_name, display_name, description,
                price_monthly, price_yearly, storage_bytes, bandwidth_mbps,
                bandwidth_burst_mbps, max_concurrent_streams, stripe_price_id_monthly,
                stripe_price_id_yearly, features, is_active, is_default, sort_order
            ) VALUES (
                '{plan['plan_code']}', '{plan['service_type']}', '{plan['tier_name']}',
                '{plan['display_name']}', '{plan['description']}',
                {plan['price_monthly'] or 'NULL'}, {plan['price_yearly'] or 'NULL'},
                {plan['storage_bytes']}, {plan['bandwidth_mbps']}, {plan['bandwidth_burst_mbps']},
                {plan['max_concurrent_streams']},
                {f"'{plan['stripe_price_id_monthly']}'" if plan['stripe_price_id_monthly'] else 'NULL'},
                {f"'{plan['stripe_price_id_yearly']}'" if plan['stripe_price_id_yearly'] else 'NULL'},
                '{plan['features']}'::jsonb, {plan['is_active']}, {plan['is_default']}, {plan['sort_order']}
            )
            ON CONFLICT (plan_code) DO NOTHING
        """)

    print("✅ Created subscription tables and seeded Normal Storage plans")


def downgrade():
    # Drop tables in reverse order (respect foreign keys)
    op.execute("DROP TABLE IF EXISTS subscription_history CASCADE")
    op.execute("DROP TABLE IF EXISTS user_subscriptions CASCADE")
    op.execute("DROP TABLE IF EXISTS subscription_plans CASCADE")

    print("Dropped subscription tables")
