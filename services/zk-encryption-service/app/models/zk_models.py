"""
Zero-Knowledge Encryption Database Models

These models extend the existing database schema with ZK-specific tables
and fields. All models use the same database as storage-service for consistency.
"""
from datetime import datetime
from typing import Optional, List, Dict, Any
from uuid import UUID, uuid4

from sqlalchemy import (
    Column, String, Integer, Boolean, BigInteger, Numeric, DateTime,
    ForeignKey, Text, LargeBinary, ARRAY, Index
)
from sqlalchemy.dialects.postgresql import UUID as PGUUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

# Import Base from database.py to ensure all models share the same metadata
from app.models.database import Base


# ========== SUBSCRIPTION TIERS ==========

class SubscriptionTier(Base):
    """Subscription tier definitions (Free, Pro, Premium, Enterprise)"""
    __tablename__ = 'subscription_tiers'

    id = Column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
    name = Column(String(50), nullable=False, unique=True)  # 'free', 'pro', 'premium', 'enterprise'
    display_name = Column(String(100), nullable=False)
    price_monthly = Column(Numeric(10, 2), nullable=False)
    price_yearly = Column(Numeric(10, 2), nullable=False)
    storage_quota_bytes = Column(BigInteger, nullable=False)  # -1 for unlimited
    features = Column(JSONB, nullable=False, default={})
    is_active = Column(Boolean, nullable=False, default=True)
    sort_order = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    subscriptions = relationship("UserSubscription", back_populates="tier")

    def __repr__(self):
        return f"<SubscriptionTier {self.name} - ${self.price_monthly}/mo>"


class UserSubscription(Base):
    """User's current subscription"""
    __tablename__ = 'user_subscriptions'

    id = Column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(PGUUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    tier_id = Column(PGUUID(as_uuid=True), ForeignKey('subscription_tiers.id'), nullable=False)
    billing_cycle = Column(String(20), nullable=False, default='monthly')  # 'monthly' or 'yearly'
    status = Column(String(20), nullable=False, default='active')  # 'active', 'cancelled', 'expired'
    started_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=True)
    cancelled_at = Column(DateTime(timezone=True), nullable=True)
    payment_method = Column(String(50), nullable=True)
    last_payment_at = Column(DateTime(timezone=True), nullable=True)
    next_payment_at = Column(DateTime(timezone=True), nullable=True)
    subscription_metadata = Column(JSONB, default={})  # Renamed from 'metadata' (SQLAlchemy reserved word)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    tier = relationship("SubscriptionTier", back_populates="subscriptions")

    __table_args__ = (
        Index('idx_user_subscriptions_user_id', 'user_id'),
        Index('idx_user_subscriptions_status', 'status'),
    )

    def __repr__(self):
        return f"<UserSubscription user={self.user_id} tier={self.tier.name if self.tier else 'unknown'}>"


# ========== HARDWARE KEYS (FIDO2/WebAuthn) ==========

