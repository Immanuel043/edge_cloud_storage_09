"""
FastAPI Dependencies

Dependency injection functions for authentication, database, and other shared resources.
"""
import jwt
import structlog
from typing import Optional
from datetime import datetime, timedelta
from fastapi import Depends, HTTPException, status, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.config import settings
from app.database import get_db
from app.redis_client import get_redis, RateLimitService

logger = structlog.get_logger()

# HTTP Bearer token security
security = HTTPBearer()


# ========== JWT TOKEN MANAGEMENT ==========

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """
    Create JWT access token.

    Args:
        data: Payload data (should include 'sub' for user ID)
        expires_delta: Token expiration time (default from config)

    Returns:
        Encoded JWT token
    """
    to_encode = data.copy()

    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)

    to_encode.update({"exp": expire, "iat": datetime.utcnow()})

    encoded_jwt = jwt.encode(
        to_encode,
        settings.SECRET_KEY,
        algorithm=settings.ALGORITHM
    )

    return encoded_jwt


def verify_token(token: str) -> Optional[dict]:
    """
    Verify and decode JWT token.

    Args:
        token: JWT token string

    Returns:
        Decoded payload or None if invalid

    Raises:
        HTTPException: If token is invalid or expired
    """
    try:
        payload = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM]
        )
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has expired",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except jwt.JWTError as e:
        logger.warning("jwt_verification_failed", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )


# Cookie name for session token (must match auth_zk.py)
COOKIE_NAME = "access_token"


# ========== USER AUTHENTICATION DEPENDENCIES ==========

async def get_current_user(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(HTTPBearer(auto_error=False)),
    db: AsyncSession = Depends(get_db)
):
    """
    Get current authenticated user from JWT token.

    Checks for token in:
    1. Authorization header (Bearer token)
    2. HTTP-only cookie (access_token)

    Args:
        request: FastAPI request object
        credentials: Optional HTTP Authorization header with Bearer token
        db: Database session

    Returns:
        User object from database

    Raises:
        HTTPException: If user not found or token invalid
    """
    token = None

    # First, try Authorization header
    if credentials:
        token = credentials.credentials
    # Fallback to cookie
    elif COOKIE_NAME in request.cookies:
        token = request.cookies[COOKIE_NAME]

    if not token:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not authenticated",
        )

    payload = verify_token(token)

    user_id = payload.get("sub")
    if user_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
        )

    # Import here to avoid circular dependency
    from app.models.database import User

    # Fetch user from database
    result = await db.execute(
        select(User).filter(User.id == user_id)
    )
    user = result.scalar_one_or_none()

    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User account is inactive",
        )

    return user


async def get_current_zk_user(
    user=Depends(get_current_user)
):
    """
    Get current user and verify ZK encryption is enabled.

    Args:
        user: Current authenticated user

    Returns:
        User object with zk_enabled=True

    Raises:
        HTTPException: If ZK not enabled for user
    """
    if not user.zk_enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Zero-knowledge encryption not enabled for this user. Visit Settings to enable.",
        )

    return user


async def get_optional_user(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(HTTPBearer(auto_error=False)),
    db: AsyncSession = Depends(get_db)
):
    """
    Get current user if authenticated, None otherwise.

    Checks for token in:
    1. Authorization header (Bearer token)
    2. HTTP-only cookie (access_token)

    Useful for endpoints that work both with and without authentication.

    Args:
        request: FastAPI request object
        credentials: Optional HTTP Authorization header
        db: Database session

    Returns:
        User object or None
    """
    token = None

    # Try Authorization header first
    if credentials:
        token = credentials.credentials
    # Fallback to cookie
    elif COOKIE_NAME in request.cookies:
        token = request.cookies[COOKIE_NAME]

    if not token:
        return None

    try:
        payload = verify_token(token)
        user_id = payload.get("sub")

        if user_id is None:
            return None

        from app.models.database import User

        result = await db.execute(
            select(User).filter(User.id == user_id)
        )
        return result.scalar_one_or_none()
    except HTTPException:
        return None


# ========== RATE LIMITING DEPENDENCIES ==========

