use lazy_static::lazy_static;
use prometheus::{
    register_counter_vec, register_histogram_vec, register_int_gauge, CounterVec, HistogramVec,
    IntGauge, Registry,
};

lazy_static! {
    /// Total requests processed
    pub static ref REQUESTS_TOTAL: CounterVec = register_counter_vec!(
        "edge_storage_requests_total",
        "Total number of requests processed",
        &["mode", "operation", "status"]
    )
    .unwrap();

    /// Request duration in seconds
    pub static ref REQUEST_DURATION: HistogramVec = register_histogram_vec!(
        "edge_storage_request_duration_seconds",
        "Request processing duration in seconds",
        &["mode", "operation"],
        vec![0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0]
    )
    .unwrap();

    /// Chunk processing metrics
    pub static ref CHUNKS_PROCESSED: CounterVec = register_counter_vec!(
        "edge_storage_chunks_processed_total",
        "Total number of chunks processed",
        &["mode", "operation"]
    )
    .unwrap();

    /// Chunk size distribution
    pub static ref CHUNK_SIZE_BYTES: HistogramVec = register_histogram_vec!(
        "edge_storage_chunk_size_bytes",
        "Chunk size distribution in bytes",
        &["mode"],
        vec![
            1024.0,           // 1KB
            10240.0,          // 10KB
            102400.0,         // 100KB
            1048576.0,        // 1MB
            10485760.0,       // 10MB
            33554432.0,       // 32MB
            67108864.0,       // 64MB
        ]
    )
    .unwrap();

    /// Compression ratio (original / compressed)
    pub static ref COMPRESSION_RATIO: HistogramVec = register_histogram_vec!(
        "edge_storage_compression_ratio",
        "Compression ratio (original size / compressed size)",
        &["mode"],
        vec![0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.5, 2.0, 5.0, 10.0]
    )
    .unwrap();

    /// Encryption operations
    pub static ref ENCRYPTION_OPS: CounterVec = register_counter_vec!(
        "edge_storage_encryption_ops_total",
        "Total number of encryption operations",
        &["operation", "status"]
    )
    .unwrap();

    /// Storage operations
    pub static ref STORAGE_OPS: CounterVec = register_counter_vec!(
        "edge_storage_storage_ops_total",
        "Total number of storage operations",
        &["operation", "status"]
    )
    .unwrap();

    /// Circuit breaker state
    pub static ref CIRCUIT_BREAKER_STATE: IntGauge = register_int_gauge!(
        "edge_storage_circuit_breaker_state",
        "Circuit breaker state (0=closed, 1=open, 2=half_open)"
    )
    .unwrap();

    /// Rate limiter tokens available
    pub static ref RATE_LIMITER_TOKENS: IntGauge = register_int_gauge!(
        "edge_storage_rate_limiter_tokens_available",
        "Number of tokens available in rate limiter"
    )
    .unwrap();

    /// Active connections
    pub static ref ACTIVE_CONNECTIONS: IntGauge = register_int_gauge!(
        "edge_storage_active_connections",
        "Number of active HTTP connections"
    )
    .unwrap();

    /// Buffer pool statistics
    pub static ref BUFFER_POOL_SIZE: IntGauge = register_int_gauge!(
        "edge_storage_buffer_pool_size",
        "Number of buffers in the pool"
    )
    .unwrap();

    /// Mode enforcement violations
    pub static ref MODE_VIOLATIONS: CounterVec = register_counter_vec!(
        "edge_storage_mode_violations_total",
        "Total number of mode enforcement violations",
        &["mode", "violation_type"]
    )
    .unwrap();

    /// Errors by type
    pub static ref ERRORS_TOTAL: CounterVec = register_counter_vec!(
        "edge_storage_errors_total",
        "Total number of errors",
        &["error_type"]
    )
    .unwrap();
}

/// Metrics container for easy access
pub struct Metrics;

impl Metrics {
    /// Record request
    pub fn record_request(mode: &str, operation: &str, status: &str, duration_secs: f64) {
        REQUESTS_TOTAL
            .with_label_values(&[mode, operation, status])
            .inc();
        REQUEST_DURATION
            .with_label_values(&[mode, operation])
            .observe(duration_secs);
    }

    /// Record chunk processed
    pub fn record_chunk_processed(mode: &str, operation: &str, size_bytes: usize) {
        CHUNKS_PROCESSED
            .with_label_values(&[mode, operation])
            .inc();
        CHUNK_SIZE_BYTES
            .with_label_values(&[mode])
            .observe(size_bytes as f64);
    }

