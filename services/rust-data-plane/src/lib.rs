// Library entry point for edge-storage-dataplane

pub mod crypto;
pub mod compression;
pub mod processing;
pub mod modes;
pub mod storage;
pub mod server;
pub mod resilience;
pub mod observability;
pub mod error;

// Re-export commonly used types
pub use crypto::{AesGcmCipher, SecretKey, detect_aes_ni};
pub use compression::{ZstdCompressor, should_compress, get_file_category, FileCategory};
pub use processing::{BufferPool, ChunkProcessor, ProcessedChunk, ProcessingPipeline, PipelineConfig};
pub use modes::{ProcessingMode, ModeEnforcer, ZkModeProcessor, NonZkModeProcessor};
pub use storage::{AtomicWriter, WriteOptions, FsyncStrategy, ChunkStorage, StorageStats};
pub use server::{
    ChunkRequest, UploadRequest, DownloadRequest, ChunkResponse, ErrorResponse,
    UploadHandler, DownloadHandler, UnixSocketServer, UnixSocketServerWithScmRights, ServerConfig,
};
pub use resilience::{
    CircuitBreaker, CircuitBreakerConfig, CircuitState,
    RateLimiter, RateLimiterConfig, TokenBucket,
};
pub use observability::{
    Metrics, register_metrics,
    init_tracing, TracingConfig,
};
pub use error::{
    CryptoError, DataPlaneError, SecurityError, CompressionError,
    RateLimitError, CircuitBreakerError,
};
