"""Pure chunk-level dedup: remove ownership coupling, add file_block_mappings

Greenfield reset of deduplication model:
- Convert deduplicated_reference files to self-describing content_addressed
- Soft-delete unconvertible references
- Drop old content_blocks (owner-based), create new (no owner, no ref count)
- Create file_block_mappings junction table (N:M file-to-block)
- Repopulate from existing content_addressed files' chunk_info

Revision ID: 20260322_0001
Revises: 20260228_0002
Create Date: 2026-03-22
"""
from alembic import op

revision = '20260322_0001'
down_revision = '20260228_0002'
branch_labels = None
depends_on = None


def upgrade():
    # Step 1a: Convert deduplicated_reference files whose owner is content_addressed
    op.execute("""
        UPDATE objects ref SET
            chunk_info = owner.chunk_info,
            encryption_key = COALESCE(ref.encryption_key, owner.encryption_key),
            object_path = owner.object_path,
            storage_type = 'content_addressed',
            dedup_info = jsonb_build_object(
                'migrated_from_reference', true,
                'original_reference', ref.dedup_info->>'reference_file_id'
            )
        FROM objects owner
        WHERE ref.storage_type = 'deduplicated_reference'
          AND ref.dedup_info->>'reference_file_id' IS NOT NULL
          AND owner.id::text = ref.dedup_info->>'reference_file_id'
          AND owner.storage_type = 'content_addressed'
    """)

    # Step 1b: Soft-delete ALL remaining deduplicated_reference rows
    op.execute("""
        UPDATE objects SET
            storage_type = 'content_addressed',
            is_deleted = true,
            deleted_at = CURRENT_TIMESTAMP,
            dedup_info = jsonb_build_object(
                'migration_error', 'owner_not_content_addressed_or_missing'
            )
        WHERE storage_type = 'deduplicated_reference'
    """)

    # Step 2: Drop old content_blocks, create new schema
    op.execute("DROP TABLE IF EXISTS content_blocks CASCADE")

    op.execute("""
        CREATE TABLE content_blocks (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            block_hash VARCHAR(64) NOT NULL,
            block_size INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT uq_content_blocks_block_hash UNIQUE (block_hash)
        )
    """)
    op.execute("CREATE INDEX idx_cb_block_hash ON content_blocks(block_hash)")

    op.execute("""
        CREATE TABLE file_block_mappings (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            file_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
            block_id UUID NOT NULL REFERENCES content_blocks(id),
            block_offset INTEGER NOT NULL,
            block_index INTEGER NOT NULL,
            CONSTRAINT uq_fbm_file_block_index UNIQUE (file_id, block_index)
        )
    """)
    op.execute("CREATE INDEX idx_fbm_file_id ON file_block_mappings(file_id)")
    op.execute("CREATE INDEX idx_fbm_block_id ON file_block_mappings(block_id)")

    # Step 3: Repopulate from existing content_addressed files
    op.execute("""
        INSERT INTO content_blocks (id, block_hash, block_size, created_at)
        SELECT DISTINCT ON (b->>'hash')
            gen_random_uuid(), b->>'hash', (b->>'size')::int, CURRENT_TIMESTAMP
        FROM objects o,
             jsonb_array_elements(o.chunk_info::jsonb->'blocks') AS b
        WHERE o.storage_type = 'content_addressed'
          AND o.chunk_info IS NOT NULL
        ON CONFLICT (block_hash) DO NOTHING
    """)

    op.execute("""
        WITH numbered_blocks AS (
            SELECT o.id AS file_id,
                   b->>'hash' AS block_hash,
                   (b->>'offset')::int AS block_offset,
                   (row_number() OVER (
                       PARTITION BY o.id ORDER BY (b->>'offset')::int
                   )) - 1 AS block_index
            FROM objects o,
                 jsonb_array_elements(o.chunk_info::jsonb->'blocks') AS b
            WHERE o.storage_type = 'content_addressed'
              AND o.chunk_info IS NOT NULL
        )
        INSERT INTO file_block_mappings (id, file_id, block_id, block_offset, block_index)
        SELECT gen_random_uuid(), nb.file_id, cb.id, nb.block_offset, nb.block_index
        FROM numbered_blocks nb
        JOIN content_blocks cb ON cb.block_hash = nb.block_hash
        ON CONFLICT (file_id, block_index) DO NOTHING
    """)


def downgrade():
    op.execute("DROP TABLE IF EXISTS file_block_mappings CASCADE")
    op.execute("DROP TABLE IF EXISTS content_blocks CASCADE")

    # Recreate old content_blocks schema
    op.execute("""
        CREATE TABLE content_blocks (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            block_hash VARCHAR(64) NOT NULL,
            file_id UUID REFERENCES objects(id) ON DELETE CASCADE,
            block_size INTEGER,
            block_offset INTEGER,
            reference_count INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT uq_content_blocks_block_hash UNIQUE (block_hash)
        )
    """)
    op.execute("CREATE INDEX idx_block_file_id ON content_blocks(file_id)")
    op.execute("CREATE INDEX idx_ref_count_zero ON content_blocks(reference_count)")
    op.execute("CREATE INDEX idx_cb_block_hash ON content_blocks(block_hash)")
