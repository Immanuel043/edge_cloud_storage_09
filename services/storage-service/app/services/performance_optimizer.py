# services/storage-service/app/services/performance_optimizer.py

"""
Performance Optimization Service

Provides tools for database query optimization, caching, and performance monitoring.

Features:
- Query performance analysis
- Automatic index recommendations
- Slow query detection
- Query result caching
- Performance metrics collection
"""

import logging
import time
import asyncio
from typing import Optional, Dict, List, Any, Callable
from datetime import datetime, timedelta
from functools import wraps
import hashlib
import json

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text, select
from sqlalchemy.engine import Row

from ..database import get_redis

logger = logging.getLogger(__name__)


class QueryPerformanceMonitor:
    """Monitor database query performance"""

    def __init__(self):
        self.slow_queries = []
        self.query_stats = {}

    async def log_query(self, query: str, duration_ms: float, params: Optional[Dict] = None):
        """Log a query execution"""
        query_hash = hashlib.md5(query.encode()).hexdigest()[:12]

        # Update statistics
        if query_hash not in self.query_stats:
            self.query_stats[query_hash] = {
                "query": query[:200],  # First 200 chars
                "count": 0,
                "total_time": 0,
                "min_time": float('inf'),
                "max_time": 0,
                "avg_time": 0
            }

        stats = self.query_stats[query_hash]
        stats["count"] += 1
        stats["total_time"] += duration_ms
        stats["min_time"] = min(stats["min_time"], duration_ms)
        stats["max_time"] = max(stats["max_time"], duration_ms)
        stats["avg_time"] = stats["total_time"] / stats["count"]

        # Log slow queries
        if duration_ms > 100:  # Slower than 100ms
            self.slow_queries.append({
                "query": query,
                "duration_ms": duration_ms,
                "timestamp": datetime.utcnow().isoformat(),
                "params": params
            })

            logger.warning(
                f"Slow query detected ({duration_ms:.2f}ms): {query[:100]}..."
            )

    def get_slow_queries(self, limit: int = 20) -> List[Dict]:
        """Get slowest queries"""
        return sorted(
            self.slow_queries,
            key=lambda x: x["duration_ms"],
            reverse=True
        )[:limit]

    def get_query_statistics(self) -> Dict:
        """Get overall query statistics"""
        if not self.query_stats:
            return {}

        sorted_stats = sorted(
            self.query_stats.values(),
            key=lambda x: x["total_time"],
            reverse=True
        )

        return {
            "total_queries": sum(s["count"] for s in self.query_stats.values()),
            "unique_queries": len(self.query_stats),
            "total_time_ms": sum(s["total_time"] for s in self.query_stats.values()),
            "slowest_queries": sorted_stats[:10]
        }


# Global monitor instance
query_monitor = QueryPerformanceMonitor()


def monitor_query(func):
    """Decorator to monitor query performance"""
    @wraps(func)
    async def wrapper(*args, **kwargs):
        start_time = time.time()
        try:
            result = await func(*args, **kwargs)
            duration_ms = (time.time() - start_time) * 1000

            # Try to extract query from args/kwargs
            query = "unknown"
            if len(args) > 1 and hasattr(args[1], 'statement'):
                query = str(args[1].statement)

            await query_monitor.log_query(query, duration_ms)

            return result
        except Exception as e:
            duration_ms = (time.time() - start_time) * 1000
            logger.error(f"Query failed after {duration_ms:.2f}ms: {e}")
            raise
    return wrapper


