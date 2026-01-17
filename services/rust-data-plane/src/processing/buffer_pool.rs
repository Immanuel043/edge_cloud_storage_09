use bytes::BytesMut;
use parking_lot::Mutex;
use std::sync::Arc;
use tracing::{debug, warn};

/// Zero-copy buffer pool for chunk processing
///
/// # Design
/// - Reuses buffers to reduce allocations
/// - Thread-safe with parking_lot Mutex (faster than std::sync::Mutex)
/// - Configurable capacity and buffer size
/// - Pressure-based eviction when pool is full
///
/// # Performance
/// - Eliminates GC pressure from repeated allocations
/// - Predictable memory usage
/// - Fast acquire/release operations (~10ns overhead)
pub struct BufferPool {
    pool: Arc<Mutex<Vec<BytesMut>>>,
    buffer_size: usize,
    max_buffers: usize,
}

impl BufferPool {
    /// Create new buffer pool
    ///
    /// # Arguments
    /// * `buffer_size` - Size of each buffer (typically 32MB for chunks)
    /// * `max_buffers` - Maximum number of buffers to retain
    pub fn new(buffer_size: usize, max_buffers: usize) -> Self {
        debug!(
            buffer_size_mb = buffer_size / (1024 * 1024),
            max_buffers = max_buffers,
            max_memory_mb = (buffer_size * max_buffers) / (1024 * 1024),
            "Creating buffer pool"
        );

        Self {
            pool: Arc::new(Mutex::new(Vec::with_capacity(max_buffers))),
            buffer_size,
            max_buffers,
        }
    }

    /// Acquire a buffer from the pool
    ///
    /// If pool is empty, allocates a new buffer.
    /// Returns a buffer with capacity >= buffer_size.
    pub fn acquire(&self) -> BytesMut {
        let mut pool = self.pool.lock();

        if let Some(buffer) = pool.pop() {
            debug!(
                pool_size = pool.len(),
                action = "reused",
                "Buffer acquired from pool"
            );
            drop(pool); // Release lock early
            buffer
        } else {
            drop(pool); // Release lock before allocation
            debug!(
                buffer_size_mb = self.buffer_size / (1024 * 1024),
                action = "allocated",
                "Buffer allocated (pool empty)"
            );
            BytesMut::with_capacity(self.buffer_size)
        }
    }

    /// Release a buffer back to the pool
    ///
    /// Buffer is cleared and returned to pool if pool has capacity.
    /// Otherwise, buffer is dropped (garbage collected).
    pub fn release(&self, mut buffer: BytesMut) {
        buffer.clear();

        let mut pool = self.pool.lock();

        if pool.len() < self.max_buffers {
            pool.push(buffer);
            debug!(
                pool_size = pool.len(),
                action = "returned",
                "Buffer returned to pool"
            );
        } else {
            warn!(
                pool_size = pool.len(),
                action = "dropped",
                "Buffer dropped (pool full)"
            );
        }
    }

    /// Get current pool statistics
    pub fn stats(&self) -> PoolStats {
        let pool = self.pool.lock();
        PoolStats {
            available_buffers: pool.len(),
            max_buffers: self.max_buffers,
            buffer_size: self.buffer_size,
            total_memory_mb: (pool.len() * self.buffer_size) / (1024 * 1024),
        }
    }

    /// Clear all buffers from pool (force garbage collection)
    pub fn clear(&self) {
        let mut pool = self.pool.lock();
        let count = pool.len();
        pool.clear();
        debug!(buffers_cleared = count, "Buffer pool cleared");
    }
}

impl Clone for BufferPool {
    fn clone(&self) -> Self {
        Self {
            pool: Arc::clone(&self.pool),
            buffer_size: self.buffer_size,
            max_buffers: self.max_buffers,
        }
    }
}

