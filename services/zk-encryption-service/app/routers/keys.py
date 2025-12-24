"""
Key Management Endpoints

Handles encryption key management, recovery mechanisms, and ZK status.
"""
import base64
import hashlib
import structlog
from datetime import datetime
from uuid import uuid4
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, status, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.config import settings
from app.database import get_db
from app.dependencies import (
    get_current_user,
    get_current_zk_user,
    rate_limit_recovery,
    get_client_ip,
    get_user_agent
)
from app.services.recovery import RecoveryPhraseService
from app.models.zk_models import (
    ZKEnrollmentHistory,
    RecoveryAttempt,
    ZKStatusResponse
)

logger = structlog.get_logger()

router = APIRouter()


# ========== REQUEST/RESPONSE MODELS ==========

class EnableZKRequest(BaseModel):
    """Request to enable ZK for existing user"""
    password_hash: str = Field(..., min_length=64, max_length=64)
    encrypted_master_key: str
    kdf_salt: str
    kdf_algorithm: str = Field(default="pbkdf2", pattern="^(pbkdf2|argon2id)$")
    kdf_iterations: int = Field(default=600000, ge=1)  # Argon2id uses 3, PBKDF2 uses 600000
    kdf_memory: Optional[int] = None
    kdf_parallelism: Optional[int] = None


class EnableRecoveryPhraseRequest(BaseModel):
    """Request to enable recovery phrase"""
    recovery_encrypted_master_key: str
    recovery_phrase_hash: str = Field(..., min_length=64, max_length=64)


class VerifyRecoveryPhraseRequest(BaseModel):
    """Request to verify recovery phrase"""
    recovery_phrase: str = Field(..., min_length=23)  # 24 words minimum


class RecoverWithPhraseRequest(BaseModel):
    """Request to recover account with phrase"""
    email: str
    recovery_phrase: str
    new_password_hash: str = Field(..., min_length=64, max_length=64)
    new_encrypted_master_key: str
    new_kdf_salt: str


# ========== ENDPOINTS ==========

