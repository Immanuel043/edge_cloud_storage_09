# services/storage-service/app/routers/auth.py
from fastapi import APIRouter, Depends, HTTPException, Form, Request, Response, Body, Query
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from datetime import timedelta
import logging
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

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/auth", tags=["authentication"])

# SECURITY: Cookie configuration
COOKIE_NAME = "access_token"
COOKIE_MAX_AGE = 3600  # 1 hour
COOKIE_SECURE = settings.is_production  # HTTPS only in production
COOKIE_HTTPONLY = True  # Prevent JavaScript access (XSS protection)
COOKIE_SAMESITE = "strict"  # CSRF protection - strict prevents cross-origin cookie sending


@router.get("/plans", response_model=dict)
async def get_public_plans(
    service_type: str = Query('normal', description="'normal' or 'zk'"),
    db: AsyncSession = Depends(get_db),
):
    """
    Get available subscription plans (PUBLIC endpoint for registration).

    Does not require authentication - used by registration flow.
    Returns categorized plan catalog with pricing and features.
    service_type: 'normal' for storage-service plans, 'zk' for ZK vault plans
    (both dashboards may call this to show the appropriate plan list).
    """
    from shared_billing import BillingService

    billing = BillingService(db, service_type=service_type)
    plans = await billing.get_available_plans(active_only=True)

    # Group plans by category
    categorized = {"individual": [], "business": [], "enterprise": []}

    for p in plans:
        if not p.is_active:
            continue

        plan_data = {
            "plan_code": p.plan_code,
            "display_name": p.display_name,
            "description": p.description or "",
            "tier_name": p.tier_name,
            "category": p.category,
            "service_type": p.service_type,

            # Storage and bandwidth
            "storage_gb": float(p.storage_bytes / (1024**3)),
            "storage_bytes": p.storage_bytes,
            "bandwidth_mbps": p.bandwidth_mbps,
            "bandwidth_burst_mbps": p.bandwidth_burst_mbps,
            "max_concurrent_streams": p.max_concurrent_streams,

            # Pricing (in rupees/dollars as stored in database)
            "price_monthly": int(float(p.price_monthly)) if p.price_monthly else None,
            "price_six_months": int(float(p.price_six_months)) if p.price_six_months else None,
            "price_yearly": int(float(p.price_yearly)) if p.price_yearly else None,

            # Metadata
            "features": p.features or {},
            "is_most_popular": p.is_most_popular,
            "is_default": p.is_default,
            "is_active": p.is_active,
        }

        categorized[p.category].append(plan_data)

    return {
        "service_type": service_type,
        "plans": categorized
    }


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

    # Get plan limits from database for bandwidth info
    from shared_billing import BillingService
    billing = BillingService(db, service_type='normal')

    try:
        plan_code = f"normal_{user.plan_type}"
        plan = await billing.get_plan_by_code(plan_code)
        default_bandwidth = plan.bandwidth_mbps
    except Exception:
        default_bandwidth = 5  # 5 Mbps fallback

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
            "bandwidth_limit_mbps": user.bandwidth_limit_mbps or default_bandwidth,
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
    """Logout user - clears cookie AND revokes JWT via blocklist"""
    # Blocklist the current token so it can't be reused
    token = None
    if request:
        cookie_token = request.cookies.get(COOKIE_NAME)
        if cookie_token:
            token = cookie_token
        else:
            auth_header = request.headers.get("Authorization", "")
            if auth_header.startswith("Bearer "):
                token = auth_header[7:]

    if token:
        await auth_service.blocklist_token(token)

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
    Issue a short-lived (5-minute) download token for query-authenticated requests
    (e.g., video streaming, file downloads where cookies are not forwarded).

    These tokens are safe to expose in URLs since they expire quickly.
    """
    access_token = auth_service.create_access_token(
        {"sub": str(current_user.id), "email": current_user.email, "type": "download"},
        expires_delta=timedelta(minutes=5)
    )
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

    # Check if email exists on ZK service
    from ..services.internal_client import InternalServiceClient
    internal_client = InternalServiceClient()
    if await internal_client.check_email_exists_on_zk_service(email):
        raise HTTPException(
            status_code=400,
            detail="This email is already registered with ZK Encrypted Storage. "
                   "Please log in using ZK mode, or use a different email."
        )

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

    # Get plan info first
    from shared_billing import BillingService
    billing = BillingService(db, service_type='normal')

    try:
        plan_code = payload.plan_code or "normal_free"
        plan = await billing.get_plan_by_code(plan_code)
        storage_quota = plan.storage_bytes
        bandwidth_limit = plan.bandwidth_mbps
    except Exception:
        plan_code = "normal_free"
        storage_quota = 5 * 1024**3  # 5GB fallback
        bandwidth_limit = 5  # 5 Mbps fallback

    # Determine plan_type from plan_code
    plan_type = plan_code.replace('normal_', '')  # e.g., "normal_basic_200" -> "basic_200"
    if '_' in plan_type:
        # Extract tier name (e.g., "basic_200" -> "basic")
        plan_type = plan_type.split('_')[0]

    # Update user with username, password, and plan_type
    from sqlalchemy import update
    await db.execute(
        update(User)
        .where(User.id == user.id)
        .values(
            username=username,
            password_hash=auth_service.get_password_hash(password),
            is_active=True,
            plan_type=plan_type,
            storage_quota=storage_quota
        )
    )
    await db.commit()
    await db.refresh(user)

    # Create root folder
    root_folder = Folder(user_id=user.id, parent_id=None, name="/", path="/")
    db.add(root_folder)
    await db.commit()

    # Create subscription with selected plan and billing cycle
    try:
        billing_cycle = payload.billing_cycle if payload.billing_cycle else None
        await billing.create_subscription(user.id, plan_code, billing_cycle=billing_cycle)
    except Exception as e:
        logger.warning(f"Failed to create subscription for user {user.id}: {e}")

    # Log activity
    await log_activity(
        db, user.id, "user_registered",
        metadata={"plan_code": plan_code, "billing_cycle": payload.billing_cycle},
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
            "storage_quota": storage_quota,
            "storage_used": 0,
            "bandwidth_limit_mbps": bandwidth_limit,
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