class QueryCache:
    """
    Query result caching with Redis

    Caches database query results to reduce database load.
    """

    def __init__(self, default_ttl: int = 300):
        """
        Initialize query cache

        Args:
            default_ttl: Default TTL in seconds (5 minutes)
        """
        self.default_ttl = default_ttl
        self.cache_hits = 0
        self.cache_misses = 0

    def _generate_cache_key(self, prefix: str, *args, **kwargs) -> str:
        """Generate cache key from function arguments"""
        # Create deterministic string from args/kwargs
        key_data = {
            "prefix": prefix,
            "args": str(args),
            "kwargs": sorted(kwargs.items())
        }
        key_string = json.dumps(key_data, sort_keys=True)
        key_hash = hashlib.md5(key_string.encode()).hexdigest()

        return f"qcache:{prefix}:{key_hash}"

    async def get(self, key: str) -> Optional[Any]:
        """Get cached value"""
        redis = await get_redis()
        try:
            value = await redis.get(key)
            if value:
                self.cache_hits += 1
                return json.loads(value)
            else:
                self.cache_misses += 1
                return None
        except Exception as e:
            logger.error(f"Cache get error: {e}")
            return None

    async def set(self, key: str, value: Any, ttl: Optional[int] = None):
        """Set cached value"""
        redis = await get_redis()
        try:
            ttl = ttl or self.default_ttl
            await redis.setex(
                key,
                ttl,
                json.dumps(value, default=str)  # default=str for datetime, UUID, etc.
            )
        except Exception as e:
            logger.error(f"Cache set error: {e}")

    async def delete(self, key: str):
        """Delete cached value"""
        redis = await get_redis()
        try:
            await redis.delete(key)
        except Exception as e:
            logger.error(f"Cache delete error: {e}")

    async def invalidate_pattern(self, pattern: str):
        """Invalidate all keys matching pattern"""
        redis = await get_redis()
        try:
            keys = await redis.keys(pattern)
            if keys:
                await redis.delete(*keys)
                logger.info(f"Invalidated {len(keys)} cache keys matching {pattern}")
        except Exception as e:
            logger.error(f"Cache invalidate error: {e}")

    def get_cache_stats(self) -> Dict:
        """Get cache statistics"""
        total = self.cache_hits + self.cache_misses
        hit_rate = (self.cache_hits / total * 100) if total > 0 else 0

        return {
            "cache_hits": self.cache_hits,
            "cache_misses": self.cache_misses,
            "total_requests": total,
            "hit_rate_percent": round(hit_rate, 2)
        }


# Global cache instance
query_cache = QueryCache()


def cached_query(prefix: str, ttl: Optional[int] = None):
    """
    Decorator to cache query results

    Args:
        prefix: Cache key prefix
        ttl: Time to live in seconds

    Example:
        @cached_query("user_files", ttl=300)
        async def get_user_files(db, user_id):
            ...
    """
    def decorator(func: Callable):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            # Generate cache key
            cache_key = query_cache._generate_cache_key(prefix, *args, **kwargs)

            # Try to get from cache
            cached_result = await query_cache.get(cache_key)
            if cached_result is not None:
                logger.debug(f"Cache HIT: {cache_key}")
                return cached_result

            # Cache miss - execute query
            logger.debug(f"Cache MISS: {cache_key}")
            result = await func(*args, **kwargs)

            # Store in cache
            await query_cache.set(cache_key, result, ttl)

            return result
        return wrapper
    return decorator


