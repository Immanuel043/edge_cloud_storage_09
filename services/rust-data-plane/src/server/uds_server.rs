use crate::resilience::{CircuitBreaker, CircuitBreakerConfig, RateLimiter, RateLimiterConfig};
use crate::server::handlers::{DownloadHandler, UploadHandler};
use crate::server::request::{UploadRequest, DownloadRequest};
use crate::storage::{ChunkStorage, WriteOptions};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper::body::{Incoming, Bytes};
use http_body_util::{Full, BodyExt};
use hyper_util::rt::TokioIo;
use std::path::Path;
use std::sync::Arc;
use tokio::net::UnixListener;
use tokio::sync::broadcast;
use tracing::{debug, error, info, instrument, warn};

/// Server configuration
#[derive(Debug, Clone)]
pub struct ServerConfig {
    /// Unix socket path
    pub socket_path: String,
    /// Storage root directory
    pub storage_root: String,
    /// Compression level (1-22)
    pub compression_level: i32,
    /// Write options for storage
    pub write_options: WriteOptions,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            socket_path: "/tmp/edge-storage-dataplane.sock".to_string(),
            storage_root: "/tmp/edge-storage".to_string(),
            compression_level: 3,
            write_options: WriteOptions::default(),
        }
    }
}

/// Unix Domain Socket HTTP server
pub struct UnixSocketServer {
    config: ServerConfig,
    upload_handler: Arc<UploadHandler>,
    download_handler: Arc<DownloadHandler>,
    circuit_breaker: Arc<CircuitBreaker>,
    rate_limiter: Arc<RateLimiter>,
}

