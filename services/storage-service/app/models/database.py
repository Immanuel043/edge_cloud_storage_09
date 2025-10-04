# services/storage-service/app/models/database.py

from sqlalchemy import (
    Column, String, Integer, DateTime, Boolean,
    ForeignKey, JSON, BigInteger, Text, UniqueConstraint, Index
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.ext.declarative import declarative_base
from datetime import datetime
import uuid

Base = declarative_base()

class User(Base):
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

class Folder(Base):
    __tablename__ = "folders"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    parent_id = Column(UUID(as_uuid=True), ForeignKey("folders.id"), nullable=True)
    name = Column(String(255), nullable=False)
    path = Column(String(1000), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

class Object(Base):
    __tablename__ = "objects"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    folder_id = Column(UUID(as_uuid=True), ForeignKey("folders.id"), nullable=True)
    file_name = Column(String(255), nullable=False)
    file_size = Column(BigInteger, nullable=False)
    mime_type = Column(String(100))
    content_hash = Column(String(64))
    encryption_key = Column(Text)
    chunk_info = Column(JSON)
    file_metadata = Column(JSONB)
    storage_tier = Column(String(20), default="cache")
    backup_status = Column(String(20), default="pending")
    backup_location = Column(String(500))
    created_at = Column(DateTime, default=datetime.utcnow)
    last_accessed = Column(DateTime, default=datetime.utcnow)
    storage_type = Column(String(30), default="chunked")
    storage_key = Column(Text)
    object_path = Column(String(500))
    current_version = Column(Integer, default=1)
    version_count = Column(Integer, default=1)
    versioning_enabled = Column(Boolean, default=True)
    dedup_info = Column(JSON, nullable=True)

    # Performance indexes
    __table_args__ = (
        Index('idx_user_storage_type', 'user_id', 'storage_type'),
        Index('idx_content_hash', 'content_hash'),
        Index('idx_user_id', 'user_id'),
    )

class ActivityLog(Base):
    __tablename__ = "activity_logs"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    action = Column(String(50), nullable=False)
    object_id = Column(UUID(as_uuid=True), nullable=True)
    ip_address = Column(String(45))
    user_agent = Column(Text)
    meta_data = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow)

class FileVersion(Base):
    __tablename__ = "file_versions"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    file_id = Column(UUID(as_uuid=True), ForeignKey("objects.id", ondelete="CASCADE"))
    version_number = Column(Integer, nullable=False)
    file_size = Column(BigInteger, nullable=False)
    content_hash = Column(String(64))
    storage_path = Column(String(500))
    chunk_info = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    comment = Column(Text)  # Version comment/description
    is_deleted = Column(Boolean, default=False)  # Soft delete
    
    __table_args__ = (
        UniqueConstraint('file_id', 'version_number', name='unique_file_version'),
    )


class ContentBlock(Base):
    __tablename__ = 'content_blocks'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    block_hash = Column(String(64), nullable=False, index=True)
    file_id = Column(UUID(as_uuid=True), ForeignKey('objects.id',ondelete='CASCADE'), index=True)
    block_size = Column(Integer)
    block_offset = Column(Integer)
    reference_count = Column(Integer, default=1, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    # Indexes and constraints for performance
    __table_args__ = (
        UniqueConstraint('block_hash', 'file_id', 'block_offset'),
        Index('idx_block_file_id', 'file_id'),
        Index('idx_ref_count_zero', 'reference_count'),
    )

class ShareLink(Base):
    __tablename__ = 'share_links'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    share_token = Column(String(64), unique=True, nullable=False, index=True)
    file_id = Column(UUID(as_uuid=True), ForeignKey('objects.id', ondelete='CASCADE'), nullable=True)
    folder_id = Column(UUID(as_uuid=True), ForeignKey('folders.id', ondelete='CASCADE'), nullable=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id'), nullable=False)
    share_type = Column(String(20), default='view')  # view, download, edit
    password_hash = Column(String(255), nullable=True)
    expires_at = Column(DateTime, nullable=True)  # NULL = never expires
    max_downloads = Column(Integer, nullable=True)  # NULL = unlimited
    download_count = Column(Integer, default=0)
    view_count = Column(Integer, default=0)
    is_active = Column(Boolean, default=True)
    allow_preview = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_accessed = Column(DateTime, nullable=True)

    # Indexes for performance
    __table_args__ = (
        Index('idx_share_token', 'share_token'),
        Index('idx_share_file_id', 'file_id'),
        Index('idx_share_folder_id', 'folder_id'),
        Index('idx_share_user_id', 'user_id'),
        Index('idx_share_active', 'is_active'),
    )

class SharedAccess(Base):
    """Collaborative sharing - share folders/files with specific users"""
    __tablename__ = 'shared_access'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id = Column(UUID(as_uuid=True), ForeignKey('users.id'), nullable=False)
    shared_with_email = Column(String(255), nullable=False, index=True)
    shared_with_user_id = Column(UUID(as_uuid=True), ForeignKey('users.id'), nullable=True)  # NULL if not registered
    file_id = Column(UUID(as_uuid=True), ForeignKey('objects.id', ondelete='CASCADE'), nullable=True)
    folder_id = Column(UUID(as_uuid=True), ForeignKey('folders.id', ondelete='CASCADE'), nullable=True)
    permission = Column(String(20), default='view')  # view, download, edit
    invitation_status = Column(String(20), default='pending')  # pending, accepted, declined
    invitation_token = Column(String(64), unique=True, nullable=True, index=True)
    expires_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    accepted_at = Column(DateTime, nullable=True)

    # Indexes
    __table_args__ = (
        Index('idx_shared_email', 'shared_with_email'),
        Index('idx_shared_user', 'shared_with_user_id'),
        Index('idx_shared_owner', 'owner_id'),
        Index('idx_shared_file', 'file_id'),
        Index('idx_shared_folder', 'folder_id'),
    )
