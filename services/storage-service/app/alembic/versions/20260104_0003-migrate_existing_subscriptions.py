"""Migrate existing users to subscription system

This migration creates user_subscriptions records for all existing users
based on their current plan_type values.

Revision ID: migrate_existing_subscriptions
Revises: add_plan_id_user_subs
Create Date: 2026-01-04
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers
revision = "migrate_existing_subscriptions"
down_revision = "add_plan_id_user_subs"
branch_labels = None
depends_on = None


def upgrade():
    # =========================================================================
    # MIGRATE EXISTING USERS TO SUBSCRIPTIONS
    # =========================================================================

    # Strategy:
    # 1. For each user, find matching plan: plan_code = 'normal_' + user.plan_type
    # 2. Create user_subscriptions record with status='active'
    # 3. Update user.current_subscription_id
    # 4. Create subscription_history entry (event_type='migrated')

    # This is done in SQL for performance

    print("Starting user subscription migration...")

    # Step 1: Create subscriptions for all users
    op.execute("""
        INSERT INTO user_subscriptions (
            user_id,
            service_type,
            plan_id,
            status,
            billing_cycle,
            started_at,
            created_at
        )
        SELECT 
            u.id AS user_id,
            'normal' AS service_type,
            p.id AS plan_id,
            'active' AS status,
            NULL AS billing_cycle,  -- Free plans have no cycle
            u.created_at AS started_at,
            NOW() AS created_at
        FROM users u
        INNER JOIN subscription_plans p 
            ON p.plan_code = ('normal_' || COALESCE(u.plan_type, 'free'))
            AND p.service_type = 'normal'
            AND p.is_active = TRUE
        WHERE u.current_subscription_id IS NULL  -- Only migrate users without subscriptions
        ON CONFLICT DO NOTHING
    """)

    # Step 2: Update users.current_subscription_id
    op.execute("""
        UPDATE users u
        SET current_subscription_id = sub.id
        FROM user_subscriptions sub
        WHERE sub.user_id = u.id
            AND sub.service_type = 'normal'
            AND sub.status = 'active'
            AND u.current_subscription_id IS NULL
    """)

    # Step 3: Create subscription history records
    op.execute("""
        INSERT INTO subscription_history (
            user_id,
            service_type,
            subscription_id,
            event_type,
            to_plan_id,
            reason,
            notes,
            created_at
        )
        SELECT 
            sub.user_id,
            'normal' AS service_type,
            sub.id AS subscription_id,
            'migrated' AS event_type,
            sub.plan_id AS to_plan_id,
            'automatic_migration' AS reason,
            'Migrated from plan_type field to subscription system' AS notes,
            NOW() AS created_at
        FROM user_subscriptions sub
        WHERE sub.service_type = 'normal'
        ON CONFLICT DO NOTHING
    """)

    # Step 4: Report migration stats
    result = op.get_bind().execute(sa.text("""
        SELECT 
            COUNT(*) as total_users,
            COUNT(current_subscription_id) as migrated_users,
            COUNT(*) - COUNT(current_subscription_id) as failed_migrations
        FROM users
    """))

    stats = result.fetchone()
    print(f"""
    ✅ User subscription migration complete:
       - Total users: {stats[0]}
       - Migrated: {stats[1]}
       - Failed: {stats[2]}
    """)

    if stats[2] > 0:
        print(
            "⚠️  Some users were not migrated. Check users table for NULL current_subscription_id"
        )


def downgrade():
    # Remove subscription history entries created by migration
    op.execute("""
        DELETE FROM subscription_history
        WHERE event_type = 'migrated'
            AND reason = 'automatic_migration'
    """)

    # Clear current_subscription_id from users
    op.execute("""
        UPDATE users
        SET current_subscription_id = NULL
        WHERE current_subscription_id IS NOT NULL
    """)

    # Delete migrated subscriptions
    op.execute("""
        DELETE FROM user_subscriptions
        WHERE service_type = 'normal'
    """)

    print("Reverted subscription migration")
