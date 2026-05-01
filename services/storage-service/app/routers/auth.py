# services/storage-service/app/routers/auth.py
import asyncio
import logging
from datetime import timedelta
from typing import Any, Dict, Optional
from uuid import UUID

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Body,
    Depends,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
)
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import AsyncSessionLocal
from ..dependencies import get_current_user, get_db, log_activity
from ..models.database import ActivityLog, AuditLog, Folder, User
from ..models.schemas import (
    ForgotPasswordRequest,
    ForgotPasswordResetRequest,
    ForgotPasswordVerifyRequest,
    RegisterCompleteRequest,
    RegisterInitRequest,
    RegisterVerifyRequest,
    ResendCodeRequest,
    ThemeUpdate,
    Token,
    UserResponse,
    VerificationResponse,
)
from ..services.audit_logging_service import (
    AuditEvent,
    AuditEventType,
    AuditSeverity,
)
from ..services.audit_logging_service import audit_service as audit_logging_service
from ..services.auth import auth_service, pwd_context
from ..services.email_service import email_service
from ..services.verification_service import verification_service
from ..utils.rate_limiter_v2 import (
    _real_client_ip,
    auth_login_limiter,
    auth_password_reset_limiter,
    auth_register_limiter,
)

# Precomputed dummy bcrypt hash used for constant-time login: when the email
# doesn't exist we still run bcrypt against this hash so the response time is
# the same as a wrong-password attempt against an existing user. Computed once
# at module load (~300ms one-time startup cost). The plaintext value is
# irrelevant — we always discard the verify result for non-existent users.
_DUMMY_BCRYPT_HASH = pwd_context.hash(
    "_constant_time_dummy_for_login_timing_attack_defense_"
)

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
    service_type: str = Query("normal", description="'normal' or 'zk'"),
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

    return {"service_type": service_type, "plans": categorized}


async def _record_login_event(
    user_id: Optional[str],
    action: str,
    ip: Optional[str],
    user_agent: Optional[str],
    audit_event_type: AuditEventType,
    audit_result: str,
    audit_severity: AuditSeverity,
    audit_details: Optional[Dict[str, Any]] = None,
    write_activity: bool = True,
) -> None:
    """Persist activity + audit log in a single fresh-session commit.

    Runs as a FastAPI BackgroundTask so the login response is not blocked on
    these writes. Uses a new session because the request-scoped one is torn
    down once the response is sent.
    """
    user_uuid = UUID(user_id) if user_id else None
    event = AuditEvent(
        event_type=audit_event_type,
        user_id=user_uuid,
        action=action,
        result=audit_result,
        severity=audit_severity,
        ip_address=ip,
        user_agent=user_agent,
        details=audit_details,
    )

    # Durability: write the audit event to the persistent log file FIRST. If
    # the container is killed between this point and the DB commit below, the
    # event survives in audit.log (which lives on the storage_data volume) and
    # can be replayed into the DB by a future reconciliation tool. The file
    # handler uses RotatingFileHandler with line-buffered writes, so the cost
    # here is ~1ms (sub-page write, no fsync per call).
    try:
        audit_logging_service._write_to_log_file(event)
    except Exception as exc:
        logger.warning("Background login audit file write failed: %s", exc)

    audit_record = AuditLog(
        event_type=event.event_type.value,
        event_category=event.category.value,
        event_hash=event.event_hash,
        user_id=user_uuid,
        action=action,
        result=audit_result,
        severity=audit_severity.value,
        ip_address=ip,
        user_agent=user_agent,
        details=audit_details,
    )
    async with AsyncSessionLocal() as bg_db:
        try:
            if write_activity and user_uuid:
                activity = ActivityLog(
                    user_id=user_uuid,
                    action=action,
                    ip_address=ip,
                    user_agent=user_agent,
                )
                bg_db.add_all([activity, audit_record])
            else:
                bg_db.add(audit_record)
            await bg_db.commit()
        except Exception as exc:
            logger.warning("Background login audit DB write failed: %s", exc)
            try:
                await bg_db.rollback()
            except Exception:
                pass


