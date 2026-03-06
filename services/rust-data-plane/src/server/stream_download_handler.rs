//! Streaming download handler for chunked file decryption.
//!
//! Accepts a JSON manifest of encrypted chunk paths + a base64 file key,
//! decrypts each chunk through the existing `ChunkProcessor` pipeline,
//! and streams plaintext back via a bounded channel for backpressure.

use crate::crypto::SecretKey;
use crate::processing::ChunkProcessor;
use crate::server::uds_server::{BoxBody, full_body};

use base64::Engine as _;
use bytes::Bytes;
use http_body_util::{BodyExt, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::{Request, Response, StatusCode};
use serde::Deserialize;
use tokio::sync::mpsc;
use tracing::{debug, error, info, instrument, warn};

/// Allowed path prefix for chunk files.
const ALLOWED_PATH_PREFIX: &str = "/app/storage/";

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct StreamDownloadRequest {
    pub chunks: Vec<ChunkDescriptor>,
    pub start_byte: u64,
    pub end_byte: u64,
    pub chunk_size: u64,
}

#[derive(Debug, Deserialize)]
pub struct ChunkDescriptor {
    pub index: u64,
    pub path: String,
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

fn validate_chunk_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') {
        return Err(format!("path must be absolute: {}", path));
    }
    if path.contains("..") {
        return Err(format!("path must not contain '..': {}", path));
    }
    if !path.starts_with(ALLOWED_PATH_PREFIX) {
        return Err(format!(
            "path must be under '{}': {}",
            ALLOWED_PATH_PREFIX, path
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

#[instrument(skip(req))]
pub async fn handle_stream_download(req: Request<Incoming>) -> Response<BoxBody> {
    // -- Extract headers ------------------------------------------------
    let headers = req.headers();

    let file_key_b64 = match headers.get("x-file-key").and_then(|v| v.to_str().ok()) {
        Some(v) => v.to_string(),
        None => {
            return error_response(StatusCode::BAD_REQUEST, "missing x-file-key header");
        }
    };

    let was_compressed = headers
        .get("x-was-compressed")
        .and_then(|v| v.to_str().ok())
        .map(|s| s == "true")
        .unwrap_or(false);

    // -- Decode key -----------------------------------------------------
    let key_bytes = match base64::engine::general_purpose::STANDARD.decode(&file_key_b64) {
        Ok(b) => b,
        Err(e) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                &format!("invalid base64 in x-file-key: {}", e),
            );
        }
    };

    // Validate key size early (the actual SecretKey is created per-chunk in spawn_blocking)
    if key_bytes.len() != 32 {
        return error_response(
            StatusCode::BAD_REQUEST,
            "x-file-key must decode to exactly 32 bytes",
        );
    }

    // -- Parse JSON body ------------------------------------------------
    let body_bytes = match req.collect().await.map(|b| b.to_bytes()) {
        Ok(b) => b,
        Err(e) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                &format!("failed to read request body: {}", e),
            );
        }
    };

    let manifest: StreamDownloadRequest = match serde_json::from_slice(&body_bytes) {
        Ok(m) => m,
        Err(e) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                &format!("invalid JSON body: {}", e),
            );
        }
    };

    // -- Validate paths -------------------------------------------------
    for chunk in &manifest.chunks {
        if let Err(e) = validate_chunk_path(&chunk.path) {
            return error_response(StatusCode::BAD_REQUEST, &e);
        }
    }

    if manifest.chunk_size == 0 {
        return error_response(StatusCode::BAD_REQUEST, "chunk_size must be > 0");
    }

    let total_plaintext = manifest.end_byte - manifest.start_byte + 1;

    info!(
        chunks = manifest.chunks.len(),
        start_byte = manifest.start_byte,
        end_byte = manifest.end_byte,
        chunk_size = manifest.chunk_size,
        was_compressed = was_compressed,
        "stream-download request accepted"
    );

    // -- Determine which chunks overlap [start_byte, end_byte] ----------
    let chunk_size = manifest.chunk_size;
    let start_byte = manifest.start_byte;
    let end_byte = manifest.end_byte;

    let first_chunk_idx = start_byte / chunk_size;
    let last_chunk_idx = end_byte / chunk_size;

    // Filter manifest.chunks to only those in range, sorted by index
    let mut relevant_chunks: Vec<&ChunkDescriptor> = manifest
        .chunks
        .iter()
        .filter(|c| c.index >= first_chunk_idx && c.index <= last_chunk_idx)
        .collect();
    relevant_chunks.sort_by_key(|c| c.index);

    if relevant_chunks.is_empty() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "no chunks overlap the requested byte range",
        );
    }

    // -- Set up streaming channel (backpressure: 2 chunks buffered) -----
    let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, Box<dyn std::error::Error + Send + Sync>>>(2);

    // Clone data needed by spawned task
    let chunks_for_task: Vec<(u64, String)> = relevant_chunks
        .iter()
        .map(|c| (c.index, c.path.clone()))
        .collect();

    // -- Spawn decryption pipeline --------------------------------------
    tokio::spawn(async move {
        for (chunk_index, chunk_path) in &chunks_for_task {
            let chunk_index = *chunk_index;
            let chunk_path = chunk_path.clone();
            let key_clone = key_bytes.clone();

            // Read + decrypt in spawn_blocking (CPU-heavy)
            let decrypt_result = {
                let path = chunk_path.clone();
                tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
                    // Read encrypted bytes from disk
                    let encrypted = std::fs::read(&path).map_err(|e| {
                        format!("failed to read chunk at {}: {}", path, e)
                    })?;

                    // Decrypt (+ optional decompress)
                    let processor = ChunkProcessor::default();
                    let key = SecretKey::from_slice(&key_clone).map_err(|e| {
                        format!("key error: {:?}", e)
                    })?;
                    processor
                        .decrypt_chunk(&encrypted, &key, chunk_index, was_compressed)
                        .map_err(|e| format!("decrypt failed for chunk {}: {}", chunk_index, e))
                })
                .await
            };

            let plaintext = match decrypt_result {
                Ok(Ok(data)) => data,
                Ok(Err(e)) => {
                    error!(error = %e, chunk_index, "chunk decryption failed");
                    let _ = tx
                        .send(Err(Box::new(std::io::Error::new(
                            std::io::ErrorKind::Other,
                            e,
                        )) as Box<dyn std::error::Error + Send + Sync>))
                        .await;
                    return;
                }
                Err(e) => {
                    error!(error = %e, chunk_index, "spawn_blocking panicked");
                    let _ = tx
                        .send(Err(Box::new(std::io::Error::new(
                            std::io::ErrorKind::Other,
                            format!("task panicked: {}", e),
                        )) as Box<dyn std::error::Error + Send + Sync>))
                        .await;
                    return;
                }
            };

            // Slice for range boundaries on first/last chunk
            let chunk_start_global = chunk_index * chunk_size;
            let slice_start = if chunk_index == first_chunk_idx {
                (start_byte - chunk_start_global) as usize
            } else {
                0
            };
            let slice_end = if chunk_index == last_chunk_idx {
                let chunk_end_global = chunk_start_global + plaintext.len() as u64 - 1;
                let clamped_end = std::cmp::min(end_byte, chunk_end_global);
                (clamped_end - chunk_start_global + 1) as usize
            } else {
                plaintext.len()
            };

            let slice_end = std::cmp::min(slice_end, plaintext.len());
            let slice_start = std::cmp::min(slice_start, slice_end);

            let bytes = Bytes::copy_from_slice(&plaintext[slice_start..slice_end]);

            debug!(
                chunk_index,
                slice_start,
                slice_end,
                bytes_len = bytes.len(),
                "sending chunk data"
            );

            if tx.send(Ok(Frame::data(bytes))).await.is_err() {
                warn!("receiver dropped, aborting stream");
                return;
            }
        }

        debug!("stream-download pipeline complete");
    });

    // -- Build streaming response ---------------------------------------
    let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
    let body = StreamBody::new(stream);
    let boxed: BoxBody = BodyExt::boxed(body);

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/octet-stream")
        .header("x-total-plaintext-size", total_plaintext.to_string())
        .header("x-decryption-backend", "rust")
        .body(boxed)
        .expect("valid response")
}

