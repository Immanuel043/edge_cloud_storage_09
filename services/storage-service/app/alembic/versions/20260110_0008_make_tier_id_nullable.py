"""make tier_id nullable on user_subscriptions

Revision ID: 20260110_0008
Revises: 20260110_0007
Create Date: 2026-01-10

The tier_id column was created as NOT NULL by migration 20251101_0000
(old ZK subscription schema). It has been superseded by plan_id which
references subscription_plans. Make tier_id nullable so create_subscription
works without requiring the legacy column.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


# revision identifiers, used by Alembic.
revision = '20260110_0008'
down_revision = '20260110_0007'
branch_labels = None
depends_on = None


def upgrade():
    """Make tier_id nullable since plan_id is the canonical reference."""
    op.execute(
        "ALTER TABLE user_subscriptions ALTER COLUMN tier_id DROP NOT NULL"
    )


def downgrade():
    """Restore tier_id NOT NULL constraint."""
    op.execute(
        "ALTER TABLE user_subscriptions ALTER COLUMN tier_id SET NOT NULL"
    )
