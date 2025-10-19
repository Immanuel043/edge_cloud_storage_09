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


class URLUploadJob(Base):
    """URL upload job tracking for server-side downloads"""
    __tablename__ = 'url_upload_jobs'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    folder_id = Column(UUID(as_uuid=True), ForeignKey('folders.id', ondelete='SET NULL'), nullable=True)
    file_id = Column(UUID(as_uuid=True), ForeignKey('objects.id', ondelete='SET NULL'), nullable=True)

    # URL and metadata
    source_url = Column(Text, nullable=False)
    filename = Column(String(255), nullable=True)
    mime_type = Column(String(100), nullable=True)

    # Status tracking
    status = Column(String(20), default='pending', nullable=False)  # pending, downloading, completed, failed
    progress = Column(Integer, default=0)  # 0-100
    total_size = Column(BigInteger, default=0)
    downloaded_size = Column(BigInteger, default=0)

    # Error handling
    error_message = Column(Text, nullable=True)
    retry_count = Column(Integer, default=0)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    started_at = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    user = relationship('User', backref='url_upload_jobs')
    folder = relationship('Folder', backref='url_upload_jobs')
    file = relationship('Object', backref='url_upload_jobs')

    __table_args__ = (
        Index('idx_url_upload_user_id', 'user_id'),
        Index('idx_url_upload_status', 'status'),
        Index('idx_url_upload_created_at', 'created_at'),
        Index('idx_url_upload_file_id', 'file_id'),
    )


# ============================================================================
# ML FEATURES - QUOTA PREDICTION
# ============================================================================

class StorageUsageHistory(Base):
    """Track daily storage usage per user for quota prediction"""
    __tablename__ = 'storage_usage_history'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    date = Column(DateTime(timezone=True), nullable=False)  # Date of measurement
    storage_used = Column(BigInteger, nullable=False)  # Bytes used on this date

    # Breakdown by storage tier
    cache_used = Column(BigInteger, default=0)
    warm_used = Column(BigInteger, default=0)
    cold_used = Column(BigInteger, default=0)

    # File count
    file_count = Column(Integer, default=0)

    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    # Relationships
    user = relationship('User', backref='usage_history')

    __table_args__ = (
        UniqueConstraint('user_id', 'date', name='unique_user_date'),
        Index('idx_usage_history_user_id', 'user_id'),
        Index('idx_usage_history_date', 'date'),
    )


class QuotaPrediction(Base):
    """Store quota predictions for users"""
    __tablename__ = 'quota_predictions'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)

    # Prediction date (when prediction was made)
    prediction_date = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    # Predictions for different time horizons (in bytes)
    predicted_7d = Column(BigInteger)   # Predicted usage in 7 days
    predicted_14d = Column(BigInteger)  # Predicted usage in 14 days
    predicted_30d = Column(BigInteger)  # Predicted usage in 30 days

    # Confidence scores (0.0 to 1.0)
    confidence_7d = Column(Float, default=0.0)
    confidence_14d = Column(Float, default=0.0)
    confidence_30d = Column(Float, default=0.0)

    # Days until quota is exceeded (null if won't exceed)
    days_until_full = Column(Integer)

    # Model used for prediction
    model_type = Column(String(50))  # 'prophet', 'linear_regression', 'moving_average'

    # Metadata
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    # Relationships
    user = relationship('User', backref='quota_predictions')

    __table_args__ = (
        Index('idx_quota_pred_user_id', 'user_id'),
        Index('idx_quota_pred_date', 'prediction_date'),
    )


class QuotaAlert(Base):
    """Track quota alerts sent to users"""
    __tablename__ = 'quota_alerts'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)

    # Alert type
    alert_type = Column(String(50), nullable=False)  # '70_percent', '85_percent', '95_percent', 'predicted_full'

    # Alert details
    current_usage_bytes = Column(BigInteger, nullable=False)
    quota_bytes = Column(BigInteger, nullable=False)
    threshold_percent = Column(Float)  # e.g., 0.70, 0.85, 0.95
    predicted_days_remaining = Column(Integer)  # Days until predicted full (for predicted_full alerts)

    # Status
    is_dismissed = Column(Boolean, default=False)
    is_sent = Column(Boolean, default=False)  # Whether notification was sent

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    dismissed_at = Column(DateTime(timezone=True), nullable=True)
    sent_at = Column(DateTime(timezone=True), nullable=True)

    # Relationships
    user = relationship('User', backref='quota_alerts')

    __table_args__ = (
        Index('idx_quota_alert_user_id', 'user_id'),
        Index('idx_quota_alert_type', 'alert_type'),
        Index('idx_quota_alert_dismissed', 'is_dismissed'),
        Index('idx_quota_alert_created', 'created_at'),
    )