@router.post("/enable")
async def enable_zero_knowledge(
    request_data: EnableZKRequest,
    request: Request,
    user = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Enable zero-knowledge encryption for an existing user.

    Allows users who registered with traditional encryption to
    upgrade to zero-knowledge mode.

    Args:
        request_data: ZK configuration
        user: Current authenticated user

    Returns:
        Success message and ZK status
    """
    if user.zk_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Zero-knowledge encryption already enabled"
        )

    logger.info("enabling_zk_for_user", user_id=str(user.id))

    # Decode salt (expecting hex string from frontend)
    try:
        kdf_salt = bytes.fromhex(request_data.kdf_salt)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid KDF salt format"
        )

    # Update user to enable ZK
    import bcrypt
    password_hash_bytes = request_data.password_hash.encode('utf-8')
    bcrypt_hash = bcrypt.hashpw(password_hash_bytes, bcrypt.gensalt(rounds=12))

    user.zk_enabled = True
    user.zk_enrolled_at = datetime.utcnow()
    user.password_hash = bcrypt_hash.decode('utf-8')  # Replace old password hash
    user.encrypted_master_key = request_data.encrypted_master_key
    user.kdf_salt = kdf_salt
    user.kdf_algorithm = request_data.kdf_algorithm
    user.kdf_iterations = request_data.kdf_iterations
    user.kdf_memory = request_data.kdf_memory
    user.kdf_parallelism = request_data.kdf_parallelism

    # Log enrollment
    enrollment_log = ZKEnrollmentHistory(
        id=uuid4(),
        user_id=user.id,
        action="enabled",
        from_tier="free",
        to_tier="pro",
        recovery_methods_configured=[],
        ip_address=get_client_ip(request),
        user_agent=get_user_agent(request)
    )
    db.add(enrollment_log)

    await db.commit()

    logger.info("zk_enabled_success", user_id=str(user.id))

    return {
        "message": "Zero-knowledge encryption enabled successfully",
        "zk_enabled": True,
        "kdf_algorithm": user.kdf_algorithm,
        "recovery_phrase_enabled": False
    }


@router.get("/status", response_model=ZKStatusResponse)
async def get_zk_status(
    user = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get zero-knowledge encryption status for current user.

    Returns:
        ZK status including recovery methods
    """
    from app.models.zk_models import HardwareKey, SocialRecoveryContact

    # Count hardware keys
    hardware_keys_result = await db.execute(
        select(HardwareKey).filter(HardwareKey.user_id == user.id)
    )
    hardware_keys_count = len(hardware_keys_result.scalars().all())

    # Check social recovery
    social_contacts_result = await db.execute(
        select(SocialRecoveryContact).filter(
            SocialRecoveryContact.user_id == user.id,
            SocialRecoveryContact.status == "verified"
        )
    )
    social_contacts_count = len(social_contacts_result.scalars().all())

    return ZKStatusResponse(
        zk_enabled=user.zk_enabled,
        zk_enrolled_at=user.zk_enrolled_at,
        kdf_algorithm=user.kdf_algorithm or "pbkdf2",
        kdf_iterations=user.kdf_iterations or 600000,
        recovery_phrase_enabled=user.recovery_phrase_enabled,
        recovery_phrase_verified=user.recovery_phrase_verified,
        hardware_keys_count=hardware_keys_count,
        social_recovery_enabled=social_contacts_count >= settings.SOCIAL_RECOVERY_THRESHOLD,
        current_tier="pro" if user.zk_enabled else "free"  # TODO: Get actual tier
    )


@router.post("/recovery/enable")
async def enable_recovery_phrase(
    request_data: EnableRecoveryPhraseRequest,
    request: Request,
    user = Depends(get_current_zk_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Enable recovery phrase for zero-knowledge encryption.

    Client must:
    1. Generate 24-word BIP39 mnemonic
    2. Derive recovery key from phrase
    3. Encrypt master key with recovery key
    4. Hash phrase for verification (SHA-256)
    5. Send encrypted master key and hash

    Args:
        request_data: Recovery phrase configuration
        user: Current ZK user

    Returns:
        Success message
    """
    if user.recovery_phrase_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Recovery phrase already enabled"
        )

    logger.info("enabling_recovery_phrase", user_id=str(user.id))

    # Store recovery encrypted master key and hash
    user.recovery_encrypted_master_key = request_data.recovery_encrypted_master_key
    user.recovery_phrase_hash = request_data.recovery_phrase_hash
    user.recovery_phrase_enabled = True
    user.recovery_phrase_created_at = datetime.utcnow()
    user.recovery_phrase_verified = False  # User must verify

    # Update enrollment history
    enrollment_log = ZKEnrollmentHistory(
        id=uuid4(),
        user_id=user.id,
        action="upgraded",
        recovery_methods_configured=["phrase"],
        ip_address=get_client_ip(request),
        user_agent=get_user_agent(request),
        metadata={"recovery_phrase_enabled": True}
    )
    db.add(enrollment_log)

    await db.commit()

    logger.info("recovery_phrase_enabled", user_id=str(user.id))

    return {
        "message": "Recovery phrase enabled successfully",
        "recovery_phrase_enabled": True,
        "verified": False,
        "instructions": "Please verify your recovery phrase by entering it"
    }


@router.post("/recovery/verify")
async def verify_recovery_phrase(
    request_data: VerifyRecoveryPhraseRequest,
    user = Depends(get_current_zk_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Verify that user has correctly saved their recovery phrase.

    This confirms the user can successfully recover their account.

    Args:
        request_data: Recovery phrase to verify
        user: Current ZK user

    Returns:
        Verification result
    """
    if not user.recovery_phrase_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Recovery phrase not enabled"
        )

    if user.recovery_phrase_verified:
        return {
            "message": "Recovery phrase already verified",
            "verified": True
        }

    logger.info("verifying_recovery_phrase", user_id=str(user.id))

    # Validate phrase format
    recovery_service = RecoveryPhraseService()
    if not recovery_service.validate_recovery_phrase(request_data.recovery_phrase):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid recovery phrase format"
        )

    # Hash phrase and compare
    phrase_hash = recovery_service.hash_recovery_phrase(request_data.recovery_phrase)

    if phrase_hash != user.recovery_phrase_hash:
        logger.warning("recovery_phrase_verification_failed", user_id=str(user.id))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Recovery phrase does not match"
        )

    # Mark as verified
    user.recovery_phrase_verified = True
    await db.commit()

    logger.info("recovery_phrase_verified", user_id=str(user.id))

    return {
        "message": "Recovery phrase verified successfully",
        "verified": True
    }


