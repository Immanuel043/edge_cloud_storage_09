"""fix audit_logs schema and rename metadata columns to match ORM

Revision ID: 20260110_0006
Revises: 20260110_0005
Create Date: 2026-01-10

Fixes:
1. audit_logs: Migration 20260110_0001 created with wrong schema. Drop and
   recreate matching the ORM AuditLog model (from 20251021_0002 schema).
2. security_alerts: Rename 'metadata' -> 'alert_metadata' to match ORM.
3. compliance_reports: Rename 'metadata' -> 'report_metadata' to match ORM.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB


# revision identifiers, used by Alembic.
revision = '20260110_0006'
down_revision = '20260110_0005'
branch_labels = None
depends_on = None


def upgrade():
    """Drop incorrect audit_logs and recreate with ORM-matching schema."""
    # Drop the incorrectly-schemaed table
    op.execute('DROP TABLE IF EXISTS audit_logs CASCADE')

    op.create_table(
        'audit_logs',
        sa.Column('id', UUID(as_uuid=True), primary_key=True),
        sa.Column('event_type', sa.String(100), nullable=False),
        sa.Column('event_category', sa.String(50)),
        sa.Column('event_hash', sa.String(64), nullable=False),

        # Actor
        sa.Column('user_id', UUID(as_uuid=True), sa.ForeignKey('users.id')),
        sa.Column('actor_email', sa.String(255)),
        sa.Column('actor_type', sa.String(50)),

        # Resource
        sa.Column('resource_type', sa.String(100)),
        sa.Column('resource_id', sa.String(255)),
        sa.Column('resource_name', sa.String(500)),

        # Action and result
        sa.Column('action', sa.String(100)),
        sa.Column('result', sa.String(20), nullable=False),
        sa.Column('result_message', sa.Text()),

        # Severity
        sa.Column('severity', sa.String(20), server_default='info'),
        sa.Column('impact_level', sa.String(20)),

        # Request context
        sa.Column('ip_address', sa.String(45)),
        sa.Column('user_agent', sa.Text()),
        sa.Column('request_id', sa.String(100)),
        sa.Column('session_id', sa.String(100)),
        sa.Column('request_method', sa.String(10)),
        sa.Column('request_path', sa.String(1000)),

        # Geolocation
        sa.Column('country_code', sa.String(2)),
        sa.Column('region', sa.String(100)),
        sa.Column('city', sa.String(100)),

        # Timing
        sa.Column('timestamp', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('duration_ms', sa.Integer()),

        # Additional data
        sa.Column('details', JSONB()),
        sa.Column('audit_metadata', JSONB()),

        # Compliance
        sa.Column('is_compliance_relevant', sa.Boolean(), server_default='false'),
        sa.Column('compliance_tags', JSONB()),

        # Chain linking
        sa.Column('previous_event_hash', sa.String(64)),
        sa.Column('sequence_number', sa.BigInteger()),

        # Retention
        sa.Column('retention_until', sa.DateTime(timezone=True)),
        sa.Column('is_archived', sa.Boolean(), server_default='false'),
    )

    # Create indexes matching the ORM model and 20251021_0002
    op.create_index('idx_audit_event_type', 'audit_logs', ['event_type'])
    op.create_index('idx_audit_category', 'audit_logs', ['event_category'])
    op.create_index('idx_audit_resource_id', 'audit_logs', ['resource_id'])
    op.create_index('idx_audit_action', 'audit_logs', ['action'])
    op.create_index('idx_audit_request_id', 'audit_logs', ['request_id'])
    op.create_index('idx_audit_session_id', 'audit_logs', ['session_id'])
    op.create_index('idx_audit_timestamp', 'audit_logs', ['timestamp'])
    op.create_index('idx_audit_user_time', 'audit_logs', ['user_id', 'timestamp'])
    op.create_index('idx_audit_resource', 'audit_logs', ['resource_type', 'resource_id'])
    op.create_index('idx_audit_severity_time', 'audit_logs', ['severity', 'timestamp'])
    op.create_index('idx_audit_category_time', 'audit_logs', ['event_category', 'timestamp'])
    op.create_index('idx_audit_compliance', 'audit_logs', ['is_compliance_relevant', 'timestamp'])

    # Fix security_alerts: rename 'metadata' -> 'alert_metadata' to match ORM
    conn = op.get_bind()
    result = conn.execute(sa.text(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'security_alerts' AND column_name = 'metadata'"
    ))
    if result.fetchone():
        op.alter_column('security_alerts', 'metadata',
                        new_column_name='alert_metadata',
                        existing_type=JSONB(),
                        existing_nullable=True)

    # Fix compliance_reports: rename 'metadata' -> 'report_metadata' to match ORM
    result = conn.execute(sa.text(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'compliance_reports' AND column_name = 'metadata'"
    ))
    if result.fetchone():
        op.alter_column('compliance_reports', 'metadata',
                        new_column_name='report_metadata',
                        existing_type=JSONB(),
                        existing_nullable=True)


def downgrade():
    """Reverse schema fixes."""
    # Rename back
    op.alter_column('compliance_reports', 'report_metadata',
                    new_column_name='metadata',
                    existing_type=JSONB(),
                    existing_nullable=True)
    op.alter_column('security_alerts', 'alert_metadata',
                    new_column_name='metadata',
                    existing_type=JSONB(),
                    existing_nullable=True)

    # Drop audit_logs
    op.drop_index('idx_audit_compliance', 'audit_logs')
    op.drop_index('idx_audit_category_time', 'audit_logs')
    op.drop_index('idx_audit_severity_time', 'audit_logs')
    op.drop_index('idx_audit_resource', 'audit_logs')
    op.drop_index('idx_audit_user_time', 'audit_logs')
    op.drop_index('idx_audit_timestamp', 'audit_logs')
    op.drop_index('idx_audit_session_id', 'audit_logs')
    op.drop_index('idx_audit_request_id', 'audit_logs')
    op.drop_index('idx_audit_action', 'audit_logs')
    op.drop_index('idx_audit_resource_id', 'audit_logs')
    op.drop_index('idx_audit_category', 'audit_logs')
    op.drop_index('idx_audit_event_type', 'audit_logs')
    op.drop_table('audit_logs')
