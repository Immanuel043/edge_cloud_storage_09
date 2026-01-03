# services/storage-service/app/routers/auth.py
from fastapi import APIRouter, Depends, HTTPException, Form, Request, Response, Body
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from datetime import timedelta
from ..dependencies import get_db, log_activity, get_current_user
from ..services.auth import auth_service
from ..services.email_service import email_service
from ..services.verification_service import verification_service
from ..models.database import User, Folder
from ..models.schemas import (
    Token, UserResponse, ThemeUpdate,
    RegisterInitRequest, RegisterVerifyRequest, RegisterCompleteRequest,
    ResendCodeRequest, VerificationResponse
)
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
    plan_type: str = Form("free"),
    db: AsyncSession = Depends(get_db),
):
    """Register a new user - SECURITY FIX: Sets HTTP-only cookie + rate limiting"""
    # Check if user exists
    result = await db.execute(
        select(User).filter((User.email == email) | (User.username == username))
    )
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="User already exists")

    # Get plan limits for the plan type (Normal storage only - ZK is separate service)
    plan_limits = settings.PLAN_LIMITS.get(plan_type, settings.PLAN_LIMITS["free"])

    # Create user with storage quota
    user = User(
        email=email,
        username=username,
        password_hash=auth_service.get_password_hash(password),
        plan_type=plan_type,
        storage_quota=plan_limits["storage_bytes"],
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
        metadata={"plan_type": plan_type},
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
            "plan_type": plan_type,
            "storage_quota": plan_limits["storage_bytes"],
            "storage_used": 0,
            "bandwidth_limit_mbps": plan_limits["bandwidth_mbps"],
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

    # Check email verification
    if not user.email_verified:
        raise HTTPException(
            status_code=403,
            detail="Please verify your email before logging in. Check your inbox for the verification code."
        )

    await log_activity(db, user.id, "user_login", request=request)

    access_token = auth_service.create_access_token({"sub": str(user.id), "email": email})

    # Get plan limits for bandwidth info
    plan_limits = settings.PLAN_LIMITS.get(user.plan_type, settings.PLAN_LIMITS["free"])

    response_data = {
        "access_token": access_token,
        "token_type": "bearer",
        "user": {
            "id": str(user.id),
            "email": user.email,
            "username": user.username,
            "plan_type": user.plan_type,
            "storage_quota": user.storage_quota,
            "storage_used": user.storage_used,
            "bandwidth_limit_mbps": user.bandwidth_limit_mbps or plan_limits["bandwidth_mbps"],
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


# ========== EMAIL VERIFICATION REGISTRATION ENDPOINTS ==========

@router.post("/register/init", dependencies=[Depends(auth_register_limiter())])
async def register_init(
    request: Request,
    payload: RegisterInitRequest = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """
    Start registration - send verification code to email.
    
    This is the first step in the 3-step registration process:
    1. Init (this endpoint) - sends verification code
    2. Verify - validates the code
    3. Complete - creates account with username/password
    """
    email = payload.email.lower().strip()

    # Check if user already exists and is verified
    existing_user = await verification_service.get_user_by_email(db, email)
    if existing_user and existing_user.email_verified and existing_user.password_hash:
        raise HTTPException(status_code=400, detail="User already exists")

    # Check resend cooldown
    can_resend, cooldown_message = await verification_service.can_resend_code(email)
    if not can_resend:
        raise HTTPException(status_code=429, detail=cooldown_message)

    # Get or create temporary user
    user = await verification_service.create_temp_user(db, email)

    # Generate verification code
    code = verification_service.generate_verification_code()

    # Store code in database
    await verification_service.store_verification_code(db, user, code)

    # Send verification email
    email_sent = await email_service.send_verification_code(email, code)
    if not email_sent:
        raise HTTPException(
            status_code=500,
            detail="Failed to send verification email. Please try again later."
        )

    return {
        "message": "Verification code sent to your email",
        "email": email
    }


@router.post("/register/verify", response_model=VerificationResponse)
async def register_verify(
    request: Request,
    payload: RegisterVerifyRequest = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """
    Verify email code - second step in registration.
    
    Validates the verification code and returns a temporary token
    that must be used in the complete step.
    """
    email = payload.email.lower().strip()
    code = payload.verification_code

    # Get user
    user = await verification_service.get_user_by_email(db, email)
    if not user:
        raise HTTPException(status_code=404, detail="Registration not found. Please start registration again.")

    # Verify code
    is_valid, message = await verification_service.verify_code(db, user, code)
    if not is_valid:
        raise HTTPException(status_code=400, detail=message)

    # Create temporary token for registration completion (expires in 10 minutes)
    verification_token = auth_service.create_access_token(
        {"sub": str(user.id), "email": email, "type": "registration"},
        expires_delta=timedelta(minutes=10)
    )

    return VerificationResponse(
        verified=True,
        token=verification_token,
        message="Email verified successfully"
    )


@router.post("/register/complete", response_model=Token, dependencies=[Depends(auth_register_limiter())])
async def register_complete(
    request: Request,
    payload: RegisterCompleteRequest = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """
    Complete registration - final step.
    
    Creates the user account with username and password.
    Requires the verification token from the verify step.
    """
    email = payload.email.lower().strip()
    username = payload.username.strip()
    password = payload.password
    verification_token = payload.verification_token

    # Verify the temporary token
    try:
        from jose import jwt, JWTError
        payload_data = jwt.decode(
            verification_token,
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM]
        )
        
        if payload_data.get("type") != "registration":
            raise HTTPException(status_code=400, detail="Invalid verification token")
        
        user_id = payload_data.get("sub")
        token_email = payload_data.get("email")
        
        if token_email != email:
            raise HTTPException(status_code=400, detail="Email mismatch")
    except JWTError:
        raise HTTPException(status_code=400, detail="Invalid or expired verification token")

    # Get user
    user = await verification_service.get_user_by_email(db, email)
    if not user:
        raise HTTPException(status_code=404, detail="Registration not found")

    # Check if email is verified
    if not user.email_verified:
        raise HTTPException(status_code=400, detail="Email not verified")

    # Check if username is already taken
    existing_username = await db.execute(
        select(User).filter(User.username == username, User.id != user.id)
    )
    if existing_username.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Username already taken")

    # Update user with username and password
    from sqlalchemy import update
    await db.execute(
        update(User)
        .where(User.id == user.id)
        .values(
            username=username,
            password_hash=auth_service.get_password_hash(password),
            is_active=True
        )
    )
    await db.commit()
    await db.refresh(user)

    # Get plan limits
    plan_limits = settings.PLAN_LIMITS.get("free", settings.PLAN_LIMITS["free"])

    # Create root folder
    root_folder = Folder(user_id=user.id, parent_id=None, name="/", path="/")
    db.add(root_folder)
    await db.commit()

    # Log activity
    await log_activity(
        db, user.id, "user_registered",
        metadata={"plan_type": "free"},
        request=request
    )

    # Create access token
    access_token = auth_service.create_access_token({"sub": str(user.id), "email": email})

    response_data = {
        "access_token": access_token,
        "token_type": "bearer",
        "user": {
            "id": str(user.id),
            "email": email,
            "username": username,
            "plan_type": user.plan_type,
            "storage_quota": plan_limits["storage_bytes"],
            "storage_used": 0,
            "bandwidth_limit_mbps": plan_limits["bandwidth_mbps"],
            "theme": "light"
        },
    }

    # Set HTTP-only cookie
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


@router.post("/register/resend-code", dependencies=[Depends(auth_register_limiter())])
async def resend_verification_code(
    request: Request,
    payload: ResendCodeRequest = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """
    Resend verification code.
    
    Allows users to request a new verification code if they didn't receive
    the first one or it expired. Rate limited to prevent abuse.
    """
    email = payload.email.lower().strip()

    # Check resend cooldown
    can_resend, cooldown_message = await verification_service.can_resend_code(email)
    if not can_resend:
        raise HTTPException(status_code=429, detail=cooldown_message)

    # Get user
    user = await verification_service.get_user_by_email(db, email)
    if not user:
        raise HTTPException(status_code=404, detail="Registration not found. Please start registration again.")

    # Check if already verified
    if user.email_verified:
        raise HTTPException(status_code=400, detail="Email already verified")

    # Generate new code
    code = verification_service.generate_verification_code()

    # Store new code
    await verification_service.store_verification_code(db, user, code)

    # Send email
    email_sent = await email_service.send_verification_code(email, code)
    if not email_sent:
        raise HTTPException(
            status_code=500,
            detail="Failed to send verification email. Please try again later."
        )

    return {
        "message": "Verification code resent to your email",
        "email": email
    }
