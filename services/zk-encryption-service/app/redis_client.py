"""
Redis Client

Connection pool and helper functions for Redis.
Used for session storage, rate limiting, and caching.

Key Namespacing:
- All ZK service keys are prefixed with "zk:" to prevent collisions with storage-service
- Session keys: zk:session:{session_id}
- Rate limit keys: zk:ratelimit:{action}:{identifier}
- Upload progress keys: zk:upload:{upload_id}
"""
import json
import structlog
from typing import Optional, Any
import redis.asyncio as aioredis
from redis.asyncio import ConnectionPool

from app.config import settings

logger = structlog.get_logger()

# Key prefix for all ZK service keys - prevents collision with storage-service
ZK_KEY_PREFIX = "zk:"

# Global Redis client
_redis_client: Optional[aioredis.Redis] = None


async def init_redis():
    """
    Initialize Redis connection pool.
    Called on application startup.
    """
    global _redis_client

    try:
        # Create connection pool
        pool = ConnectionPool.from_url(
            settings.ZK_REDIS_URL,
            max_connections=50,
            decode_responses=True,  # Auto-decode bytes to str
        )

        # Create Redis client
        _redis_client = aioredis.Redis(connection_pool=pool)

        # Test connection
        await _redis_client.ping()

        logger.info("redis_initialized", url=settings.ZK_REDIS_URL)

    except Exception as e:
        logger.error("redis_init_failed", error=str(e), exc_info=True)
        raise


async def close_redis():
    """
    Close Redis connections.
    Called on application shutdown.
    """
    global _redis_client

    if _redis_client:
        try:
            await _redis_client.close()
            await _redis_client.connection_pool.disconnect()
            logger.info("redis_connections_closed")
        except Exception as e:
            logger.error("redis_close_failed", error=str(e), exc_info=True)


def get_redis() -> aioredis.Redis:
    """
    Get Redis client instance.

    Returns:
        Redis client

    Raises:
        RuntimeError: If Redis not initialized

    Usage:
        redis = get_redis()
        await redis.set("key", "value")
    """
    if _redis_client is None:
        raise RuntimeError("Redis not initialized. Call init_redis() first.")
    return _redis_client


class RedisService:
    """
    Helper service for common Redis operations.
    """

    @staticmethod
    async def set_json(key: str, value: Any, ttl: Optional[int] = None) -> bool:
        """
        Store JSON-serializable data in Redis.

        Args:
            key: Redis key
            value: JSON-serializable value
            ttl: Time to live in seconds (optional)

        Returns:
            True if successful
        """
        try:
            redis = get_redis()
            json_str = json.dumps(value)

            if ttl:
                await redis.setex(key, ttl, json_str)
            else:
                await redis.set(key, json_str)

            return True
        except Exception as e:
            logger.error("redis_set_json_failed", key=key, error=str(e))
            return False

    @staticmethod
    async def get_json(key: str) -> Optional[Any]:
        """
        Retrieve JSON data from Redis.

        Args:
            key: Redis key

        Returns:
            Parsed JSON value or None if not found
        """
        try:
            redis = get_redis()
            json_str = await redis.get(key)

            if json_str is None:
                return None

            return json.loads(json_str)
        except Exception as e:
            logger.error("redis_get_json_failed", key=key, error=str(e))
            return None

    @staticmethod
    async def delete(key: str) -> bool:
        """
        Delete key from Redis.

        Args:
            key: Redis key

        Returns:
            True if key was deleted
        """
        try:
            redis = get_redis()
            result = await redis.delete(key)
            return result > 0
        except Exception as e:
            logger.error("redis_delete_failed", key=key, error=str(e))
            return False

    @staticmethod
    async def exists(key: str) -> bool:
        """
        Check if key exists in Redis.

        Args:
            key: Redis key

        Returns:
            True if key exists
        """
        try:
            redis = get_redis()
            result = await redis.exists(key)
            return result > 0
        except Exception as e:
            logger.error("redis_exists_failed", key=key, error=str(e))
            return False

    @staticmethod
    async def increment(key: str, amount: int = 1) -> Optional[int]:
        """
        Increment a counter in Redis.

        Args:
            key: Redis key
            amount: Amount to increment

        Returns:
            New value or None if failed
        """
        try:
            redis = get_redis()
            return await redis.incrby(key, amount)
        except Exception as e:
            logger.error("redis_increment_failed", key=key, error=str(e))
            return None

    @staticmethod
    async def set_with_expiry(key: str, value: str, ttl: int) -> bool:
        """
        Set a key with expiry time.

        Args:
            key: Redis key
            value: String value
            ttl: Time to live in seconds

        Returns:
            True if successful
        """
        try:
            redis = get_redis()
            await redis.setex(key, ttl, value)
            return True
        except Exception as e:
            logger.error("redis_setex_failed", key=key, error=str(e))
            return False

    @staticmethod
    async def get_ttl(key: str) -> Optional[int]:
        """
        Get remaining TTL for a key.

        Args:
            key: Redis key

        Returns:
            TTL in seconds, or None if key doesn't exist or has no expiry
        """
        try:
            redis = get_redis()
            ttl = await redis.ttl(key)
            return ttl if ttl > 0 else None
        except Exception as e:
            logger.error("redis_ttl_failed", key=key, error=str(e))
            return None


