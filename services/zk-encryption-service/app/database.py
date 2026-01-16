"""
Database Connection Management

Async SQLAlchemy setup for the ZK encryption service.

IMPORTANT: This is a SEPARATE database from the Storage Service.
The ZK service uses its own PostgreSQL instance (ZK_DATABASE_URL)
for complete isolation. No data is shared with Storage Service.
"""
import structlog
from typing import AsyncGenerator, Optional
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.pool import NullPool, QueuePool
from contextlib import asynccontextmanager
import redis.asyncio as redis

from app.config import settings

logger = structlog.get_logger()

# Redis client for caching and rate limiting
_redis_client: Optional[redis.Redis] = None

# Create async engine
engine = create_async_engine(
    settings.ZK_DATABASE_URL,
    echo=settings.DEBUG,  # Log SQL queries in debug mode
    pool_size=settings.DB_POOL_SIZE,
    max_overflow=settings.DB_MAX_OVERFLOW,
    pool_pre_ping=True,  # Verify connections before using
    pool_recycle=3600,   # Recycle connections after 1 hour
    future=True,
)

# Create session factory
async_session_maker = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False,
)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """
    FastAPI dependency for database sessions.

    Yields:
        AsyncSession: Database session

    Usage:
        @router.post("/endpoint")
        async def my_endpoint(db: AsyncSession = Depends(get_db)):
            result = await db.execute(select(User))
            ...
    """
    async with async_session_maker() as session:
        try:
            yield session
            await session.commit()
        except Exception as e:
            await session.rollback()
            # Don't log HTTPException as database errors - they're just passing through
            from fastapi import HTTPException
            if not isinstance(e, HTTPException):
                logger.error("database_error", error=str(e), exc_info=True)
            raise
        finally:
            await session.close()


@asynccontextmanager
async def get_db_context():
    """
    Context manager for database sessions (for use outside FastAPI).

    Usage:
        async with get_db_context() as db:
            result = await db.execute(select(User))
            ...
    """
    async with async_session_maker() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


async def init_db():
    """
    Initialize database connection pool.
    Called on application startup.
    """
    try:
        # Test connection
        async with engine.begin() as conn:
            await conn.execute(sa.text("SELECT 1"))

        logger.info(
            "database_initialized",
            pool_size=settings.DB_POOL_SIZE,
            max_overflow=settings.DB_MAX_OVERFLOW
        )
    except Exception as e:
        logger.error("database_init_failed", error=str(e), exc_info=True)
        raise


async def close_db():
    """
    Close database connections.
    Called on application shutdown.
    """
    try:
        await engine.dispose()
        logger.info("database_connections_closed")
    except Exception as e:
        logger.error("database_close_failed", error=str(e), exc_info=True)


# ==================== Redis Functions ====================

async def init_redis():
    """
    Initialize Redis connection.
    Called on application startup.
    """
    global _redis_client
    try:
        _redis_client = redis.from_url(
            settings.ZK_REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
            max_connections=50
        )
        # Test connection
        await _redis_client.ping()
        logger.info("redis_initialized", redis_url=settings.ZK_REDIS_URL)
    except Exception as e:
        logger.error("redis_init_failed", error=str(e), exc_info=True)
        raise


async def close_redis():
    """
    Close Redis connection.
    Called on application shutdown.
    """
    global _redis_client
    if _redis_client:
        try:
            await _redis_client.close()
            logger.info("redis_connection_closed")
        except Exception as e:
            logger.error("redis_close_failed", error=str(e), exc_info=True)


async def get_redis() -> redis.Redis:
    """
    Get Redis client instance.

    Returns:
        redis.Redis: Redis client

    Raises:
        RuntimeError: If Redis is not initialized
    """
    global _redis_client
    if _redis_client is None:
        raise RuntimeError("Redis client not initialized. Call init_redis() first.")
    return _redis_client


# Import sqlalchemy for SQL text
import sqlalchemy as sa
