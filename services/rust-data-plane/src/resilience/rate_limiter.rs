use crate::error::RateLimitError;
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tracing::{debug, warn};

/// Rate limiter configuration
#[derive(Debug, Clone)]
pub struct RateLimiterConfig {
    /// Maximum requests per window
    pub max_requests: usize,
    /// Time window (seconds)
    pub window_seconds: u64,
}

impl Default for RateLimiterConfig {
    fn default() -> Self {
        Self {
            max_requests: 100,   // 100 requests
            window_seconds: 1,    // per second
        }
    }
}

/// Token bucket for rate limiting
///
/// # Algorithm
/// - Tokens refill at constant rate
/// - Each request consumes 1 token
/// - If no tokens available, request is rejected
///
/// # Properties
/// - Allows bursts up to bucket capacity
/// - Smooth rate limiting over time
/// - No need to track individual request timestamps
pub struct TokenBucket {
    capacity: usize,
    tokens: f64,
    refill_rate: f64,        // Tokens per second
    last_refill: Instant,
}

impl TokenBucket {
    /// Create new token bucket
    ///
    /// # Arguments
    /// * `capacity` - Maximum tokens in bucket
    /// * `refill_rate` - Tokens added per second
    pub fn new(capacity: usize, refill_rate: f64) -> Self {
        Self {
            capacity,
            tokens: capacity as f64,
            refill_rate,
            last_refill: Instant::now(),
        }
    }

    /// Try to consume tokens
    ///
    /// # Arguments
    /// * `tokens` - Number of tokens to consume (usually 1)
    ///
    /// # Returns
    /// Ok(()) if tokens available, Err if rate limited
    pub fn consume(&mut self, tokens: usize) -> Result<(), RateLimitError> {
        // Refill tokens based on elapsed time
        self.refill();

        if self.tokens >= tokens as f64 {
            self.tokens -= tokens as f64;
            Ok(())
        } else {
            // Calculate retry_after based on refill rate
            let tokens_needed = tokens as f64 - self.tokens;
            let retry_after_secs = (tokens_needed / self.refill_rate).ceil();
            let retry_after = Duration::from_secs_f64(retry_after_secs);

            warn!(
                available = self.tokens,
                requested = tokens,
                retry_after_secs = retry_after_secs,
                "Rate limit exceeded"
            );
            Err(RateLimitError::TooManyRequests { retry_after })
        }
    }

    /// Refill tokens based on elapsed time
    fn refill(&mut self) {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();

        if elapsed > 0.0 {
            let new_tokens = elapsed * self.refill_rate;
            self.tokens = (self.tokens + new_tokens).min(self.capacity as f64);
            self.last_refill = now;

            debug!(
                tokens = self.tokens,
                refilled = new_tokens,
                "Tokens refilled"
            );
        }
    }

    /// Get current token count
    pub fn available_tokens(&mut self) -> usize {
        self.refill();
        self.tokens.floor() as usize
    }
}

/// Rate limiter using token bucket algorithm
pub struct RateLimiter {
    config: RateLimiterConfig,
    bucket: Arc<Mutex<TokenBucket>>,
}

impl RateLimiter {
    /// Create new rate limiter
    pub fn new(config: RateLimiterConfig) -> Self {
        let refill_rate = config.max_requests as f64 / config.window_seconds as f64;
        let bucket = TokenBucket::new(config.max_requests, refill_rate);

        Self {
            config,
            bucket: Arc::new(Mutex::new(bucket)),
        }
    }

    /// Check if request should be allowed
    pub fn allow_request(&self) -> Result<(), RateLimitError> {
        let mut bucket = self.bucket.lock();
        bucket.consume(1)
    }

    /// Check if N requests should be allowed
    pub fn allow_n_requests(&self, n: usize) -> Result<(), RateLimitError> {
        let mut bucket = self.bucket.lock();
        bucket.consume(n)
    }

    /// Get number of available tokens
    pub fn available_tokens(&self) -> usize {
        let mut bucket = self.bucket.lock();
        bucket.available_tokens()
    }

    /// Get configuration
    pub fn config(&self) -> &RateLimiterConfig {
        &self.config
    }
}

