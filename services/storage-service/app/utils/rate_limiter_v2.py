"""
Production-Grade Rate Limiting with fastapi-limiter

This module provides rate limiting functionality using fastapi-limiter,
which uses Redis + Lua scripts for atomic operations and includes
proper X-RateLimit-* headers in responses.
"""

import logging
from typing import Callable, Optional

from fastapi import Request, Response
from fastapi_limiter.depends import RateLimiter
from jose import JWTError, jwt
from slowapi.util import get_remote_address

from ..config import settings

logger = logging.getLogger(__name__)


class RateLimitConfig:
    """Rate limit configurations for different endpoint types"""

    # Public endpoints (stricter limits)
    PUBLIC = {"times": 20, "minutes": 1}

    # Authentication endpoints
    AUTH_LOGIN = {"times": 5, "minutes": 1}  # 5/minute
    AUTH_REGISTER = {"times": 3, "hours": 1}  # 3/hour
    AUTH_PASSWORD_RESET = {"times": 3, "hours": 1}
    AUTH_REFRESH_TOKEN = {"times": 10, "minutes": 1}

    # File operations (user-based)
    FILE_UPLOAD = {"times": 100, "hours": 1}  # For upload init
    CHUNK_UPLOAD = {"times": 5000, "hours": 1}  # For chunk uploads (large files need many chunks)
    FILE_DOWNLOAD = {"times": 200, "hours": 1}
    FILE_DELETE = {"times": 100, "hours": 1}
    FILE_LIST = {"times": 500, "hours": 1}
    FILE_UPDATE = {"times": 100, "hours": 1}

    # Search operations
    SEARCH = {"times": 100, "hours": 1}
    ADVANCED_SEARCH = {"times": 50, "hours": 1}

    # API endpoints (read operations)
    API_READ = {"times": 500, "hours": 1}
    API_WRITE = {"times": 100, "hours": 1}
    API_HEAVY = {"times": 50, "hours": 1}

    # Sharing operations
    SHARE_CREATE = {"times": 50, "hours": 1}
    SHARE_ACCESS = {"times": 1000, "hours": 1}

    # ML operations (resource-intensive)
    ML_PREDICTION = {"times": 100, "hours": 1}
    ML_ANALYSIS = {"times": 50, "hours": 1}

    # Admin endpoints
    ADMIN = {"times": 1000, "hours": 1}

    # WebSocket connections
    WEBSOCKET_CONNECT = {"times": 10, "minutes": 1}

    # OAuth endpoints
    OAUTH_LOGIN = {"times": 10, "minutes": 1}
    OAUTH_CALLBACK = {"times": 20, "minutes": 1}


def _real_client_ip(request: Request) -> str:
    """
    Resolve the real client IP behind the nginx proxy.

    nginx sets X-Real-IP to $remote_addr (overwriting any client-sent value),
    so it is NOT spoofable through this proxy. X-Forwarded-For is
    $proxy_add_x_forwarded_for (appends to client-sent value) and MUST NOT
    be trusted as the first hop.
    """
    xri = request.headers.get("x-real-ip")
    if xri:
        xri = xri.strip()
        if xri:
            return xri
    return get_remote_address(request)


def _bearer_from_header(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    parts = value.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return None


async def get_ip_identifier(request: Request) -> str:
    """IP-only identifier. Use for unauthenticated endpoints (login/register/reset)."""
    return f"ip:{_real_client_ip(request)}"


async def get_user_or_ip_identifier(request: Request) -> str:
    """
    User-aware identifier for authenticated endpoints.

    Decodes the JWT signature-only (no DB lookups, no blocklist checks —
    the limiter fires on every request and must stay cheap). A forged token
    cannot pass signature verification without SECRET_KEY, so isolating by
    `sub` is safe for bucketing. Typed tokens (download/password_reset/
    registration) are rejected so they fall through to IP scoping.
    """
    token = (
        request.cookies.get("access_token")
        or _bearer_from_header(request.headers.get("authorization"))
        or request.query_params.get("token")
    )
    if token:
        try:
            payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
            if payload.get("type") is None:
                sub = payload.get("sub")
                if sub:
                    return f"user:{sub}"
        except JWTError:
            pass
    return f"ip:{_real_client_ip(request)}"


# Back-compat alias (no external consumers currently).
get_user_identifier = get_user_or_ip_identifier


async def rate_limit_callback(request: Request, response: Response, pexpire: int):
    """
    Custom callback for rate limit exceeded responses.

    This callback is called when rate limits are exceeded and provides
    proper error responses with rate limit information.

    Args:
        request: FastAPI request object
        response: FastAPI response object
        pexpire: Milliseconds until rate limit resets
    """
    from fastapi import HTTPException

    # Calculate retry_after in seconds
    retry_after = int(pexpire / 1000) if pexpire else 60

    # Log rate limit hit
    client_ip = request.client.host if request.client else "unknown"
    logger.warning(
        f"Rate limit exceeded for {request.url.path} "
        f"from {client_ip} "
        f"(retry after {retry_after}s)"
    )

    # Set rate limit headers
    response.headers["Retry-After"] = str(retry_after)
    response.headers["X-RateLimit-Reset"] = str(int(pexpire / 1000))

    raise HTTPException(
        status_code=429,
        detail={
            "error": "rate_limit_exceeded",
            "message": "Too many requests. Please try again later.",
            "retry_after": retry_after,
        },
    )


def create_rate_limiter(**kwargs) -> RateLimiter:
    """User-scoped limiter for authenticated routes (IP fallback when no token)."""
    return RateLimiter(
        **kwargs,
        identifier=get_user_or_ip_identifier,
        callback=rate_limit_callback,
    )


def create_ip_rate_limiter(**kwargs) -> RateLimiter:
    """IP-only limiter. Use for unauthenticated routes (login/register/reset)
    where an authenticated caller must not share the bucket with themselves
    across sessions or with other users at the same IP."""
    return RateLimiter(
        **kwargs,
        identifier=get_ip_identifier,
        callback=rate_limit_callback,
    )


# Pre-configured rate limiters for common use cases
auth_login_limiter = lambda: create_ip_rate_limiter(**RateLimitConfig.AUTH_LOGIN)
auth_register_limiter = lambda: create_ip_rate_limiter(**RateLimitConfig.AUTH_REGISTER)
auth_password_reset_limiter = lambda: create_ip_rate_limiter(**RateLimitConfig.AUTH_PASSWORD_RESET)
file_upload_limiter = lambda: create_rate_limiter(**RateLimitConfig.FILE_UPLOAD)
file_download_limiter = lambda: create_rate_limiter(**RateLimitConfig.FILE_DOWNLOAD)
api_read_limiter = lambda: create_rate_limiter(**RateLimitConfig.API_READ)
api_write_limiter = lambda: create_rate_limiter(**RateLimitConfig.API_WRITE)


__all__ = [
    "RateLimitConfig",
    "create_rate_limiter",
    "create_ip_rate_limiter",
    "get_user_identifier",
    "get_user_or_ip_identifier",
    "get_ip_identifier",
    "rate_limit_callback",
    "auth_login_limiter",
    "auth_register_limiter",
    "auth_password_reset_limiter",
    "file_upload_limiter",
    "file_download_limiter",
    "api_read_limiter",
    "api_write_limiter",
]
