"""update_plans_schema

Revision ID: 20260109_0001
Revises: 20260104_0004
Create Date: 2026-01-09 12:00:00.000000

Adds new columns for 6-month pricing, plan categories, and most popular flags.
Migrates to new 11-plan structure with updated pricing.
"""

from uuid import uuid4

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID

# revision identifiers
revision = "update_plans_schema"
down_revision = "add_zk_encryption_plans"
branch_labels = None
depends_on = None


def upgrade():
    """
    Add new columns and migrate to new plan structure.
    """
    # Step 1: Add new columns to subscription_plans table (IF NOT EXISTS for idempotent re-runs)
    op.execute(
        "ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price_six_months NUMERIC(10, 2)"
    )
    op.execute(
        "ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS is_most_popular BOOLEAN NOT NULL DEFAULT false"
    )
    op.execute(
        "ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS category VARCHAR(20) NOT NULL DEFAULT 'individual'"
    )
    op.execute(
        "ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS stripe_price_id_six_months VARCHAR(255)"
    )

    # Step 2: SOFT DELETE - Mark old plans as inactive (DON'T DELETE!)
    # This preserves existing user subscriptions and history
    op.execute("""
            UPDATE subscription_plans
            SET is_active = FALSE,
                updated_at = NOW()
            WHERE plan_code IN (
                'normal_free', 'normal_basic', 'normal_pro', 'normal_team',
                'zk_free', 'zk_personal', 'zk_business', 'zk_enterprise'
            );
        """)

    # Step 3: Migrate existing subscriptions to new plan structure
    # Map old plan codes to new plan codes (will be created below)
    # Note: This will be executed after new plans are inserted, so we'll do it after step 4

    # Step 3: Insert new plans from JSON structure

    ###################
    # NORMAL STORAGE PLANS - Individual
    ###################

    # 1. normal_free (5GB, Free) - upsert so re-runs don't violate unique constraint
    op.execute("""
            INSERT INTO subscription_plans (
                id, plan_code, service_type, tier_name, display_name, description,
                price_monthly, price_six_months, price_yearly,
                storage_bytes, bandwidth_mbps, bandwidth_burst_mbps, max_concurrent_streams,
                features, is_active, is_default, is_most_popular, category, sort_order,
                created_at, updated_at
            ) VALUES (
                gen_random_uuid(), 'normal_free', 'normal', 'free', 'Free Storage', 'Perfect for getting started',
                NULL, NULL, NULL,
                5368709120, 5, 10, 2,
                '{"support": "community", "ai_features": false}'::jsonb,
                TRUE, TRUE, FALSE, 'individual', 0,
                NOW(), NOW()
            )
            ON CONFLICT (plan_code) DO UPDATE SET
                service_type = EXCLUDED.service_type,
                tier_name = EXCLUDED.tier_name,
                display_name = EXCLUDED.display_name,
                description = EXCLUDED.description,
                price_monthly = EXCLUDED.price_monthly,
                price_six_months = EXCLUDED.price_six_months,
                price_yearly = EXCLUDED.price_yearly,
                storage_bytes = EXCLUDED.storage_bytes,
                bandwidth_mbps = EXCLUDED.bandwidth_mbps,
                bandwidth_burst_mbps = EXCLUDED.bandwidth_burst_mbps,
                max_concurrent_streams = EXCLUDED.max_concurrent_streams,
                features = EXCLUDED.features,
                is_active = EXCLUDED.is_active,
                is_default = EXCLUDED.is_default,
                is_most_popular = EXCLUDED.is_most_popular,
                category = EXCLUDED.category,
                sort_order = EXCLUDED.sort_order,
                updated_at = NOW();
        """)

    # 2. normal_basic (200GB, ₹99/mo, ₹499/6mo, ₹899/yr) - MOST POPULAR
    op.execute("""
            INSERT INTO subscription_plans (
                id, plan_code, service_type, tier_name, display_name, description,
                price_monthly, price_six_months, price_yearly,
                storage_bytes, bandwidth_mbps, bandwidth_burst_mbps, max_concurrent_streams,
                features, is_active, is_default, is_most_popular, category, sort_order,
                created_at, updated_at
            ) VALUES (
                gen_random_uuid(), 'normal_basic', 'normal', 'basic', 'Basic Storage', 'Perfect for personal use with 200GB storage',
                99, 499, 899,
                214748364800, 25, 50, 5,
                '{"support": "email", "versioning": 10, "ai_features": false}'::jsonb,
                TRUE, FALSE, TRUE, 'individual', 1,
                NOW(), NOW()
            )
            ON CONFLICT (plan_code) DO UPDATE SET
                service_type = EXCLUDED.service_type,
                tier_name = EXCLUDED.tier_name,
                display_name = EXCLUDED.display_name,
                description = EXCLUDED.description,
                price_monthly = EXCLUDED.price_monthly,
                price_six_months = EXCLUDED.price_six_months,
                price_yearly = EXCLUDED.price_yearly,
                storage_bytes = EXCLUDED.storage_bytes,
                bandwidth_mbps = EXCLUDED.bandwidth_mbps,
                bandwidth_burst_mbps = EXCLUDED.bandwidth_burst_mbps,
                max_concurrent_streams = EXCLUDED.max_concurrent_streams,
                features = EXCLUDED.features,
                is_active = EXCLUDED.is_active,
                is_default = EXCLUDED.is_default,
                is_most_popular = EXCLUDED.is_most_popular,
                category = EXCLUDED.category,
                sort_order = EXCLUDED.sort_order,
                updated_at = NOW();
        """)

    # 3. normal_pro (1TB, ₹199/mo, ₹999/6mo, ₹1799/yr)
    op.execute("""
            INSERT INTO subscription_plans (
                id, plan_code, service_type, tier_name, display_name, description,
                price_monthly, price_six_months, price_yearly,
                storage_bytes, bandwidth_mbps, bandwidth_burst_mbps, max_concurrent_streams,
                features, is_active, is_default, is_most_popular, category, sort_order,
                created_at, updated_at
            ) VALUES (
                gen_random_uuid(), 'normal_pro', 'normal', 'pro', 'Pro Storage', 'Designed for creators and power users with 1TB high-performance storage',
                199, 999, 1799,
                1099511627776, 100, 200, 10,
                '{"support": "priority", "versioning": 50, "ai_features": true}'::jsonb,
                TRUE, FALSE, FALSE, 'individual', 2,
                NOW(), NOW()
            )
            ON CONFLICT (plan_code) DO UPDATE SET
                service_type = EXCLUDED.service_type,
                tier_name = EXCLUDED.tier_name,
                display_name = EXCLUDED.display_name,
                description = EXCLUDED.description,
                price_monthly = EXCLUDED.price_monthly,
                price_six_months = EXCLUDED.price_six_months,
                price_yearly = EXCLUDED.price_yearly,
                storage_bytes = EXCLUDED.storage_bytes,
                bandwidth_mbps = EXCLUDED.bandwidth_mbps,
                bandwidth_burst_mbps = EXCLUDED.bandwidth_burst_mbps,
                max_concurrent_streams = EXCLUDED.max_concurrent_streams,
                features = EXCLUDED.features,
                is_active = EXCLUDED.is_active,
                is_default = EXCLUDED.is_default,
                is_most_popular = EXCLUDED.is_most_popular,
                category = EXCLUDED.category,
                sort_order = EXCLUDED.sort_order,
                updated_at = NOW();
        """)

    # 4. normal_pro_plus (2TB, ₹299/mo, ₹1499/6mo, ₹2499/yr)
    op.execute("""
            INSERT INTO subscription_plans (
                id, plan_code, service_type, tier_name, display_name, description,
                price_monthly, price_six_months, price_yearly,
                storage_bytes, bandwidth_mbps, bandwidth_burst_mbps, max_concurrent_streams,
                features, is_active, is_default, is_most_popular, category, sort_order,
                created_at, updated_at
            ) VALUES (
                gen_random_uuid(), 'normal_pro_plus', 'normal', 'pro_plus', 'Pro Plus Storage', 'For power users needing 2TB high-performance storage',
                299, 1499, 2499,
                2199023255552, 150, 300, 15,
                '{"support": "priority", "versioning": 100, "ai_features": true}'::jsonb,
                TRUE, FALSE, FALSE, 'individual', 3,
                NOW(), NOW()
            )
            ON CONFLICT (plan_code) DO UPDATE SET
                service_type = EXCLUDED.service_type,
                tier_name = EXCLUDED.tier_name,
                display_name = EXCLUDED.display_name,
                description = EXCLUDED.description,
                price_monthly = EXCLUDED.price_monthly,
                price_six_months = EXCLUDED.price_six_months,
                price_yearly = EXCLUDED.price_yearly,
                storage_bytes = EXCLUDED.storage_bytes,
                bandwidth_mbps = EXCLUDED.bandwidth_mbps,
                bandwidth_burst_mbps = EXCLUDED.bandwidth_burst_mbps,
                max_concurrent_streams = EXCLUDED.max_concurrent_streams,
                features = EXCLUDED.features,
                is_active = EXCLUDED.is_active,
                is_default = EXCLUDED.is_default,
                is_most_popular = EXCLUDED.is_most_popular,
                category = EXCLUDED.category,
                sort_order = EXCLUDED.sort_order,
                updated_at = NOW();
        """)

    # 5. normal_pro_ultra (3TB, ₹399/mo, ₹1999/6mo, ₹3499/yr)
    op.execute("""
            INSERT INTO subscription_plans (
                id, plan_code, service_type, tier_name, display_name, description,
                price_monthly, price_six_months, price_yearly,
                storage_bytes, bandwidth_mbps, bandwidth_burst_mbps, max_concurrent_streams,
                features, is_active, is_default, is_most_popular, category, sort_order,
                created_at, updated_at
            ) VALUES (
                gen_random_uuid(), 'normal_pro_ultra', 'normal', 'pro_ultra', 'Pro Ultra Storage', 'High-capacity 3TB storage for heavy creators and professionals',
                399, 1999, 3499,
                3298534883328, 200, 400, 20,
                '{"support": "priority", "versioning": 150, "ai_features": true}'::jsonb,
                TRUE, FALSE, FALSE, 'individual', 4,
                NOW(), NOW()
            )
            ON CONFLICT (plan_code) DO UPDATE SET
                service_type = EXCLUDED.service_type,
                tier_name = EXCLUDED.tier_name,
                display_name = EXCLUDED.display_name,
                description = EXCLUDED.description,
                price_monthly = EXCLUDED.price_monthly,
                price_six_months = EXCLUDED.price_six_months,
                price_yearly = EXCLUDED.price_yearly,
                storage_bytes = EXCLUDED.storage_bytes,
                bandwidth_mbps = EXCLUDED.bandwidth_mbps,
                bandwidth_burst_mbps = EXCLUDED.bandwidth_burst_mbps,
                max_concurrent_streams = EXCLUDED.max_concurrent_streams,
                features = EXCLUDED.features,
                is_active = EXCLUDED.is_active,
                is_default = EXCLUDED.is_default,
                is_most_popular = EXCLUDED.is_most_popular,
                category = EXCLUDED.category,
                sort_order = EXCLUDED.sort_order,
                updated_at = NOW();
        """)

    # 6. normal_solo_max (5TB, ₹599/mo, ₹2999/6mo, ₹5499/yr)
    op.execute("""
            INSERT INTO subscription_plans (
                id, plan_code, service_type, tier_name, display_name, description,
                price_monthly, price_six_months, price_yearly,
                storage_bytes, bandwidth_mbps, bandwidth_burst_mbps, max_concurrent_streams,
                features, is_active, is_default, is_most_popular, category, sort_order,
                created_at, updated_at
            ) VALUES (
                gen_random_uuid(), 'normal_solo_max', 'normal', 'solo_max', 'Solo Max Storage', 'Massive 5TB personal storage without collaboration features',
                599, 2999, 5499,
                5497558138880, 300, 600, 25,
                '{"support": "priority", "versioning": 200, "ai_features": true, "team_sharing": false}'::jsonb,
                TRUE, FALSE, FALSE, 'individual', 5,
                NOW(), NOW()
            )
            ON CONFLICT (plan_code) DO UPDATE SET
                service_type = EXCLUDED.service_type,
                tier_name = EXCLUDED.tier_name,
                display_name = EXCLUDED.display_name,
                description = EXCLUDED.description,
                price_monthly = EXCLUDED.price_monthly,
                price_six_months = EXCLUDED.price_six_months,
                price_yearly = EXCLUDED.price_yearly,
                storage_bytes = EXCLUDED.storage_bytes,
                bandwidth_mbps = EXCLUDED.bandwidth_mbps,
                bandwidth_burst_mbps = EXCLUDED.bandwidth_burst_mbps,
                max_concurrent_streams = EXCLUDED.max_concurrent_streams,
                features = EXCLUDED.features,
                is_active = EXCLUDED.is_active,
                is_default = EXCLUDED.is_default,
                is_most_popular = EXCLUDED.is_most_popular,
                category = EXCLUDED.category,
                sort_order = EXCLUDED.sort_order,
                updated_at = NOW();
        """)

    ###################
    # NORMAL STORAGE PLANS - Business
    ###################

    # 7. normal_team (5TB, ₹799/mo, ₹3999/6mo, ₹6999/yr) - MOST POPULAR
    op.execute("""
            INSERT INTO subscription_plans (
                id, plan_code, service_type, tier_name, display_name, description,
                price_monthly, price_six_months, price_yearly,
                storage_bytes, bandwidth_mbps, bandwidth_burst_mbps, max_concurrent_streams,
                features, is_active, is_default, is_most_popular, category, sort_order,
                created_at, updated_at
            ) VALUES (
                gen_random_uuid(), 'normal_team', 'normal', 'team', 'Team Storage', 'Collaboration-ready storage with 5TB capacity for teams',
                799, 3999, 6999,
                5497558138880, 500, 1000, 25,
                '{"support": "24/7", "versioning": 100, "ai_features": true, "team_sharing": true}'::jsonb,
                TRUE, FALSE, TRUE, 'business', 6,
                NOW(), NOW()
            )
            ON CONFLICT (plan_code) DO UPDATE SET
                service_type = EXCLUDED.service_type,
                tier_name = EXCLUDED.tier_name,
                display_name = EXCLUDED.display_name,
                description = EXCLUDED.description,
                price_monthly = EXCLUDED.price_monthly,
                price_six_months = EXCLUDED.price_six_months,
                price_yearly = EXCLUDED.price_yearly,
                storage_bytes = EXCLUDED.storage_bytes,
                bandwidth_mbps = EXCLUDED.bandwidth_mbps,
                bandwidth_burst_mbps = EXCLUDED.bandwidth_burst_mbps,
                max_concurrent_streams = EXCLUDED.max_concurrent_streams,
                features = EXCLUDED.features,
                is_active = EXCLUDED.is_active,
                is_default = EXCLUDED.is_default,
                is_most_popular = EXCLUDED.is_most_popular,
                category = EXCLUDED.category,
                sort_order = EXCLUDED.sort_order,
                updated_at = NOW();
        """)

    ###################
    # ZK ENCRYPTION PLANS - Individual
    ###################

    # 8. zk_pro (1TB, ₹399/mo, ₹1999/6mo, ₹3499/yr) - MOST POPULAR
    op.execute("""
            INSERT INTO subscription_plans (
                id, plan_code, service_type, tier_name, display_name, description,
                price_monthly, price_six_months, price_yearly,
                storage_bytes, bandwidth_mbps, bandwidth_burst_mbps, max_concurrent_streams,
                features, is_active, is_default, is_most_popular, category, sort_order,
                created_at, updated_at
            ) VALUES (
                gen_random_uuid(), 'zk_pro', 'zk', 'pro', 'ZK Pro', '1TB zero-knowledge encrypted personal vault',
                399, 1999, 3499,
                1099511627776, 20, 40, 5,
                '{"support": "priority", "webauthn": true, "encryption": "zero_knowledge", "versioning": true, "hardware_keys": 10, "recovery_phrase": true}'::jsonb,
                TRUE, FALSE, TRUE, 'individual', 0,
                NOW(), NOW()
            )
            ON CONFLICT (plan_code) DO UPDATE SET
                service_type = EXCLUDED.service_type,
                tier_name = EXCLUDED.tier_name,
                display_name = EXCLUDED.display_name,
                description = EXCLUDED.description,
                price_monthly = EXCLUDED.price_monthly,
                price_six_months = EXCLUDED.price_six_months,
                price_yearly = EXCLUDED.price_yearly,
                storage_bytes = EXCLUDED.storage_bytes,
                bandwidth_mbps = EXCLUDED.bandwidth_mbps,
                bandwidth_burst_mbps = EXCLUDED.bandwidth_burst_mbps,
                max_concurrent_streams = EXCLUDED.max_concurrent_streams,
                features = EXCLUDED.features,
                is_active = EXCLUDED.is_active,
                is_default = EXCLUDED.is_default,
                is_most_popular = EXCLUDED.is_most_popular,
                category = EXCLUDED.category,
                sort_order = EXCLUDED.sort_order,
                updated_at = NOW();
        """)

    # 9. zk_pro_plus (2TB, ₹699/mo, ₹3499/6mo, ₹5999/yr)
    op.execute("""
            INSERT INTO subscription_plans (
                id, plan_code, service_type, tier_name, display_name, description,
                price_monthly, price_six_months, price_yearly,
                storage_bytes, bandwidth_mbps, bandwidth_burst_mbps, max_concurrent_streams,
                features, is_active, is_default, is_most_popular, category, sort_order,
                created_at, updated_at
            ) VALUES (
                gen_random_uuid(), 'zk_pro_plus', 'zk', 'pro_plus', 'ZK Pro Plus', '2TB zero-knowledge encrypted personal storage',
                699, 3499, 5999,
                2199023255552, 30, 60, 7,
                '{"support": "priority", "webauthn": true, "encryption": "zero_knowledge", "versioning": true, "hardware_keys": 15, "recovery_phrase": true}'::jsonb,
                TRUE, FALSE, FALSE, 'individual', 1,
                NOW(), NOW()
            )
            ON CONFLICT (plan_code) DO UPDATE SET
                service_type = EXCLUDED.service_type,
                tier_name = EXCLUDED.tier_name,
                display_name = EXCLUDED.display_name,
                description = EXCLUDED.description,
                price_monthly = EXCLUDED.price_monthly,
                price_six_months = EXCLUDED.price_six_months,
                price_yearly = EXCLUDED.price_yearly,
                storage_bytes = EXCLUDED.storage_bytes,
                bandwidth_mbps = EXCLUDED.bandwidth_mbps,
                bandwidth_burst_mbps = EXCLUDED.bandwidth_burst_mbps,
                max_concurrent_streams = EXCLUDED.max_concurrent_streams,
                features = EXCLUDED.features,
                is_active = EXCLUDED.is_active,
                is_default = EXCLUDED.is_default,
                is_most_popular = EXCLUDED.is_most_popular,
                category = EXCLUDED.category,
                sort_order = EXCLUDED.sort_order,
                updated_at = NOW();
        """)

    # 10. zk_ultra (3TB, ₹999/mo, ₹4999/6mo, ₹8999/yr)
    op.execute("""
            INSERT INTO subscription_plans (
                id, plan_code, service_type, tier_name, display_name, description,
                price_monthly, price_six_months, price_yearly,
                storage_bytes, bandwidth_mbps, bandwidth_burst_mbps, max_concurrent_streams,
                features, is_active, is_default, is_most_popular, category, sort_order,
                created_at, updated_at
            ) VALUES (
                gen_random_uuid(), 'zk_ultra', 'zk', 'ultra', 'ZK Ultra', '3TB zero-knowledge encrypted vault',
                999, 4999, 8999,
                3298534883328, 40, 80, 10,
                '{"support": "priority", "webauthn": true, "encryption": "zero_knowledge", "versioning": true, "hardware_keys": 25, "recovery_phrase": true}'::jsonb,
                TRUE, FALSE, FALSE, 'individual', 2,
                NOW(), NOW()
            )
            ON CONFLICT (plan_code) DO UPDATE SET
                service_type = EXCLUDED.service_type,
                tier_name = EXCLUDED.tier_name,
                display_name = EXCLUDED.display_name,
                description = EXCLUDED.description,
                price_monthly = EXCLUDED.price_monthly,
                price_six_months = EXCLUDED.price_six_months,
                price_yearly = EXCLUDED.price_yearly,
                storage_bytes = EXCLUDED.storage_bytes,
                bandwidth_mbps = EXCLUDED.bandwidth_mbps,
                bandwidth_burst_mbps = EXCLUDED.bandwidth_burst_mbps,
                max_concurrent_streams = EXCLUDED.max_concurrent_streams,
                features = EXCLUDED.features,
                is_active = EXCLUDED.is_active,
                is_default = EXCLUDED.is_default,
                is_most_popular = EXCLUDED.is_most_popular,
                category = EXCLUDED.category,
                sort_order = EXCLUDED.sort_order,
                updated_at = NOW();
        """)

    # 11. zk_max (5TB, ₹1399/mo, ₹6999/6mo, ₹11999/yr)
    op.execute("""
            INSERT INTO subscription_plans (
                id, plan_code, service_type, tier_name, display_name, description,
                price_monthly, price_six_months, price_yearly,
                storage_bytes, bandwidth_mbps, bandwidth_burst_mbps, max_concurrent_streams,
                features, is_active, is_default, is_most_popular, category, sort_order,
                created_at, updated_at
            ) VALUES (
                gen_random_uuid(), 'zk_max', 'zk', 'max', 'ZK Max', '5TB zero-knowledge encrypted personal vault',
                1399, 6999, 11999,
                5497558138880, 60, 120, 15,
                '{"support": "priority", "webauthn": true, "encryption": "zero_knowledge", "versioning": true, "hardware_keys": 40, "recovery_phrase": true}'::jsonb,
                TRUE, FALSE, FALSE, 'individual', 3,
                NOW(), NOW()
            )
            ON CONFLICT (plan_code) DO UPDATE SET
                service_type = EXCLUDED.service_type,
                tier_name = EXCLUDED.tier_name,
                display_name = EXCLUDED.display_name,
                description = EXCLUDED.description,
                price_monthly = EXCLUDED.price_monthly,
                price_six_months = EXCLUDED.price_six_months,
                price_yearly = EXCLUDED.price_yearly,
                storage_bytes = EXCLUDED.storage_bytes,
                bandwidth_mbps = EXCLUDED.bandwidth_mbps,
                bandwidth_burst_mbps = EXCLUDED.bandwidth_burst_mbps,
                max_concurrent_streams = EXCLUDED.max_concurrent_streams,
                features = EXCLUDED.features,
                is_active = EXCLUDED.is_active,
                is_default = EXCLUDED.is_default,
                is_most_popular = EXCLUDED.is_most_popular,
                category = EXCLUDED.category,
                sort_order = EXCLUDED.sort_order,
                updated_at = NOW();
        """)

    # Step 4: Subscription migration skipped.
    # Plans were upserted in place (same plan_code), so user_subscriptions.plan_id
    # and subscription_history already reference the correct plan rows; no remap needed.


def downgrade():
    """
    Rollback changes: remove new columns and restore old plans.
    """
    # Restore old plans (mark as active again)
    op.execute("""
            UPDATE subscription_plans
            SET is_active = TRUE,
                updated_at = NOW()
            WHERE plan_code IN (
                'normal_free', 'normal_basic', 'normal_pro', 'normal_team',
                'zk_free', 'zk_personal', 'zk_business', 'zk_enterprise'
            );
        """)

    # Soft-delete plans that this migration added/updated (no remap needed; we upserted in place)
    op.execute("""
            UPDATE subscription_plans
            SET is_active = FALSE,
                updated_at = NOW()
            WHERE plan_code IN (
                'normal_pro_plus', 'normal_pro_ultra', 'normal_solo_max',
                'zk_pro', 'zk_pro_plus', 'zk_ultra', 'zk_max'
            );
        """)

    # Remove new columns
    op.drop_column("subscription_plans", "stripe_price_id_six_months")
    op.drop_column("subscription_plans", "category")
    op.drop_column("subscription_plans", "is_most_popular")
    op.drop_column("subscription_plans", "price_six_months")
