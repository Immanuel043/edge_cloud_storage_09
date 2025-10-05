# services/storage-service/app/models/database.py

from sqlalchemy import (
    Column, String, Integer, DateTime, Boolean,
    ForeignKey, JSON, BigInteger, Text, UniqueConstraint, Index, Float
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship
from datetime import datetime
import uuid
from uuid import uuid4
from sqlalchemy.sql import func

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


class FileOCR(Base):
    """OCR extracted text from files"""
    __tablename__ = 'file_ocr'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    file_id = Column(UUID(as_uuid=True), ForeignKey('objects.id', ondelete='CASCADE'), nullable=False, unique=True)
    extracted_text = Column(Text, nullable=False)
    word_count = Column(Integer, default=0)
    confidence = Column(Integer, default=0)  # 0-100
    ocr_engine = Column(String(50), default='tesseract')
    languages = Column(JSON)  # List of detected/used languages
    page_count = Column(Integer, default=1)
    extraction_method = Column(String(50))  # 'ocr', 'direct', 'pymupdf', etc.
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        Index('idx_file_ocr_file_id', 'file_id'),
    )


class FileMetadata(Base):
    """Extended metadata for files"""
    __tablename__ = 'file_metadata_extended'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    file_id = Column(UUID(as_uuid=True), ForeignKey('objects.id', ondelete='CASCADE'), nullable=False, unique=True)
    metadata_type = Column(String(50))  # image, pdf, audio, video, document
    raw_metadata = Column(JSONB)  # Full metadata JSON

    # Common fields extracted for quick access
    width = Column(Integer)
    height = Column(Integer)
    duration = Column(Integer)  # For audio/video
    page_count = Column(Integer)  # For PDFs/documents

    # Image specific
    camera_make = Column(String(100))
    camera_model = Column(String(100))
    date_taken = Column(DateTime)
    gps_latitude = Column(String(50))
    gps_longitude = Column(String(50))

    # Audio/Video specific
    artist = Column(String(255))
    album = Column(String(255))
    title = Column(String(255))
    genre = Column(String(100))
    bitrate = Column(Integer)

    # Document specific
    author = Column(String(255))
    word_count = Column(Integer)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        Index('idx_file_metadata_file_id', 'file_id'),
        Index('idx_file_metadata_type', 'metadata_type'),
        Index('idx_file_metadata_artist', 'artist'),
        Index('idx_file_metadata_author', 'author'),
    )


class FileHash(Base):
    """Perceptual hashes for similarity detection"""
    __tablename__ = 'file_hashes'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    file_id = Column(UUID(as_uuid=True), ForeignKey('objects.id', ondelete='CASCADE'), nullable=False, unique=True)

    # Different hash types for images
    phash = Column(String(64))  # Perceptual hash
    dhash = Column(String(64))  # Difference hash
    whash = Column(String(64))  # Wavelet hash
    average_hash = Column(String(64))  # Average hash
    colorhash = Column(String(64))  # Color hash

    # Text document hashes
    text_hash = Column(String(64))  # Hash of extracted text

    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index('idx_file_hash_file_id', 'file_id'),
        Index('idx_file_hash_phash', 'phash'),
        Index('idx_file_hash_dhash', 'dhash'),
    )


class FileTag(Base):
    """AI-generated and user-defined tags for files"""
    __tablename__ = 'file_tags'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    file_id = Column(UUID(as_uuid=True), ForeignKey('objects.id', ondelete='CASCADE'), nullable=False)
    tag = Column(String(100), nullable=False)
    confidence = Column(Integer, default=100)  # 0-100, 100 for manual tags
    source = Column(String(50), default='manual')  # manual, ai_vision, ai_nlp, keywords, exif, etc.
    created_by = Column(UUID(as_uuid=True), ForeignKey('users.id'), nullable=True)  # NULL for auto-generated
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index('idx_file_tag_file_id', 'file_id'),
        Index('idx_file_tag_tag', 'tag'),
        Index('idx_file_tag_source', 'source'),
        UniqueConstraint('file_id', 'tag', name='unique_file_tag'),
    )


# ============================================================================
# SECURITY & AUDIT MODELS
# ============================================================================

