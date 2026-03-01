use crate::compression::should_compress;

use crate::error::{DataPlaneError, SecurityError};
use crate::modes::{ModeEnforcer, NonZkModeProcessor, ProcessingMode, ZkModeProcessor};
use crate::server::request::{DownloadRequest, UploadRequest};
use crate::server::response::{ChunkResponse, ErrorResponse};
use crate::storage::ChunkStorage;
use bytes::Bytes;
use std::os::unix::io::RawFd;
use std::path::PathBuf;
use std::sync::Arc;
use tracing::{debug, error, instrument};

/// Upload handler - processes upload requests
pub struct UploadHandler {
    zk_processor: Arc<ZkModeProcessor>,
    non_zk_processor: Arc<NonZkModeProcessor>,
    storage: Arc<ChunkStorage>,
}

impl UploadHandler {
    pub fn new(storage: Arc<ChunkStorage>, compression_level: i32) -> Result<Self, DataPlaneError> {
        Ok(Self {
            zk_processor: Arc::new(ZkModeProcessor::new()),
            non_zk_processor: Arc::new(NonZkModeProcessor::new(compression_level)?),
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
        let mode = ProcessingMode::from_header(&request.mode)
            .map_err(|e| ErrorResponse::bad_request(format!("Invalid mode: {}", e)))?;

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

        let response = match mode {
            ProcessingMode::ZK => {
                self.handle_zk_upload(request, chunk_data).await?
            }
            ProcessingMode::NonZK => {
                let key_fd = key_fd.ok_or_else(|| {
                    ErrorResponse::bad_request("Missing key FD for Non-ZK mode".to_string())
                })?;
                let target_path = request.target_path.clone();
                self.handle_non_zk_upload(request, chunk_data, key_fd, target_path).await?
            }
        };

        Ok(response)
    }

    /// Handle ZK mode upload (server blind)
    ///
    /// CPU-bound hashing and blocking I/O are offloaded to a blocking thread
    /// so the tokio async runtime stays responsive under concurrent load.
    async fn handle_zk_upload(
        &self,
        request: UploadRequest,
        chunk_data: Bytes,
    ) -> Result<ChunkResponse, ErrorResponse> {
        debug!("Processing ZK mode upload");

        self.zk_processor.verify_chunk_format(&chunk_data)
            .map_err(|e| ErrorResponse::bad_request(format!("Invalid chunk format: {}", e)))?;

        let zk_processor = Arc::clone(&self.zk_processor);
        let storage = Arc::clone(&self.storage);
        let file_id = request.file_id.clone();
        let chunk_index = request.chunk_index;

        let (content_hash, chunk_size) = tokio::task::spawn_blocking(move || {
            let processed = zk_processor.process_zk_chunk(&chunk_data, chunk_index)?;
            storage.store_chunk(&file_id, chunk_index, &chunk_data)?;
            Ok::<_, DataPlaneError>((processed.content_hash, processed.chunk_size))
        })
        .await
        .map_err(|e| ErrorResponse::internal_error(format!("Task join error: {}", e)))?
        .map_err(|e| ErrorResponse::internal_error(format!("Processing failed: {}", e)))?;

        Ok(ChunkResponse {
            success: true,
            hash: content_hash,
            original_size: chunk_size,
            encrypted_size: chunk_size,
            compressed: false,
            compression_ratio: None,
            encrypted_chunk_path: None,
        })
    }

    /// Handle Non-ZK mode upload (server-side encryption)
    ///
    /// The full pipeline (hash, compress, encrypt, write) is offloaded to a
    /// blocking thread to avoid starving the tokio runtime with ~300 ms of
    /// CPU + I/O work per 32 MB chunk.
    async fn handle_non_zk_upload(
        &self,
        request: UploadRequest,
        chunk_data: Bytes,
        key_fd: RawFd,
        target_path: Option<String>,
    ) -> Result<ChunkResponse, ErrorResponse> {
        debug!("Processing Non-ZK mode upload");

        #[cfg(target_os = "linux")]
        let key = crate::crypto::memfd::read_key_from_memfd(key_fd)
            .map_err(|e| ErrorResponse::internal_error(format!("Failed to read key: {}", e)))?;

        #[cfg(target_os = "macos")]
        let key = crate::crypto::memfd_macos::read_key_from_memfd(key_fd)
            .map_err(|e| ErrorResponse::internal_error(format!("Failed to read key: {}", e)))?;

        let should_compress = if request.compress {
            if let (Some(filename), Some(file_size)) = (&request.filename, request.file_size) {
                should_compress(filename, file_size)
            } else {
                request.compress
            }
        } else {
            false
        };

        self.non_zk_processor.verify_chunk_format(&chunk_data)
            .map_err(|e| ErrorResponse::bad_request(format!("Invalid chunk format: {}", e)))?;

        let processor = Arc::clone(&self.non_zk_processor);
        let storage = Arc::clone(&self.storage);
        let file_id = request.file_id.clone();
        let chunk_index = request.chunk_index;

        let (original_hash, original_size, encrypted_size, was_compressed, compression_ratio, chunk_path) =
            tokio::task::spawn_blocking(move || {
                let processed = processor
                    .process_non_zk_chunk(&chunk_data, &key, chunk_index, should_compress)?;

                let chunk_path = if let Some(ref tp) = target_path {
                    storage.store_chunk_at(&PathBuf::from(tp), &processed.encrypted_data)?
                } else {
                    storage.store_chunk(&file_id, chunk_index, &processed.encrypted_data)?
                };

                Ok::<_, DataPlaneError>((
                    processed.original_hash,
                    processed.stats.original_size,
                    processed.stats.encrypted_size,
                    processed.was_compressed,
                    processed.stats.compression_ratio,
                    chunk_path,
                ))
            })
            .await
            .map_err(|e| ErrorResponse::internal_error(format!("Task join error: {}", e)))?
            .map_err(|e| ErrorResponse::internal_error(format!("Processing failed: {}", e)))?;

        Ok(ChunkResponse {
            success: true,
            hash: original_hash,
            original_size,
            encrypted_size,
            compressed: was_compressed,
            compression_ratio,
            encrypted_chunk_path: Some(chunk_path.to_string_lossy().to_string()),
        })
    }
}

/// Download handler - processes download requests
pub struct DownloadHandler {
    non_zk_processor: Arc<NonZkModeProcessor>,
    storage: Arc<ChunkStorage>,
}

impl DownloadHandler {
    pub fn new(storage: Arc<ChunkStorage>, compression_level: i32) -> Result<Self, DataPlaneError> {
        Ok(Self {
            non_zk_processor: Arc::new(NonZkModeProcessor::new(compression_level)?),
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
        let mode = ProcessingMode::from_header(&request.mode)
            .map_err(|e| ErrorResponse::bad_request(format!("Invalid mode: {}", e)))?;

        ModeEnforcer::enforce(mode, key_fd.is_some())
            .map_err(|e| {
                if let Some(fd) = key_fd {
                    crate::server::fd_guard::close_key_fd(fd);
                }
                error!(error = ?e, "Mode enforcement violation");
                ErrorResponse::security_violation(format!("Security violation: {}", e))
            })?;

        let storage = Arc::clone(&self.storage);
        let file_id = request.file_id.clone();
        let chunk_index = request.chunk_index;

        let encrypted_data = tokio::task::spawn_blocking(move || {
            storage.retrieve_chunk(&file_id, chunk_index)
        })
        .await
        .map_err(|e| {
            if let Some(fd) = key_fd {
                crate::server::fd_guard::close_key_fd(fd);
            }
            ErrorResponse::internal_error(format!("Task join error: {}", e))
        })?
        .map_err(|e| {
            if let Some(fd) = key_fd {
                crate::server::fd_guard::close_key_fd(fd);
            }
            ErrorResponse::bad_request(format!("Chunk not found: {}", e))
        })?;

        match mode {
            ProcessingMode::ZK => {
                debug!("Returning ZK mode chunk (encrypted)");
                Ok(encrypted_data)
            }
            ProcessingMode::NonZK => {
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

        #[cfg(target_os = "linux")]
        let key = crate::crypto::memfd::read_key_from_memfd(key_fd)
            .map_err(|e| ErrorResponse::internal_error(format!("Failed to read key: {}", e)))?;

        #[cfg(target_os = "macos")]
        let key = crate::crypto::memfd_macos::read_key_from_memfd(key_fd)
            .map_err(|e| ErrorResponse::internal_error(format!("Failed to read key: {}", e)))?;

        let processor = Arc::clone(&self.non_zk_processor);

        let plaintext = tokio::task::spawn_blocking(move || {
            processor.decrypt_non_zk_chunk(&encrypted_data, &key, chunk_index, was_compressed)
        })
        .await
        .map_err(|e| ErrorResponse::internal_error(format!("Task join error: {}", e)))?
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

    fn create_test_storage() -> (Arc<ChunkStorage>, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let storage = ChunkStorage::new(temp_dir.path(), WriteOptions::default());
        (Arc::new(storage), temp_dir)
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
            target_path: None,
        };

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
            target_path: None,
        };

        let encrypted_data = Bytes::from(vec![0u8; 1024]);

        let result = handler.handle_upload(request, encrypted_data, Some(99)).await;
        assert!(result.is_err());

        let err = result.unwrap_err();
        assert_eq!(err.status_code, 403);
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
            target_path: None,
        };

        let data = Bytes::from(vec![0u8; 1024]);

        let result = handler.handle_upload(request, data, None).await;
        assert!(result.is_err());

        let err = result.unwrap_err();
        assert_eq!(err.status_code, 400);
    }
}
