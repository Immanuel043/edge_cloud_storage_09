use crate::crypto::{AesGcmCipher, SecretKey};
use crate::compression::ZstdCompressor;
use crate::error::DataPlaneError;
use tracing::{debug, instrument};

/// Result of chunk processing
#[derive(Debug, Clone)]
pub struct ProcessedChunk {
    /// Encrypted (and optionally compressed) data
    pub encrypted_data: Vec<u8>,
    /// Original hash (before compression/encryption)
    pub original_hash: String,
    /// Whether compression was applied
    pub was_compressed: bool,
    /// Processing statistics
    pub stats: ProcessingStats,
}

/// Processing statistics for monitoring
#[derive(Debug, Clone)]
pub struct ProcessingStats {
    /// Original size (bytes)
    pub original_size: usize,
    /// Size after compression (bytes, 0 if not compressed)
    pub compressed_size: usize,
    /// Final encrypted size (bytes)
    pub encrypted_size: usize,
    /// Compression ratio (if compressed)
    pub compression_ratio: Option<f64>,
}

/// Chunk processor for CPU-bound operations
pub struct ChunkProcessor {
    cipher: AesGcmCipher,
    compressor: ZstdCompressor,
}

impl ChunkProcessor {
    /// Create new chunk processor
    pub fn new(compression_level: i32) -> Result<Self, DataPlaneError> {
        Ok(Self {
            cipher: AesGcmCipher::new(),
            compressor: ZstdCompressor::new(compression_level)?,
        })
    }

    /// Process chunk: hash → compress (optional) → encrypt
    ///
    /// # Arguments
    /// * `chunk_data` - Raw chunk data
    /// * `file_key` - Encryption key (32 bytes)
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
    pub fn process_chunk(
        &self,
        chunk_data: &[u8],
        file_key: &SecretKey,
        chunk_index: u64,
        should_compress: bool,
    ) -> Result<ProcessedChunk, DataPlaneError> {
        // Step 1: Hash original data (before any processing)
        let original_hash = AesGcmCipher::hash_data(chunk_data);
        let original_size = chunk_data.len();

        debug!(
            original_hash = %original_hash,
            original_size = original_size,
            "Hashed original chunk"
        );

        // Step 2: Optional compression, Step 3: Encryption
        let (encrypted_data, compressed_size, was_compressed) = if should_compress {
            let compressed = self.compressor.compress(chunk_data)?;
            let compressed_size = compressed.len();
            let ratio = (compressed_size as f64 / original_size as f64) * 100.0;

            debug!(
                compressed_size = compressed_size,
                ratio = format!("{:.2}%", ratio),
                "Compression completed"
            );

            let encrypted = self.cipher.encrypt_chunk(
                &compressed,
                file_key.as_bytes(),
                chunk_index,
            )?;
            (encrypted, compressed_size, true)
        } else {
            debug!("Skipping compression");
            // Avoid redundant to_vec - encrypt directly from chunk_data
            let encrypted = self.cipher.encrypt_chunk(
                chunk_data,
                file_key.as_bytes(),
                chunk_index,
            )?;
            (encrypted, 0, false)
        };

        let encrypted_size = encrypted_data.len();

        debug!(
            encrypted_size = encrypted_size,
            "Encryption completed"
        );

        // Calculate compression ratio
        let compression_ratio = if was_compressed {
            Some((compressed_size as f64 / original_size as f64) * 100.0)
        } else {
            None
        };

        Ok(ProcessedChunk {
            encrypted_data,
            original_hash,
            was_compressed,
            stats: ProcessingStats {
                original_size,
                compressed_size,
                encrypted_size,
                compression_ratio,
            },
        })
    }

    /// Decrypt and decompress chunk
    ///
    /// # Arguments
    /// * `encrypted_data` - Encrypted (and optionally compressed) data
    /// * `file_key` - Decryption key (32 bytes)
    /// * `chunk_index` - Chunk index for AAD verification
    /// * `was_compressed` - Whether chunk was compressed
    ///
    /// # Returns
    /// Original chunk data
    #[instrument(
        skip(self, encrypted_data, file_key),
        fields(
            encrypted_size = encrypted_data.len(),
            chunk_index = chunk_index,
            was_compressed = was_compressed
        )
    )]
    pub fn decrypt_chunk(
        &self,
        encrypted_data: &[u8],
        file_key: &SecretKey,
        chunk_index: u64,
        was_compressed: bool,
    ) -> Result<Vec<u8>, DataPlaneError> {
        // Step 1: Decrypt
        let decrypted = self.cipher.decrypt_chunk(
            encrypted_data,
            file_key.as_bytes(),
            chunk_index,
        )?;

        debug!(
            decrypted_size = decrypted.len(),
            "Decryption completed"
        );

        // Step 2: Optional decompression
        if was_compressed {
            let decompressed = self.compressor.decompress(&decrypted)?;
            debug!(
                decompressed_size = decompressed.len(),
                "Decompression completed"
            );
            Ok(decompressed)
        } else {
            Ok(decrypted)
        }
    }
}