/// Build a JSON error response.
fn error_response(status: StatusCode, message: &str) -> Response<BoxBody> {
    let json = serde_json::json!({
        "success": false,
        "error": "stream_download_error",
        "message": message,
    });
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(full_body(Bytes::from(json.to_string())))
        .expect("valid error response")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_stream_download_request() {
        let json = r#"{
            "chunks": [
                {"index": 0, "path": "/app/storage/cache/ab/abc_chunk_0.enc"},
                {"index": 1, "path": "/app/storage/cache/ab/abc_chunk_1.enc"}
            ],
            "start_byte": 0,
            "end_byte": 67108863,
            "chunk_size": 33554432
        }"#;

        let req: StreamDownloadRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.chunks.len(), 2);
        assert_eq!(req.chunks[0].index, 0);
        assert_eq!(req.chunks[1].path, "/app/storage/cache/ab/abc_chunk_1.enc");
        assert_eq!(req.start_byte, 0);
        assert_eq!(req.end_byte, 67108863);
        assert_eq!(req.chunk_size, 33554432);
    }

    #[test]
    fn test_path_validation_valid() {
        assert!(validate_chunk_path("/app/storage/cache/ab/abc_chunk_0.enc").is_ok());
        assert!(validate_chunk_path("/app/storage/data/test.enc").is_ok());
    }

    #[test]
    fn test_path_validation_rejects_relative() {
        assert!(validate_chunk_path("relative/path.enc").is_err());
    }

    #[test]
    fn test_path_validation_rejects_traversal() {
        assert!(validate_chunk_path("/app/storage/../etc/passwd").is_err());
    }

    #[test]
    fn test_path_validation_rejects_wrong_prefix() {
        assert!(validate_chunk_path("/etc/passwd").is_err());
        assert!(validate_chunk_path("/tmp/data.enc").is_err());
    }
}
