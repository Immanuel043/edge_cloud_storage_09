use crate::error::CompressionError;
use std::io::{Read, Write};
use tracing::{debug, instrument};
use zstd::stream::Encoder;

/// Maximum decompressed size (64MB) - prevents OOM from decompression bombs
const MAX_DECOMPRESSED_SIZE: usize = 64 * 1024 * 1024;

/// Zstandard compressor with configurable compression level
pub struct ZstdCompressor {
    level: i32,
}

impl ZstdCompressor {
    /// Create new compressor with specified level (1-22)
    ///
    /// Recommended levels:
    /// - 1-3: Fast compression, lower ratio (real-time)
    /// - 3-9: Balanced (recommended for most cases)
    /// - 10-19: High compression, slower
    /// - 20-22: Maximum compression (very slow)
    pub fn new(level: i32) -> Result<Self, CompressionError> {
        if !(1..=22).contains(&level) {
            return Err(CompressionError::InvalidLevel(level));
        }

        Ok(Self { level })
    }

    /// Compress data with Zstandard
    ///
    /// # Arguments
    /// * `input` - Data to compress
    ///
    /// # Returns
    /// Compressed data
    #[instrument(skip(self, input), fields(input_len = input.len(), level = self.level))]
    pub fn compress(&self, input: &[u8]) -> Result<Vec<u8>, CompressionError> {
        let mut encoder = Encoder::new(Vec::new(), self.level)
            .map_err(|e| CompressionError::CompressionFailed(e.to_string()))?;

        encoder
            .write_all(input)
            .map_err(|e| CompressionError::CompressionFailed(e.to_string()))?;

        let compressed = encoder
            .finish()
            .map_err(|e| CompressionError::CompressionFailed(e.to_string()))?;

        let ratio = (compressed.len() as f64 / input.len() as f64) * 100.0;
        debug!(
            input_len = input.len(),
            output_len = compressed.len(),
            ratio = format!("{:.2}%", ratio),
            "Compression completed"
        );

        Ok(compressed)
    }

    /// Decompress Zstandard data with size limit to prevent decompression bombs
    ///
    /// # Arguments
    /// * `input` - Compressed data
    ///
    /// # Returns
    /// Decompressed data (fails if exceeds MAX_DECOMPRESSED_SIZE)
    #[instrument(skip(self, input), fields(input_len = input.len()))]
    pub fn decompress(&self, input: &[u8]) -> Result<Vec<u8>, CompressionError> {
        let mut decoder = zstd::stream::Decoder::new(input)
            .map_err(|e| CompressionError::DecompressionFailed(e.to_string()))?;

        let mut out = Vec::with_capacity(input.len().min(MAX_DECOMPRESSED_SIZE));
        let mut buf = [0u8; 65536];

        loop {
            let n = decoder
                .read(&mut buf)
                .map_err(|e| CompressionError::DecompressionFailed(e.to_string()))?;
            if n == 0 {
                break;
            }
            out.extend_from_slice(&buf[..n]);
            if out.len() > MAX_DECOMPRESSED_SIZE {
                return Err(CompressionError::DecompressionFailed(
                    "Decompressed size exceeds maximum allowed 64MB".to_string(),
                ));
            }
        }

        debug!(
            input_len = input.len(),
            output_len = out.len(),
            "Decompression completed"
        );

        Ok(out)
    }
}

impl Default for ZstdCompressor {
    /// Default compression level: 3 (balanced speed/ratio)
    fn default() -> Self {
        Self { level: 3 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compress_decompress_roundtrip() {
        let compressor = ZstdCompressor::new(3).unwrap();
        let original = b"Hello, world! This is a test message that should compress well because it has repetition. repetition. repetition.";

        let compressed = compressor.compress(original).unwrap();
        let decompressed = compressor.decompress(&compressed).unwrap();

        assert_eq!(original, &decompressed[..]);
        assert!(compressed.len() < original.len(), "Data should be compressed");
    }

    #[test]
    fn test_different_compression_levels() {
        let data = vec![b'A'; 10000]; // Highly compressible data

        let compressor_level1 = ZstdCompressor::new(1).unwrap();
        let compressor_level9 = ZstdCompressor::new(9).unwrap();
        let compressor_level19 = ZstdCompressor::new(19).unwrap();

        let compressed_l1 = compressor_level1.compress(&data).unwrap();
        let compressed_l9 = compressor_level9.compress(&data).unwrap();
        let compressed_l19 = compressor_level19.compress(&data).unwrap();

        // Higher levels should generally produce smaller output
        assert!(compressed_l19.len() <= compressed_l9.len());
        assert!(compressed_l9.len() <= compressed_l1.len() + 50); // Allow some tolerance
    }

    #[test]
    fn test_invalid_compression_level() {
        let result = ZstdCompressor::new(0);
        assert!(result.is_err());
        assert!(matches!(result, Err(CompressionError::InvalidLevel(0))));

        let result = ZstdCompressor::new(23);
        assert!(result.is_err());
        assert!(matches!(result, Err(CompressionError::InvalidLevel(23))));
    }

    #[test]
    fn test_empty_data() {
        let compressor = ZstdCompressor::new(3).unwrap();
        let empty: &[u8] = &[];

        let compressed = compressor.compress(empty).unwrap();
        let decompressed = compressor.decompress(&compressed).unwrap();

        assert_eq!(empty, &decompressed[..]);
    }

    #[test]
    fn test_incompressible_data() {
        let compressor = ZstdCompressor::new(3).unwrap();
        let random_data: Vec<u8> = (0..1000).map(|i| (i * 7 % 256) as u8).collect();

        let compressed = compressor.compress(&random_data).unwrap();
        let decompressed = compressor.decompress(&compressed).unwrap();

        assert_eq!(random_data, decompressed);
        // Random data may not compress well, but should still roundtrip
    }

    #[test]
    fn test_default_compressor() {
        let compressor = ZstdCompressor::default();
        let data = b"Test data for default compressor";

        let compressed = compressor.compress(data).unwrap();
        let decompressed = compressor.decompress(&compressed).unwrap();

        assert_eq!(data, &decompressed[..]);
    }

    #[test]
    fn test_large_data() {
        let compressor = ZstdCompressor::new(3).unwrap();
        let large_data = vec![b'A'; 1024 * 1024]; // 1MB

        let compressed = compressor.compress(&large_data).unwrap();
        let decompressed = compressor.decompress(&compressed).unwrap();

        assert_eq!(large_data.len(), decompressed.len());
        assert_eq!(large_data, decompressed);
        // Highly repetitive data should compress very well
        assert!(compressed.len() < large_data.len() / 100);
    }
}
