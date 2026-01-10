# services/storage-service/app/services/bandwidth_throttle.py

"""
Bandwidth Throttling Service

Implements token bucket algorithm for per-user and per-group bandwidth limiting.
Uses Redis for distributed rate limiting across multiple instances.

Critical Fixes Applied:
- Lua scripts for atomic INCR+EXPIRE (prevents race conditions)
- Stream slot underflow protection
- Retry-aware throttling with exponential penalty
- Capped sleep times with 429 Retry-After responses

Plan Integration:
- Plan-aware bandwidth limits (free, basic, pro, team)
- Priority: DB override > Redis cache > Plan default
- Storage quotas per plan tier
"""

import asyncio
import time
import logging
from typing import Optional, Dict, AsyncGenerator, Any
from fastapi import HTTPException
from ..database import get_redis
from ..config import settings

logger = logging.getLogger(__name__)

# Lua script for atomic stream slot acquisition (Fix #1: Race condition)
ACQUIRE_STREAM_LUA = """
local current = redis.call("INCR", KEYS[1])
if current == 1 then
    redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return current
"""

# Lua script for atomic token bucket consume
CONSUME_TOKENS_LUA = """
local bucket_key = KEYS[1]
local refill_key = KEYS[2]
local bytes_requested = tonumber(ARGV[1])
local bytes_per_second = tonumber(ARGV[2])
local bucket_capacity = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local current_tokens = tonumber(redis.call("GET", bucket_key)) or bucket_capacity
local last_refill = tonumber(redis.call("GET", refill_key)) or now

-- Refill tokens based on time elapsed
local time_elapsed = now - last_refill
local tokens_to_add = time_elapsed * bytes_per_second
current_tokens = math.min(current_tokens + tokens_to_add, bucket_capacity)

-- Check if enough tokens
if current_tokens >= bytes_requested then
    local new_tokens = current_tokens - bytes_requested
    redis.call("SETEX", bucket_key, ttl, tostring(new_tokens))
    redis.call("SETEX", refill_key, ttl, tostring(now))
    return {1, 0}  -- allowed, wait_time=0
else
    -- Update tokens with refill
    redis.call("SETEX", bucket_key, ttl, tostring(current_tokens))
    redis.call("SETEX", refill_key, ttl, tostring(now))
    local tokens_needed = bytes_requested - current_tokens
    local wait_time = tokens_needed / bytes_per_second
    return {0, wait_time}  -- not allowed, wait_time
end
"""


