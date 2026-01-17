use thiserror::Error;

#[derive(Error, Debug)]
pub enum DataPlaneError {
    #[error("Crypto error: {0}")]
    Crypto(#[from] CryptoError),

    #[error("Compression error: {0}")]
    Compression(#[from] CompressionError),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Mode enforcement violation: {0}")]
    Security(#[from] SecurityError),

    #[error("Invalid request: {0}")]
    InvalidRequest(String),

    #[error("Internal error: {0}")]
    Internal(String),

    #[error("Rate limit exceeded: {0}")]
    RateLimit(#[from] RateLimitError),

    #[error("Circuit breaker error: {0}")]
    CircuitBreaker(#[from] CircuitBreakerError),
}

#[derive(Error, Debug)]
pub enum CryptoError {
    #[error("AES-GCM encryption failed")]
    EncryptionFailed,

    #[error("AES-GCM decryption failed")]
    DecryptionFailed,

    #[error("Invalid ciphertext format")]
    InvalidCiphertext,

    #[error("Key zeroization failed")]
    ZeroizationFailed,

    #[error("Invalid key size: expected 32 bytes")]
    InvalidKeySize,

    #[error("Failed to generate random nonce")]
    NonceGenerationFailed,

    #[error("Ring crypto error: {0}")]
    RingError(String),
}

#[derive(Error, Debug)]
pub enum CompressionError {
    #[error("Zstd compression failed: {0}")]
    CompressionFailed(String),

    #[error("Zstd decompression failed: {0}")]
    DecompressionFailed(String),

    #[error("Invalid compression level: {0}")]
    InvalidLevel(i32),
}

#[derive(Error, Debug)]
pub enum SecurityError {
    #[error("ZK mode cannot receive encryption keys")]
    ZkModeKeyLeakage,

    #[error("Non-ZK mode requires encryption key")]
    NonZkMissingKey,

    #[error("Invalid mode: {0}")]
    InvalidMode(String),

    #[error("Key file descriptor not provided")]
    MissingKeyFd,

    #[error("Failed to read key from memfd: {0}")]
    KeyReadFailed(String),
}

#[derive(Error, Debug)]
pub enum RateLimitError {
    #[error("Too many requests, retry after {retry_after:?}")]
    TooManyRequests {
        retry_after: std::time::Duration,
    },

    #[error("Rate limiter configuration error: {0}")]
    ConfigError(String),
}

#[derive(Error, Debug)]
pub enum CircuitBreakerError {
    #[error("Circuit breaker is open")]
    CircuitOpen,

    #[error("Too many requests in half-open state")]
    TooManyRequests,

    #[error("Operation failed")]
    OperationFailed,
}

// Convert ring's Unspecified error to our CryptoError
impl From<ring::error::Unspecified> for CryptoError {
    fn from(_: ring::error::Unspecified) -> Self {
        CryptoError::RingError("Unspecified ring error".to_string())
    }
}

// HTTP response helpers
impl DataPlaneError {
    pub fn status_code(&self) -> u16 {
        match self {
            DataPlaneError::Security(_) => 403,
            DataPlaneError::InvalidRequest(_) => 400,
            DataPlaneError::RateLimit(_) => 429,
            DataPlaneError::CircuitBreaker(_) => 503,
            _ => 500,
        }
    }

    pub fn error_code(&self) -> &str {
        match self {
            DataPlaneError::Crypto(_) => "encryption_failed",
            DataPlaneError::Compression(_) => "compression_failed",
            DataPlaneError::Io(_) => "io_error",
            DataPlaneError::Security(_) => "security_violation",
            DataPlaneError::InvalidRequest(_) => "invalid_request",
            DataPlaneError::Internal(_) => "internal_error",
            DataPlaneError::RateLimit(_) => "rate_limit_exceeded",
            DataPlaneError::CircuitBreaker(_) => "circuit_breaker_error",
        }
    }
}
