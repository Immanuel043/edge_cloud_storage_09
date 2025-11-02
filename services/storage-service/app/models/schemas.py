# services/storage-service/app/models/schemas.py

from pydantic import BaseModel, EmailStr, field_validator
from typing import Optional, List, Dict, Any
from datetime import datetime
from uuid import UUID

# User Schemas
class UserCreate(BaseModel):
    email: EmailStr
    username: str
    password: str
    user_type: str = "individual"

class UserLogin(BaseModel):
    email: EmailStr
    password: str

class UserResponse(BaseModel):
    id: str
    email: str
    username: str
    user_type: str
    storage_quota: int
    storage_used: int
    theme: str
    created_at: Optional[datetime] = None

class ThemeUpdate(BaseModel):
    theme: str

# File Schemas
class FileUploadInit(BaseModel):
    file_name: str
    file_size: int
    folder_id: Optional[str] = None

class FileResponse(BaseModel):
    id: str
    name: str
    size: int
    mime_type: Optional[str]
    folder_id: Optional[str] = None
    storage_tier: str = 'hot'
    backup_status: str = 'none'
    created_at: datetime
    last_accessed: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    tier: Optional[str] = None  # Alias for storage_tier
    path: Optional[str] = None
    is_favorite: Optional[bool] = False
    favorited_at: Optional[datetime] = None

    # Zero-Knowledge Encryption fields
    is_encrypted: Optional[bool] = False  # True if client-side encrypted
    encrypted_file_key: Optional[str] = None  # Base64-encoded encrypted file key
    file_key_iv: Optional[str] = None  # Base64-encoded IV for file key encryption
    encryption_algorithm: Optional[str] = None  # "AES-256-GCM" for ZK files

# Folder Schemas
class FolderCreate(BaseModel):
    name: str
    parent_id: Optional[str] = None

class FolderResponse(BaseModel):
    id: str
    name: str
    path: str
    parent_id: Optional[str]
    created_at: datetime

# Share Schemas
class ShareCreate(BaseModel):
    share_type: str = 'view'  # view, download, edit
    expires_hours: Optional[int] = None  # None = never expires
    password: Optional[str] = None
    max_downloads: Optional[int] = None  # None = unlimited
    allow_preview: bool = True

class ShareResponse(BaseModel):
    share_url: str
    token: str
    share_type: str
    expires_at: Optional[str] = None
    password_protected: bool
    max_downloads: Optional[int] = None
    downloads_used: int = 0
    allow_preview: bool = True

class CollaborativeShareCreate(BaseModel):
    emails: List[str]  # List of emails to share with
    permission: str = 'view'  # view, download, edit
    expires_hours: Optional[int] = None
    message: Optional[str] = None  # Optional message to recipients

class CollaborativeShareResponse(BaseModel):
    id: str
    shared_with_email: str
    permission: str
    invitation_status: str
    invitation_token: Optional[str] = None
    created_at: datetime

class SharedItemResponse(BaseModel):
    id: str
    owner_email: str
    item_name: str
    item_type: str  # file or folder
    permission: str
    shared_at: datetime
    file_id: Optional[str] = None
    folder_id: Optional[str] = None

# Storage Schemas
class StorageStats(BaseModel):
    quota: int
    used: int
    available: int
    percentage_used: float
    distribution: Dict[str, Dict[str, Any]]

# Activity Schemas
class ActivityResponse(BaseModel):
    id: str
    action: str
    object_id: Optional[str]
    ip_address: Optional[str]
    metadata: Optional[Dict[str, Any]]
    created_at: datetime

# Upload Schemas
class UploadInitResponse(BaseModel):
    upload_id: str
    storage_strategy: str
    chunk_size: int
    total_chunks: int
    direct_upload: bool

class UploadStatusResponse(BaseModel):
    upload_id: str
    file_name: str
    total_chunks: int
    uploaded_chunks: List[int]
    missing_chunks: List[int]
    progress: float

