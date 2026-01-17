use serde::{Deserialize, Serialize};

/// Successful chunk response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkResponse {
    /// Success status
    pub success: bool,
    /// Content hash (sha256)
    pub hash: String,
    /// Original size (bytes)
    pub original_size: usize,
    /// Encrypted size (bytes)
    pub encrypted_size: usize,
    /// Whether compressed
    pub compressed: bool,
    /// Compression ratio (if compressed)
    pub compression_ratio: Option<f64>,
    /// Path to encrypted chunk file (for Non-ZK mode)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encrypted_chunk_path: Option<String>,
}

/// Error response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorResponse {
    /// Success status (always false)
    pub success: bool,
    /// Error code
    pub error: String,
    /// Error message
    pub message: String,
    /// HTTP status code
    pub status_code: u16,
}

impl ErrorResponse {
    pub fn new(error: String, message: String, status_code: u16) -> Self {
        Self {
            success: false,
            error,
            message,
            status_code,
        }
    }

    pub fn bad_request(message: String) -> Self {
        Self::new("bad_request".to_string(), message, 400)
    }

    pub fn internal_error(message: String) -> Self {
        Self::new("internal_error".to_string(), message, 500)
    }

    pub fn security_violation(message: String) -> Self {
        Self::new("security_violation".to_string(), message, 403)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chunk_response_serialization() {
        let response = ChunkResponse {
            success: true,
            hash: "sha256:abc123".to_string(),
            original_size: 1024,
            encrypted_size: 1080,
            compressed: false,
            compression_ratio: None,
            encrypted_chunk_path: None,
        };

        let json = serde_json::to_string(&response).unwrap();
        let deserialized: ChunkResponse = serde_json::from_str(&json).unwrap();

        assert!(deserialized.success);
        assert_eq!(deserialized.hash, "sha256:abc123");
    }

    #[test]
    fn test_error_response_bad_request() {
        let error = ErrorResponse::bad_request("Invalid mode".to_string());

        assert!(!error.success);
        assert_eq!(error.error, "bad_request");
        assert_eq!(error.status_code, 400);
    }

    #[test]
    fn test_error_response_internal_error() {
        let error = ErrorResponse::internal_error("Database error".to_string());

        assert_eq!(error.error, "internal_error");
        assert_eq!(error.status_code, 500);
    }

    #[test]
    fn test_error_response_security_violation() {
        let error = ErrorResponse::security_violation("ZK mode key leakage".to_string());

        assert_eq!(error.error, "security_violation");
        assert_eq!(error.status_code, 403);
    }
}
