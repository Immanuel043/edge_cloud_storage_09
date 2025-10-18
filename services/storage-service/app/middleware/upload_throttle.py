# services/storage-service/app/middleware/upload_throttle.py

"""
Upload Throttling Middleware

Protects against resource exhaustion by limiting:
- Concurrent uploads per user
- Total system-wide concurrent uploads
- Request rate per user
"""

import time
import asyncio
from fastapi import Request, HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from typing import Dict
from collections import defaultdict
import logging

logger = logging.getLogger(__name__)


class UploadThrottleMiddleware(BaseHTTPMiddleware):
    """
    Middleware to throttle upload requests based on:
    - Per-user concurrent upload limits
    - Global concurrent upload limits
    - Per-user request rate limits
    """

    def __init__(
        self,
        app,
        max_concurrent_uploads_per_user: int = 5,
        max_concurrent_uploads_global: int = 100,
        max_requests_per_minute: int = 60,
    ):
        super().__init__(app)
        self.max_concurrent_per_user = max_concurrent_uploads_per_user
        self.max_concurrent_global = max_concurrent_uploads_global
        self.max_requests_per_minute = max_requests_per_minute

        # Track active uploads
        self.active_uploads_per_user: Dict[str, int] = defaultdict(int)
        self.active_uploads_global = 0
        self.upload_lock = asyncio.Lock()

        # Track request rates
        self.request_times_per_user: Dict[str, list] = defaultdict(list)
        self.rate_limit_lock = asyncio.Lock()

    async def dispatch(self, request: Request, call_next):
        # Only apply to upload endpoints
        if not self._is_upload_endpoint(request):
            return await call_next(request)

        # Get user ID (assumes authentication middleware sets it)
        user_id = getattr(request.state, "user_id", None)
        if not user_id:
            user_id = request.client.host  # Fallback to IP

        # Check rate limit
        if await self._is_rate_limited(user_id):
            logger.warning(f"Rate limit exceeded for user {user_id}")
            raise HTTPException(
                status_code=429,
                detail=f"Too many requests. Maximum {self.max_requests_per_minute} requests per minute.",
                headers={"Retry-After": "60"},
            )

        # Check concurrent uploads
        async with self.upload_lock:
            # Check global limit
            if self.active_uploads_global >= self.max_concurrent_global:
                logger.warning(f"Global upload limit reached: {self.active_uploads_global}")
                raise HTTPException(
                    status_code=503,
                    detail="System is at capacity. Please try again later.",
                    headers={"Retry-After": "30"},
                )

            # Check per-user limit
            if self.active_uploads_per_user[user_id] >= self.max_concurrent_per_user:
                logger.warning(
                    f"User {user_id} concurrent upload limit reached: "
                    f"{self.active_uploads_per_user[user_id]}"
                )
                raise HTTPException(
                    status_code=429,
                    detail=f"Maximum {self.max_concurrent_per_user} concurrent uploads allowed per user.",
                    headers={"Retry-After": "10"},
                )

            # Increment counters
            self.active_uploads_per_user[user_id] += 1
            self.active_uploads_global += 1

        try:
            # Process request
            response = await call_next(request)
            return response

        finally:
            # Decrement counters
            async with self.upload_lock:
                self.active_uploads_per_user[user_id] -= 1
                self.active_uploads_global -= 1

                # Cleanup if user has no active uploads
                if self.active_uploads_per_user[user_id] <= 0:
                    del self.active_uploads_per_user[user_id]

    def _is_upload_endpoint(self, request: Request) -> bool:
        """Check if this is an upload endpoint"""
        upload_paths = [
            "/api/v1/upload/chunk/",
            "/api/v1/upload/direct/",
            "/api/v1/upload/complete/",
        ]
        return any(path in request.url.path for path in upload_paths)

    async def _is_rate_limited(self, user_id: str) -> bool:
        """
        Check if user has exceeded rate limit

        Uses sliding window algorithm
        """
        async with self.rate_limit_lock:
            now = time.time()
            minute_ago = now - 60

            # Get user's request times
            request_times = self.request_times_per_user[user_id]

            # Remove old requests (older than 1 minute)
            request_times = [t for t in request_times if t > minute_ago]
            self.request_times_per_user[user_id] = request_times

            # Check if limit exceeded
            if len(request_times) >= self.max_requests_per_minute:
                return True

            # Add current request
            request_times.append(now)
            return False

    def get_stats(self) -> Dict:
        """Get current throttling statistics"""
        return {
            "active_uploads_global": self.active_uploads_global,
            "active_uploads_per_user": dict(self.active_uploads_per_user),
            "total_users_uploading": len(self.active_uploads_per_user),
            "limits": {
                "max_concurrent_per_user": self.max_concurrent_per_user,
                "max_concurrent_global": self.max_concurrent_global,
                "max_requests_per_minute": self.max_requests_per_minute,
            },
        }
