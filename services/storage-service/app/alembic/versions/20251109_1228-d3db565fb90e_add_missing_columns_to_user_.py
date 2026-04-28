"""add missing columns to user_interactions table

Revision ID: d3db565fb90e
Revises: 20251112_0000
Create Date: 2025-11-09 12:28:48.129525

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d3db565fb90e"
down_revision: Union[str, None] = "20251112_0000"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add missing columns to user_interactions table
    op.add_column(
        "user_interactions",
        sa.Column("interaction_count", sa.Integer(), server_default="0", nullable=False),
    )
    op.add_column(
        "user_interactions",
        sa.Column("last_interaction_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "user_interactions",
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    # Remove columns added in upgrade
    op.drop_column("user_interactions", "updated_at")
    op.drop_column("user_interactions", "last_interaction_at")
    op.drop_column("user_interactions", "interaction_count")
