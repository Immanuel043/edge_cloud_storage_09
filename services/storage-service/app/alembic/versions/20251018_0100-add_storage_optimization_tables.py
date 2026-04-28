"""add storage optimization tables

Revision ID: storage_optimization_001
Revises: ml_quota_prediction_001
Create Date: 2025-10-18 01:00:00.000000

Adds tables for ML-based storage optimization feature:
- storage_analysis: Storage usage analysis results
- optimization_suggestions: Individual optimization suggestions
- optimization_actions: Tracking of optimization actions taken
"""

from uuid import uuid4

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = "20251018_0100"
down_revision = "20251018_0000"
branch_labels = None
depends_on = None


def upgrade():
    """Add storage optimization tables"""

    # Create storage_analysis table
    op.create_table(
        "storage_analysis",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, default=uuid4),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # Overall metrics
        sa.Column("total_files", sa.Integer, nullable=False),
        sa.Column("total_size", sa.BigInteger, nullable=False),
        sa.Column("duplicate_files", sa.Integer, default=0),
        sa.Column("duplicate_size", sa.BigInteger, default=0),
        # Tier distribution
        sa.Column("cache_files", sa.Integer, default=0),
        sa.Column("cache_size", sa.BigInteger, default=0),
        sa.Column("warm_files", sa.Integer, default=0),
        sa.Column("warm_size", sa.BigInteger, default=0),
        sa.Column("cold_files", sa.Integer, default=0),
        sa.Column("cold_size", sa.BigInteger, default=0),
        # Access patterns
        sa.Column("avg_access_frequency", sa.Float, default=0.0),
        sa.Column("files_never_accessed", sa.Integer, default=0),
        sa.Column("size_never_accessed", sa.BigInteger, default=0),
        sa.Column("files_accessed_once", sa.Integer, default=0),
        sa.Column("size_accessed_once", sa.BigInteger, default=0),
        # Age analysis
        sa.Column("files_older_30d", sa.Integer, default=0),
        sa.Column("size_older_30d", sa.BigInteger, default=0),
        sa.Column("files_older_90d", sa.Integer, default=0),
        sa.Column("size_older_90d", sa.BigInteger, default=0),
        sa.Column("files_older_180d", sa.Integer, default=0),
        sa.Column("size_older_180d", sa.BigInteger, default=0),
        # Compression opportunities
        sa.Column("compressible_files", sa.Integer, default=0),
        sa.Column("compressible_size", sa.BigInteger, default=0),
        sa.Column("estimated_savings_compression", sa.BigInteger, default=0),
        # Tier migration opportunities
        sa.Column("files_to_cold", sa.Integer, default=0),
        sa.Column("size_to_cold", sa.BigInteger, default=0),
        sa.Column("estimated_savings_tiering", sa.BigInteger, default=0),
        # Total potential savings
        sa.Column("total_potential_savings", sa.BigInteger, default=0),
        # Analysis metadata
        sa.Column(
            "analysis_date",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("analysis_duration_ms", sa.Integer, default=0),
        # Indexes
        sa.Index("idx_storage_analysis_user_id", "user_id"),
        sa.Index("idx_storage_analysis_date", "analysis_date"),
    )

    # Create optimization_suggestions table
    op.create_table(
        "optimization_suggestions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, default=uuid4),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "analysis_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("storage_analysis.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Suggestion details
        sa.Column(
            "suggestion_type", sa.String(50), nullable=False
        ),  # 'tier_migration', 'deduplication', 'compression', 'cleanup'
        sa.Column("priority", sa.String(20), nullable=False),  # 'low', 'medium', 'high', 'critical'
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("description", sa.Text, nullable=False),
        # Impact estimates
        sa.Column("files_affected", sa.Integer, default=0),
        sa.Column("size_affected", sa.BigInteger, default=0),
        sa.Column("estimated_savings", sa.BigInteger, default=0),
        sa.Column("estimated_savings_percent", sa.Float, default=0.0),
        # Actions
        sa.Column(
            "action_type", sa.String(50)
        ),  # 'move_to_cold', 'delete_duplicates', 'compress', 'delete_old'
        sa.Column("action_details", postgresql.JSON),  # Specific file IDs, parameters, etc.
        # Status
        sa.Column(
            "status", sa.String(20), default="pending"
        ),  # 'pending', 'accepted', 'rejected', 'completed'
        sa.Column("is_dismissed", sa.Boolean, default=False),
        sa.Column("is_auto_applicable", sa.Boolean, default=False),
        # Timestamps
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("applied_at", sa.DateTime(timezone=True)),
        sa.Column("dismissed_at", sa.DateTime(timezone=True)),
        # Indexes
        sa.Index("idx_optimization_user_id", "user_id"),
        sa.Index("idx_optimization_type", "suggestion_type"),
        sa.Index("idx_optimization_priority", "priority"),
        sa.Index("idx_optimization_status", "status"),
        sa.Index("idx_optimization_created", "created_at"),
    )

    # Create optimization_actions table
    op.create_table(
        "optimization_actions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, default=uuid4),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "suggestion_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("optimization_suggestions.id", ondelete="SET NULL"),
            nullable=True,
        ),
        # Action details
        sa.Column("action_type", sa.String(50), nullable=False),
        sa.Column("files_processed", sa.Integer, default=0),
        sa.Column("size_processed", sa.BigInteger, default=0),
        sa.Column("actual_savings", sa.BigInteger, default=0),
        # Status
        sa.Column(
            "status", sa.String(20), default="pending"
        ),  # 'pending', 'in_progress', 'completed', 'failed'
        sa.Column("error_message", sa.Text),
        # Timestamps
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        # Indexes
        sa.Index("idx_optimization_action_user_id", "user_id"),
        sa.Index("idx_optimization_action_status", "status"),
        sa.Index("idx_optimization_action_created", "created_at"),
    )

    print("✅ Created storage optimization tables:")
    print("  - storage_analysis")
    print("  - optimization_suggestions")
    print("  - optimization_actions")


def downgrade():
    """Remove storage optimization tables"""

    op.drop_table("optimization_actions")
    op.drop_table("optimization_suggestions")
    op.drop_table("storage_analysis")

    print("⬇️  Dropped storage optimization tables")
