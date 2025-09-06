# services/storage-service/app/routers/auth.py

# services/storage-service/app/routers/auth.py
from fastapi import APIRouter, Depends, HTTPException, Form, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from ..dependencies import get_db, log_activity
from ..services.auth import auth_service
from ..models.database import User, Folder
from ..models.schemas import Token, UserResponse, ThemeUpdate
from ..config import settings

router = APIRouter(prefix="/api/v1/auth", tags=["authentication"])

@router.post("/register", response_model=Token)
async def register(
    email: str = Form(...),
    username: str = Form(...),
    password: str = Form(...),
    user_type: str = Form("individual"),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Register a new user"""
    # Check if user exists
    result = await db.execute(
        select(User).filter((User.email == email) | (User.username == username))
    )
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="User already exists")
    
    # Create user
    user = User(
        email=email,
        username=username,
        password_hash=auth_service.get_password_hash(password),
        user_type=user_type,
        storage_quota=settings.QUOTAS.get(user_type, settings.QUOTAS["individual"]),
    )
    db.add(user)
    await db.commit()
    
    # Create root folder
    root_folder = Folder(user_id=user.id, parent_id=None, name="/", path="/")
    db.add(root_folder)
    await db.commit()
    
    # Log activity
    await log_activity(
        db, user.id, "user_registered", 
        metadata={"user_type": user_type}, 
        request=request
    )
    
    # Create token
    access_token = auth_service.create_access_token({"sub": str(user.id), "email": email})
    
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": {
            "id": str(user.id),
            "email": email,
            "username": username,
            "user_type": user_type,
            "storage_quota": settings.QUOTAS.get(user_type),
            "storage_used": 0,
            "theme": "light"
        },
    }

@router.post("/login", response_model=Token)
async def login(
    email: str = Form(...),
    password: str = Form(...),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Login user"""
    result = await db.execute(select(User).filter(User.email == email))
    user = result.scalar_one_or_none()
    
    if not user or not auth_service.verify_password(password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account deactivated")
    
    await log_activity(db, user.id, "user_login", request=request)
    
    access_token = auth_service.create_access_token({"sub": str(user.id), "email": email})
    
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": {
            "id": str(user.id),
            "email": user.email,
            "username": user.username,
            "user_type": user.user_type,
            "storage_quota": user.storage_quota,
            "storage_used": user.storage_used,
            "theme": user.theme_preference,
        },
    }