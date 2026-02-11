"""
Rate Limiting Middleware for Billing Endpoints

Implements comprehensive rate limiting to prevent abuse of payment and billing APIs.
Uses Redis-backed rate limiting with sliding window algorithm.

Rate Limits:
- Payment creation: 10/hour per user
- Payment verification: 20/hour per user
- Subscription changes: 5/hour per user
- Webhooks: 100/minute per IP (global)
- Plan viewing: 60/minute per user
"""

import logging
import time
import threading
from collections import defaultdict
from typing import Callable, Optional
from datetime import datetime, timedelta
from fastapi import Request, HTTPException, status
from redis.asyncio import Redis
import hashlib

logger = logging.getLogger(__name__)


class InMemoryRateLimiter:
    """
    Simple in-memory fallback rate limiter using sliding window.
    Activates when Redis is unreachable.

    Note: This is per-process only - in multi-worker deployments,
    each worker tracks independently, so effective limits are multiplied
    by worker count. This is acceptable as a degraded-mode fallback.
    """

    def __init__(self):
        # key -> list of timestamps
        self._requests: dict[str, list[float]] = defaultdict(list)
        self._lock = threading.Lock()
        self._last_cleanup = time.monotonic()
        self._cleanup_interval = 60  # seconds

    def check(self, key: str, max_requests: int, window_seconds: int) -> tuple[bool, dict]:
        now = time.monotonic()
        window_start = now - window_seconds

        with self._lock:
            # Periodic cleanup of stale keys
            if now - self._last_cleanup > self._cleanup_interval:
                self._cleanup(now)
                self._last_cleanup = now

            # Remove old entries for this key
            timestamps = self._requests[key]
            self._requests[key] = [t for t in timestamps if t > window_start]
            timestamps = self._requests[key]

            if len(timestamps) >= max_requests:
                retry_after = int(timestamps[0] - window_start) + 1
                return False, {
                    "limit": max_requests,
                    "remaining": 0,
                    "reset": retry_after,
                    "retry_after": retry_after
                }

            timestamps.append(now)
            remaining = max_requests - len(timestamps)
            return True, {
                "limit": max_requests,
                "remaining": remaining,
                "reset": window_seconds,
                "retry_after": None
            }

    def _cleanup(self, now: float):
        """Remove keys with no recent requests"""
        stale_keys = [
            k for k, v in self._requests.items()
            if not v or v[-1] < now - 7200  # 2 hours stale
        ]
        for k in stale_keys:
            del self._requests[k]


# Singleton fallback limiter shared across all RateLimiter instances
_fallback_limiter = InMemoryRateLimiter()


class RateLimitConfig:
    """Rate limit configurations for different endpoint types"""

    # Payment endpoints - strict limits to prevent abuse
    PAYMENT_CREATE = {"requests": 10, "window": 3600}  # 10 per hour
    PAYMENT_VERIFY = {"requests": 20, "window": 3600}  # 20 per hour

    # Subscription management - moderate limits
    SUBSCRIPTION_CREATE = {"requests": 5, "window": 3600}  # 5 per hour
    SUBSCRIPTION_MODIFY = {"requests": 5, "window": 3600}  # 5 per hour (upgrade/downgrade)
    SUBSCRIPTION_CANCEL = {"requests": 3, "window": 3600}  # 3 per hour

    # Billing portal - moderate access
    BILLING_PORTAL = {"requests": 10, "window": 3600}  # 10 per hour

    # Webhooks - high volume but protected by IP
    WEBHOOK_STRIPE = {"requests": 100, "window": 60}  # 100 per minute
    WEBHOOK_RAZORPAY = {"requests": 100, "window": 60}  # 100 per minute

    # Read-only endpoints - generous limits
    PLAN_VIEW = {"requests": 60, "window": 60}  # 60 per minute
    SUBSCRIPTION_VIEW = {"requests": 100, "window": 60}  # 100 per minute
    USAGE_VIEW = {"requests": 100, "window": 60}  # 100 per minute


