"""add trial and payment method fields

Revision ID: 20260110_0002
Revises: 20260110_0001
Create Date: 2026-01-10

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '20260110_0002'
down_revision = '20260110_0001'
branch_labels = None
depends_on = None


def upgrade():
    """Add trial period tracking and payment method fields."""

    # Rename trial_ends_at to trial_end for consistency
    op.alter_column(
        'user_subscriptions',
        'trial_ends_at',
        new_column_name='trial_end',
        existing_type=sa.DateTime(timezone=True),
        existing_nullable=True
    )

    # Add trial_start field
    op.add_column(
        'user_subscriptions',
        sa.Column('trial_start', sa.DateTime(timezone=True), nullable=True)
    )

    # Add payment method fields for auto-conversion
    op.add_column(
        'user_subscriptions',
        sa.Column('stripe_payment_method_id', sa.String(255), nullable=True)
    )

    op.add_column(
        'user_subscriptions',
        sa.Column('razorpay_payment_method_id', sa.String(255), nullable=True)
    )

    # Add cancelled_at field for tracking
    op.add_column(
        'user_subscriptions',
        sa.Column('cancelled_at', sa.DateTime(timezone=True), nullable=True)
    )

    # Create index on trial_end for efficient expiry queries
    op.create_index(
        'idx_user_subscriptions_trial_end',
        'user_subscriptions',
        ['trial_end']
    )


def downgrade():
    """Remove trial and payment method fields."""

    op.drop_index('idx_user_subscriptions_trial_end', table_name='user_subscriptions')

    op.drop_column('user_subscriptions', 'cancelled_at')
    op.drop_column('user_subscriptions', 'razorpay_payment_method_id')
    op.drop_column('user_subscriptions', 'stripe_payment_method_id')
    op.drop_column('user_subscriptions', 'trial_start')

    # Rename back
    op.alter_column(
        'user_subscriptions',
        'trial_end',
        new_column_name='trial_ends_at',
        existing_type=sa.DateTime(timezone=True),
        existing_nullable=True
    )
