/**
 * Request Deduplication Cache
 * Prevents duplicate simultaneous requests to the same endpoint
 */

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

interface DedupeOptions {
  ttl?: number;
  useCache?: boolean;
}

interface CacheSize {
  cache: number;
  pending: number;
}

class RequestCache {
  private pendingRequests: Map<string, Promise<unknown>>;
  private cache: Map<string, CacheEntry<unknown>>;
  private cacheTTL: number;

  constructor() {
    this.pendingRequests = new Map();
    this.cache = new Map();
    this.cacheTTL = 5000; // 5 seconds default TTL
  }

  /**
   * Deduplicate requests - if same request is already in flight, return existing promise
   */
  async dedupe<T>(
    key: string,
    requestFn: () => Promise<T>,
    options: DedupeOptions = {}
  ): Promise<T> {
    const { ttl = this.cacheTTL, useCache = false } = options;

    // Check cache first if enabled
    if (useCache) {
      const cached = this.cache.get(key);
      if (cached && Date.now() - cached.timestamp < ttl) {
        console.log(`[Cache HIT] ${key}`);
        return cached.data as T;
      }
    }

    // Check if request already in flight
    if (this.pendingRequests.has(key)) {
      console.log(`[Dedup] Reusing existing request: ${key}`);
      return this.pendingRequests.get(key) as Promise<T>;
    }

    // Create new request
    const promise = requestFn()
      .then((data) => {
        // Store in cache if enabled
        if (useCache) {
          this.cache.set(key, {
            data,
            timestamp: Date.now(),
          });
        }
        return data;
      })
      .finally(() => {
        // Remove from pending
        this.pendingRequests.delete(key);
      });

    this.pendingRequests.set(key, promise);
    return promise;
  }

  /**
   * Invalidate cache for a specific key or pattern
   */
  invalidate(keyOrPattern: string | RegExp): void {
    if (typeof keyOrPattern === 'string') {
      this.cache.delete(keyOrPattern);
    } else if (keyOrPattern instanceof RegExp) {
      // Invalidate all keys matching pattern
      for (const key of this.cache.keys()) {
        if (keyOrPattern.test(key)) {
          this.cache.delete(key);
        }
      }
    }
  }

  /**
   * Clear all cache and pending requests
   */
  clear(): void {
    this.cache.clear();
    this.pendingRequests.clear();
  }

  /**
   * Get cache size
   */
  size(): CacheSize {
    return {
      cache: this.cache.size,
      pending: this.pendingRequests.size,
    };
  }
}

export const requestCache = new RequestCache();
export default requestCache;
