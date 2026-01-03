# services/zk-encryption-service/app/services/bandwidth_throttle.py

"""
Bandwidth Throttling Service for ZK Encryption Service

Implements token bucket algorithm for per-user bandwidth limiting.
Uses Redis (DB 1) for distributed rate limiting across multiple instances.

Plan Integration:
- Plan-aware bandwidth limits (free, personal, professional, enterprise)
- Priority: DB override > Plan default
"""

import asyncio
import time
import logging
from typing import Optional, Dict, AsyncGenerator, Any
from fastapi import HTTPException

from app.redis_client import get_redis
from app.config import settings

logger = logging.getLogger(__name__)

# Lua script for atomic stream slot acquisition
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
    Token Bucket Rate Limiter for ZK Service Bandwidth Control

    Features:
    - Per-user bandwidth limits (plan-aware)
    - Redis-based for distributed systems
    - Concurrent stream limiting
    - Graceful degradation with 429 responses
    """

    # Constants
    DEFAULT_LIMIT_MBPS = 10
    BURST_MULTIPLIER = 2
    MAX_STREAMS_PER_USER = 5
    STREAM_SLOT_TTL = 300  # 5 minutes
    MAX_WAIT_SLEEP = 1.0
    LONG_WAIT_THRESHOLD = 5.0

    def __init__(self):
        self.default_limit_mbps = self.DEFAULT_LIMIT_MBPS
        self._lua_scripts_registered = False
        self._acquire_stream_sha = None
        self._consume_tokens_sha = None

    # =========================================================================
    # PLAN-AWARE METHODS
    # =========================================================================

    def get_plan_limits(self, plan_type: str) -> Dict[str, Any]:
        """
        Get bandwidth and storage limits for a ZK subscription plan.

        Args:
            plan_type: Plan tier (free, personal, professional, enterprise)

        Returns:
            Dictionary with plan limits
        """
        return settings.PLAN_LIMITS.get(plan_type, settings.PLAN_LIMITS["free"])

    def get_max_streams_for_plan(self, plan_type: str) -> int:
        """
        Get maximum concurrent streams for a ZK subscription plan.

        Args:
            plan_type: Plan tier (free, personal, professional, enterprise)

        Returns:
            Maximum number of concurrent streams allowed
        """
        plan = self.get_plan_limits(plan_type)
        # ZK plans use same bandwidth structure as storage plans
        bandwidth_mbps = plan.get("bandwidth_mbps", self.DEFAULT_LIMIT_MBPS)
        # Derive max streams from bandwidth tier
        if bandwidth_mbps >= 100:
            return 10
        elif bandwidth_mbps >= 25:
            return 5
        else:
            return 2

    def get_bandwidth_for_plan(self, plan_type: str) -> tuple[float, float]:
        """
        Get bandwidth limits for a ZK subscription plan.

        Args:
            plan_type: Plan tier (free, personal, professional, enterprise)

        Returns:
            (bandwidth_mbps, burst_mbps)
        """
        plan = self.get_plan_limits(plan_type)
        bandwidth = plan.get("bandwidth_mbps", self.DEFAULT_LIMIT_MBPS)
        burst = plan.get("burst_mbps", bandwidth * 2)
        return float(bandwidth), float(burst)

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
        2. Plan default (from PLAN_LIMITS config)

        Args:
            user_id: User identifier
            plan_type: User's subscription plan tier
            db_bandwidth_override: Optional DB-stored bandwidth override
            db_burst_override: Optional DB-stored burst override

        Returns:
            (bandwidth_mbps, burst_mbps)
        """
        # Priority 1: Database override
        if db_bandwidth_override is not None:
            burst = db_burst_override if db_burst_override else db_bandwidth_override * 2
            logger.debug(f"ZK User {user_id} using DB override: {db_bandwidth_override} Mbps")
            return float(db_bandwidth_override), float(burst)

        # Priority 2: Plan default
        bandwidth, burst = self.get_bandwidth_for_plan(plan_type)
        logger.debug(f"ZK User {user_id} using plan default ({plan_type}): {bandwidth} Mbps")
        return bandwidth, burst

    async def get_max_streams_with_plan(
        self,
        user_id: str,
        plan_type: str = "free",
        db_streams_override: Optional[int] = None
    ) -> int:
        """
        Get effective max streams for a user.

        Args:
            user_id: User identifier
            plan_type: User's subscription plan tier
            db_streams_override: Optional DB-stored streams override

        Returns:
            Maximum number of concurrent streams
        """
        if db_streams_override is not None:
            return db_streams_override
        return self.get_max_streams_for_plan(plan_type)

    # =========================================================================
    # STREAM SLOT MANAGEMENT
    # =========================================================================

    async def acquire_stream_slot(
        self,
        user_id: str,
        max_streams: int = None,
        plan_type: str = None,
        db_streams_override: int = None
    ) -> bool:
        """
        Acquire a stream slot for concurrent upload/download limiting.

        Args:
            user_id: User identifier
            max_streams: Maximum allowed concurrent streams
            plan_type: User's subscription plan tier
            db_streams_override: Database-stored streams override

        Returns:
            True if slot acquired, False if at limit
        """
        if max_streams is None:
            if db_streams_override is not None:
                max_streams = db_streams_override
            elif plan_type:
                max_streams = self.get_max_streams_for_plan(plan_type)
            else:
                max_streams = self.MAX_STREAMS_PER_USER

        try:
            redis_client = get_redis()
        except RuntimeError:
            logger.warning("Redis not available, allowing stream slot")
            return True

        key = f"zk:bandwidth:streams:{user_id}"

        try:
            current = await redis_client.eval(
                ACQUIRE_STREAM_LUA, 1, key, str(self.STREAM_SLOT_TTL)
            )

            if current > max_streams:
                await redis_client.decr(key)
                logger.info(f"ZK stream slot denied for user {user_id}: {current}/{max_streams}")
                return False

            logger.debug(f"ZK stream slot acquired for user {user_id}: {current}/{max_streams}")
            return True

        except Exception as e:
            logger.error(f"Redis error acquiring ZK stream slot: {e}")
            return True  # Fail open

    async def release_stream_slot(self, user_id: str):
        """
        Release a stream slot after transfer completes.

        Args:
            user_id: User identifier
        """
        try:
            redis_client = get_redis()
        except RuntimeError:
            return

        key = f"zk:bandwidth:streams:{user_id}"

        try:
            value = await redis_client.decr(key)
            # Prevent underflow
            if value < 0:
                await redis_client.set(key, 0, ex=self.STREAM_SLOT_TTL)
            logger.debug(f"ZK stream slot released for user {user_id}")
        except Exception as e:
            logger.error(f"Redis error releasing ZK stream slot: {e}")

    # =========================================================================
    # BANDWIDTH CHECKING
    # =========================================================================

    async def can_transfer(
        self,
        user_id: str,
        bytes_requested: int,
        limit_mbps: Optional[float] = None,
        plan_type: str = None,
        db_bandwidth_override: int = None
    ) -> tuple[bool, float]:
        """
        Check if a transfer of given bytes is allowed under bandwidth limit.

        Args:
            user_id: User identifier
            bytes_requested: Number of bytes to transfer
            limit_mbps: Bandwidth limit in Mbps (explicit override)
            plan_type: User's subscription plan tier
            db_bandwidth_override: Database-stored bandwidth override

        Returns:
            (allowed: bool, wait_time: float in seconds)
        """
        # Auto-fetch user limit with plan awareness
        if limit_mbps is None:
            if plan_type or db_bandwidth_override is not None:
                limit_mbps, _ = await self.get_user_limit_with_plan(
                    user_id, plan_type or "free", db_bandwidth_override
                )
            else:
                limit_mbps = self.default_limit_mbps

        try:
            redis_client = get_redis()
        except RuntimeError:
            logger.warning("Redis not available, allowing transfer")
            return True, 0

        # Calculate token bucket parameters
        bytes_per_second = (limit_mbps * 1_000_000) / 8
        bucket_capacity = bytes_per_second * self.BURST_MULTIPLIER

        bucket_key = f"zk:bandwidth:bucket:{user_id}"
        refill_key = f"zk:bandwidth:refill:{user_id}"
        now = time.time()
        ttl = 300

        try:
            result = await redis_client.eval(
                CONSUME_TOKENS_LUA,
                2, bucket_key, refill_key,
                str(bytes_requested),
                str(bytes_per_second),
                str(bucket_capacity),
                str(now),
                str(ttl)
            )

            allowed = bool(result[0])
            wait_time = float(result[1])
            return allowed, wait_time

        except Exception as e:
            logger.error(f"Redis error in ZK can_transfer: {e}")
            return True, 0  # Fail open

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
        Wrap a data generator with bandwidth throttling.

        Args:
            user_id: User identifier
            data_generator: Original async generator yielding data chunks
            limit_mbps: Bandwidth limit in Mbps
            raise_on_long_wait: If True, raise HTTPException 429 for long waits
            plan_type: User's subscription plan tier
            db_bandwidth_override: Database-stored bandwidth override

        Yields:
            Data chunks with throttled timing
        """
        # Auto-fetch limit once at start
        if limit_mbps is None:
            if plan_type or db_bandwidth_override is not None:
                limit_mbps, _ = await self.get_user_limit_with_plan(
                    user_id, plan_type or "free", db_bandwidth_override
                )
            else:
                limit_mbps = self.default_limit_mbps

        async for chunk in data_generator:
            chunk_size = len(chunk)
            allowed, wait_time = await self.can_transfer(
                user_id, chunk_size, limit_mbps
            )

            if not allowed:
                if raise_on_long_wait and wait_time > self.LONG_WAIT_THRESHOLD:
                    raise HTTPException(
                        status_code=429,
                        detail=f"Bandwidth limit exceeded. Retry after {int(wait_time)} seconds.",
                        headers={"Retry-After": str(int(wait_time))}
                    )
                await asyncio.sleep(min(wait_time, self.MAX_WAIT_SLEEP))

            yield chunk


# Global service instance
bandwidth_throttle_service = BandwidthThrottleService()

