"""Initialize ZK Database Schema

Creates the complete schema for the ZK Private Vault service.
This is a SEPARATE database from the Storage Service.

Revision ID: init_zk_database
Revises: None
Create Date: 2025-12-31
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers
revision = 'init_zk_database'
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    # =========================================================================
    # ZK_USERS TABLE
    # =========================================================================
    op.create_table(
        'zk_users',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        
        # Identity (separate auth from Storage Service)
        sa.Column('email', sa.String(255), unique=True, nullable=False),
        sa.Column('username', sa.String(100), unique=True, nullable=False),
        sa.Column('password_hash', sa.String(255), nullable=False),
        
        # Plan & Quota
        sa.Column('plan_type', sa.String(20), nullable=False, server_default='free'),
        sa.Column('storage_quota', sa.BigInteger(), nullable=False, server_default='1073741824'),  # 1GB
        sa.Column('storage_used', sa.BigInteger(), nullable=False, server_default='0'),
        
        # Stripe billing
        sa.Column('stripe_customer_id', sa.String(255), nullable=True),
        sa.Column('stripe_subscription_id', sa.String(255), nullable=True),
        sa.Column('billing_status', sa.String(20), nullable=True, server_default='active'),
        
        # Account status
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('last_login_at', sa.DateTime(timezone=True), nullable=True),
        
        # Master Key (encrypted with password-derived key)
        sa.Column('encrypted_master_key', sa.Text(), nullable=True),
        sa.Column('master_key_iv', sa.Text(), nullable=True),
        
        # Key Derivation Function parameters
        sa.Column('kdf_salt', postgresql.BYTEA(), nullable=True),
        sa.Column('kdf_algorithm', sa.String(20), nullable=True, server_default='argon2id'),
        sa.Column('kdf_iterations', sa.Integer(), nullable=True, server_default='3'),
        sa.Column('kdf_memory', sa.Integer(), nullable=True, server_default='65536'),
        sa.Column('kdf_parallelism', sa.Integer(), nullable=True, server_default='4'),
        
        # Recovery
        sa.Column('recovery_phrase_enabled', sa.Boolean(), nullable=True, server_default='false'),
        sa.Column('recovery_phrase_verified', sa.Boolean(), nullable=True, server_default='false'),
        sa.Column('recovery_encrypted_master_key', sa.Text(), nullable=True),
        sa.Column('recovery_phrase_hash', sa.String(64), nullable=True),
        
        # ZK enrollment
        sa.Column('zk_enrolled_at', sa.DateTime(timezone=True), nullable=True),
    )
    
    # Indexes for zk_users
    op.create_index('idx_zk_user_email', 'zk_users', ['email'])
    op.create_index('idx_zk_user_username', 'zk_users', ['username'])
    op.create_index('idx_zk_user_plan', 'zk_users', ['plan_type'])
    op.create_index('idx_zk_user_stripe', 'zk_users', ['stripe_customer_id'])
    
    # =========================================================================
    # ZK_FOLDERS TABLE
    # =========================================================================
    op.create_table(
        'zk_folders',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), 
                  sa.ForeignKey('zk_users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('parent_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('zk_folders.id', ondelete='CASCADE'), nullable=True),
        
        # Folder name is encrypted
        sa.Column('encrypted_name', sa.Text(), nullable=False),
        sa.Column('name_iv', sa.String(255), nullable=False),
        
        # Metadata
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('is_deleted', sa.Boolean(), nullable=False, server_default='false'),
    )
    
    # Indexes for zk_folders
    op.create_index('idx_zk_folder_user', 'zk_folders', ['user_id'])
    op.create_index('idx_zk_folder_parent', 'zk_folders', ['parent_id'])
    
    # =========================================================================
    # ZK_OBJECTS TABLE
    # =========================================================================
    op.create_table(
        'zk_objects',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('zk_users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('folder_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('zk_folders.id', ondelete='SET NULL'), nullable=True),
        
        # Encrypted file name
        sa.Column('encrypted_file_name', sa.Text(), nullable=False),
        sa.Column('file_name_iv', sa.String(255), nullable=False),
        
        # Unencrypted metadata (for quota)
        sa.Column('file_size', sa.BigInteger(), nullable=False),
        sa.Column('mime_type', sa.String(100), nullable=True),
        
        # File encryption key (encrypted with master key)
        sa.Column('encrypted_file_key', sa.Text(), nullable=False),
        sa.Column('file_key_iv', sa.String(255), nullable=False),
        
        # Encryption details
        sa.Column('encryption_algorithm', sa.String(50), nullable=False, server_default='AES-256-GCM'),
        sa.Column('encryption_version', sa.Integer(), nullable=False, server_default='2'),
        
        # Storage
        sa.Column('storage_path', sa.String(500), nullable=True),
        sa.Column('chunk_info', postgresql.JSONB(), nullable=True),
        sa.Column('content_hash', sa.String(128), nullable=True),
        
        # Upload tracking
        sa.Column('upload_status', sa.String(20), nullable=False, server_default='completed'),
        sa.Column('upload_id', sa.String(255), nullable=True),
        
        # Encrypted thumbnail
        sa.Column('encrypted_thumbnail', sa.Text(), nullable=True),
        sa.Column('thumbnail_iv', sa.String(255), nullable=True),
        
        # Timestamps
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('uploaded_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('last_accessed_at', sa.DateTime(timezone=True), nullable=True),
        
        # Soft delete
        sa.Column('is_deleted', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    )
    
    # Indexes for zk_objects
    op.create_index('idx_zk_object_user', 'zk_objects', ['user_id'])
    op.create_index('idx_zk_object_folder', 'zk_objects', ['folder_id'])
    op.create_index('idx_zk_object_deleted', 'zk_objects', ['is_deleted', 'deleted_at'])
    op.create_index('idx_zk_object_upload_status', 'zk_objects', ['upload_status'])
    
    # =========================================================================
    # ZK_AUDIT_LOGS TABLE
    # =========================================================================
    op.create_table(
        'zk_audit_logs',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), nullable=True),
        
        # Action details
        sa.Column('action', sa.String(50), nullable=False),
        sa.Column('success', sa.Boolean(), nullable=False),
        sa.Column('error_message', sa.Text(), nullable=True),
        
        # Request context
        sa.Column('ip_address', sa.String(45), nullable=True),
        sa.Column('user_agent', sa.Text(), nullable=True),
        
        # Timestamp
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    
    # Indexes for zk_audit_logs
    op.create_index('idx_zk_audit_user', 'zk_audit_logs', ['user_id'])
    op.create_index('idx_zk_audit_action', 'zk_audit_logs', ['action'])
    op.create_index('idx_zk_audit_time', 'zk_audit_logs', ['created_at'])


def downgrade():
    # Drop tables in reverse order (respecting foreign keys)
    op.drop_table('zk_audit_logs')
    op.drop_table('zk_objects')
    op.drop_table('zk_folders')
    op.drop_table('zk_users')

