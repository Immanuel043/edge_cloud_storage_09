"""add security tables

Revision ID: 20251005_2000
Revises: 20251005_1800
Create Date: 2025-10-05 20:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = '20251005_2000'
down_revision = 'ai_analysis_001'
branch_labels = None
depends_on = None


def upgrade():
    # Create virus_scan_logs table
    op.create_table(
        'virus_scan_logs',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('file_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('objects.id', ondelete='CASCADE'), nullable=False),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('is_infected', sa.Boolean(), nullable=False, default=False),
        sa.Column('virus_name', sa.String(255), nullable=True),
        sa.Column('scan_engine', sa.String(50), default='clamav'),
        sa.Column('scan_time', sa.Float(), default=0.0),
        sa.Column('scanned_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('file_size', sa.BigInteger(), nullable=True),
        sa.Column('file_hash', sa.String(64), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('action_taken', sa.String(50), default='allowed'),
    )

    op.create_index('idx_virus_scan_file_id', 'virus_scan_logs', ['file_id'])
    op.create_index('idx_virus_scan_user_id', 'virus_scan_logs', ['user_id'])
    op.create_index('idx_virus_scan_is_infected', 'virus_scan_logs', ['is_infected'])
    op.create_index('idx_virus_scan_scanned_at', 'virus_scan_logs', ['scanned_at'])

    # Create dlp_scan_logs table
    op.create_table(
        'dlp_scan_logs',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('file_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('objects.id', ondelete='CASCADE'), nullable=False),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('has_sensitive_data', sa.Boolean(), nullable=False, default=False),
        sa.Column('risk_score', sa.Float(), default=0.0),
        sa.Column('total_matches', sa.Integer(), default=0),
        sa.Column('scan_time', sa.Float(), default=0.0),
        sa.Column('detected_types', sa.Text(), nullable=True),
        sa.Column('scanned_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('file_size', sa.BigInteger(), nullable=True),
        sa.Column('action_taken', sa.String(50), default='allowed'),
        sa.Column('blocked', sa.Boolean(), default=False),
    )

    op.create_index('idx_dlp_scan_file_id', 'dlp_scan_logs', ['file_id'])
    op.create_index('idx_dlp_scan_user_id', 'dlp_scan_logs', ['user_id'])
    op.create_index('idx_dlp_scan_has_sensitive', 'dlp_scan_logs', ['has_sensitive_data'])
    op.create_index('idx_dlp_scan_risk_score', 'dlp_scan_logs', ['risk_score'])
    op.create_index('idx_dlp_scan_scanned_at', 'dlp_scan_logs', ['scanned_at'])

    # Create audit_logs table
    op.create_table(
        'audit_logs',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('action', sa.String(100), nullable=False),
        sa.Column('resource_type', sa.String(50), nullable=True),
        sa.Column('resource_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('resource_name', sa.String(500), nullable=True),
        sa.Column('ip_address', sa.String(45), nullable=True),
        sa.Column('user_agent', sa.Text(), nullable=True),
        sa.Column('request_method', sa.String(10), nullable=True),
        sa.Column('request_path', sa.String(500), nullable=True),
        sa.Column('status', sa.String(20), nullable=False),
        sa.Column('status_code', sa.Integer(), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('context_data', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('is_suspicious', sa.Boolean(), default=False),
        sa.Column('risk_level', sa.String(20), default='low'),
    )

    op.create_index('idx_audit_user_id', 'audit_logs', ['user_id'])
    op.create_index('idx_audit_action', 'audit_logs', ['action'])
    op.create_index('idx_audit_resource_type', 'audit_logs', ['resource_type'])
    op.create_index('idx_audit_resource_id', 'audit_logs', ['resource_id'])
    op.create_index('idx_audit_created_at', 'audit_logs', ['created_at'])
    op.create_index('idx_audit_status', 'audit_logs', ['status'])
    op.create_index('idx_audit_is_suspicious', 'audit_logs', ['is_suspicious'])
    op.create_index('idx_audit_ip_address', 'audit_logs', ['ip_address'])


def downgrade():
    op.drop_table('audit_logs')
    op.drop_table('dlp_scan_logs')
    op.drop_table('virus_scan_logs')
