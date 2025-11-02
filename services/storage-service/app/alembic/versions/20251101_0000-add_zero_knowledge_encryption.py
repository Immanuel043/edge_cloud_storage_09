"""add_zero_knowledge_encryption_support

Revision ID: 20251101_0000
Revises: 20251023_0003
Create Date: 2025-11-01

Adds support for Zero-Knowledge Encryption as an optional premium feature.
Users can opt-in to client-side encryption where the server never has access
to encryption keys or plaintext data.

Changes:
- Add ZK opt-in fields to users table
- Add subscription tier tracking
- Add recovery mechanism fields
- Add hardware key support
- Add client-encrypted flag to objects
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = '20251101_0000'
down_revision = '20251023_0003'
branch_labels = None
depends_on = None


def upgrade():
    # ========== SUBSCRIPTION TIERS TABLE ==========
    op.create_table(
        'subscription_tiers',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('name', sa.String(50), nullable=False, unique=True),
        sa.Column('display_name', sa.String(100), nullable=False),
        sa.Column('price_monthly', sa.Numeric(10, 2), nullable=False),
        sa.Column('price_yearly', sa.Numeric(10, 2), nullable=False),
        sa.Column('storage_quota_bytes', sa.BigInteger, nullable=False),
        sa.Column('features', postgresql.JSONB, nullable=False, server_default='{}'),
        sa.Column('is_active', sa.Boolean, nullable=False, server_default='true'),
        sa.Column('sort_order', sa.Integer, nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), onupdate=sa.func.now()),
    )

    # Insert default tiers
    op.execute("""
        INSERT INTO subscription_tiers (name, display_name, price_monthly, price_yearly, storage_quota_bytes, features, sort_order) VALUES
        ('free', 'Free', 0.00, 0.00, 10737418240, '{"zk_encryption": false, "hardware_keys": false, "priority_support": false}', 1),
        ('pro', 'Pro', 9.99, 99.00, 107374182400, '{"zk_encryption": true, "hardware_keys": false, "priority_support": true, "recovery_phrase": true}', 2),
        ('premium', 'Premium', 19.99, 199.00, 1099511627776, '{"zk_encryption": true, "hardware_keys": true, "priority_support": true, "recovery_phrase": true, "social_recovery": true, "version_history": true}', 3),
        ('enterprise', 'Enterprise', 49.00, 490.00, -1, '{"zk_encryption": true, "hardware_keys": true, "priority_support": true, "recovery_phrase": true, "social_recovery": true, "version_history": true, "sso": true, "admin_dashboard": true, "sla": true}', 4)
    """)

    # ========== USER SUBSCRIPTIONS TABLE ==========
    op.create_table(
        'user_subscriptions',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('tier_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('subscription_tiers.id'), nullable=False),
        sa.Column('billing_cycle', sa.String(20), nullable=False, server_default='monthly'),
        sa.Column('status', sa.String(20), nullable=False, server_default='active'),
        sa.Column('started_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('cancelled_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('payment_method', sa.String(50), nullable=True),
        sa.Column('last_payment_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('next_payment_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('metadata', postgresql.JSONB, server_default='{}'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), onupdate=sa.func.now()),
    )

    op.create_index('idx_user_subscriptions_user_id', 'user_subscriptions', ['user_id'])
    op.create_index('idx_user_subscriptions_status', 'user_subscriptions', ['status'])

    # ========== ADD ZK FIELDS TO USERS TABLE ==========
    op.add_column('users', sa.Column('zk_enabled', sa.Boolean, nullable=False, server_default='false'))
    op.add_column('users', sa.Column('zk_enrolled_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('users', sa.Column('encrypted_master_key', sa.Text, nullable=True))
    op.add_column('users', sa.Column('kdf_salt', sa.LargeBinary, nullable=True))
    op.add_column('users', sa.Column('kdf_algorithm', sa.String(20), nullable=False, server_default='pbkdf2'))
    op.add_column('users', sa.Column('kdf_iterations', sa.Integer, nullable=False, server_default='600000'))
    op.add_column('users', sa.Column('kdf_memory', sa.Integer, nullable=True))  # For Argon2
    op.add_column('users', sa.Column('kdf_parallelism', sa.Integer, nullable=True))  # For Argon2
    op.add_column('users', sa.Column('zk_version', sa.Integer, nullable=False, server_default='1'))

    # Recovery mechanisms
    op.add_column('users', sa.Column('recovery_phrase_enabled', sa.Boolean, nullable=False, server_default='false'))
    op.add_column('users', sa.Column('recovery_encrypted_master_key', sa.Text, nullable=True))
    op.add_column('users', sa.Column('recovery_phrase_hash', sa.String(64), nullable=True))  # SHA-256 of phrase (for verification)
    op.add_column('users', sa.Column('recovery_phrase_created_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('users', sa.Column('recovery_phrase_verified', sa.Boolean, nullable=False, server_default='false'))

    # Create indexes for ZK users
    op.create_index('idx_users_zk_enabled', 'users', ['zk_enabled'], postgresql_where=sa.text('zk_enabled = true'))

    # ========== HARDWARE KEYS TABLE (FIDO2/WebAuthn) ==========
    op.create_table(
        'hardware_keys',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('key_name', sa.String(100), nullable=False),
        sa.Column('credential_id', sa.Text, nullable=False, unique=True),
        sa.Column('public_key', sa.Text, nullable=False),
        sa.Column('aaguid', sa.String(36), nullable=True),
        sa.Column('sign_count', sa.Integer, nullable=False, server_default='0'),
        sa.Column('encrypted_master_key', sa.Text, nullable=False),  # Master key encrypted with hardware key
        sa.Column('transports', postgresql.ARRAY(sa.String(20)), nullable=True),
        sa.Column('is_primary', sa.Boolean, nullable=False, server_default='false'),
        sa.Column('is_backup', sa.Boolean, nullable=False, server_default='false'),
        sa.Column('last_used_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('metadata', postgresql.JSONB, server_default='{}'),
    )

    op.create_index('idx_hardware_keys_user_id', 'hardware_keys', ['user_id'])
    op.create_index('idx_hardware_keys_credential_id', 'hardware_keys', ['credential_id'])

    # ========== SOCIAL RECOVERY TABLE ==========
    op.create_table(
        'social_recovery_contacts',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('contact_email', sa.String(255), nullable=False),
        sa.Column('contact_name', sa.String(100), nullable=True),
        sa.Column('share_number', sa.Integer, nullable=False),  # Which share (1-5)
        sa.Column('encrypted_share', sa.Text, nullable=False),  # Shamir secret share
        sa.Column('status', sa.String(20), nullable=False, server_default='pending'),
        sa.Column('verification_token', sa.String(64), nullable=True),
        sa.Column('verified_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('last_notified_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('metadata', postgresql.JSONB, server_default='{}'),
    )

    op.create_index('idx_social_recovery_user_id', 'social_recovery_contacts', ['user_id'])
    op.create_unique_constraint('uq_social_recovery_user_share', 'social_recovery_contacts', ['user_id', 'share_number'])

    # ========== RECOVERY ATTEMPTS TABLE (Security Logging) ==========
    op.create_table(
        'recovery_attempts',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('recovery_method', sa.String(50), nullable=False),  # phrase/hardware/social
        sa.Column('success', sa.Boolean, nullable=False),
        sa.Column('ip_address', sa.String(45), nullable=True),
        sa.Column('user_agent', sa.Text, nullable=True),
        sa.Column('error_message', sa.Text, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('metadata', postgresql.JSONB, server_default='{}'),
    )

    op.create_index('idx_recovery_attempts_user_id', 'recovery_attempts', ['user_id'])
    op.create_index('idx_recovery_attempts_created_at', 'recovery_attempts', ['created_at'])

    # ========== ADD CLIENT-ENCRYPTED FLAG TO OBJECTS ==========
    op.add_column('objects', sa.Column('client_encrypted', sa.Boolean, nullable=False, server_default='false'))
    op.add_column('objects', sa.Column('encryption_metadata', postgresql.JSONB, nullable=True))

    # Create index for filtering ZK files
    op.create_index('idx_objects_client_encrypted', 'objects', ['client_encrypted'], postgresql_where=sa.text('client_encrypted = true'))

    # ========== ZK ENROLLMENT HISTORY ==========
    op.create_table(
        'zk_enrollment_history',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('action', sa.String(50), nullable=False),  # enabled/disabled/upgraded
        sa.Column('from_tier', sa.String(50), nullable=True),
        sa.Column('to_tier', sa.String(50), nullable=True),
        sa.Column('recovery_methods_configured', postgresql.ARRAY(sa.String(50)), nullable=True),
        sa.Column('ip_address', sa.String(45), nullable=True),
        sa.Column('user_agent', sa.Text, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('metadata', postgresql.JSONB, server_default='{}'),
    )

    op.create_index('idx_zk_enrollment_user_id', 'zk_enrollment_history', ['user_id'])


def downgrade():
    # Drop indexes
    op.drop_index('idx_zk_enrollment_user_id', 'zk_enrollment_history')
    op.drop_index('idx_objects_client_encrypted', 'objects')
    op.drop_index('idx_recovery_attempts_created_at', 'recovery_attempts')
    op.drop_index('idx_recovery_attempts_user_id', 'recovery_attempts')
    op.drop_index('idx_social_recovery_user_id', 'social_recovery_contacts')
    op.drop_index('idx_hardware_keys_credential_id', 'hardware_keys')
    op.drop_index('idx_hardware_keys_user_id', 'hardware_keys')
    op.drop_index('idx_users_zk_enabled', 'users')
    op.drop_index('idx_user_subscriptions_status', 'user_subscriptions')
    op.drop_index('idx_user_subscriptions_user_id', 'user_subscriptions')

    # Drop tables
    op.drop_table('zk_enrollment_history')
    op.drop_table('recovery_attempts')
    op.drop_table('social_recovery_contacts')
    op.drop_table('hardware_keys')
    op.drop_table('user_subscriptions')
    op.drop_table('subscription_tiers')

    # Remove columns from objects
    op.drop_column('objects', 'encryption_metadata')
    op.drop_column('objects', 'client_encrypted')

    # Remove columns from users
    op.drop_column('users', 'recovery_phrase_verified')
    op.drop_column('users', 'recovery_phrase_created_at')
    op.drop_column('users', 'recovery_phrase_hash')
    op.drop_column('users', 'recovery_encrypted_master_key')
    op.drop_column('users', 'recovery_phrase_enabled')
    op.drop_column('users', 'zk_version')
    op.drop_column('users', 'kdf_parallelism')
    op.drop_column('users', 'kdf_memory')
    op.drop_column('users', 'kdf_iterations')
    op.drop_column('users', 'kdf_algorithm')
    op.drop_column('users', 'kdf_salt')
    op.drop_column('users', 'encrypted_master_key')
    op.drop_column('users', 'zk_enrolled_at')
    op.drop_column('users', 'zk_enabled')