@router.post("/recovery/use")
async def recover_with_phrase(
    request_data: RecoverWithPhraseRequest,
    request: Request,
    db: AsyncSession = Depends(get_db)
):
    """
    Recover account using recovery phrase and set new password.

    This is the ONLY way to recover if password is forgotten.

    Flow:
    1. User enters email and recovery phrase
    2. Server fetches recovery_encrypted_master_key
    3. Client decrypts master key with phrase
    4. User sets new password
    5. Client re-encrypts master key with new password
    6. Server updates encrypted_master_key and password_hash

    Args:
        request_data: Recovery data

    Returns:
        New access token
    """
    from app.models.database import User

    logger.info("account_recovery_attempt", email=request_data.email)

    # Fetch user
    result = await db.execute(
        select(User).filter(User.email == request_data.email)
    )
    user = result.scalar_one_or_none()

    if not user:
        logger.warning("recovery_failed_user_not_found", email=request_data.email)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found"
        )

    if not user.recovery_phrase_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Recovery phrase not enabled for this account"
        )

    # Rate limit recovery attempts
    await rate_limit_recovery(request, str(user.id))

    # Validate recovery phrase
    recovery_service = RecoveryPhraseService()
    if not recovery_service.validate_recovery_phrase(request_data.recovery_phrase):
        # Log failed attempt
        attempt = RecoveryAttempt(
            id=uuid4(),
            user_id=user.id,
            recovery_method="phrase",
            success=False,
            ip_address=get_client_ip(request),
            user_agent=get_user_agent(request),
            error_message="Invalid phrase format"
        )
        db.add(attempt)
        await db.commit()

        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid recovery phrase"
        )

    # Verify phrase hash
    phrase_hash = recovery_service.hash_recovery_phrase(request_data.recovery_phrase)

    if phrase_hash != user.recovery_phrase_hash:
        # Log failed attempt
        attempt = RecoveryAttempt(
            id=uuid4(),
            user_id=user.id,
            recovery_method="phrase",
            success=False,
            ip_address=get_client_ip(request),
            user_agent=get_user_agent(request),
            error_message="Phrase hash mismatch"
        )
        db.add(attempt)
        await db.commit()

        logger.warning("recovery_failed_invalid_phrase", user_id=str(user.id))
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid recovery phrase"
        )

    # Update password and encrypted master key
    import bcrypt
    new_password_hash_bytes = request_data.new_password_hash.encode('utf-8')
    bcrypt_hash = bcrypt.hashpw(new_password_hash_bytes, bcrypt.gensalt(rounds=12))

    user.password_hash = bcrypt_hash.decode('utf-8')
    user.encrypted_master_key = request_data.new_encrypted_master_key

    # Update KDF salt if changed (expecting hex string from frontend)
    try:
        new_kdf_salt = bytes.fromhex(request_data.new_kdf_salt)
        user.kdf_salt = new_kdf_salt
    except Exception:
        pass

    # Log successful recovery
    attempt = RecoveryAttempt(
        id=uuid4(),
        user_id=user.id,
        recovery_method="phrase",
        success=True,
        ip_address=get_client_ip(request),
        user_agent=get_user_agent(request)
    )
    db.add(attempt)

    await db.commit()

    logger.info("account_recovery_success", user_id=str(user.id))

    # Create new access token
    from app.dependencies import create_access_token
    access_token = create_access_token(data={"sub": str(user.id)})

    return {
        "message": "Account recovered successfully. Password has been reset.",
        "access_token": access_token,
        "token_type": "bearer"
    }


@router.get("/recovery/info")
async def get_recovery_info(
    email: str,
    db: AsyncSession = Depends(get_db)
):
    """
    Get recovery information for a user (public endpoint for recovery flow).

    Returns encrypted master key and KDF params so client can attempt recovery.

    Args:
        email: User's email

    Returns:
        Recovery information
    """
    from app.models.database import User

    result = await db.execute(
        select(User).filter(User.email == email)
    )
    user = result.scalar_one_or_none()

    if not user:
        # Don't reveal if user exists
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found"
        )

    if not user.recovery_phrase_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Recovery phrase not enabled for this account"
        )

    return {
        "recovery_enabled": True,
        "recovery_encrypted_master_key": user.recovery_encrypted_master_key,
        "kdf_params": {
            "algorithm": user.kdf_algorithm,
            "iterations": user.kdf_iterations,
            "memory": user.kdf_memory,
            "parallelism": user.kdf_parallelism
        }
    }


# ========== HARDWARE KEY ENDPOINTS (FIDO2/WebAuthn) ==========

class HardwareKeyRegisterRequest(BaseModel):
    """Request to register hardware key"""
    key_name: str = Field(..., min_length=1, max_length=100)


class HardwareKeyVerifyRequest(BaseModel):
    """Request to verify hardware key registration"""
    key_name: str
    credential_response: dict
    state: dict
    encrypted_master_key: str  # Master key encrypted with hardware key


class HardwareKeyAuthRequest(BaseModel):
    """Request to authenticate with hardware key"""
    credential_response: dict
    state: dict