# ============================================================================
# ML FEATURES - STORAGE OPTIMIZATION
# ============================================================================

class StorageAnalysis(Base):
    """Store storage usage analysis results"""
    __tablename__ = 'storage_analysis'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)

    # Overall metrics
    total_files = Column(Integer, nullable=False)
    total_size = Column(BigInteger, nullable=False)
    duplicate_files = Column(Integer, default=0)
    duplicate_size = Column(BigInteger, default=0)

    # Tier distribution
    cache_files = Column(Integer, default=0)
    cache_size = Column(BigInteger, default=0)
    warm_files = Column(Integer, default=0)
    warm_size = Column(BigInteger, default=0)
    cold_files = Column(Integer, default=0)
    cold_size = Column(BigInteger, default=0)

    # Access patterns
    avg_access_frequency = Column(Float, default=0.0)  # Average accesses per file
    files_never_accessed = Column(Integer, default=0)
    size_never_accessed = Column(BigInteger, default=0)
    files_accessed_once = Column(Integer, default=0)
    size_accessed_once = Column(BigInteger, default=0)

    # Age analysis
    files_older_30d = Column(Integer, default=0)
    size_older_30d = Column(BigInteger, default=0)
    files_older_90d = Column(Integer, default=0)
    size_older_90d = Column(BigInteger, default=0)
    files_older_180d = Column(Integer, default=0)
    size_older_180d = Column(BigInteger, default=0)

    # Compression opportunities
    compressible_files = Column(Integer, default=0)
    compressible_size = Column(BigInteger, default=0)
    estimated_savings_compression = Column(BigInteger, default=0)

    # Tier migration opportunities
    files_to_cold = Column(Integer, default=0)
    size_to_cold = Column(BigInteger, default=0)
    estimated_savings_tiering = Column(BigInteger, default=0)

    # Total potential savings
    total_potential_savings = Column(BigInteger, default=0)

    # Analysis metadata
    analysis_date = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    analysis_duration_ms = Column(Integer, default=0)

    # Relationships
    user = relationship('User', backref='storage_analyses')

    __table_args__ = (
        Index('idx_storage_analysis_user_id', 'user_id'),
        Index('idx_storage_analysis_date', 'analysis_date'),
    )


class OptimizationSuggestion(Base):
    """Store individual optimization suggestions"""
    __tablename__ = 'optimization_suggestions'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    analysis_id = Column(UUID(as_uuid=True), ForeignKey('storage_analysis.id', ondelete='CASCADE'), nullable=False)

    # Suggestion details
    suggestion_type = Column(String(50), nullable=False)  # 'tier_migration', 'deduplication', 'compression', 'cleanup'
    priority = Column(String(20), nullable=False)  # 'low', 'medium', 'high', 'critical'
    title = Column(String(255), nullable=False)
    description = Column(Text, nullable=False)

    # Impact estimates
    files_affected = Column(Integer, default=0)
    size_affected = Column(BigInteger, default=0)
    estimated_savings = Column(BigInteger, default=0)
    estimated_savings_percent = Column(Float, default=0.0)

    # Actions
    action_type = Column(String(50))  # 'move_to_cold', 'delete_duplicates', 'compress', 'delete_old'
    action_details = Column(JSON)  # Specific file IDs, parameters, etc.

    # Status
    status = Column(String(20), default='pending')  # 'pending', 'accepted', 'rejected', 'completed'
    is_dismissed = Column(Boolean, default=False)
    is_auto_applicable = Column(Boolean, default=False)  # Can be applied automatically

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    applied_at = Column(DateTime(timezone=True), nullable=True)
    dismissed_at = Column(DateTime(timezone=True), nullable=True)

    # Relationships
    user = relationship('User', backref='optimization_suggestions')
    analysis = relationship('StorageAnalysis', backref='suggestions')

    __table_args__ = (
        Index('idx_optimization_user_id', 'user_id'),
        Index('idx_optimization_type', 'suggestion_type'),
        Index('idx_optimization_priority', 'priority'),
        Index('idx_optimization_status', 'status'),
        Index('idx_optimization_created', 'created_at'),
    )


