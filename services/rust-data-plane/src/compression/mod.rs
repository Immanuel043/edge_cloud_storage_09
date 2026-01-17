pub mod zstd_compression;
pub mod detector;

pub use zstd_compression::ZstdCompressor;
pub use detector::{should_compress, get_file_category, FileCategory};
