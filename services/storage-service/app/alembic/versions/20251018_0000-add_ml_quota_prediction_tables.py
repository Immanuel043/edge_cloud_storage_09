"""add ml quota prediction tables

Revision ID: ml_quota_prediction_001
Revises: 20251005_2000
Create Date: 2025-10-18 00:00:00.000000

Adds tables for ML-based quota prediction feature:
- storage_usage_history: Daily storage usage tracking
- quota_predictions: ML-generated predictions
- quota_alerts: User quota alerts
"""

from uuid import uuid4

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = "20251018_0000"
down_revision = "20251005_2000"
branch_labels = None
depends_on = None


def upgrade():
    """Add ML quota prediction tables"""

    # Create storage_usage_history table
    op.create_table(
        "storage_usage_history",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, default=uuid4),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("date", sa.DateTime(timezone=True), nullable=False),
        sa.Column("storage_used", sa.BigInteger, nullable=False),
        sa.Column("cache_used", sa.BigInteger, default=0),
        sa.Column("warm_used", sa.BigInteger, default=0),
        sa.Column("cold_used", sa.BigInteger, default=0),
        sa.Column("file_count", sa.Integer, default=0),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        # Add composite index for efficient queries
        sa.Index("ix_usage_history_user_date", "user_id", "date"),
        sa.UniqueConstraint("user_id", "date", name="uq_usage_history_user_date"),
    )

    # Create quota_predictions table
    op.create_table(
        "quota_predictions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, default=uuid4),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("predicted_7d", sa.BigInteger),
        sa.Column("predicted_14d", sa.BigInteger),
        sa.Column("predicted_30d", sa.BigInteger),
        sa.Column("confidence_7d", sa.Float, default=0.0),
        sa.Column("confidence_14d", sa.Float, default=0.0),
        sa.Column("confidence_30d", sa.Float, default=0.0),
        sa.Column("days_until_full", sa.Integer),
        sa.Column("model_type", sa.String(50)),  # 'prophet', 'linear_regression', 'moving_average'
        sa.Column("prediction_date", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        # Index for querying latest predictions
        sa.Index("ix_predictions_user_date", "user_id", "prediction_date"),
    )

    # Create quota_alerts table
    op.create_table(
        "quota_alerts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, default=uuid4),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "alert_type", sa.String(50), nullable=False
        ),  # '70_percent', '85_percent', '95_percent', 'predicted_full'
        sa.Column("current_usage_bytes", sa.BigInteger, nullable=False),
        sa.Column("quota_bytes", sa.BigInteger, nullable=False),
        sa.Column("usage_percent", sa.Float, nullable=False),
        sa.Column("threshold_percent", sa.Float),
        sa.Column("predicted_days_remaining", sa.Integer),
        sa.Column("is_dismissed", sa.Boolean, default=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("dismissed_at", sa.DateTime(timezone=True)),
        # Indexes for efficient queries
        sa.Index("ix_alerts_user_type", "user_id", "alert_type"),
        sa.Index("ix_alerts_user_dismissed", "user_id", "is_dismissed"),
    )

    print("✅ Created ML quota prediction tables:")
    print("  - storage_usage_history")
    print("  - quota_predictions")
    print("  - quota_alerts")


def downgrade():
    """Remove ML quota prediction tables"""

    op.drop_table("quota_alerts")
    op.drop_table("quota_predictions")
    op.drop_table("storage_usage_history")

    print("⬇️  Dropped ML quota prediction tables")
