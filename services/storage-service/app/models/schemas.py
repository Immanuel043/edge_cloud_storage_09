# services/storage-service/app/models/schemas.py

from pydantic import BaseModel, EmailStr
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
    folder_id: Optional[str]
    storage_tier: str
    backup_status: str
    created_at: datetime
    last_accessed: datetime

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