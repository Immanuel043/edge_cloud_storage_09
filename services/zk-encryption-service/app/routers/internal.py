"""
Internal API Endpoints for Service-to-Service Communication

Provides internal-only endpoints for cross-service operations.
These endpoints are secured with an internal API key and should
not be exposed to public clients.
"""
from fastapi import APIRouter, Depends, HTTPException, Header
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.models.database import ZKUser
from app.config import settings

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
        raise HTTPException(
            status_code=500,
            detail="Internal API key not configured"
        )

    if x_internal_api_key != settings.INTERNAL_SERVICE_API_KEY:
        raise HTTPException(
            status_code=403,
            detail="Invalid internal API key"
        )
    return True


@router.get("/check-email")
async def check_email_exists(
    email: str,
    db: AsyncSession = Depends(get_db),
    _: bool = Depends(verify_internal_api_key)
):
    """
    Check if email exists in ZK service (internal use only)

    Args:
        email: Email address to check
        db: Database session
        _: Internal API key verification dependency

    Returns:
        dict: {"exists": bool}
    """
    result = await db.execute(
        select(ZKUser).filter(ZKUser.email == email.lower().strip())
    )
    user = result.scalar_one_or_none()

    return {"exists": user is not None}
