use crate::crypto::SecretKey;
use crate::error::DataPlaneError;
use crate::processing::{BufferPool, ChunkProcessor, ProcessedChunk};
use bytes::Bytes;
use std::sync::Arc;
use tokio::task;
use tracing::{debug, instrument};

/// Pipeline configuration
#[derive(Debug, Clone)]
pub struct PipelineConfig {
    /// Compression level (1-22)
    pub compression_level: i32,
    /// Buffer pool size (number of buffers)
    pub buffer_pool_size: usize,
    /// Buffer size (bytes, typically 32MB)
    pub buffer_size: usize,
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            compression_level: 3,
            buffer_pool_size: 100,
            buffer_size: 32 * 1024 * 1024, // 32MB
        }
    }
}

/// Processing pipeline for async chunk processing
///
/// Coordinates:
/// - Buffer pool management
/// - CPU-bound work on blocking thread pool
/// - Async orchestration
pub struct ProcessingPipeline {
    processor: Arc<ChunkProcessor>,
    buffer_pool: BufferPool,
    config: PipelineConfig,
}

impl ProcessingPipeline {
    /// Create new processing pipeline
    pub fn new(config: PipelineConfig) -> Result<Self, DataPlaneError> {
        let processor = Arc::new(ChunkProcessor::new(config.compression_level)?);
        let buffer_pool = BufferPool::new(config.buffer_size, config.buffer_pool_size);

        debug!(
            compression_level = config.compression_level,
            buffer_pool_size = config.buffer_pool_size,
            buffer_size_mb = config.buffer_size / (1024 * 1024),
            "Processing pipeline initialized"
        );

        Ok(Self {
            processor,
            buffer_pool,
            config,
        })
    }

