use crate::compression::should_compress;

use crate::error::{DataPlaneError, SecurityError};
use crate::modes::{ModeEnforcer, NonZkModeProcessor, ProcessingMode, ZkModeProcessor};
use crate::server::request::{DownloadRequest, UploadRequest};
use crate::server::response::{ChunkResponse, ErrorResponse};
use crate::storage::ChunkStorage;
use bytes::Bytes;
use std::os::unix::io::RawFd;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, error, instrument};

/// Upload handler - processes upload requests
pub struct UploadHandler {
    zk_processor: ZkModeProcessor,
    non_zk_processor: NonZkModeProcessor,
    storage: Arc<Mutex<ChunkStorage>>,
}

impl UploadHandler {
    pub fn new(storage: Arc<Mutex<ChunkStorage>>, compression_level: i32) -> Result<Self, DataPlaneError> {
        Ok(Self {
            zk_processor: ZkModeProcessor::new(),
            non_zk_processor: NonZkModeProcessor::new(compression_level)?,
            storage,
        })
    }

    /// Handle upload request
    #[instrument(skip(self, chunk_data, key_fd), fields(file_id = %request.file_id, chunk_index = request.chunk_index, mode = %request.mode))]
    pub async fn handle_upload(
        &self,
        request: UploadRequest,
        chunk_data: Bytes,
        key_fd: Option<RawFd>,
    ) -> Result<ChunkResponse, ErrorResponse> {
        // Parse mode
        let mode = ProcessingMode::from_header(&request.mode)
            .map_err(|e| ErrorResponse::bad_request(format!("Invalid mode: {}", e)))?;

        // Enforce mode security (close key_fd on violation - it would otherwise leak)
        ModeEnforcer::enforce(mode, key_fd.is_some())
            .map_err(|e| {
                if let Some(fd) = key_fd {
                    crate::server::fd_guard::close_key_fd(fd);
                }
                error!(error = ?e, "Mode enforcement violation");
                match e {
                    SecurityError::ZkModeKeyLeakage => {
                        ErrorResponse::security_violation(
                            "ZK mode cannot receive encryption keys".to_string()
                        )
                    }
                    SecurityError::NonZkMissingKey => {
                        ErrorResponse::bad_request(
                            "Non-ZK mode requires encryption key".to_string()
                        )
                    }
                    _ => ErrorResponse::bad_request(format!("Security error: {}", e)),
                }
            })?;

        // Process based on mode
        let response = match mode {
            ProcessingMode::ZK => {
                self.handle_zk_upload(request, chunk_data).await?
            }
            ProcessingMode::NonZK => {
                let key_fd = key_fd.ok_or_else(|| {
                    ErrorResponse::bad_request("Missing key FD for Non-ZK mode".to_string())
                })?;
                self.handle_non_zk_upload(request, chunk_data, key_fd).await?
            }
        };

        Ok(response)
    }

    /// Handle ZK mode upload (server blind)
    async fn handle_zk_upload(
        &self,
        request: UploadRequest,
        chunk_data: Bytes,
    ) -> Result<ChunkResponse, ErrorResponse> {
        debug!("Processing ZK mode upload");

        // Verify chunk format
        self.zk_processor.verify_chunk_format(&chunk_data)
            .map_err(|e| ErrorResponse::bad_request(format!("Invalid chunk format: {}", e)))?;

        // Hash only (server blind operation)
        let processed = self.zk_processor.process_zk_chunk(&chunk_data, request.chunk_index)
            .map_err(|e| ErrorResponse::internal_error(format!("Processing failed: {}", e)))?;

        // Store encrypted chunk (already encrypted by client)
        let mut storage = self.storage.lock().await;
        storage.store_chunk(&request.file_id, request.chunk_index, &chunk_data)
            .map_err(|e| ErrorResponse::internal_error(format!("Storage failed: {}", e)))?;

        Ok(ChunkResponse {
            success: true,
            hash: processed.content_hash,
            original_size: processed.chunk_size,
            encrypted_size: processed.chunk_size,
            compressed: false,
            compression_ratio: None,
            encrypted_chunk_path: None,  // ZK mode doesn't store encrypted chunks
        })
    }

