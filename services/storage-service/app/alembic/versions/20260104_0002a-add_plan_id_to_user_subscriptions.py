"""Add plan_id to user_subscriptions when missing (legacy schema from 20251101_0000)

When user_subscriptions was created by the older ZK migration (20251101_0000),
it had tier_id instead of plan_id. The create_subscription_tables migration
uses CREATE TABLE IF NOT EXISTS so it does not alter that table. This migration
adds plan_id so migrate_existing_subscriptions can run.

Revision ID: add_plan_id_user_subs
Revises: add_subscription_fk_to_users
Create Date: 2026-01-04

"""
from alembic import op

revision = 'add_plan_id_user_subs'
down_revision = 'add_subscription_fk_to_users'
branch_labels = None
depends_on = None


def upgrade():
    # user_subscriptions may already exist from 20251101_0000 with tier_id only.
    # Ensure plan_id exists for the migrate_existing_subscriptions step.
    op.execute("""
        ALTER TABLE user_subscriptions
        ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES subscription_plans(id)
    """)


def downgrade():
    # Only drop if we're reverting; leave data intact.
    op.execute("ALTER TABLE user_subscriptions DROP COLUMN IF EXISTS plan_id")
