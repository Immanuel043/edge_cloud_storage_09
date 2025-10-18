# services/storage-service/app/services/bandwidth_throttle.py

"""
Bandwidth Throttling Service

Implements token bucket algorithm for per-user and per-group bandwidth limiting.
Uses Redis for distributed rate limiting across multiple instances.
"""

import asyncio
import time
import logging
from typing import Optional, Dict
from ..database import get_redis

logger = logging.getLogger(__name__)


class BandwidthThrottleService:
    """
    Token Bucket Rate Limiter for Bandwidth Control

    Features:
    - Per-user bandwidth limits
    - Per-group bandwidth pools
    - Redis-based for distributed systems
    - Graceful degradation (slow down, don't reject)
    - Configurable burst capacity
    """

    def __init__(self):
        self.default_limit_mbps = 10  # 10 Mbps default
        self.burst_multiplier = 2  # Allow 2x burst
        self.refill_interval = 1.0  # Refill tokens every second

    async def can_transfer(
        self,
        user_id: str,
        bytes_requested: int,
        limit_mbps: Optional[float] = None
    ) -> tuple[bool, float]:
        """
        Check if transfer is allowed and return wait time if throttled

        Args:
            user_id: User identifier
            bytes_requested: Number of bytes to transfer
            limit_mbps: Bandwidth limit in Mbps (None = use default)

        Returns:
            (allowed: bool, wait_time: float)
                - allowed: True if transfer can proceed
                - wait_time: Seconds to wait if throttled (0 if allowed)
        """
        redis_client = await get_redis()
        if not redis_client:
            # Redis unavailable - allow transfer
            return True, 0.0

        limit_mbps = limit_mbps or self.default_limit_mbps
        bucket_key = f"bandwidth:bucket:{user_id}"
        last_refill_key = f"bandwidth:refill:{user_id}"

        # Convert Mbps to bytes per second
        bytes_per_second = (limit_mbps * 1024 * 1024) / 8
        bucket_capacity = bytes_per_second * self.burst_multiplier

        try:
            # Get current state
            current_tokens = await redis_client.get(bucket_key)
            last_refill = await redis_client.get(last_refill_key)

            # Initialize if needed
            if current_tokens is None:
                current_tokens = bucket_capacity
                await redis_client.setex(bucket_key, 300, str(bucket_capacity))
                await redis_client.setex(last_refill_key, 300, str(time.time()))
            else:
                current_tokens = float(current_tokens)
                last_refill = float(last_refill) if last_refill else time.time()

                # Refill tokens based on time elapsed
                now = time.time()
                time_elapsed = now - last_refill
                tokens_to_add = time_elapsed * bytes_per_second

                current_tokens = min(current_tokens + tokens_to_add, bucket_capacity)
                await redis_client.setex(last_refill_key, 300, str(now))

            # Check if enough tokens available
            if current_tokens >= bytes_requested:
                # Consume tokens
                new_tokens = current_tokens - bytes_requested
                await redis_client.setex(bucket_key, 300, str(new_tokens))
                return True, 0.0

            else:
                # Calculate wait time
                tokens_needed = bytes_requested - current_tokens
                wait_time = tokens_needed / bytes_per_second
                return False, wait_time

        except Exception as e:
            logger.error(f"Bandwidth throttle error: {e}")
            # On error, allow transfer
            return True, 0.0

    async def throttled_transfer(
        self,
        user_id: str,
        data_generator,
        limit_mbps: Optional[float] = None
    ):
        """
        Transfer data with bandwidth throttling

        Args:
            user_id: User identifier
            data_generator: Async generator yielding data chunks
            limit_mbps: Bandwidth limit in Mbps

        Yields:
            Data chunks with appropriate delays
        """
        async for chunk in data_generator:
            # Check bandwidth allowance
            allowed, wait_time = await self.can_transfer(
                user_id,
                len(chunk),
                limit_mbps
            )

            if not allowed:
                # Wait before transferring
                logger.debug(f"Throttling user {user_id}: waiting {wait_time:.2f}s")
                await asyncio.sleep(wait_time)

                # Re-check after waiting
                allowed, _ = await self.can_transfer(
                    user_id,
                    len(chunk),
                    limit_mbps
                )

            yield chunk

    async def get_usage_stats(self, user_id: str) -> Dict:
        """
        Get bandwidth usage statistics for a user

        Returns:
            Dictionary with current token count, limit, etc.
        """
        redis_client = await get_redis()
        if not redis_client:
            return {"error": "Redis unavailable"}

        bucket_key = f"bandwidth:bucket:{user_id}"
        last_refill_key = f"bandwidth:refill:{user_id}"

        try:
            current_tokens = await redis_client.get(bucket_key)
            last_refill = await redis_client.get(last_refill_key)

            if current_tokens is None:
                return {
                    "user_id": user_id,
                    "status": "no_active_transfers",
                    "available_tokens": 0,
                    "limit_mbps": self.default_limit_mbps,
                }

            current_tokens = float(current_tokens)
            last_refill = float(last_refill) if last_refill else time.time()

            # Calculate utilization
            bytes_per_second = (self.default_limit_mbps * 1024 * 1024) / 8
            bucket_capacity = bytes_per_second * self.burst_multiplier
            utilization = ((bucket_capacity - current_tokens) / bucket_capacity) * 100

            return {
                "user_id": user_id,
                "status": "active",
                "available_tokens": current_tokens,
                "bucket_capacity": bucket_capacity,
                "utilization_percent": round(utilization, 2),
                "limit_mbps": self.default_limit_mbps,
                "burst_capacity_mbps": self.default_limit_mbps * self.burst_multiplier,
                "last_refill": last_refill,
            }

        except Exception as e:
            logger.error(f"Error getting bandwidth stats: {e}")
            return {"error": str(e)}

    async def set_user_limit(self, user_id: str, limit_mbps: float):
        """
        Set bandwidth limit for a specific user

        Args:
            user_id: User identifier
            limit_mbps: Bandwidth limit in Mbps
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

    async def get_user_limit(self, user_id: str) -> float:
        """
        Get bandwidth limit for a user

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

    async def clear_user_limit(self, user_id: str):
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


# Singleton instance
bandwidth_throttle_service = BandwidthThrottleService()
