"""add health_status + health_checked_at to objects

Revision ID: 20260430_0001
Revises: 20260407_0001
Create Date: 2026-04-30

Adds two columns used by the storage_reconcile_worker to flag Object rows
whose chunks have gone missing from disk:
- health_status:      'healthy' | 'degraded' | 'broken' (default 'healthy')
- health_checked_at:  timestamp of last reconciliation check
"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "20260430_0001"
down_revision = "20260407_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    existing = (
        conn.execute(
            sa.text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'objects' "
                "AND column_name IN ('health_status', 'health_checked_at')"
            )
        )
        .scalars()
        .all()
    )

    if "health_status" not in existing:
        op.add_column(
            "objects",
            sa.Column(
                "health_status",
                sa.String(20),
                nullable=False,
                server_default="healthy",
            ),
        )
        op.create_index(
            "idx_objects_health_status",
            "objects",
            ["health_status"],
            postgresql_where=sa.text("health_status <> 'healthy'"),
        )

    if "health_checked_at" not in existing:
        op.add_column(
            "objects",
            sa.Column("health_checked_at", sa.DateTime, nullable=True),
        )


def downgrade() -> None:
    conn = op.get_bind()
    existing = (
        conn.execute(
            sa.text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'objects' "
                "AND column_name IN ('health_status', 'health_checked_at')"
            )
        )
        .scalars()
        .all()
    )

    if "health_status" in existing:
        op.drop_index("idx_objects_health_status", table_name="objects")
        op.drop_column("objects", "health_status")
    if "health_checked_at" in existing:
        op.drop_column("objects", "health_checked_at")