impl Clone for RateLimiter {
    fn clone(&self) -> Self {
        Self {
            config: self.config.clone(),
            bucket: Arc::clone(&self.bucket),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_token_bucket_creation() {
        let bucket = TokenBucket::new(10, 1.0);
        assert_eq!(bucket.capacity, 10);
        assert_eq!(bucket.refill_rate, 1.0);
    }

    #[test]
    fn test_token_consumption() {
        let mut bucket = TokenBucket::new(10, 1.0);

        // Consume tokens
        assert!(bucket.consume(1).is_ok());
        assert_eq!(bucket.available_tokens(), 9);

        assert!(bucket.consume(5).is_ok());
        assert_eq!(bucket.available_tokens(), 4);
    }

    #[test]
    fn test_token_bucket_rate_limit() {
        let mut bucket = TokenBucket::new(5, 1.0);

        // Consume all tokens
        for _ in 0..5 {
            assert!(bucket.consume(1).is_ok());
        }

        // Next request should be rate limited
        let result = bucket.consume(1);
        assert!(result.is_err());
        assert!(matches!(result, Err(RateLimitError::TooManyRequests { .. })));
    }

    #[test]
    fn test_token_refill() {
        let mut bucket = TokenBucket::new(10, 10.0); // 10 tokens/sec

        // Consume all tokens
        bucket.consume(10).ok();
        assert_eq!(bucket.available_tokens(), 0);

        // Wait for refill (100ms = 1 token at 10 tokens/sec)
        std::thread::sleep(Duration::from_millis(100));

        let available = bucket.available_tokens();
        assert!(available >= 1);
    }

    #[test]
    fn test_token_bucket_capacity_limit() {
        let mut bucket = TokenBucket::new(10, 10.0);

        // Wait for potential refill
        std::thread::sleep(Duration::from_millis(500));

        // Refill shouldn't exceed capacity
        let available = bucket.available_tokens();
        assert!(available <= 10);
    }

    #[test]
    fn test_rate_limiter_creation() {
        let config = RateLimiterConfig {
            max_requests: 100,
            window_seconds: 1,
        };
        let limiter = RateLimiter::new(config);

        assert_eq!(limiter.config().max_requests, 100);
        assert_eq!(limiter.config().window_seconds, 1);
    }

    #[test]
    fn test_rate_limiter_allows_requests() {
        let config = RateLimiterConfig {
            max_requests: 10,
            window_seconds: 1,
        };
        let limiter = RateLimiter::new(config);

        // Should allow up to capacity
        for _ in 0..10 {
            assert!(limiter.allow_request().is_ok());
        }

        // Next should be rate limited
        let result = limiter.allow_request();
        assert!(result.is_err());
    }

    #[test]
    fn test_rate_limiter_allows_n_requests() {
        let config = RateLimiterConfig {
            max_requests: 10,
            window_seconds: 1,
        };
        let limiter = RateLimiter::new(config);

        // Consume 5 tokens at once
        assert!(limiter.allow_n_requests(5).is_ok());
        assert_eq!(limiter.available_tokens(), 5);

        // Consume remaining 5
        assert!(limiter.allow_n_requests(5).is_ok());
        assert_eq!(limiter.available_tokens(), 0);

        // No tokens left
        let result = limiter.allow_n_requests(1);
        assert!(result.is_err());
    }

    #[test]
    fn test_rate_limiter_refill() {
        let config = RateLimiterConfig {
            max_requests: 100,
            window_seconds: 1,
        };
        let limiter = RateLimiter::new(config);

        // Consume all tokens
        limiter.allow_n_requests(100).ok();
        assert_eq!(limiter.available_tokens(), 0);

        // Wait for partial refill
        std::thread::sleep(Duration::from_millis(100)); // ~10 tokens should refill

        let available = limiter.available_tokens();
        assert!(available >= 5); // At least some tokens refilled
        assert!(available <= 15); // But not all
    }

    #[test]
    fn test_rate_limiter_clone_shares_bucket() {
        let config = RateLimiterConfig {
            max_requests: 10,
            window_seconds: 1,
        };
        let limiter1 = RateLimiter::new(config);
        let limiter2 = limiter1.clone();

        // Consume from limiter1
        limiter1.allow_n_requests(5).ok();

        // limiter2 should see the consumption
        assert_eq!(limiter2.available_tokens(), 5);
    }

    #[test]
    fn test_rate_limiter_default_config() {
        let config = RateLimiterConfig::default();
        assert_eq!(config.max_requests, 100);
        assert_eq!(config.window_seconds, 1);
    }

    #[test]
    fn test_burst_handling() {
        let config = RateLimiterConfig {
            max_requests: 50,
            window_seconds: 1,
        };
        let limiter = RateLimiter::new(config);

        // Allow burst up to capacity
        for _ in 0..50 {
            assert!(limiter.allow_request().is_ok());
        }

        // Burst exceeded
        assert!(limiter.allow_request().is_err());
    }

    #[test]
    fn test_sustained_rate() {
        let config = RateLimiterConfig {
            max_requests: 10,
            window_seconds: 1,
        };
        let limiter = RateLimiter::new(config);

        // Consume initial capacity
        limiter.allow_n_requests(10).ok();

        // Wait for 1 second to fully refill
        std::thread::sleep(Duration::from_secs(1));

        // Should have refilled to capacity
        let available = limiter.available_tokens();
        assert!(available >= 9); // Allow some timing tolerance
    }
}
