"""fix storage_key column length

Revision ID: 20251023_0002
Revises: 20251023_0001
Create Date: 2025-10-23 00:02:00.000000

"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "20251023_0002"
down_revision = "20251023_0001"
branch_labels = None
depends_on = None


def upgrade():
    """Change storage_key from VARCHAR(500) to TEXT to support encrypted data."""
    # Change storage_key to TEXT for unlimited length
    op.execute("""
        ALTER TABLE objects
        ALTER COLUMN storage_key TYPE TEXT;
    """)

    # Also ensure object_path can handle long paths
    op.execute("""
        ALTER TABLE objects
        ALTER COLUMN object_path TYPE TEXT;
    """)


def downgrade():
    """Revert storage_key and object_path back to VARCHAR(500)."""
    op.execute("""
        ALTER TABLE objects
        ALTER COLUMN storage_key TYPE VARCHAR(500);
    """)

    op.execute("""
        ALTER TABLE objects
        ALTER COLUMN object_path TYPE VARCHAR(500);
    """)
