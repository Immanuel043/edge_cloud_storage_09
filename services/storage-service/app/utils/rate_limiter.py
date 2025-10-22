"""Advanced rate limiting with Redis backend using SlowAPI"""
from slowapi import Limiter
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from fastapi import Request, Response
from typing import Callable
import logging

from ..config import settings

logger = logging.getLogger(__name__)

# Initialize rate limiter with Redis storage
# NOTE: headers_enabled=False to avoid needing response parameter in endpoints
limiter = Limiter(
    key_func=get_remote_address,
    storage_uri=settings.REDIS_URL,
    default_limits=["1000/day", "100/hour"],
    headers_enabled=False  # Disabled to work without response parameter
)


def get_user_id_from_request(request: Request) -> str:
    """
    Extract user ID from JWT token for user-based rate limiting

    NOTE: This must be synchronous for slowapi compatibility

    Args:
        request: FastAPI request object

    Returns:
        User ID if authenticated, otherwise IP address
    """
    try:
        # Try to get user from request state (set by auth middleware)
        if hasattr(request.state, 'user') and request.state.user:
            return f"user:{request.state.user.id}"
    except Exception as e:
        logger.debug(f"Could not extract user from request: {e}")

    # Fall back to IP address
    return f"ip:{get_remote_address(request)}"


# User-based limiter (for authenticated requests)
# NOTE: headers_enabled=False to avoid needing response parameter in endpoints
user_limiter = Limiter(
    key_func=get_user_id_from_request,
    storage_uri=settings.REDIS_URL,
    headers_enabled=False  # Disabled to work without response parameter
)


class RateLimitConfig:
    """Rate limit configurations for different endpoint types"""

    # Public endpoints (stricter limits)
    PUBLIC = "20/minute"

    # Authentication endpoints
    AUTH_LOGIN = "5/minute;20/hour"
    AUTH_REGISTER = "3/hour;10/day"
    AUTH_PASSWORD_RESET = "3/hour;10/day"
    AUTH_REFRESH_TOKEN = "10/minute;100/hour"

    # File operations (user-based)
    FILE_UPLOAD = "50/hour;500/day"
    FILE_DOWNLOAD = "200/hour;2000/day"
    FILE_DELETE = "100/hour;500/day"
    FILE_LIST = "500/hour;3000/day"
    FILE_UPDATE = "100/hour;500/day"

    # Search operations
    SEARCH = "100/hour;1000/day"
    ADVANCED_SEARCH = "50/hour;500/day"

    # API endpoints (read operations)
    API_READ = "500/hour;5000/day"
    API_WRITE = "100/hour;1000/day"
    API_HEAVY = "50/hour;200/day"  # For resource-intensive operations

    # Sharing operations
    SHARE_CREATE = "50/hour;200/day"
    SHARE_ACCESS = "1000/hour;10000/day"

    # ML operations (resource-intensive)
    ML_PREDICTION = "100/hour;500/day"
    ML_ANALYSIS = "50/hour;200/day"

    # Admin endpoints
    ADMIN = "1000/hour;10000/day"

    # WebSocket connections
    WEBSOCKET_CONNECT = "10/minute;100/hour"

    # OAuth endpoints
    OAUTH_LOGIN = "10/minute;50/hour"
    OAUTH_CALLBACK = "20/minute;100/hour"


async def rate_limit_exceeded_handler(request: Request, exc: RateLimitExceeded) -> Response:
    """
    Custom handler for rate limit exceeded errors

    Args:
        request: FastAPI request object
        exc: RateLimitExceeded exception

    Returns:
        JSON response with rate limit information
    """
    from fastapi.responses import JSONResponse

    # Calculate retry_after
    retry_after = exc.retry_after if hasattr(exc, 'retry_after') else 60

    # Log rate limit hit
    logger.warning(
        f"Rate limit exceeded for {request.url.path} "
        f"from {get_remote_address(request)} "
        f"(limit: {exc.limit if hasattr(exc, 'limit') else 'unknown'})"
    )

    response_data = {
        "error": "rate_limit_exceeded",
        "message": "Too many requests. Please try again later.",
        "retry_after": retry_after,
        "limit": getattr(exc, 'limit', None),
        "window": getattr(exc, 'window', None),
    }

    return JSONResponse(
        status_code=429,
        content=response_data,
        headers={
            "Retry-After": str(retry_after),
            "X-RateLimit-Limit": str(getattr(exc, 'limit', '')),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": str(getattr(exc, 'reset', '')),
        }
    )


def create_custom_rate_limiter(
    rate: str,
    key_func: Callable = None,
    scope: str = None
) -> Callable:
    """
    Create a custom rate limiter with specific configuration

    Args:
        rate: Rate limit string (e.g., "10/minute;100/hour")
        key_func: Function to extract key from request
        scope: Optional scope for the rate limit

    Returns:
        Rate limiter function
    """
    custom_limiter = Limiter(
        key_func=key_func or get_remote_address,
        storage_uri=settings.REDIS_URL,
        headers_enabled=True,
        default_limits=[rate]
    )

    return custom_limiter.limit(rate, scope=scope)


# Helper function to check if user should bypass rate limits
async def should_bypass_rate_limit(request: Request) -> bool:
    """
    Check if request should bypass rate limiting

    Args:
        request: FastAPI request object

    Returns:
        True if should bypass, False otherwise
    """
    # Check if user is admin or has special permissions
    if hasattr(request.state, 'user') and request.state.user:
        user = request.state.user

        # Admins bypass rate limits
        if hasattr(user, 'is_admin') and user.is_admin:
            return True

        # Premium users get higher limits (handled separately)
        # This function just checks for complete bypass

    return False


# Export commonly used limiters
__all__ = [
    'limiter',
    'user_limiter',
    'RateLimitConfig',
    'rate_limit_exceeded_handler',
    'create_custom_rate_limiter',
    'should_bypass_rate_limit'
]
