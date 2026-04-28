"""add content_blocks table

Revision ID: 20251023_0001
Revises: 20251023_0000
Create Date: 2025-10-23 00:01:00.000000

"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

# revision identifiers, used by Alembic.
revision = "20251023_0001"
down_revision = "20251023_0000"
branch_labels = None
depends_on = None


def upgrade():
    """Add content_blocks table for deduplication."""
    # Create content_blocks table if it doesn't exist
    op.execute("""
        CREATE TABLE IF NOT EXISTS content_blocks (
            id UUID PRIMARY KEY,
            block_hash VARCHAR(64) NOT NULL,
            file_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
            block_size INTEGER,
            block_offset INTEGER,
            reference_count INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT NOW(),
            CONSTRAINT uq_block_hash_file_offset UNIQUE (block_hash, file_id, block_offset)
        );
    """)

    # Create indexes
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_content_blocks_block_hash ON content_blocks(block_hash);
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_block_file_id ON content_blocks(file_id);
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_ref_count_zero ON content_blocks(reference_count);
    """)


def downgrade():
    """Remove content_blocks table."""
    op.drop_table("content_blocks")
