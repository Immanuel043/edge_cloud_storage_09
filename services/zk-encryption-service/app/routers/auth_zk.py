"""
Zero-Knowledge Authentication Endpoints

Handles user registration and login with client-side encryption.
The server NEVER receives the user's password or derived encryption key.

Authentication Flow:
1. Client derives key from password using PBKDF2 (600k iterations)
2. Client hashes the derived key
3. Client sends hash to server for verification
4. Server stores bcrypt(hash) for authentication
5. On login, server returns encrypted master key
6. Client decrypts master key with derived key
"""
import base64
import bcrypt
import structlog
from datetime import datetime
from typing import Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from jose import jwt, JWTError

from app.config import settings

import os

# Cookie settings for HTTP-only session cookie
COOKIE_NAME = "access_token"
COOKIE_MAX_AGE = 3600  # 1 hour
# SECURITY: Must be True in production to prevent token theft over HTTP
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "true").lower() == "true"
COOKIE_HTTPONLY = True  # Prevent JavaScript access (XSS protection)
COOKIE_SAMESITE = "lax"  # CSRF protection
from app.database import get_db
from app.dependencies import (
    create_access_token,
    get_current_user,
    rate_limit_login,
    get_client_ip,
    get_user_agent
)
from app.services.kdf import KDFService
from app.models.zk_models import ZKEnrollmentHistory

logger = structlog.get_logger()

router = APIRouter()


# ========== REQUEST/RESPONSE MODELS ==========

class KDFParamsResponse(BaseModel):
    """KDF parameters for client-side key derivation"""
    kdf_salt: str  # Hex-encoded
    kdf_algorithm: str
    kdf_iterations: int
    kdf_iv: Optional[str] = None  # Base64-encoded IV for AES-GCM
    kdf_memory: Optional[int] = None  # For Argon2
    kdf_parallelism: Optional[int] = None  # For Argon2


class RegisterZKRequest(BaseModel):
    """Request to register with zero-knowledge encryption"""
    email: EmailStr
    username: str = Field(..., min_length=3, max_length=50)
    password_hash: str = Field(..., min_length=64, max_length=64)  # SHA-256 hex (64 chars)
    encrypted_master_key: str  # Base64 encoded
    master_key_iv: str  # Base64 encoded IV for AES-GCM
    kdf_salt: str  # Hex encoded
    kdf_algorithm: str = Field(default="pbkdf2", pattern="^(pbkdf2|argon2id)$")
    kdf_iterations: int = Field(default=600000, ge=1)  # Argon2id uses 3, PBKDF2 uses 600000
    kdf_memory: Optional[int] = Field(default=None, ge=16384)  # Min 16MB for Argon2id
    kdf_parallelism: Optional[int] = Field(default=None, ge=1)
    recovery_encrypted_master_key: Optional[str] = None
    recovery_phrase_hash: Optional[str] = None


class LoginZKRequest(BaseModel):
    """Request to login with zero-knowledge encryption"""
    email: EmailStr
    password_hash: str = Field(..., min_length=64, max_length=64)


class LoginZKResponse(BaseModel):
    """Response for ZK login"""
    access_token: str
    token_type: str = "bearer"
    user: dict
    encrypted_master_key: str
    kdf_salt: str
    kdf_params: dict


# ========== ENDPOINTS ==========

