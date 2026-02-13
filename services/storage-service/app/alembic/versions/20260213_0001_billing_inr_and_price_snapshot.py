"""billing: INR currency default, price_snapshot, price_updated_at

Revision ID: 20260213_0001
Revises: 20260110_0008
Create Date: 2026-02-13

Changes:
- Update all subscription_plans to use INR currency
- Add price_snapshot JSONB column to user_subscriptions
- Add price_updated_at timestamp to subscription_plans
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


# revision identifiers, used by Alembic.
revision = '20260213_0001'
down_revision = '20260110_0008'
branch_labels = None
depends_on = None


def upgrade():
    """Add price snapshot support and fix currency to INR."""

    # 1. Fix currency to INR on existing plans
    op.execute(
        "UPDATE subscription_plans SET currency = 'INR' WHERE currency = 'USD' OR currency IS NULL"
    )
    op.alter_column(
        'subscription_plans', 'currency',
        server_default='INR',
        existing_type=sa.String(3),
        existing_nullable=True
    )

    # 2. Add price_snapshot JSONB to user_subscriptions
    # Captures exact price at time of purchase so price changes don't affect existing subscribers
    op.add_column(
        'user_subscriptions',
        sa.Column('price_snapshot', JSONB, nullable=True)
    )

    # 3. Add price_updated_at to subscription_plans
    # Tracks when admin last updated prices (for audit trail)
    op.add_column(
        'subscription_plans',
        sa.Column('price_updated_at', sa.DateTime(timezone=True), nullable=True)
    )


def downgrade():
    """Reverse price snapshot and INR changes."""

    # Remove price_updated_at from plans
    op.drop_column('subscription_plans', 'price_updated_at')

    # Remove price_snapshot from subscriptions
    op.drop_column('user_subscriptions', 'price_snapshot')

    # Revert currency default (back to USD)
    op.alter_column(
        'subscription_plans', 'currency',
        server_default='USD',
        existing_type=sa.String(3),
        existing_nullable=True
    )
    op.execute(
        "UPDATE subscription_plans SET currency = 'USD' WHERE currency = 'INR'"
    )
