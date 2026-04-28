"""add dedup_info column to objects table

Revision ID: 20251022_0001
Revises: 20251022_0000
Create Date: 2025-10-22 18:25:00.000000

"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSON

# revision identifiers, used by Alembic.
revision = "20251022_0001"
down_revision = "20251022_0000"
branch_labels = None
depends_on = None


def upgrade():
    """Add dedup_info column to objects table."""
    # Add dedup_info column if it doesn't exist
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name='objects' AND column_name='dedup_info'
            ) THEN
                ALTER TABLE objects ADD COLUMN dedup_info JSON;
            END IF;
        END $$;
    """)


def downgrade():
    """Remove dedup_info column from objects table."""
    op.drop_column("objects", "dedup_info")
