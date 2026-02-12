"""add missing tables: share_bundles, share_bundle_files, upload_sessions

Revision ID: 20260110_0007
Revises: 20260110_0006
Create Date: 2026-01-10

These tables were defined in the ORM model (database.py) but never had
alembic migrations to create them.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB


# revision identifiers, used by Alembic.
revision = '20260110_0007'
down_revision = '20260110_0006'
branch_labels = None
depends_on = None


def upgrade():
    """Create share_bundles, share_bundle_files, and upload_sessions tables."""

    # --- share_bundles ---
    op.execute("DROP TABLE IF EXISTS share_bundle_files CASCADE")
    op.execute("DROP TABLE IF EXISTS share_bundles CASCADE")

    op.create_table(
        'share_bundles',
        sa.Column('id', UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),

        # Bundle metadata
        sa.Column('name', sa.String(255), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),

        # Share token
        sa.Column('share_token', sa.String(64), unique=True, nullable=False),

        # Sharing settings
        sa.Column('share_type', sa.String(20), server_default='view'),
        sa.Column('password_hash', sa.String(255), nullable=True),
        sa.Column('expires_at', sa.DateTime(), nullable=True),
        sa.Column('max_downloads', sa.Integer(), nullable=True),
        sa.Column('download_count', sa.Integer(), server_default='0'),
        sa.Column('view_count', sa.Integer(), server_default='0'),
        sa.Column('is_active', sa.Boolean(), server_default='true'),
        sa.Column('allow_preview', sa.Boolean(), server_default='true'),

        # Bundle-specific settings
        sa.Column('allow_zip_download', sa.Boolean(), server_default='true'),
        sa.Column('show_file_sizes', sa.Boolean(), server_default='true'),

        # Statistics
        sa.Column('total_size', sa.BigInteger(), server_default='0'),
        sa.Column('file_count', sa.Integer(), server_default='0'),

        # Timestamps
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('last_accessed', sa.DateTime(), nullable=True),
    )

    op.create_index('idx_bundle_token', 'share_bundles', ['share_token'])
    op.create_index('idx_bundle_user', 'share_bundles', ['user_id'])
    op.create_index('idx_bundle_active', 'share_bundles', ['is_active'])
    op.create_index('idx_bundle_created', 'share_bundles', ['created_at'])

    # --- share_bundle_files ---
    op.create_table(
        'share_bundle_files',
        sa.Column('id', UUID(as_uuid=True), primary_key=True),
        sa.Column('bundle_id', UUID(as_uuid=True), sa.ForeignKey('share_bundles.id', ondelete='CASCADE'), nullable=False),
        sa.Column('file_id', UUID(as_uuid=True), sa.ForeignKey('objects.id', ondelete='CASCADE'), nullable=False),

        # Order within bundle
        sa.Column('display_order', sa.Integer(), server_default='0'),

        # Folder path for structure display
        sa.Column('folder_path', sa.String(1024), nullable=True),

        # Timestamps
        sa.Column('added_at', sa.DateTime(timezone=True), server_default=sa.func.now()),

        sa.UniqueConstraint('bundle_id', 'file_id', name='unique_bundle_file'),
    )

    op.create_index('idx_bundle_file_bundle', 'share_bundle_files', ['bundle_id'])
    op.create_index('idx_bundle_file_file', 'share_bundle_files', ['file_id'])

    # --- upload_sessions ---
    op.execute("DROP TABLE IF EXISTS upload_sessions CASCADE")

    op.create_table(
        'upload_sessions',
        sa.Column('upload_id', sa.String(64), primary_key=True),
        sa.Column('user_id', UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('session_data', JSONB(), nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.func.now()),
        sa.Column('expires_at', sa.DateTime(), nullable=False),
    )

    op.create_index('idx_upload_session_user_id', 'upload_sessions', ['user_id'])


def downgrade():
    """Drop share_bundles, share_bundle_files, and upload_sessions tables."""
    op.drop_index('idx_upload_session_user_id', 'upload_sessions')
    op.drop_table('upload_sessions')

    op.drop_index('idx_bundle_file_file', 'share_bundle_files')
    op.drop_index('idx_bundle_file_bundle', 'share_bundle_files')
    op.drop_table('share_bundle_files')

    op.drop_index('idx_bundle_created', 'share_bundles')
    op.drop_index('idx_bundle_active', 'share_bundles')
    op.drop_index('idx_bundle_user', 'share_bundles')
    op.drop_index('idx_bundle_token', 'share_bundles')
    op.drop_table('share_bundles')