    /// Process chunk asynchronously
    ///
    /// Spawns CPU-bound work on blocking thread pool via tokio::task::spawn_blocking
    ///
    /// # Arguments
    /// * `chunk_data` - Raw chunk data
    /// * `file_key` - Encryption key
    /// * `chunk_index` - Chunk index for AAD
    /// * `should_compress` - Whether to compress
    ///
    /// # Returns
    /// ProcessedChunk with encrypted data
    #[instrument(
        skip(self, chunk_data, file_key),
        fields(
            chunk_size = chunk_data.len(),
            chunk_index = chunk_index
        )
    )]
    pub async fn process_chunk_async(
        &self,
        chunk_data: Bytes,
        file_key: Arc<SecretKey>,
        chunk_index: u64,
        should_compress: bool,
    ) -> Result<ProcessedChunk, DataPlaneError> {
        let processor = Arc::clone(&self.processor);
        let key = file_key; // Arc<SecretKey> is cheap to move, no key bytes copied

        // Spawn CPU-bound work on blocking thread pool
        let result = task::spawn_blocking(move || {
            processor.process_chunk(&chunk_data, &key, chunk_index, should_compress)
        })
        .await
        .map_err(|e| DataPlaneError::Internal(format!("Task join error: {}", e)))??;

        debug!(
            encrypted_size = result.encrypted_data.len(),
            was_compressed = result.was_compressed,
            "Async chunk processing completed"
        );

        Ok(result)
    }

    /// Decrypt chunk asynchronously
    ///
    /// # Arguments
    /// * `encrypted_data` - Encrypted (and optionally compressed) data
    /// * `file_key` - Decryption key
    /// * `chunk_index` - Chunk index for AAD verification
    /// * `was_compressed` - Whether chunk was compressed
    ///
    /// # Returns
    /// Original chunk data
    #[instrument(
        skip(self, encrypted_data, file_key),
        fields(
            encrypted_size = encrypted_data.len(),
            chunk_index = chunk_index
        )
    )]
    pub async fn decrypt_chunk_async(
        &self,
        encrypted_data: Bytes,
        file_key: Arc<SecretKey>,
        chunk_index: u64,
        was_compressed: bool,
    ) -> Result<Vec<u8>, DataPlaneError> {
        let processor = Arc::clone(&self.processor);
        let key = file_key; // Arc<SecretKey> is cheap to move, no key bytes copied

        // Spawn CPU-bound work on blocking thread pool
        let result = task::spawn_blocking(move || {
            processor.decrypt_chunk(&encrypted_data, &key, chunk_index, was_compressed)
        })
        .await
        .map_err(|e| DataPlaneError::Internal(format!("Task join error: {}", e)))??;

        debug!(
            decrypted_size = result.len(),
            "Async chunk decryption completed"
        );

        Ok(result)
    }

    /// Get buffer pool statistics
    pub fn buffer_pool_stats(&self) -> crate::processing::buffer_pool::PoolStats {
        self.buffer_pool.stats()
    }

    /// Get pipeline configuration
    pub fn config(&self) -> &PipelineConfig {
        &self.config
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_async_process_chunk() {
        let config = PipelineConfig::default();
        let pipeline = ProcessingPipeline::new(config).unwrap();

        let key = Arc::new(SecretKey::from_bytes([0x42u8; 32]));
        let data = Bytes::from_static(b"Test data for async processing");

        let result = pipeline
            .process_chunk_async(data, Arc::clone(&key), 0, false)
            .await
            .unwrap();

        assert!(!result.was_compressed);
        assert!(result.encrypted_data.len() > 0);
        assert!(result.original_hash.starts_with("sha256:"));
    }

    #[tokio::test]
    async fn test_async_roundtrip() {
        let config = PipelineConfig::default();
        let pipeline = ProcessingPipeline::new(config).unwrap();

        let key = Arc::new(SecretKey::from_bytes([0x42u8; 32]));
        let original = Bytes::from_static(b"Test data for async roundtrip");

        // Encrypt
        let processed = pipeline
            .process_chunk_async(original.clone(), Arc::clone(&key), 5, true)
            .await
            .unwrap();

        assert!(processed.was_compressed);

        // Decrypt
        let decrypted = pipeline
            .decrypt_chunk_async(
                Bytes::from(processed.encrypted_data),
                Arc::clone(&key),
                5,
                true,
            )
            .await
            .unwrap();

        assert_eq!(original.as_ref(), &decrypted[..]);
    }

    #[tokio::test]
    async fn test_concurrent_processing() {
        let config = PipelineConfig::default();
        let pipeline = Arc::new(ProcessingPipeline::new(config).unwrap());

        let key = Arc::new(SecretKey::from_bytes([0x42u8; 32]));

        // Process 10 chunks concurrently
        let mut handles = vec![];

        for i in 0..10 {
            let pipeline = Arc::clone(&pipeline);
            let key = Arc::clone(&key);
            let data = Bytes::from(vec![i as u8; 1000]);

            let handle = tokio::spawn(async move {
                pipeline
                    .process_chunk_async(data, key, i as u64, false)
                    .await
            });

            handles.push(handle);
        }

        // Wait for all to complete
        for handle in handles {
            let result = handle.await.unwrap();
            assert!(result.is_ok());
        }
    }

    #[tokio::test]
    async fn test_buffer_pool_stats() {
        let config = PipelineConfig {
            compression_level: 3,
            buffer_pool_size: 50,
            buffer_size: 1024 * 1024, // 1MB
        };

        let pipeline = ProcessingPipeline::new(config).unwrap();

        let stats = pipeline.buffer_pool_stats();
        assert_eq!(stats.max_buffers, 50);
        assert_eq!(stats.buffer_size, 1024 * 1024);
    }

    #[tokio::test]
    async fn test_custom_config() {
        let config = PipelineConfig {
            compression_level: 9,
            buffer_pool_size: 200,
            buffer_size: 64 * 1024 * 1024, // 64MB
        };

        let pipeline = ProcessingPipeline::new(config.clone()).unwrap();

        assert_eq!(pipeline.config().compression_level, 9);
        assert_eq!(pipeline.config().buffer_pool_size, 200);
        assert_eq!(pipeline.config().buffer_size, 64 * 1024 * 1024);
    }

    #[tokio::test]
    async fn test_large_chunk_async() {
        let config = PipelineConfig::default();
        let pipeline = ProcessingPipeline::new(config).unwrap();

        let key = Arc::new(SecretKey::from_bytes([0x42u8; 32]));
        let data = Bytes::from(vec![0u8; 10 * 1024 * 1024]); // 10MB

        let result = pipeline
            .process_chunk_async(data, key, 0, true)
            .await
            .unwrap();

        assert!(result.was_compressed);
        assert_eq!(result.stats.original_size, 10 * 1024 * 1024);
    }
}
