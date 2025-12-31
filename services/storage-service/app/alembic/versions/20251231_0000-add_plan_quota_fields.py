"""add plan quota and bandwidth override fields to users table

Revision ID: 20251231_0000
Revises: 20251224_0000
Create Date: 2025-12-31

Adds columns for plan-based split storage quotas and admin bandwidth overrides:
- User.zk_storage_quota: Zero-Knowledge storage quota in bytes
- User.zk_storage_used: Zero-Knowledge storage currently used in bytes
- User.bandwidth_limit_mbps: Admin override for bandwidth limit (NULL = use plan default)
- User.bandwidth_burst_mbps: Admin override for burst bandwidth (NULL = use plan default)
- User.max_concurrent_streams: Admin override for max streams (NULL = use plan default)
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '20251231_0000'
down_revision = '20251224_0000'
branch_labels = None
depends_on = None


def upgrade():
    """Add plan quota and bandwidth override columns to users table"""

    # Add ZK storage quota column (default 0 for free tier)
    op.execute("""
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS zk_storage_quota BIGINT DEFAULT 0 NOT NULL
    """)

    # Add ZK storage used column
    op.execute("""
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS zk_storage_used BIGINT DEFAULT 0 NOT NULL
    """)

    # Add bandwidth limit override column (NULL = use plan default)
    op.execute("""
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS bandwidth_limit_mbps INTEGER DEFAULT NULL
    """)

    # Add bandwidth burst override column (NULL = use plan default)
    op.execute("""
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS bandwidth_burst_mbps INTEGER DEFAULT NULL
    """)

    # Add max concurrent streams override column (NULL = use plan default)
    op.execute("""
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS max_concurrent_streams INTEGER DEFAULT NULL
    """)

    # Create index for finding users with custom bandwidth limits (admin overrides)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_users_bandwidth_override
        ON users(bandwidth_limit_mbps)
        WHERE bandwidth_limit_mbps IS NOT NULL
    """)

    # Update existing users based on their user_type to set ZK quotas
    # Free tier: 0 GB ZK
    op.execute("""
        UPDATE users SET zk_storage_quota = 0
        WHERE user_type = 'free' OR user_type IS NULL
    """)

    # Individual tier: 300 GB ZK
    op.execute("""
        UPDATE users SET zk_storage_quota = 322122547200
        WHERE user_type = 'individual'
    """)

    # Creator tier: 1 TB ZK
    op.execute("""
        UPDATE users SET zk_storage_quota = 1099511627776
        WHERE user_type = 'creator'
    """)

    # Business tier: 2 TB ZK
    op.execute("""
        UPDATE users SET zk_storage_quota = 2199023255552
        WHERE user_type = 'business'
    """)


def downgrade():
    """Remove plan quota and bandwidth override columns from users table"""
    # Drop index first
    op.execute("DROP INDEX IF EXISTS idx_users_bandwidth_override")

    # Drop columns from users table
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS max_concurrent_streams")
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS bandwidth_burst_mbps")
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS bandwidth_limit_mbps")
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS zk_storage_used")
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS zk_storage_quota")
