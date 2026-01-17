use crate::crypto::AesGcmCipher;
use crate::error::DataPlaneError;
use tracing::{debug, instrument};

/// ZK (Zero-Knowledge) mode processor
///
/// # Security Guarantee
/// Server remains blind to plaintext - data is pre-encrypted by client
///
/// # Processing Pipeline
/// 1. Hash data (for integrity verification)
/// 2. Verify data format (optional)
/// 3. Write to storage AS-IS (no server-side encryption)
///
/// # Restrictions
/// - Cannot decrypt data (no key)
/// - Cannot compress (would reveal patterns)
/// - Cannot generate previews
/// - Cannot perform analytics
pub struct ZkModeProcessor {
    // No cipher needed - server is blind
}

impl ZkModeProcessor {
    pub fn new() -> Self {
        Self {}
    }

    /// Process ZK chunk: hash only (server-blind operation)
    ///
    /// # Arguments
    /// * `chunk_data` - Pre-encrypted chunk data from client
    /// * `chunk_index` - Chunk index for tracking
    ///
    /// # Returns
    /// ZkProcessedChunk with hash and metadata
    #[instrument(skip(self, chunk_data), fields(chunk_size = chunk_data.len(), chunk_index = chunk_index))]
    pub fn process_zk_chunk(
        &self,
        chunk_data: &[u8],
        chunk_index: u64,
    ) -> Result<ZkProcessedChunk, DataPlaneError> {
        // Only operation: hash the encrypted data
        let content_hash = AesGcmCipher::hash_data(chunk_data);
        let chunk_size = chunk_data.len();

        debug!(
            content_hash = %content_hash,
            chunk_size = chunk_size,
            chunk_index = chunk_index,
            "ZK chunk processed (server blind)"
        );

        Ok(ZkProcessedChunk {
            content_hash,
            chunk_size,
            chunk_index,
        })
    }

    /// Verify ZK chunk format (basic validation)
    ///
    /// Checks:
    /// - Minimum size (nonce + tag minimum)
    /// - Maximum size (chunk size limit)
    pub fn verify_chunk_format(&self, chunk_data: &[u8]) -> Result<(), DataPlaneError> {
        const MIN_SIZE: usize = 28; // nonce (12) + tag (16)
        const MAX_SIZE: usize = 64 * 1024 * 1024; // 64MB

        if chunk_data.len() < MIN_SIZE {
            return Err(DataPlaneError::InvalidRequest(format!(
                "ZK chunk too small: {} bytes (minimum {})",
                chunk_data.len(),
                MIN_SIZE
            )));
        }

        if chunk_data.len() > MAX_SIZE {
            return Err(DataPlaneError::InvalidRequest(format!(
                "ZK chunk too large: {} bytes (maximum {})",
                chunk_data.len(),
                MAX_SIZE
            )));
        }

        Ok(())
    }
}

impl Default for ZkModeProcessor {
    fn default() -> Self {
        Self::new()
    }
}

/// Result of ZK mode chunk processing
#[derive(Debug, Clone)]
pub struct ZkProcessedChunk {
    /// Hash of encrypted content (for integrity)
    pub content_hash: String,
    /// Size of encrypted chunk
    pub chunk_size: usize,
    /// Chunk index
    pub chunk_index: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_process_zk_chunk() {
        let processor = ZkModeProcessor::new();
        let data = b"Pre-encrypted data from client (server cannot decrypt)";

        let result = processor.process_zk_chunk(data, 0).unwrap();

        assert!(result.content_hash.starts_with("sha256:"));
        assert_eq!(result.chunk_size, data.len());
        assert_eq!(result.chunk_index, 0);
    }

    #[test]
    fn test_hash_consistency() {
        let processor = ZkModeProcessor::new();
        let data = b"Test data for hash consistency";

        let result1 = processor.process_zk_chunk(data, 0).unwrap();
        let result2 = processor.process_zk_chunk(data, 0).unwrap();

        // Same data should produce same hash
        assert_eq!(result1.content_hash, result2.content_hash);
    }

    #[test]
    fn test_different_data_different_hash() {
        let processor = ZkModeProcessor::new();
        let data1 = b"Data 1";
        let data2 = b"Data 2";

        let result1 = processor.process_zk_chunk(data1, 0).unwrap();
        let result2 = processor.process_zk_chunk(data2, 0).unwrap();

        assert_ne!(result1.content_hash, result2.content_hash);
    }

    #[test]
    fn test_chunk_index_tracking() {
        let processor = ZkModeProcessor::new();
        let data = b"Test data";

        let result = processor.process_zk_chunk(data, 42).unwrap();
        assert_eq!(result.chunk_index, 42);
    }

    #[test]
    fn test_verify_chunk_format_valid() {
        let processor = ZkModeProcessor::new();
        let data = vec![0u8; 1024]; // Valid size

        let result = processor.verify_chunk_format(&data);
        assert!(result.is_ok());
    }

    #[test]
    fn test_verify_chunk_format_too_small() {
        let processor = ZkModeProcessor::new();
        let data = vec![0u8; 10]; // Too small (< 28 bytes)

        let result = processor.verify_chunk_format(&data);
        assert!(result.is_err());
    }

    #[test]
    fn test_verify_chunk_format_too_large() {
        let processor = ZkModeProcessor::new();
        let data = vec![0u8; 65 * 1024 * 1024]; // Too large (> 64MB)

        let result = processor.verify_chunk_format(&data);
        assert!(result.is_err());
    }

    #[test]
    fn test_verify_chunk_format_edge_cases() {
        let processor = ZkModeProcessor::new();

        // Minimum valid size
        let min_data = vec![0u8; 28];
        assert!(processor.verify_chunk_format(&min_data).is_ok());

        // Maximum valid size
        let max_data = vec![0u8; 64 * 1024 * 1024];
        assert!(processor.verify_chunk_format(&max_data).is_ok());

        // Just below minimum
        let below_min = vec![0u8; 27];
        assert!(processor.verify_chunk_format(&below_min).is_err());
    }

    #[test]
    fn test_large_chunk() {
        let processor = ZkModeProcessor::new();
        let data = vec![0u8; 32 * 1024 * 1024]; // 32MB

        let result = processor.process_zk_chunk(&data, 0).unwrap();
        assert_eq!(result.chunk_size, 32 * 1024 * 1024);
    }
}
