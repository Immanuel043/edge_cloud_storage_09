-- Migration: Add trash functionality (soft delete) to objects table
-- Date: 2025-10-24
-- Description: Adds is_deleted and deleted_at columns for trash/bin functionality with 30-day auto-deletion

-- Add columns to objects table
ALTER TABLE objects
ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

-- Create index for efficient trash queries
CREATE INDEX IF NOT EXISTS idx_is_deleted_deleted_at ON objects(is_deleted, deleted_at);

-- Add comment for documentation
COMMENT ON COLUMN objects.is_deleted IS 'Soft delete flag - TRUE when file is in trash';
COMMENT ON COLUMN objects.deleted_at IS 'Timestamp when file was moved to trash - used for 30-day auto-deletion';

-- Create a view for trash files (optional, for easier querying)
CREATE OR REPLACE VIEW trash_files AS
SELECT
    id,
    user_id,
    folder_id,
    file_name,
    file_size,
    mime_type,
    created_at,
    deleted_at,
    EXTRACT(DAY FROM (NOW() - deleted_at)) as days_in_trash
FROM objects
WHERE is_deleted = TRUE AND deleted_at IS NOT NULL
ORDER BY deleted_at DESC;

-- Function to permanently delete old trash files (for scheduled job)
CREATE OR REPLACE FUNCTION cleanup_old_trash_files()
RETURNS TABLE(deleted_count INTEGER) AS $$
DECLARE
    count INTEGER;
BEGIN
    -- Count files to be deleted (older than 30 days)
    SELECT COUNT(*) INTO count
    FROM objects
    WHERE is_deleted = TRUE
    AND deleted_at IS NOT NULL
    AND deleted_at < NOW() - INTERVAL '30 days';

    -- Delete the files
    DELETE FROM objects
    WHERE is_deleted = TRUE
    AND deleted_at IS NOT NULL
    AND deleted_at < NOW() - INTERVAL '30 days';

    RETURN QUERY SELECT count;
END;
$$ LANGUAGE plpgsql;

-- Grant permissions
GRANT SELECT ON trash_files TO PUBLIC;
