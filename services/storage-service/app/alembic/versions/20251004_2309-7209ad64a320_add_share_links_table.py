"""add_share_links_table

Revision ID: 7209ad64a320
Revises: 6dc45c27a477
Create Date: 2025-10-04 23:09:03.852935

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "7209ad64a320"
down_revision: Union[str, None] = "6dc45c27a477"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "share_links",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("share_token", sa.String(64), nullable=False, unique=True, index=True),
        sa.Column(
            "file_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("objects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column("password_hash", sa.String(255), nullable=True),
        sa.Column("expires_at", sa.DateTime, nullable=True),
        sa.Column("max_downloads", sa.Integer, nullable=True),
        sa.Column("download_count", sa.Integer, default=0, server_default="0"),
        sa.Column("is_active", sa.Boolean, default=True, server_default="true"),
        sa.Column("created_at", sa.DateTime, server_default=sa.text("now()")),
        sa.Column("last_accessed", sa.DateTime, nullable=True),
    )

    # Create indexes
    op.create_index("idx_share_token", "share_links", ["share_token"])
    op.create_index("idx_share_file_id", "share_links", ["file_id"])
    op.create_index("idx_share_user_id", "share_links", ["user_id"])
    op.create_index("idx_share_active", "share_links", ["is_active"])


def downgrade() -> None:
    op.drop_index("idx_share_active", "share_links")
    op.drop_index("idx_share_user_id", "share_links")
    op.drop_index("idx_share_file_id", "share_links")
    op.drop_index("idx_share_token", "share_links")
    op.drop_table("share_links")
