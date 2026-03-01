"""Fix content_blocks unique constraint for deduplication

The ON CONFLICT (block_hash) clause in dedup_db_batch.py requires a
unique constraint on block_hash alone. The original migration only
created a composite unique (block_hash, file_id, block_offset) which
doesn't satisfy ON CONFLICT (block_hash).

Revision ID: 20260228_0002
Revises: 20260228_0001
Create Date: 2026-02-28
"""
from alembic import op

revision = '20260228_0002'
down_revision = '20260228_0001'
branch_labels = None
depends_on = None


def upgrade():
    """Add unique constraint on block_hash alone."""
    # Drop the composite constraint that doesn't match ON CONFLICT (block_hash)
    op.execute("""
        ALTER TABLE content_blocks
        DROP CONSTRAINT IF EXISTS uq_block_hash_file_offset;
    """)

    # Add unique constraint on block_hash alone (matches model and ON CONFLICT clause)
    op.execute("""
        ALTER TABLE content_blocks
        ADD CONSTRAINT uq_content_blocks_block_hash UNIQUE (block_hash);
    """)


def downgrade():
    """Revert to composite constraint."""
    op.execute("""
        ALTER TABLE content_blocks
        DROP CONSTRAINT IF EXISTS uq_content_blocks_block_hash;
    """)

    op.execute("""
        ALTER TABLE content_blocks
        ADD CONSTRAINT uq_block_hash_file_offset UNIQUE (block_hash, file_id, block_offset);
    """)
