"""
Performance Monitoring and Optimization API

Provides endpoints for monitoring and optimizing system performance:
- Performance reports and metrics
- Slow query detection
- Cache statistics and management
- Database index recommendations
- Query performance statistics
"""

from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.auth import get_current_admin_user
from ..core.database import get_db
from ..models.database import User
from ..services.performance_optimizer import performance_optimizer
from ..utils.rate_limiter import RateLimitConfig, user_limiter

router = APIRouter(
    prefix="/api/v1/performance",
    tags=["performance"]
)


# Response Models

class PerformanceReportResponse(BaseModel):
    """Performance report response."""
    generated_at: str
    summary: Dict
    top_queries: List[Dict]
    slow_queries: List[Dict]
    cache_stats: Dict
    index_recommendations: List[Dict]
    database_stats: Dict


class CacheStatsResponse(BaseModel):
    """Cache statistics response."""
    total_commands_processed: int
    keyspace_hits: int
    keyspace_misses: int
    hit_rate: float
    connected_clients: int
    used_memory_human: str


class IndexRecommendationsResponse(BaseModel):
    """Index recommendations response."""
    total_recommendations: int
    recommendations: List[Dict]


class CreateIndexesRequest(BaseModel):
    """Create indexes request."""
    execute: bool = Field(
        default=False,
        description="Set to true to actually create indexes (default is dry run)"
    )


class CreateIndexesResponse(BaseModel):
    """Create indexes response."""
    total_recommendations: int
    created: List[Dict]
    failed: List[Dict]
    skipped: List[Dict]
    message: Optional[str] = None


class ClearCacheRequest(BaseModel):
    """Clear cache request."""
    pattern: str = Field(
        default="*",
        description="Pattern to match cache keys (e.g., 'files:*', 'user:123:*')"
    )


class ClearCacheResponse(BaseModel):
    """Clear cache response."""
    success: bool
    pattern: str
    message: Optional[str] = None
    error: Optional[str] = None


class QueryStatsResponse(BaseModel):
    """Query statistics response."""
    total_queries: int
    top_queries: List[Dict]


class SlowQueriesResponse(BaseModel):
    """Slow queries response."""
    total_slow_queries: int
    slow_queries: List[Dict]


class ResetStatsResponse(BaseModel):
    """Reset statistics response."""
    success: bool
    message: str


# Endpoints