    /// Handle Non-ZK mode upload (server-side encryption)
    async fn handle_non_zk_upload(
        &self,
        request: UploadRequest,
        chunk_data: Bytes,
        key_fd: RawFd,
    ) -> Result<ChunkResponse, ErrorResponse> {
        debug!("Processing Non-ZK mode upload");

        // Read key from memfd
        #[cfg(target_os = "linux")]
        let key = crate::crypto::memfd::read_key_from_memfd(key_fd)
            .map_err(|e| ErrorResponse::internal_error(format!("Failed to read key: {}", e)))?;

        #[cfg(target_os = "macos")]
        let key = crate::crypto::memfd_macos::read_key_from_memfd(key_fd)
            .map_err(|e| ErrorResponse::internal_error(format!("Failed to read key: {}", e)))?;

        // Determine if compression should be used
        let should_compress = if request.compress {
            if let (Some(filename), Some(file_size)) = (&request.filename, request.file_size) {
                should_compress(filename, file_size)
            } else {
                request.compress
            }
        } else {
            false
        };

        // Verify chunk format
        self.non_zk_processor.verify_chunk_format(&chunk_data)
            .map_err(|e| ErrorResponse::bad_request(format!("Invalid chunk format: {}", e)))?;

        // Process: hash → compress → encrypt
        let processed = self.non_zk_processor
            .process_non_zk_chunk(&chunk_data, &key, request.chunk_index, should_compress)
            .map_err(|e| ErrorResponse::internal_error(format!("Processing failed: {}", e)))?;

        // Store encrypted chunk
        let mut storage = self.storage.lock().await;
        let chunk_path = storage.store_chunk(&request.file_id, request.chunk_index, &processed.encrypted_data)
            .map_err(|e| ErrorResponse::internal_error(format!("Storage failed: {}", e)))?;

        Ok(ChunkResponse {
            success: true,
            hash: processed.original_hash,
            original_size: processed.stats.original_size,
            encrypted_size: processed.stats.encrypted_size,
            compressed: processed.was_compressed,
            compression_ratio: processed.stats.compression_ratio,
            encrypted_chunk_path: Some(chunk_path.to_string_lossy().to_string()),
        })
    }
}

/// Download handler - processes download requests
pub struct DownloadHandler {
    non_zk_processor: NonZkModeProcessor,
    storage: Arc<Mutex<ChunkStorage>>,
}

impl DownloadHandler {
    pub fn new(storage: Arc<Mutex<ChunkStorage>>, compression_level: i32) -> Result<Self, DataPlaneError> {
        Ok(Self {
            non_zk_processor: NonZkModeProcessor::new(compression_level)?,
            storage,
        })
    }

    /// Handle download request
    #[instrument(skip(self, key_fd), fields(file_id = %request.file_id, chunk_index = request.chunk_index, mode = %request.mode))]
    pub async fn handle_download(
        &self,
        request: DownloadRequest,
        key_fd: Option<RawFd>,
    ) -> Result<Vec<u8>, ErrorResponse> {
        // Parse mode
        let mode = ProcessingMode::from_header(&request.mode)
            .map_err(|e| ErrorResponse::bad_request(format!("Invalid mode: {}", e)))?;

        // Enforce mode security (close key_fd on violation - it would otherwise leak)
        ModeEnforcer::enforce(mode, key_fd.is_some())
            .map_err(|e| {
                if let Some(fd) = key_fd {
                    crate::server::fd_guard::close_key_fd(fd);
                }
                error!(error = ?e, "Mode enforcement violation");
                ErrorResponse::security_violation(format!("Security violation: {}", e))
            })?;

        // Retrieve encrypted chunk (close key_fd on error - would otherwise leak)
        let storage = self.storage.lock().await;
        let encrypted_data = storage.retrieve_chunk(&request.file_id, request.chunk_index)
            .map_err(|e| {
                if let Some(fd) = key_fd {
                    crate::server::fd_guard::close_key_fd(fd);
                }
                ErrorResponse::bad_request(format!("Chunk not found: {}", e))
            })?;
        drop(storage);

        // Process based on mode
        match mode {
            ProcessingMode::ZK => {
                // ZK mode: return encrypted data as-is (client will decrypt)
                debug!("Returning ZK mode chunk (encrypted)");
                Ok(encrypted_data)
            }
            ProcessingMode::NonZK => {
                // Non-ZK mode: decrypt and decompress
                let key_fd = key_fd.ok_or_else(|| {
                    ErrorResponse::bad_request("Missing key FD for Non-ZK mode".to_string())
                })?;

                self.handle_non_zk_download(encrypted_data, key_fd, request.chunk_index, request.was_compressed).await
            }
        }
    }

