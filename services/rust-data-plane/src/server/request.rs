use serde::{Deserialize, Serialize};

/// Validate file_id to prevent path traversal (reject `..`, `/`, `\`, etc.)
pub fn validate_file_id(file_id: &str) -> Result<(), String> {
    if file_id.is_empty() {
        return Err("file_id cannot be empty".to_string());
    }
    if !file_id
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return Err("file_id contains invalid characters (allowed: alphanumeric, -, _)".to_string());
    }
    Ok(())
}

/// Upload request from FastAPI
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadRequest {
    /// Processing mode: "zk" or "non-zk"
    pub mode: String,
    /// File ID (for storage path)
    pub file_id: String,
    /// Chunk index
    pub chunk_index: u64,
    /// Whether to compress (for non-zk mode)
    pub compress: bool,
    /// Original filename (for format detection)
    pub filename: Option<String>,
    /// File size (for format detection)
    pub file_size: Option<u64>,
}

/// Download request from FastAPI
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadRequest {
    /// Processing mode: "zk" or "non-zk"
    pub mode: String,
    /// File ID
    pub file_id: String,
    /// Chunk index
    pub chunk_index: u64,
    /// Whether chunk was compressed (for non-zk mode)
    pub was_compressed: bool,
}

/// Generic chunk request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkRequest {
    pub mode: String,
    pub file_id: String,
    pub chunk_index: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_file_id() {
        assert!(validate_file_id("file-123").is_ok());
        assert!(validate_file_id("abc_XYZ-09").is_ok());
        assert!(validate_file_id("a").is_ok());
        assert!(validate_file_id("").is_err());
        assert!(validate_file_id("file/bar").is_err());
        assert!(validate_file_id("..").is_err());
        assert!(validate_file_id("path\\to").is_err());
        assert!(validate_file_id("file name").is_err());
    }

    #[test]
    fn test_upload_request_serialization() {
        let request = UploadRequest {
            mode: "non-zk".to_string(),
            file_id: "file-123".to_string(),
            chunk_index: 0,
            compress: true,
            filename: Some("test.txt".to_string()),
            file_size: Some(1024 * 1024),
        };

        let json = serde_json::to_string(&request).unwrap();
        let deserialized: UploadRequest = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.mode, "non-zk");
        assert_eq!(deserialized.file_id, "file-123");
        assert_eq!(deserialized.chunk_index, 0);
        assert!(deserialized.compress);
    }

    #[test]
    fn test_download_request_serialization() {
        let request = DownloadRequest {
            mode: "zk".to_string(),
            file_id: "file-456".to_string(),
            chunk_index: 5,
            was_compressed: false,
        };

        let json = serde_json::to_string(&request).unwrap();
        let deserialized: DownloadRequest = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.mode, "zk");
        assert_eq!(deserialized.chunk_index, 5);
        assert!(!deserialized.was_compressed);
    }
}
