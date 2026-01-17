use crate::error::{CircuitBreakerError, DataPlaneError};
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tracing::{debug, warn};

/// Circuit breaker state
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CircuitState {
    /// Circuit is closed - requests allowed
    Closed,
    /// Circuit is open - requests blocked (fast fail)
    Open,
    /// Circuit is half-open - testing if service recovered
    HalfOpen,
}

/// Circuit breaker configuration
#[derive(Debug, Clone)]
pub struct CircuitBreakerConfig {
    /// Failure threshold to open circuit (number of failures)
    pub failure_threshold: usize,
    /// Success threshold to close circuit from half-open
    pub success_threshold: usize,
    /// Timeout before attempting half-open (seconds)
    pub timeout_seconds: u64,
    /// Window size for failure counting (seconds)
    pub window_seconds: u64,
}

impl Default for CircuitBreakerConfig {
    fn default() -> Self {
        Self {
            failure_threshold: 5,      // Open after 5 failures
            success_threshold: 2,      // Close after 2 successes in half-open
            timeout_seconds: 60,       // Try half-open after 60s
            window_seconds: 10,        // Count failures in 10s window
        }
    }
}

/// Circuit breaker state machine
struct CircuitBreakerState {
    state: CircuitState,
    failure_count: usize,
    success_count: usize,
    last_failure_time: Option<Instant>,
    opened_at: Option<Instant>,
}

/// Circuit breaker for fault tolerance
///
/// # Pattern
/// - Closed: Normal operation, count failures
/// - Open: Fast fail without calling service
/// - Half-Open: Allow limited requests to test recovery
///
/// # Use Case
/// Prevent cascading failures when downstream service is degraded
pub struct CircuitBreaker {
    config: CircuitBreakerConfig,
    state: Arc<Mutex<CircuitBreakerState>>,
}

impl CircuitBreaker {
    /// Create new circuit breaker
    pub fn new(config: CircuitBreakerConfig) -> Self {
        Self {
            config,
            state: Arc::new(Mutex::new(CircuitBreakerState {
                state: CircuitState::Closed,
                failure_count: 0,
                success_count: 0,
                last_failure_time: None,
                opened_at: None,
            })),
        }
    }

    /// Check if request should be allowed
    pub fn allow_request(&self) -> Result<(), CircuitBreakerError> {
        let mut state = self.state.lock();

        match state.state {
            CircuitState::Closed => {
                // Check if failure window expired
                if let Some(last_failure) = state.last_failure_time {
                    let window = Duration::from_secs(self.config.window_seconds);
                    if last_failure.elapsed() > window {
                        // Reset failure count (window expired)
                        state.failure_count = 0;
                        state.last_failure_time = None;
                    }
                }
                Ok(())
            }
            CircuitState::Open => {
                // Check if timeout expired
                if let Some(opened_at) = state.opened_at {
                    let timeout = Duration::from_secs(self.config.timeout_seconds);
                    if opened_at.elapsed() > timeout {
                        // Transition to half-open
                        debug!("Circuit transitioning from Open to HalfOpen");
                        state.state = CircuitState::HalfOpen;
                        state.success_count = 0;
                        Ok(())
                    } else {
                        // Still open - reject request
                        Err(CircuitBreakerError::CircuitOpen)
                    }
                } else {
                    Err(CircuitBreakerError::CircuitOpen)
                }
            }
            CircuitState::HalfOpen => {
                // Allow limited requests to test recovery
                Ok(())
            }
        }
    }

    /// Record successful operation
    pub fn record_success(&self) {
        let mut state = self.state.lock();

        match state.state {
            CircuitState::Closed => {
                // Reset failure count on success
                state.failure_count = 0;
                state.last_failure_time = None;
            }
            CircuitState::HalfOpen => {
                state.success_count += 1;
                debug!(
                    success_count = state.success_count,
                    threshold = self.config.success_threshold,
                    "Circuit half-open success"
                );

                if state.success_count >= self.config.success_threshold {
                    // Transition to closed
                    debug!("Circuit transitioning from HalfOpen to Closed");
                    state.state = CircuitState::Closed;
                    state.failure_count = 0;
                    state.success_count = 0;
                    state.last_failure_time = None;
                    state.opened_at = None;
                }
            }
            CircuitState::Open => {
                // Shouldn't happen, but ignore
            }
        }
    }

