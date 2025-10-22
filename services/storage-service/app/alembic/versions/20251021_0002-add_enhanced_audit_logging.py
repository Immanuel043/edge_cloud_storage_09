"""add enhanced audit logging tables

Revision ID: 20251021_0002
Revises: 20251021_0001
Create Date: 2025-10-21 16:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = '20251021_0002'
down_revision = '20251021_0001'
branch_labels = None
depends_on = None


def upgrade():
    # Drop old audit_logs table if it exists
    op.execute('DROP TABLE IF EXISTS audit_logs CASCADE')

    # Create audit_logs table
    op.create_table(
        'audit_logs',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('event_type', sa.String(100), nullable=False),
        sa.Column('event_category', sa.String(50)),
        sa.Column('event_hash', sa.String(64), nullable=False),

        # Actor
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id')),
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
        sa.Column('details', postgresql.JSONB()),
        sa.Column('metadata', postgresql.JSONB()),

        # Compliance
        sa.Column('is_compliance_relevant', sa.Boolean(), server_default='false'),
        sa.Column('compliance_tags', postgresql.JSONB()),

        # Chain linking
        sa.Column('previous_event_hash', sa.String(64)),
        sa.Column('sequence_number', sa.BigInteger()),

        # Retention
        sa.Column('retention_until', sa.DateTime(timezone=True)),
        sa.Column('is_archived', sa.Boolean(), server_default='false'),
    )

    # Create indexes for audit_logs
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

    # Create security_alerts table
    op.create_table(
        'security_alerts',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('alert_type', sa.String(100), nullable=False),
        sa.Column('severity', sa.String(20), nullable=False),
        sa.Column('status', sa.String(20), server_default='open'),
        sa.Column('trigger_event_id', postgresql.UUID(as_uuid=True)),
        sa.Column('trigger_pattern', sa.String(200)),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id')),
        sa.Column('ip_address', sa.String(45)),
        sa.Column('title', sa.String(500), nullable=False),
        sa.Column('description', sa.Text()),
        sa.Column('evidence', postgresql.JSONB()),
        sa.Column('risk_score', sa.Float()),
        sa.Column('first_seen', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('last_seen', sa.DateTime(timezone=True)),
        sa.Column('detected_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('assigned_to_user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id')),
        sa.Column('investigated_at', sa.DateTime(timezone=True)),
        sa.Column('resolved_at', sa.DateTime(timezone=True)),
        sa.Column('resolution', sa.Text()),
        sa.Column('actions_taken', postgresql.JSONB()),
        sa.Column('metadata', postgresql.JSONB()),
    )

    # Create indexes for security_alerts
    op.create_index('idx_alert_status_severity', 'security_alerts', ['status', 'severity'])
    op.create_index('idx_alert_user', 'security_alerts', ['user_id'])
    op.create_index('idx_alert_detected', 'security_alerts', ['detected_at'])

    # Create compliance_reports table
    op.create_table(
        'compliance_reports',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('report_type', sa.String(50), nullable=False),
        sa.Column('report_period_start', sa.DateTime(timezone=True), nullable=False),
        sa.Column('report_period_end', sa.DateTime(timezone=True), nullable=False),
        sa.Column('generated_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('generated_by_user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id')),
        sa.Column('status', sa.String(20), server_default='draft'),
        sa.Column('summary', postgresql.JSONB()),
        sa.Column('findings', postgresql.JSONB()),
        sa.Column('recommendations', postgresql.JSONB()),
        sa.Column('event_count', sa.Integer()),
        sa.Column('compliance_score', sa.Float()),
        sa.Column('issues_found', sa.Integer(), server_default='0'),
        sa.Column('issues_resolved', sa.Integer(), server_default='0'),
        sa.Column('report_file_path', sa.String(1000)),
        sa.Column('metadata', postgresql.JSONB()),
    )

    # Create indexes for compliance_reports
    op.create_index('idx_report_type_period', 'compliance_reports',
                    ['report_type', 'report_period_start'])
    op.create_index('idx_report_generated', 'compliance_reports', ['generated_at'])


def downgrade():
    # Drop indexes first
    op.drop_index('idx_report_generated', 'compliance_reports')
    op.drop_index('idx_report_type_period', 'compliance_reports')
    op.drop_index('idx_alert_detected', 'security_alerts')
    op.drop_index('idx_alert_user', 'security_alerts')
    op.drop_index('idx_alert_status_severity', 'security_alerts')

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

    # Drop tables
    op.drop_table('compliance_reports')
    op.drop_table('security_alerts')
    op.drop_table('audit_logs')
