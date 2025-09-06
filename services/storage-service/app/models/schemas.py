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
    file_id: str
    expires_hours: int = 24
    password: Optional[str] = None
    max_downloads: Optional[int] = None

class ShareResponse(BaseModel):
    share_url: str
    token: str
    expires_at: str
    expires_hours: int
    password: bool
    max_downloads: Optional[int]

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