class HardwareKey(Base):
    """Hardware security keys (YubiKey, Titan, etc.) for recovery"""
    __tablename__ = 'hardware_keys'

    id = Column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(PGUUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    key_name = Column(String(100), nullable=False)  # User-friendly name
    credential_id = Column(Text, nullable=False, unique=True)  # WebAuthn credential ID
    public_key = Column(Text, nullable=False)  # Public key for verification
    aaguid = Column(String(36), nullable=True)  # Authenticator AAGUID
    sign_count = Column(Integer, nullable=False, default=0)  # Counter for replay protection
    encrypted_master_key = Column(Text, nullable=False)  # Master key encrypted with hardware key
    transports = Column(ARRAY(String(20)), nullable=True)  # ['usb', 'nfc', 'ble', 'internal']
    is_primary = Column(Boolean, nullable=False, default=False)
    is_backup = Column(Boolean, nullable=False, default=False)
    last_used_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    extra_metadata = Column(JSONB, default={})

    __table_args__ = (
        Index('idx_hardware_keys_user_id', 'user_id'),
        Index('idx_hardware_keys_credential_id', 'credential_id'),
    )

    def __repr__(self):
        return f"<HardwareKey {self.key_name} user={self.user_id}>"


# ========== SOCIAL RECOVERY ==========

class SocialRecoveryContact(Base):
    """Trusted contacts for social recovery (Shamir Secret Sharing)"""
    __tablename__ = 'social_recovery_contacts'

    id = Column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(PGUUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    contact_email = Column(String(255), nullable=False)
    contact_name = Column(String(100), nullable=True)
    share_number = Column(Integer, nullable=False)  # 1-5
    encrypted_share = Column(Text, nullable=False)  # Shamir secret share
    status = Column(String(20), nullable=False, default='pending')  # 'pending', 'verified', 'revoked'
    verification_token = Column(String(64), nullable=True)
    verified_at = Column(DateTime(timezone=True), nullable=True)
    last_notified_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    extra_metadata = Column(JSONB, default={})

    __table_args__ = (
        Index('idx_social_recovery_user_id', 'user_id'),
    )

    def __repr__(self):
        return f"<SocialRecoveryContact user={self.user_id} share={self.share_number}>"


# ========== RECOVERY ATTEMPTS (Security Logging) ==========

class RecoveryAttempt(Base):
    """Log all account recovery attempts for security monitoring"""
    __tablename__ = 'recovery_attempts'

    id = Column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(PGUUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    recovery_method = Column(String(50), nullable=False)  # 'phrase', 'hardware', 'social'
    success = Column(Boolean, nullable=False)
    ip_address = Column(String(45), nullable=True)
    user_agent = Column(Text, nullable=True)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    extra_metadata = Column(JSONB, default={})

    __table_args__ = (
        Index('idx_recovery_attempts_user_id', 'user_id'),
        Index('idx_recovery_attempts_created_at', 'created_at'),
    )

    def __repr__(self):
        return f"<RecoveryAttempt user={self.user_id} method={self.recovery_method} success={self.success}>"


# ========== ZK ENROLLMENT HISTORY ==========

class ZKEnrollmentHistory(Base):
    """Track when users enable/disable ZK encryption"""
    __tablename__ = 'zk_enrollment_history'

    id = Column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(PGUUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    action = Column(String(50), nullable=False)  # 'enabled', 'disabled', 'upgraded'
    from_tier = Column(String(50), nullable=True)
    to_tier = Column(String(50), nullable=True)
    recovery_methods_configured = Column(ARRAY(String(50)), nullable=True)
    ip_address = Column(String(45), nullable=True)
    user_agent = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    extra_metadata = Column(JSONB, default={})

    __table_args__ = (
        Index('idx_zk_enrollment_user_id', 'user_id'),
    )

    def __repr__(self):
        return f"<ZKEnrollmentHistory user={self.user_id} action={self.action}>"


# ========== PYDANTIC MODELS (for API validation) ==========

from pydantic import BaseModel, EmailStr, Field
from typing import Literal


class SubscriptionTierResponse(BaseModel):
    """API response for subscription tier info"""
    id: UUID
    name: str
    display_name: str
    price_monthly: float
    price_yearly: float
    storage_quota_gb: int
    features: Dict[str, Any]
    is_active: bool

    class Config:
        from_attributes = True


class UserSubscriptionResponse(BaseModel):
    """API response for user's subscription"""
    id: UUID
    user_id: UUID
    tier: SubscriptionTierResponse
    billing_cycle: Literal['monthly', 'yearly']
    status: Literal['active', 'cancelled', 'expired']
    started_at: datetime
    expires_at: Optional[datetime]
    next_payment_at: Optional[datetime]

    class Config:
        from_attributes = True


class HardwareKeyResponse(BaseModel):
    """API response for hardware key info"""
    id: UUID
    key_name: str
    is_primary: bool
    is_backup: bool
    last_used_at: Optional[datetime]
    created_at: datetime
    transports: Optional[List[str]]

    class Config:
        from_attributes = True


class RecoveryPhraseRequest(BaseModel):
    """Request to verify recovery phrase"""
    phrase: str = Field(..., min_length=23)  # 24 words separated by spaces


class HardwareKeyRegisterRequest(BaseModel):
    """Request to register hardware key"""
    key_name: str = Field(..., min_length=1, max_length=100)
    credential_response: Dict[str, Any]  # WebAuthn credential
    encrypted_master_key: str  # Master key encrypted with hardware key


class SocialRecoverySetupRequest(BaseModel):
    """Request to setup social recovery"""
    contacts: List[Dict[str, str]]  # [{"email": "...", "name": "..."}]
    shares: List[str]  # Shamir shares (encrypted)


class ZKEnableRequest(BaseModel):
    """Request to enable ZK encryption"""
    encrypted_master_key: str
    kdf_salt: str
    kdf_algorithm: Literal['pbkdf2', 'argon2id'] = 'pbkdf2'
    kdf_iterations: int = Field(default=600000, ge=1)  # Argon2id uses 3, PBKDF2 uses 600000
    kdf_memory: Optional[int] = Field(default=None, ge=16384)  # Min 16MB for Argon2id
    kdf_parallelism: Optional[int] = Field(default=None, ge=1)  # For Argon2
    recovery_encrypted_master_key: Optional[str] = None
    recovery_phrase_hash: Optional[str] = None


class ZKStatusResponse(BaseModel):
    """Response for ZK encryption status"""
    zk_enabled: bool
    zk_enrolled_at: Optional[datetime]
    kdf_algorithm: str
    kdf_iterations: int
    recovery_phrase_enabled: bool
    recovery_phrase_verified: bool
    hardware_keys_count: int
    social_recovery_enabled: bool
    current_tier: str

    class Config:
        from_attributes = True
