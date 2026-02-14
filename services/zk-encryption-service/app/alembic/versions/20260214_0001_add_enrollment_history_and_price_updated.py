"""add zk_enrollment_history table, price_updated_at and price_snapshot columns

Revision ID: 20260214_0001
Revises: 20260110_0004
Create Date: 2026-02-14

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB


# revision identifiers, used by Alembic.
revision = '20260214_0001'
down_revision = '20260110_0004'
branch_labels = None
depends_on = None


def upgrade():
    """
    1. Create zk_enrollment_history table for tracking ZK enrollment events.
    2. Add price_updated_at column to subscription_plans (parity with normal DB).
    """

    # 1. Create zk_enrollment_history table
    op.create_table(
        'zk_enrollment_history',
        sa.Column('id', UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('user_id', UUID(as_uuid=True), sa.ForeignKey('zk_users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('action', sa.String(50), nullable=False),
        sa.Column('from_tier', sa.String(50), nullable=True),
        sa.Column('to_tier', sa.String(50), nullable=True),
        sa.Column('recovery_methods_configured', sa.ARRAY(sa.String(50)), nullable=True),
        sa.Column('ip_address', sa.String(45), nullable=True),
        sa.Column('user_agent', sa.Text, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('extra_metadata', JSONB, server_default='{}'),
    )

    op.create_index(
        'idx_zk_enrollment_user_id',
        'zk_enrollment_history',
        ['user_id']
    )

    # 2. Add price_updated_at to subscription_plans
    op.add_column(
        'subscription_plans',
        sa.Column('price_updated_at', sa.DateTime(timezone=True), nullable=True)
    )

    # 3. Add price_snapshot to user_subscriptions (parity with normal DB)
    op.add_column(
        'user_subscriptions',
        sa.Column('price_snapshot', JSONB, nullable=True)
    )


def downgrade():
    """Remove zk_enrollment_history table, price_updated_at and price_snapshot columns."""

    # Drop price_snapshot column
    op.drop_column('user_subscriptions', 'price_snapshot')

    # Drop price_updated_at column
    op.drop_column('subscription_plans', 'price_updated_at')

    # Drop enrollment history table
    op.drop_index('idx_zk_enrollment_user_id', table_name='zk_enrollment_history')
    op.drop_table('zk_enrollment_history')
