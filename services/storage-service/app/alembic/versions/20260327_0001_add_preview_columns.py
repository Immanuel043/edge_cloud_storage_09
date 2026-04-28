"""Add preview_generated_at and preview_content_hash columns to objects table

Revision ID: 20260327_0001
Revises: 20260324_0001
Create Date: 2026-03-27
"""

import sqlalchemy as sa
from alembic import op

# revision identifiers
revision = "20260327_0001"
down_revision = "20260324_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("objects", sa.Column("preview_generated_at", sa.DateTime(), nullable=True))
    op.add_column("objects", sa.Column("preview_content_hash", sa.String(64), nullable=True))


def downgrade() -> None:
    op.drop_column("objects", "preview_content_hash")
    op.drop_column("objects", "preview_generated_at")
