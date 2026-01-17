use std::path::Path;

/// File category for compression decisions
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileCategory {
    /// Already compressed formats (don't compress)
    Compressed,
    /// Compressible text/data formats
    Compressible,
    /// Unknown or uncategorized
    Unknown,
}

/// Extensions for already-compressed formats (should NOT be compressed)
const COMPRESSED_EXTENSIONS: &[&str] = &[
    // Archives
    ".zip", ".gz", ".bz2", ".xz", ".7z", ".rar", ".tar.gz", ".tgz",
    // Images
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".avif",
    // Video
    ".mp4", ".mkv", ".avi", ".mov", ".webm", ".flv", ".m4v", ".3gp",
    // Audio
    ".mp3", ".aac", ".m4a", ".ogg", ".opus", ".flac", ".wma",
    // Documents
    ".pdf", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp",
    // Other
    ".apk", ".dmg", ".iso", ".deb", ".rpm",
];

/// Extensions for compressible formats (text-based or uncompressed)
const COMPRESSIBLE_EXTENSIONS: &[&str] = &[
    // Text
    ".txt", ".log", ".md", ".markdown", ".csv", ".tsv",
    // Source code
    ".rs", ".py", ".js", ".ts", ".jsx", ".tsx", ".go", ".java", ".cpp", ".c", ".h",
    ".cs", ".php", ".rb", ".swift", ".kt", ".scala", ".sh", ".bash",
    // Config
    ".json", ".yaml", ".yml", ".toml", ".xml", ".html", ".css", ".scss", ".sass",
    ".ini", ".conf", ".config", ".env",
    // Data
    ".sql", ".graphql", ".proto", ".thrift",
    // Uncompressed archives
    ".tar", ".cpio",
    // Uncompressed images (rare but exist)
    ".bmp", ".tiff", ".tif", ".svg",
    // Other
    ".pem", ".key", ".crt", ".csr",
];

/// Determine if a file should be compressed based on filename and size
///
/// # Arguments
/// * `filename` - Name of the file (with extension)
/// * `size` - Size of the file in bytes
///
/// # Returns
/// true if file should be compressed, false otherwise
///
/// # Logic
/// - Already compressed formats: Never compress
/// - Compressible formats AND size > 1MB: Compress
/// - Unknown formats AND size > 1MB: Compress (conservative)
/// - Small files (< 1MB): Don't compress (overhead not worth it)
pub fn should_compress(filename: &str, size: u64) -> bool {
    const MIN_SIZE_FOR_COMPRESSION: u64 = 1024 * 1024; // 1MB

    // Files smaller than 1MB: don't compress
    if size < MIN_SIZE_FOR_COMPRESSION {
        return false;
    }

    match get_file_category(filename) {
        FileCategory::Compressed => false,     // Already compressed
        FileCategory::Compressible => true,    // Compressible and large enough
        FileCategory::Unknown => true,         // Unknown but large: try compressing
    }
}

/// Get file category based on extension
pub fn get_file_category(filename: &str) -> FileCategory {
    let ext = get_extension(filename);

    if COMPRESSED_EXTENSIONS.contains(&ext.as_str()) {
        FileCategory::Compressed
    } else if COMPRESSIBLE_EXTENSIONS.contains(&ext.as_str()) {
        FileCategory::Compressible
    } else {
        FileCategory::Unknown
    }
}

/// Extract file extension (lowercase with dot)
fn get_extension(filename: &str) -> String {
    Path::new(filename)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{}", s.to_lowercase()))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compressed_formats() {
        assert_eq!(get_file_category("file.zip"), FileCategory::Compressed);
        assert_eq!(get_file_category("file.jpg"), FileCategory::Compressed);
        assert_eq!(get_file_category("file.mp4"), FileCategory::Compressed);
        assert_eq!(get_file_category("file.mp3"), FileCategory::Compressed);
        assert_eq!(get_file_category("file.pdf"), FileCategory::Compressed);
    }

    #[test]
    fn test_compressible_formats() {
        assert_eq!(get_file_category("file.txt"), FileCategory::Compressible);
        assert_eq!(get_file_category("file.log"), FileCategory::Compressible);
        assert_eq!(get_file_category("file.json"), FileCategory::Compressible);
        assert_eq!(get_file_category("file.csv"), FileCategory::Compressible);
        assert_eq!(get_file_category("file.rs"), FileCategory::Compressible);
        assert_eq!(get_file_category("file.py"), FileCategory::Compressible);
    }

    #[test]
    fn test_unknown_formats() {
        assert_eq!(get_file_category("file.xyz"), FileCategory::Unknown);
        assert_eq!(get_file_category("file.dat"), FileCategory::Unknown);
        assert_eq!(get_file_category("noextension"), FileCategory::Unknown);
    }

    #[test]
    fn test_case_insensitive() {
        assert_eq!(get_file_category("file.TXT"), FileCategory::Compressible);
        assert_eq!(get_file_category("file.ZIP"), FileCategory::Compressed);
        assert_eq!(get_file_category("file.JpG"), FileCategory::Compressed);
    }

    #[test]
    fn test_should_compress_by_size() {
        // Small files: don't compress
        assert!(!should_compress("large.txt", 500 * 1024)); // 500KB
        assert!(!should_compress("large.txt", 1024 * 1024 - 1)); // Just under 1MB

        // Large compressible files: compress
        assert!(should_compress("large.txt", 2 * 1024 * 1024)); // 2MB
        assert!(should_compress("large.log", 10 * 1024 * 1024)); // 10MB

        // Large compressed files: don't compress
        assert!(!should_compress("large.jpg", 10 * 1024 * 1024));
        assert!(!should_compress("large.mp4", 100 * 1024 * 1024));
    }

    #[test]
    fn test_should_compress_unknown_formats() {
        // Small unknown: don't compress
        assert!(!should_compress("file.xyz", 500 * 1024));

        // Large unknown: compress (conservative approach)
        assert!(should_compress("file.xyz", 2 * 1024 * 1024));
    }

    #[test]
    fn test_should_compress_edge_cases() {
        // Exactly 1MB (threshold)
        assert!(!should_compress("file.txt", 1024 * 1024 - 1)); // Just under
        assert!(should_compress("file.txt", 1024 * 1024));      // Exactly 1MB

        // Empty filename (unknown category, large size = compress)
        assert!(should_compress("", 2 * 1024 * 1024));

        // No extension (unknown category, large size = compress)
        assert!(should_compress("README", 2 * 1024 * 1024));
    }

    #[test]
    fn test_specific_use_cases() {
        // Source code files (should compress if large)
        assert!(should_compress("main.rs", 2 * 1024 * 1024));
        assert!(should_compress("script.py", 5 * 1024 * 1024));

        // Already compressed images (never compress)
        assert!(!should_compress("photo.jpg", 10 * 1024 * 1024));
        assert!(!should_compress("image.png", 5 * 1024 * 1024));

        // Videos (never compress)
        assert!(!should_compress("video.mp4", 1024 * 1024 * 1024)); // 1GB

        // Log files (compress if large)
        assert!(should_compress("app.log", 50 * 1024 * 1024));

        // JSON data (compress if large)
        assert!(should_compress("data.json", 10 * 1024 * 1024));
    }

    #[test]
    fn test_get_extension() {
        assert_eq!(get_extension("file.txt"), ".txt");
        assert_eq!(get_extension("file.TXT"), ".txt"); // Lowercase
        assert_eq!(get_extension("path/to/file.rs"), ".rs");
        assert_eq!(get_extension("noext"), "");
        assert_eq!(get_extension(""), "");
    }
}
