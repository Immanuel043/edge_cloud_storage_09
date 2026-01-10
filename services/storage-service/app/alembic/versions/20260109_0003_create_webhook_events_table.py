"""create webhook events table for idempotency

Revision ID: 20260109_0003
Revises: 20260109_0002
Create Date: 2026-01-09

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB


# revision identifiers, used by Alembic.
revision = '20260109_0003'
down_revision = '20260109_0002'
branch_labels = None
depends_on = None


def upgrade():
    """Create webhook_events table for idempotency tracking."""

    op.create_table(
        'webhook_events',
        sa.Column('id', UUID(as_uuid=True), primary_key=True),
        sa.Column('event_id', sa.String(255), nullable=False),
        sa.Column('gateway', sa.String(20), nullable=False),
        sa.Column('event_type', sa.String(100), nullable=False),
        sa.Column('status', sa.String(20), nullable=False, server_default='processed'),
        sa.Column('payload', JSONB, nullable=False),
        sa.Column('ip_address', sa.String(45), nullable=True),
        sa.Column('processed_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('error_message', sa.Text, nullable=True),
    )

    # Create indexes
    op.create_index('idx_webhook_event_id', 'webhook_events', ['event_id'], unique=True)
    op.create_index('idx_webhook_gateway', 'webhook_events', ['gateway'])
    op.create_index('idx_webhook_event_type', 'webhook_events', ['event_type'])
    op.create_index('idx_webhook_gateway_event_type', 'webhook_events', ['gateway', 'event_type'])
    op.create_index('idx_webhook_processed_at', 'webhook_events', ['processed_at'])


def downgrade():
    """Drop webhook_events table."""

    op.drop_index('idx_webhook_processed_at', table_name='webhook_events')
    op.drop_index('idx_webhook_gateway_event_type', table_name='webhook_events')
    op.drop_index('idx_webhook_event_type', table_name='webhook_events')
    op.drop_index('idx_webhook_gateway', table_name='webhook_events')
    op.drop_index('idx_webhook_event_id', table_name='webhook_events')
    op.drop_table('webhook_events')
