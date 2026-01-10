"""create audit logs table

Revision ID: 20260110_0001
Revises: 20260109_0003
Create Date: 2026-01-10

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB


# revision identifiers, used by Alembic.
revision = '20260110_0001'
down_revision = '20260109_0002'
branch_labels = None
depends_on = None


def upgrade():
    """Create audit_logs table for comprehensive event tracking."""

    op.create_table(
        'audit_logs',
        sa.Column('id', UUID(as_uuid=True), primary_key=True),
        sa.Column('event_type', sa.String(100), nullable=False),
        sa.Column('event_timestamp', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),

        # Actor information
        sa.Column('user_id', UUID(as_uuid=True), nullable=True),
        sa.Column('admin_id', UUID(as_uuid=True), nullable=True),
        sa.Column('actor_email', sa.String(255), nullable=True),
        sa.Column('actor_ip', sa.String(45), nullable=True),

        # Resource information
        sa.Column('resource_type', sa.String(50), nullable=True),
        sa.Column('resource_id', sa.String(255), nullable=True),

        # Event details
        sa.Column('event_data', JSONB, nullable=True),
        sa.Column('previous_state', JSONB, nullable=True),
        sa.Column('new_state', JSONB, nullable=True),

        # Context
        sa.Column('gateway', sa.String(20), nullable=True),
        sa.Column('service_type', sa.String(20), nullable=True),

        # Status and notes
        sa.Column('status', sa.String(20), nullable=False, server_default='success'),
        sa.Column('error_message', sa.Text, nullable=True),
        sa.Column('notes', sa.Text, nullable=True),

        # Compliance flags
        sa.Column('retention_required', sa.Boolean, server_default='true'),
        sa.Column('retention_years', sa.Integer, server_default='7'),
    )

    # Create indexes for efficient querying
    op.create_index('idx_audit_event_type', 'audit_logs', ['event_type'])
    op.create_index('idx_audit_event_timestamp', 'audit_logs', ['event_timestamp'])
    op.create_index('idx_audit_user_id', 'audit_logs', ['user_id'])
    op.create_index('idx_audit_admin_id', 'audit_logs', ['admin_id'])
    op.create_index('idx_audit_resource_id', 'audit_logs', ['resource_id'])
    op.create_index('idx_audit_user_event', 'audit_logs', ['user_id', 'event_type'])
    op.create_index('idx_audit_resource', 'audit_logs', ['resource_type', 'resource_id'])
    op.create_index('idx_audit_gateway', 'audit_logs', ['gateway'])
    op.create_index('idx_audit_status', 'audit_logs', ['status'])


def downgrade():
    """Drop audit_logs table."""

    op.drop_index('idx_audit_status', table_name='audit_logs')
    op.drop_index('idx_audit_gateway', table_name='audit_logs')
    op.drop_index('idx_audit_resource', table_name='audit_logs')
    op.drop_index('idx_audit_user_event', table_name='audit_logs')
    op.drop_index('idx_audit_resource_id', table_name='audit_logs')
    op.drop_index('idx_audit_admin_id', table_name='audit_logs')
    op.drop_index('idx_audit_user_id', table_name='audit_logs')
    op.drop_index('idx_audit_event_timestamp', table_name='audit_logs')
    op.drop_index('idx_audit_event_type', table_name='audit_logs')
    op.drop_table('audit_logs')
