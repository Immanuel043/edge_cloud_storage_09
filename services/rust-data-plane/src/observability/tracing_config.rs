use tracing::Level;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// Tracing configuration
#[derive(Debug, Clone)]
pub struct TracingConfig {
    /// Log level
    pub level: Level,
    /// Enable JSON formatting
    pub json_format: bool,
    /// Enable ANSI colors
    pub ansi: bool,
    /// Service name for distributed tracing
    pub service_name: String,
}

impl Default for TracingConfig {
    fn default() -> Self {
        Self {
            level: Level::INFO,
            json_format: false,
            ansi: true,
            service_name: "edge-storage-dataplane".to_string(),
        }
    }
}

/// Initialize tracing/logging
pub fn init_tracing(config: TracingConfig) {
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(config.level.to_string()));

    if config.json_format {
        tracing_subscriber::registry()
            .with(env_filter)
            .with(fmt::layer().json().with_ansi(false))
            .init();
    } else {
        tracing_subscriber::registry()
            .with(env_filter)
            .with(fmt::layer().with_ansi(config.ansi))
            .init();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = TracingConfig::default();
        assert_eq!(config.level, Level::INFO);
        assert!(!config.json_format);
        assert!(config.ansi);
        assert_eq!(config.service_name, "edge-storage-dataplane");
    }

    #[test]
    fn test_custom_config() {
        let config = TracingConfig {
            level: Level::DEBUG,
            json_format: true,
            ansi: false,
            service_name: "test-service".to_string(),
        };

        assert_eq!(config.level, Level::DEBUG);
        assert!(config.json_format);
        assert!(!config.ansi);
        assert_eq!(config.service_name, "test-service");
    }
}