@router.post("/login", response_model=Token, dependencies=[Depends(auth_login_limiter())])
async def login(
    request: Request,
    background_tasks: BackgroundTasks,
    email: str = Form(...),
    password: str = Form(...),
    db: AsyncSession = Depends(get_db),
):
    """Login user - SECURITY: HTTP-only cookie + rate limiting (5/min, 20/hour)"""
    result = await db.execute(select(User).filter(User.email == email))
    user = result.scalar_one_or_none()

    ip = _real_client_ip(request) if request else None
    user_agent = request.headers.get("user-agent") if request else None

    # Always run bcrypt — against the user's hash if found, else a precomputed
    # dummy hash — so response time is constant regardless of whether the
    # email exists. This defeats user-enumeration timing attacks.
    # bcrypt runs in a thread pool (no DB session use) and the BillingService
    # query owns the session for its duration, so they don't race.
    from shared_billing import BillingService

    billing = BillingService(db, service_type="normal")
    verify_target_hash = user.password_hash if user else _DUMMY_BCRYPT_HASH
    plan_coro = (
        billing.get_plan_by_code(f"normal_{user.plan_type}")
        if user
        else asyncio.sleep(0)
    )
    password_valid, plan_or_err = await asyncio.gather(
        auth_service.async_verify_password(password, verify_target_hash),
        plan_coro,
        return_exceptions=True,
    )
    if not user or isinstance(password_valid, BaseException):
        password_valid = False

    if not user or not password_valid:
        background_tasks.add_task(
            _record_login_event,
            user_id=str(user.id) if user else None,
            action="login",
            ip=ip,
            user_agent=user_agent,
            audit_event_type=AuditEventType.LOGIN_FAILURE,
            audit_result="failure",
            audit_severity=AuditSeverity.WARNING,
            audit_details={"attempted_email": email},
            write_activity=False,
        )
        raise HTTPException(status_code=401, detail="Invalid credentials")

    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account deactivated")

    # Check email verification
    if not user.email_verified:
        raise HTTPException(
            status_code=403,
            detail="Please verify your email before logging in. Check your inbox for the verification code.",
        )

    background_tasks.add_task(
        _record_login_event,
        user_id=str(user.id),
        action="user_login",
        ip=ip,
        user_agent=user_agent,
        audit_event_type=AuditEventType.LOGIN_SUCCESS,
        audit_result="success",
        audit_severity=AuditSeverity.INFO,
    )

    access_token = auth_service.create_access_token({"sub": str(user.id), "email": email})

    # Resolve plan from the earlier concurrent fetch; fall back on any failure.
    if plan_or_err is None or isinstance(plan_or_err, BaseException):
        default_bandwidth = 5
    else:
        default_bandwidth = plan_or_err.bandwidth_mbps

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
        path="/",
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
        samesite=COOKIE_SAMESITE,
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
        expires_delta=timedelta(minutes=5),
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
            "Please log in using ZK mode, or use a different email.",
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
            status_code=500, detail="Failed to send verification email. Please try again later."
        )

    return {"message": "Verification code sent to your email", "email": email}


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
        raise HTTPException(
            status_code=404, detail="Registration not found. Please start registration again."
        )

    # Verify code
    is_valid, message = await verification_service.verify_code(db, user, code)
    if not is_valid:
        raise HTTPException(status_code=400, detail=message)

    # Create temporary token for registration completion (expires in 10 minutes)
    verification_token = auth_service.create_access_token(
        {"sub": str(user.id), "email": email, "type": "registration"},
        expires_delta=timedelta(minutes=10),
    )

    return VerificationResponse(
        verified=True, token=verification_token, message="Email verified successfully"
    )


