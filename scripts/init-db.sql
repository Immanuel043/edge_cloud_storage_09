-- Create database
CREATE DATABASE edge_cloud;

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    user_type VARCHAR(20) DEFAULT 'individual',
    storage_quota BIGINT DEFAULT 107374182400, -- 100GB
    storage_used BIGINT DEFAULT 0,
    bandwidth_quota BIGINT DEFAULT 1099511627776, -- 1TB/month
    bandwidth_used BIGINT DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Objects table (file metadata)
CREATE TABLE objects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    bucket_name VARCHAR(255) NOT NULL,
    object_key VARCHAR(500) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_size BIGINT NOT NULL,
    mime_type VARCHAR(100),
    content_hash VARCHAR(64),
    etag VARCHAR(64),
    storage_class VARCHAR(20) DEFAULT 'STANDARD',
    encryption_algorithm VARCHAR(20) DEFAULT 'AES256',
    encryption_key_id VARCHAR(255),
    is_multipart BOOLEAN DEFAULT false,
    version_id VARCHAR(100),
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(bucket_name, object_key, version_id)
);

-- Chunks table
CREATE TABLE chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chunk_hash VARCHAR(64) UNIQUE NOT NULL,
    chunk_size INTEGER NOT NULL,
    compressed_size INTEGER NOT NULL,
    storage_path VARCHAR(500) NOT NULL,
    storage_tier VARCHAR(20) DEFAULT 'cache',
    reference_count INTEGER DEFAULT 1,
    compression_algorithm VARCHAR(20) DEFAULT 'zstd',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_accessed TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Object chunks mapping
CREATE TABLE object_chunks (
    object_id UUID REFERENCES objects(id) ON DELETE CASCADE,
    chunk_id UUID REFERENCES chunks(id),
    chunk_index INTEGER NOT NULL,
    chunk_offset BIGINT NOT NULL,
    PRIMARY KEY (object_id, chunk_index)
);

-- Shared links
CREATE TABLE shared_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    object_id UUID REFERENCES objects(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    share_token VARCHAR(255) UNIQUE NOT NULL,
    share_type VARCHAR(20) DEFAULT 'view',
    password_hash VARCHAR(255),
    expires_at TIMESTAMP,
    download_limit INTEGER,
    download_count INTEGER DEFAULT 0,
    allowed_ips JSONB,
    metadata JSONB,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Upload sessions
CREATE TABLE upload_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    object_name VARCHAR(255) NOT NULL,
    total_size BIGINT NOT NULL,
    chunk_size INTEGER NOT NULL,
    total_chunks INTEGER NOT NULL,
    uploaded_chunks INTEGER[] DEFAULT '{}',
    status VARCHAR(20) DEFAULT 'in_progress',
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP + INTERVAL '24 hours'
);

-- Activity logs
CREATE TABLE activity_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    action VARCHAR(50) NOT NULL,
    object_id UUID,
    ip_address INET,
    user_agent TEXT,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_objects_user_id ON objects(user_id);
CREATE INDEX idx_objects_bucket_key ON objects(bucket_name, object_key);
CREATE INDEX idx_chunks_hash ON chunks(chunk_hash);
CREATE INDEX idx_chunks_tier ON chunks(storage_tier);
CREATE INDEX idx_object_chunks_object ON object_chunks(object_id);
CREATE INDEX idx_shared_links_token ON shared_links(share_token);
CREATE INDEX idx_activity_logs_user ON activity_logs(user_id, created_at DESC);

-- Storage tier management view
CREATE VIEW storage_distribution AS
SELECT 
    storage_tier,
    COUNT(*) as chunk_count,
    SUM(chunk_size) as total_size,
    SUM(compressed_size) as compressed_total,
    AVG(chunk_size) as avg_chunk_size,
    AVG(reference_count) as avg_references
FROM chunks
GROUP BY storage_tier;

-- User storage usage view
CREATE VIEW user_storage_usage AS
SELECT 
    u.id,
    u.username,
    u.storage_quota,
    COALESCE(SUM(o.file_size), 0) as storage_used,
    u.storage_quota - COALESCE(SUM(o.file_size), 0) as storage_available,
    COUNT(o.id) as file_count
FROM users u
LEFT JOIN objects o ON u.id = o.user_id
GROUP BY u.id, u.username, u.storage_quota;