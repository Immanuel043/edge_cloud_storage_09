"""
Internal API Endpoints for Service-to-Service Communication

Provides internal-only endpoints for cross-service operations.
These endpoints are secured with an internal API key and should
not be exposed to public clients.
"""

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import get_db
from ..models.database import User

router = APIRouter()


async def verify_internal_api_key(x_internal_api_key: str = Header(...)):
    """
    Verify internal API key for service-to-service authentication

    Args:
        x_internal_api_key: API key from X-Internal-API-Key header

    Raises:
        HTTPException: 403 if API key is invalid

    Returns:
        bool: True if key is valid
    """
    if not settings.INTERNAL_SERVICE_API_KEY:
        raise HTTPException(status_code=500, detail="Internal API key not configured")

    if x_internal_api_key != settings.INTERNAL_SERVICE_API_KEY:
        raise HTTPException(status_code=403, detail="Invalid internal API key")
    return True


@router.get("/check-email")
async def check_email_exists(
    email: str, db: AsyncSession = Depends(get_db), _: bool = Depends(verify_internal_api_key)
):
    """
    Check if email exists in storage service (internal use only)

    Args:
        email: Email address to check
        db: Database session
        _: Internal API key verification dependency

    Returns:
        dict: {"exists": bool}
    """
    result = await db.execute(select(User).filter(User.email == email.lower().strip()))
    user = result.scalar_one_or_none()

    return {"exists": user is not None}