class BandwidthThrottleService:
    """
    Token Bucket Rate Limiter for Bandwidth Control

    Features:
    - Per-user bandwidth limits (auto-fetched from Redis)
    - Per-group bandwidth pools
    - Redis-based for distributed systems
    - Concurrent stream limiting (max 5 per user)
    - Retry-aware throttling with exponential penalty
    - Graceful degradation with 429 responses for long waits
    - Atomic operations via Lua scripts
    """

    # Constants
    DEFAULT_LIMIT_MBPS = 10  # 10 Mbps default
    BURST_MULTIPLIER = 2  # Allow 2x burst
    REFILL_INTERVAL = 1.0  # Refill tokens every second
    MAX_STREAMS_PER_USER = 5  # Maximum concurrent streams
    STREAM_SLOT_TTL = 300  # 5 minutes TTL for stream slots
    MAX_WAIT_SLEEP = 1.0  # Max sleep time in async generator (Fix #4)
    LONG_WAIT_THRESHOLD = 5.0  # Return 429 if wait exceeds this
    RETRY_PENALTY_BASE = 1.5  # Base penalty multiplier for retries

    def __init__(self):
        self.default_limit_mbps = self.DEFAULT_LIMIT_MBPS
        self.burst_multiplier = self.BURST_MULTIPLIER
        self.refill_interval = self.REFILL_INTERVAL
        self._lua_scripts_registered = False
        self._acquire_stream_sha = None
        self._consume_tokens_sha = None

    # =========================================================================
    # PLAN-AWARE METHODS
    # =========================================================================

    def get_plan_limits(self, plan_type: str) -> Dict[str, Any]:
        """
        Get bandwidth and storage limits for a subscription plan.

        DEPRECATED: This method uses hardcoded fallback values.
        Use async methods with database lookup instead (get_user_limit_with_plan).

        Args:
            plan_type: Plan tier (free, basic, pro, team)

        Returns:
            Dictionary with plan limits (fallback hardcoded values):
            - storage_bytes: Storage quota
            - bandwidth_mbps: Bandwidth limit
            - burst_mbps: Burst bandwidth
            - max_streams: Maximum concurrent streams
        """
        # Hardcoded fallback values (deprecated - database is source of truth)
        FALLBACK_LIMITS = {
            "free": {
                "storage_bytes": 5 * 1024**3,
                "bandwidth_mbps": 5,
                "burst_mbps": 10,
                "max_streams": 2,
            },
            "basic": {
                "storage_bytes": 200 * 1024**3,
                "bandwidth_mbps": 25,
                "burst_mbps": 50,
                "max_streams": 5,
            },
            "pro": {
                "storage_bytes": 1 * 1024**4,
                "bandwidth_mbps": 100,
                "burst_mbps": 200,
                "max_streams": 10,
            },
            "team": {
                "storage_bytes": 5 * 1024**4,
                "bandwidth_mbps": 500,
                "burst_mbps": 1000,
                "max_streams": 25,
            },
        }
        return FALLBACK_LIMITS.get(plan_type, FALLBACK_LIMITS["free"])

    def get_max_streams_for_plan(self, plan_type: str) -> int:
        """
        Get maximum concurrent streams for a subscription plan.

        Args:
            plan_type: Plan tier (free, basic, pro, team)

        Returns:
            Maximum number of concurrent streams allowed
        """
        plan = self.get_plan_limits(plan_type)
        return plan.get("max_streams", self.MAX_STREAMS_PER_USER)

    def get_bandwidth_for_plan(self, plan_type: str) -> tuple[float, float]:
        """
        Get bandwidth limits for a subscription plan.

        Args:
            plan_type: Plan tier (free, basic, pro, team)

        Returns:
            (bandwidth_mbps, burst_mbps)
        """
        plan = self.get_plan_limits(plan_type)
        return (
            plan.get("bandwidth_mbps", self.DEFAULT_LIMIT_MBPS),
            plan.get("burst_mbps", self.DEFAULT_LIMIT_MBPS * 2)
        )

    async def get_user_limit_with_plan(
        self,
        user_id: str,
        plan_type: str = "free",
        db_bandwidth_override: Optional[int] = None,
        db_burst_override: Optional[int] = None
    ) -> tuple[float, float]:
        """
        Get effective bandwidth limit for a user with priority resolution.

        Priority order:
        1. Database override (admin-set bandwidth_limit_mbps column)
        2. Redis cache (runtime override via admin API)
        3. Plan default (from PLAN_LIMITS config)

        Args:
            user_id: User identifier
            plan_type: User's subscription plan tier
            db_bandwidth_override: Optional DB-stored bandwidth override
            db_burst_override: Optional DB-stored burst override

        Returns:
            (bandwidth_mbps, burst_mbps)
        """
        # Priority 1: Database override (from User model)
        if db_bandwidth_override is not None:
            burst = db_burst_override if db_burst_override else db_bandwidth_override * 2
            logger.debug(f"User {user_id} using DB override: {db_bandwidth_override} Mbps")
            return float(db_bandwidth_override), float(burst)

        # Priority 2: Redis cache (admin API override)
        redis_client = await get_redis()
        if redis_client:
            limit_key = f"bandwidth:limit:{user_id}"
            try:
                cached_limit = await redis_client.get(limit_key)
                if cached_limit:
                    limit = float(cached_limit)
                    logger.debug(f"User {user_id} using Redis override: {limit} Mbps")
                    return limit, limit * 2
            except Exception as e:
                logger.warning(f"Redis error getting limit: {e}")

        # Priority 3: Plan default
        bandwidth, burst = self.get_bandwidth_for_plan(plan_type)
        logger.debug(f"User {user_id} using plan default ({plan_type}): {bandwidth} Mbps")
        return bandwidth, burst

    async def get_max_streams_with_plan(
        self,
        user_id: str,
        plan_type: str = "free",
        db_streams_override: Optional[int] = None
    ) -> int:
        """
        Get effective max streams for a user with priority resolution.

        Priority order:
        1. Database override (admin-set max_concurrent_streams column)
        2. Plan default (from PLAN_LIMITS config)

        Args:
            user_id: User identifier
            plan_type: User's subscription plan tier
            db_streams_override: Optional DB-stored streams override

        Returns:
            Maximum number of concurrent streams
        """
        # Priority 1: Database override
        if db_streams_override is not None:
            return db_streams_override

        # Priority 2: Plan default
        return self.get_max_streams_for_plan(plan_type)

    async def _ensure_lua_scripts(self, redis_client):
        """Register Lua scripts with Redis for better performance"""
        if not self._lua_scripts_registered:
            try:
                self._acquire_stream_sha = await redis_client.script_load(ACQUIRE_STREAM_LUA)
                self._consume_tokens_sha = await redis_client.script_load(CONSUME_TOKENS_LUA)
                self._lua_scripts_registered = True
            except Exception as e:
                logger.warning(f"Failed to register Lua scripts: {e}")

    async def acquire_stream_slot(
        self,
        user_id: str,
        max_streams: int = None,
        plan_type: str = None,
        db_streams_override: int = None
    ) -> bool:
        """
        Acquire a stream slot for concurrent transfer limiting.
        Uses Lua script for atomic INCR+EXPIRE (Fix #1).

        Args:
            user_id: User identifier
            max_streams: Maximum allowed concurrent streams (explicit override)
            plan_type: User's subscription plan tier (for plan-based limits)
            db_streams_override: Database-stored streams override (from User model)

        Returns:
            True if slot acquired, False if limit reached
        """
        # Resolve max_streams with priority
        if max_streams is None:
            if db_streams_override is not None:
                max_streams = db_streams_override
            elif plan_type:
                max_streams = self.get_max_streams_for_plan(plan_type)
            else:
                max_streams = self.MAX_STREAMS_PER_USER
        redis_client = await get_redis()
        if not redis_client:
            return True  # Allow if Redis unavailable

        key = f"bandwidth:streams:{user_id}"

        try:
            # Use Lua script for atomic operation
            current = await redis_client.eval(
                ACQUIRE_STREAM_LUA,
                1,  # number of keys
                key,  # KEYS[1]
                self.STREAM_SLOT_TTL  # ARGV[1]
            )

            if current > max_streams:
                # Over limit - decrement and reject
                await redis_client.decr(key)
                logger.warning(f"User {user_id} exceeded stream limit: {current}/{max_streams}")
                return False

            logger.debug(f"User {user_id} acquired stream slot: {current}/{max_streams}")
            return True

        except Exception as e:
            logger.error(f"Failed to acquire stream slot: {e}")
            return True  # Allow on error

    async def release_stream_slot(self, user_id: str):
        """
        Release a stream slot after transfer completes.
        Includes underflow protection (Fix #2).

        Args:
            user_id: User identifier
        """
        redis_client = await get_redis()
        if not redis_client:
            return

        key = f"bandwidth:streams:{user_id}"

        try:
            value = await redis_client.decr(key)

            # Fix #2: Underflow protection
            if value < 0:
                await redis_client.set(key, 0, ex=self.STREAM_SLOT_TTL)
                logger.warning(f"Stream slot underflow for user {user_id}, reset to 0")

        except Exception as e:
            logger.error(f"Failed to release stream slot: {e}")

    async def get_stream_count(self, user_id: str) -> int:
        """Get current stream count for a user"""
        redis_client = await get_redis()
        if not redis_client:
            return 0

        key = f"bandwidth:streams:{user_id}"
        try:
            count = await redis_client.get(key)
            return int(count) if count else 0
        except Exception as e:
            logger.error(f"Failed to get stream count: {e}")
            return 0

    async def get_user_limit(self, user_id: str) -> float:
        """
        Get bandwidth limit for a user (auto-fetch from Redis).

        Returns:
            Bandwidth limit in Mbps (or default if not set)
        """
        redis_client = await get_redis()
        if not redis_client:
            return self.default_limit_mbps

        limit_key = f"bandwidth:limit:{user_id}"
        try:
            limit = await redis_client.get(limit_key)
            return float(limit) if limit else self.default_limit_mbps
        except Exception as e:
            logger.error(f"Failed to get bandwidth limit: {e}")
            return self.default_limit_mbps

    async def can_transfer(
        self,
        user_id: str,
        bytes_requested: int,
        limit_mbps: Optional[float] = None,
        plan_type: str = None,
        db_bandwidth_override: int = None
    ) -> tuple[bool, float]:
        """
        Check if transfer is allowed and return wait time if throttled.
        Auto-fetches user limit if not provided.

        Args:
            user_id: User identifier
            bytes_requested: Number of bytes to transfer
            limit_mbps: Bandwidth limit in Mbps (explicit override)
            plan_type: User's subscription plan tier (for plan-based limits)
            db_bandwidth_override: Database-stored bandwidth override

        Returns:
            (allowed: bool, wait_time: float)
        """
        redis_client = await get_redis()
        if not redis_client:
            return True, 0.0

        # Auto-fetch user limit with plan awareness if not provided
        if limit_mbps is None:
            if plan_type or db_bandwidth_override is not None:
                limit_mbps, _ = await self.get_user_limit_with_plan(
                    user_id, plan_type or "free", db_bandwidth_override
                )
            else:
                limit_mbps = await self.get_user_limit(user_id)

        bucket_key = f"bandwidth:bucket:{user_id}"
        last_refill_key = f"bandwidth:refill:{user_id}"

        # Convert Mbps to bytes per second
        bytes_per_second = (limit_mbps * 1024 * 1024) / 8
        bucket_capacity = bytes_per_second * self.burst_multiplier

        try:
            # Use Lua script for atomic operation
            result = await redis_client.eval(
                CONSUME_TOKENS_LUA,
                2,  # number of keys
                bucket_key, last_refill_key,  # KEYS
                bytes_requested, bytes_per_second, bucket_capacity, time.time(), 300  # ARGV
            )

            allowed = bool(result[0])
            wait_time = float(result[1])
            return allowed, wait_time

        except Exception as e:
            logger.error(f"Bandwidth throttle error: {e}")
            return True, 0.0

    async def can_transfer_with_priority(
        self,
        user_id: str,
        bytes_requested: int,
        retry_count: int = 0,
        limit_mbps: Optional[float] = None,
        plan_type: str = None,
        db_bandwidth_override: int = None
    ) -> tuple[bool, float]:
        """
        Check transfer with retry-aware throttling (plan-aware).
        Applies exponential penalty for retries to prevent retry storms.

        Args:
            user_id: User identifier
            bytes_requested: Number of bytes to transfer
            retry_count: Number of retries for this chunk (0 = first attempt)
            limit_mbps: Bandwidth limit in Mbps (explicit override)
            plan_type: User's subscription plan tier (for plan-based limits)
            db_bandwidth_override: Database-stored bandwidth override

        Returns:
            (allowed: bool, wait_time: float)
        """
        allowed, wait_time = await self.can_transfer(
            user_id, bytes_requested, limit_mbps, plan_type, db_bandwidth_override
        )

        if not allowed and retry_count > 0:
            # Apply exponential penalty for retries
            penalty = self.RETRY_PENALTY_BASE ** retry_count
            wait_time = wait_time * penalty
            logger.debug(f"Retry penalty applied: retry={retry_count}, penalty={penalty:.2f}x, wait={wait_time:.2f}s")

        return allowed, wait_time

    async def throttled_transfer(
        self,
        user_id: str,
        data_generator: AsyncGenerator[bytes, None],
        limit_mbps: Optional[float] = None,
        raise_on_long_wait: bool = True,
        plan_type: str = None,
        db_bandwidth_override: int = None
    ) -> AsyncGenerator[bytes, None]:
        """
        Transfer data with bandwidth throttling.
        Fix #4: Caps sleep time and raises 429 for long waits.

        Args:
            user_id: User identifier
            data_generator: Async generator yielding data chunks
            limit_mbps: Bandwidth limit in Mbps (explicit override)
            raise_on_long_wait: If True, raise HTTPException 429 for long waits
            plan_type: User's subscription plan tier (for plan-based limits)
            db_bandwidth_override: Database-stored bandwidth override

        Yields:
            Data chunks with appropriate delays

        Raises:
            HTTPException 429 if wait time exceeds threshold
        """
        # Auto-fetch limit once at start with plan awareness
        if limit_mbps is None:
            if plan_type or db_bandwidth_override is not None:
                limit_mbps, _ = await self.get_user_limit_with_plan(
                    user_id, plan_type or "free", db_bandwidth_override
                )
            else:
                limit_mbps = await self.get_user_limit(user_id)

        async for chunk in data_generator:
            chunk_size = len(chunk)
            allowed, wait_time = await self.can_transfer(user_id, chunk_size, limit_mbps)

            if not allowed:
                # Fix #4: Return 429 for long waits instead of blocking
                if raise_on_long_wait and wait_time > self.LONG_WAIT_THRESHOLD:
                    logger.warning(f"User {user_id} bandwidth limit exceeded, wait={wait_time:.2f}s")
                    raise HTTPException(
                        status_code=429,
                        detail=f"Bandwidth limit exceeded. Please retry after {int(wait_time)} seconds.",
                        headers={"Retry-After": str(int(wait_time))}
                    )

                # Cap sleep time to prevent blocking event loop
                sleep_time = min(wait_time, self.MAX_WAIT_SLEEP)
                logger.debug(f"Throttling user {user_id}: waiting {sleep_time:.2f}s (requested: {wait_time:.2f}s)")
                await asyncio.sleep(sleep_time)

                # If we only slept partial time, re-check
                if wait_time > sleep_time:
                    allowed, remaining_wait = await self.can_transfer(user_id, chunk_size, limit_mbps)
                    if not allowed and remaining_wait > self.LONG_WAIT_THRESHOLD:
                        raise HTTPException(
                            status_code=429,
                            detail=f"Bandwidth limit exceeded. Please retry after {int(remaining_wait)} seconds.",
                            headers={"Retry-After": str(int(remaining_wait))}
                        )

            yield chunk

    async def throttled_transfer_with_retry(
        self,
        user_id: str,
        data_generator: AsyncGenerator[bytes, None],
        retry_count: int = 0,
        limit_mbps: Optional[float] = None
    ) -> AsyncGenerator[bytes, None]:
        """
        Transfer data with retry-aware throttling.
        Applies penalty for retries to prevent retry storms.

        Args:
            user_id: User identifier
            data_generator: Async generator yielding data chunks
            retry_count: Retry attempt number (0 = first attempt)
            limit_mbps: Bandwidth limit in Mbps

        Yields:
            Data chunks with appropriate delays
        """
        if limit_mbps is None:
            limit_mbps = await self.get_user_limit(user_id)

        async for chunk in data_generator:
            chunk_size = len(chunk)
            allowed, wait_time = await self.can_transfer_with_priority(
                user_id, chunk_size, retry_count, limit_mbps
            )

            if not allowed:
                if wait_time > self.LONG_WAIT_THRESHOLD:
                    raise HTTPException(
                        status_code=429,
                        detail=f"Bandwidth limit exceeded. Please retry after {int(wait_time)} seconds.",
                        headers={"Retry-After": str(int(wait_time))}
                    )

                sleep_time = min(wait_time, self.MAX_WAIT_SLEEP)
                await asyncio.sleep(sleep_time)

            yield chunk

    async def get_usage_stats(self, user_id: str) -> Dict[str, Any]:
        """
        Get bandwidth usage statistics for a user.

        Returns:
            Dictionary with current token count, limit, stream count, etc.
        """
        redis_client = await get_redis()
        if not redis_client:
            return {"error": "Redis unavailable"}

        bucket_key = f"bandwidth:bucket:{user_id}"
        last_refill_key = f"bandwidth:refill:{user_id}"
        streams_key = f"bandwidth:streams:{user_id}"

        try:
            # Fetch all values
            current_tokens = await redis_client.get(bucket_key)
            last_refill = await redis_client.get(last_refill_key)
            stream_count = await redis_client.get(streams_key)
            user_limit = await self.get_user_limit(user_id)

            if current_tokens is None:
                return {
                    "user_id": user_id,
                    "status": "no_active_transfers",
                    "available_tokens": 0,
                    "limit_mbps": user_limit,
                    "stream_count": int(stream_count) if stream_count else 0,
                    "max_streams": self.MAX_STREAMS_PER_USER,
                }

            current_tokens = float(current_tokens)
            last_refill = float(last_refill) if last_refill else time.time()

            # Calculate utilization
            bytes_per_second = (user_limit * 1024 * 1024) / 8
            bucket_capacity = bytes_per_second * self.burst_multiplier
            utilization = ((bucket_capacity - current_tokens) / bucket_capacity) * 100

            return {
                "user_id": user_id,
                "status": "active",
                "available_tokens": current_tokens,
                "bucket_capacity": bucket_capacity,
                "utilization_percent": round(max(0, min(100, utilization)), 2),
                "limit_mbps": user_limit,
                "burst_capacity_mbps": user_limit * self.burst_multiplier,
                "last_refill": last_refill,
                "stream_count": int(stream_count) if stream_count else 0,
                "max_streams": self.MAX_STREAMS_PER_USER,
            }

        except Exception as e:
            logger.error(f"Error getting bandwidth stats: {e}")
            return {"error": str(e)}

    async def set_user_limit(self, user_id: str, limit_mbps: float) -> bool:
        """
        Set bandwidth limit for a specific user.

        Args:
            user_id: User identifier
            limit_mbps: Bandwidth limit in Mbps

        Returns:
            True if successful
        """
        redis_client = await get_redis()
        if not redis_client:
            logger.warning("Redis unavailable - cannot set bandwidth limit")
            return False

        limit_key = f"bandwidth:limit:{user_id}"
        try:
            await redis_client.setex(limit_key, 86400, str(limit_mbps))  # 24 hour TTL
            logger.info(f"Set bandwidth limit for {user_id}: {limit_mbps} Mbps")
            return True
        except Exception as e:
            logger.error(f"Failed to set bandwidth limit: {e}")
            return False

    async def clear_user_limit(self, user_id: str) -> bool:
        """Remove custom bandwidth limit for a user"""
        redis_client = await get_redis()
        if not redis_client:
            return False

        limit_key = f"bandwidth:limit:{user_id}"
        try:
            await redis_client.delete(limit_key)
            return True
        except Exception as e:
            logger.error(f"Failed to clear bandwidth limit: {e}")
            return False

    async def get_all_active_users_stats(self) -> Dict[str, Any]:
        """
        Get bandwidth stats for all active users.
        Fix #5: Uses SCAN instead of KEYS to avoid blocking Redis.

        Returns:
            Dictionary with all active users' stats
        """
        redis_client = await get_redis()
        if not redis_client:
            return {"error": "Redis unavailable"}

        try:
            active_users = {}

            # Fix #5: Use scan_iter instead of keys() to avoid O(N) blocking
            async for key in redis_client.scan_iter("bandwidth:bucket:*", count=100):
                key_str = key.decode() if isinstance(key, bytes) else key
                user_id = key_str.split(":")[-1]

                if user_id not in active_users:
                    stats = await self.get_usage_stats(user_id)
                    if stats.get("status") == "active":
                        active_users[user_id] = stats

            return {
                "active_user_count": len(active_users),
                "users": active_users
            }

        except Exception as e:
            logger.error(f"Error getting all users stats: {e}")
            return {"error": str(e)}


# Singleton instance
bandwidth_throttle_service = BandwidthThrottleService()