class RateLimiter:
    """
    Redis-backed rate limiter with sliding window algorithm.

    Features:
    - Per-user rate limiting (authenticated endpoints)
    - Per-IP rate limiting (webhooks, public endpoints)
    - Custom rate limits per endpoint
    - Automatic key expiry
    - Rate limit headers in response
    """

    def __init__(self, redis_client: Redis):
        self.redis = redis_client

    async def check_rate_limit(
        self,
        key: str,
        max_requests: int,
        window_seconds: int,
        identifier: str = "request"
    ) -> tuple[bool, dict]:
        """
        Check if request is within rate limit using sliding window.

        Args:
            key: Redis key for rate limit tracking
            max_requests: Maximum requests allowed in window
            window_seconds: Time window in seconds
            identifier: Description for logging

        Returns:
            (is_allowed, rate_limit_info)
        """
        now = datetime.utcnow()
        window_start = now - timedelta(seconds=window_seconds)

        # Redis key for sorted set (stores request timestamps)
        redis_key = f"ratelimit:{key}"

        try:
            # Remove old entries outside the window
            await self.redis.zremrangebyscore(
                redis_key,
                0,
                window_start.timestamp()
            )

            # Count requests in current window
            current_requests = await self.redis.zcard(redis_key)

            # Check if limit exceeded
            if current_requests >= max_requests:
                # Calculate reset time
                oldest_timestamp = await self.redis.zrange(
                    redis_key, 0, 0, withscores=True
                )
                if oldest_timestamp:
                    reset_at = datetime.fromtimestamp(
                        oldest_timestamp[0][1]
                    ) + timedelta(seconds=window_seconds)
                    retry_after = int((reset_at - now).total_seconds())
                else:
                    retry_after = window_seconds

                logger.warning(
                    f"Rate limit exceeded for {identifier}",
                    extra={
                        "key": key,
                        "requests": current_requests,
                        "limit": max_requests,
                        "window": window_seconds
                    }
                )

                return False, {
                    "limit": max_requests,
                    "remaining": 0,
                    "reset": retry_after,
                    "retry_after": retry_after
                }

            # Add current request
            await self.redis.zadd(
                redis_key,
                {str(now.timestamp()): now.timestamp()}
            )

            # Set expiry on key (cleanup)
            await self.redis.expire(redis_key, window_seconds)

            # Calculate remaining requests
            remaining = max_requests - (current_requests + 1)

            return True, {
                "limit": max_requests,
                "remaining": remaining,
                "reset": window_seconds,
                "retry_after": None
            }

        except Exception as e:
            logger.error(
                f"Rate limiter Redis error, falling back to in-memory limiter: {e}",
                exc_info=True
            )
            # Use in-memory fallback instead of failing open
            return _fallback_limiter.check(key, max_requests, window_seconds)

    def get_identifier(self, request: Request) -> str:
        """
        Get unique identifier for rate limiting.

        Priority:
        1. User ID (for authenticated requests)
        2. API key (for API access)
        3. IP address (fallback)
        """
        # Try to get user ID from request state
        if hasattr(request.state, "user") and request.state.user:
            return f"user:{request.state.user.id}"

        # Try to get from Authorization header
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            # Hash the token to create stable identifier
            token_hash = hashlib.sha256(
                auth_header.encode()
            ).hexdigest()[:16]
            return f"token:{token_hash}"

        # Fallback to IP address
        # Handle X-Forwarded-For for proxied requests
        forwarded_for = request.headers.get("X-Forwarded-For")
        if forwarded_for:
            client_ip = forwarded_for.split(",")[0].strip()
        else:
            client_ip = request.client.host if request.client else "unknown"

        return f"ip:{client_ip}"

    async def apply_rate_limit(
        self,
        request: Request,
        rate_limit_config: dict,
        endpoint_name: str
    ):
        """
        Apply rate limit to request and raise HTTPException if exceeded.

        Args:
            request: FastAPI request object
            rate_limit_config: {"requests": int, "window": int}
            endpoint_name: Name of endpoint for logging

        Raises:
            HTTPException: If rate limit exceeded
        """
        identifier = self.get_identifier(request)
        key = f"{endpoint_name}:{identifier}"

        is_allowed, rate_info = await self.check_rate_limit(
            key=key,
            max_requests=rate_limit_config["requests"],
            window_seconds=rate_limit_config["window"],
            identifier=f"{endpoint_name} - {identifier}"
        )

        # Add rate limit headers to response
        request.state.rate_limit_headers = {
            "X-RateLimit-Limit": str(rate_info["limit"]),
            "X-RateLimit-Remaining": str(rate_info["remaining"]),
            "X-RateLimit-Reset": str(rate_info["reset"])
        }

        if not is_allowed:
            logger.warning(
                f"Rate limit exceeded: {endpoint_name}",
                extra={
                    "endpoint": endpoint_name,
                    "identifier": identifier,
                    "limit": rate_info["limit"]
                }
            )

            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail={
                    "error": "rate_limit_exceeded",
                    "message": f"Too many requests. Please try again in {rate_info['retry_after']} seconds.",
                    "limit": rate_info["limit"],
                    "retry_after": rate_info["retry_after"]
                },
                headers={
                    "Retry-After": str(rate_info["retry_after"]),
                    "X-RateLimit-Limit": str(rate_info["limit"]),
                    "X-RateLimit-Remaining": "0",
                    "X-RateLimit-Reset": str(rate_info["reset"])
                }
            )


def rate_limit(config: dict, endpoint_name: str):
    """
    Decorator for applying rate limits to FastAPI endpoints.

    Usage:
        @router.post("/create-payment")
        @rate_limit(RateLimitConfig.PAYMENT_CREATE, "payment_create")
        async def create_payment(...):
            ...
    """
    def decorator(func: Callable):
        async def wrapper(*args, **kwargs):
            # Extract request from kwargs
            request: Optional[Request] = kwargs.get("request")
            if not request:
                # Try to find in args
                for arg in args:
                    if isinstance(arg, Request):
                        request = arg
                        break

            if not request:
                logger.error(
                    f"Rate limiter: Could not find Request object in {endpoint_name}"
                )
                # Fail open if we can't find request
                return await func(*args, **kwargs)

            # Get rate limiter from app state
            rate_limiter: RateLimiter = request.app.state.rate_limiter

            # Apply rate limit
            await rate_limiter.apply_rate_limit(
                request=request,
                rate_limit_config=config,
                endpoint_name=endpoint_name
            )

            # Call original function
            return await func(*args, **kwargs)

        wrapper.__name__ = func.__name__
        wrapper.__doc__ = func.__doc__
        return wrapper

    return decorator


# Response middleware to add rate limit headers
async def add_rate_limit_headers(request: Request, call_next):
    """Middleware to add rate limit headers to all responses"""
    response = await call_next(request)

    # Add rate limit headers if they were set
    if hasattr(request.state, "rate_limit_headers"):
        for header, value in request.state.rate_limit_headers.items():
            response.headers[header] = value

    return response
