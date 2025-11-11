# services/storage-service/app/routers/auth.py
from fastapi import APIRouter, Depends, HTTPException, Form, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from ..dependencies import get_db, log_activity, get_current_user
from ..services.auth import auth_service
from ..models.database import User, Folder
from ..models.schemas import Token, UserResponse, ThemeUpdate
from ..config import settings
from ..utils.rate_limiter_v2 import auth_login_limiter, auth_register_limiter

router = APIRouter(prefix="/api/v1/auth", tags=["authentication"])

# SECURITY: Cookie configuration
COOKIE_NAME = "access_token"
COOKIE_MAX_AGE = 3600  # 1 hour
COOKIE_SECURE = settings.is_production  # HTTPS only in production
COOKIE_HTTPONLY = True  # Prevent JavaScript access (XSS protection)
COOKIE_SAMESITE = "lax"  # CSRF protection

@router.post("/register", response_model=Token, dependencies=[Depends(auth_register_limiter())])
async def register(
    request: Request,
    email: str = Form(...),
    username: str = Form(...),
    password: str = Form(...),
    user_type: str = Form("individual"),
    db: AsyncSession = Depends(get_db),
):
    """Register a new user - SECURITY FIX: Sets HTTP-only cookie + rate limiting"""
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

    # Still return token in response for backward compatibility (optional)
    response_data = {
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

    # SECURITY FIX: Set HTTP-only cookie (prevents XSS token theft)
    response = JSONResponse(content=response_data)
    response.set_cookie(
        key=COOKIE_NAME,
        value=access_token,
        max_age=COOKIE_MAX_AGE,
        httponly=COOKIE_HTTPONLY,
        secure=COOKIE_SECURE,
        samesite=COOKIE_SAMESITE,
        path="/"
    )

    return response

@router.post("/login", response_model=Token, dependencies=[Depends(auth_login_limiter())])
async def login(
    request: Request,
    email: str = Form(...),
    password: str = Form(...),
    db: AsyncSession = Depends(get_db),
):
    """Login user - SECURITY: HTTP-only cookie + rate limiting (5/min, 20/hour)"""
    result = await db.execute(select(User).filter(User.email == email))
    user = result.scalar_one_or_none()

    if not user or not auth_service.verify_password(password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account deactivated")

    await log_activity(db, user.id, "user_login", request=request)

    access_token = auth_service.create_access_token({"sub": str(user.id), "email": email})

    response_data = {
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

    # SECURITY FIX: Set HTTP-only cookie (prevents XSS token theft)
    response = JSONResponse(content=response_data)
    response.set_cookie(
        key=COOKIE_NAME,
        value=access_token,
        max_age=COOKIE_MAX_AGE,
        httponly=COOKIE_HTTPONLY,
        secure=COOKIE_SECURE,
        samesite=COOKIE_SAMESITE,
        path="/"
    )

    return response


@router.post("/logout")
async def logout(request: Request = None):
    """Logout user - SECURITY FIX: Clears HTTP-only cookie"""
    # Clear the HTTP-only cookie
    response = JSONResponse(content={"message": "Logged out successfully"})
    response.delete_cookie(
        key=COOKIE_NAME,
        path="/",
        httponly=COOKIE_HTTPONLY,
        secure=COOKIE_SECURE,
        samesite=COOKIE_SAMESITE
    )

    return response


@router.get("/session-token")
async def session_token(current_user: User = Depends(get_current_user)):
    """
    Issue a fresh short-lived access token for use in query-authenticated requests
    (e.g., video streaming where cookies are not forwarded).
    """
    access_token = auth_service.create_access_token({
        "sub": str(current_user.id),
        "email": current_user.email
    })
    return {"access_token": access_token}
