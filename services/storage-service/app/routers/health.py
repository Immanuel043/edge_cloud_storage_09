# services/storage-service/app/routers/health.py

"""
Enhanced Health Check and Database Monitoring Endpoint

Provides detailed health information about database connections,
query performance, and system resources.
"""

import os
import time
from datetime import datetime
from typing import Any, Dict

import psutil
from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import engine, get_db, get_redis
from ..middleware.db_performance import (
    get_all_endpoint_stats,
    get_query_stats,
    get_slow_queries,
)

router = APIRouter(prefix="/api/v1/health", tags=["health"])


@router.get("/db")
async def database_health(db: AsyncSession = Depends(get_db)) -> Dict[str, Any]:
    """
    Comprehensive database health check

    Returns:
        - Connection pool status
        - Database connectivity
        - Query performance metrics
        - Database size and table statistics
    """
    start_time = time.time()

    try:
        # Test database connectivity
        result = await db.execute(text("SELECT 1"))
        db_connected = result.scalar() == 1

        # Get connection pool stats
        pool = engine.pool
        pool_status = {
            "size": pool.size(),
            "checked_in": pool.checkedin(),
            "checked_out": pool.checkedout(),
            "overflow": pool.overflow(),
            "total_connections": pool.size() + pool.overflow(),
            "utilization_percent": (
                round((pool.checkedout() / (pool.size() + pool.overflow())) * 100, 2)
                if (pool.size() + pool.overflow()) > 0
                else 0
            ),
        }

        # Get database statistics
        db_stats_result = await db.execute(text("""
            SELECT
                pg_database_size(current_database()) as db_size,
                (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) as active_connections,
                (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active') as active_queries
        """))
        db_stats = db_stats_result.first()

        # Get table sizes
        table_sizes_result = await db.execute(text("""
            SELECT
                schemaname,
                tablename,
                pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size,
                pg_total_relation_size(schemaname||'.'||tablename) AS size_bytes
            FROM pg_tables
            WHERE schemaname = 'public'
            ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
            LIMIT 10
        """))
        table_sizes = [
            {
                "schema": row.schemaname,
                "table": row.tablename,
                "size": row.size,
                "size_bytes": row.size_bytes,
            }
            for row in table_sizes_result.fetchall()
        ]

        # Get query performance stats
        query_performance = get_query_stats()

        response_time = time.time() - start_time

        return {
            "status": "healthy" if db_connected else "unhealthy",
            "timestamp": datetime.utcnow().isoformat(),
            "response_time": f"{response_time:.3f}s",
            "database": {
                "connected": db_connected,
                "size_bytes": db_stats.db_size if db_stats else 0,
                "size_human": format_bytes(db_stats.db_size if db_stats else 0),
                "active_connections": db_stats.active_connections if db_stats else 0,
                "active_queries": db_stats.active_queries if db_stats else 0,
            },
            "connection_pool": pool_status,
            "top_tables": table_sizes,
            "query_performance": query_performance,
        }

    except Exception as e:
        return {
            "status": "unhealthy",
            "timestamp": datetime.utcnow().isoformat(),
            "error": str(e),
            "connection_pool": {
                "size": pool.size(),
                "checked_in": pool.checkedin(),
                "checked_out": pool.checkedout(),
            },
        }


@router.get("/db/slow-queries")
async def get_slow_query_log(limit: int = 50) -> Dict[str, Any]:
    """
    Get recent slow queries

    Args:
        limit: Number of slow queries to return (default 50, max 100)

    Returns:
        List of slow queries with timing information
    """
    limit = min(limit, 100)
    slow_queries = get_slow_queries(limit)

    return {
        "count": len(slow_queries),
        "queries": slow_queries,
        "threshold": "1.0s",
    }


