"""add deleted_at column to objects

Revision ID: 20251108_0000
Revises: 20251101_0000
Create Date: 2025-11-08

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '20251108_0000'
down_revision = '20251101_0000'
branch_labels = None
depends_on = None


def upgrade():
    """Add is_deleted and deleted_at columns to objects table for trash functionality"""
    # Add is_deleted column if it doesn't exist
    op.execute("ALTER TABLE objects ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE")

    # Add deleted_at column if it doesn't exist
    op.execute("ALTER TABLE objects ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE")

    # Create index for trash queries
    op.execute("CREATE INDEX IF NOT EXISTS idx_objects_is_deleted_deleted_at ON objects(is_deleted, deleted_at)")


def downgrade():
    """Remove is_deleted and deleted_at columns from objects table"""
    op.execute("DROP INDEX IF EXISTS idx_objects_is_deleted_deleted_at")
    op.execute("ALTER TABLE objects DROP COLUMN IF EXISTS deleted_at")
    op.execute("ALTER TABLE objects DROP COLUMN IF EXISTS is_deleted")
