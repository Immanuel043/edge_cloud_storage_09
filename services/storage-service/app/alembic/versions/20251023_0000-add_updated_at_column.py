"""add updated_at column to objects table

Revision ID: 20251023_0000
Revises: 20251022_0001
Create Date: 2025-10-23 00:00:00.000000

"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.sql import func

# revision identifiers, used by Alembic.
revision = "20251023_0000"
down_revision = "20251022_0001"
branch_labels = None
depends_on = None


def upgrade():
    """Add updated_at column to objects table."""
    # Add updated_at column if it doesn't exist
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name='objects' AND column_name='updated_at'
            ) THEN
                ALTER TABLE objects ADD COLUMN updated_at TIMESTAMP DEFAULT NOW();
                -- Set existing records' updated_at to their created_at
                UPDATE objects SET updated_at = created_at WHERE updated_at IS NULL;
            END IF;
        END $$;
    """)


def downgrade():
    """Remove updated_at column from objects table."""
    op.drop_column("objects", "updated_at")
