# services/zk-encryption-service/app/models/schemas.py
"""
Pydantic schemas for ZK Encryption Service
"""
from pydantic import BaseModel, EmailStr, field_validator
from typing import Optional


# ========== Email Verification Registration Schemas ==========

class RegisterZKInitRequest(BaseModel):
    """Request to start ZK registration - sends verification code"""
    email: EmailStr


class RegisterZKVerifyRequest(BaseModel):
    """Request to verify email code for ZK registration"""
    email: EmailStr
    verification_code: str

    @field_validator('verification_code')
    @classmethod
    def validate_code(cls, v):
        """Validate verification code format"""
        if not v or len(v) != 6 or not v.isdigit():
            raise ValueError('Verification code must be 6 digits')
        return v


class RegisterZKCompleteRequest(BaseModel):
    """Request to complete ZK registration after email verification"""
    email: EmailStr
    username: str
    password_hash: str  # SHA-256 hex (64 chars)
    encrypted_master_key: str  # Base64
    master_key_iv: str  # Base64
    kdf_salt: str  # Hex
    kdf_algorithm: str = "pbkdf2"
    kdf_iterations: int = 600000
    kdf_memory: Optional[int] = None
    kdf_parallelism: Optional[int] = None
    verification_token: str  # Token from verify step
    plan_code: Optional[str] = "zk_free"  # Default ZK plan
    billing_cycle: Optional[str] = "monthly"  # Billing cycle: 'monthly', 'six_months', 'yearly'
    recovery_encrypted_master_key: Optional[str] = None
    recovery_phrase_hash: Optional[str] = None

    @field_validator('password_hash')
    @classmethod
    def validate_password_hash(cls, v):
        """Validate password hash is SHA-256 (64 hex chars)"""
        if not v or len(v) != 64:
            raise ValueError('Password hash must be 64 characters (SHA-256 hex)')
        return v


class ResendCodeRequestZK(BaseModel):
    """Request to resend verification code for ZK"""
    email: EmailStr


class VerificationResponseZK(BaseModel):
    """Response after ZK email verification"""
    verified: bool
    token: str
    message: Optional[str] = None