impl UnixSocketServer {
    /// Create new server
    pub fn new(config: ServerConfig) -> Result<Self, Box<dyn std::error::Error>> {
        let storage = Arc::new(
            ChunkStorage::new(&config.storage_root, config.write_options.clone())
        );

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

    /// Start server (shuts down gracefully when shutdown_rx receives)
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
        info!(socket = %self.config.socket_path, "Server listening on Unix socket");

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
                            let io = TokioIo::new(stream);

                            let service = service_fn(move |req| {
                                Self::handle_request(
                                    req,
                                    Arc::clone(&upload_handler),
                                    Arc::clone(&download_handler),
                                    Arc::clone(&circuit_breaker),
                                    Arc::clone(&rate_limiter),
                                    compression_level,
                                )
                            });

                            if let Err(e) = http1::Builder::new()
                                .serve_connection(io, service)
                                .await
                            {
                                error!(error = %e, "Connection error");
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

    /// Handle HTTP request
    async fn handle_request(
        req: Request<Incoming>,
        upload_handler: Arc<UploadHandler>,
        download_handler: Arc<DownloadHandler>,
        circuit_breaker: Arc<CircuitBreaker>,
        rate_limiter: Arc<RateLimiter>,
        compression_level: i32,
    ) -> Result<Response<Full<Bytes>>, Box<dyn std::error::Error + Send + Sync>> {
        let method = req.method().clone();
        let uri = req.uri().clone();

        debug!(method = %method, uri = %uri, "Handling request");

        // Skip rate limit and circuit breaker for health checks
        let path = uri.path();
        if path != "/health" {
            if let Err(_) = rate_limiter.allow_request() {
                return Ok(Response::builder()
                    .status(StatusCode::TOO_MANY_REQUESTS)
                    .body(Full::new(Bytes::from(r#"{"success":false,"error":"rate_limit_exceeded","message":"Too many requests"}"#)))
                    .expect("static body"));
            }
            if let Err(_) = circuit_breaker.allow_request() {
                return Ok(Response::builder()
                    .status(StatusCode::SERVICE_UNAVAILABLE)
                    .body(Full::new(Bytes::from(r#"{"success":false,"error":"circuit_breaker_open","message":"Service temporarily unavailable"}"#)))
                    .expect("static body"));
            }
        }

        let response = match (method.as_str(), path) {
            ("POST", "/upload") => {
                Self::handle_upload_endpoint(req, upload_handler, circuit_breaker).await
            }
            ("POST", "/download") => {
                Self::handle_download_endpoint(req, download_handler, circuit_breaker).await
            }
            ("POST", "/dedup-chunk") => {
                Self::handle_dedup_endpoint(req, compression_level).await
            }
            ("GET", "/health") => {
                Self::handle_health_check().await
            }
            _ => {
                warn!(method = %method, uri = %uri, "Not found");
                Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Full::new(Bytes::from("{\"error\":\"not_found\"}")))
                    .expect("invalid body type")
            }
        };

        Ok(response)
    }

    /// Handle upload endpoint
    #[instrument(skip(req, handler, circuit_breaker))]
    async fn handle_upload_endpoint(
        req: Request<Incoming>,
        handler: Arc<UploadHandler>,
        circuit_breaker: Arc<CircuitBreaker>,
    ) -> Response<Full<Bytes>> {
        // Extract request metadata from headers
        let headers = req.headers();

        let mode = headers
            .get("x-mode")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("non-zk")
            .to_string();

        let file_id = headers
            .get("x-file-id")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("unknown")
            .to_string();

        if let Err(e) = crate::server::request::validate_file_id(&file_id) {
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(Full::new(Bytes::from(
                    serde_json::json!({
                        "success": false,
                        "error": "invalid_file_id",
                        "message": e
                    })
                    .to_string(),
                )))
                .expect("invalid body type");
        }

        let chunk_index = headers
            .get("x-chunk-index")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);

        let compress = headers
            .get("x-should-compress")
            .and_then(|v| v.to_str().ok())
            .map(|s| s == "true")
            .unwrap_or(false);

        let filename = headers
            .get("x-filename")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());

        let file_size = headers
            .get("x-file-size")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok());

        // Extract target path for direct write (bypasses Rust's default storage path)
        let target_path = headers
            .get("x-target-path")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());

        // Validate target_path: must be absolute and must not contain path traversal
        if let Some(ref tp) = target_path {
            if !tp.starts_with('/') || tp.contains("..") {
                return Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .body(Full::new(Bytes::from(
                        serde_json::json!({
                            "success": false,
                            "error": "invalid_target_path",
                            "message": "target_path must be an absolute path and must not contain '..'"
                        })
                        .to_string(),
                    )))
                    .expect("invalid body type");
            }
        }

        // Extract key FD from header (in production, this would come from SCM_RIGHTS)
        // For now, we read the FD number from header as a placeholder
        let key_fd = headers
            .get("x-file-key-fd")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<i32>().ok());

        // Read chunk data from body
        let body = req.into_body();
        let chunk_data = match body.collect().await {
            Ok(collected) => collected.to_bytes(),
            Err(e) => {
                circuit_breaker.record_failure();
                error!(error = %e, "Failed to read request body");
                let msg = serde_json::json!({
                    "success": false,
                    "error": "body_read_failed",
                    "message": format!("Failed to read request body: {}", e)
                });
                return Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .body(Full::new(Bytes::from(
                        serde_json::to_string(&msg)
                            .unwrap_or_else(|_| r#"{"success":false,"error":"body_read_failed"}"#.to_string())
                    )))
                    .expect("invalid body type");
            }
        };

        // Create upload request
        let upload_req = UploadRequest {
            mode,
            file_id,
            chunk_index,
            compress,
            filename,
            file_size,
            target_path,
        };

        // Call handler
        match handler.handle_upload(upload_req, chunk_data, key_fd).await {
            Ok(response) => {
                circuit_breaker.record_success();
                debug!(
                    success = response.success,
                    hash = %response.hash,
                    "Upload successful"
                );

                let json = serde_json::to_string(&response)
                    .unwrap_or_else(|_| r#"{"success":false,"error":"serialization_error"}"#.to_string());
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "application/json")
                    .body(Full::new(Bytes::from(json)))
                    .expect("invalid body type")
            }
            Err(err) => {
                circuit_breaker.record_failure();
                error!(
                    error = %err.error,
                    message = %err.message,
                    "Upload failed"
                );

                let status_code = StatusCode::from_u16(err.status_code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
                let json = serde_json::to_string(&err)
                    .unwrap_or_else(|_| r#"{"success":false,"error":"serialization_error"}"#.to_string());

                Response::builder()
                    .status(status_code)
                    .header("content-type", "application/json")
                    .body(Full::new(Bytes::from(json)))
                    .expect("invalid body type")
            }
        }
    }

    /// Handle download endpoint
    #[instrument(skip(req, handler, circuit_breaker))]
    async fn handle_download_endpoint(
        req: Request<Incoming>,
        handler: Arc<DownloadHandler>,
        circuit_breaker: Arc<CircuitBreaker>,
    ) -> Response<Full<Bytes>> {
        // Extract request metadata from headers
        let headers = req.headers();

        let mode = headers
            .get("x-mode")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("non-zk")
            .to_string();

        let file_id = headers
            .get("x-file-id")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("unknown")
            .to_string();

        if let Err(e) = crate::server::request::validate_file_id(&file_id) {
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(Full::new(Bytes::from(
                    serde_json::json!({
                        "success": false,
                        "error": "invalid_file_id",
                        "message": e
                    })
                    .to_string(),
                )))
                .expect("invalid body type");
        }

        let chunk_index = headers
            .get("x-chunk-index")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);

        // Extract key FD from header (in production, this would come from SCM_RIGHTS)
        let key_fd = headers
            .get("x-file-key-fd")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<i32>().ok());

        let was_compressed = headers
            .get("x-was-compressed")
            .and_then(|v| v.to_str().ok())
            .map(|s| s == "true")
            .unwrap_or(false);

        // Create download request
        let download_req = DownloadRequest {
            mode,
            file_id,
            chunk_index,
            was_compressed,
        };

        // Call handler
        match handler.handle_download(download_req, key_fd).await {
            Ok(chunk_data) => {
                circuit_breaker.record_success();
                debug!(
                    chunk_index = chunk_index,
                    size = chunk_data.len(),
                    "Download successful"
                );

                // Convert Vec<u8> to Bytes
                let bytes_data = Bytes::from(chunk_data);

                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "application/octet-stream")
                    .body(Full::new(bytes_data))
                    .expect("invalid body type")
            }
            Err(err) => {
                circuit_breaker.record_failure();
                error!(
                    error = %err.error,
                    message = %err.message,
                    "Download failed"
                );

                let status_code = StatusCode::from_u16(err.status_code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
                let json = serde_json::to_string(&err)
                    .unwrap_or_else(|_| r#"{"success":false,"error":"serialization_error"}"#.to_string());

                Response::builder()
                    .status(status_code)
                    .header("content-type", "application/json")
                    .body(Full::new(Bytes::from(json)))
                    .expect("invalid body type")
            }
        }
    }

    /// Handle dedup-chunk endpoint (convergent encryption + CAS write)
    #[instrument(skip(req))]
    async fn handle_dedup_endpoint(
        req: Request<Incoming>,
        compression_level: i32,
    ) -> Response<Full<Bytes>> {
        use crate::server::dedup_handler::{DedupChunkRequest, process_dedup_chunk};

        let headers = req.headers().clone();
        let dedup_req = match DedupChunkRequest::from_headers(&headers) {
            Ok(r) => r,
            Err(e) => {
                let json = serde_json::to_string(&e).unwrap_or_default();
                return Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .header("content-type", "application/json")
                    .body(Full::new(Bytes::from(json)))
                    .expect("invalid body type");
            }
        };

        let body_bytes = match req.collect().await.map(|b| b.to_bytes()) {
            Ok(b) => b,
            Err(e) => {
                let json = format!(
                    r#"{{"success":false,"error":"body_read_failed","message":"{}"}}"#,
                    e
                );
                return Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .header("content-type", "application/json")
                    .body(Full::new(Bytes::from(json)))
                    .expect("invalid body type");
            }
        };

        // CPU-heavy work: PBKDF2 + compress + encrypt + write -- offload
        let result = tokio::task::spawn_blocking(move || {
            process_dedup_chunk(&dedup_req, &body_bytes, compression_level)
        })
        .await;

        match result {
            Ok(Ok(resp)) => {
                let json = serde_json::to_string(&resp).unwrap_or_default();
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "application/json")
                    .body(Full::new(Bytes::from(json)))
                    .expect("invalid body type")
            }
            Ok(Err(e)) => {
                let json = serde_json::to_string(&e).unwrap_or_default();
                let status = StatusCode::from_u16(e.status_code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
                Response::builder()
                    .status(status)
                    .header("content-type", "application/json")
                    .body(Full::new(Bytes::from(json)))
                    .expect("invalid body type")
            }
            Err(e) => {
                let json = format!(
                    r#"{{"success":false,"error":"internal_error","message":"Task panicked: {}"}}"#,
                    e
                );
                Response::builder()
                    .status(StatusCode::INTERNAL_SERVER_ERROR)
                    .header("content-type", "application/json")
                    .body(Full::new(Bytes::from(json)))
                    .expect("invalid body type")
            }
        }
    }

    /// Handle health check endpoint
    async fn handle_health_check() -> Response<Full<Bytes>> {
        Response::builder()
            .status(StatusCode::OK)
            .body(Full::new(Bytes::from("{\"status\":\"healthy\"}")))
            .expect("invalid body type")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_server_config_default() {
        let config = ServerConfig::default();
        assert_eq!(config.socket_path, "/tmp/edge-storage-dataplane.sock");
        assert_eq!(config.compression_level, 3);
    }

    #[test]
    fn test_server_creation() {
        let config = ServerConfig::default();
        let server = UnixSocketServer::new(config);
        assert!(server.is_ok());
    }
}