    /// Record failed operation
    pub fn record_failure(&self) {
        let mut state = self.state.lock();

        match state.state {
            CircuitState::Closed => {
                state.failure_count += 1;
                state.last_failure_time = Some(Instant::now());

                warn!(
                    failure_count = state.failure_count,
                    threshold = self.config.failure_threshold,
                    "Circuit failure recorded"
                );

                if state.failure_count >= self.config.failure_threshold {
                    // Transition to open
                    warn!("Circuit transitioning from Closed to Open");
                    state.state = CircuitState::Open;
                    state.opened_at = Some(Instant::now());
                }
            }
            CircuitState::HalfOpen => {
                // Any failure in half-open immediately reopens
                warn!("Circuit transitioning from HalfOpen to Open (failure during test)");
                state.state = CircuitState::Open;
                state.opened_at = Some(Instant::now());
                state.success_count = 0;
            }
            CircuitState::Open => {
                // Already open, just update timestamp
                state.opened_at = Some(Instant::now());
            }
        }
    }

    /// Get current circuit state
    pub fn state(&self) -> CircuitState {
        self.state.lock().state
    }

    /// Reset circuit to closed state
    pub fn reset(&self) {
        let mut state = self.state.lock();
        debug!("Circuit manually reset to Closed");
        state.state = CircuitState::Closed;
        state.failure_count = 0;
        state.success_count = 0;
        state.last_failure_time = None;
        state.opened_at = None;
    }

    /// Execute function with circuit breaker protection
    pub async fn execute<F, T, E>(&self, f: F) -> Result<T, DataPlaneError>
    where
        F: std::future::Future<Output = Result<T, E>>,
        E: Into<DataPlaneError>,
    {
        // Check if request allowed
        self.allow_request()?;

        // Execute function
        match f.await {
            Ok(result) => {
                self.record_success();
                Ok(result)
            }
            Err(e) => {
                self.record_failure();
                Err(e.into())
            }
        }
    }
}

