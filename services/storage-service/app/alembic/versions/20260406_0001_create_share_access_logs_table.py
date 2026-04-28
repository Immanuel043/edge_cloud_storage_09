"""Create share_access_logs table for share analytics

Revision ID: 20260406_0001
Revises: 20260327_0001
Create Date: 2026-04-06
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

# revision identifiers
revision = "20260406_0001"
down_revision = "20260327_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "share_access_logs",
        sa.Column(
            "id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")
        ),
        sa.Column(
            "share_link_id",
            UUID(as_uuid=True),
            sa.ForeignKey("share_links.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "bundle_id",
            UUID(as_uuid=True),
            sa.ForeignKey("share_bundles.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("access_type", sa.String(30), nullable=False),
        sa.Column("ip_address", sa.String(45), nullable=True),
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.Column("file_id", UUID(as_uuid=True), nullable=True),
        sa.Column("accessed_at", sa.DateTime(), server_default=sa.text("NOW()"), index=False),
    )
    op.create_index("idx_access_log_share_link", "share_access_logs", ["share_link_id"])
    op.create_index("idx_access_log_bundle", "share_access_logs", ["bundle_id"])
    op.create_index("idx_access_log_accessed_at", "share_access_logs", ["accessed_at"])


def downgrade() -> None:
    op.drop_index("idx_access_log_accessed_at", table_name="share_access_logs")
    op.drop_index("idx_access_log_bundle", table_name="share_access_logs")
    op.drop_index("idx_access_log_share_link", table_name="share_access_logs")
    op.drop_table("share_access_logs")
