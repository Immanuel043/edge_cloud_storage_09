"""add file_metadata column to objects table

Revision ID: 20251022_0000
Revises: 20251021_0003
Create Date: 2025-10-22 04:20:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

# revision identifiers, used by Alembic.
revision = '20251022_0000'
down_revision = '20251021_0003'
branch_labels = None
depends_on = None


def upgrade():
    """Add file_metadata column to objects table."""
    # Add file_metadata column if it doesn't exist
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name='objects' AND column_name='file_metadata'
            ) THEN
                ALTER TABLE objects ADD COLUMN file_metadata JSONB;
            END IF;
        END $$;
    """)


def downgrade():
    """Remove file_metadata column from objects table."""
    op.drop_column('objects', 'file_metadata')
