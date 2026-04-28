"""add_favorites_table

Revision ID: 20251020_0000
Revises: 20251018_0200b
Create Date: 2025-10-20

"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = "20251020_0000"
down_revision = "20251018_0200b"
branch_labels = None
depends_on = None


def upgrade():
    # Create favorites table
    op.create_table(
        "favorites",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "file_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("objects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),  # Optional user notes
        # Unique constraint: user can favorite a file only once
        sa.UniqueConstraint("user_id", "file_id", name="uq_user_file_favorite"),
        # Indexes for performance
        sa.Index("idx_favorites_user_id", "user_id"),
        sa.Index("idx_favorites_file_id", "file_id"),
        sa.Index("idx_favorites_created_at", "created_at"),
    )

    # Update objects table: Ensure last_accessed is indexed for recents queries
    op.create_index("idx_objects_last_accessed", "objects", ["last_accessed"], if_not_exists=True)
    op.create_index(
        "idx_objects_user_last_accessed",
        "objects",
        ["user_id", "last_accessed"],
        if_not_exists=True,
    )


def downgrade():
    # Drop indexes on objects table
    op.drop_index("idx_objects_user_last_accessed", "objects", if_exists=True)
    op.drop_index("idx_objects_last_accessed", "objects", if_exists=True)

    # Drop favorites table
    op.drop_table("favorites")
