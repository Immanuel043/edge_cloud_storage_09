use crate::crypto::SecretKey;
use crate::error::DataPlaneError;
use crate::processing::{ChunkProcessor, ProcessedChunk};
use tracing::{debug, instrument};

/// Non-ZK mode processor
///
/// # Processing Pipeline
/// Server-side encryption with full processing capabilities:
/// 1. Hash plaintext chunk
/// 2. Optional compression (based on format detection)
/// 3. Encrypt with file key
/// 4. Write encrypted data to storage
///
/// # Capabilities
/// - Server-side encryption
/// - Compression (for text/compressible formats)
/// - Preview generation (future)
/// - Video transcoding (future)
/// - Full-text search (future)
pub struct NonZkModeProcessor {
    processor: ChunkProcessor,
}

impl NonZkModeProcessor {
    /// Create new Non-ZK mode processor
    pub fn new(compression_level: i32) -> Result<Self, DataPlaneError> {
        Ok(Self {
            processor: ChunkProcessor::new(compression_level)?,
        })
    }

    /// Process Non-ZK chunk: full pipeline (hash → compress → encrypt)
    ///
    /// # Arguments
    /// * `chunk_data` - Plaintext chunk data
    /// * `file_key` - Encryption key (from memfd via SCM_RIGHTS)
    /// * `chunk_index` - Chunk index for AAD
    /// * `should_compress` - Whether to compress before encryption
    ///
    /// # Returns
    /// ProcessedChunk with encrypted data and metadata
    #[instrument(
        skip(self, chunk_data, file_key),
        fields(
            chunk_size = chunk_data.len(),
            chunk_index = chunk_index,
            should_compress = should_compress
        )
    )]
    pub fn process_non_zk_chunk(
        &self,
        chunk_data: &[u8],
        file_key: &SecretKey,
        chunk_index: u64,
        should_compress: bool,
    ) -> Result<ProcessedChunk, DataPlaneError> {
        let result = self.processor.process_chunk(
            chunk_data,
            file_key,
            chunk_index,
            should_compress,
        )?;

        debug!(
            encrypted_size = result.encrypted_data.len(),
            was_compressed = result.was_compressed,
            original_hash = %result.original_hash,
            "Non-ZK chunk processed"
        );

        Ok(result)
    }

    /// Decrypt and decompress Non-ZK chunk
    ///
    /// # Arguments
    /// * `encrypted_data` - Encrypted (and optionally compressed) data
    /// * `file_key` - Decryption key
    /// * `chunk_index` - Chunk index for AAD verification
    /// * `was_compressed` - Whether chunk was compressed
    ///
    /// # Returns
    /// Original plaintext chunk
    #[instrument(
        skip(self, encrypted_data, file_key),
        fields(
            encrypted_size = encrypted_data.len(),
            chunk_index = chunk_index,
            was_compressed = was_compressed
        )
    )]
    pub fn decrypt_non_zk_chunk(
        &self,
        encrypted_data: &[u8],
        file_key: &SecretKey,
        chunk_index: u64,
        was_compressed: bool,
    ) -> Result<Vec<u8>, DataPlaneError> {
        let result = self.processor.decrypt_chunk(
            encrypted_data,
            file_key,
            chunk_index,
            was_compressed,
        )?;

        debug!(
            decrypted_size = result.len(),
            "Non-ZK chunk decrypted"
        );

        Ok(result)
    }

    /// Verify plaintext chunk format
    pub fn verify_chunk_format(&self, chunk_data: &[u8]) -> Result<(), DataPlaneError> {
        const MAX_SIZE: usize = 64 * 1024 * 1024; // 64MB

        if chunk_data.is_empty() {
            return Err(DataPlaneError::InvalidRequest(
                "Non-ZK chunk cannot be empty".to_string(),
            ));
        }

        if chunk_data.len() > MAX_SIZE {
            return Err(DataPlaneError::InvalidRequest(format!(
                "Non-ZK chunk too large: {} bytes (maximum {})",
                chunk_data.len(),
                MAX_SIZE
            )));
        }

        Ok(())
    }
}