    /// Handle Non-ZK mode download (decrypt and decompress)
    async fn handle_non_zk_download(
        &self,
        encrypted_data: Vec<u8>,
        key_fd: RawFd,
        chunk_index: u64,
        was_compressed: bool,
    ) -> Result<Vec<u8>, ErrorResponse> {
        debug!("Processing Non-ZK mode download");

        // Read key from memfd
        #[cfg(target_os = "linux")]
        let key = crate::crypto::memfd::read_key_from_memfd(key_fd)
            .map_err(|e| ErrorResponse::internal_error(format!("Failed to read key: {}", e)))?;

        #[cfg(target_os = "macos")]
        let key = crate::crypto::memfd_macos::read_key_from_memfd(key_fd)
            .map_err(|e| ErrorResponse::internal_error(format!("Failed to read key: {}", e)))?;

        // Decrypt and decompress
        let plaintext = self.non_zk_processor
            .decrypt_non_zk_chunk(&encrypted_data, &key, chunk_index, was_compressed)
            .map_err(|e| ErrorResponse::internal_error(format!("Decryption failed: {}", e)))?;

        debug!(decrypted_size = plaintext.len(), "Decryption completed");
        Ok(plaintext)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::WriteOptions;
    use tempfile::TempDir;

    fn create_test_storage() -> (Arc<Mutex<ChunkStorage>>, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let storage = ChunkStorage::new(temp_dir.path(), WriteOptions::default());
        (Arc::new(Mutex::new(storage)), temp_dir)
    }

    #[tokio::test]
    async fn test_upload_handler_creation() {
        let (storage, _temp_dir) = create_test_storage();
        let handler = UploadHandler::new(storage, 3);
        assert!(handler.is_ok());
    }

    #[tokio::test]
    async fn test_download_handler_creation() {
        let (storage, _temp_dir) = create_test_storage();
        let handler = DownloadHandler::new(storage, 3);
        assert!(handler.is_ok());
    }

    #[tokio::test]
    async fn test_zk_mode_upload() {
        let (storage, _temp_dir) = create_test_storage();
        let handler = UploadHandler::new(storage, 3).unwrap();

        let request = UploadRequest {
            mode: "zk".to_string(),
            file_id: "test-file".to_string(),
            chunk_index: 0,
            compress: false,
            filename: None,
            file_size: None,
        };

        // Pre-encrypted data (simulating client-side encryption)
        let encrypted_data = Bytes::from(vec![0u8; 1024]);

        let result = handler.handle_upload(request, encrypted_data, None).await;
        assert!(result.is_ok());

        let response = result.unwrap();
        assert!(response.success);
        assert!(!response.compressed);
    }

    #[tokio::test]
    async fn test_zk_mode_rejects_key_fd() {
        let (storage, _temp_dir) = create_test_storage();
        let handler = UploadHandler::new(storage, 3).unwrap();

        let request = UploadRequest {
            mode: "zk".to_string(),
            file_id: "test-file".to_string(),
            chunk_index: 0,
            compress: false,
            filename: None,
            file_size: None,
        };

        let encrypted_data = Bytes::from(vec![0u8; 1024]);

        // ZK mode with key FD should fail (security violation)
        let result = handler.handle_upload(request, encrypted_data, Some(99)).await;
        assert!(result.is_err());

        let err = result.unwrap_err();
        assert_eq!(err.status_code, 403); // Security violation
    }

    #[tokio::test]
    async fn test_invalid_mode() {
        let (storage, _temp_dir) = create_test_storage();
        let handler = UploadHandler::new(storage, 3).unwrap();

        let request = UploadRequest {
            mode: "invalid-mode".to_string(),
            file_id: "test-file".to_string(),
            chunk_index: 0,
            compress: false,
            filename: None,
            file_size: None,
        };

        let data = Bytes::from(vec![0u8; 1024]);

        let result = handler.handle_upload(request, data, None).await;
        assert!(result.is_err());

        let err = result.unwrap_err();
        assert_eq!(err.status_code, 400); // Bad request
    }
}