# Zero-Knowledge Upload Schemas
class ZKUploadInitRequest(BaseModel):
    """Request schema for ZK upload initialization"""
    file_name: str
    file_size: int
    mime_type: Optional[str] = None
    folder_id: Optional[str] = None

    # ZK-specific fields
    encrypted_file_key: str  # Base64-encoded encrypted file key
    file_key_iv: str  # Base64-encoded initialization vector
    encryption_algorithm: str = "AES-256-GCM"

    @field_validator('encrypted_file_key', 'file_key_iv')
    @classmethod
    def validate_base64(cls, v):
        """Validate base64 encoding"""
        if not v:
            raise ValueError('Field cannot be empty')
        try:
            import base64
            base64.b64decode(v)
            return v
        except Exception:
            raise ValueError('Invalid base64 encoding')

    @field_validator('file_size')
    @classmethod
    def validate_file_size(cls, v):
        """Validate file size (max 10GB)"""
        MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024  # 10GB
        if v <= 0:
            raise ValueError('File size must be greater than 0')
        if v > MAX_FILE_SIZE:
            raise ValueError(f'File size exceeds maximum allowed size of {MAX_FILE_SIZE} bytes')
        return v

    @field_validator('file_name')
    @classmethod
    def validate_filename(cls, v):
        """Validate filename"""
        if not v or not v.strip():
            raise ValueError('Filename cannot be empty')
        if len(v) > 255:
            raise ValueError('Filename too long (max 255 characters)')
        # Check for path traversal attempts
        if '..' in v or '/' in v or '\\' in v:
            raise ValueError('Invalid filename - path traversal not allowed')
        return v.strip()

class ZKUploadInitResponse(BaseModel):
    """Response schema for ZK upload initialization"""
    upload_id: str
    storage_strategy: str
    chunk_size: int
    total_chunks: int
    direct_upload: bool
    zk_mode: bool = True
    message: str = "ZK upload initialized - chunks will not be re-encrypted on server"

# Token Schemas
class Token(BaseModel):
    access_token: str
    token_type: str
    user: UserResponse
#Storage Stats extended with type distribution
class StorageStats(BaseModel):
    quota: int
    used: int
    available: int
    percentage_used: float
    total_files: int
    distribution: Dict[str, Dict[str, Any]]  # by tier
    type_distribution: Dict[str, Dict[str, Any]]  # by storage type

# URL Upload Schemas
class URLUploadRequest(BaseModel):
    url: str
    folder_id: Optional[str] = None
    filename: Optional[str] = None  # Override auto-detected filename

class URLUploadResponse(BaseModel):
    job_id: str
    status: str
    url: str
    message: str

class URLUploadStatusResponse(BaseModel):
    job_id: str
    status: str  # pending, downloading, completed, failed
    progress: int  # 0-100
    total_size: int
    downloaded_size: int
    file_id: Optional[str] = None
    filename: Optional[str] = None
    error: Optional[str] = None
    created_at: datetime
    updated_at: Optional[datetime] = None

# Folder Upload Schemas
class FolderUploadInit(BaseModel):
    folder_name: str
    parent_id: Optional[str] = None
    total_files: int
    total_size: int

class FolderUploadInitResponse(BaseModel):
    session_id: str
    root_folder_id: str
    folder_name: str
    message: str

class FolderFileItem(BaseModel):
    relative_path: str  # Path relative to root folder (e.g., "docs/file.txt")
    file_size: int
    mime_type: Optional[str] = None

class FolderUploadFileRequest(BaseModel):
    session_id: str
    relative_path: str

class FolderUploadCompleteRequest(BaseModel):
    session_id: str

class FolderUploadStatusResponse(BaseModel):
    session_id: str
    status: str  # in_progress, completed, failed
    root_folder_id: str
    total_files: int
    uploaded_files: int
    failed_files: int
    progress: float  # 0-100
    errors: List[str] = []

