"""add_file_embeddings_table

Revision ID: 20251216_0000
Revises: da9af03487c9
Create Date: 2025-12-16

Adds file_embeddings table for semantic search using sentence-transformers.
Stores 384-dimensional embeddings as binary data for efficient storage.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = '20251216_0000'
down_revision = 'da9af03487c9'
branch_labels = None
depends_on = None


def upgrade():
    # Create file_embeddings table for semantic search
    op.create_table(
        'file_embeddings',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('file_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('objects.id', ondelete='CASCADE'), nullable=False),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),

        # Embedding data stored as binary (384 floats * 4 bytes = 1536 bytes for all-MiniLM-L6-v2)
        sa.Column('embedding', sa.LargeBinary(), nullable=False),
        sa.Column('embedding_dim', sa.Integer(), default=384),

        # Model versioning for future upgrades
        sa.Column('model_name', sa.String(100), default='all-MiniLM-L6-v2'),
        sa.Column('model_version', sa.String(50), default='1.0'),

        # Source text metadata
        sa.Column('source_text_hash', sa.String(64), nullable=True),  # SHA256 hash to detect changes
        sa.Column('source_type', sa.String(50), default='filename'),  # 'filename', 'content', 'tags', 'combined'

        # Processing status
        sa.Column('status', sa.String(20), default='pending'),  # 'pending', 'processing', 'completed', 'failed'
        sa.Column('error_message', sa.Text(), nullable=True),

        # Timestamps
        sa.Column('computed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), onupdate=sa.func.now(), nullable=True),
    )

    # Create indexes for efficient querying
    op.create_index('idx_file_embedding_file_id', 'file_embeddings', ['file_id'])
    op.create_index('idx_file_embedding_user_id', 'file_embeddings', ['user_id'])
    op.create_index('idx_file_embedding_status', 'file_embeddings', ['status'])
    op.create_index('idx_file_embedding_model', 'file_embeddings', ['model_name'])

    # Unique constraint: one embedding per file per source type
    op.create_unique_constraint('unique_file_embedding_source', 'file_embeddings', ['file_id', 'source_type'])


def downgrade():
    # Drop unique constraint
    op.drop_constraint('unique_file_embedding_source', 'file_embeddings', type_='unique')

    # Drop indexes
    op.drop_index('idx_file_embedding_model', 'file_embeddings')
    op.drop_index('idx_file_embedding_status', 'file_embeddings')
    op.drop_index('idx_file_embedding_user_id', 'file_embeddings')
    op.drop_index('idx_file_embedding_file_id', 'file_embeddings')

    # Drop table
    op.drop_table('file_embeddings')
