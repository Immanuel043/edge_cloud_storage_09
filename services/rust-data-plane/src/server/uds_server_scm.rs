//! Unix Domain Socket Server with SCM_RIGHTS support
//!
//! This is an alternative UDS server implementation that supports receiving file descriptors
//! via SCM_RIGHTS ancillary data for secure key passing in Non-ZK mode.
//!
//! Unlike the Hyper-based server, this uses custom HTTP parsing to access the raw socket
//! for recvmsg() with ancillary data.

use crate::resilience::{CircuitBreaker, CircuitBreakerConfig, RateLimiter, RateLimiterConfig};
use crate::server::fd_guard;
use crate::server::handlers::{DownloadHandler, UploadHandler};
use crate::server::request::{DownloadRequest, UploadRequest};
use crate::server::scm_rights::{
    build_http_response, parse_http_request, recv_with_scm_rights,
};
use crate::server::ServerConfig;
use crate::storage::ChunkStorage;
use bytes::Bytes;
use scopeguard;
use std::os::unix::io::{AsRawFd, RawFd};
use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::broadcast;
use tokio::sync::Mutex;
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
        let storage = Arc::new(Mutex::new(ChunkStorage::new(
            &config.storage_root,
            config.write_options.clone(),
        )));

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

                        // Spawn connection handler
                        tokio::spawn(async move {
                            if let Err(e) = Self::handle_connection(
                                stream,
                                upload_handler,
                                download_handler,
                                circuit_breaker,
                                rate_limiter,
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
    ) -> Result<(), Box<dyn std::error::Error>> {
        let fd = stream.as_raw_fd();

        // Buffers for receiving data
        let buffer = vec![0u8; 64 * 1024]; // Initial receive buffer (64KB)
        let ancillary_buffer = vec![0u8; 256]; // For SCM_RIGHTS control messages

        // Receive initial data + potential FD via SCM_RIGHTS
        // Use spawn_blocking and return the data with the result
        let (bytes_read, received_fd, buffer) = tokio::task::spawn_blocking(move || {
            let mut buf = buffer;
            let mut anc_buf = ancillary_buffer;
            match recv_with_scm_rights(fd, &mut buf, &mut anc_buf) {
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
}