@router.post("/hardware/register/challenge")
async def hardware_key_register_challenge(
    request_data: HardwareKeyRegisterRequest,
    user = Depends(get_current_zk_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Generate WebAuthn challenge for hardware key registration.

    Client will use this challenge with navigator.credentials.create().

    Args:
        request_data: Key name
        user: Current ZK user

    Returns:
        WebAuthn registration options
    """
    from app.services.fido2_service import get_fido2_service
    from app.models.zk_models import HardwareKey

    # Check if user has too many keys
    result = await db.execute(
        select(HardwareKey).filter(HardwareKey.user_id == user.id)
    )
    existing_keys = result.scalars().all()

    if len(existing_keys) >= settings.MAX_HARDWARE_KEYS_PER_USER:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Maximum {settings.MAX_HARDWARE_KEYS_PER_USER} hardware keys allowed"
        )

    # Get existing credential IDs
    existing_cred_ids = [
        base64.urlsafe_b64decode(key.credential_id)
        for key in existing_keys
    ]

    # Generate registration options
    fido2_service = get_fido2_service()
    options = fido2_service.generate_registration_options(
        user_id=str(user.id),
        username=user.username,
        email=user.email,
        existing_credentials=existing_cred_ids
    )

    logger.info(
        "hardware_key_registration_challenge_generated",
        user_id=str(user.id),
        key_name=request_data.key_name
    )

    return options


@router.post("/hardware/register/verify")
async def hardware_key_register_verify(
    request_data: HardwareKeyVerifyRequest,
    request: Request,
    user = Depends(get_current_zk_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Verify hardware key registration and store credential.

    Args:
        request_data: Registration response from client
        user: Current ZK user

    Returns:
        Success message
    """
    from app.services.fido2_service import get_fido2_service
    from app.models.zk_models import HardwareKey

    fido2_service = get_fido2_service()

    # Verify registration
    try:
        expected_challenge = base64.urlsafe_b64decode(request_data.state["challenge"])
        verified_cred = fido2_service.verify_registration(
            credential_response=request_data.credential_response,
            expected_challenge=expected_challenge
        )
    except ValueError as e:
        logger.warning(
            "hardware_key_registration_verification_failed",
            user_id=str(user.id),
            error=str(e)
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Hardware key verification failed: {str(e)}"
        )

    # Check if this is the first hardware key (make it primary)
    result = await db.execute(
        select(HardwareKey).filter(HardwareKey.user_id == user.id)
    )
    existing_keys = result.scalars().all()
    is_primary = len(existing_keys) == 0

    # Store hardware key
    hardware_key = HardwareKey(
        id=uuid4(),
        user_id=user.id,
        key_name=request_data.key_name,
        credential_id=verified_cred["credential_id"],
        public_key=verified_cred["public_key"],
        aaguid=verified_cred.get("aaguid"),
        sign_count=verified_cred.get("sign_count", 0),
        encrypted_master_key=request_data.encrypted_master_key,
        transports=verified_cred.get("transports", ["usb"]),
        is_primary=is_primary,
        is_backup=False
    )
    db.add(hardware_key)

    # Update enrollment history
    enrollment_log = ZKEnrollmentHistory(
        id=uuid4(),
        user_id=user.id,
        action="upgraded",
        recovery_methods_configured=["hardware_key"],
        ip_address=get_client_ip(request),
        user_agent=get_user_agent(request),
        metadata={"key_name": request_data.key_name, "aaguid": verified_cred.get("aaguid")}
    )
    db.add(enrollment_log)

    await db.commit()

    logger.info(
        "hardware_key_registered",
        user_id=str(user.id),
        key_name=request_data.key_name,
        is_primary=is_primary
    )

    return {
        "message": "Hardware key registered successfully",
        "key_id": str(hardware_key.id),
        "key_name": hardware_key.key_name,
        "is_primary": is_primary
    }


@router.post("/hardware/auth/challenge")
async def hardware_key_auth_challenge(
    user = Depends(get_current_zk_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Generate WebAuthn challenge for hardware key authentication.

    Client will use this with navigator.credentials.get().

    Args:
        user: Current ZK user

    Returns:
        WebAuthn authentication options
    """
    from app.services.fido2_service import get_fido2_service
    from app.models.zk_models import HardwareKey

    # Get user's hardware keys
    result = await db.execute(
        select(HardwareKey).filter(HardwareKey.user_id == user.id)
    )
    hardware_keys = result.scalars().all()

    if not hardware_keys:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No hardware keys registered"
        )

    # Format credentials for FIDO2 service
    credentials = [
        {
            "credential_id": key.credential_id,
            "public_key": key.public_key,
            "sign_count": key.sign_count,
            "transports": key.transports or ["usb"]
        }
        for key in hardware_keys
    ]

    # Generate authentication options
    fido2_service = get_fido2_service()
    options = fido2_service.generate_authentication_options(credentials)

    logger.info(
        "hardware_key_auth_challenge_generated",
        user_id=str(user.id),
        num_keys=len(hardware_keys)
    )

    return options


@router.post("/hardware/auth/verify")
async def hardware_key_auth_verify(
    request_data: HardwareKeyAuthRequest,
    user = Depends(get_current_zk_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Verify hardware key authentication and return encrypted master key.

    Args:
        request_data: Authentication response
        user: Current ZK user

    Returns:
        Encrypted master key
    """
    from app.services.fido2_service import get_fido2_service
    from app.models.zk_models import HardwareKey

    # Get user's hardware keys
    result = await db.execute(
        select(HardwareKey).filter(HardwareKey.user_id == user.id)
    )
    hardware_keys = result.scalars().all()

    # Format credentials
    credentials = [
        {
            "credential_id": key.credential_id,
            "public_key": key.public_key,
            "sign_count": key.sign_count
        }
        for key in hardware_keys
    ]

    # Verify authentication
    fido2_service = get_fido2_service()
    try:
        expected_challenge = base64.urlsafe_b64decode(request_data.state["challenge"])
        verification = fido2_service.verify_authentication(
            credential_response=request_data.credential_response,
            expected_challenge=expected_challenge,
            stored_credentials=credentials
        )
    except ValueError as e:
        logger.warning(
            "hardware_key_auth_failed",
            user_id=str(user.id),
            error=str(e)
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Hardware key authentication failed: {str(e)}"
        )

    # Find the key that was used
    used_key = None
    for key in hardware_keys:
        if key.credential_id == verification["credential_id"]:
            used_key = key
            break

    if not used_key:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Hardware key not found"
        )

    # Update sign count (replay protection)
    used_key.sign_count = verification["new_sign_count"]
    used_key.last_used_at = datetime.utcnow()
    await db.commit()

    logger.info(
        "hardware_key_auth_success",
        user_id=str(user.id),
        key_id=str(used_key.id),
        key_name=used_key.key_name
    )

    return {
        "verified": True,
        "encrypted_master_key": used_key.encrypted_master_key,
        "key_name": used_key.key_name
    }


@router.get("/hardware/list")
async def list_hardware_keys(
    user = Depends(get_current_zk_user),
    db: AsyncSession = Depends(get_db)
):
    """
    List user's registered hardware keys.

    Args:
        user: Current ZK user

    Returns:
        List of hardware keys
    """
    from app.models.zk_models import HardwareKey

    result = await db.execute(
        select(HardwareKey).filter(HardwareKey.user_id == user.id)
    )
    hardware_keys = result.scalars().all()

    return {
        "hardware_keys": [
            {
                "id": str(key.id),
                "key_name": key.key_name,
                "is_primary": key.is_primary,
                "is_backup": key.is_backup,
                "created_at": key.created_at.isoformat() if key.created_at else None,
                "last_used_at": key.last_used_at.isoformat() if key.last_used_at else None,
                "transports": key.transports
            }
            for key in hardware_keys
        ],
        "count": len(hardware_keys),
        "max_allowed": settings.MAX_HARDWARE_KEYS_PER_USER
    }


@router.delete("/hardware/{key_id}")
async def delete_hardware_key(
    key_id: str,
    user = Depends(get_current_zk_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Delete a hardware key.

    Args:
        key_id: Hardware key ID
        user: Current ZK user

    Returns:
        Success message
    """
    from app.models.zk_models import HardwareKey

    # Get key
    result = await db.execute(
        select(HardwareKey).filter(
            HardwareKey.id == key_id,
            HardwareKey.user_id == user.id
        )
    )
    hardware_key = result.scalar_one_or_none()

    if not hardware_key:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Hardware key not found"
        )

    # Check if this is the only recovery method
    if hardware_key.is_primary and not user.recovery_phrase_enabled:
        # Check if there are other hardware keys
        result = await db.execute(
            select(HardwareKey).filter(HardwareKey.user_id == user.id)
        )
        all_keys = result.scalars().all()

        if len(all_keys) == 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot delete last recovery method. Set up recovery phrase or another hardware key first."
            )

    # Delete key
    await db.delete(hardware_key)
    await db.commit()

    logger.info(
        "hardware_key_deleted",
        user_id=str(user.id),
        key_id=key_id,
        key_name=hardware_key.key_name
    )

    return {
        "message": "Hardware key deleted successfully",
        "deleted_key_name": hardware_key.key_name
    }
