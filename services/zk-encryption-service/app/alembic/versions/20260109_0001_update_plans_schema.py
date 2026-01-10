"""update_plans_schema

Revision ID: 20260109_0001
Revises: 20260104_0004
Create Date: 2026-01-09 12:00:00.000000

Adds new columns for 6-month pricing, plan categories, and most popular flags.
Migrates to new 11-plan structure with updated pricing.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID as PGUUID, JSONB
from sqlalchemy import text
from uuid import uuid4

# revision identifiers
revision = 'update_plans_schema'
down_revision = 'create_subscription_tables'
branch_labels = None
depends_on = None


def upgrade():
    """
    Add new columns and migrate to new plan structure.
    """
    # Step 1: Add new columns to subscription_plans table
    op.add_column('subscription_plans', sa.Column('price_six_months', sa.Numeric(10, 2), nullable=True))
    op.add_column('subscription_plans', sa.Column('is_most_popular', sa.Boolean(), nullable=False, server_default='false'))
    op.add_column('subscription_plans', sa.Column('category', sa.String(20), nullable=False, server_default='individual'))
    op.add_column('subscription_plans', sa.Column('stripe_price_id_six_months', sa.String(255), nullable=True))

    # Step 2: Delete history first, then subscriptions, then plans (FK constraint order)
    op.execute(
        """
            DELETE FROM subscription_history
            WHERE subscription_id IN (
                SELECT us.id FROM user_subscriptions us
                JOIN subscription_plans sp ON us.plan_id = sp.id
                WHERE sp.plan_code IN (
                    'normal_free', 'normal_basic', 'normal_pro', 'normal_team',
                    'zk_free', 'zk_personal', 'zk_business', 'zk_enterprise'
                )
            );
        """
    )

    # Step 3: Delete user subscriptions
    op.execute(
        """
            DELETE FROM user_subscriptions
            WHERE plan_id IN (
                SELECT id FROM subscription_plans WHERE plan_code IN (
                    'normal_free', 'normal_basic', 'normal_pro', 'normal_team',
                    'zk_free', 'zk_personal', 'zk_business', 'zk_enterprise'
                )
            );
        """
    )

    # Step 4: Now delete the old plans
    op.execute(
        """
            DELETE FROM subscription_plans
            WHERE plan_code IN (
                'normal_free', 'normal_basic', 'normal_pro', 'normal_team',
                'zk_free', 'zk_personal', 'zk_business', 'zk_enterprise'
            );
        """
    )

    # Step 3: Insert new plans from JSON structure

    ###################
    # NORMAL STORAGE PLANS - Individual
    ###################

    # 1. normal_free (5GB, Free)
    op.execute(
        """
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
            );
        """
    )

    # 2. normal_basic (200GB, $0.99/mo, $4.99/6mo, $8.99/yr) - MOST POPULAR
    op.execute(
        """
            INSERT INTO subscription_plans (
                id, plan_code, service_type, tier_name, display_name, description,
                price_monthly, price_six_months, price_yearly,
                storage_bytes, bandwidth_mbps, bandwidth_burst_mbps, max_concurrent_streams,
                features, is_active, is_default, is_most_popular, category, sort_order,
                created_at, updated_at
            ) VALUES (
                gen_random_uuid(), 'normal_basic', 'normal', 'basic', 'Basic Storage', 'Perfect for personal use with 200GB storage',
                0.99, 4.99, 8.99,
                214748364800, 25, 50, 5,
                '{"support": "email", "versioning": 10, "ai_features": false}'::jsonb,
                TRUE, FALSE, TRUE, 'individual', 1,
                NOW(), NOW()
            );
        """
    )

    # 3. normal_pro (1TB, $1.99/mo, $7.99/6mo, $12.99/yr)
    op.execute(
        """
            INSERT INTO subscription_plans (
                id, plan_code, service_type, tier_name, display_name, description,
                price_monthly, price_six_months, price_yearly,
                storage_bytes, bandwidth_mbps, bandwidth_burst_mbps, max_concurrent_streams,
                features, is_active, is_default, is_most_popular, category, sort_order,
                created_at, updated_at
            ) VALUES (
                gen_random_uuid(), 'normal_pro', 'normal', 'pro', 'Pro Storage', 'Designed for creators and power users with 1TB high-performance storage',
                1.99, 7.99, 12.99,
                1099511627776, 100, 200, 10,
                '{"support": "priority", "versioning": 50, "ai_features": true}'::jsonb,
                TRUE, FALSE, FALSE, 'individual', 2,
                NOW(), NOW()
            );
        """
    )

    # 4. normal_pro_plus (2TB, $2.99/mo, $12.99/6mo, $22.99/yr)
    op.execute(
        """
            INSERT INTO subscription_plans (
                id, plan_code, service_type, tier_name, display_name, description,
                price_monthly, price_six_months, price_yearly,
                storage_bytes, bandwidth_mbps, bandwidth_burst_mbps, max_concurrent_streams,
                features, is_active, is_default, is_most_popular, category, sort_order,
                created_at, updated_at
            ) VALUES (
                gen_random_uuid(), 'normal_pro_plus', 'normal', 'pro_plus', 'Pro Plus Storage', 'For power users needing 2TB high-performance storage',
                2.99, 12.99, 22.99,
                2199023255552, 150, 300, 15,
                '{"support": "priority", "versioning": 100, "ai_features": true}'::jsonb,
                TRUE, FALSE, FALSE, 'individual', 3,
                NOW(), NOW()
            );
        """
    )

    # 5. normal_pro_ultra (3TB, $3.99/mo, $19.99/6mo, $32.99/yr)
    op.execute(
        """
            INSERT INTO subscription_plans (
                id, plan_code, service_type, tier_name, display_name, description,
                price_monthly, price_six_months, price_yearly,
                storage_bytes, bandwidth_mbps, bandwidth_burst_mbps, max_concurrent_streams,
                features, is_active, is_default, is_most_popular, category, sort_order,
                created_at, updated_at
            ) VALUES (
                gen_random_uuid(), 'normal_pro_ultra', 'normal', 'pro_ultra', 'Pro Ultra Storage', 'High-capacity 3TB storage for heavy creators and professionals',
                3.99, 19.99, 32.99,
                3298534883328, 200, 400, 20,
                '{"support": "priority", "versioning": 150, "ai_features": true}'::jsonb,
                TRUE, FALSE, FALSE, 'individual', 4,
                NOW(), NOW()
            );
        """
    )

    # 6. normal_solo_max (5TB, $5.99/mo, $31.99/6mo, $54.99/yr)
    op.execute(
        """
            INSERT INTO subscription_plans (
                id, plan_code, service_type, tier_name, display_name, description,
                price_monthly, price_six_months, price_yearly,
                storage_bytes, bandwidth_mbps, bandwidth_burst_mbps, max_concurrent_streams,
                features, is_active, is_default, is_most_popular, category, sort_order,
                created_at, updated_at
            ) VALUES (
                gen_random_uuid(), 'normal_solo_max', 'normal', 'solo_max', 'Solo Max Storage', 'Massive 5TB personal storage without collaboration features',
                5.99, 31.99, 54.99,
                5497558138880, 300, 600, 25,
                '{"support": "priority", "versioning": 200, "ai_features": true, "team_sharing": false}'::jsonb,
                TRUE, FALSE, FALSE, 'individual', 5,
                NOW(), NOW()
            );
        """
    )

    ###################
    # NORMAL STORAGE PLANS - Business
    ###################

    # 7. normal_team (5TB, $5.99/mo, $34.99/6mo, $64.99/yr) - MOST POPULAR
    op.execute(
        """
            INSERT INTO subscription_plans (
                id, plan_code, service_type, tier_name, display_name, description,
                price_monthly, price_six_months, price_yearly,
                storage_bytes, bandwidth_mbps, bandwidth_burst_mbps, max_concurrent_streams,
                features, is_active, is_default, is_most_popular, category, sort_order,
                created_at, updated_at
            ) VALUES (
                gen_random_uuid(), 'normal_team', 'normal', 'team', 'Team Storage', 'Collaboration-ready storage with 5TB capacity for teams',
                5.99, 34.99, 64.99,
                5497558138880, 500, 1000, 25,
                '{"support": "24/7", "versioning": 100, "ai_features": true, "team_sharing": true}'::jsonb,
                TRUE, FALSE, TRUE, 'business', 6,
                NOW(), NOW()
            );
        """
    )

    ###################
    # ZK ENCRYPTION PLANS - Individual
    ###################

    # 8. zk_pro (1TB, $3.99/mo, $16.99/6mo, $29.99/yr) - MOST POPULAR
    op.execute(
        """
            INSERT INTO subscription_plans (
                id, plan_code, service_type, tier_name, display_name, description,
                price_monthly, price_six_months, price_yearly,
                storage_bytes, bandwidth_mbps, bandwidth_burst_mbps, max_concurrent_streams,
                features, is_active, is_default, is_most_popular, category, sort_order,
                created_at, updated_at
            ) VALUES (
                gen_random_uuid(), 'zk_pro', 'zk', 'pro', 'ZK Pro', '1TB zero-knowledge encrypted personal vault',
                3.99, 16.99, 29.99,
                1099511627776, 20, 40, 5,
                '{"support": "priority", "webauthn": true, "encryption": "zero_knowledge", "versioning": true, "hardware_keys": 10, "recovery_phrase": true}'::jsonb,
                TRUE, FALSE, TRUE, 'individual', 0,
                NOW(), NOW()
            );
        """
    )

    # 9. zk_pro_plus (2TB, $6.99/mo, $29.99/6mo, $54.99/yr)
    op.execute(
        """
            INSERT INTO subscription_plans (
                id, plan_code, service_type, tier_name, display_name, description,
                price_monthly, price_six_months, price_yearly,
                storage_bytes, bandwidth_mbps, bandwidth_burst_mbps, max_concurrent_streams,
                features, is_active, is_default, is_most_popular, category, sort_order,
                created_at, updated_at
            ) VALUES (
                gen_random_uuid(), 'zk_pro_plus', 'zk', 'pro_plus', 'ZK Pro Plus', '2TB zero-knowledge encrypted personal storage',
                6.99, 29.99, 54.99,
                2199023255552, 30, 60, 7,
                '{"support": "priority", "webauthn": true, "encryption": "zero_knowledge", "versioning": true, "hardware_keys": 15, "recovery_phrase": true}'::jsonb,
                TRUE, FALSE, FALSE, 'individual', 1,
                NOW(), NOW()
            );
        """
    )

    # 10. zk_ultra (3TB, $9.99/mo, $44.99/6mo, $79.99/yr)
    op.execute(
        """
            INSERT INTO subscription_plans (
                id, plan_code, service_type, tier_name, display_name, description,
                price_monthly, price_six_months, price_yearly,
                storage_bytes, bandwidth_mbps, bandwidth_burst_mbps, max_concurrent_streams,
                features, is_active, is_default, is_most_popular, category, sort_order,
                created_at, updated_at
            ) VALUES (
                gen_random_uuid(), 'zk_ultra', 'zk', 'ultra', 'ZK Ultra', '3TB zero-knowledge encrypted vault',
                9.99, 44.99, 79.99,
                3298534883328, 40, 80, 10,
                '{"support": "priority", "webauthn": true, "encryption": "zero_knowledge", "versioning": true, "hardware_keys": 25, "recovery_phrase": true}'::jsonb,
                TRUE, FALSE, FALSE, 'individual', 2,
                NOW(), NOW()
            );
        """
    )

    # 11. zk_max (5TB, $13.99/mo, $64.99/6mo, $119.99/yr)
    op.execute(
        """
            INSERT INTO subscription_plans (
                id, plan_code, service_type, tier_name, display_name, description,
                price_monthly, price_six_months, price_yearly,
                storage_bytes, bandwidth_mbps, bandwidth_burst_mbps, max_concurrent_streams,
                features, is_active, is_default, is_most_popular, category, sort_order,
                created_at, updated_at
            ) VALUES (
                gen_random_uuid(), 'zk_max', 'zk', 'max', 'ZK Max', '5TB zero-knowledge encrypted personal vault',
                13.99, 64.99, 119.99,
                5497558138880, 60, 120, 15,
                '{"support": "priority", "webauthn": true, "encryption": "zero_knowledge", "versioning": true, "hardware_keys": 40, "recovery_phrase": true}'::jsonb,
                TRUE, FALSE, FALSE, 'individual', 3,
                NOW(), NOW()
            );
        """
    )


def downgrade():
    """
    Rollback changes: remove new columns and restore old plans.
    """
    # Restore old plans (mark as active again)
    op.execute(
        """
            UPDATE subscription_plans
            SET is_active = TRUE
            WHERE plan_code IN (
                'normal_free', 'normal_basic', 'normal_pro', 'normal_team',
                'zk_free', 'zk_personal', 'zk_business', 'zk_enterprise'
            );
        """
    )

    # Delete new plans
    op.execute(
        """
            DELETE FROM subscription_plans
            WHERE plan_code IN (
                'normal_pro_plus', 'normal_pro_ultra', 'normal_solo_max',
                'zk_pro', 'zk_pro_plus', 'zk_ultra', 'zk_max'
            );
        """
    )

    # Remove new columns
    op.drop_column('subscription_plans', 'stripe_price_id_six_months')
    op.drop_column('subscription_plans', 'category')
    op.drop_column('subscription_plans', 'is_most_popular')
    op.drop_column('subscription_plans', 'price_six_months')