class VirusScanLog(Base):
    """Virus scan results for uploaded files"""
    __tablename__ = 'virus_scan_logs'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    file_id = Column(UUID(as_uuid=True), ForeignKey('objects.id', ondelete='CASCADE'), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)

    # Scan results
    is_infected = Column(Boolean, nullable=False, default=False)
    virus_name = Column(String(255), nullable=True)  # Name of detected virus/malware
    scan_engine = Column(String(50), default='clamav')  # e.g., 'clamav', 'virustotal'
    scan_time = Column(Float, default=0.0)  # Scan duration in seconds

    # Metadata
    scanned_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    file_size = Column(BigInteger, nullable=True)  # Size of scanned file
    file_hash = Column(String(64), nullable=True)  # SHA-256 hash
    error_message = Column(Text, nullable=True)  # Error if scan failed

    # Action taken
    action_taken = Column(String(50), default='allowed')  # 'allowed', 'blocked', 'quarantined'

    # Relationships
    file = relationship('Object', backref='virus_scans')
    user = relationship('User', backref='virus_scans')

    __table_args__ = (
        Index('idx_virus_scan_file_id', 'file_id'),
        Index('idx_virus_scan_user_id', 'user_id'),
        Index('idx_virus_scan_is_infected', 'is_infected'),
        Index('idx_virus_scan_scanned_at', 'scanned_at'),
    )


class DLPScanLog(Base):
    """Data Loss Prevention scan results"""
    __tablename__ = 'dlp_scan_logs'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    file_id = Column(UUID(as_uuid=True), ForeignKey('objects.id', ondelete='CASCADE'), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)

    # Scan results
    has_sensitive_data = Column(Boolean, nullable=False, default=False)
    risk_score = Column(Float, default=0.0)  # 0-100 risk score
    total_matches = Column(Integer, default=0)  # Total sensitive data matches
    scan_time = Column(Float, default=0.0)

    # Detected sensitive data types (JSON array)
    detected_types = Column(Text, nullable=True)  # JSON: ['SSN', 'CREDIT_CARD', 'API_KEY']

    # Metadata
    scanned_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    file_size = Column(BigInteger, nullable=True)

    # Action taken
    action_taken = Column(String(50), default='allowed')  # 'allowed', 'blocked', 'flagged'
    blocked = Column(Boolean, default=False)

    # Relationships
    file = relationship('Object', backref='dlp_scans')
    user = relationship('User', backref='dlp_scans')

    __table_args__ = (
        Index('idx_dlp_scan_file_id', 'file_id'),
        Index('idx_dlp_scan_user_id', 'user_id'),
        Index('idx_dlp_scan_has_sensitive', 'has_sensitive_data'),
        Index('idx_dlp_scan_risk_score', 'risk_score'),
        Index('idx_dlp_scan_scanned_at', 'scanned_at'),
    )


class AuditLog(Base):
    """Comprehensive audit logging for all user actions"""
    __tablename__ = 'audit_logs'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id', ondelete='SET NULL'), nullable=True)

    # Action details
    action = Column(String(100), nullable=False)  # e.g., 'file.upload', 'file.delete', 'user.login'
    resource_type = Column(String(50), nullable=True)  # 'file', 'folder', 'user', 'share'
    resource_id = Column(UUID(as_uuid=True), nullable=True)  # ID of affected resource
    resource_name = Column(String(500), nullable=True)  # Name for easy reference

    # Request context
    ip_address = Column(String(45), nullable=True)  # IPv4 or IPv6
    user_agent = Column(Text, nullable=True)
    request_method = Column(String(10), nullable=True)  # GET, POST, PUT, DELETE
    request_path = Column(String(500), nullable=True)

    # Result
    status = Column(String(20), nullable=False)  # 'success', 'failure', 'blocked'
    status_code = Column(Integer, nullable=True)  # HTTP status code
    error_message = Column(Text, nullable=True)

    # Additional context data (JSON)
    context_data = Column(Text, nullable=True)  # JSON: extra context like file size, permissions, etc.

    # Timestamp
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    # Security flags
    is_suspicious = Column(Boolean, default=False)  # Flag suspicious activity
    risk_level = Column(String(20), default='low')  # 'low', 'medium', 'high', 'critical'

    # Relationships
    user = relationship('User', backref='audit_logs')

    __table_args__ = (
        Index('idx_audit_user_id', 'user_id'),
        Index('idx_audit_action', 'action'),
        Index('idx_audit_resource_type', 'resource_type'),
        Index('idx_audit_resource_id', 'resource_id'),
        Index('idx_audit_created_at', 'created_at'),
        Index('idx_audit_status', 'status'),
        Index('idx_audit_is_suspicious', 'is_suspicious'),
        Index('idx_audit_ip_address', 'ip_address'),
    )
