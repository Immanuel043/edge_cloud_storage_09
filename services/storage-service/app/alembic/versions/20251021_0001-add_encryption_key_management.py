"""add encryption key management tables

Revision ID: 20251021_0001
Revises: 20251020_0001
Create Date: 2025-10-21 14:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from datetime import datetime

# revision identifiers, used by Alembic.
revision = '20251021_0001'
down_revision = '20251020_0001'
branch_labels = None
depends_on = None


def upgrade():
    # Create encryption_key_versions table
    op.create_table(
        'encryption_key_versions',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('version', sa.Integer(), nullable=False, unique=True),
        sa.Column('status', sa.String(20), nullable=False, server_default='active'),
        sa.Column('key_algorithm', sa.String(50), server_default='AES-256-GCM'),
        sa.Column('key_source', sa.String(100)),
        sa.Column('key_purpose', sa.String(50), server_default='data_encryption'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('activated_at', sa.DateTime(timezone=True)),
        sa.Column('deprecated_at', sa.DateTime(timezone=True)),
        sa.Column('retired_at', sa.DateTime(timezone=True)),
        sa.Column('rotated_by_user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id')),
        sa.Column('rotation_reason', sa.Text()),
        sa.Column('predecessor_version', sa.Integer()),
        sa.Column('objects_encrypted', sa.BigInteger(), server_default='0'),
        sa.Column('last_used_at', sa.DateTime(timezone=True)),
        sa.Column('metadata', postgresql.JSONB()),
    )

    # Create indexes for encryption_key_versions
    op.create_index('idx_key_version_status', 'encryption_key_versions', ['version', 'status'])

    # Create key_rotation_history table
    op.create_table(
        'key_rotation_history',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('old_key_version', sa.Integer(), nullable=False),
        sa.Column('new_key_version', sa.Integer(), nullable=False),
        sa.Column('rotation_type', sa.String(50), nullable=False),
        sa.Column('initiated_by_user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id')),
        sa.Column('initiated_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('status', sa.String(20), server_default='in_progress'),
        sa.Column('completed_at', sa.DateTime(timezone=True)),
        sa.Column('objects_to_reencrypt', sa.BigInteger(), server_default='0'),
        sa.Column('objects_reencrypted', sa.BigInteger(), server_default='0'),
        sa.Column('reencryption_progress', sa.Float(), server_default='0.0'),
        sa.Column('errors_encountered', sa.Integer(), server_default='0'),
        sa.Column('error_details', postgresql.JSONB()),
        sa.Column('reason', sa.Text()),
        sa.Column('metadata', postgresql.JSONB()),
    )

    # Create indexes for key_rotation_history
    op.create_index('idx_rotation_status', 'key_rotation_history', ['status'])
    op.create_index('idx_rotation_date', 'key_rotation_history', ['initiated_at'])

    # Create data_reencryption_queue table
    op.create_table(
        'data_reencryption_queue',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('object_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('objects.id', ondelete='CASCADE')),
        sa.Column('object_type', sa.String(50), server_default='file'),
        sa.Column('current_key_version', sa.Integer(), nullable=False),
        sa.Column('target_key_version', sa.Integer(), nullable=False),
        sa.Column('rotation_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('key_rotation_history.id')),
        sa.Column('status', sa.String(20), server_default='pending'),
        sa.Column('priority', sa.Integer(), server_default='5'),
        sa.Column('queued_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('started_at', sa.DateTime(timezone=True)),
        sa.Column('completed_at', sa.DateTime(timezone=True)),
        sa.Column('retry_count', sa.Integer(), server_default='0'),
        sa.Column('max_retries', sa.Integer(), server_default='3'),
        sa.Column('last_error', sa.Text()),
        sa.Column('error_metadata', postgresql.JSONB()),
        sa.Column('metadata', postgresql.JSONB()),
    )

    # Create indexes for data_reencryption_queue
    op.create_index('idx_reencrypt_status', 'data_reencryption_queue', ['status'])
    op.create_index('idx_reencrypt_priority', 'data_reencryption_queue',
                    ['priority', 'queued_at'])
    op.create_index('idx_reencrypt_rotation', 'data_reencryption_queue', ['rotation_id'])

    # Insert initial key version record
    from uuid import uuid4
    op.execute(f"""
        INSERT INTO encryption_key_versions (
            id, version, status, key_algorithm, key_source, key_purpose,
            activated_at, objects_encrypted, metadata
        ) VALUES (
            '{uuid4()}', 1, 'active', 'AES-256-GCM', 'configuration',
            'data_encryption', NOW(), 0, '{{}}'::jsonb
        )
    """)


def downgrade():
    # Drop indexes first
    op.drop_index('idx_reencrypt_rotation', 'data_reencryption_queue')
    op.drop_index('idx_reencrypt_priority', 'data_reencryption_queue')
    op.drop_index('idx_reencrypt_status', 'data_reencryption_queue')
    op.drop_index('idx_rotation_date', 'key_rotation_history')
    op.drop_index('idx_rotation_status', 'key_rotation_history')
    op.drop_index('idx_key_version_status', 'encryption_key_versions')

    # Drop tables
    op.drop_table('data_reencryption_queue')
    op.drop_table('key_rotation_history')
    op.drop_table('encryption_key_versions')