# ML Features - Quota Prediction Schemas
class QuotaPredictionResponse(BaseModel):
    user_id: str
    current_usage_bytes: int
    quota_bytes: int
    usage_percent: float
    predicted_7d: Optional[int] = None
    predicted_14d: Optional[int] = None
    predicted_30d: Optional[int] = None
    confidence_7d: Optional[float] = None
    confidence_14d: Optional[float] = None
    confidence_30d: Optional[float] = None
    days_until_full: Optional[int] = None
    will_exceed_quota: bool
    model_type: Optional[str] = None
    prediction_date: datetime

class UsageHistoryPoint(BaseModel):
    date: datetime
    storage_used: int
    file_count: int
    cache_used: int
    warm_used: int
    cold_used: int

class UsageHistoryResponse(BaseModel):
    user_id: str
    start_date: datetime
    end_date: datetime
    data_points: List[UsageHistoryPoint]
    total_points: int

class QuotaAlertResponse(BaseModel):
    id: str
    alert_type: str
    current_usage_bytes: int
    quota_bytes: int
    usage_percent: float
    threshold_percent: Optional[float] = None
    predicted_days_remaining: Optional[int] = None
    is_dismissed: bool
    created_at: datetime
    message: str  # Human-readable alert message

class DismissAlertRequest(BaseModel):
    alert_id: str


# ============================================================================
# Storage Optimization Schemas
# ============================================================================

class StorageAnalysisResponse(BaseModel):
    """Response schema for storage analysis"""
    id: str
    user_id: str

    # Overall metrics
    total_files: int
    total_size: int
    duplicate_files: int
    duplicate_size: int

    # Tier distribution
    tier_distribution: Dict[str, Dict[str, int]]  # {tier: {files: int, size: int}}

    # Access patterns
    avg_access_frequency: float
    never_accessed: Dict[str, int]  # {files: int, size: int}
    accessed_once: Dict[str, int]

    # Age analysis
    age_breakdown: Dict[str, Dict[str, int]]  # {period: {files: int, size: int}}

    # Savings opportunities
    compression_savings: Dict[str, int]  # {files: int, size: int, estimated_savings: int}
    tiering_savings: Dict[str, int]
    total_potential_savings: int
    total_potential_savings_percent: float

    # Metadata
    analysis_date: datetime
    analysis_duration_ms: int


class OptimizationSuggestionResponse(BaseModel):
    """Response schema for optimization suggestion"""
    id: str
    user_id: str
    analysis_id: str

    # Suggestion details
    suggestion_type: str  # tier_migration, deduplication, compression, cleanup
    priority: str  # low, medium, high, critical
    title: str
    description: str

    # Impact
    files_affected: int
    size_affected: int
    estimated_savings: int
    estimated_savings_percent: float

    # Action
    action_type: str
    is_auto_applicable: bool

    # Status
    status: str
    is_dismissed: bool
    created_at: datetime
    applied_at: Optional[datetime] = None


class OptimizationActionRequest(BaseModel):
    """Request to apply an optimization suggestion"""
    suggestion_id: str
    auto_apply: bool = False  # Whether to apply automatically


class OptimizationActionResponse(BaseModel):
    """Response after applying optimization"""
    id: str
    action_type: str
    status: str
    files_processed: int
    size_processed: int
    actual_savings: int
    created_at: datetime
    completed_at: Optional[datetime] = None


class StorageBreakdown(BaseModel):
    """Storage breakdown by category"""
    category: str
    files: int
    size: int
    percent: float


class OptimizationSummary(BaseModel):
    """Summary of all optimization opportunities"""
    user_id: str
    total_size: int
    total_files: int

    # Breakdown
    breakdown_by_tier: List[StorageBreakdown]
    breakdown_by_age: List[StorageBreakdown]
    breakdown_by_access: List[StorageBreakdown]

    # Opportunities
    total_potential_savings: int
    total_potential_savings_percent: float
    suggestion_count: int
    high_priority_count: int

    # Latest analysis
    last_analysis_date: Optional[datetime] = None


# ============================================================================
# Auto-Organization Schemas
# ============================================================================