@router.get("/report", response_model=PerformanceReportResponse)
@user_limiter.limit(RateLimitConfig.API_READ)
async def get_performance_report(
    request: Request,
    current_user: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get comprehensive performance report.

    **Admin only**

    Returns:
    - Query performance statistics
    - Slow query detection
    - Cache hit rates
    - Database index recommendations
    - Database statistics
    """

    report = await performance_optimizer.get_performance_report(db)
    return report


@router.get("/queries/stats", response_model=QueryStatsResponse)
@user_limiter.limit(RateLimitConfig.API_READ)
async def get_query_stats(
    request: Request,
    top_n: int = Query(50, ge=1, le=500, description="Number of top queries to return"),
    current_user: User = Depends(get_current_admin_user),
):
    """
    Get query performance statistics.

    **Admin only**

    Returns the top N queries by total execution time with statistics:
    - Total executions
    - Average, min, max duration
    - Total time spent
    """

    stats = performance_optimizer.query_monitor.get_query_stats(top_n=top_n)

    return {
        "total_queries": len(performance_optimizer.query_monitor.query_stats),
        "top_queries": stats
    }


@router.get("/queries/slow", response_model=SlowQueriesResponse)
@user_limiter.limit(RateLimitConfig.API_READ)
async def get_slow_queries(
    request: Request,
    limit: int = Query(100, ge=1, le=1000, description="Maximum number of slow queries to return"),
    current_user: User = Depends(get_current_admin_user),
):
    """
    Get detected slow queries.

    **Admin only**

    Returns queries that exceeded the performance threshold (>100ms).
    """

    slow_queries = performance_optimizer.query_monitor.get_slow_queries(limit=limit)

    return {
        "total_slow_queries": len(performance_optimizer.query_monitor.slow_queries),
        "slow_queries": slow_queries
    }


@router.post("/queries/reset", response_model=ResetStatsResponse)
@user_limiter.limit(RateLimitConfig.API_WRITE)
async def reset_query_stats(
    request: Request,
    current_user: User = Depends(get_current_admin_user),
):
    """
    Reset query performance statistics.

    **Admin only**

    Clears all collected query statistics and slow query logs.
    Useful for starting fresh measurements after optimizations.
    """

    result = performance_optimizer.reset_query_stats()
    return result


@router.get("/cache/stats", response_model=CacheStatsResponse)
@user_limiter.limit(RateLimitConfig.API_READ)
async def get_cache_stats(
    request: Request,
    current_user: User = Depends(get_current_admin_user),
):
    """
    Get cache statistics.

    **Admin only**

    Returns Redis cache performance metrics:
    - Cache hit/miss rates
    - Memory usage
    - Connected clients
    - Total commands processed
    """

    stats = await performance_optimizer.query_cache.get_stats()

    return {
        "total_commands_processed": stats.get("total_commands_processed", 0),
        "keyspace_hits": stats.get("keyspace_hits", 0),
        "keyspace_misses": stats.get("keyspace_misses", 0),
        "hit_rate": stats.get("hit_rate", 0.0),
        "connected_clients": stats.get("connected_clients", 0),
        "used_memory_human": stats.get("used_memory_human", "0"),
    }


@router.post("/cache/clear", response_model=ClearCacheResponse)
@user_limiter.limit(RateLimitConfig.API_WRITE)
async def clear_cache(
    request: Request,
    clear_request: ClearCacheRequest,
    current_user: User = Depends(get_current_admin_user),
):
    """
    Clear cache entries.

    **Admin only**

    Clear cache entries matching the specified pattern.

    Examples:
    - `*` - Clear all cache entries
    - `files:*` - Clear all file-related cache
    - `user:123:*` - Clear cache for specific user
    """

    result = await performance_optimizer.clear_cache(pattern=clear_request.pattern)
    return result


@router.get("/indexes/recommendations", response_model=IndexRecommendationsResponse)
@user_limiter.limit(RateLimitConfig.API_READ)
async def get_index_recommendations(
    request: Request,
    current_user: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get database index recommendations.

    **Admin only**

    Analyzes the database schema and recommends missing indexes
    that could improve query performance.
    """

    recommendations = await performance_optimizer.index_recommender.get_missing_indexes(db)

    return {
        "total_recommendations": len(recommendations),
        "recommendations": recommendations
    }


@router.post("/indexes/create", response_model=CreateIndexesResponse)
@user_limiter.limit(RateLimitConfig.API_WRITE)
async def create_recommended_indexes(
    request: Request,
    create_request: CreateIndexesRequest,
    current_user: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Create recommended database indexes.

    **Admin only**

    Creates the recommended indexes to improve query performance.

    **Warning:** Creating indexes on large tables can take time and
    may temporarily impact performance. Consider running during low-traffic periods.

    Set `execute: true` to actually create indexes. Default is dry run.
    """

    result = await performance_optimizer.create_recommended_indexes(
        db=db,
        execute=create_request.execute
    )

    return result


@router.get("/health")
@user_limiter.limit(RateLimitConfig.API_READ)
async def performance_health_check(
    request: Request,
    current_user: User = Depends(get_current_admin_user),
):
    """
    Performance monitoring health check.

    **Admin only**

    Checks if performance monitoring services are operational.
    """

    try:
        # Check cache connectivity
        cache_stats = await performance_optimizer.query_cache.get_stats()
        cache_healthy = bool(cache_stats)

        # Check query monitor
        query_monitor_healthy = performance_optimizer.query_monitor is not None

        overall_healthy = cache_healthy and query_monitor_healthy

        return {
            "healthy": overall_healthy,
            "components": {
                "cache": {
                    "healthy": cache_healthy,
                    "connected": cache_stats.get("connected_clients", 0) > 0
                },
                "query_monitor": {
                    "healthy": query_monitor_healthy,
                    "queries_tracked": len(performance_optimizer.query_monitor.query_stats)
                }
            }
        }
    except Exception as e:
        raise HTTPException(
            status_code=503,
            detail=f"Performance monitoring unhealthy: {str(e)}"
        )