class OptimizationAction(Base):
    """Track optimization actions taken by users"""
    __tablename__ = 'optimization_actions'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    suggestion_id = Column(UUID(as_uuid=True), ForeignKey('optimization_suggestions.id', ondelete='SET NULL'), nullable=True)

    # Action details
    action_type = Column(String(50), nullable=False)
    files_processed = Column(Integer, default=0)
    size_processed = Column(BigInteger, default=0)
    actual_savings = Column(BigInteger, default=0)

    # Status
    status = Column(String(20), default='pending')  # 'pending', 'in_progress', 'completed', 'failed'
    error_message = Column(Text, nullable=True)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    started_at = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)

    # Relationships
    user = relationship('User', backref='optimization_actions')
    suggestion = relationship('OptimizationSuggestion', backref='actions')

    __table_args__ = (
        Index('idx_optimization_action_user_id', 'user_id'),
        Index('idx_optimization_action_status', 'status'),
        Index('idx_optimization_action_created', 'created_at'),
    )


# ============================================================================
# ML FEATURES - AUTO-ORGANIZATION
# ============================================================================

class OrganizationCluster(Base):
    """Store ML clustering results for file organization"""
    __tablename__ = 'organization_clusters'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)

    # Cluster details
    cluster_id = Column(Integer, nullable=False)  # Cluster number (0, 1, 2, ...)
    cluster_name = Column(String(255), nullable=False)  # Generated name (e.g., "Photos 2024", "Work Documents")
    cluster_description = Column(Text)  # Description of cluster contents

    # ML metadata
    algorithm = Column(String(50), nullable=False)  # 'kmeans', 'dbscan'
    num_files = Column(Integer, default=0)
    total_size = Column(BigInteger, default=0)

    # Representative features
    top_keywords = Column(JSON)  # Top TF-IDF keywords: ["report", "2024", "financial"]
    common_extensions = Column(JSON)  # [".pdf", ".docx"]
    date_range_start = Column(DateTime(timezone=True))
    date_range_end = Column(DateTime(timezone=True))

    # Quality metrics
    silhouette_score = Column(Float)  # Cluster quality (0-1, higher is better)
    cohesion_score = Column(Float)  # How similar files are within cluster

    # Suggested folder
    suggested_folder_path = Column(String(500))  # e.g., "/Work/Financial Reports 2024"

    # Status
    is_applied = Column(Boolean, default=False)
    is_dismissed = Column(Boolean, default=False)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    applied_at = Column(DateTime(timezone=True))
    dismissed_at = Column(DateTime(timezone=True))

    # Relationships
    user = relationship('User', backref='organization_clusters')

    __table_args__ = (
        Index('idx_org_cluster_user_id', 'user_id'),
        Index('idx_org_cluster_algorithm', 'algorithm'),
        Index('idx_org_cluster_applied', 'is_applied'),
        Index('idx_org_cluster_created', 'created_at'),
        UniqueConstraint('user_id', 'cluster_id', 'created_at', name='unique_user_cluster')
    )


class FileClusterAssignment(Base):
    """Track which files belong to which clusters"""
    __tablename__ = 'file_cluster_assignments'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    file_id = Column(UUID(as_uuid=True), ForeignKey('objects.id', ondelete='CASCADE'), nullable=False)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey('organization_clusters.id', ondelete='CASCADE'), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)

    # Assignment confidence
    confidence_score = Column(Float, default=1.0)  # How confident is the assignment (0-1)
    distance_to_centroid = Column(Float)  # Distance from cluster center

    # Feature vector (for debugging/analysis)
    feature_vector = Column(JSON)  # TF-IDF features used for clustering

    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    # Relationships
    file = relationship('Object', backref='cluster_assignments')
    cluster = relationship('OrganizationCluster', backref='file_assignments')
    user = relationship('User', backref='file_cluster_assignments')

    __table_args__ = (
        Index('idx_file_cluster_file_id', 'file_id'),
        Index('idx_file_cluster_cluster_id', 'cluster_id'),
        Index('idx_file_cluster_user_id', 'user_id'),
    )


