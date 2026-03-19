//! Unix Domain Socket Server with SCM_RIGHTS support
//!
//! This is an alternative UDS server implementation that supports receiving file descriptors
//! via SCM_RIGHTS ancillary data for secure key passing in Non-ZK mode.
//!
//! Unlike the Hyper-based server, this uses custom HTTP parsing to access the raw socket
//! for recvmsg() with ancillary data.

use crate::crypto::SecretKey;
use crate::processing::ChunkProcessor;
use crate::resilience::{CircuitBreaker, CircuitBreakerConfig, RateLimiter, RateLimiterConfig};
use crate::server::fd_guard;
use crate::server::handlers::{DownloadHandler, UploadHandler};
use crate::server::request::{DownloadRequest, UploadRequest};
use crate::server::scm_rights::{
    build_http_response, parse_http_request, recv_with_scm_rights,
};
use crate::server::stream_download_handler::{StreamDownloadRequest, ChunkDescriptor};
use crate::server::ServerConfig;
use crate::storage::ChunkStorage;
use base64::Engine as _;
use bytes::Bytes;
use futures_util::stream::{FuturesOrdered, StreamExt};
use memmap2::Mmap;
use scopeguard;
use serde::Deserialize;
use std::os::unix::io::{AsRawFd, RawFd};
use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, Semaphore};
use tracing::{debug, error, info, instrument};

/// Maximum allowed chunk size (64MB) - prevents OOM from adversarial Content-Length
const MAX_CHUNK_SIZE: usize = 64 * 1024 * 1024;

/// Unix Domain Socket HTTP server with SCM_RIGHTS support
pub struct UnixSocketServerWithScmRights {
    config: ServerConfig,
    upload_handler: Arc<UploadHandler>,
    download_handler: Arc<DownloadHandler>,
    circuit_breaker: Arc<CircuitBreaker>,
    rate_limiter: Arc<RateLimiter>,
}

impl UnixSocketServerWithScmRights {
    /// Create new server with SCM_RIGHTS support
    pub fn new(config: ServerConfig) -> Result<Self, Box<dyn std::error::Error>> {
        let storage = Arc::new(ChunkStorage::new(
            &config.storage_root,
            config.write_options.clone(),
        ));

        let upload_handler = Arc::new(
            UploadHandler::new(Arc::clone(&storage), config.compression_level)?
        );

        let download_handler = Arc::new(
            DownloadHandler::new(Arc::clone(&storage), config.compression_level)?
        );

        let circuit_breaker = Arc::new(CircuitBreaker::new(CircuitBreakerConfig::default()));
        let rate_limiter = Arc::new(RateLimiter::new(RateLimiterConfig::default()));

        Ok(Self {
            config,
            upload_handler,
            download_handler,
            circuit_breaker,
            rate_limiter,
        })
    }

