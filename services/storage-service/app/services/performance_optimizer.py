"""
Performance Optimization Service

Provides comprehensive performance monitoring, caching, and optimization
capabilities for the Edge Cloud Storage platform.

Features:
- Query performance monitoring
- Redis-based query result caching
- Database index recommendations
- Slow query detection and alerting
- Performance metrics collection
"""

import hashlib
import json
import time
from datetime import datetime, timedelta
from functools import wraps
from typing import Any, Callable, Dict, List, Optional, Tuple
from uuid import UUID

import redis.asyncio as redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings


class QueryPerformanceMonitor:
    """Monitor database query performance and detect slow queries."""

    def __init__(self):
        self.slow_queries: List[Dict] = []
        self.query_stats: Dict[str, Dict] = {}
        self.slow_query_threshold_ms = 100  # 100ms threshold

    async def log_query(
        self,
        query: str,
        duration_ms: float,
        params: Optional[Dict] = None,
        user_id: Optional[UUID] = None,
    ):
        """Log query execution and detect slow queries."""

        # Normalize query for grouping (remove parameter values)
        normalized_query = self._normalize_query(query)

        # Update query statistics
        if normalized_query not in self.query_stats:
            self.query_stats[normalized_query] = {
                "count": 0,
                "total_duration_ms": 0,
                "min_duration_ms": float("inf"),
                "max_duration_ms": 0,
                "avg_duration_ms": 0,
            }

        stats = self.query_stats[normalized_query]
        stats["count"] += 1
        stats["total_duration_ms"] += duration_ms
        stats["min_duration_ms"] = min(stats["min_duration_ms"], duration_ms)
        stats["max_duration_ms"] = max(stats["max_duration_ms"], duration_ms)
        stats["avg_duration_ms"] = stats["total_duration_ms"] / stats["count"]

        # Detect slow queries
        if duration_ms > self.slow_query_threshold_ms:
            slow_query_entry = {
                "query": query,
                "normalized_query": normalized_query,
                "duration_ms": duration_ms,
                "timestamp": datetime.utcnow().isoformat(),
                "params": params,
                "user_id": str(user_id) if user_id else None,
            }
            self.slow_queries.append(slow_query_entry)

            # Keep only last 1000 slow queries
            if len(self.slow_queries) > 1000:
                self.slow_queries = self.slow_queries[-1000:]

    def _normalize_query(self, query: str) -> str:
        """Normalize query by removing parameter values for grouping."""
        # Simple normalization: replace common patterns
        import re

        normalized = re.sub(r"= '[^']*'", "= ?", query)
        normalized = re.sub(r"= \d+", "= ?", normalized)
        normalized = re.sub(r"IN \([^)]+\)", "IN (?)", normalized)
        return normalized

    def get_slow_queries(self, limit: int = 100) -> List[Dict]:
        """Get recent slow queries."""
        return self.slow_queries[-limit:]

    def get_query_stats(self, top_n: int = 50) -> List[Dict]:
        """Get top N queries by total execution time."""
        stats_list = [{"query": query, **stats} for query, stats in self.query_stats.items()]

        # Sort by total duration (descending)
        stats_list.sort(key=lambda x: x["total_duration_ms"], reverse=True)
        return stats_list[:top_n]

    def reset_stats(self):
        """Reset all query statistics."""
        self.slow_queries.clear()
        self.query_stats.clear()


