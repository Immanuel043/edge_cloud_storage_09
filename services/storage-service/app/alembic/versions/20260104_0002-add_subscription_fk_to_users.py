"""Add current_subscription_id FK to users table

This migration adds a foreign key from users table to user_subscriptions
to easily access a user's current subscription.

Revision ID: add_subscription_fk_to_users
Revises: create_subscription_tables
Create Date: 2026-01-04
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers
revision = "add_subscription_fk_to_users"
down_revision = "create_subscription_tables"
branch_labels = None
depends_on = None


def upgrade():
    # Add current_subscription_id column to users table
    op.add_column(
        "users", sa.Column("current_subscription_id", postgresql.UUID(as_uuid=True), nullable=True)
    )

    # Create foreign key constraint
    op.create_foreign_key(
        "fk_users_current_subscription",
        "users",
        "user_subscriptions",
        ["current_subscription_id"],
        ["id"],
        ondelete="SET NULL",
    )

    # Create index for faster lookups
    op.create_index("idx_users_current_subscription", "users", ["current_subscription_id"])

    # Add comment to plan_type column (deprecation notice)
    op.execute("""
        COMMENT ON COLUMN users.plan_type IS 
        'DEPRECATED: Use current_subscription_id instead. Kept for backward compatibility during migration.'
    """)

    print("✅ Added current_subscription_id FK to users table")


def downgrade():
    # Drop index and foreign key
    op.drop_index("idx_users_current_subscription", "users")
    op.drop_constraint("fk_users_current_subscription", "users", type_="foreignkey")
    op.drop_column("users", "current_subscription_id")

    # Remove comment
    op.execute("COMMENT ON COLUMN users.plan_type IS NULL")

    print("Removed current_subscription_id from users table")