    /// Record compression
    pub fn record_compression(mode: &str, original_size: usize, compressed_size: usize) {
        if compressed_size > 0 {
            let ratio = original_size as f64 / compressed_size as f64;
            COMPRESSION_RATIO
                .with_label_values(&[mode])
                .observe(ratio);
        }
    }

    /// Record encryption operation
    pub fn record_encryption(operation: &str, status: &str) {
        ENCRYPTION_OPS
            .with_label_values(&[operation, status])
            .inc();
    }

    /// Record storage operation
    pub fn record_storage(operation: &str, status: &str) {
        STORAGE_OPS
            .with_label_values(&[operation, status])
            .inc();
    }

    /// Update circuit breaker state
    pub fn update_circuit_breaker_state(state: i64) {
        CIRCUIT_BREAKER_STATE.set(state);
    }

    /// Update rate limiter tokens
    pub fn update_rate_limiter_tokens(tokens: i64) {
        RATE_LIMITER_TOKENS.set(tokens);
    }

    /// Update active connections
    pub fn update_active_connections(count: i64) {
        ACTIVE_CONNECTIONS.set(count);
    }

    /// Update buffer pool size
    pub fn update_buffer_pool_size(size: i64) {
        BUFFER_POOL_SIZE.set(size);
    }

    /// Record mode violation
    pub fn record_mode_violation(mode: &str, violation_type: &str) {
        MODE_VIOLATIONS
            .with_label_values(&[mode, violation_type])
            .inc();
    }

    /// Record error
    pub fn record_error(error_type: &str) {
        ERRORS_TOTAL.with_label_values(&[error_type]).inc();
    }
}

/// Register all metrics with a custom registry (optional - metrics use default registry by default)
/// Call this only if you need metrics in a custom registry for /metrics endpoint.
/// Using both default registry (from macros) and custom registry causes double registration.
pub fn register_metrics(_registry: &Registry) -> Result<(), prometheus::Error> {
    // Metrics are already registered to default registry via lazy_static macros.
    // Do not re-register to avoid double registration.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_record_request() {
        Metrics::record_request("non-zk", "upload", "success", 0.5);

        let value = REQUESTS_TOTAL
            .with_label_values(&["non-zk", "upload", "success"])
            .get();
        assert!(value >= 1.0);
    }

    #[test]
    fn test_record_chunk_processed() {
        Metrics::record_chunk_processed("zk", "upload", 1048576);

        let value = CHUNKS_PROCESSED
            .with_label_values(&["zk", "upload"])
            .get();
        assert!(value >= 1.0);
    }

    #[test]
    fn test_record_compression() {
        Metrics::record_compression("non-zk", 10000, 5000);

        // Ratio should be 2.0 (10000 / 5000)
        let metric = COMPRESSION_RATIO
            .with_label_values(&["non-zk"]);
        assert!(metric.get_sample_count() >= 1);
    }

    #[test]
    fn test_record_encryption() {
        Metrics::record_encryption("encrypt", "success");

        let value = ENCRYPTION_OPS
            .with_label_values(&["encrypt", "success"])
            .get();
        assert!(value >= 1.0);
    }

    #[test]
    fn test_record_storage() {
        Metrics::record_storage("write", "success");

        let value = STORAGE_OPS
            .with_label_values(&["write", "success"])
            .get();
        assert!(value >= 1.0);
    }

    #[test]
    fn test_update_circuit_breaker_state() {
        Metrics::update_circuit_breaker_state(1); // Open
        assert_eq!(CIRCUIT_BREAKER_STATE.get(), 1);

        Metrics::update_circuit_breaker_state(0); // Closed
        assert_eq!(CIRCUIT_BREAKER_STATE.get(), 0);
    }

    #[test]
    fn test_update_rate_limiter_tokens() {
        Metrics::update_rate_limiter_tokens(50);
        assert_eq!(RATE_LIMITER_TOKENS.get(), 50);
    }

    #[test]
    fn test_update_active_connections() {
        Metrics::update_active_connections(10);
        assert_eq!(ACTIVE_CONNECTIONS.get(), 10);
    }

    #[test]
    fn test_update_buffer_pool_size() {
        Metrics::update_buffer_pool_size(25);
        assert_eq!(BUFFER_POOL_SIZE.get(), 25);
    }

    #[test]
    fn test_record_mode_violation() {
        Metrics::record_mode_violation("zk", "key_leakage");

        let value = MODE_VIOLATIONS
            .with_label_values(&["zk", "key_leakage"])
            .get();
        assert!(value >= 1.0);
    }

    #[test]
    fn test_record_error() {
        Metrics::record_error("encryption_failed");

        let value = ERRORS_TOTAL
            .with_label_values(&["encryption_failed"])
            .get();
        assert!(value >= 1.0);
    }
}