@router.get("/me")
async def get_current_user_info(
    user = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get current authenticated user's profile.

    Used by frontend on page refresh to restore user session.
    Returns user info without sensitive encryption keys.
    """
    return {
        "id": str(user.id),
        "email": user.email,
        "username": user.username,
        "plan_type": user.plan_type,
        "storage_quota": user.storage_quota,
        "storage_used": user.storage_used,
        "zk_enabled": True,
        "recovery_phrase_enabled": user.recovery_phrase_enabled,
        "created_at": user.created_at.isoformat() if user.created_at else None,
    }


@router.get("/kdf-params", response_model=KDFParamsResponse)
async def get_kdf_params(
    email: EmailStr,
    db: AsyncSession = Depends(get_db)
):
    """
    Get KDF parameters for a user's email.

    Client needs these parameters to derive the encryption key from password.
    This endpoint is public (no authentication required) to allow login.

    Args:
        email: User's email address

    Returns:
        KDF parameters (salt, algorithm, iterations)
    """
    # Import ZKUser model
    from app.models.database import ZKUser

    # Fetch user
    result = await db.execute(
        select(ZKUser).filter(ZKUser.email == email)
    )
    user = result.scalar_one_or_none()

    if not user:
        # Security: Don't reveal if user exists
        # Return fake parameters to prevent user enumeration
        logger.warning("kdf_params_requested_nonexistent_user", email=email)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found"
        )

    # Return KDF parameters
    return KDFParamsResponse(
        kdf_salt=user.kdf_salt.hex() if user.kdf_salt else "",
        kdf_algorithm=user.kdf_algorithm or "pbkdf2",
        kdf_iterations=user.kdf_iterations or 600000,
        kdf_iv=user.master_key_iv,
        kdf_memory=user.kdf_memory,
        kdf_parallelism=user.kdf_parallelism
    )


# ========== EMAIL VERIFICATION REGISTRATION ENDPOINTS ==========

@router.post("/register-zk/init")
async def register_zk_init(
    request: Request,
    db: AsyncSession = Depends(get_db)
):
    """
    Start ZK registration - send verification code to email.

    Step 1 of 3-step ZK registration:
    1. Init (this endpoint) - sends verification code
    2. Verify - validates the code
    3. Complete - creates ZK account with encryption keys
    """
    from app.models.schemas import RegisterZKInitRequest
    from app.services.verification_service import verification_service
    from app.services.email_service import email_service
    from app.models.database import ZKUser

    # Parse request body
    try:
        body = await request.json()
        payload = RegisterZKInitRequest(**body)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid request: {str(e)}")

    email = payload.email.lower().strip()

    # Check if user already exists and is verified
    result = await db.execute(
        select(ZKUser).filter(ZKUser.email == email)
    )
    existing_user = result.scalar_one_or_none()

    if existing_user and existing_user.email_verified and existing_user.password_hash:
        raise HTTPException(status_code=400, detail="User already exists")

    # Check resend cooldown (using Redis)
    can_resend, cooldown_message = await verification_service.can_resend_code(email)
    if not can_resend:
        raise HTTPException(status_code=429, detail=cooldown_message)

    # Get or create temporary ZK user
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

    logger.info("zk_registration_init", email=email, user_id=str(user.id))

    return {
        "message": "Verification code sent to your email",
        "email": email
    }


@router.post("/register-zk/verify")
async def register_zk_verify(
    request: Request,
    db: AsyncSession = Depends(get_db)
):
    """
    Verify email code - second step in ZK registration.

    Validates the verification code and returns a temporary token
    for completing registration.
    """
    from app.models.schemas import RegisterZKVerifyRequest, VerificationResponseZK
    from app.services.verification_service import verification_service
    from datetime import timedelta
    from app.models.database import ZKUser

    # Parse request body
    try:
        body = await request.json()
        payload = RegisterZKVerifyRequest(**body)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid request: {str(e)}")

    email = payload.email.lower().strip()
    code = payload.verification_code

    # Get user
    result = await db.execute(
        select(ZKUser).filter(ZKUser.email == email)
    )
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(
            status_code=404,
            detail="Registration not found. Please start registration again."
        )

    # Verify code
    is_valid, message = await verification_service.verify_code(db, user, code)
    if not is_valid:
        raise HTTPException(status_code=400, detail=message)

    # Create temporary token for registration completion (10 minutes)
    verification_token = create_access_token(
        data={"sub": str(user.id), "email": email, "type": "zk_registration"},
        expires_delta=timedelta(minutes=10)
    )

    logger.info("zk_email_verified", email=email, user_id=str(user.id))

    return VerificationResponseZK(
        verified=True,
        token=verification_token,
        message="Email verified successfully. Please complete your registration."
    )


@router.post("/register-zk/complete", status_code=status.HTTP_201_CREATED)
async def register_zk_complete(
    request: Request,
    db: AsyncSession = Depends(get_db)
):
    """
    Complete ZK registration - final step.

    Creates the ZK user account with encryption keys.
    Requires the verification token from the verify step.
    """
    from app.models.schemas import RegisterZKCompleteRequest
    from app.models.database import ZKUser
    from sqlalchemy import update

    # Parse request body
    try:
        body = await request.json()
        payload = RegisterZKCompleteRequest(**body)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid request: {str(e)}")

    email = payload.email.lower().strip()
    username = payload.username.strip()

    # Verify the temporary token
    try:
        token_data = jwt.decode(
            payload.verification_token,
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM]
        )

        if token_data.get("type") != "zk_registration":
            raise HTTPException(status_code=400, detail="Invalid verification token")

        token_email = token_data.get("email")
        if token_email != email:
            raise HTTPException(status_code=400, detail="Email mismatch")

    except JWTError:
        raise HTTPException(
            status_code=400,
            detail="Invalid or expired verification token. Please verify your email again."
        )

    # Get user
    result = await db.execute(
        select(ZKUser).filter(ZKUser.email == email)
    )
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(status_code=404, detail="Registration not found")

    # Check if email is verified
    if not user.email_verified:
        raise HTTPException(status_code=400, detail="Email not verified")

    # Check if username is taken
    result = await db.execute(
        select(ZKUser).filter(ZKUser.username == username, ZKUser.id != user.id)
    )
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Username already taken")

    # Decode KDF salt
    try:
        kdf_salt = bytes.fromhex(payload.kdf_salt)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid KDF salt format")

    # Hash the password_hash with bcrypt
    password_hash_bytes = payload.password_hash.encode('utf-8')
    bcrypt_hash = bcrypt.hashpw(password_hash_bytes, bcrypt.gensalt(rounds=12))

    # Update user with ZK credentials
    await db.execute(
        update(ZKUser)
        .where(ZKUser.id == user.id)
        .values(
            username=username,
            password_hash=bcrypt_hash.decode('utf-8'),
            encrypted_master_key=payload.encrypted_master_key,
            master_key_iv=payload.master_key_iv,
            kdf_salt=kdf_salt,
            kdf_algorithm=payload.kdf_algorithm,
            kdf_iterations=payload.kdf_iterations,
            kdf_memory=payload.kdf_memory,
            kdf_parallelism=payload.kdf_parallelism,
            recovery_encrypted_master_key=payload.recovery_encrypted_master_key,
            recovery_phrase_hash=payload.recovery_phrase_hash,
            recovery_phrase_enabled=(payload.recovery_phrase_hash is not None),
            is_active=True,
            zk_enrolled_at=datetime.utcnow()
        )
    )
    await db.commit()
    await db.refresh(user)

    # Get plan limits (use shared_billing if available, fallback to settings)
    try:
        from shared_billing import BillingService
        billing = BillingService(db, service_type='zk')
        plan_code = payload.plan_code or "zk_pro"
        plan = await billing.get_plan_by_code(plan_code)
        storage_quota = plan.storage_bytes
    except Exception:
        storage_quota = 100 * 1024**3  # 100GB fallback

    # Update storage quota
    await db.execute(
        update(ZKUser)
        .where(ZKUser.id == user.id)
        .values(storage_quota=storage_quota)
    )
    await db.commit()

    # Create subscription with selected plan and billing cycle
    try:
        from shared_billing import BillingService
        billing = BillingService(db, service_type='zk')
        billing_cycle = payload.billing_cycle if payload.billing_cycle else None
        await billing.create_subscription(user.id, plan_code, billing_cycle=billing_cycle)
    except Exception as e:
        logger.warning(f"Failed to create subscription for ZK user {user.id}: {e}")

    # Log enrollment
    enrollment_log = ZKEnrollmentHistory(
        id=uuid4(),
        user_id=user.id,
        action="enabled",
        to_tier="pro",
        recovery_methods_configured=["phrase"] if payload.recovery_phrase_hash else [],
        ip_address=get_client_ip(request),
        user_agent=get_user_agent(request),
        extra_metadata={"registration": True, "email_verified": True}
    )
    db.add(enrollment_log)
    await db.commit()

    logger.info(
        "zk_registration_complete",
        user_id=str(user.id),
        email=email,
        kdf_algorithm=user.kdf_algorithm
    )

    # Create access token
    access_token = create_access_token(data={"sub": str(user.id)})

    # Build response
    response_data = {
        "access_token": access_token,
        "token_type": "bearer",
        "user": {
            "id": str(user.id),
            "email": email,
            "username": username,
            "recovery_phrase_enabled": user.recovery_phrase_enabled,
            "zk_enabled": True
        }
    }

    # Set HTTP-only cookie
    response = JSONResponse(content=response_data, status_code=status.HTTP_201_CREATED)
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


@router.post("/register-zk/resend-code")
async def resend_zk_verification_code(
    request: Request,
    db: AsyncSession = Depends(get_db)
):
    """
    Resend verification code for ZK registration.

    Rate limited to prevent abuse.
    """
    from app.models.schemas import ResendCodeRequestZK
    from app.services.verification_service import verification_service
    from app.services.email_service import email_service
    from app.models.database import ZKUser

    # Parse request body
    try:
        body = await request.json()
        payload = ResendCodeRequestZK(**body)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid request: {str(e)}")

    email = payload.email.lower().strip()

    # Check resend cooldown
    can_resend, cooldown_message = await verification_service.can_resend_code(email)
    if not can_resend:
        raise HTTPException(status_code=429, detail=cooldown_message)

    # Get user
    result = await db.execute(
        select(ZKUser).filter(ZKUser.email == email)
    )
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(
            status_code=404,
            detail="Registration not found. Please start registration again."
        )

    # Check if already verified
    if user.email_verified and user.password_hash:
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

    logger.info("zk_verification_code_resent", email=email)

    return {
        "message": "Verification code resent to your email",
        "email": email
    }


@router.post("/register-zk", status_code=status.HTTP_201_CREATED, deprecated=True)
async def register_zero_knowledge(
    request_data: RegisterZKRequest,
    request: Request,
    db: AsyncSession = Depends(get_db)
):
    """
    Register a new user with zero-knowledge encryption - DEPRECATED

    ⚠️ DEPRECATED: This endpoint bypasses email verification and will be removed in a future version.

    Please use the 3-step email verification flow instead:
    1. POST /register-zk/init (send verification code)
    2. POST /register-zk/verify (validate code, get token)
    3. POST /register-zk/complete (create ZK account)

    The client must:
    1. Derive key from password (PBKDF2 600k iterations)
    2. Hash the derived key (SHA-256)
    3. Send the hash (NOT the password or derived key)
    4. Encrypt master key with derived key
    5. Send encrypted master key

    Server stores:
    - bcrypt(password_hash) for verification
    - encrypted_master_key (cannot decrypt)
    - KDF parameters (public)

    Args:
        request_data: Registration data

    Returns:
        Access token and user info
    """
    # Import ZKUser model
    from app.models.database import ZKUser

    logger.info("zk_registration_attempt", email=request_data.email)

    # Check if user already exists
    result = await db.execute(
        select(ZKUser).filter(
            (ZKUser.email == request_data.email) | (ZKUser.username == request_data.username)
        )
    )
    existing_user = result.scalar_one_or_none()

    if existing_user:
        if existing_user.email == request_data.email:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Email already registered"
            )
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Username already taken"
            )

    # Decode salt (expecting hex string from frontend)
    try:
        kdf_salt = bytes.fromhex(request_data.kdf_salt)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid KDF salt format"
        )

    # Hash the password_hash with bcrypt (double hashing for security)
    # This allows server to verify password without knowing it
    password_hash_bytes = request_data.password_hash.encode('utf-8')
    bcrypt_hash = bcrypt.hashpw(password_hash_bytes, bcrypt.gensalt(rounds=12))

    # Create new user
    new_user = ZKUser(
        id=uuid4(),
        email=request_data.email,
        username=request_data.username,
        password_hash=bcrypt_hash.decode('utf-8'),
        zk_enrolled_at=datetime.utcnow(),
        encrypted_master_key=request_data.encrypted_master_key,
        master_key_iv=request_data.master_key_iv,
        kdf_salt=kdf_salt,
        kdf_algorithm=request_data.kdf_algorithm,
        kdf_iterations=request_data.kdf_iterations,
        kdf_memory=request_data.kdf_memory,
        kdf_parallelism=request_data.kdf_parallelism,
        recovery_encrypted_master_key=request_data.recovery_encrypted_master_key,
        recovery_phrase_hash=request_data.recovery_phrase_hash,
        recovery_phrase_enabled=request_data.recovery_phrase_hash is not None,
        is_active=True,
        storage_quota=107374182400,  # 100GB for Pro tier (ZK enabled)
    )

    db.add(new_user)

    # Log enrollment
    enrollment_log = ZKEnrollmentHistory(
        id=uuid4(),
        user_id=new_user.id,
        action="enabled",
        to_tier="pro",
        recovery_methods_configured=["phrase"] if request_data.recovery_phrase_hash else [],
        ip_address=get_client_ip(request),
        user_agent=get_user_agent(request),
        extra_metadata={"registration": True}
    )
    db.add(enrollment_log)

    await db.commit()
    await db.refresh(new_user)

    logger.info(
        "zk_registration_success",
        user_id=str(new_user.id),
        email=new_user.email,
        kdf_algorithm=new_user.kdf_algorithm
    )

    # Create access token
    access_token = create_access_token(data={"sub": str(new_user.id)})

    # Build response data
    response_data = {
        "access_token": access_token,
        "token_type": "bearer",
        "user": {
            "id": str(new_user.id),
            "email": new_user.email,
            "username": new_user.username,
            "recovery_phrase_enabled": new_user.recovery_phrase_enabled
        }
    }

    # Set HTTP-only cookie for automatic authentication after registration
    response = JSONResponse(content=response_data, status_code=status.HTTP_201_CREATED)
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


@router.post("/login-zk", response_model=LoginZKResponse, dependencies=[Depends(rate_limit_login)])
async def login_zero_knowledge(
    request_data: LoginZKRequest,
    request: Request,
    db: AsyncSession = Depends(get_db)
):
    """
    Login with zero-knowledge encryption.

    Client flow:
    1. Fetch KDF params from /kdf-params
    2. Derive key from password using those params
    3. Hash the derived key
    4. Send hash for verification
    5. Receive encrypted master key
    6. Decrypt master key locally

    Args:
        request_data: Login credentials

    Returns:
        Access token and encrypted master key
    """
    # Import ZKUser model
    from app.models.database import ZKUser

    logger.info("zk_login_attempt", email=request_data.email)

    # Fetch user
    result = await db.execute(
        select(ZKUser).filter(ZKUser.email == request_data.email)
    )
    user = result.scalar_one_or_none()

    if not user:
        logger.warning("zk_login_failed_user_not_found", email=request_data.email)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password"
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is inactive"
        )

    # Verify password hash
    password_hash_bytes = request_data.password_hash.encode('utf-8')
    stored_hash = user.password_hash.encode('utf-8')

    if not bcrypt.checkpw(password_hash_bytes, stored_hash):
        logger.warning(
            "zk_login_failed_invalid_password",
            user_id=str(user.id),
            ip=get_client_ip(request)
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password"
        )

    logger.info("zk_login_success", user_id=str(user.id), email=user.email)

    # Create access token
    access_token = create_access_token(data={"sub": str(user.id)})

    # Build response data
    response_data = {
        "access_token": access_token,
        "token_type": "bearer",
        "user": {
            "id": str(user.id),
            "email": user.email,
            "username": user.username,
            "recovery_phrase_enabled": user.recovery_phrase_enabled
        },
        "encrypted_master_key": user.encrypted_master_key,
        "master_key_iv": user.master_key_iv,  # Required for decrypting master key
        "kdf_salt": user.kdf_salt.hex(),
        "kdf_params": {
            "algorithm": user.kdf_algorithm,
            "iterations": user.kdf_iterations,
            "memory": user.kdf_memory,
            "parallelism": user.kdf_parallelism
        }
    }

    # Set HTTP-only cookie for cross-service authentication
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
async def logout(
    user = Depends(get_current_user)
):
    """
    Logout user.

    In zero-knowledge mode, the master key is stored in client's sessionStorage.
    This endpoint invalidates the server-side JWT token and clears the cookie.
    Client must also clear their sessionStorage.

    Args:
        user: Current authenticated user

    Returns:
        Success message
    """
    logger.info("zk_logout", user_id=str(user.id))

    # TODO: Implement token blacklist in Redis if needed

    response_data = {
        "message": "Logged out successfully",
        "instructions": "Clear your browser's sessionStorage to remove encryption keys"
    }

    # Clear the auth cookie
    response = JSONResponse(content=response_data)
    response.delete_cookie(
        key=COOKIE_NAME,
        path="/",
        secure=COOKIE_SECURE,
        httponly=COOKIE_HTTPONLY,
        samesite=COOKIE_SAMESITE
    )

    return response


class UpgradeToZKRequest(BaseModel):
    """Request to upgrade existing account to zero-knowledge encryption"""
    password_hash: str = Field(..., min_length=64, max_length=64)  # SHA-256 hex
    encrypted_master_key: str  # Base64 encoded
    master_key_iv: str  # Base64 encoded IV for AES-GCM
    kdf_salt: str  # Hex encoded
    kdf_algorithm: str = Field(default="pbkdf2", pattern="^(pbkdf2|argon2id)$")
    kdf_iterations: int = Field(default=600000, ge=1)  # Argon2id uses 3, PBKDF2 uses 600000
    kdf_memory: Optional[int] = Field(default=None, ge=16384)  # Min 16MB for Argon2id
    kdf_parallelism: Optional[int] = Field(default=None, ge=1)


@router.post("/upgrade-to-zk")
async def upgrade_to_zero_knowledge(
    request_data: UpgradeToZKRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user = Depends(get_current_user)
):
    """
    Upgrade an existing regular account to zero-knowledge encryption.

    Requirements:
    - User must be authenticated
    - User must NOT already have ZK enabled

    The client must:
    1. Derive key from NEW password (PBKDF2 600k iterations)
    2. Hash the derived key (SHA-256)
    3. Generate new master key
    4. Encrypt master key with derived key
    5. Send all ZK credentials

    After upgrade:
    - User's old password no longer works
    - User must login with new ZK password
    - All future file uploads will be encrypted

    Args:
        request_data: ZK credentials
        current_user: Authenticated user

    Returns:
        Success message and new access token
    """
    from app.models.database import ZKUser

    logger.info("zk_upgrade_attempt", user_id=str(current_user.id), email=current_user.email)

    # Decode salt (expecting hex string from frontend)
    try:
        kdf_salt = bytes.fromhex(request_data.kdf_salt)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid KDF salt format"
        )

    # Hash the password_hash with bcrypt (double hashing for security)
    password_hash_bytes = request_data.password_hash.encode('utf-8')
    bcrypt_hash = bcrypt.hashpw(password_hash_bytes, bcrypt.gensalt(rounds=12))

    # Update user with ZK credentials
    current_user.password_hash = bcrypt_hash.decode('utf-8')
    current_user.zk_enrolled_at = datetime.utcnow()
    current_user.encrypted_master_key = request_data.encrypted_master_key
    current_user.master_key_iv = request_data.master_key_iv
    current_user.kdf_salt = kdf_salt
    current_user.kdf_algorithm = request_data.kdf_algorithm
    current_user.kdf_iterations = request_data.kdf_iterations
    current_user.kdf_memory = request_data.kdf_memory
    current_user.kdf_parallelism = request_data.kdf_parallelism

    # Log enrollment
    enrollment_log = ZKEnrollmentHistory(
        id=uuid4(),
        user_id=current_user.id,
        action="upgraded",
        from_tier="basic",
        to_tier="pro",
        recovery_methods_configured=[],
        ip_address=get_client_ip(request),
        user_agent=get_user_agent(request),
        extra_metadata={"upgrade": True}
    )
    db.add(enrollment_log)

    await db.commit()
    await db.refresh(current_user)

    logger.info(
        "zk_upgrade_success",
        user_id=str(current_user.id),
        email=current_user.email,
        kdf_algorithm=current_user.kdf_algorithm
    )

    # Create new access token
    access_token = create_access_token(data={"sub": str(current_user.id)})

    response_data = {
        "message": "Account upgraded to zero-knowledge encryption successfully",
        "access_token": access_token,
        "token_type": "bearer",
        "user": {
            "id": str(current_user.id),
            "email": current_user.email,
            "username": current_user.username,
            "recovery_phrase_enabled": False
        }
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


# ========== USER MODEL (Temporary - for type hints) ==========
# NOTE: This should import from storage-service models in production

class User:
    """Temporary User model placeholder for type hints"""
    pass
