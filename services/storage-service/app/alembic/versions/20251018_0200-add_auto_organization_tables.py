"""add auto-organization tables

Revision ID: auto_organization_001
Revises: storage_optimization_001
Create Date: 2025-10-18 02:00:00.000000

Adds tables for ML-based auto-organization feature:
- organization_clusters: ML clustering results
- file_cluster_assignments: File-to-cluster mapping
- organization_rules: User/ML organization rules
- organization_sessions: Organization session tracking
"""

from uuid import uuid4

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = "20251018_0200a"
down_revision = "20251018_0100"
branch_labels = None
depends_on = None


def upgrade():
    """Add auto-organization tables"""

    # Create organization_clusters table
    op.create_table(
        "organization_clusters",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, default=uuid4),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # Cluster details
        sa.Column("cluster_id", sa.Integer, nullable=False),
        sa.Column("cluster_name", sa.String(255), nullable=False),
        sa.Column("cluster_description", sa.Text),
        # ML metadata
        sa.Column("algorithm", sa.String(50), nullable=False),  # kmeans, dbscan
        sa.Column("num_files", sa.Integer, default=0),
        sa.Column("total_size", sa.BigInteger, default=0),
        # Representative features
        sa.Column("top_keywords", postgresql.JSON),
        sa.Column("common_extensions", postgresql.JSON),
        sa.Column("date_range_start", sa.DateTime(timezone=True)),
        sa.Column("date_range_end", sa.DateTime(timezone=True)),
        # Quality metrics
        sa.Column("silhouette_score", sa.Float),
        sa.Column("cohesion_score", sa.Float),
        # Suggested folder
        sa.Column("suggested_folder_path", sa.String(500)),
        # Status
        sa.Column("is_applied", sa.Boolean, default=False),
        sa.Column("is_dismissed", sa.Boolean, default=False),
        # Timestamps
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("applied_at", sa.DateTime(timezone=True)),
        sa.Column("dismissed_at", sa.DateTime(timezone=True)),
        # Indexes
        sa.Index("idx_org_cluster_user_id", "user_id"),
        sa.Index("idx_org_cluster_algorithm", "algorithm"),
        sa.Index("idx_org_cluster_applied", "is_applied"),
        sa.Index("idx_org_cluster_created", "created_at"),
        sa.UniqueConstraint("user_id", "cluster_id", "created_at", name="unique_user_cluster"),
    )

    # Create file_cluster_assignments table
    op.create_table(
        "file_cluster_assignments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, default=uuid4),
        sa.Column(
            "file_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("objects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "cluster_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("organization_clusters.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Assignment confidence
        sa.Column("confidence_score", sa.Float, default=1.0),
        sa.Column("distance_to_centroid", sa.Float),
        # Feature vector
        sa.Column("feature_vector", postgresql.JSON),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        # Indexes
        sa.Index("idx_file_cluster_file_id", "file_id"),
        sa.Index("idx_file_cluster_cluster_id", "cluster_id"),
        sa.Index("idx_file_cluster_user_id", "user_id"),
    )

    # Create organization_rules table
    op.create_table(
        "organization_rules",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, default=uuid4),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # Rule definition
        sa.Column("rule_name", sa.String(255), nullable=False),
        sa.Column(
            "rule_type", sa.String(50), nullable=False
        ),  # pattern, extension, date, ml_cluster
        # Pattern matching
        sa.Column("pattern", sa.String(500)),
        sa.Column("file_extensions", postgresql.JSON),
        sa.Column("keywords", postgresql.JSON),
        # Date-based rules
        sa.Column("date_field", sa.String(50)),
        sa.Column("date_range_days", sa.Integer),
        # Target folder
        sa.Column("target_folder_path", sa.String(500), nullable=False),
        sa.Column("create_subfolder_by_date", sa.Boolean, default=False),
        # Rule behavior
        sa.Column("is_active", sa.Boolean, default=True),
        sa.Column("auto_apply", sa.Boolean, default=False),
        sa.Column("priority", sa.Integer, default=0),
        # Statistics
        sa.Column("files_organized", sa.Integer, default=0),
        sa.Column("last_applied_at", sa.DateTime(timezone=True)),
        # Source
        sa.Column("source", sa.String(50), default="user"),  # user, ml, suggested
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("updated_at", sa.DateTime(timezone=True), onupdate=sa.func.now()),
        # Indexes
        sa.Index("idx_org_rule_user_id", "user_id"),
        sa.Index("idx_org_rule_type", "rule_type"),
        sa.Index("idx_org_rule_active", "is_active"),
        sa.Index("idx_org_rule_priority", "priority"),
    )

    # Create organization_sessions table
    op.create_table(
        "organization_sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, default=uuid4),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # Session details
        sa.Column(
            "session_type", sa.String(50), nullable=False
        ),  # ml_clustering, rule_based, manual
        sa.Column("algorithm", sa.String(50)),  # kmeans, dbscan
        # Parameters
        sa.Column("num_clusters", sa.Integer),
        sa.Column("min_files", sa.Integer),
        # Results
        sa.Column("files_analyzed", sa.Integer, default=0),
        sa.Column("files_organized", sa.Integer, default=0),
        sa.Column("clusters_created", sa.Integer, default=0),
        sa.Column("folders_created", sa.Integer, default=0),
        # Quality metrics
        sa.Column("avg_silhouette_score", sa.Float),
        # Status
        sa.Column(
            "status", sa.String(20), default="pending"
        ),  # pending, running, completed, failed
        sa.Column("error_message", sa.Text),
        # Timestamps
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        # Indexes
        sa.Index("idx_org_session_user_id", "user_id"),
        sa.Index("idx_org_session_status", "status"),
        sa.Index("idx_org_session_created", "created_at"),
    )

    print("✅ Created auto-organization tables:")
    print("  - organization_clusters")
    print("  - file_cluster_assignments")
    print("  - organization_rules")
    print("  - organization_sessions")


def downgrade():
    """Remove auto-organization tables"""

    op.drop_table("organization_sessions")
    op.drop_table("organization_rules")
    op.drop_table("file_cluster_assignments")
    op.drop_table("organization_clusters")

    print("⬇️  Dropped auto-organization tables")