class IndexRecommender:
    """Analyze queries and recommend indexes"""

    def __init__(self):
        self.analyzed_queries = []

    async def analyze_query(self, db: AsyncSession, query: str) -> Dict:
        """
        Analyze a query and check if it needs indexes

        Returns query execution plan and recommendations
        """
        try:
            # Get query execution plan
            explain_query = f"EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {query}"
            result = await db.execute(text(explain_query))
            plan = result.scalar()

            # Parse plan to find sequential scans
            recommendations = []

            if "Seq Scan" in str(plan):
                recommendations.append({
                    "type": "index",
                    "reason": "Sequential scan detected - consider adding index",
                    "query": query[:200]
                })

            return {
                "query": query,
                "execution_plan": plan,
                "recommendations": recommendations
            }

        except Exception as e:
            logger.error(f"Query analysis failed: {e}")
            return {
                "query": query,
                "error": str(e)
            }

    async def get_missing_indexes(self, db: AsyncSession) -> List[str]:
        """
        Analyze database and suggest missing indexes

        Returns list of CREATE INDEX statements
        """
        recommendations = []

        # Common patterns that need indexes
        index_suggestions = [
            # User-related queries
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_objects_user_created ON objects(user_id, created_at DESC)",
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_objects_user_size ON objects(user_id, file_size DESC)",

            # File search
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_objects_filename_trgm ON objects USING gin(file_name gin_trgm_ops)",
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_objects_mime_type ON objects(mime_type)",

            # Activity logs
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_user_time ON activity_logs(user_id, timestamp DESC)",
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_action_time ON activity_logs(action, timestamp DESC)",

            # Audit logs
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_user_category ON audit_logs(user_id, event_category, timestamp DESC)",
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_resource ON audit_logs(resource_type, resource_id, timestamp DESC)",

            # Favorites
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_favorites_user_created ON favorites(user_id, created_at DESC)",

            # Share links
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_share_links_token ON share_links(share_token)",
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_share_links_expires ON share_links(expires_at) WHERE expires_at IS NOT NULL"
        ]

        # Check which indexes already exist
        existing_indexes_query = """
            SELECT indexname
            FROM pg_indexes
            WHERE schemaname = 'public'
        """

        result = await db.execute(text(existing_indexes_query))
        existing_indexes = {row[0] for row in result.fetchall()}

        # Filter out existing indexes
        for suggestion in index_suggestions:
            index_name = suggestion.split("IF NOT EXISTS")[1].split("ON")[0].strip()
            if index_name not in existing_indexes:
                recommendations.append(suggestion)

        return recommendations


class PerformanceOptimizer:
    """
    Main performance optimization service

    Combines query monitoring, caching, and index recommendations.
    """

    def __init__(self):
        self.query_monitor = query_monitor
        self.query_cache = query_cache
        self.index_recommender = IndexRecommender()

    async def get_performance_report(self, db: AsyncSession) -> Dict:
        """Generate comprehensive performance report"""
        # Query statistics
        query_stats = self.query_monitor.get_query_statistics()

        # Cache statistics
        cache_stats = self.query_cache.get_cache_stats()

        # Index recommendations
        index_recommendations = await self.index_recommender.get_missing_indexes(db)

        # Slow queries
        slow_queries = self.query_monitor.get_slow_queries(limit=10)

        return {
            "timestamp": datetime.utcnow().isoformat(),
            "query_statistics": query_stats,
            "cache_statistics": cache_stats,
            "slow_queries": slow_queries,
            "index_recommendations": index_recommendations,
            "performance_summary": {
                "total_queries": query_stats.get("total_queries", 0),
                "cache_hit_rate": cache_stats["hit_rate_percent"],
                "slow_query_count": len(slow_queries),
                "recommended_indexes": len(index_recommendations)
            }
        }

    async def optimize_table(self, db: AsyncSession, table_name: str):
        """
        Optimize a specific table

        Runs VACUUM ANALYZE to update statistics and reclaim space
        """
        try:
            await db.execute(text(f"VACUUM ANALYZE {table_name}"))
            logger.info(f"Optimized table: {table_name}")
        except Exception as e:
            logger.error(f"Failed to optimize table {table_name}: {e}")

    async def create_recommended_indexes(
        self,
        db: AsyncSession,
        execute: bool = False
    ) -> Dict:
        """
        Create recommended indexes

        Args:
            db: Database session
            execute: If True, actually create indexes. If False, just return statements.

        Returns:
            Dict with index creation results
        """
        recommendations = await self.index_recommender.get_missing_indexes(db)

        if not execute:
            return {
                "mode": "dry_run",
                "index_count": len(recommendations),
                "statements": recommendations
            }

        # Execute index creation
        created = []
        failed = []

        for statement in recommendations:
            try:
                await db.execute(text(statement))
                await db.commit()
                created.append(statement)
                logger.info(f"Created index: {statement}")
            except Exception as e:
                failed.append({
                    "statement": statement,
                    "error": str(e)
                })
                logger.error(f"Failed to create index: {e}")

        return {
            "mode": "execute",
            "total_recommendations": len(recommendations),
            "created": len(created),
            "failed": len(failed),
            "created_statements": created,
            "failed_statements": failed
        }


# Global optimizer instance
performance_optimizer = PerformanceOptimizer()