class QueryCache:
    """Redis-based query result caching."""

    def __init__(self):
        self.redis_client: Optional[redis.Redis] = None
        self.default_ttl = 300  # 5 minutes default TTL

    async def connect(self):
        """Connect to Redis."""
        if not self.redis_client:
            self.redis_client = await redis.from_url(
                settings.REDIS_URL, encoding="utf-8", decode_responses=False
            )

    async def disconnect(self):
        """Disconnect from Redis."""
        if self.redis_client:
            await self.redis_client.close()
            self.redis_client = None

    async def get(self, key: str) -> Optional[Any]:
        """Get cached value."""
        await self.connect()
        try:
            value = await self.redis_client.get(key)
            if value:
                return json.loads(value)
            return None
        except Exception as e:
            print(f"Cache get error: {e}")
            return None

    async def set(self, key: str, value: Any, ttl: Optional[int] = None):
        """Set cached value with TTL."""
        await self.connect()
        try:
            ttl = ttl or self.default_ttl
            serialized = json.dumps(value, default=str)
            await self.redis_client.setex(key, ttl, serialized)
        except Exception as e:
            print(f"Cache set error: {e}")

    async def delete(self, key: str):
        """Delete cached value."""
        await self.connect()
        try:
            await self.redis_client.delete(key)
        except Exception as e:
            print(f"Cache delete error: {e}")

    async def delete_pattern(self, pattern: str):
        """Delete all keys matching pattern."""
        await self.connect()
        try:
            cursor = 0
            while True:
                cursor, keys = await self.redis_client.scan(cursor=cursor, match=pattern, count=100)
                if keys:
                    await self.redis_client.delete(*keys)
                if cursor == 0:
                    break
        except Exception as e:
            print(f"Cache delete pattern error: {e}")

    async def get_stats(self) -> Dict:
        """Get cache statistics."""
        await self.connect()
        try:
            info = await self.redis_client.info("stats")
            return {
                "total_commands_processed": info.get("total_commands_processed", 0),
                "keyspace_hits": info.get("keyspace_hits", 0),
                "keyspace_misses": info.get("keyspace_misses", 0),
                "hit_rate": self._calculate_hit_rate(
                    info.get("keyspace_hits", 0), info.get("keyspace_misses", 0)
                ),
                "connected_clients": info.get("connected_clients", 0),
                "used_memory_human": (await self.redis_client.info("memory")).get(
                    "used_memory_human", "0"
                ),
            }
        except Exception as e:
            print(f"Cache stats error: {e}")
            return {}

    def _calculate_hit_rate(self, hits: int, misses: int) -> float:
        """Calculate cache hit rate percentage."""
        total = hits + misses
        if total == 0:
            return 0.0
        return (hits / total) * 100

    def _generate_cache_key(self, prefix: str, *args, **kwargs) -> str:
        """Generate cache key from function arguments."""
        # Create a stable hash from arguments
        arg_str = json.dumps(
            {
                "args": [str(arg) for arg in args],
                "kwargs": {k: str(v) for k, v in sorted(kwargs.items())},
            },
            sort_keys=True,
        )

        arg_hash = hashlib.md5(arg_str.encode()).hexdigest()[:16]
        return f"query_cache:{prefix}:{arg_hash}"


# Global instances
query_monitor = QueryPerformanceMonitor()
query_cache = QueryCache()


def monitor_query(func: Callable) -> Callable:
    """Decorator to monitor query performance."""

    @wraps(func)
    async def wrapper(*args, **kwargs):
        start_time = time.time()
        result = await func(*args, **kwargs)
        duration_ms = (time.time() - start_time) * 1000

        # Log query performance
        await query_monitor.log_query(
            query=func.__name__,
            duration_ms=duration_ms,
            params={"args": len(args), "kwargs": list(kwargs.keys())},
        )

        return result

    return wrapper


def cached_query(prefix: str, ttl: Optional[int] = None):
    """Decorator to cache query results."""

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        async def wrapper(*args, **kwargs):
            # Generate cache key
            cache_key = query_cache._generate_cache_key(prefix, *args, **kwargs)

            # Try to get from cache
            cached_result = await query_cache.get(cache_key)
            if cached_result is not None:
                return cached_result

            # Execute query
            result = await func(*args, **kwargs)

            # Cache result
            await query_cache.set(cache_key, result, ttl)

            return result

        return wrapper

    return decorator