impl Default for NonZkModeProcessor {
    fn default() -> Self {
        Self {
            processor: ChunkProcessor::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_process_non_zk_chunk_without_compression() {
        let processor = NonZkModeProcessor::default();
        let key = SecretKey::from_bytes([0x42u8; 32]);
        let data = b"Plaintext data for server-side encryption";

        let result = processor
            .process_non_zk_chunk(data, &key, 0, false)
            .unwrap();

        assert!(!result.was_compressed);
        assert!(result.original_hash.starts_with("sha256:"));
        assert!(result.encrypted_data.len() > data.len()); // Includes nonce + tag
    }

    #[test]
    fn test_process_non_zk_chunk_with_compression() {
        let processor = NonZkModeProcessor::default();
        let key = SecretKey::from_bytes([0x42u8; 32]);
        let data = vec![b'A'; 10000]; // Highly compressible

        let result = processor
            .process_non_zk_chunk(&data, &key, 0, true)
            .unwrap();

        assert!(result.was_compressed);
        assert!(result.stats.compressed_size < data.len());
        assert!(result.stats.compression_ratio.is_some());
    }

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let processor = NonZkModeProcessor::default();
        let key = SecretKey::from_bytes([0x42u8; 32]);
        let original = b"Test data for roundtrip verification";

        // Encrypt
        let processed = processor
            .process_non_zk_chunk(original, &key, 5, false)
            .unwrap();

        // Decrypt
        let decrypted = processor
            .decrypt_non_zk_chunk(&processed.encrypted_data, &key, 5, false)
            .unwrap();

        assert_eq!(original, &decrypted[..]);
    }

    #[test]
    fn test_roundtrip_with_compression() {
        let processor = NonZkModeProcessor::default();
        let key = SecretKey::from_bytes([0x42u8; 32]);
        let original = vec![b'X'; 5000]; // Compressible

        // Encrypt with compression
        let processed = processor
            .process_non_zk_chunk(&original, &key, 10, true)
            .unwrap();

        assert!(processed.was_compressed);

        // Decrypt with decompression
        let decrypted = processor
            .decrypt_non_zk_chunk(&processed.encrypted_data, &key, 10, true)
            .unwrap();

        assert_eq!(original, decrypted);
    }

    #[test]
    fn test_wrong_key_fails() {
        let processor = NonZkModeProcessor::default();
        let key1 = SecretKey::from_bytes([0x42u8; 32]);
        let key2 = SecretKey::from_bytes([0x43u8; 32]);
        let data = b"Test data";

        let processed = processor
            .process_non_zk_chunk(data, &key1, 0, false)
            .unwrap();

        // Wrong key should fail
        let result = processor.decrypt_non_zk_chunk(&processed.encrypted_data, &key2, 0, false);
        assert!(result.is_err());
    }

    #[test]
    fn test_wrong_chunk_index_fails() {
        let processor = NonZkModeProcessor::default();
        let key = SecretKey::from_bytes([0x42u8; 32]);
        let data = b"Test data for AAD binding";

        // Encrypt with index 1
        let processed = processor
            .process_non_zk_chunk(data, &key, 1, false)
            .unwrap();

        // Decrypt with wrong index (should fail due to AAD mismatch)
        let result = processor.decrypt_non_zk_chunk(&processed.encrypted_data, &key, 2, false);
        assert!(result.is_err());
    }

    #[test]
    fn test_verify_chunk_format_valid() {
        let processor = NonZkModeProcessor::default();
        let data = vec![0u8; 1024];

        let result = processor.verify_chunk_format(&data);
        assert!(result.is_ok());
    }

    #[test]
    fn test_verify_chunk_format_empty() {
        let processor = NonZkModeProcessor::default();
        let data: &[u8] = &[];

        let result = processor.verify_chunk_format(data);
        assert!(result.is_err());
    }

    #[test]
    fn test_verify_chunk_format_too_large() {
        let processor = NonZkModeProcessor::default();
        let data = vec![0u8; 65 * 1024 * 1024]; // > 64MB

        let result = processor.verify_chunk_format(&data);
        assert!(result.is_err());
    }

    #[test]
    fn test_custom_compression_level() {
        let processor = NonZkModeProcessor::new(9).unwrap();
        let key = SecretKey::from_bytes([0x42u8; 32]);
        let data = vec![b'Z'; 10000];

        let result = processor
            .process_non_zk_chunk(&data, &key, 0, true)
            .unwrap();

        assert!(result.was_compressed);
        // Level 9 should produce good compression
        assert!(result.stats.compression_ratio.unwrap() < 10.0);
    }

    #[test]
    fn test_large_chunk() {
        let processor = NonZkModeProcessor::default();
        let key = SecretKey::from_bytes([0x42u8; 32]);
        let data = vec![0u8; 32 * 1024 * 1024]; // 32MB

        let result = processor
            .process_non_zk_chunk(&data, &key, 0, true)
            .unwrap();

        assert_eq!(result.stats.original_size, 32 * 1024 * 1024);
    }
}
