"""add is_admin column to users

Revision ID: 20260110_0004
Revises: 20260110_0003
Create Date: 2026-01-10

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '20260110_0004'
down_revision = '20260110_0003'
branch_labels = None
depends_on = None


def upgrade():
    """Add is_admin boolean column to users table."""
    op.execute(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE"
    )


def downgrade():
    """Remove is_admin column from users table."""
    op.drop_column('users', 'is_admin')
