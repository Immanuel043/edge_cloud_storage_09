# services/storage-service/app/database.py
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine,async_sessionmaker
from sqlalchemy.orm import sessionmaker
import redis.asyncio as redis
from .config import settings

# Database Engine with connection pool for 100 concurrent uploads
engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,
    pool_size=50,          # Base pool size
    max_overflow=100,      # Additional connections beyond pool_size
    pool_pre_ping=True     # Verify connections before using
)
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

# Redis Client (initialized at startup)
redis_client = None

async def init_redis():
    """Initialize Redis connection with connection pooling"""
    global redis_client
    redis_client = await redis.from_url(
        settings.REDIS_URL,
        encoding="utf-8",
        decode_responses=False,  # Keep as bytes for binary data compatibility
        max_connections=100,  # Support 100+ concurrent connections
        socket_connect_timeout=5,
        socket_keepalive=True,
        health_check_interval=30
    )
    return redis_client

async def close_redis():
    """Close Redis connection"""
    global redis_client
    if redis_client:
        await redis_client.close()

async def get_redis():
    """Get Redis client instance"""
    return redis_client

async def get_db():
    """Dependency to get database session"""
    async with AsyncSessionLocal() as session:
        yield session