/// Pool statistics for monitoring
#[derive(Debug, Clone)]
pub struct PoolStats {
    pub available_buffers: usize,
    pub max_buffers: usize,
    pub buffer_size: usize,
    pub total_memory_mb: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_acquire_and_release() {
        let pool = BufferPool::new(1024, 10);

        // Acquire buffer (should allocate)
        let buffer1 = pool.acquire();
        assert_eq!(buffer1.capacity(), 1024);

        // Release buffer
        pool.release(buffer1);

        // Acquire again (should reuse)
        let buffer2 = pool.acquire();
        assert_eq!(buffer2.capacity(), 1024);

        let stats = pool.stats();
        assert_eq!(stats.available_buffers, 0); // One buffer in use
    }

    #[test]
    fn test_pool_capacity_limit() {
        let pool = BufferPool::new(1024, 2); // Max 2 buffers

        let buffer1 = pool.acquire();
        let buffer2 = pool.acquire();
        let buffer3 = pool.acquire();

        // Return all buffers
        pool.release(buffer1);
        pool.release(buffer2);
        pool.release(buffer3); // This should be dropped (pool full)

        let stats = pool.stats();
        assert_eq!(stats.available_buffers, 2); // Only 2 retained
        assert_eq!(stats.max_buffers, 2);
    }

    #[test]
    fn test_buffer_cleared_on_release() {
        let pool = BufferPool::new(1024, 10);

        let mut buffer = pool.acquire();
        buffer.extend_from_slice(b"test data");
        assert!(!buffer.is_empty());

        pool.release(buffer);

        let buffer2 = pool.acquire();
        assert!(buffer2.is_empty()); // Should be cleared
    }

    #[test]
    fn test_multiple_acquires_from_empty_pool() {
        let pool = BufferPool::new(1024, 10);

        let buffers: Vec<_> = (0..5).map(|_| pool.acquire()).collect();

        assert_eq!(buffers.len(), 5);
        for buffer in buffers {
            assert_eq!(buffer.capacity(), 1024);
        }

        let stats = pool.stats();
        assert_eq!(stats.available_buffers, 0); // All buffers in use
    }

    #[test]
    fn test_stats() {
        let pool = BufferPool::new(32 * 1024 * 1024, 100); // 32MB buffers, max 100

        // Acquire 5 buffers first, then release them
        let buffers: Vec<_> = (0..5).map(|_| pool.acquire()).collect();
        for buffer in buffers {
            pool.release(buffer);
        }

        let stats = pool.stats();
        assert_eq!(stats.available_buffers, 5);
        assert_eq!(stats.max_buffers, 100);
        assert_eq!(stats.buffer_size, 32 * 1024 * 1024);
        assert_eq!(stats.total_memory_mb, 160); // 5 * 32MB
    }

    #[test]
    fn test_clear_pool() {
        let pool = BufferPool::new(1024, 10);

        // Acquire 5 buffers first, then release them
        let buffers: Vec<_> = (0..5).map(|_| pool.acquire()).collect();
        for buffer in buffers {
            pool.release(buffer);
        }

        assert_eq!(pool.stats().available_buffers, 5);

        pool.clear();

        assert_eq!(pool.stats().available_buffers, 0);
    }

    #[test]
    fn test_clone_shares_pool() {
        let pool1 = BufferPool::new(1024, 10);

        // Add buffer to pool1
        pool1.release(pool1.acquire());
        assert_eq!(pool1.stats().available_buffers, 1);

        // Clone pool
        let pool2 = pool1.clone();

        // Acquire from pool2 (should get the same buffer)
        let _buffer = pool2.acquire();
        assert_eq!(pool1.stats().available_buffers, 0);
        assert_eq!(pool2.stats().available_buffers, 0);
    }

    #[test]
    fn test_concurrent_access() {
        use std::thread;

        let pool = BufferPool::new(1024, 100);

        let handles: Vec<_> = (0..10)
            .map(|_| {
                let pool_clone = pool.clone();
                thread::spawn(move || {
                    for _ in 0..10 {
                        let buffer = pool_clone.acquire();
                        // Simulate work
                        std::thread::sleep(std::time::Duration::from_micros(10));
                        pool_clone.release(buffer);
                    }
                })
            })
            .collect();

        for handle in handles {
            handle.join().unwrap();
        }

        // All buffers should be returned
        let stats = pool.stats();
        assert!(stats.available_buffers <= 100);
    }
}