class OrganizationRule(Base):
    """User-defined or ML-generated organization rules"""
    __tablename__ = 'organization_rules'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)

    # Rule definition
    rule_name = Column(String(255), nullable=False)
    rule_type = Column(String(50), nullable=False)  # 'pattern', 'extension', 'date', 'ml_cluster'

    # Pattern matching
    pattern = Column(String(500))  # e.g., "*_report_*.pdf", "IMG_*.jpg"
    file_extensions = Column(JSON)  # [".pdf", ".docx"]
    keywords = Column(JSON)  # ["invoice", "receipt"]

    # Date-based rules
    date_field = Column(String(50))  # 'created_at', 'modified_at'
    date_range_days = Column(Integer)  # Files from last N days

    # Target folder
    target_folder_path = Column(String(500), nullable=False)
    create_subfolder_by_date = Column(Boolean, default=False)  # Create YYYY/MM subfolders

    # Rule behavior
    is_active = Column(Boolean, default=True)
    auto_apply = Column(Boolean, default=False)  # Automatically apply to new files
    priority = Column(Integer, default=0)  # Higher priority rules run first

    # Statistics
    files_organized = Column(Integer, default=0)
    last_applied_at = Column(DateTime(timezone=True))

    # Source
    source = Column(String(50), default='user')  # 'user', 'ml', 'suggested'

    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    user = relationship('User', backref='organization_rules')

    __table_args__ = (
        Index('idx_org_rule_user_id', 'user_id'),
        Index('idx_org_rule_type', 'rule_type'),
        Index('idx_org_rule_active', 'is_active'),
        Index('idx_org_rule_priority', 'priority'),
    )


class OrganizationSession(Base):
    """Track organization sessions (batch operations)"""
    __tablename__ = 'organization_sessions'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)

    # Session details
    session_type = Column(String(50), nullable=False)  # 'ml_clustering', 'rule_based', 'manual'
    algorithm = Column(String(50))  # 'kmeans', 'dbscan' (for ML sessions)

    # Parameters
    num_clusters = Column(Integer)  # For k-means
    min_files = Column(Integer)  # Minimum files to organize

    # Results
    files_analyzed = Column(Integer, default=0)
    files_organized = Column(Integer, default=0)
    clusters_created = Column(Integer, default=0)
    folders_created = Column(Integer, default=0)

    # Quality metrics
    avg_silhouette_score = Column(Float)

    # Status
    status = Column(String(20), default='pending')  # 'pending', 'running', 'completed', 'failed'
    error_message = Column(Text)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    started_at = Column(DateTime(timezone=True))
    completed_at = Column(DateTime(timezone=True))

    # Relationships
    user = relationship('User', backref='organization_sessions')

    __table_args__ = (
        Index('idx_org_session_user_id', 'user_id'),
        Index('idx_org_session_status', 'status'),
        Index('idx_org_session_created', 'created_at'),
    )


# ============================================================================
# ML FEATURES - CONTENT RECOMMENDATIONS
# ============================================================================

class FileSimilarity(Base):
    """Store pre-computed file similarity scores"""
    __tablename__ = 'file_similarities'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    file_id = Column(UUID(as_uuid=True), ForeignKey('objects.id', ondelete='CASCADE'), nullable=False)
    similar_file_id = Column(UUID(as_uuid=True), ForeignKey('objects.id', ondelete='CASCADE'), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)

    # Similarity metrics
    similarity_score = Column(Float, nullable=False)  # 0-1, higher is more similar
    similarity_type = Column(String(50), nullable=False)  # 'content', 'collaborative', 'hybrid'

    # Feature details
    common_keywords = Column(JSON)  # Shared TF-IDF keywords
    name_similarity = Column(Float)  # Filename similarity
    type_match = Column(Boolean, default=False)  # Same file type

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    file = relationship('Object', foreign_keys=[file_id], backref='similarities')
    similar_file = relationship('Object', foreign_keys=[similar_file_id])
    user = relationship('User', backref='file_similarities')

    __table_args__ = (
        Index('idx_file_sim_file_id', 'file_id'),
        Index('idx_file_sim_user_id', 'user_id'),
        Index('idx_file_sim_score', 'similarity_score'),
        Index('idx_file_sim_type', 'similarity_type'),
        UniqueConstraint('file_id', 'similar_file_id', name='unique_file_pair')
    )