class IndexRecommender:
    """Analyze queries and recommend database indexes."""

    async def get_missing_indexes(self, db: AsyncSession) -> List[Dict]:
        """Analyze database and recommend missing indexes."""

        recommendations = []

        # Check files table
        files_indexes = await self._check_table_indexes(db, "files")
        recommendations.extend(files_indexes)

        # Check folders table
        folders_indexes = await self._check_table_indexes(db, "folders")
        recommendations.extend(folders_indexes)

        # Check users table
        users_indexes = await self._check_table_indexes(db, "users")
        recommendations.extend(users_indexes)

        # Check audit_logs table
        audit_indexes = await self._check_table_indexes(db, "audit_logs")
        recommendations.extend(audit_indexes)

        return recommendations

    async def _check_table_indexes(self, db: AsyncSession, table_name: str) -> List[Dict]:
        """Check for missing indexes on a specific table."""

        recommendations = []

        # Get existing indexes
        result = await db.execute(text(f"""
            SELECT indexname, indexdef
            FROM pg_indexes
            WHERE tablename = '{table_name}'
        """))
        existing_indexes = {row[0]: row[1] for row in result}

        # Define recommended indexes per table
        recommended_indexes = self._get_recommended_indexes(table_name)

        for index_name, index_def in recommended_indexes.items():
            if index_name not in existing_indexes:
                recommendations.append(
                    {
                        "table": table_name,
                        "index_name": index_name,
                        "index_definition": index_def,
                        "reason": self._get_index_reason(table_name, index_name),
                    }
                )

        return recommendations

    def _get_recommended_indexes(self, table_name: str) -> Dict[str, str]:
        """Get recommended indexes for a table."""

        indexes = {
            "files": {
                "idx_files_owner_deleted": "CREATE INDEX idx_files_owner_deleted ON files(owner_id) WHERE deleted_at IS NULL",
                "idx_files_folder_deleted": "CREATE INDEX idx_files_folder_deleted ON files(folder_id) WHERE deleted_at IS NULL",
                "idx_files_created_at": "CREATE INDEX idx_files_created_at ON files(created_at DESC)",
                "idx_files_size": "CREATE INDEX idx_files_size ON files(size)",
                "idx_files_file_type": "CREATE INDEX idx_files_file_type ON files(file_type)",
                "idx_files_name_trgm": "CREATE INDEX idx_files_name_trgm ON files USING gin(name gin_trgm_ops)",
            },
            "folders": {
                "idx_folders_owner_deleted": "CREATE INDEX idx_folders_owner_deleted ON folders(owner_id) WHERE deleted_at IS NULL",
                "idx_folders_parent_deleted": "CREATE INDEX idx_folders_parent_deleted ON folders(parent_id) WHERE deleted_at IS NULL",
                "idx_folders_path": "CREATE INDEX idx_folders_path ON folders(path)",
                "idx_folders_name_trgm": "CREATE INDEX idx_folders_name_trgm ON folders USING gin(name gin_trgm_ops)",
            },
            "users": {
                "idx_users_email_lower": "CREATE INDEX idx_users_email_lower ON users(LOWER(email))",
                "idx_users_created_at": "CREATE INDEX idx_users_created_at ON users(created_at DESC)",
            },
            "audit_logs": {
                "idx_audit_user_timestamp": "CREATE INDEX idx_audit_user_timestamp ON audit_logs(user_id, timestamp DESC)",
                "idx_audit_event_type": "CREATE INDEX idx_audit_event_type ON audit_logs(event_type)",
                "idx_audit_timestamp": "CREATE INDEX idx_audit_timestamp ON audit_logs(timestamp DESC)",
                "idx_audit_resource": "CREATE INDEX idx_audit_resource ON audit_logs(resource_type, resource_id)",
            },
            "share_links": {
                "idx_share_links_token": "CREATE UNIQUE INDEX idx_share_links_token ON share_links(token)",
                "idx_share_links_file_id": "CREATE INDEX idx_share_links_file_id ON share_links(file_id)",
            },
        }

        return indexes.get(table_name, {})

    def _get_index_reason(self, table_name: str, index_name: str) -> str:
        """Get the reason for recommending an index."""

        reasons = {
            "idx_files_owner_deleted": "Optimize queries filtering by owner and non-deleted files",
            "idx_files_folder_deleted": "Optimize queries filtering by folder and non-deleted files",
            "idx_files_created_at": "Optimize sorting by creation date",
            "idx_files_size": "Optimize sorting/filtering by file size",
            "idx_files_file_type": "Optimize filtering by file type",
            "idx_files_name_trgm": "Enable fast full-text search on file names",
            "idx_folders_owner_deleted": "Optimize queries filtering by owner and non-deleted folders",
            "idx_folders_parent_deleted": "Optimize queries filtering by parent and non-deleted folders",
            "idx_folders_path": "Optimize path-based lookups",
            "idx_folders_name_trgm": "Enable fast full-text search on folder names",
            "idx_users_email_lower": "Optimize case-insensitive email lookups",
            "idx_users_created_at": "Optimize sorting by user creation date",
            "idx_audit_user_timestamp": "Optimize user activity queries",
            "idx_audit_event_type": "Optimize filtering by event type",
            "idx_audit_timestamp": "Optimize time-based queries",
            "idx_audit_resource": "Optimize resource-specific audit queries",
            "idx_share_links_token": "Fast token-based share link lookups",
            "idx_share_links_file_id": "Optimize file-based share link queries",
        }

        return reasons.get(index_name, "Improve query performance")


