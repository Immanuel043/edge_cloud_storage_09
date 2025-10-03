-- Migration: Add Performance Indexes
-- Date: 2024-01-10
-- Description: Add indexes to improve query performance for 500+ concurrent users

-- Objects table indexes
CREATE INDEX IF NOT EXISTS idx_user_storage_type ON objects(user_id, storage_type);
CREATE INDEX IF NOT EXISTS idx_content_hash ON objects(content_hash);
CREATE INDEX IF NOT EXISTS idx_user_id ON objects(user_id);

-- ContentBlocks table indexes
CREATE INDEX IF NOT EXISTS idx_block_file_id ON content_blocks(file_id);
CREATE INDEX IF NOT EXISTS idx_ref_count_zero ON content_blocks(reference_count);
CREATE INDEX IF NOT EXISTS idx_block_hash ON content_blocks(block_hash);

-- Analyze tables to update statistics
ANALYZE objects;
ANALYZE content_blocks;