class UserInteraction(Base):
    """Track user interactions with files for collaborative filtering"""
    __tablename__ = 'user_interactions'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    file_id = Column(UUID(as_uuid=True), ForeignKey('objects.id', ondelete='CASCADE'), nullable=False)

    # Interaction types
    interaction_type = Column(String(50), nullable=False)  # 'view', 'download', 'share', 'favorite', 'tag'
    interaction_count = Column(Integer, default=1)

    # Interaction strength (weighted score)
    interaction_weight = Column(Float, default=1.0)  # view=1.0, download=2.0, share=3.0, favorite=5.0

    # Context
    last_interaction_at = Column(DateTime(timezone=True), nullable=False)
    total_time_spent = Column(Integer, default=0)  # Seconds

    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    user = relationship('User', backref='interactions')
    file = relationship('Object', backref='interactions')

    __table_args__ = (
        Index('idx_interaction_user_id', 'user_id'),
        Index('idx_interaction_file_id', 'file_id'),
        Index('idx_interaction_type', 'interaction_type'),
        Index('idx_interaction_weight', 'interaction_weight'),
        Index('idx_interaction_last', 'last_interaction_at'),
        UniqueConstraint('user_id', 'file_id', 'interaction_type', name='unique_user_file_interaction')
    )


class Recommendation(Base):
    """Store generated recommendations for users"""
    __tablename__ = 'recommendations'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    file_id = Column(UUID(as_uuid=True), ForeignKey('objects.id', ondelete='CASCADE'), nullable=False)

    # Recommendation details
    recommendation_type = Column(String(50), nullable=False)  # 'similar', 'collaborative', 'trending', 'personalized'
    recommendation_score = Column(Float, nullable=False)  # 0-1, higher is better
    rank = Column(Integer, default=0)  # Position in recommendation list

    # Source
    source_file_id = Column(UUID(as_uuid=True), ForeignKey('objects.id', ondelete='SET NULL'), nullable=True)  # For similar files
    algorithm = Column(String(50))  # 'tfidf', 'collaborative_user', 'collaborative_item', 'hybrid'

    # Explanation
    reason = Column(Text)  # Human-readable explanation

    # Status
    is_viewed = Column(Boolean, default=False)
    is_accepted = Column(Boolean, default=False)  # User clicked/opened
    is_dismissed = Column(Boolean, default=False)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    expires_at = Column(DateTime(timezone=True))  # Recommendations expire after N days
    viewed_at = Column(DateTime(timezone=True))
    accepted_at = Column(DateTime(timezone=True))

    # Relationships
    user = relationship('User', backref='recommendations')
    file = relationship('Object', foreign_keys=[file_id], backref='recommendations')
    source_file = relationship('Object', foreign_keys=[source_file_id])

    __table_args__ = (
        Index('idx_recommendation_user_id', 'user_id'),
        Index('idx_recommendation_file_id', 'file_id'),
        Index('idx_recommendation_type', 'recommendation_type'),
        Index('idx_recommendation_score', 'recommendation_score'),
        Index('idx_recommendation_created', 'created_at'),
        Index('idx_recommendation_expires', 'expires_at'),
    )


class RecommendationFeedback(Base):
    """Track user feedback on recommendations for ML improvement"""
    __tablename__ = 'recommendation_feedback'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    recommendation_id = Column(UUID(as_uuid=True), ForeignKey('recommendations.id', ondelete='CASCADE'), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)

    # Feedback
    feedback_type = Column(String(50), nullable=False)  # 'positive', 'negative', 'irrelevant'
    feedback_score = Column(Integer)  # 1-5 rating

    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    # Relationships
    recommendation = relationship('Recommendation', backref='feedback')
    user = relationship('User', backref='recommendation_feedback')

    __table_args__ = (
        Index('idx_rec_feedback_rec_id', 'recommendation_id'),
        Index('idx_rec_feedback_user_id', 'user_id'),
        Index('idx_rec_feedback_type', 'feedback_type'),
    )