class PerformanceOptimizer:
    """Main performance optimization service."""

    def __init__(self):
        self.query_monitor = query_monitor
        self.query_cache = query_cache
        self.index_recommender = IndexRecommender()

    async def get_performance_report(self, db: AsyncSession) -> Dict:
        """Generate comprehensive performance report."""

        # Get query statistics
        query_stats = self.query_monitor.get_query_stats(top_n=20)
        slow_queries = self.query_monitor.get_slow_queries(limit=50)

        # Get cache statistics
        cache_stats = await self.query_cache.get_stats()

        # Get index recommendations
        index_recommendations = await self.index_recommender.get_missing_indexes(db)

        # Get database statistics
        db_stats = await self._get_database_stats(db)

        return {
            "generated_at": datetime.utcnow().isoformat(),
            "summary": {
                "total_queries_monitored": sum(s["count"] for s in query_stats),
                "slow_queries_detected": len(slow_queries),
                "cache_hit_rate": cache_stats.get("hit_rate", 0),
                "missing_indexes": len(index_recommendations),
                "database_size": db_stats.get("database_size", "unknown"),
            },
            "top_queries": query_stats,
            "slow_queries": slow_queries,
            "cache_stats": cache_stats,
            "index_recommendations": index_recommendations,
            "database_stats": db_stats,
        }

    async def _get_database_stats(self, db: AsyncSession) -> Dict:
        """Get database statistics."""

        try:
            # Database size
            result = await db.execute(text("""
                SELECT pg_size_pretty(pg_database_size(current_database())) as size
            """))
            db_size = result.scalar()

            # Table sizes
            result = await db.execute(text("""
                SELECT
                    schemaname,
                    tablename,
                    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size,
                    pg_total_relation_size(schemaname||'.'||tablename) AS bytes
                FROM pg_tables
                WHERE schemaname = 'public'
                ORDER BY bytes DESC
                LIMIT 10
            """))
            tables = [
                {"schema": row[0], "table": row[1], "size": row[2], "bytes": row[3]}
                for row in result
            ]

            # Connection count
            result = await db.execute(text("""
                SELECT count(*) FROM pg_stat_activity
            """))
            connection_count = result.scalar()

            return {
                "database_size": db_size,
                "largest_tables": tables,
                "active_connections": connection_count,
            }
        except Exception as e:
            print(f"Error getting database stats: {e}")
            return {}

    async def create_recommended_indexes(self, db: AsyncSession, execute: bool = False) -> Dict:
        """Create recommended indexes."""

        recommendations = await self.index_recommender.get_missing_indexes(db)

        results = {
            "total_recommendations": len(recommendations),
            "created": [],
            "failed": [],
            "skipped": [],
        }

        if not execute:
            results["skipped"] = recommendations
            results["message"] = "Dry run - set execute=True to create indexes"
            return results

        # Enable pg_trgm extension for trigram indexes
        try:
            await db.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
            await db.commit()
        except Exception as e:
            print(f"Warning: Could not create pg_trgm extension: {e}")

        for recommendation in recommendations:
            try:
                await db.execute(text(recommendation["index_definition"]))
                await db.commit()
                results["created"].append(recommendation)
            except Exception as e:
                await db.rollback()
                results["failed"].append({**recommendation, "error": str(e)})

        return results

    async def clear_cache(self, pattern: str = "*") -> Dict:
        """Clear cache entries matching pattern."""

        try:
            await self.query_cache.delete_pattern(f"query_cache:{pattern}")
            return {
                "success": True,
                "pattern": pattern,
                "message": f"Cleared cache entries matching: {pattern}",
            }
        except Exception as e:
            return {"success": False, "pattern": pattern, "error": str(e)}

    def reset_query_stats(self):
        """Reset query performance statistics."""
        self.query_monitor.reset_stats()
        return {"success": True, "message": "Query statistics reset"}


# Global performance optimizer instance
performance_optimizer = PerformanceOptimizer()