@router.get("/db/stats")
async def get_database_stats(db: AsyncSession = Depends(get_db)) -> Dict[str, Any]:
    """
    Get detailed database statistics

    Returns:
        - Table row counts
        - Index usage statistics
        - Cache hit ratios
        - Transaction statistics
    """
    try:
        # Get table row counts
        table_counts_result = await db.execute(text("""
            SELECT
                schemaname,
                tablename,
                n_live_tup as row_count,
                n_dead_tup as dead_rows,
                last_vacuum,
                last_autovacuum,
                last_analyze,
                last_autoanalyze
            FROM pg_stat_user_tables
            WHERE schemaname = 'public'
            ORDER BY n_live_tup DESC
        """))
        table_counts = [
            {
                "schema": row.schemaname,
                "table": row.tablename,
                "row_count": row.row_count,
                "dead_rows": row.dead_rows,
                "last_vacuum": row.last_vacuum.isoformat() if row.last_vacuum else None,
                "last_analyze": row.last_analyze.isoformat() if row.last_analyze else None,
            }
            for row in table_counts_result.fetchall()
        ]

        # Get index usage
        index_usage_result = await db.execute(text("""
            SELECT
                schemaname,
                tablename,
                indexname,
                idx_scan as scans,
                idx_tup_read as tuples_read,
                idx_tup_fetch as tuples_fetched
            FROM pg_stat_user_indexes
            WHERE schemaname = 'public'
            ORDER BY idx_scan DESC
            LIMIT 20
        """))
        index_usage = [
            {
                "schema": row.schemaname,
                "table": row.tablename,
                "index": row.indexname,
                "scans": row.scans,
                "tuples_read": row.tuples_read,
                "tuples_fetched": row.tuples_fetched,
            }
            for row in index_usage_result.fetchall()
        ]

        # Get cache hit ratio
        cache_hit_result = await db.execute(text("""
            SELECT
                sum(heap_blks_read) as heap_read,
                sum(heap_blks_hit) as heap_hit,
                sum(heap_blks_hit) / NULLIF(sum(heap_blks_hit) + sum(heap_blks_read), 0) * 100 as cache_hit_ratio
            FROM pg_statio_user_tables
        """))
        cache_hit = cache_hit_result.first()

        return {
            "tables": table_counts,
            "top_indexes": index_usage,
            "cache_hit_ratio": (
                round(cache_hit.cache_hit_ratio, 2)
                if cache_hit and cache_hit.cache_hit_ratio
                else 0
            ),
            "query_performance": get_all_endpoint_stats(),
        }

    except Exception as e:
        return {"error": str(e), "status": "failed to retrieve stats"}


@router.get("/system")
async def system_health() -> Dict[str, Any]:
    """
    Get system resource usage

    Returns:
        - CPU usage
        - Memory usage
        - Disk usage
        - Process information
    """
    try:
        # CPU usage
        cpu_percent = psutil.cpu_percent(interval=0.1)
        cpu_count = psutil.cpu_count()

        # Memory usage
        memory = psutil.virtual_memory()

        # Disk usage
        disk = psutil.disk_usage("/app/storage" if os.path.exists("/app/storage") else "/")

        # Process info
        process = psutil.Process(os.getpid())
        process_memory = process.memory_info()

        return {
            "status": "healthy",
            "timestamp": datetime.utcnow().isoformat(),
            "cpu": {
                "percent": cpu_percent,
                "count": cpu_count,
            },
            "memory": {
                "total": format_bytes(memory.total),
                "available": format_bytes(memory.available),
                "used": format_bytes(memory.used),
                "percent": memory.percent,
            },
            "disk": {
                "total": format_bytes(disk.total),
                "used": format_bytes(disk.used),
                "free": format_bytes(disk.free),
                "percent": disk.percent,
            },
            "process": {
                "memory_rss": format_bytes(process_memory.rss),
                "memory_vms": format_bytes(process_memory.vms),
                "threads": process.num_threads(),
                "fds": process.num_fds() if hasattr(process, "num_fds") else None,
            },
        }

    except Exception as e:
        return {"status": "error", "error": str(e)}


@router.get("/redis")
async def redis_health() -> Dict[str, Any]:
    """
    Check Redis connectivity and stats

    Returns:
        - Connection status
        - Memory usage
        - Key count
        - Performance metrics
    """
    try:
        redis_client = await get_redis()

        if not redis_client:
            return {"status": "unavailable", "error": "Redis client not initialized"}

        start_time = time.time()

        # Test connectivity
        pong = await redis_client.ping()
        response_time = time.time() - start_time

        # Get Redis info
        info = await redis_client.info()

        return {
            "status": "healthy" if pong else "unhealthy",
            "timestamp": datetime.utcnow().isoformat(),
            "response_time": f"{response_time:.3f}s",
            "version": info.get("redis_version"),
            "uptime_seconds": info.get("uptime_in_seconds"),
            "connected_clients": info.get("connected_clients"),
            "used_memory": format_bytes(info.get("used_memory", 0)),
            "used_memory_peak": format_bytes(info.get("used_memory_peak", 0)),
            "total_commands_processed": info.get("total_commands_processed"),
            "keyspace": info.get("db0"),
        }

    except Exception as e:
        return {"status": "unhealthy", "error": str(e)}


def format_bytes(bytes_value: int) -> str:
    """Format bytes to human readable format"""
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if bytes_value < 1024.0:
            return f"{bytes_value:.2f} {unit}"
        bytes_value /= 1024.0
    return f"{bytes_value:.2f} PB"