# Session storage helpers
class SessionService:
    """
    Service for managing user sessions in Redis.
    """

    @staticmethod
    def _session_key(session_id: str) -> str:
        """Generate Redis key for session (with ZK prefix)"""
        return f"{ZK_KEY_PREFIX}session:{session_id}"

    @staticmethod
    async def create_session(
        session_id: str,
        data: dict,
        ttl: int = None
    ) -> bool:
        """
        Create a new session.

        Args:
            session_id: Unique session ID
            data: Session data (dict)
            ttl: Time to live in seconds (default from config)

        Returns:
            True if successful
        """
        if ttl is None:
            ttl = settings.REDIS_SESSION_TTL

        key = SessionService._session_key(session_id)
        return await RedisService.set_json(key, data, ttl)

    @staticmethod
    async def get_session(session_id: str) -> Optional[dict]:
        """
        Retrieve session data.

        Args:
            session_id: Session ID

        Returns:
            Session data dict or None if not found
        """
        key = SessionService._session_key(session_id)
        return await RedisService.get_json(key)

    @staticmethod
    async def update_session(session_id: str, data: dict) -> bool:
        """
        Update session data (preserves TTL).

        Args:
            session_id: Session ID
            data: New session data

        Returns:
            True if successful
        """
        key = SessionService._session_key(session_id)

        # Get remaining TTL
        redis = get_redis()
        ttl = await redis.ttl(key)

        if ttl <= 0:
            # Session expired or doesn't exist
            return False

        return await RedisService.set_json(key, data, ttl)

    @staticmethod
    async def delete_session(session_id: str) -> bool:
        """
        Delete a session.

        Args:
            session_id: Session ID

        Returns:
            True if session was deleted
        """
        key = SessionService._session_key(session_id)
        return await RedisService.delete(key)


# Rate limiting helpers
class RateLimitService:
    """
    Service for rate limiting using Redis.
    """

    @staticmethod
    def _rate_limit_key(identifier: str, action: str) -> str:
        """Generate Redis key for rate limiting (with ZK prefix)"""
        return f"{ZK_KEY_PREFIX}ratelimit:{action}:{identifier}"

    @staticmethod
    async def check_rate_limit(
        identifier: str,
        action: str,
        max_requests: int,
        window_seconds: int
    ) -> tuple[bool, int]:
        """
        Check if request is within rate limit.

        Args:
            identifier: Unique identifier (user_id, IP, etc.)
            action: Action being rate limited (e.g., "login", "recovery")
            max_requests: Maximum requests allowed
            window_seconds: Time window in seconds

        Returns:
            Tuple of (is_allowed: bool, remaining_requests: int)
        """
        key = RateLimitService._rate_limit_key(identifier, action)
        redis = get_redis()

        try:
            # Increment counter
            current = await redis.incr(key)

            # Set expiry on first request
            if current == 1:
                await redis.expire(key, window_seconds)

            # Check if over limit
            if current > max_requests:
                return False, 0

            remaining = max_requests - current
            return True, remaining

        except Exception as e:
            logger.error(
                "rate_limit_check_failed",
                identifier=identifier,
                action=action,
                error=str(e)
            )
            # Fail open (allow request) on error
            return True, max_requests

    @staticmethod
    async def reset_rate_limit(identifier: str, action: str) -> bool:
        """
        Reset rate limit counter.

        Args:
            identifier: Unique identifier
            action: Action being rate limited

        Returns:
            True if reset successful
        """
        key = RateLimitService._rate_limit_key(identifier, action)
        return await RedisService.delete(key)
