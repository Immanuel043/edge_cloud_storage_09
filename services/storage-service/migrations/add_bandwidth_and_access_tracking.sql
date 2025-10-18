-- Migration: Add Bandwidth Limits and Access Pattern Tracking
-- Date: 2025-10-15
-- Description: Support for bandwidth throttling and predictive prefetching

-- ============================================================================
-- BANDWIDTH LIMITING
-- ============================================================================

-- Add bandwidth limit column to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS bandwidth_limit_mbps INTEGER DEFAULT 10;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bandwidth_burst_mbps INTEGER DEFAULT 20;

-- Create groups table for shared bandwidth pools
CREATE TABLE IF NOT EXISTS user_groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    bandwidth_limit_mbps INTEGER DEFAULT 100,
    bandwidth_burst_mbps INTEGER DEFAULT 200,
    max_members INTEGER DEFAULT 50,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- User-group membership
CREATE TABLE IF NOT EXISTS user_group_members (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id UUID NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
    role VARCHAR(20) DEFAULT 'member',  -- 'admin', 'member'
    joined_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_user ON user_group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON user_group_members(group_id);

-- ============================================================================
-- ACCESS PATTERN TRACKING FOR PREDICTIVE PREFETCHING
-- ============================================================================

-- Track individual file accesses
CREATE TABLE IF NOT EXISTS file_access_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
    access_type VARCHAR(20) NOT NULL,  -- 'view', 'download', 'preview'
    session_id VARCHAR(64),  -- Group related accesses
    accessed_at TIMESTAMP DEFAULT NOW(),
    access_duration_ms INTEGER,  -- How long file was accessed
    ip_address VARCHAR(45),
    user_agent TEXT
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_file_access_user_time
ON file_access_log(user_id, accessed_at DESC);

CREATE INDEX IF NOT EXISTS idx_file_access_file_time
ON file_access_log(file_id, accessed_at DESC);

CREATE INDEX IF NOT EXISTS idx_file_access_session
ON file_access_log(session_id, accessed_at);

-- Track access sequences (for Markov chain)
CREATE TABLE IF NOT EXISTS file_access_sequences (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_from UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
    file_to UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
    sequence_count INTEGER DEFAULT 1,
    probability FLOAT,  -- Calculated probability
    last_seen TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Unique constraint for sequence pair
CREATE UNIQUE INDEX IF NOT EXISTS idx_access_sequence_unique
ON file_access_sequences(user_id, file_from, file_to);

-- Index for lookup
CREATE INDEX IF NOT EXISTS idx_access_sequence_from
ON file_access_sequences(file_from, probability DESC);

-- ============================================================================
-- PREFETCH CANDIDATES
-- ============================================================================

-- Store files predicted to be accessed next
CREATE TABLE IF NOT EXISTS prefetch_candidates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
    prediction_confidence FLOAT NOT NULL,  -- 0.0 to 1.0
    prediction_method VARCHAR(50),  -- 'markov', 'time_pattern', 'ml_model'
    predicted_at TIMESTAMP DEFAULT NOW(),
    prefetched BOOLEAN DEFAULT FALSE,
    prefetched_at TIMESTAMP,
    accessed_after_prefetch BOOLEAN,  -- Was prediction correct?
    expires_at TIMESTAMP,
    UNIQUE(user_id, file_id)
);

CREATE INDEX IF NOT EXISTS idx_prefetch_user_confidence
ON prefetch_candidates(user_id, prediction_confidence DESC, prefetched);

CREATE INDEX IF NOT EXISTS idx_prefetch_expires
ON prefetch_candidates(expires_at)
WHERE NOT prefetched;

-- ============================================================================
-- BANDWIDTH USAGE STATISTICS
-- ============================================================================

-- Track bandwidth usage over time (for billing/reporting)
CREATE TABLE IF NOT EXISTS bandwidth_usage (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bytes_uploaded BIGINT DEFAULT 0,
    bytes_downloaded BIGINT DEFAULT 0,
    period_start TIMESTAMP NOT NULL,
    period_end TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bandwidth_usage_user_period
ON bandwidth_usage(user_id, period_start DESC);

-- ============================================================================
-- HELPER VIEWS
-- ============================================================================

-- View: Recent access patterns per user
CREATE OR REPLACE VIEW user_recent_access AS
SELECT
    user_id,
    file_id,
    COUNT(*) as access_count,
    MAX(accessed_at) as last_accessed,
    AVG(access_duration_ms) as avg_duration_ms
FROM file_access_log
WHERE accessed_at > NOW() - INTERVAL '7 days'
GROUP BY user_id, file_id;

-- View: Most accessed files
CREATE OR REPLACE VIEW popular_files AS
SELECT
    o.id,
    o.file_name,
    o.mime_type,
    COUNT(fal.id) as access_count,
    COUNT(DISTINCT fal.user_id) as unique_users,
    MAX(fal.accessed_at) as last_accessed
FROM objects o
LEFT JOIN file_access_log fal ON o.id = fal.file_id
WHERE fal.accessed_at > NOW() - INTERVAL '30 days'
GROUP BY o.id, o.file_name, o.mime_type
ORDER BY access_count DESC;

-- View: User bandwidth summary
CREATE OR REPLACE VIEW user_bandwidth_summary AS
SELECT
    u.id as user_id,
    u.username,
    u.bandwidth_limit_mbps,
    COALESCE(SUM(bu.bytes_uploaded), 0) as total_uploaded,
    COALESCE(SUM(bu.bytes_downloaded), 0) as total_downloaded,
    COALESCE(SUM(bu.bytes_uploaded + bu.bytes_downloaded), 0) as total_transfer
FROM users u
LEFT JOIN bandwidth_usage bu ON u.id = bu.user_id
    AND bu.period_start > NOW() - INTERVAL '30 days'
GROUP BY u.id, u.username, u.bandwidth_limit_mbps;

-- ============================================================================
-- FUNCTIONS
-- ============================================================================

-- Function to update access sequence probabilities
CREATE OR REPLACE FUNCTION update_access_sequence_probabilities()
RETURNS void AS $$
BEGIN
    -- Calculate probabilities based on sequence counts
    UPDATE file_access_sequences fas
    SET probability = (
        SELECT CAST(fas.sequence_count AS FLOAT) /
               CAST(SUM(fas2.sequence_count) AS FLOAT)
        FROM file_access_sequences fas2
        WHERE fas2.user_id = fas.user_id
          AND fas2.file_from = fas.file_from
    );
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- INITIAL DATA
-- ============================================================================

-- Set default bandwidth limits for existing users
UPDATE users
SET bandwidth_limit_mbps = 10,
    bandwidth_burst_mbps = 20
WHERE bandwidth_limit_mbps IS NULL;

-- ============================================================================
-- SUMMARY
-- ============================================================================
-- This migration adds:
-- - User and group bandwidth limits
-- - Access pattern tracking for ML-based prefetching
-- - File access sequences (Markov chains)
-- - Prefetch candidate tracking
-- - Bandwidth usage statistics
-- - Helper views for analytics
-- ============================================================================