@router.post(
    "/register/complete", response_model=Token, dependencies=[Depends(auth_register_limiter())]
)
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
        from jose import JWTError, jwt

        payload_data = jwt.decode(
            verification_token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
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

    # Validate plan_code early (before any commits)
    from shared_billing import BillingService, InvalidPlanChangeError
    from sqlalchemy import update

    billing = BillingService(db, service_type="normal")

    plan_code = payload.plan_code or "normal_free"
    try:
        plan = await billing.get_plan_by_code(plan_code)
    except Exception:
        raise HTTPException(status_code=400, detail=f"Invalid plan code: {plan_code}")

    # Reject ZK plans — registration only supports normal storage
    if plan.service_type != "normal":
        raise HTTPException(
            status_code=400, detail="ZK plans are not supported for standard registration"
        )

    # Determine if plan requires payment
    billing_cycle = payload.billing_cycle if payload.billing_cycle else None
    is_paid = plan.price_monthly is not None and float(plan.price_monthly) > 0

    if is_paid and not settings.DEV_MODE:
        # Paid plan without payment: register with free tier, return upgrade info
        actual_plan_code = "normal_free"
        pending_upgrade = {"plan_code": plan_code, "billing_cycle": billing_cycle}
    else:
        # Free plan or DEV_MODE: activate immediately
        actual_plan_code = plan_code
        pending_upgrade = None

    # Step 1: Activate user (no plan-derived fields yet)
    await db.execute(
        update(User)
        .where(User.id == user.id)
        .values(
            username=username,
            password_hash=await auth_service.async_get_password_hash(password),
            is_active=True,
        )
    )
    await db.commit()

    # Step 2: Create root folder (idempotent — safe on retry)
    existing_root = await db.execute(
        select(Folder).where(
            Folder.user_id == user.id, Folder.parent_id == None, Folder.path == "/"
        )
    )
    if not existing_root.scalar_one_or_none():
        root_folder = Folder(user_id=user.id, parent_id=None, name="/", path="/")
        db.add(root_folder)
        await db.commit()

    # Step 3: Create subscription (retry-safe — reuses matching existing subscription)
    try:
        subscription = await billing.create_subscription(
            user.id,
            actual_plan_code,
            billing_cycle=billing_cycle if not pending_upgrade else "monthly",
        )
    except InvalidPlanChangeError:
        # Retry path: subscription already exists from a previous attempt
        subscription = await billing.get_user_subscription(user.id, include_plan=True)
        if subscription.plan.plan_code != actual_plan_code:
            raise HTTPException(
                status_code=409,
                detail=f"User already has an active subscription ({subscription.plan.plan_code}), "
                f"cannot create {actual_plan_code}",
            )

    # Step 4: Sync plan-derived fields from subscription
    await db.execute(
        update(User)
        .where(User.id == user.id)
        .values(
            plan_type=subscription.plan.tier_name,
            storage_quota=subscription.plan.storage_bytes,
            bandwidth_limit_mbps=subscription.plan.bandwidth_mbps,
            bandwidth_burst_mbps=subscription.plan.bandwidth_burst_mbps,
            max_concurrent_streams=subscription.plan.max_concurrent_streams,
            current_subscription_id=subscription.id,
        )
    )
    await db.commit()
    await db.refresh(user)

    # Log activity
    await log_activity(
        db,
        user.id,
        "user_registered",
        metadata={
            "plan_code": plan_code,
            "actual_plan_code": actual_plan_code,
            "billing_cycle": payload.billing_cycle,
        },
        request=request,
    )

    # Create access token
    access_token = auth_service.create_access_token({"sub": str(user.id), "email": email})

    # Build response from refreshed user (not stale locals)
    response_data = {
        "access_token": access_token,
        "token_type": "bearer",
        "user": {
            "id": str(user.id),
            "email": email,
            "username": username,
            "plan_type": user.plan_type,
            "storage_quota": user.storage_quota,
            "storage_used": 0,
            "bandwidth_limit_mbps": user.bandwidth_limit_mbps,
            "theme": "light",
        },
        "pending_upgrade": pending_upgrade,
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
        path="/",
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
        raise HTTPException(
            status_code=404, detail="Registration not found. Please start registration again."
        )

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
            status_code=500, detail="Failed to send verification email. Please try again later."
        )

    return {"message": "Verification code resent to your email", "email": email}


# ========== PASSWORD RESET ENDPOINTS ==========


@router.post("/forgot-password", dependencies=[Depends(auth_password_reset_limiter())])
async def forgot_password(
    request: Request,
    payload: ForgotPasswordRequest = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """
    Initiate password reset flow.

    Detects account type (normal, ZK, OAuth-only) and sends appropriate email.
    Always returns a generic message to prevent email enumeration.
    """
    from datetime import datetime, timezone

    from ..database import redis_client as _redis
    from ..services.internal_client import InternalServiceClient

    email = payload.email.lower().strip()

    # Check resend cooldown
    if _redis:
        try:
            cooldown_key = f"password_reset:resend:{email}"
            last_sent = await _redis.get(cooldown_key)
            if last_sent:
                time_since = datetime.now(timezone.utc).timestamp() - float(last_sent)
                if time_since < settings.RESEND_CODE_COOLDOWN_SECONDS:
                    remaining = int(settings.RESEND_CODE_COOLDOWN_SECONDS - time_since)
                    raise HTTPException(
                        status_code=429,
                        detail=f"Please wait {remaining} seconds before requesting again.",
                    )
        except HTTPException:
            raise
        except Exception:
            pass  # Fail open on Redis errors

    generic_response = {
        "message": "If an account with this email exists, we've sent reset instructions."
    }

    # Look up normal user
    result = await db.execute(
        select(User).filter(
            User.email == email,
            User.email_verified == True,
            User.is_active == True,
        )
    )
    user = result.scalar_one_or_none()

    if user:
        if user.password_hash:
            # Normal account with password — send reset code
            code = verification_service.generate_verification_code()
            await verification_service.store_verification_code(db, user, code)
            await email_service.send_password_reset_code(email, code)
        else:
            # OAuth-only account (empty password_hash)
            await email_service.send_oauth_login_instructions(email)
    else:
        # Check ZK service
        internal_client = InternalServiceClient()
        is_zk = await internal_client.check_email_exists_on_zk_service(email)
        if is_zk:
            await email_service.send_zk_recovery_instructions(email)

    # Set resend cooldown
    if _redis:
        try:
            await _redis.setex(
                f"password_reset:resend:{email}",
                settings.RESEND_CODE_COOLDOWN_SECONDS,
                str(datetime.now(timezone.utc).timestamp()),
            )
        except Exception:
            pass

    # Audit log (best-effort)
    try:
        await audit_logging_service.log_event(
            db,
            AuditEventType.PASSWORD_RESET,
            user_id=user.id if user else None,
            action="forgot_password_requested",
            result="initiated",
            severity=AuditSeverity.INFO,
            request=request,
            details={"email": email},
        )
    except Exception:
        try:
            await db.rollback()
        except Exception:
            pass

    return generic_response


@router.post("/forgot-password/verify", dependencies=[Depends(auth_password_reset_limiter())])
async def forgot_password_verify(
    request: Request,
    payload: ForgotPasswordVerifyRequest = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """
    Verify password reset code and return a short-lived reset token.

    Does NOT use verification_service.verify_code (which sets email_verified=True).
    Instead verifies code inline with password-reset semantics.
    """
    from datetime import datetime, timezone

    from sqlalchemy import update

    email = payload.email.lower().strip()
    code = payload.code

    # Look up verified, active, normal user
    result = await db.execute(
        select(User).filter(
            User.email == email,
            User.email_verified == True,
            User.is_active == True,
        )
    )
    user = result.scalar_one_or_none()

    if not user or not user.password_hash:
        raise HTTPException(status_code=400, detail="Invalid or expired code")

    # Check code exists
    if not user.verification_code:
        raise HTTPException(
            status_code=400, detail="No reset code found. Please request a new one."
        )

    # Check expiry
    if user.verification_code_expires_at and user.verification_code_expires_at < datetime.now(
        timezone.utc
    ):
        raise HTTPException(
            status_code=400, detail="Reset code has expired. Please request a new one."
        )

    # Check max attempts
    if user.verification_code_attempts >= settings.MAX_VERIFICATION_ATTEMPTS:
        raise HTTPException(
            status_code=400, detail="Maximum attempts exceeded. Please request a new code."
        )

    # Verify code
    if user.verification_code != code:
        new_attempts = user.verification_code_attempts + 1
        await db.execute(
            update(User).where(User.id == user.id).values(verification_code_attempts=new_attempts)
        )
        await db.commit()
        remaining = settings.MAX_VERIFICATION_ATTEMPTS - new_attempts
        raise HTTPException(
            status_code=400, detail=f"Invalid code. {remaining} attempts remaining."
        )

    # Code matches — clear code fields
    await db.execute(
        update(User)
        .where(User.id == user.id)
        .values(
            verification_code=None,
            verification_code_expires_at=None,
            verification_code_attempts=0,
        )
    )
    await db.commit()

    # Generate short-lived reset token (10 minutes)
    reset_token = auth_service.create_access_token(
        {"sub": str(user.id), "email": email, "type": "password_reset"},
        expires_delta=timedelta(minutes=10),
    )

    return {"reset_token": reset_token, "message": "Code verified successfully"}


@router.post("/forgot-password/reset", dependencies=[Depends(auth_password_reset_limiter())])
async def forgot_password_reset(
    request: Request,
    payload: ForgotPasswordResetRequest = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """
    Reset password using verified reset token.

    The reset token is single-use (jti is blocklisted after use).
    All existing sessions are invalidated via pwd_reset_at Redis key.
    """
    import time

    from jose import JWTError
    from jose import jwt as jose_jwt
    from sqlalchemy import update

    from ..database import redis_client as _redis

    email = payload.email.lower().strip()
    reset_token = payload.reset_token

    # Decode and validate reset token
    try:
        token_payload = jose_jwt.decode(
            reset_token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        if token_payload.get("type") != "password_reset":
            raise HTTPException(status_code=400, detail="Invalid reset token")
        if token_payload.get("email") != email:
            raise HTTPException(status_code=400, detail="Email mismatch")

        # S3: Check jti not already used
        jti = token_payload.get("jti")
        if jti and await auth_service.is_token_blocklisted(jti):
            raise HTTPException(status_code=400, detail="Reset token already used")
    except JWTError:
        raise HTTPException(status_code=400, detail="Invalid or expired reset token")

    # Look up user
    result = await db.execute(
        select(User).filter(
            User.email == email,
            User.email_verified == True,
            User.is_active == True,
        )
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=400, detail="User not found")

    # Hash and update password
    new_hash = await auth_service.async_get_password_hash(payload.new_password)
    await db.execute(update(User).where(User.id == user.id).values(password_hash=new_hash))
    await db.commit()

    # S3: Blocklist the reset token (single-use)
    await auth_service.blocklist_token(reset_token)

    # Invalidate all existing sessions
    if _redis:
        try:
            await _redis.setex(
                f"pwd_reset_at:{user.id}",
                settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
                str(int(time.time())),
            )
        except Exception:
            pass

    # Audit log
    try:
        await audit_logging_service.log_event(
            db,
            AuditEventType.PASSWORD_RESET,
            user_id=user.id,
            action="password_reset_completed",
            result="success",
            severity=AuditSeverity.HIGH,
            request=request,
        )
    except Exception:
        try:
            await db.rollback()
        except Exception:
            pass

    return {"message": "Password reset successfully. Please log in with your new password."}