impl Default for ChunkProcessor {
    fn default() -> Self {
        Self {
            cipher: AesGcmCipher::new(),
            compressor: ZstdCompressor::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_process_chunk_without_compression() {
        let processor = ChunkProcessor::default();
        let key = SecretKey::from_bytes([0x42u8; 32]);
        let data = b"Hello, world! This is test data.";

        let result = processor
            .process_chunk(data, &key, 0, false)
            .unwrap();

        assert!(!result.was_compressed);
        assert!(result.original_hash.starts_with("sha256:"));
        assert!(result.encrypted_data.len() > data.len()); // Includes nonce + tag
        assert_eq!(result.stats.original_size, data.len());
        assert_eq!(result.stats.compressed_size, 0);
        assert!(result.stats.compression_ratio.is_none());
    }

    #[test]
    fn test_process_chunk_with_compression() {
        let processor = ChunkProcessor::default();
        let key = SecretKey::from_bytes([0x42u8; 32]);
        let data = vec![b'A'; 10000]; // Highly compressible

        let result = processor
            .process_chunk(&data, &key, 0, true)
            .unwrap();

        assert!(result.was_compressed);
        assert!(result.stats.compressed_size > 0);
        assert!(result.stats.compressed_size < data.len()); // Should be smaller
        assert!(result.stats.compression_ratio.is_some());
        assert!(result.stats.compression_ratio.unwrap() < 50.0); // Good compression
    }

    #[test]
    fn test_encrypt_decrypt_roundtrip_without_compression() {
        let processor = ChunkProcessor::default();
        let key = SecretKey::from_bytes([0x42u8; 32]);
        let original = b"Test data for roundtrip without compression";

        // Encrypt
        let processed = processor
            .process_chunk(original, &key, 5, false)
            .unwrap();

        // Decrypt
        let decrypted = processor
            .decrypt_chunk(&processed.encrypted_data, &key, 5, false)
            .unwrap();

        assert_eq!(original, &decrypted[..]);
    }

    #[test]
    fn test_encrypt_decrypt_roundtrip_with_compression() {
        let processor = ChunkProcessor::default();
        let key = SecretKey::from_bytes([0x42u8; 32]);
        let original = vec![b'B'; 5000]; // Compressible data

        // Encrypt with compression
        let processed = processor
            .process_chunk(&original, &key, 10, true)
            .unwrap();

        assert!(processed.was_compressed);

        // Decrypt with decompression
        let decrypted = processor
            .decrypt_chunk(&processed.encrypted_data, &key, 10, true)
            .unwrap();

        assert_eq!(original, decrypted);
    }

    #[test]
    fn test_chunk_index_binding() {
        let processor = ChunkProcessor::default();
        let key = SecretKey::from_bytes([0x42u8; 32]);
        let data = b"Test data for chunk index binding";

        // Encrypt with index 1
        let processed = processor
            .process_chunk(data, &key, 1, false)
            .unwrap();

        // Try to decrypt with wrong index (should fail)
        let result = processor.decrypt_chunk(&processed.encrypted_data, &key, 2, false);
        assert!(result.is_err());

        // Decrypt with correct index (should succeed)
        let decrypted = processor
            .decrypt_chunk(&processed.encrypted_data, &key, 1, false)
            .unwrap();
        assert_eq!(data, &decrypted[..]);
    }

    #[test]
    fn test_wrong_key() {
        let processor = ChunkProcessor::default();
        let key1 = SecretKey::from_bytes([0x42u8; 32]);
        let key2 = SecretKey::from_bytes([0x43u8; 32]);
        let data = b"Test data for wrong key";

        let processed = processor
            .process_chunk(data, &key1, 0, false)
            .unwrap();

        // Try to decrypt with wrong key (should fail)
        let result = processor.decrypt_chunk(&processed.encrypted_data, &key2, 0, false);
        assert!(result.is_err());
    }

    #[test]
    fn test_hash_consistency() {
        let processor = ChunkProcessor::default();
        let key = SecretKey::from_bytes([0x42u8; 32]);
        let data = b"Test data for hash consistency";

        let result1 = processor.process_chunk(data, &key, 0, false).unwrap();
        let result2 = processor.process_chunk(data, &key, 0, false).unwrap();

        // Same data should produce same hash (before encryption)
        assert_eq!(result1.original_hash, result2.original_hash);

        // But different encrypted data (due to random nonces)
        assert_ne!(result1.encrypted_data, result2.encrypted_data);
    }

    #[test]
    fn test_compression_stats() {
        let processor = ChunkProcessor::default();
        let key = SecretKey::from_bytes([0x42u8; 32]);
        let data = vec![b'X'; 100000]; // 100KB of 'X'

        let result = processor
            .process_chunk(&data, &key, 0, true)
            .unwrap();

        assert!(result.was_compressed);
        assert_eq!(result.stats.original_size, 100000);
        assert!(result.stats.compressed_size > 0);
        assert!(result.stats.compressed_size < 1000); // Should compress to <1KB
        assert!(result.stats.encrypted_size > result.stats.compressed_size); // Includes nonce + tag

        let ratio = result.stats.compression_ratio.unwrap();
        assert!(ratio < 1.0); // Less than 1% of original size
    }

    #[test]
    fn test_large_chunk() {
        let processor = ChunkProcessor::default();
        let key = SecretKey::from_bytes([0x42u8; 32]);
        let data = vec![0u8; 32 * 1024 * 1024]; // 32MB

        let result = processor
            .process_chunk(&data, &key, 0, true)
            .unwrap();

        // Should handle large chunks
        assert!(result.encrypted_data.len() > 0);
        assert_eq!(result.stats.original_size, 32 * 1024 * 1024);
    }
}
