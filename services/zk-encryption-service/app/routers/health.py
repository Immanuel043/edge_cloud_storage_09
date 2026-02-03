"""
Enhanced Health Check Endpoints for ZK Service

Provides comprehensive health monitoring including:
- Database connectivity and pool statistics
- System resource usage (CPU, memory, disk)
- Redis connectivity and statistics
- Detailed health check combining all subsystems
"""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from typing import Dict, Any
import time
import psutil
import os
from datetime import datetime, timezone

from app.database import engine, get_db, get_redis
import structlog

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1/health", tags=["health"])

# Service start time for uptime calculation
SERVICE_START_TIME = datetime.now(timezone.utc)


@router.get("/db")
async def database_health(db: AsyncSession = Depends(get_db)) -> Dict[str, Any]:
    """Comprehensive database health check"""
    start_time = time.time()

    try:
        # Test connectivity
        result = await db.execute(text("SELECT 1"))
        db_connected = result.scalar() == 1

        # Connection pool stats
        pool = engine.pool
        total = pool.size() + pool.overflow()
        pool_status = {
            "size": pool.size(),
            "checked_in": pool.checkedin(),
            "checked_out": pool.checkedout(),
            "overflow": pool.overflow(),
            "total_connections": total,
            "utilization_percent": round((pool.checkedout() / total) * 100, 2) if total > 0 else 0,
        }

        # Database statistics
        db_stats_result = await db.execute(text("""
            SELECT
                pg_database_size(current_database()) as db_size,
                (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) as active_connections
        """))
        db_stats = db_stats_result.first()

        response_time = time.time() - start_time

        return {
            "status": "healthy" if db_connected else "unhealthy",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "response_time": f"{response_time:.3f}s",
            "database": {
                "connected": db_connected,
                "size_bytes": db_stats.db_size if db_stats else 0,
                "size_human": format_bytes(db_stats.db_size if db_stats else 0),
                "active_connections": db_stats.active_connections if db_stats else 0,
            },
            "connection_pool": pool_status,
        }
    except Exception as e:
        logger.error("database_health_check_failed", error=str(e))
        return {
            "status": "unhealthy",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "error": str(e),
        }


@router.get("/system")
async def system_health() -> Dict[str, Any]:
    """System resource usage"""
    try:
        cpu_percent = psutil.cpu_percent(interval=0.1)
        cpu_count = psutil.cpu_count()
        memory = psutil.virtual_memory()
        disk = psutil.disk_usage('/app/storage' if os.path.exists('/app/storage') else '/')
        process = psutil.Process(os.getpid())
        process_memory = process.memory_info()

        return {
            "status": "healthy",
            "timestamp": datetime.now(timezone.utc).isoformat(),
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
            }
        }
    except Exception as e:
        logger.error("system_health_check_failed", error=str(e))
        return {"status": "error", "error": str(e)}


@router.get("/redis")
async def redis_health() -> Dict[str, Any]:
    """Redis connectivity and stats"""
    try:
        redis_client = await get_redis()
        if not redis_client:
            return {"status": "unavailable", "error": "Redis client not initialized"}

        start_time = time.time()
        pong = await redis_client.ping()
        response_time = time.time() - start_time
        info = await redis_client.info()

        return {
            "status": "healthy" if pong else "unhealthy",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "response_time": f"{response_time:.3f}s",
            "version": info.get("redis_version"),
            "uptime_seconds": info.get("uptime_in_seconds"),
            "connected_clients": info.get("connected_clients"),
            "used_memory": format_bytes(info.get("used_memory", 0)),
            "total_commands_processed": info.get("total_commands_processed"),
        }
    except Exception as e:
        logger.error("redis_health_check_failed", error=str(e))
        return {"status": "unhealthy", "error": str(e)}


@router.get("/detailed")
async def detailed_health(db: AsyncSession = Depends(get_db)) -> Dict[str, Any]:
    """Comprehensive health check with all subsystems"""
    uptime_seconds = (datetime.now(timezone.utc) - SERVICE_START_TIME).total_seconds()

    db_health = await database_health(db)
    system_health_data = await system_health()
    redis_health_data = await redis_health()

    overall_status = "healthy"
    if (db_health.get("status") != "healthy" or redis_health_data.get("status") != "healthy"):
        overall_status = "degraded"

    return {
        "service": "zk-encryption-service",
        "version": "2.0.0",
        "status": overall_status,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "uptime_seconds": uptime_seconds,
        "checks": {
            "database": db_health,
            "system": system_health_data,
            "redis": redis_health_data,
        }
    }


def format_bytes(bytes_value: int) -> str:
    """Format bytes to human readable format"""
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if bytes_value < 1024.0:
            return f"{bytes_value:.2f} {unit}"
        bytes_value /= 1024.0
    return f"{bytes_value:.2f} PB"
