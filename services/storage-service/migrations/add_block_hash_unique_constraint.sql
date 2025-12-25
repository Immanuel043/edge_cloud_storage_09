-- Migration: Add Unique Constraint on block_hash for Deduplication
-- Date: 2025-12-25
-- Description: Fix deduplication ON CONFLICT error by adding unique constraint on block_hash
-- Error: "there is no unique or exclusion constraint matching the ON CONFLICT specification"

-- ============================================================================
-- PROBLEM
-- ============================================================================
-- The deduplication service uses ON CONFLICT (block_hash) to handle duplicate
-- content blocks, but there's no unique constraint on block_hash alone.
-- Current constraint is on (block_hash, file_id, block_offset) which doesn't
-- support ON CONFLICT (block_hash).

-- ============================================================================
-- SOLUTION
-- ============================================================================
-- Add a unique index on block_hash to enable content-addressed storage.
-- This ensures each content block with the same hash is stored only once.

-- First, check if there are any duplicate block_hashes that would prevent
-- adding the unique constraint. If so, we need to deduplicate first.

-- Step 1: Create a temporary table with deduplicated blocks
CREATE TEMP TABLE IF NOT EXISTS dedup_blocks AS
SELECT DISTINCT ON (block_hash)
    id,
    block_hash,
    file_id,
    block_size,
    block_offset,
    reference_count,
    created_at
FROM content_blocks
ORDER BY block_hash, created_at ASC;

-- Step 2: Count duplicates (for logging purposes)
DO $$
DECLARE
    total_rows INTEGER;
    unique_rows INTEGER;
    duplicate_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO total_rows FROM content_blocks;
    SELECT COUNT(*) INTO unique_rows FROM dedup_blocks;
    duplicate_count := total_rows - unique_rows;

    IF duplicate_count > 0 THEN
        RAISE NOTICE 'Found % duplicate block_hash entries to merge', duplicate_count;
    ELSE
        RAISE NOTICE 'No duplicate block_hash entries found';
    END IF;
END $$;

-- Step 3: Update reference counts for deduplicated blocks
-- Sum up reference counts for all blocks with the same hash
UPDATE content_blocks cb
SET reference_count = (
    SELECT COALESCE(SUM(reference_count), 1)
    FROM content_blocks cb2
    WHERE cb2.block_hash = cb.block_hash
)
WHERE cb.id IN (SELECT id FROM dedup_blocks);

-- Step 4: Delete duplicate rows (keep only the ones in dedup_blocks)
DELETE FROM content_blocks
WHERE id NOT IN (SELECT id FROM dedup_blocks);

-- Step 5: Drop the old composite unique constraint if it exists
ALTER TABLE content_blocks
DROP CONSTRAINT IF EXISTS content_blocks_block_hash_file_id_block_offset_key;

-- Step 6: Add the unique constraint on block_hash alone
-- Using CREATE UNIQUE INDEX for better control
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_blocks_block_hash_unique
ON content_blocks(block_hash);

-- Step 7: Clean up temp table
DROP TABLE IF EXISTS dedup_blocks;

-- Step 8: Analyze the table for query optimizer
ANALYZE content_blocks;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- After running this migration, verify with:
-- SELECT COUNT(*), COUNT(DISTINCT block_hash) FROM content_blocks;
-- Both counts should be equal.