async def rate_limit_login(request: Request):
    """
    Rate limit for login attempts.

    Args:
        request: FastAPI request

    Raises:
        HTTPException: If rate limit exceeded
    """
    if not settings.RATE_LIMIT_ENABLED:
        return

    # Get identifier (IP address)
    client_ip = request.client.host if request.client else "unknown"

    # Check rate limit (5 login attempts per 15 minutes)
    is_allowed, remaining = await RateLimitService.check_rate_limit(
        identifier=client_ip,
        action="login",
        max_requests=settings.MAX_FAILED_LOGIN_ATTEMPTS,
        window_seconds=settings.LOGIN_LOCKOUT_DURATION_MINUTES * 60
    )

    if not is_allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Too many login attempts. Try again in {settings.LOGIN_LOCKOUT_DURATION_MINUTES} minutes.",
        )


async def rate_limit_recovery(request: Request, user_id: str):
    """
    Rate limit for recovery attempts.

    Args:
        request: FastAPI request
        user_id: User ID attempting recovery

    Raises:
        HTTPException: If rate limit exceeded
    """
    if not settings.RATE_LIMIT_ENABLED:
        return

    # Check rate limit (3 recovery attempts per 15 minutes per user)
    is_allowed, remaining = await RateLimitService.check_rate_limit(
        identifier=user_id,
        action="recovery",
        max_requests=settings.RATE_LIMIT_RECOVERY_ATTEMPTS,
        window_seconds=settings.RECOVERY_ATTEMPT_WINDOW_MINUTES * 60
    )

    if not is_allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Too many recovery attempts. Try again in {settings.RECOVERY_ATTEMPT_WINDOW_MINUTES} minutes.",
        )


async def rate_limit_api(request: Request, user=Depends(get_optional_user)):
    """
    General API rate limiting.

    Args:
        request: FastAPI request
        user: Current user (optional)

    Raises:
        HTTPException: If rate limit exceeded
    """
    if not settings.RATE_LIMIT_ENABLED:
        return

    # Use user ID if authenticated, otherwise IP
    if user:
        identifier = str(user.id)
    else:
        identifier = request.client.host if request.client else "unknown"

    # Check rate limit (60 requests per minute)
    is_allowed, remaining = await RateLimitService.check_rate_limit(
        identifier=identifier,
        action="api",
        max_requests=settings.RATE_LIMIT_REQUESTS_PER_MINUTE,
        window_seconds=60
    )

    if not is_allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="API rate limit exceeded. Please slow down.",
        )


# ========== SUBSCRIPTION TIER DEPENDENCIES ==========

async def require_pro_tier(user=Depends(get_current_user)):
    """
    Require user to have Pro tier or higher.

    Args:
        user: Current authenticated user

    Returns:
        User object

    Raises:
        HTTPException: If user doesn't have required tier
    """
    # TODO: Check user's subscription tier
    # For now, allow if ZK is enabled (which requires Pro+)
    if not user.zk_enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This feature requires Pro tier or higher. Upgrade your subscription.",
        )

    return user


async def require_premium_tier(user=Depends(get_current_user)):
    """
    Require user to have Premium tier or higher.

    Args:
        user: Current authenticated user

    Returns:
        User object

    Raises:
        HTTPException: If user doesn't have required tier
    """
    # TODO: Implement proper tier checking
    # For now, check if hardware keys feature is available
    # (Premium tier feature - to be implemented)

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="This feature requires Premium tier. Upgrade to access hardware key support.",
    )


# ========== HELPER FUNCTIONS ==========

def get_client_ip(request: Request) -> str:
    """
    Get client IP address from request.

    Args:
        request: FastAPI request

    Returns:
        Client IP address
    """
    # Check for proxy headers first
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()

    real_ip = request.headers.get("X-Real-IP")
    if real_ip:
        return real_ip

    # Fallback to direct client
    return request.client.host if request.client else "unknown"


def get_user_agent(request: Request) -> str:
    """
    Get user agent from request.

    Args:
        request: FastAPI request

    Returns:
        User agent string
    """
    return request.headers.get("User-Agent", "unknown")
