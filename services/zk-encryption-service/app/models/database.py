"""
Database models for Zero-Knowledge Encryption Service

IMPORTANT: This is a SEPARATE database from the Storage Service.
The ZK service has its own PostgreSQL instance with completely
isolated user accounts, files, and encryption keys.

There is NO data sharing with the Storage Service.
"""
from sqlalchemy import (
    Column, String, Integer, DateTime, Boolean, BigInteger, Text,
    ForeignKey, Index
)
from sqlalchemy.dialects.postgresql import UUID, BYTEA, JSONB
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from datetime import datetime
import uuid

Base = declarative_base()


class ZKUser(Base):
    """
    ZK User Account - Completely separate from Storage Service users.
    
    A user can have both a Storage Service account AND a ZK account
    (potentially with the same email), but they are completely independent.
    """
    __tablename__ = "zk_users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    
    # Identity (separate auth from Storage Service)
    email = Column(String(255), unique=True, nullable=False, index=True)
    username = Column(String(100), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    
    # Plan & Quota
    plan_type = Column(String(20), default="free")  # free, personal, professional, enterprise
    storage_quota = Column(BigInteger, default=1073741824)  # 1GB default (free tier)
    storage_used = Column(BigInteger, default=0)
    
    # Stripe billing (separate from Storage Service)
    stripe_customer_id = Column(String(255), nullable=True)
    stripe_subscription_id = Column(String(255), nullable=True)
    billing_status = Column(String(20), default="active")  # active, past_due, canceled
    
    # Bandwidth overrides (NULL = use plan default from PLAN_LIMITS)
    bandwidth_limit_mbps = Column(Integer, nullable=True)
    bandwidth_burst_mbps = Column(Integer, nullable=True)
    max_concurrent_streams = Column(Integer, nullable=True)
    
    # Account status
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    last_login_at = Column(DateTime(timezone=True), nullable=True)

    # Email verification fields
    email_verified = Column(Boolean, default=False, nullable=False)
    verification_code = Column(String(6), nullable=True)
    verification_code_expires_at = Column(DateTime(timezone=True), nullable=True)
    verification_code_attempts = Column(Integer, default=0, nullable=False)

    # Zero-Knowledge Encryption Master Key
    # This is the user's master key encrypted with their password-derived key
    encrypted_master_key = Column(Text, nullable=True)
    master_key_iv = Column(Text, nullable=True)  # IV for AES-GCM encryption of master key
    
    # Key Derivation Function parameters
    kdf_salt = Column(BYTEA, nullable=True)
    kdf_algorithm = Column(String(20), default='argon2id', nullable=True)  # argon2id or pbkdf2
    kdf_iterations = Column(Integer, default=3, nullable=True)  # Argon2id time cost
    kdf_memory = Column(Integer, default=65536, nullable=True)  # Argon2id memory (64MB)
    kdf_parallelism = Column(Integer, default=4, nullable=True)  # Argon2id parallelism
    
    # Recovery options
    recovery_phrase_enabled = Column(Boolean, default=False)
    recovery_phrase_verified = Column(Boolean, default=False)
    recovery_encrypted_master_key = Column(Text, nullable=True)
    recovery_phrase_hash = Column(String(64), nullable=True)
    
    # ZK enrollment status
    zk_enrolled_at = Column(DateTime(timezone=True), nullable=True)
    
    # Relationships
    objects = relationship("ZKObject", back_populates="user", cascade="all, delete-orphan")
    folders = relationship("ZKFolder", back_populates="user", cascade="all, delete-orphan")

    __table_args__ = (
        Index('idx_zk_user_email', 'email'),
        Index('idx_zk_user_plan', 'plan_type'),
        Index('idx_zk_user_stripe', 'stripe_customer_id'),
    )


class ZKFolder(Base):
    """ZK Folder - for organizing encrypted files"""
    __tablename__ = "zk_folders"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("zk_users.id", ondelete="CASCADE"), nullable=False)
    parent_id = Column(UUID(as_uuid=True), ForeignKey("zk_folders.id", ondelete="CASCADE"), nullable=True)
    
    # Folder name is encrypted with user's master key
    encrypted_name = Column(Text, nullable=False)
    name_iv = Column(String(255), nullable=False)
    
    # Metadata
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    is_deleted = Column(Boolean, default=False)
    
    # Relationships
    user = relationship("ZKUser", back_populates="folders")

    __table_args__ = (
        Index('idx_zk_folder_user', 'user_id'),
        Index('idx_zk_folder_parent', 'parent_id'),
    )


class ZKObject(Base):
    """
    ZK Encrypted Object (File)
    
    All file content is encrypted client-side with keys only the user knows.
    The server stores encrypted blobs and encrypted metadata.
    """
    __tablename__ = "zk_objects"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("zk_users.id", ondelete="CASCADE"), nullable=False)
    folder_id = Column(UUID(as_uuid=True), ForeignKey("zk_folders.id", ondelete="SET NULL"), nullable=True)
    
    # File name is encrypted with user's master key (for privacy)
    encrypted_file_name = Column(Text, nullable=False)
    file_name_iv = Column(String(255), nullable=False)
    
    # Unencrypted metadata (needed for quota enforcement)
    file_size = Column(BigInteger, nullable=False)
    mime_type = Column(String(100), nullable=True)  # Can be encrypted if privacy needed
    
    # File encryption key (encrypted with user's master key)
    encrypted_file_key = Column(Text, nullable=False)
    file_key_iv = Column(String(255), nullable=False)
    
    # Encryption details
    encryption_algorithm = Column(String(50), default="AES-256-GCM", nullable=False)
    encryption_version = Column(Integer, default=2, nullable=False)  # 2=V2 (HKDF+AAD)
    
    # Storage location (path to encrypted chunks)
    storage_path = Column(String(500), nullable=True)
    chunk_info = Column(JSONB, nullable=True)  # Chunk hashes, paths, count
    content_hash = Column(String(128), nullable=True)  # Hash of encrypted content
    
    # Upload tracking
    upload_status = Column(String(20), default="completed", nullable=False)
    upload_id = Column(String(255), nullable=True)
    
    # Encrypted thumbnail (for image/video previews)
    encrypted_thumbnail = Column(Text, nullable=True)
    thumbnail_iv = Column(String(255), nullable=True)
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    uploaded_at = Column(DateTime(timezone=True), nullable=True)
    last_accessed_at = Column(DateTime(timezone=True), nullable=True)
    
    # Soft delete for trash
    is_deleted = Column(Boolean, default=False)
    deleted_at = Column(DateTime(timezone=True), nullable=True)
    
    # Relationships
    user = relationship("ZKUser", back_populates="objects")

    __table_args__ = (
        Index('idx_zk_object_user', 'user_id'),
        Index('idx_zk_object_folder', 'folder_id'),
        Index('idx_zk_object_deleted', 'is_deleted', 'deleted_at'),
        Index('idx_zk_object_upload_status', 'upload_status'),
    )


class ZKAuditLog(Base):
    """Audit log for ZK operations - for security monitoring"""
    __tablename__ = "zk_audit_logs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), nullable=True)  # NULL if user lookup failed
    
    # Action details
    action = Column(String(50), nullable=False)  # login, upload, download, key_rotation, etc.
    success = Column(Boolean, nullable=False)
    error_message = Column(Text, nullable=True)
    
    # Request context
    ip_address = Column(String(45), nullable=True)
    user_agent = Column(Text, nullable=True)
    
    # Timestamp
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index('idx_zk_audit_user', 'user_id'),
        Index('idx_zk_audit_action', 'action'),
        Index('idx_zk_audit_time', 'created_at'),
    )
