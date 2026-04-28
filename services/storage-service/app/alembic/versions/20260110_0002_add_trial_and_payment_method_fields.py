"""add trial and payment method fields

Revision ID: 20260110_0002
Revises: 20260110_0001
Create Date: 2026-01-10

"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "20260110_0002"
down_revision = "20260110_0001"
branch_labels = None
depends_on = None


def upgrade():
    """Add trial period tracking and payment method fields."""

    # Use raw SQL with IF NOT EXISTS guards to handle columns that may already exist
    # from earlier migrations (20251101_0000, create_subscription_tables)
    conn = op.get_bind()

    # Rename trial_ends_at to trial_end (only if trial_ends_at exists and trial_end doesn't)
    result = conn.execute(
        sa.text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'user_subscriptions' AND column_name = 'trial_ends_at'"
        )
    )
    if result.fetchone():
        op.alter_column(
            "user_subscriptions",
            "trial_ends_at",
            new_column_name="trial_end",
            existing_type=sa.DateTime(timezone=True),
            existing_nullable=True,
        )

    # Add columns only if they don't already exist
    op.execute("ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS trial_start TIMESTAMPTZ")
    op.execute("ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS trial_end TIMESTAMPTZ")
    op.execute(
        "ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS stripe_payment_method_id VARCHAR(255)"
    )
    op.execute(
        "ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS razorpay_payment_method_id VARCHAR(255)"
    )
    op.execute("ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ")

    # Create index (only if it doesn't exist)
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_user_subscriptions_trial_end "
        "ON user_subscriptions (trial_end)"
    )


def downgrade():
    """Remove trial and payment method fields."""

    op.drop_index("idx_user_subscriptions_trial_end", table_name="user_subscriptions")

    op.drop_column("user_subscriptions", "cancelled_at")
    op.drop_column("user_subscriptions", "razorpay_payment_method_id")
    op.drop_column("user_subscriptions", "stripe_payment_method_id")
    op.drop_column("user_subscriptions", "trial_start")

    # Rename back
    op.alter_column(
        "user_subscriptions",
        "trial_end",
        new_column_name="trial_ends_at",
        existing_type=sa.DateTime(timezone=True),
        existing_nullable=True,
    )
