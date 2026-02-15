"""create hardware_keys, social_recovery_contacts, and recovery_attempts tables

Revision ID: 20260215_0001
Revises: 20260214_0001
Create Date: 2026-02-15

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB


# revision identifiers, used by Alembic.
revision = '20260215_0001'
down_revision = '20260214_0001'
branch_labels = None
depends_on = None


def upgrade():
    """
    Create three recovery-related tables:
    1. hardware_keys - FIDO2/WebAuthn hardware security keys
    2. social_recovery_contacts - Trusted contacts for Shamir Secret Sharing recovery
    3. recovery_attempts - Security audit log for all recovery attempts
    """

    # 1. Create hardware_keys table
    op.create_table(
        'hardware_keys',
        sa.Column('id', UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('user_id', UUID(as_uuid=True), sa.ForeignKey('zk_users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('key_name', sa.String(100), nullable=False),
        sa.Column('credential_id', sa.Text, nullable=False, unique=True),
        sa.Column('public_key', sa.Text, nullable=False),
        sa.Column('aaguid', sa.String(36), nullable=True),
        sa.Column('sign_count', sa.Integer, nullable=False, server_default='0'),
        sa.Column('encrypted_master_key', sa.Text, nullable=False),
        sa.Column('transports', sa.ARRAY(sa.String(20)), nullable=True),
        sa.Column('is_primary', sa.Boolean, nullable=False, server_default='false'),
        sa.Column('is_backup', sa.Boolean, nullable=False, server_default='false'),
        sa.Column('last_used_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('extra_metadata', JSONB, server_default='{}'),
    )

    op.create_index('idx_hardware_keys_user_id', 'hardware_keys', ['user_id'])
    op.create_index('idx_hardware_keys_credential_id', 'hardware_keys', ['credential_id'])

    # 2. Create social_recovery_contacts table
    op.create_table(
        'social_recovery_contacts',
        sa.Column('id', UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('user_id', UUID(as_uuid=True), sa.ForeignKey('zk_users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('contact_email', sa.String(255), nullable=False),
        sa.Column('contact_name', sa.String(100), nullable=True),
        sa.Column('share_number', sa.Integer, nullable=False),
        sa.Column('encrypted_share', sa.Text, nullable=False),
        sa.Column('status', sa.String(20), nullable=False, server_default='pending'),
        sa.Column('verification_token', sa.String(64), nullable=True),
        sa.Column('verified_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('last_notified_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('extra_metadata', JSONB, server_default='{}'),
    )

    op.create_index('idx_social_recovery_user_id', 'social_recovery_contacts', ['user_id'])

    # 3. Create recovery_attempts table
    op.create_table(
        'recovery_attempts',
        sa.Column('id', UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('user_id', UUID(as_uuid=True), sa.ForeignKey('zk_users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('recovery_method', sa.String(50), nullable=False),
        sa.Column('success', sa.Boolean, nullable=False),
        sa.Column('ip_address', sa.String(45), nullable=True),
        sa.Column('user_agent', sa.Text, nullable=True),
        sa.Column('error_message', sa.Text, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('extra_metadata', JSONB, server_default='{}'),
    )

    op.create_index('idx_recovery_attempts_user_id', 'recovery_attempts', ['user_id'])
    op.create_index('idx_recovery_attempts_created_at', 'recovery_attempts', ['created_at'])


def downgrade():
    """Drop recovery-related tables."""

    # Drop recovery_attempts
    op.drop_index('idx_recovery_attempts_created_at', table_name='recovery_attempts')
    op.drop_index('idx_recovery_attempts_user_id', table_name='recovery_attempts')
    op.drop_table('recovery_attempts')

    # Drop social_recovery_contacts
    op.drop_index('idx_social_recovery_user_id', table_name='social_recovery_contacts')
    op.drop_table('social_recovery_contacts')

    # Drop hardware_keys
    op.drop_index('idx_hardware_keys_credential_id', table_name='hardware_keys')
    op.drop_index('idx_hardware_keys_user_id', table_name='hardware_keys')
    op.drop_table('hardware_keys')
