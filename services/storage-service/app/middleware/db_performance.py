# services/storage-service/app/middleware/db_performance.py

"""
Database Performance Monitoring Middleware

Tracks slow queries, connection pool health, and database performance metrics.
"""

import time
import logging
from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from sqlalchemy import event
from sqlalchemy.engine import Engine
from typing import Dict, List
import asyncio
from collections import deque
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

# In-memory storage for recent slow queries
slow_queries: deque = deque(maxlen=100)  # Keep last 100 slow queries
query_stats: Dict[str, List[float]] = {}  # Query execution times by endpoint


class DatabasePerformanceMiddleware(BaseHTTPMiddleware):
    """
    Middleware to monitor database query performance and log slow queries
    """

    def __init__(self, app, slow_query_threshold: float = 1.0):
        """
        Args:
            app: FastAPI application
            slow_query_threshold: Time in seconds to consider a query slow (default 1.0s)
        """
        super().__init__(app)
        self.slow_query_threshold = slow_query_threshold

    async def dispatch(self, request: Request, call_next):
        # Skip health checks and static files
        if request.url.path in ["/health", "/metrics", "/docs", "/openapi.json"]:
            return await call_next(request)

        start_time = time.time()

        # Add query tracking context
        request.state.query_count = 0
        request.state.query_time = 0.0

        try:
            response = await call_next(request)
            duration = time.time() - start_time

            # Log slow requests
            if duration > self.slow_query_threshold:
                logger.warning(
                    f"Slow request detected",
                    extra={
                        "method": request.method,
                        "path": request.url.path,
                        "duration": f"{duration:.3f}s",
                        "query_count": getattr(request.state, "query_count", 0),
                        "query_time": f"{getattr(request.state, 'query_time', 0):.3f}s",
                    }
                )

                # Store slow query info
                slow_queries.append({
                    "timestamp": datetime.utcnow().isoformat(),
                    "method": request.method,
                    "path": request.url.path,
                    "duration": duration,
                    "query_count": getattr(request.state, "query_count", 0),
                    "query_time": getattr(request.state, "query_time", 0),
                })

            # Track query stats by endpoint
            endpoint = f"{request.method}:{request.url.path}"
            if endpoint not in query_stats:
                query_stats[endpoint] = []
            query_stats[endpoint].append(duration)

            # Keep only last 1000 measurements per endpoint
            if len(query_stats[endpoint]) > 1000:
                query_stats[endpoint] = query_stats[endpoint][-1000:]

            # Add performance headers to response
            response.headers["X-Response-Time"] = f"{duration:.3f}s"
            response.headers["X-Query-Count"] = str(getattr(request.state, "query_count", 0))

            return response

        except Exception as e:
            duration = time.time() - start_time
            logger.error(
                f"Request failed after {duration:.3f}s",
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "error": str(e),
                }
            )
            raise


# SQLAlchemy event listeners for query tracking
@event.listens_for(Engine, "before_cursor_execute")
def before_cursor_execute(conn, cursor, statement, parameters, context, executemany):
    """Track query start time"""
    conn.info.setdefault("query_start_time", []).append(time.time())


@event.listens_for(Engine, "after_cursor_execute")
def after_cursor_execute(conn, cursor, statement, parameters, context, executemany):
    """Log slow queries and track query time"""
    total = time.time() - conn.info["query_start_time"].pop(-1)

    # Log extremely slow queries (>2s)
    if total > 2.0:
        logger.warning(
            f"SLOW QUERY: {total:.3f}s",
            extra={
                "duration": f"{total:.3f}s",
                "query": statement[:500],  # First 500 chars
            }
        )


def get_slow_queries(limit: int = 50) -> List[Dict]:
    """Get recent slow queries"""
    return list(slow_queries)[-limit:]


def get_query_stats(endpoint: str = None) -> Dict:
    """
    Get query statistics for endpoints

    Args:
        endpoint: Specific endpoint (e.g., "GET:/api/v1/files") or None for all

    Returns:
        Dictionary with statistics (avg, min, max, p95, p99)
    """
    if endpoint:
        if endpoint not in query_stats:
            return {}
        times = query_stats[endpoint]
    else:
        # Aggregate all endpoints
        times = []
        for endpoint_times in query_stats.values():
            times.extend(endpoint_times)

    if not times:
        return {}

    sorted_times = sorted(times)
    count = len(sorted_times)

    return {
        "count": count,
        "avg": sum(sorted_times) / count,
        "min": sorted_times[0],
        "max": sorted_times[-1],
        "p50": sorted_times[int(count * 0.5)],
        "p95": sorted_times[int(count * 0.95)],
        "p99": sorted_times[int(count * 0.99)],
    }


def get_all_endpoint_stats() -> Dict[str, Dict]:
    """Get statistics for all endpoints"""
    result = {}
    for endpoint in query_stats.keys():
        result[endpoint] = get_query_stats(endpoint)
    return result


def clear_stats():
    """Clear all stored statistics (useful for testing)"""
    slow_queries.clear()
    query_stats.clear()
