// Main entry point for edge-storage-dataplane service
use edge_storage_dataplane::{
    detect_aes_ni, init_tracing, CircuitBreaker, CircuitBreakerConfig, RateLimiter,
    RateLimiterConfig, ServerConfig, TracingConfig, UnixSocketServer,
    UnixSocketServerWithScmRights, WriteOptions,
};
use std::sync::Arc;
use tokio::sync::broadcast;
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

    // Prometheus metrics use default registry (registered on first use via lazy_static)
    info!("📊 Prometheus metrics available");

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

    // Shutdown channel for graceful termination on SIGTERM/SIGINT
    let (shutdown_tx, shutdown_rx) = broadcast::channel(1);
    let shutdown_tx = std::sync::Arc::new(shutdown_tx);

    // Spawn signal listener (SIGINT = Ctrl+C, SIGTERM = `docker stop`).
    // Without SIGTERM handling the container would be killed mid-stream
    // when Docker stops it, truncating in-flight downloads.
    let shutdown_tx_clone = Arc::clone(&shutdown_tx);
    tokio::spawn(async move {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(error = %e, "Failed to install SIGTERM handler");
                return;
            }
        };
        tokio::select! {
            res = tokio::signal::ctrl_c() => {
                if let Err(e) = res {
                    tracing::error!(error = %e, "Failed to listen for ctrl_c");
                    return;
                }
                info!("Received shutdown signal (Ctrl+C / SIGINT)");
            }
            _ = sigterm.recv() => {
                info!("Received shutdown signal (SIGTERM)");
            }
        }
        let _ = shutdown_tx_clone.send(());
    });

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
        server.serve(shutdown_rx).await?;
    } else {
        info!("⚠️  Using legacy Hyper server (limited Non-ZK support)");
        let server = UnixSocketServer::new(server_config)?;
        info!("🌐 Server initialized");
        info!("🚀 Starting Unix Domain Socket server");
        server.serve(shutdown_rx).await?;
    }

    info!("Server shutdown complete");
    Ok(())
}