class OrganizationClusterResponse(BaseModel):
    """Response schema for organization cluster"""
    id: str
    user_id: str
    cluster_id: int
    cluster_name: str
    cluster_description: Optional[str] = None

    # Metadata
    algorithm: str  # kmeans, dbscan
    num_files: int
    total_size: int

    # Features
    top_keywords: List[str]
    common_extensions: List[str]
    date_range_start: Optional[datetime] = None
    date_range_end: Optional[datetime] = None

    # Quality
    silhouette_score: Optional[float] = None
    cohesion_score: Optional[float] = None

    # Suggestion
    suggested_folder_path: str

    # Status
    is_applied: bool
    is_dismissed: bool
    created_at: datetime


class FileClusterAssignmentResponse(BaseModel):
    """Response schema for file cluster assignment"""
    file_id: str
    cluster_id: str
    confidence_score: float
    distance_to_centroid: Optional[float] = None


class OrganizationRuleResponse(BaseModel):
    """Response schema for organization rule"""
    id: str
    user_id: str
    rule_name: str
    rule_type: str  # pattern, extension, date, ml_cluster

    # Pattern
    pattern: Optional[str] = None
    file_extensions: Optional[List[str]] = None
    keywords: Optional[List[str]] = None

    # Date-based
    date_field: Optional[str] = None
    date_range_days: Optional[int] = None

    # Target
    target_folder_path: str
    create_subfolder_by_date: bool

    # Behavior
    is_active: bool
    auto_apply: bool
    priority: int

    # Stats
    files_organized: int
    last_applied_at: Optional[datetime] = None

    # Source
    source: str  # user, ml, suggested
    created_at: datetime


class OrganizationSessionResponse(BaseModel):
    """Response schema for organization session"""
    id: str
    user_id: str
    session_type: str  # ml_clustering, rule_based, manual
    algorithm: Optional[str] = None

    # Parameters
    num_clusters: Optional[int] = None
    min_files: Optional[int] = None

    # Results
    files_analyzed: int
    files_organized: int
    clusters_created: int
    folders_created: int

    # Quality
    avg_silhouette_score: Optional[float] = None

    # Status
    status: str  # pending, running, completed, failed
    error_message: Optional[str] = None

    created_at: datetime
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None


class StartOrganizationRequest(BaseModel):
    """Request to start auto-organization"""
    algorithm: str = "kmeans"  # kmeans or dbscan
    num_clusters: Optional[int] = None  # For k-means (auto-detect if None)
    min_files: int = 10  # Minimum files to organize
    preview_only: bool = False  # If True, don't actually move files


class ApplyClusterRequest(BaseModel):
    """Request to apply a cluster organization"""
    cluster_id: str
    target_folder_path: Optional[str] = None  # Override suggested path


class CreateRuleRequest(BaseModel):
    """Request to create organization rule"""
    rule_name: str
    rule_type: str  # pattern, extension, date, ml_cluster

    # Pattern matching
    pattern: Optional[str] = None
    file_extensions: Optional[List[str]] = None
    keywords: Optional[List[str]] = None

    # Date-based
    date_field: Optional[str] = None
    date_range_days: Optional[int] = None

    # Target
    target_folder_path: str
    create_subfolder_by_date: bool = False

    # Behavior
    auto_apply: bool = False
    priority: int = 0


class UpdateRuleRequest(BaseModel):
    """Request to update organization rule"""
    is_active: Optional[bool] = None
    auto_apply: Optional[bool] = None
    priority: Optional[int] = None
    target_folder_path: Optional[str] = None


class OrganizationPreview(BaseModel):
    """Preview of organization results"""
    clusters: List[OrganizationClusterResponse]
    total_files: int
    total_clusters: int
    avg_cluster_size: float
    quality_score: float  # Overall quality (0-1)


# ============================================================================
# Content Recommendations Schemas
# ============================================================================

class FileDetailResponse(BaseModel):
    """File details for recommendation response"""
    id: str
    name: str
    size: int
    mime_type: Optional[str] = None
    storage_tier: str
    folder_path: Optional[str] = None
    created_at: datetime
    last_accessed: Optional[datetime] = None
    access_count: int = 0


