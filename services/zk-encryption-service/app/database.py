"""
Database Connection Management

Async SQLAlchemy setup for the ZK encryption service.
Shares the same PostgreSQL database as storage-service for consistency.
"""
import structlog
from typing import AsyncGenerator
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.pool import NullPool, QueuePool
from contextlib import asynccontextmanager

from app.config import settings

logger = structlog.get_logger()

# Create async engine
engine = create_async_engine(
    settings.DATABASE_URL,
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


# Import sqlalchemy for SQL text
import sqlalchemy as sa
