"""add missing share_links columns: folder_id, share_type, view_count, allow_preview

Revision ID: 20260220_0001
Revises: 20260213_0001
Create Date: 2026-02-20

Changes:
- Add folder_id column (FK to folders.id) for folder sharing
- Add share_type column (view/download/edit)
- Add view_count column
- Add allow_preview column
- Make file_id nullable (folder-only shares have no file_id)
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

# revision identifiers, used by Alembic.
revision = "20260220_0001"
down_revision = "20260213_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("share_links", sa.Column("folder_id", UUID(as_uuid=True), nullable=True))
    op.add_column("share_links", sa.Column("share_type", sa.String(20), server_default="view"))
    op.add_column("share_links", sa.Column("view_count", sa.Integer, server_default="0"))
    op.add_column("share_links", sa.Column("allow_preview", sa.Boolean, server_default="true"))

    op.alter_column("share_links", "file_id", nullable=True)

    op.create_foreign_key(
        "share_links_folder_id_fkey",
        "share_links",
        "folders",
        ["folder_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index("idx_share_folder_id", "share_links", ["folder_id"])


def downgrade() -> None:
    op.drop_index("idx_share_folder_id", table_name="share_links")
    op.drop_constraint("share_links_folder_id_fkey", "share_links", type_="foreignkey")

    op.alter_column("share_links", "file_id", nullable=False)

    op.drop_column("share_links", "allow_preview")
    op.drop_column("share_links", "view_count")
    op.drop_column("share_links", "share_type")
    op.drop_column("share_links", "folder_id")
