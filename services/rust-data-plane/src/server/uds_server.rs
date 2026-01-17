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
use tokio::sync::Mutex;
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
}

impl UnixSocketServer {
    /// Create new server
    pub fn new(config: ServerConfig) -> Result<Self, Box<dyn std::error::Error>> {
        let storage = Arc::new(Mutex::new(
            ChunkStorage::new(&config.storage_root, config.write_options.clone())
        ));

        let upload_handler = Arc::new(
            UploadHandler::new(Arc::clone(&storage), config.compression_level)?
        );

        let download_handler = Arc::new(
            DownloadHandler::new(Arc::clone(&storage), config.compression_level)?
        );

        Ok(Self {
            config,
            upload_handler,
            download_handler,
        })
    }

    /// Start server
    #[instrument(skip(self))]
    pub async fn serve(&self) -> Result<(), Box<dyn std::error::Error>> {
        // Remove existing socket if present
        let socket_path = Path::new(&self.config.socket_path);
        if socket_path.exists() {
            std::fs::remove_file(socket_path)?;
            debug!(socket = %self.config.socket_path, "Removed existing socket");
        }

        // Bind to Unix socket
        let listener = UnixListener::bind(&self.config.socket_path)?;
        info!(socket = %self.config.socket_path, "Server listening on Unix socket");

        // Accept connections
        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    debug!("Accepted connection");

                    let upload_handler = Arc::clone(&self.upload_handler);
                    let download_handler = Arc::clone(&self.download_handler);

                    // Spawn connection handler
                    tokio::spawn(async move {
                        let io = TokioIo::new(stream);

                        let service = service_fn(move |req| {
                            Self::handle_request(
                                req,
                                Arc::clone(&upload_handler),
                                Arc::clone(&download_handler),
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

    /// Handle HTTP request
    async fn handle_request(
        req: Request<Incoming>,
        upload_handler: Arc<UploadHandler>,
        download_handler: Arc<DownloadHandler>,
    ) -> Result<Response<Full<Bytes>>, Box<dyn std::error::Error + Send + Sync>> {
        let method = req.method().clone();
        let uri = req.uri().clone();

        debug!(method = %method, uri = %uri, "Handling request");

        let response = match (method.as_str(), uri.path()) {
            ("POST", "/upload") => {
                Self::handle_upload_endpoint(req, upload_handler).await
            }
            ("POST", "/download") => {
                Self::handle_download_endpoint(req, download_handler).await
            }
            ("GET", "/health") => {
                Self::handle_health_check().await
            }
            _ => {
                warn!(method = %method, uri = %uri, "Not found");
                Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Full::new(Bytes::from("{\"error\":\"not_found\"}")))
                    .unwrap()
            }
        };

        Ok(response)
    }

    /// Handle upload endpoint
    #[instrument(skip(req, handler))]
    async fn handle_upload_endpoint(
        req: Request<Incoming>,
        handler: Arc<UploadHandler>,
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
                error!(error = %e, "Failed to read request body");
                return Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .body(Full::new(Bytes::from(
                        serde_json::json!({
                            "success": false,
                            "error": "body_read_failed",
                            "message": format!("Failed to read request body: {}", e)
                        }).to_string()
                    )))
                    .unwrap();
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
        };

        // Call handler
        match handler.handle_upload(upload_req, chunk_data, key_fd).await {
            Ok(response) => {
                debug!(
                    success = response.success,
                    hash = %response.hash,
                    "Upload successful"
                );

                let json = serde_json::to_string(&response).unwrap();
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "application/json")
                    .body(Full::new(Bytes::from(json)))
                    .unwrap()
            }
            Err(err) => {
                error!(
                    error = %err.error,
                    message = %err.message,
                    "Upload failed"
                );

                let status_code = StatusCode::from_u16(err.status_code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
                let json = serde_json::to_string(&err).unwrap();

                Response::builder()
                    .status(status_code)
                    .header("content-type", "application/json")
                    .body(Full::new(Bytes::from(json)))
                    .unwrap()
            }
        }
    }

    /// Handle download endpoint
    #[instrument(skip(req, handler))]
    async fn handle_download_endpoint(
        req: Request<Incoming>,
        handler: Arc<DownloadHandler>,
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
                    .unwrap()
            }
            Err(err) => {
                error!(
                    error = %err.error,
                    message = %err.message,
                    "Download failed"
                );

                let status_code = StatusCode::from_u16(err.status_code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
                let json = serde_json::to_string(&err).unwrap();

                Response::builder()
                    .status(status_code)
                    .header("content-type", "application/json")
                    .body(Full::new(Bytes::from(json)))
                    .unwrap()
            }
        }
    }

    /// Handle health check endpoint
    async fn handle_health_check() -> Response<Full<Bytes>> {
        Response::builder()
            .status(StatusCode::OK)
            .body(Full::new(Bytes::from("{\"status\":\"healthy\"}")))
            .unwrap()
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