    /// Start serving requests (shuts down gracefully when shutdown_rx receives)
    #[instrument(skip(self, shutdown_rx))]
    pub async fn serve(
        &self,
        mut shutdown_rx: broadcast::Receiver<()>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        // Remove existing socket if present
        let socket_path = Path::new(&self.config.socket_path);
        if socket_path.exists() {
            std::fs::remove_file(socket_path)?;
            debug!(socket = %self.config.socket_path, "Removed existing socket");
        }

        // Bind to Unix socket
        let listener = UnixListener::bind(&self.config.socket_path)?;
        info!(
            socket = %self.config.socket_path,
            "Server listening on Unix socket (SCM_RIGHTS enabled)"
        );

        // Accept connections until shutdown signal
        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => {
                    info!("Shutdown signal received, stopping acceptor");
                    break;
                }
                result = listener.accept() => match result {
                    Ok((stream, _addr)) => {
                        debug!("Accepted connection");

                        let upload_handler = Arc::clone(&self.upload_handler);
                        let download_handler = Arc::clone(&self.download_handler);
                        let circuit_breaker = Arc::clone(&self.circuit_breaker);
                        let rate_limiter = Arc::clone(&self.rate_limiter);
                        let compression_level = self.config.compression_level;

                        // Spawn connection handler
                        tokio::spawn(async move {
                            if let Err(e) = Self::handle_connection(
                                stream,
                                upload_handler,
                                download_handler,
                                circuit_breaker,
                                rate_limiter,
                                compression_level,
                            )
                            .await
                            {
                                error!(error = %e, "Connection handling error");
                            }
                        });
                    }
                    Err(e) => {
                        error!(error = %e, "Failed to accept connection");
                    }
                }
            }
        }

        Ok(())
    }

    /// Handle a single connection with SCM_RIGHTS support
    #[instrument(skip(stream, upload_handler, download_handler, circuit_breaker, rate_limiter))]
    async fn handle_connection(
        mut stream: UnixStream,
        upload_handler: Arc<UploadHandler>,
        download_handler: Arc<DownloadHandler>,
        circuit_breaker: Arc<CircuitBreaker>,
        rate_limiter: Arc<RateLimiter>,
        compression_level: i32,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let fd = stream.as_raw_fd();

        // Buffers for receiving data
        let buffer = vec![0u8; 64 * 1024]; // Initial receive buffer (64KB)
        let ancillary_buffer = vec![0u8; 256]; // For SCM_RIGHTS control messages

        // Receive initial data + potential FD via SCM_RIGHTS
        // Use spawn_blocking and return the data with the result
        let (bytes_read, received_fd, buffer) = tokio::task::spawn_blocking(move || {
            // Tokio sets accepted sockets to non-blocking mode. recvmsg() is a raw
            // syscall that returns EAGAIN on a non-blocking FD if data hasn't arrived
            // yet, which kills the connection (Python sees "Broken pipe").
            // Temporarily switch to blocking mode so recvmsg waits for the data +
            // SCM_RIGHTS ancillary message, then restore non-blocking for Tokio.
            unsafe {
                let flags = libc::fcntl(fd, libc::F_GETFL);
                if flags == -1 {
                    return Err(nix::Error::last().into());
                }
                if libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) == -1 {
                    return Err(nix::Error::last().into());
                }
            }

            let mut buf = buffer;
            let mut anc_buf = ancillary_buffer;
            let result = recv_with_scm_rights(fd, &mut buf, &mut anc_buf);

            // Restore non-blocking mode for subsequent tokio async reads
            unsafe {
                let flags = libc::fcntl(fd, libc::F_GETFL);
                if flags != -1 {
                    libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
                }
            }

            match result {
                Ok((bytes, fd_opt)) => Ok((bytes, fd_opt, buf)),
                Err(e) => Err(e),
            }
        })
        .await??;

        if bytes_read > 0 {
            debug!(bytes = bytes_read, fd_received = received_fd.is_some(), "Received data");
        }

        // Parse HTTP request
        let (method, path, headers, body_start) = parse_http_request(&buffer, bytes_read)?;

        debug!(method = %method, path = %path, "Processing HTTP request");

        // Skip rate limit and circuit breaker for health checks
        let path_str = path.as_str();
        if path_str != "/health" {
            if rate_limiter.allow_request().is_err() {
                let response = build_http_response(
                    429,
                    "Too Many Requests",
                    r#"{"success":false,"error":"rate_limit_exceeded","message":"Too many requests"}"#,
                    &[],
                );
                stream.write_all(&response).await?;
                return Ok(());
            }
            if circuit_breaker.allow_request().is_err() {
                let response = build_http_response(
                    503,
                    "Service Unavailable",
                    r#"{"success":false,"error":"circuit_breaker_open","message":"Service temporarily unavailable"}"#,
                    &[],
                );
                stream.write_all(&response).await?;
                return Ok(());
            }
        }

        // Handle different endpoints
        match (method.as_str(), path_str) {
            ("GET", "/health") => {
                // Health check - simple response
                let response = build_http_response(
                    200,
                    "OK",
                    r#"{"status":"healthy"}"#,
                    &[],
                );
                stream.write_all(&response).await?;
                Ok(())
            }

            ("POST", "/upload") => {
                Self::handle_upload(
                    &buffer,
                    bytes_read,
                    body_start,
                    &headers,
                    received_fd,
                    upload_handler,
                    circuit_breaker,
                    &mut stream,
                )
                .await
            }

            ("GET", "/download") => {
                Self::handle_download(
                    fd,
                    &headers,
                    received_fd,
                    download_handler,
                    circuit_breaker,
                    &mut stream,
                )
                .await
            }

            ("POST", "/dedup-chunk") => {
                Self::handle_dedup_chunk(
                    &buffer,
                    bytes_read,
                    body_start,
                    &headers,
                    compression_level,
                    &mut stream,
                )
                .await
            }

            ("POST", "/convergent-decrypt") => {
                Self::handle_convergent_decrypt(
                    &buffer,
                    bytes_read,
                    body_start,
                    &headers,
                    &mut stream,
                )
                .await
            }

            ("POST", "/dedup-chunk-batch") => {
                Self::handle_dedup_chunk_batch(
                    &buffer,
                    bytes_read,
                    body_start,
                    &headers,
                    compression_level,
                    &mut stream,
                )
                .await
            }

            ("POST", "/bulk-decrypt") => {
                Self::handle_bulk_decrypt(
                    &buffer,
                    bytes_read,
                    body_start,
                    &headers,
                    &mut stream,
                )
                .await
            }

            ("POST", "/stream-download") => {
                Self::handle_stream_download(
                    &buffer,
                    bytes_read,
                    body_start,
                    &headers,
                    &mut stream,
                )
                .await
            }

            _ => {
                // 404 Not Found
                let response = build_http_response(
                    404,
                    "Not Found",
                    r#"{"success":false,"error":"not_found","message":"Endpoint not found"}"#,
                    &[],
                );
                stream.write_all(&response).await?;
                Ok(())
            }
        }
    }

    /// Handle upload request
    #[instrument(skip(buffer, headers, upload_handler, stream, circuit_breaker))]
    async fn handle_upload(
        buffer: &[u8],
        bytes_read: usize,
        body_start: usize,
        headers: &[(String, String)],
        key_fd: Option<RawFd>,
        upload_handler: Arc<UploadHandler>,
        circuit_breaker: Arc<CircuitBreaker>,
        stream: &mut UnixStream,
    ) -> Result<(), Box<dyn std::error::Error>> {
        // Guard: close key_fd on any error path before we pass it to the handler
        let fd_guard = key_fd.map(|fd| scopeguard::guard((), move |_| fd_guard::close_key_fd(fd)));

        // Extract headers
        let mode = headers
            .iter()
            .find(|(k, _)| k == "x-mode")
            .map(|(_, v)| v.as_str())
            .unwrap_or("zk");

        let file_id = headers
            .iter()
            .find(|(k, _)| k == "x-file-id")
            .map(|(_, v)| v.clone())
            .ok_or("Missing x-file-id header")?;

        crate::server::request::validate_file_id(&file_id)
            .map_err(|e| format!("Invalid file_id: {}", e))?;

        let chunk_index = headers
            .iter()
            .find(|(k, _)| k == "x-chunk-index")
            .and_then(|(_, v)| v.parse::<u64>().ok())
            .unwrap_or(0);

        let should_compress = headers
            .iter()
            .find(|(k, _)| k == "x-should-compress")
            .map(|(_, v)| v == "true")
            .unwrap_or(false);

        let filename = headers
            .iter()
            .find(|(k, _)| k == "x-filename")
            .map(|(_, v)| v.clone());

        let file_size = headers
            .iter()
            .find(|(k, _)| k == "x-file-size")
            .and_then(|(_, v)| v.parse::<u64>().ok());

        let target_path = headers
            .iter()
            .find(|(k, _)| k == "x-target-path")
            .map(|(_, v)| v.clone());

        // Validate target_path: must be absolute and must not contain path traversal
        if let Some(ref tp) = target_path {
            if !tp.starts_with('/') || tp.contains("..") {
                let err_json = serde_json::json!({
                    "success": false,
                    "error": "invalid_target_path",
                    "message": "target_path must be an absolute path and must not contain '..'"
                }).to_string();
                let resp = build_http_response(400, "Bad Request", &err_json, &[]);
                stream.write_all(&resp).await?;
                return Ok(());
            }
        }

        // Get Content-Length and enforce cap to prevent OOM
        let content_length = headers
            .iter()
            .find(|(k, _)| k == "content-length")
            .and_then(|(_, v)| v.parse::<usize>().ok())
            .ok_or("Missing Content-Length header")?;

        if content_length > MAX_CHUNK_SIZE {
            return Err(format!(
                "Content-Length {} exceeds maximum allowed {} bytes",
                content_length, MAX_CHUNK_SIZE
            )
            .into());
        }

        // Read body using tokio's async read
        let mut chunk_data = Vec::with_capacity(content_length);

        // Copy any body data from initial buffer
        let initial_body_len = bytes_read.saturating_sub(body_start);
        if initial_body_len > 0 {
            let copy_len = initial_body_len.min(content_length);
            chunk_data.extend_from_slice(&buffer[body_start..body_start + copy_len]);
            debug!(copied = copy_len, "Copied partial body from initial buffer");
        }

        // Read remaining body if needed using async read (with timeout to prevent slowloris)
        if chunk_data.len() < content_length {
            let remaining = content_length - chunk_data.len();
            let mut remaining_data = vec![0u8; remaining];
            tokio::time::timeout(
                std::time::Duration::from_secs(300),
                stream.read_exact(&mut remaining_data),
            )
            .await
            .map_err(|_| "Body read timeout (300s exceeded)")??;
            chunk_data.extend_from_slice(&remaining_data);
            debug!(read = remaining, total = chunk_data.len(), "Read remaining body");
        }

        // Create upload request
        let upload_req = UploadRequest {
            file_id,
            chunk_index,
            mode: mode.to_string(),
            compress: should_compress,
            filename,
            file_size,
            target_path,
        };

        // Call handler
        let response = if mode == "non-zk" {
            // Non-ZK mode requires key FD - disarm guard before handler (handler will close it)
            let fd = key_fd.ok_or("Non-ZK mode requires encryption key FD")?;
            if let Some(g) = fd_guard {
                scopeguard::ScopeGuard::into_inner(g);
            }

            debug!("Processing Non-ZK upload with key from FD");

            match upload_handler
                .handle_upload(upload_req, Bytes::from(chunk_data), Some(fd))
                .await
            {
                Ok(resp) => {
                    circuit_breaker.record_success();
                    let json = serde_json::to_string(&resp)?;
                    build_http_response(200, "OK", &json, &[])
                }
                Err(err_resp) => {
                    circuit_breaker.record_failure();
                    let json = serde_json::to_string(&err_resp)?;
                    build_http_response(err_resp.status_code, "Error", &json, &[])
                }
            }
        } else {
            // ZK mode - no key needed
            debug!("Processing ZK upload");

            match upload_handler
                .handle_upload(upload_req, Bytes::from(chunk_data), None)
                .await
            {
                Ok(resp) => {
                    circuit_breaker.record_success();
                    let json = serde_json::to_string(&resp)?;
                    build_http_response(200, "OK", &json, &[])
                }
                Err(err_resp) => {
                    circuit_breaker.record_failure();
                    let json = serde_json::to_string(&err_resp)?;
                    build_http_response(err_resp.status_code, "Error", &json, &[])
                }
            }
        };

        stream.write_all(&response).await?;
        Ok(())
    }

    /// Handle download request
    #[instrument(skip(headers, download_handler, stream, circuit_breaker))]
    async fn handle_download(
        _fd: RawFd,
        headers: &[(String, String)],
        key_fd: Option<RawFd>,
        download_handler: Arc<DownloadHandler>,
        circuit_breaker: Arc<CircuitBreaker>,
        stream: &mut UnixStream,
    ) -> Result<(), Box<dyn std::error::Error>> {
        // Guard: close key_fd on any error path before we pass it to the handler
        let mut download_fd_guard = key_fd.map(|fd| scopeguard::guard((), move |_| fd_guard::close_key_fd(fd)));

        // Extract headers
        let mode = headers
            .iter()
            .find(|(k, _)| k == "x-mode")
            .map(|(_, v)| v.as_str())
            .unwrap_or("zk");

        let file_id = headers
            .iter()
            .find(|(k, _)| k == "x-file-id")
            .map(|(_, v)| v.clone())
            .ok_or("Missing x-file-id header")?;

        crate::server::request::validate_file_id(&file_id)
            .map_err(|e| format!("Invalid file_id: {}", e))?;

        let chunk_index = headers
            .iter()
            .find(|(k, _)| k == "x-chunk-index")
            .and_then(|(_, v)| v.parse::<u64>().ok())
            .unwrap_or(0);

        let was_compressed = headers
            .iter()
            .find(|(k, _)| k == "x-was-compressed")
            .map(|(_, v)| v == "true")
            .unwrap_or(false);

        // Create download request
        let download_req = DownloadRequest {
            file_id,
            chunk_index,
            mode: mode.to_string(),
            was_compressed,
        };

        // Disarm guard before handler (handler takes ownership and closes fd)
        if let Some(g) = download_fd_guard.take() {
            scopeguard::ScopeGuard::into_inner(g);
        }

        // Call handler
        match download_handler
            .handle_download(download_req, key_fd)
            .await
        {
            Ok(chunk_data) => {
                circuit_breaker.record_success();
                // Build response with binary data
                let mut response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    chunk_data.len()
                ).into_bytes();

                response.extend_from_slice(&chunk_data);

                stream.write_all(&response).await?;
                Ok(())
            }
            Err(err_resp) => {
                circuit_breaker.record_failure();
                let json = serde_json::to_string(&err_resp)?;
                let response = build_http_response(err_resp.status_code, "Error", &json, &[]);
                stream.write_all(&response).await?;
                Ok(())
            }
        }
    }

    /// Handle dedup-chunk request (no SCM_RIGHTS needed -- key is content-derived)
    #[instrument(skip(buffer, headers, stream))]
    async fn handle_dedup_chunk(
        buffer: &[u8],
        bytes_read: usize,
        body_start: usize,
        headers: &[(String, String)],
        compression_level: i32,
        stream: &mut UnixStream,
    ) -> Result<(), Box<dyn std::error::Error>> {
        use crate::server::dedup_handler::{DedupChunkRequest, process_dedup_chunk};

        let dedup_req = match DedupChunkRequest::from_raw_headers(headers) {
            Ok(r) => r,
            Err(e) => {
                let json = serde_json::to_string(&e)?;
                let resp = build_http_response(400, "Bad Request", &json, &[]);
                stream.write_all(&resp).await?;
                return Ok(());
            }
        };

        let content_length = headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, v)| v.parse::<usize>().ok())
            .unwrap_or(0);

        if content_length > MAX_CHUNK_SIZE {
            let err_json = format!(
                r#"{{"success":false,"error":"bad_request","message":"Content-Length {} exceeds maximum {}"}}"#,
                content_length, MAX_CHUNK_SIZE
            );
            let resp = build_http_response(400, "Bad Request", &err_json, &[]);
            stream.write_all(&resp).await?;
            return Ok(());
        }

        // Assemble the full body (initial buffer may only contain a partial body)
        let mut block_data = Vec::with_capacity(content_length);

        let initial_body_len = bytes_read.saturating_sub(body_start);
        if initial_body_len > 0 {
            let copy_len = initial_body_len.min(content_length);
            block_data.extend_from_slice(&buffer[body_start..body_start + copy_len]);
        }

        if block_data.len() < content_length {
            let remaining = content_length - block_data.len();
            let mut remaining_data = vec![0u8; remaining];
            tokio::time::timeout(
                std::time::Duration::from_secs(300),
                stream.read_exact(&mut remaining_data),
            )
            .await
            .map_err(|_| "Body read timeout (300s exceeded)")??;
            block_data.extend_from_slice(&remaining_data);
            debug!(read = remaining, total = block_data.len(), "Read remaining dedup-chunk body");
        }

        let result = tokio::task::spawn_blocking(move || {
            process_dedup_chunk(&dedup_req, &block_data, compression_level)
        })
        .await?;

        match result {
            Ok(resp) => {
                let json = serde_json::to_string(&resp)?;
                let response = build_http_response(200, "OK", &json, &[]);
                stream.write_all(&response).await?;
            }
            Err(err_resp) => {
                let json = serde_json::to_string(&err_resp)?;
                let response = build_http_response(err_resp.status_code, "Error", &json, &[]);
                stream.write_all(&response).await?;
            }
        }

        Ok(())
    }

    /// Handle convergent-decrypt request (PBKDF2 + AES-GCM decryption, no SCM_RIGHTS needed)
    #[instrument(skip(buffer, headers, stream))]
    async fn handle_convergent_decrypt(
        buffer: &[u8],
        bytes_read: usize,
        body_start: usize,
        headers: &[(String, String)],
        stream: &mut UnixStream,
    ) -> Result<(), Box<dyn std::error::Error>> {
        use crate::server::dedup_handler::{DedupDecryptRequest, process_dedup_decrypt};

        let decrypt_req = match DedupDecryptRequest::from_raw_headers(headers) {
            Ok(r) => r,
            Err(e) => {
                let json = serde_json::to_string(&e)?;
                let resp = build_http_response(400, "Bad Request", &json, &[]);
                stream.write_all(&resp).await?;
                return Ok(());
            }
        };

        let content_length = headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, v)| v.parse::<usize>().ok())
            .unwrap_or(0);

        if content_length > MAX_CHUNK_SIZE {
            let err_json = format!(
                r#"{{"success":false,"error":"bad_request","message":"Content-Length {} exceeds maximum {}"}}"#,
                content_length, MAX_CHUNK_SIZE
            );
            let resp = build_http_response(400, "Bad Request", &err_json, &[]);
            stream.write_all(&resp).await?;
            return Ok(());
        }

        // Assemble the full body
        let mut encrypted_data = Vec::with_capacity(content_length);

        let initial_body_len = bytes_read.saturating_sub(body_start);
        if initial_body_len > 0 {
            let copy_len = initial_body_len.min(content_length);
            encrypted_data.extend_from_slice(&buffer[body_start..body_start + copy_len]);
        }

        if encrypted_data.len() < content_length {
            let remaining = content_length - encrypted_data.len();
            let mut remaining_data = vec![0u8; remaining];
            tokio::time::timeout(
                std::time::Duration::from_secs(300),
                stream.read_exact(&mut remaining_data),
            )
            .await
            .map_err(|_| "Body read timeout (300s exceeded)")??;
            encrypted_data.extend_from_slice(&remaining_data);
        }

        let result = tokio::task::spawn_blocking(move || {
            process_dedup_decrypt(&decrypt_req, &encrypted_data)
        })
        .await?;

        match result {
            Ok(plaintext) => {
                // Return binary plaintext with size header
                let mut response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nx-plaintext-size: {}\r\nConnection: close\r\n\r\n",
                    plaintext.len(), plaintext.len()
                ).into_bytes();
                response.extend_from_slice(&plaintext);
                stream.write_all(&response).await?;
            }
            Err(err_resp) => {
                let json = serde_json::to_string(&err_resp)?;
                let response = build_http_response(err_resp.status_code, "Error", &json, &[]);
                stream.write_all(&response).await?;
            }
        }

        Ok(())
    }

    /// Handle dedup-chunk-batch request (multiple blocks in one request)
    #[instrument(skip(buffer, headers, stream))]
    async fn handle_dedup_chunk_batch(
        buffer: &[u8],
        bytes_read: usize,
        body_start: usize,
        headers: &[(String, String)],
        compression_level: i32,
        stream: &mut UnixStream,
    ) -> Result<(), Box<dyn std::error::Error>> {
        use crate::server::dedup_handler::{BatchDedupRequest, process_dedup_chunk_batch};

        // Batch bodies can be large (10 blocks x 8MB = 80MB)
        const MAX_BATCH_BODY: usize = 128 * 1024 * 1024;

        let content_length = headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, v)| v.parse::<usize>().ok())
            .unwrap_or(0);

        if content_length > MAX_BATCH_BODY {
            let err_json = format!(
                r#"{{"success":false,"error":"bad_request","message":"Content-Length {} exceeds batch maximum {}"}}"#,
                content_length, MAX_BATCH_BODY
            );
            let resp = build_http_response(400, "Bad Request", &err_json, &[]);
            stream.write_all(&resp).await?;
            return Ok(());
        }

        // Assemble the full body
        let mut body_data = Vec::with_capacity(content_length);
        let initial_body_len = bytes_read.saturating_sub(body_start);
        if initial_body_len > 0 {
            let copy_len = initial_body_len.min(content_length);
            body_data.extend_from_slice(&buffer[body_start..body_start + copy_len]);
        }

        if body_data.len() < content_length {
            let remaining = content_length - body_data.len();
            let mut remaining_data = vec![0u8; remaining];
            tokio::time::timeout(
                std::time::Duration::from_secs(300),
                stream.read_exact(&mut remaining_data),
            )
            .await
            .map_err(|_| "Body read timeout (300s exceeded)")??;
            body_data.extend_from_slice(&remaining_data);
            debug!(read = remaining, total = body_data.len(), "Read remaining batch body");
        }

        // Split body: <json_manifest>\n<block_data>
        let split_pos = body_data.iter().position(|&b| b == b'\n');
        let (manifest_bytes, block_data) = match split_pos {
            Some(pos) => (&body_data[..pos], &body_data[pos + 1..]),
            None => {
                let err_json = r#"{"success":false,"error":"invalid_format","message":"Expected JSON manifest followed by newline and block data"}"#;
                let resp = build_http_response(400, "Bad Request", err_json, &[]);
                stream.write_all(&resp).await?;
                return Ok(());
            }
        };

        let batch_req: BatchDedupRequest = match serde_json::from_slice(manifest_bytes) {
            Ok(r) => r,
            Err(e) => {
                let err_json = format!(
                    r#"{{"success":false,"error":"invalid_json","message":"{}"}}"#,
                    e
                );
                let resp = build_http_response(400, "Bad Request", &err_json, &[]);
                stream.write_all(&resp).await?;
                return Ok(());
            }
        };

        let block_data_owned = block_data.to_vec();
        let result = tokio::task::spawn_blocking(move || {
            process_dedup_chunk_batch(&batch_req, &block_data_owned, compression_level)
        })
        .await?;

        let json = serde_json::to_string(&result)?;
        let response = build_http_response(200, "OK", &json, &[]);
        stream.write_all(&response).await?;

        Ok(())
    }

    /// Handle bulk-decrypt request: read encrypted chunks from disk, decrypt, return plaintext
    #[instrument(skip(buffer, headers, stream))]
    async fn handle_bulk_decrypt(
        buffer: &[u8],
        bytes_read: usize,
        body_start: usize,
        headers: &[(String, String)],
        stream: &mut UnixStream,
    ) -> Result<(), Box<dyn std::error::Error>> {
        // Max JSON body for the manifest (1MB should be plenty)
        const MAX_MANIFEST_SIZE: usize = 1024 * 1024;

        let content_length = headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, v)| v.parse::<usize>().ok())
            .unwrap_or(0);

        if content_length > MAX_MANIFEST_SIZE {
            let err_json = format!(
                r#"{{"success":false,"error":"bad_request","message":"Content-Length {} exceeds manifest maximum {}"}}"#,
                content_length, MAX_MANIFEST_SIZE
            );
            let resp = build_http_response(400, "Bad Request", &err_json, &[]);
            stream.write_all(&resp).await?;
            return Ok(());
        }

        // Assemble the full JSON body
        let mut body_data = Vec::with_capacity(content_length);
        let initial_body_len = bytes_read.saturating_sub(body_start);
        if initial_body_len > 0 {
            let copy_len = initial_body_len.min(content_length);
            body_data.extend_from_slice(&buffer[body_start..body_start + copy_len]);
        }

        if body_data.len() < content_length {
            let remaining = content_length - body_data.len();
            let mut remaining_data = vec![0u8; remaining];
            tokio::time::timeout(
                std::time::Duration::from_secs(300),
                stream.read_exact(&mut remaining_data),
            )
            .await
            .map_err(|_| "Body read timeout (300s exceeded)")??;
            body_data.extend_from_slice(&remaining_data);
        }

        // Parse JSON manifest
        let manifest: BulkDecryptRequest = match serde_json::from_slice(&body_data) {
            Ok(m) => m,
            Err(e) => {
                let err_json = format!(
                    r#"{{"success":false,"error":"invalid_json","message":"{}"}}"#,
                    e
                );
                let resp = build_http_response(400, "Bad Request", &err_json, &[]);
                stream.write_all(&resp).await?;
                return Ok(());
            }
        };

        // Validate file key
        let key_bytes = match base64::engine::general_purpose::STANDARD
            .decode(&manifest.file_key_b64)
        {
            Ok(b) => b,
            Err(e) => {
                let err_json = format!(
                    r#"{{"success":false,"error":"bad_request","message":"invalid base64 in file_key_b64: {}"}}"#,
                    e
                );
                let resp = build_http_response(400, "Bad Request", &err_json, &[]);
                stream.write_all(&resp).await?;
                return Ok(());
            }
        };

        if key_bytes.len() != 32 {
            let err_json =
                r#"{"success":false,"error":"bad_request","message":"file_key_b64 must decode to exactly 32 bytes"}"#;
            let resp = build_http_response(400, "Bad Request", err_json, &[]);
            stream.write_all(&resp).await?;
            return Ok(());
        }

        // Validate chunk paths
        const ALLOWED_PATH_PREFIX: &str = "/app/storage/";
        for chunk in &manifest.chunks {
            if !chunk.path.starts_with('/') || chunk.path.contains("..") {
                let err_json = format!(
                    r#"{{"success":false,"error":"bad_request","message":"invalid chunk path: {}"}}"#,
                    chunk.path
                );
                let resp = build_http_response(400, "Bad Request", &err_json, &[]);
                stream.write_all(&resp).await?;
                return Ok(());
            }
            if !chunk.path.starts_with(ALLOWED_PATH_PREFIX) {
                let err_json = format!(
                    r#"{{"success":false,"error":"bad_request","message":"path must be under '{}': {}"}}"#,
                    ALLOWED_PATH_PREFIX, chunk.path
                );
                let resp = build_http_response(400, "Bad Request", &err_json, &[]);
                stream.write_all(&resp).await?;
                return Ok(());
            }
        }

        if manifest.chunk_size == 0 {
            let err_json =
                r#"{"success":false,"error":"bad_request","message":"chunk_size must be > 0"}"#;
            let resp = build_http_response(400, "Bad Request", err_json, &[]);
            stream.write_all(&resp).await?;
            return Ok(());
        }

        let was_compressed = manifest.was_compressed;
        let chunks = manifest.chunks;

        info!(
            num_chunks = chunks.len(),
            was_compressed,
            chunk_size = manifest.chunk_size,
            "bulk-decrypt request accepted"
        );

        // Decrypt all chunks in a blocking task
        let result = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
            let processor = ChunkProcessor::default();
            let secret_key = SecretKey::from_slice(&key_bytes)
                .map_err(|e| format!("failed to create secret key: {:?}", e))?;

            let mut plaintext = Vec::new();
            for chunk_desc in &chunks {
                let file = std::fs::File::open(&chunk_desc.path).map_err(|e| {
                    format!("failed to open chunk at {}: {}", chunk_desc.path, e)
                })?;
                let mmap = unsafe { Mmap::map(&file) }.map_err(|e| {
                    format!("failed to mmap chunk at {}: {}", chunk_desc.path, e)
                })?;
                let decrypted = processor
                    .decrypt_chunk(&mmap, &secret_key, chunk_desc.index, was_compressed)
                    .map_err(|e| {
                        format!("decrypt failed for chunk {}: {}", chunk_desc.index, e)
                    })?;
                plaintext.extend_from_slice(&decrypted);
            }
            Ok(plaintext)
        })
        .await
        .map_err(|e| format!("task panicked: {}", e))?;

        match result {
            Ok(plaintext) => {
                info!(
                    plaintext_size = plaintext.len(),
                    "bulk-decrypt complete"
                );
                let mut response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nx-plaintext-size: {}\r\nConnection: close\r\n\r\n",
                    plaintext.len(), plaintext.len()
                )
                .into_bytes();
                response.extend_from_slice(&plaintext);
                stream.write_all(&response).await?;
            }
            Err(e) => {
                error!(error = %e, "bulk-decrypt failed");
                let err_json = format!(
                    r#"{{"success":false,"error":"bulk_decrypt_error","message":"{}"}}"#,
                    e
                );
                let resp = build_http_response(500, "Internal Server Error", &err_json, &[]);
                stream.write_all(&resp).await?;
            }
        }

        Ok(())
    }

    /// Handle streaming download via chunked transfer encoding.
    ///
    /// Mirrors the Hyper-based `stream_download_handler::handle_stream_download`
    /// but writes directly to the raw UDS with HTTP chunked encoding.
    #[instrument(skip(buffer, headers, stream))]
    async fn handle_stream_download(
        buffer: &[u8],
        bytes_read: usize,
        body_start: usize,
        headers: &[(String, String)],
        stream: &mut UnixStream,
    ) -> Result<(), Box<dyn std::error::Error>> {
        const MAX_MANIFEST_SIZE: usize = 1024 * 1024;
        const ALLOWED_PATH_PREFIX: &str = "/app/storage/";

        let content_length = headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, v)| v.parse::<usize>().ok())
            .unwrap_or(0);

        if content_length > MAX_MANIFEST_SIZE {
            let err_json = format!(
                r#"{{"success":false,"error":"bad_request","message":"Content-Length {} exceeds maximum {}"}}"#,
                content_length, MAX_MANIFEST_SIZE
            );
            let resp = build_http_response(400, "Bad Request", &err_json, &[]);
            stream.write_all(&resp).await?;
            return Ok(());
        }

        // Extract headers
        let file_key_b64 = match headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("x-file-key"))
            .map(|(_, v)| v.as_str())
        {
            Some(v) => v.to_string(),
            None => {
                let resp = build_http_response(
                    400,
                    "Bad Request",
                    r#"{"success":false,"error":"bad_request","message":"missing x-file-key header"}"#,
                    &[],
                );
                stream.write_all(&resp).await?;
                return Ok(());
            }
        };

        let was_compressed = headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("x-was-compressed"))
            .map(|(_, v)| v.as_str() == "true")
            .unwrap_or(false);

        // Decode key
        let key_bytes =
            match base64::engine::general_purpose::STANDARD.decode(&file_key_b64) {
                Ok(b) => b,
                Err(e) => {
                    let err_json = format!(
                        r#"{{"success":false,"error":"bad_request","message":"invalid base64 in x-file-key: {}"}}"#,
                        e
                    );
                    let resp = build_http_response(400, "Bad Request", &err_json, &[]);
                    stream.write_all(&resp).await?;
                    return Ok(());
                }
            };

        if key_bytes.len() != 32 {
            let resp = build_http_response(
                400,
                "Bad Request",
                r#"{"success":false,"error":"bad_request","message":"x-file-key must decode to exactly 32 bytes"}"#,
                &[],
            );
            stream.write_all(&resp).await?;
            return Ok(());
        }

        // Assemble body
        let mut body_data = Vec::with_capacity(content_length);
        let initial_body_len = bytes_read.saturating_sub(body_start);
        if initial_body_len > 0 {
            let copy_len = initial_body_len.min(content_length);
            body_data.extend_from_slice(&buffer[body_start..body_start + copy_len]);
        }

        if body_data.len() < content_length {
            let remaining = content_length - body_data.len();
            let mut remaining_data = vec![0u8; remaining];
            tokio::time::timeout(
                std::time::Duration::from_secs(300),
                stream.read_exact(&mut remaining_data),
            )
            .await
            .map_err(|_| "Body read timeout (300s exceeded)")??;
            body_data.extend_from_slice(&remaining_data);
        }

        // Parse JSON manifest
        let manifest: StreamDownloadRequest = match serde_json::from_slice(&body_data) {
            Ok(m) => m,
            Err(e) => {
                let err_json = format!(
                    r#"{{"success":false,"error":"invalid_json","message":"{}"}}"#,
                    e
                );
                let resp = build_http_response(400, "Bad Request", &err_json, &[]);
                stream.write_all(&resp).await?;
                return Ok(());
            }
        };

        // Validate paths
        for chunk in &manifest.chunks {
            if !chunk.path.starts_with('/') || chunk.path.contains("..") {
                let err_json = format!(
                    r#"{{"success":false,"error":"bad_request","message":"invalid chunk path: {}"}}"#,
                    chunk.path
                );
                let resp = build_http_response(400, "Bad Request", &err_json, &[]);
                stream.write_all(&resp).await?;
                return Ok(());
            }
            if !chunk.path.starts_with(ALLOWED_PATH_PREFIX) {
                let err_json = format!(
                    r#"{{"success":false,"error":"bad_request","message":"path must be under '{}': {}"}}"#,
                    ALLOWED_PATH_PREFIX, chunk.path
                );
                let resp = build_http_response(400, "Bad Request", &err_json, &[]);
                stream.write_all(&resp).await?;
                return Ok(());
            }
        }

        if manifest.chunk_size == 0 {
            let resp = build_http_response(
                400,
                "Bad Request",
                r#"{"success":false,"error":"bad_request","message":"chunk_size must be > 0"}"#,
                &[],
            );
            stream.write_all(&resp).await?;
            return Ok(());
        }

        let chunk_size = manifest.chunk_size;
        let start_byte = manifest.start_byte;
        let end_byte = manifest.end_byte;
        let total_plaintext = end_byte - start_byte + 1;

        let first_chunk_idx = start_byte / chunk_size;
        let last_chunk_idx = end_byte / chunk_size;

        // Filter and sort relevant chunks
        let mut relevant_chunks: Vec<&ChunkDescriptor> = manifest
            .chunks
            .iter()
            .filter(|c| c.index >= first_chunk_idx && c.index <= last_chunk_idx)
            .collect();
        relevant_chunks.sort_by_key(|c| c.index);

        if relevant_chunks.is_empty() {
            let resp = build_http_response(
                400,
                "Bad Request",
                r#"{"success":false,"error":"bad_request","message":"no chunks overlap the requested byte range"}"#,
                &[],
            );
            stream.write_all(&resp).await?;
            return Ok(());
        }

        info!(
            chunks = relevant_chunks.len(),
            start_byte,
            end_byte,
            chunk_size,
            was_compressed,
            "stream-download request accepted (SCM)"
        );

        // Send HTTP response header with chunked transfer encoding
        let response_header = format!(
            "HTTP/1.1 200 OK\r\n\
             Content-Type: application/octet-stream\r\n\
             Transfer-Encoding: chunked\r\n\
             x-total-plaintext-size: {}\r\n\
             x-decryption-backend: rust\r\n\
             Connection: close\r\n\
             \r\n",
            total_plaintext
        );
        stream.write_all(response_header.as_bytes()).await?;

        // Create shared processor and key
        let processor = Arc::new(ChunkProcessor::default());
        let secret_key = Arc::new(match SecretKey::from_slice(&key_bytes) {
            Ok(k) => k,
            Err(e) => {
                error!(error = ?e, "stream-download key error");
                stream.write_all(b"0\r\n\r\n").await?;
                return Ok(());
            }
        });

        let chunks_for_task: Vec<(u64, String)> = relevant_chunks
            .iter()
            .map(|c| (c.index, c.path.clone()))
            .collect();

        // Parallel decrypt with semaphore, ordered output
        let semaphore = Arc::new(Semaphore::new(4));
        let mut futures = FuturesOrdered::new();

        for (chunk_index, chunk_path) in &chunks_for_task {
            let sem = Arc::clone(&semaphore);
            let proc = Arc::clone(&processor);
            let sk = Arc::clone(&secret_key);
            let path = chunk_path.clone();
            let idx = *chunk_index;

            futures.push_back(async move {
                let _permit = sem.acquire().await.unwrap();
                let result =
                    tokio::task::spawn_blocking(move || -> Result<(u64, Vec<u8>), String> {
                        let file = std::fs::File::open(&path).map_err(|e| {
                            format!("failed to open chunk at {}: {}", path, e)
                        })?;
                        let mmap = unsafe { Mmap::map(&file) }.map_err(|e| {
                            format!("failed to mmap chunk at {}: {}", path, e)
                        })?;
                        let decrypted = proc
                            .decrypt_chunk(&mmap, &sk, idx, was_compressed)
                            .map_err(|e| {
                                format!("decrypt failed for chunk {}: {}", idx, e)
                            })?;
                        Ok((idx, decrypted))
                    })
                    .await;
                match result {
                    Ok(inner) => inner,
                    Err(e) => Err(format!("task panicked: {}", e)),
                }
            });
        }

        // Drain in order, write each chunk using HTTP chunked transfer encoding
        while let Some(result) = futures.next().await {
            let (chunk_index, plaintext) = match result {
                Ok(data) => data,
                Err(e) => {
                    error!(error = %e, "chunk processing failed during stream-download");
                    stream.write_all(b"0\r\n\r\n").await?;
                    return Ok(());
                }
            };

            // Byte-range slicing for first/last chunk
            let chunk_start_global = chunk_index * chunk_size;
            let slice_start = if chunk_index == first_chunk_idx {
                (start_byte - chunk_start_global) as usize
            } else {
                0
            };
            let slice_end = if chunk_index == last_chunk_idx {
                let chunk_end_global =
                    chunk_start_global + plaintext.len() as u64 - 1;
                let clamped_end = std::cmp::min(end_byte, chunk_end_global);
                (clamped_end - chunk_start_global + 1) as usize
            } else {
                plaintext.len()
            };

            let slice_end = std::cmp::min(slice_end, plaintext.len());
            let slice_start = std::cmp::min(slice_start, slice_end);
            let data = &plaintext[slice_start..slice_end];

            // Write HTTP chunked encoding: <hex-size>\r\n<data>\r\n
            let chunk_header = format!("{:x}\r\n", data.len());
            stream.write_all(chunk_header.as_bytes()).await?;
            stream.write_all(data).await?;
            stream.write_all(b"\r\n").await?;
        }

        // Terminate chunked encoding
        stream.write_all(b"0\r\n\r\n").await?;

        info!(total_plaintext, "stream-download complete (SCM)");

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Request types for bulk-decrypt
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct BulkDecryptRequest {
    chunks: Vec<BulkDecryptChunk>,
    file_key_b64: String,
    was_compressed: bool,
    chunk_size: u64,
}

#[derive(Debug, Deserialize)]
struct BulkDecryptChunk {
    index: u64,
    path: String,
}
