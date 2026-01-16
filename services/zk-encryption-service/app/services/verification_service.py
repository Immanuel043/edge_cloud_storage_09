# services/zk-encryption-service/app/services/verification_service.py
"""
Verification Code Service for ZK Encryption Service

Handles generation, storage, and validation of email verification codes.
Adapted from storage service for ZKUser model.
"""
import secrets
import structlog
from datetime import datetime, timedelta, timezone
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update

from app.config import settings
from app.models.database import ZKUser
from app.database import get_redis

logger = structlog.get_logger()


class VerificationService:
    """Service for managing email verification codes"""

    def __init__(self):
        self.code_length = 6  # 6-digit code
        self.expiry_minutes = 30  # 30 minute expiry
        self.max_attempts = 5  # Max 5 attempts
        self.resend_cooldown = 60  # 60 second cooldown

    def generate_verification_code(self) -> str:
        """
        Generate a cryptographically secure 6-digit verification code.

        Returns:
            6-digit numeric code as string
        """
        # Generate random number between 100000 and 999999
        code = secrets.randbelow(900000) + 100000
        return str(code)

    async def store_verification_code(
        self,
        db: AsyncSession,
        user: ZKUser,
        code: str
    ) -> bool:
        """
        Store verification code in database with expiry time.

        Args:
            db: Database session
            user: ZKUser object
            code: Verification code to store

        Returns:
            True if stored successfully
        """
        try:
            expiry_time = datetime.now(timezone.utc) + timedelta(minutes=self.expiry_minutes)

            await db.execute(
                update(ZKUser)
                .where(ZKUser.id == user.id)
                .values(
                    verification_code=code,
                    verification_code_expires_at=expiry_time,
                    verification_code_attempts=0
                )
            )
            await db.commit()

            logger.info("zk_verification_code_stored", user_id=str(user.id), email=user.email)
            return True

        except Exception as e:
            logger.error("zk_verification_code_store_error", error=str(e), user_id=str(user.id))
            await db.rollback()
            return False

    async def verify_code(
        self,
        db: AsyncSession,
        user: ZKUser,
        code: str
    ) -> tuple[bool, str]:
        """
        Verify the provided code against stored code.

        Args:
            db: Database session
            user: ZKUser object
            code: Code to verify

        Returns:
            (is_valid: bool, message: str)
        """
        # Check if code exists
        if not user.verification_code:
            return False, "No verification code found. Please request a new code."

        # Check if code has expired
        if user.verification_code_expires_at and user.verification_code_expires_at < datetime.now(timezone.utc):
            return False, "Verification code has expired. Please request a new code."

        # Check if max attempts exceeded
        if user.verification_code_attempts >= self.max_attempts:
            return False, "Maximum verification attempts exceeded. Please request a new code."

        # Verify code
        if user.verification_code != code:
            # Increment attempt counter
            new_attempts = user.verification_code_attempts + 1
            await db.execute(
                update(ZKUser)
                .where(ZKUser.id == user.id)
                .values(
                    verification_code_attempts=new_attempts
                )
            )
            await db.commit()

            remaining_attempts = self.max_attempts - new_attempts
            logger.warning(
                "zk_verification_code_invalid",
                user_id=str(user.id),
                attempts_remaining=remaining_attempts
            )
            return False, f"Invalid verification code. {remaining_attempts} attempts remaining."

        # Code is valid - mark email as verified and clear code
        await db.execute(
            update(ZKUser)
            .where(ZKUser.id == user.id)
            .values(
                email_verified=True,
                verification_code=None,
                verification_code_expires_at=None,
                verification_code_attempts=0
            )
        )
        await db.commit()

        logger.info("zk_email_verified", user_id=str(user.id), email=user.email)
        return True, "Email verified successfully"

    async def can_resend_code(self, email: str) -> tuple[bool, Optional[str]]:
        """
        Check if code can be resent (cooldown check).

        Args:
            email: User email

        Returns:
            (can_resend: bool, message: Optional[str])
        """
        try:
            redis_client = await get_redis()
            if redis_client is None:
                # If Redis unavailable, allow resend (fail open)
                logger.warning("zk_redis_unavailable_resend_check", email=email)
                return True, None

            key = f"zk:verification:resend:{email}"
            last_sent = await redis_client.get(key)

            if last_sent:
                # Check cooldown
                time_since_last = datetime.now(timezone.utc).timestamp() - float(last_sent)
                if time_since_last < self.resend_cooldown:
                    remaining = int(self.resend_cooldown - time_since_last)
                    return False, f"Please wait {remaining} seconds before requesting a new code."

            # Update last sent time
            await redis_client.setex(key, self.resend_cooldown, str(datetime.now(timezone.utc).timestamp()))
            return True, None

        except Exception as e:
            logger.error("zk_resend_cooldown_check_error", error=str(e), email=email)
            # Fail open - allow resend if Redis check fails
            return True, None

    async def get_user_by_email(
        self,
        db: AsyncSession,
        email: str
    ) -> Optional[ZKUser]:
        """
        Get ZK user by email address.

        Args:
            db: Database session
            email: Email address

        Returns:
            ZKUser object or None
        """
        result = await db.execute(
            select(ZKUser).where(ZKUser.email == email)
        )
        return result.scalar_one_or_none()

    async def create_temp_user(
        self,
        db: AsyncSession,
        email: str
    ) -> ZKUser:
        """
        Create a temporary ZK user record for email verification.
        User will be activated after verification and ZK key setup.

        Args:
            db: Database session
            email: Email address

        Returns:
            Created ZKUser object
        """
        # Check if user already exists
        existing_user = await self.get_user_by_email(db, email)
        if existing_user:
            return existing_user

        # Create temporary user (ZK credentials will be set during registration completion)
        user = ZKUser(
            email=email,
            username=email.split("@")[0],  # Temporary username
            password_hash="",  # Will be set during registration completion
            email_verified=False,
            is_active=False  # Inactive until email verified and ZK keys set
        )

        db.add(user)
        await db.commit()
        await db.refresh(user)

        logger.info("zk_temp_user_created", email=email, user_id=str(user.id))
        return user


# Global service instance
verification_service = VerificationService()
