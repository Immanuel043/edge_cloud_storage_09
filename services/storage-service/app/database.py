# services/storage-service/app/database.py
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker
import redis.asyncio as redis
from .config import settings

# Database Engine
engine = create_async_engine(settings.DATABASE_URL, echo=False)
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

# Redis Client (initialized at startup)
redis_client = None

async def init_redis():
    """Initialize Redis connection"""
    global redis_client
    redis_client = await redis.from_url(settings.REDIS_URL)
    return redis_client

async def close_redis():
    """Close Redis connection"""
    global redis_client
    if redis_client:
        await redis_client.close()

async def get_redis():
    """Get Redis client instance"""
    return redis_client
