# services/storage-service/app/dependencies.py
from typing import AsyncGenerator
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import Request, Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from sqlalchemy import select
from .database import AsyncSessionLocal
from .models.database import User, ActivityLog
from .config import settings

# Security
security = HTTPBearer()

async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Get database session"""
    async with AsyncSessionLocal() as session:
        yield session

async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db)
) -> User:
    """Get the current authenticated user from JWT token"""
    token = credentials.credentials
    
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        user_id = payload.get("sub")
        if user_id is None:
            raise HTTPException(status_code=401, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    result = await db.execute(select(User).filter(User.id == user_id))
    user = result.scalar_one_or_none()
    
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")
    
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account deactivated")
    
    return user

async def get_current_user_ws(token: str):
    """WebSocket authentication dependency"""
    from .database import get_db
    from .services.auth import auth_service
    
    async with get_db() as db:
        user = await auth_service.get_current_user_from_token(token, db)
        if not user:
            return None
        return user

async def log_activity(
    db: AsyncSession,
    user_id: str,
    action: str,
    object_id: str = None,
    metadata: dict = None,
    request: Request = None,
):
    """Log user activity"""
    activity = ActivityLog(
        user_id=user_id,
        action=action,
        object_id=object_id,
        ip_address=request.client.host if request else None,
        user_agent=request.headers.get("user-agent") if request else None,
        meta_data=metadata,
    )
    db.add(activity)
    await db.commit()