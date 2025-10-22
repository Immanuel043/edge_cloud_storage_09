"""add content recommendations tables

Revision ID: content_recommendations_001
Revises: storage_optimization_001
Create Date: 2025-10-18 02:00:00.000000

Adds tables for ML-based content recommendations feature:
- file_similarities: Pre-computed file similarity scores
- user_interactions: User interaction tracking for collaborative filtering
- recommendations: Generated recommendations
- recommendation_feedback: User feedback on recommendations
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from uuid import uuid4


# revision identifiers, used by Alembic.
revision = '20251018_0200b'
down_revision = '20251018_0200a'
branch_labels = None
depends_on = None


def upgrade():
    """Add content recommendations tables"""

    # Create file_similarities table
    op.create_table(
        'file_similarities',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, default=uuid4),
        sa.Column('file_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('objects.id', ondelete='CASCADE'), nullable=False, index=True),
        sa.Column('similar_file_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('objects.id', ondelete='CASCADE'), nullable=False, index=True),

        # Similarity metrics
        sa.Column('similarity_score', sa.Float, nullable=False),  # 0-1
        sa.Column('similarity_type', sa.String(50), nullable=False),  # content, collaborative, hybrid
        sa.Column('common_keywords', postgresql.JSON),  # List of common keywords

        # Metadata
        sa.Column('computed_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),

        # Indexes
        sa.Index('idx_file_similarity_file_id', 'file_id'),
        sa.Index('idx_file_similarity_similar_file_id', 'similar_file_id'),
        sa.Index('idx_file_similarity_score', 'similarity_score'),
        sa.Index('idx_file_similarity_type', 'similarity_type'),

        # Unique constraint to prevent duplicates
        sa.UniqueConstraint('file_id', 'similar_file_id', name='uq_file_similarity_pair'),
    )

    # Create user_interactions table
    op.create_table(
        'user_interactions',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, default=uuid4),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True),
        sa.Column('file_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('objects.id', ondelete='CASCADE'), nullable=False, index=True),

        # Interaction details
        sa.Column('interaction_type', sa.String(50), nullable=False),  # view, download, share, favorite, tag
        sa.Column('interaction_weight', sa.Float, nullable=False),  # Weighted score (view=1, download=2, share=3, favorite=5)
        sa.Column('total_time_spent', sa.Integer),  # Time spent in seconds
        sa.Column('interaction_metadata', postgresql.JSON),  # Additional context

        # Timestamp
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),

        # Indexes
        sa.Index('idx_user_interaction_user_id', 'user_id'),
        sa.Index('idx_user_interaction_file_id', 'file_id'),
        sa.Index('idx_user_interaction_type', 'interaction_type'),
        sa.Index('idx_user_interaction_weight', 'interaction_weight'),
        sa.Index('idx_user_interaction_created', 'created_at'),
    )

    # Create recommendations table
    op.create_table(
        'recommendations',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, default=uuid4),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True),
        sa.Column('file_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('objects.id', ondelete='CASCADE'), nullable=False, index=True),
        sa.Column('context_file_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('objects.id', ondelete='SET NULL')),  # File that triggered recommendation

        # Recommendation details
        sa.Column('recommendation_type', sa.String(50), nullable=False),  # similar, collaborative, trending, personalized
        sa.Column('recommendation_score', sa.Float, nullable=False),  # 0-1
        sa.Column('algorithm', sa.String(50), nullable=False),  # tfidf, collaborative_user, collaborative_item, hybrid
        sa.Column('reason', sa.Text),  # Human-readable explanation

        # Status
        sa.Column('is_accepted', sa.Boolean),  # User accepted/acted on recommendation
        sa.Column('is_dismissed', sa.Boolean, default=False),
        sa.Column('dismissed_at', sa.DateTime(timezone=True)),

        # Timestamps
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('accepted_at', sa.DateTime(timezone=True)),

        # Indexes
        sa.Index('idx_recommendation_user_id', 'user_id'),
        sa.Index('idx_recommendation_file_id', 'file_id'),
        sa.Index('idx_recommendation_context_file', 'context_file_id'),
        sa.Index('idx_recommendation_type', 'recommendation_type'),
        sa.Index('idx_recommendation_score', 'recommendation_score'),
        sa.Index('idx_recommendation_algorithm', 'algorithm'),
        sa.Index('idx_recommendation_dismissed', 'is_dismissed'),
        sa.Index('idx_recommendation_created', 'created_at'),
    )

    # Create recommendation_feedback table
    op.create_table(
        'recommendation_feedback',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, default=uuid4),
        sa.Column('recommendation_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('recommendations.id', ondelete='CASCADE'), nullable=False, index=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True),

        # Feedback details
        sa.Column('feedback_type', sa.String(50), nullable=False),  # positive, negative, irrelevant
        sa.Column('feedback_score', sa.Integer),  # 1-5 rating
        sa.Column('feedback_text', sa.Text),  # Optional comment

        # Timestamp
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),

        # Indexes
        sa.Index('idx_recommendation_feedback_rec_id', 'recommendation_id'),
        sa.Index('idx_recommendation_feedback_user_id', 'user_id'),
        sa.Index('idx_recommendation_feedback_type', 'feedback_type'),
        sa.Index('idx_recommendation_feedback_created', 'created_at'),
    )

    print("✅ Created content recommendations tables:")
    print("  - file_similarities")
    print("  - user_interactions")
    print("  - recommendations")
    print("  - recommendation_feedback")


def downgrade():
    """Remove content recommendations tables"""

    op.drop_table('recommendation_feedback')
    op.drop_table('recommendations')
    op.drop_table('user_interactions')
    op.drop_table('file_similarities')

    print("⬇️  Dropped content recommendations tables")
