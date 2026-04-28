"""add_shared_access_table

Revision ID: da9af03487c9
Revises: 31f08c8dbc4a
Create Date: 2025-11-16 03:46:46.378835

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

# revision identifiers, used by Alembic.
revision: str = "da9af03487c9"
down_revision: Union[str, None] = "31f08c8dbc4a"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "shared_access",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("owner_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("shared_with_email", sa.String(255), nullable=False),
        sa.Column(
            "shared_with_user_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True
        ),
        sa.Column(
            "file_id",
            UUID(as_uuid=True),
            sa.ForeignKey("objects.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "folder_id",
            UUID(as_uuid=True),
            sa.ForeignKey("folders.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("permission", sa.String(20), server_default="view"),
        sa.Column("invitation_status", sa.String(20), server_default="pending"),
        sa.Column("invitation_token", sa.String(64), unique=True, nullable=True),
        sa.Column("expires_at", sa.DateTime, nullable=True),
        sa.Column("created_at", sa.DateTime, server_default=sa.text("now()")),
        sa.Column("accepted_at", sa.DateTime, nullable=True),
    )

    # Create indexes
    op.create_index("idx_shared_email", "shared_access", ["shared_with_email"])
    op.create_index("idx_shared_user", "shared_access", ["shared_with_user_id"])
    op.create_index("idx_shared_owner", "shared_access", ["owner_id"])
    op.create_index("idx_shared_file", "shared_access", ["file_id"])
    op.create_index("idx_shared_folder", "shared_access", ["folder_id"])
    op.create_index("idx_invitation_token", "shared_access", ["invitation_token"])


def downgrade() -> None:
    op.drop_index("idx_invitation_token", "shared_access")
    op.drop_index("idx_shared_folder", "shared_access")
    op.drop_index("idx_shared_file", "shared_access")
    op.drop_index("idx_shared_owner", "shared_access")
    op.drop_index("idx_shared_user", "shared_access")
    op.drop_index("idx_shared_email", "shared_access")
    op.drop_table("shared_access")