impl Clone for CircuitBreaker {
    fn clone(&self) -> Self {
        Self {
            config: self.config.clone(),
            state: Arc::clone(&self.state),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_circuit_starts_closed() {
        let cb = CircuitBreaker::new(CircuitBreakerConfig::default());
        assert_eq!(cb.state(), CircuitState::Closed);
        assert!(cb.allow_request().is_ok());
    }

    #[test]
    fn test_circuit_opens_after_threshold() {
        let config = CircuitBreakerConfig {
            failure_threshold: 3,
            ..Default::default()
        };
        let cb = CircuitBreaker::new(config);

        // Record failures
        cb.record_failure();
        cb.record_failure();
        assert_eq!(cb.state(), CircuitState::Closed);

        cb.record_failure();
        assert_eq!(cb.state(), CircuitState::Open);
    }

    #[test]
    fn test_circuit_open_rejects_requests() {
        let config = CircuitBreakerConfig {
            failure_threshold: 1,
            ..Default::default()
        };
        let cb = CircuitBreaker::new(config);

        cb.record_failure();
        assert_eq!(cb.state(), CircuitState::Open);

        let result = cb.allow_request();
        assert!(result.is_err());
        assert!(matches!(result, Err(CircuitBreakerError::CircuitOpen)));
    }

    #[test]
    fn test_circuit_transitions_to_half_open() {
        let config = CircuitBreakerConfig {
            failure_threshold: 1,
            timeout_seconds: 0, // Immediate timeout for testing
            ..Default::default()
        };
        let cb = CircuitBreaker::new(config);

        cb.record_failure();
        assert_eq!(cb.state(), CircuitState::Open);

        // Sleep briefly to ensure timeout passed
        std::thread::sleep(Duration::from_millis(10));

        // Next request should transition to half-open
        assert!(cb.allow_request().is_ok());
        assert_eq!(cb.state(), CircuitState::HalfOpen);
    }

    #[test]
    fn test_circuit_closes_from_half_open() {
        let config = CircuitBreakerConfig {
            failure_threshold: 1,
            success_threshold: 2,
            timeout_seconds: 0,
            ..Default::default()
        };
        let cb = CircuitBreaker::new(config);

        // Open circuit
        cb.record_failure();
        std::thread::sleep(Duration::from_millis(10));
        cb.allow_request().ok(); // Transition to half-open

        assert_eq!(cb.state(), CircuitState::HalfOpen);

        // Record successes
        cb.record_success();
        assert_eq!(cb.state(), CircuitState::HalfOpen);

        cb.record_success();
        assert_eq!(cb.state(), CircuitState::Closed);
    }

    #[test]
    fn test_circuit_reopens_on_half_open_failure() {
        let config = CircuitBreakerConfig {
            failure_threshold: 1,
            timeout_seconds: 0,
            ..Default::default()
        };
        let cb = CircuitBreaker::new(config);

        // Open and transition to half-open
        cb.record_failure();
        std::thread::sleep(Duration::from_millis(10));
        cb.allow_request().ok();

        assert_eq!(cb.state(), CircuitState::HalfOpen);

        // Failure in half-open reopens circuit
        cb.record_failure();
        assert_eq!(cb.state(), CircuitState::Open);
    }

    #[test]
    fn test_circuit_reset() {
        let config = CircuitBreakerConfig {
            failure_threshold: 1,
            ..Default::default()
        };
        let cb = CircuitBreaker::new(config);

        cb.record_failure();
        assert_eq!(cb.state(), CircuitState::Open);

        cb.reset();
        assert_eq!(cb.state(), CircuitState::Closed);
        assert!(cb.allow_request().is_ok());
    }

    #[test]
    fn test_failure_window_expiration() {
        let config = CircuitBreakerConfig {
            failure_threshold: 3,
            window_seconds: 0, // Immediate window expiration
            ..Default::default()
        };
        let cb = CircuitBreaker::new(config);

        // Record failures
        cb.record_failure();
        cb.record_failure();

        // Sleep to expire window
        std::thread::sleep(Duration::from_millis(10));

        // Failure count should reset
        cb.allow_request().ok();
        assert_eq!(cb.state(), CircuitState::Closed);

        // Would need 3 new failures to open
        cb.record_failure();
        cb.record_failure();
        assert_eq!(cb.state(), CircuitState::Closed);
    }

    #[test]
    fn test_success_resets_failure_count() {
        let config = CircuitBreakerConfig {
            failure_threshold: 3,
            ..Default::default()
        };
        let cb = CircuitBreaker::new(config);

        cb.record_failure();
        cb.record_failure();
        assert_eq!(cb.state(), CircuitState::Closed);

        cb.record_success();

        // Should need 3 new failures after reset
        cb.record_failure();
        cb.record_failure();
        assert_eq!(cb.state(), CircuitState::Closed);

        cb.record_failure();
        assert_eq!(cb.state(), CircuitState::Open);
    }

    #[tokio::test]
    async fn test_execute_with_success() {
        let cb = CircuitBreaker::new(CircuitBreakerConfig::default());

        let result = cb.execute(async { Ok::<_, DataPlaneError>(42) }).await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 42);
        assert_eq!(cb.state(), CircuitState::Closed);
    }

    #[tokio::test]
    async fn test_execute_with_failure() {
        let config = CircuitBreakerConfig {
            failure_threshold: 1,
            ..Default::default()
        };
        let cb = CircuitBreaker::new(config);

        let result = cb
            .execute(async { Err::<i32, _>(DataPlaneError::Internal("error".to_string())) })
            .await;

        assert!(result.is_err());
        assert_eq!(cb.state(), CircuitState::Open);
    }

    #[test]
    fn test_clone_shares_state() {
        let cb1 = CircuitBreaker::new(CircuitBreakerConfig::default());
        let cb2 = cb1.clone();

        cb1.record_failure();

        // Both should see the same state
        assert_eq!(cb1.state(), cb2.state());
    }
}