class SimilarFileResponse(BaseModel):
    """Response schema for similar file recommendation"""
    file: FileDetailResponse
    similarity_score: float  # 0-1
    similarity_type: str  # content, collaborative, hybrid
    reason: str  # Human-readable explanation
    common_keywords: List[str]


class RecommendationResponse(BaseModel):
    """Response schema for file recommendation"""
    id: str
    user_id: str
    recommended_file: FileDetailResponse
    recommendation_type: str  # similar, collaborative, trending, personalized
    recommendation_score: float  # 0-1
    algorithm: str  # tfidf, collaborative_user, collaborative_item, hybrid
    reason: str  # Why this file is recommended
    context_file_id: Optional[str] = None  # File that triggered this recommendation
    is_accepted: Optional[bool] = None
    is_dismissed: bool
    created_at: datetime


class UserInteractionRequest(BaseModel):
    """Request to track user interaction"""
    file_id: str
    interaction_type: str  # view, download, share, favorite, tag
    total_time_spent: Optional[int] = None  # Seconds spent viewing
    metadata: Optional[Dict[str, Any]] = None  # Additional context


class UserInteractionResponse(BaseModel):
    """Response after tracking interaction"""
    id: str
    file_id: str
    interaction_type: str
    interaction_weight: float
    created_at: datetime


class RecommendationFeedbackRequest(BaseModel):
    """Request to submit feedback on recommendation"""
    recommendation_id: str
    feedback_type: str  # positive, negative, irrelevant
    feedback_score: Optional[int] = None  # 1-5 rating
    feedback_text: Optional[str] = None  # Optional comment


class RecommendationFeedbackResponse(BaseModel):
    """Response after submitting feedback"""
    id: str
    recommendation_id: str
    feedback_type: str
    feedback_score: Optional[int] = None
    created_at: datetime


class RecommendationSettingsRequest(BaseModel):
    """Request to configure recommendation preferences"""
    enabled: bool = True
    algorithm_preference: Optional[str] = None  # tfidf, collaborative, hybrid
    min_score_threshold: float = 0.3  # Minimum score to show (0-1)
    max_recommendations: int = 10
    include_trending: bool = True
    include_collaborative: bool = True
    include_content_based: bool = True


class RecommendationSettingsResponse(BaseModel):
    """Response for recommendation settings"""
    user_id: str
    enabled: bool
    algorithm_preference: Optional[str] = None
    min_score_threshold: float
    max_recommendations: int
    include_trending: bool
    include_collaborative: bool
    include_content_based: bool
    updated_at: datetime


class TrendingFileResponse(BaseModel):
    """Response for trending files"""
    file: FileDetailResponse
    trending_score: float  # Based on recent interactions
    interaction_count: int  # Total interactions in time window
    unique_users: int  # Number of unique users interacting
    time_period: str  # e.g., "7 days", "30 days"


class PersonalizedRecommendationSummary(BaseModel):
    """Summary of all recommendations for a user"""
    user_id: str
    total_recommendations: int
    by_type: Dict[str, int]  # Count by recommendation_type
    by_algorithm: Dict[str, int]  # Count by algorithm
    avg_score: float
    accepted_count: int
    dismissed_count: int
    last_updated: datetime


class FileSimilarityResponse(BaseModel):
    """Response for pre-computed file similarity"""
    file_id: str
    similar_file_id: str
    similarity_score: float
    similarity_type: str
    common_keywords: List[str]
    computed_at: datetime


class BatchRecommendationRequest(BaseModel):
    """Request for batch recommendation generation"""
    file_ids: Optional[List[str]] = None  # Generate for specific files
    regenerate: bool = False  # Force regeneration of existing recommendations
    algorithm: str = "hybrid"  # tfidf, collaborative, hybrid
    min_score: float = 0.3


class BatchRecommendationResponse(BaseModel):
    """Response for batch recommendation generation"""
    job_id: str
    status: str  # pending, processing, completed, failed
    total_files: int
    processed_files: int
    recommendations_generated: int
    started_at: datetime
    completed_at: Optional[datetime] = None
    error: Optional[str] = None