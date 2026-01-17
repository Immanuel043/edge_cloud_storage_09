// Main entry point for edge-storage-dataplane service
use edge_storage_dataplane::{
    detect_aes_ni, init_tracing, register_metrics, CircuitBreaker, CircuitBreakerConfig,
    RateLimiter, RateLimiterConfig, ServerConfig, TracingConfig, UnixSocketServer,
    UnixSocketServerWithScmRights, WriteOptions,
};
use prometheus::Registry;
use tracing::info;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing
    let tracing_config = TracingConfig::default();
    init_tracing(tracing_config);

    info!(
        "🚀 Starting Edge Storage Data Plane v{}",
        env!("CARGO_PKG_VERSION")
    );

    // Detect hardware capabilities
    let has_aes_ni = detect_aes_ni();
    info!(
        "Hardware AES-NI: {}",
        if has_aes_ni {
            "✅ Available"
        } else {
            "❌ Not available"
        }
    );

    // Register Prometheus metrics
    let registry = Registry::new();
    register_metrics(&registry)?;
    info!("📊 Prometheus metrics registered");

    // Initialize resilience components (for future use)
    let circuit_breaker_config = CircuitBreakerConfig::default();
    let _circuit_breaker = CircuitBreaker::new(circuit_breaker_config);

    let rate_limiter_config = RateLimiterConfig::default();
    let _rate_limiter = RateLimiter::new(rate_limiter_config);

    info!("🛡️  Resilience components initialized");

    // Configure server
    let socket_path =
        std::env::var("SOCKET_PATH").unwrap_or_else(|_| "/tmp/edge-storage-dataplane.sock".to_string());

    let storage_root =
        std::env::var("STORAGE_ROOT").unwrap_or_else(|_| "/tmp/edge-storage".to_string());

    let compression_level = std::env::var("COMPRESSION_LEVEL")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3);

    let write_options = WriteOptions::default();

    let server_config = ServerConfig {
        socket_path: socket_path.clone(),
        storage_root: storage_root.clone(),
        compression_level,
        write_options,
    };

    info!(
        socket_path = %socket_path,
        storage_root = %storage_root,
        compression_level = compression_level,
        "🔧 Server configuration loaded"
    );

    // Choose server implementation based on environment variable
    let use_scm_rights = std::env::var("USE_SCM_RIGHTS")
        .unwrap_or_else(|_| "true".to_string())
        .to_lowercase()
        == "true";

    if use_scm_rights {
        info!("🔐 Using SCM_RIGHTS server (full Non-ZK mode support)");
        let server = UnixSocketServerWithScmRights::new(server_config)?;
        info!("🌐 Server initialized with SCM_RIGHTS support");
        info!("🚀 Starting Unix Domain Socket server (SCM_RIGHTS enabled)");
        server.serve().await?;
    } else {
        info!("⚠️  Using legacy Hyper server (limited Non-ZK support)");
        let server = UnixSocketServer::new(server_config)?;
        info!("🌐 Server initialized");
        info!("🚀 Starting Unix Domain Socket server");
        server.serve().await?;
    }

    Ok(())
}
