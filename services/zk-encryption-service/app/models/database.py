"""
Database models for Zero-Knowledge Encryption Service

These models mirror the storage-service models but include only
the tables needed for ZK operations. Both services share the same database.
"""
from sqlalchemy import Column, String, Integer, DateTime, Boolean, BigInteger, Text, JSON
from sqlalchemy.dialects.postgresql import UUID, BYTEA, JSONB
from sqlalchemy.ext.declarative import declarative_base
from datetime import datetime
import uuid

Base = declarative_base()


class User(Base):
    """User model (shared with storage-service)"""
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String(255), unique=True, nullable=False)
    username = Column(String(100), unique=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    user_type = Column(String(20), default="individual")
    storage_quota = Column(BigInteger, default=107374182400)  # 100GB default
    storage_used = Column(BigInteger, default=0)
    is_active = Column(Boolean, default=True)
    theme_preference = Column(String(10), default="light")
    created_at = Column(DateTime, default=datetime.utcnow)

    # Zero-Knowledge Encryption fields
    zk_enabled = Column(Boolean, default=False)
    zk_enrolled_at = Column(DateTime, nullable=True)
    encrypted_master_key = Column(Text, nullable=True)
    master_key_iv = Column(Text, nullable=True)  # IV for AES-GCM encryption of master key
    kdf_salt = Column(BYTEA, nullable=True)
    kdf_algorithm = Column(String(20), default='pbkdf2', nullable=True)
    kdf_iterations = Column(Integer, default=600000, nullable=True)
    kdf_memory = Column(Integer, nullable=True)  # For Argon2id
    kdf_parallelism = Column(Integer, nullable=True)  # For Argon2id
    recovery_phrase_enabled = Column(Boolean, default=False)
    recovery_phrase_verified = Column(Boolean, default=False)
    recovery_encrypted_master_key = Column(Text, nullable=True)
    recovery_phrase_hash = Column(String(64), nullable=True)


class StorageObject(Base):
    """Storage object model (shared with storage-service) - minimal fields for ZK"""
    __tablename__ = "objects"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), nullable=False)
    folder_id = Column(UUID(as_uuid=True), nullable=True)
    file_name = Column(String(255), nullable=False)
    file_size = Column(BigInteger, nullable=False)
    mime_type = Column(String(100))
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    is_deleted = Column(Boolean, default=False)

    # Encryption mode to distinguish file types
    # Values: 'none' (no encryption), 'server_side' (storage service encrypts), 'client_zk' (ZK client-side encryption)
    encryption_mode = Column(String(20), default='client_zk', nullable=False)

    # Zero-Knowledge Encryption fields
    is_encrypted = Column(Boolean, default=False)
    encrypted_file_key = Column(Text, nullable=True)
    file_key_iv = Column(String(255), nullable=True)
    encryption_algorithm = Column(String(50), default="AES-256-GCM", nullable=True)
    encryption_version = Column(Integer, default=2, nullable=True)  # 1=V1 (basic), 2=V2 (HKDF+AAD) - default V2
    upload_status = Column(String(20), default="completed", nullable=True)
    upload_id = Column(String(255), nullable=True)
    uploaded_at = Column(DateTime, nullable=True)
    file_hash = Column(String(128), nullable=True)

    # File metadata (shared with storage-service) - includes ZK thumbnail
    file_metadata = Column(JSONB, nullable=True)
