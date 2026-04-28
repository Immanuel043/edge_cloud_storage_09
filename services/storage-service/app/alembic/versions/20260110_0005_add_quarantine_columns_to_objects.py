"""add quarantine columns to objects

Revision ID: 20260110_0005
Revises: 20260110_0004
Create Date: 2026-01-10

"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "20260110_0005"
down_revision = "20260110_0004"
branch_labels = None
depends_on = None


def upgrade():
    """Add quarantine columns to objects table for virus scanner integration."""
    op.execute(
        "ALTER TABLE objects ADD COLUMN IF NOT EXISTS is_quarantined BOOLEAN NOT NULL DEFAULT FALSE"
    )
    op.execute("ALTER TABLE objects ADD COLUMN IF NOT EXISTS quarantined_at TIMESTAMPTZ")
    op.execute("ALTER TABLE objects ADD COLUMN IF NOT EXISTS quarantine_reason VARCHAR(500)")
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_objects_quarantined ON objects(is_quarantined) WHERE is_quarantined = TRUE"
    )


def downgrade():
    """Remove quarantine columns from objects table."""
    op.execute("DROP INDEX IF EXISTS idx_objects_quarantined")
    op.drop_column("objects", "quarantine_reason")
    op.drop_column("objects", "quarantined_at")
    op.drop_column("objects", "is_quarantined")
