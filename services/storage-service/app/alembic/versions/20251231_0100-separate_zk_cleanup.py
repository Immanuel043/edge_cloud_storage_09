"""Separate ZK from Storage Service - Cleanup

This migration:
1. Renames user_type to plan_type
2. Removes ZK-related columns from users table
3. Removes ZK-related columns from objects table
4. Adds Stripe billing columns

Revision ID: separate_zk_cleanup
Revises: 20251231_0000-add_plan_quota_fields
Create Date: 2025-12-31

IMPORTANT: Run the ZK data migration script BEFORE this migration!
    python scripts/migrate_zk_to_separate_db.py --execute
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers
revision = 'separate_zk_cleanup'
down_revision = '20251231_0000'
branch_labels = None
depends_on = None


def upgrade():
    # =========================================================================
    # USERS TABLE - Remove ZK columns, add billing columns
    # =========================================================================
    
    # Step 1: Rename user_type to plan_type
    op.alter_column('users', 'user_type', new_column_name='plan_type')
    
    # Step 2: Add Stripe billing columns
    op.add_column('users', sa.Column('stripe_customer_id', sa.String(255), nullable=True))
    op.add_column('users', sa.Column('stripe_subscription_id', sa.String(255), nullable=True))
    op.add_column('users', sa.Column('billing_status', sa.String(20), nullable=True, server_default='active'))
    
    # Step 3: Create index for Stripe lookups
    op.create_index('idx_users_stripe_customer', 'users', ['stripe_customer_id'])
    
    # Step 4: Remove ZK columns from users table
    # Note: These are nullable, so safe to drop
    columns_to_drop = [
        'zk_storage_quota',
        'zk_storage_used',
        'zk_enabled',
        'encrypted_master_key',
        'kdf_salt',
        'kdf_algorithm',
        'kdf_iterations',
        'recovery_phrase_enabled',
        'recovery_encrypted_master_key',
        'recovery_phrase_hash',
    ]
    
    for col in columns_to_drop:
        try:
            op.drop_column('users', col)
        except Exception as e:
            print(f"Column {col} may not exist, skipping: {e}")
    
    # =========================================================================
    # OBJECTS TABLE - Remove ZK encryption columns
    # =========================================================================
    
    zk_object_columns = [
        'is_encrypted',
        'encrypted_file_key',
        'file_key_iv',
        'encryption_algorithm',
        'encryption_version',
        'upload_status',
        'upload_id',
        'uploaded_at',
        'file_hash',
    ]
    
    for col in zk_object_columns:
        try:
            op.drop_column('objects', col)
        except Exception as e:
            print(f"Column {col} may not exist in objects, skipping: {e}")
    
    # =========================================================================
    # UPDATE encryption_mode constraint
    # =========================================================================
    
    # Update any 'client_zk' rows to 'none' (they should have been migrated)
    op.execute("""
        UPDATE objects 
        SET encryption_mode = 'none' 
        WHERE encryption_mode = 'client_zk'
    """)


def downgrade():
    # =========================================================================
    # OBJECTS TABLE - Restore ZK columns
    # =========================================================================
    
    op.add_column('objects', sa.Column('is_encrypted', sa.Boolean(), nullable=True, server_default='false'))
    op.add_column('objects', sa.Column('encrypted_file_key', sa.Text(), nullable=True))
    op.add_column('objects', sa.Column('file_key_iv', sa.String(255), nullable=True))
    op.add_column('objects', sa.Column('encryption_algorithm', sa.String(50), nullable=True))
    op.add_column('objects', sa.Column('encryption_version', sa.Integer(), nullable=True))
    op.add_column('objects', sa.Column('upload_status', sa.String(20), nullable=True))
    op.add_column('objects', sa.Column('upload_id', sa.String(255), nullable=True))
    op.add_column('objects', sa.Column('uploaded_at', sa.DateTime(), nullable=True))
    op.add_column('objects', sa.Column('file_hash', sa.String(128), nullable=True))
    
    # =========================================================================
    # USERS TABLE - Restore ZK columns
    # =========================================================================
    
    op.add_column('users', sa.Column('zk_storage_quota', sa.BigInteger(), nullable=True, server_default='0'))
    op.add_column('users', sa.Column('zk_storage_used', sa.BigInteger(), nullable=True, server_default='0'))
    op.add_column('users', sa.Column('zk_enabled', sa.Boolean(), nullable=True, server_default='false'))
    op.add_column('users', sa.Column('encrypted_master_key', sa.Text(), nullable=True))
    op.add_column('users', sa.Column('kdf_salt', postgresql.BYTEA(), nullable=True))
    op.add_column('users', sa.Column('kdf_algorithm', sa.String(20), nullable=True))
    op.add_column('users', sa.Column('kdf_iterations', sa.Integer(), nullable=True))
    op.add_column('users', sa.Column('recovery_phrase_enabled', sa.Boolean(), nullable=True, server_default='false'))
    op.add_column('users', sa.Column('recovery_encrypted_master_key', sa.Text(), nullable=True))
    op.add_column('users', sa.Column('recovery_phrase_hash', sa.String(64), nullable=True))
    
    # Drop Stripe columns
    op.drop_index('idx_users_stripe_customer', 'users')
    op.drop_column('users', 'billing_status')
    op.drop_column('users', 'stripe_subscription_id')
    op.drop_column('users', 'stripe_customer_id')
    
    # Rename plan_type back to user_type
    op.alter_column('users', 'plan_type', new_column_name='user_type')

