//! Handler for POST /dedup-chunk -- convergent encryption for dedup blocks.
//!
//! Receives a single block, verifies its hash, performs PBKDF2 key derivation,
//! optional Zstd compression, AES-256-GCM convergent encryption, and atomic
//! CAS write.  No SCM_RIGHTS / key FD needed (key is content-derived).

use crate::compression::ZstdCompressor;
use crate::crypto::convergent;
use crate::server::response::ErrorResponse;
use crate::storage::atomic_writer::{AtomicWriter, WriteOptions};
use ring::digest::{digest, SHA256};
use serde::Serialize;
use std::path::Path;
use tracing::{debug, error, info, instrument};

/// Response for a successful /dedup-chunk request.
#[derive(Debug, Serialize)]
pub struct DedupChunkResponse {
    pub success: bool,
    pub encrypted_size: usize,
    pub was_compressed: bool,
    pub compression_ratio: Option<f64>,
}

/// Parsed headers for a dedup-chunk request.
#[derive(Debug)]
pub struct DedupChunkRequest {
    pub block_hash: String,
    pub user_id: String,
    pub cas_path: String,
    pub should_compress: bool,
}

impl DedupChunkRequest {
    /// Parse from HTTP header map (hyper).  Returns Err(ErrorResponse) on missing headers.
    pub fn from_headers(headers: &hyper::HeaderMap) -> Result<Self, ErrorResponse> {
        let block_hash = get_header(headers, "x-block-hash")?;
        let user_id = get_header(headers, "x-user-id")?;
        let cas_path = get_header(headers, "x-cas-path")?;
        let should_compress = headers
            .get("x-should-compress")
            .and_then(|v| v.to_str().ok())
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);

        Ok(Self {
            block_hash,
            user_id,
            cas_path,
            should_compress,
        })
    }

    /// Parse from raw header lines (SCM server). Returns Err(ErrorResponse) on missing headers.
    pub fn from_raw_headers(headers: &[(String, String)]) -> Result<Self, ErrorResponse> {
        let find = |name: &str| -> Result<String, ErrorResponse> {
            headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.clone())
                .ok_or_else(|| ErrorResponse::bad_request(format!("Missing header: {}", name)))
        };

        let block_hash = find("x-block-hash")?;
        let user_id = find("x-user-id")?;
        let cas_path = find("x-cas-path")?;
        let should_compress = headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("x-should-compress"))
            .map(|(_, v)| v == "true" || v == "1")
            .unwrap_or(false);

        Ok(Self {
            block_hash,
            user_id,
            cas_path,
            should_compress,
        })
    }
}

/// Core processing logic (shared between both server variants).
#[instrument(skip(block_data), fields(hash = %req.block_hash, cas = %req.cas_path, size = block_data.len()))]
pub fn process_dedup_chunk(
    req: &DedupChunkRequest,
    block_data: &[u8],
    compression_level: i32,
) -> Result<DedupChunkResponse, ErrorResponse> {
    // 1. Verify hash
    let computed = digest(&SHA256, block_data);
    let computed_hex: String = computed.as_ref().iter().map(|b| format!("{:02x}", b)).collect();

    if computed_hex != req.block_hash {
        error!(
            expected = %req.block_hash,
            computed = %computed_hex,
            "Block hash mismatch"
        );
        return Err(ErrorResponse::bad_request("Block hash mismatch".into()));
    }

    // 2. Optional compression
    let (data_to_encrypt, was_compressed, compression_ratio) = if req.should_compress {
        let compressor = ZstdCompressor::new(compression_level)
            .map_err(|e| ErrorResponse::internal_error(format!("Compressor init: {}", e)))?;
        match compressor.compress(block_data) {
            Ok(compressed) => {
                let ratio = block_data.len() as f64 / compressed.len() as f64;
                if compressed.len() < block_data.len() {
                    debug!(
                        original = block_data.len(),
                        compressed = compressed.len(),
                        ratio = ratio,
                        "Compression effective"
                    );
                    (compressed, true, Some(ratio))
                } else {
                    debug!("Compression not effective, using original");
                    (block_data.to_vec(), false, None)
                }
            }
            Err(e) => {
                debug!(error = %e, "Compression failed, using original");
                (block_data.to_vec(), false, None)
            }
        }
    } else {
        (block_data.to_vec(), false, None)
    };

    // 3. Convergent encryption
    let encrypted = convergent::convergent_encrypt(&data_to_encrypt, &req.block_hash, &req.user_id)
        .map_err(|e| ErrorResponse::internal_error(format!("Convergent encrypt: {}", e)))?;

    let encrypted_size = encrypted.len();

    // 4. Atomic write to CAS path
    let mut writer = AtomicWriter::new(WriteOptions::default());
    writer.write_atomic(Path::new(&req.cas_path), &encrypted).map_err(|e| {
        error!(error = %e, path = %req.cas_path, "Atomic CAS write failed");
        ErrorResponse::internal_error(format!("CAS write: {}", e))
    })?;

    info!(
        encrypted_size = encrypted_size,
        was_compressed = was_compressed,
        "Dedup chunk processed"
    );

    Ok(DedupChunkResponse {
        success: true,
        encrypted_size,
        was_compressed,
        compression_ratio,
    })
}

fn get_header(headers: &hyper::HeaderMap, name: &str) -> Result<String, ErrorResponse> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .ok_or_else(|| ErrorResponse::bad_request(format!("Missing header: {}", name)))
}
