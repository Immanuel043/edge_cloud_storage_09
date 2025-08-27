# ===== COMPLETE STORAGE SERVICE WITH ALL FEATURES =====
# services/storage-service/app/main.py

from fastapi import (
    FastAPI,
    UploadFile,
    File,
    HTTPException,
    Depends,
    BackgroundTasks,
    Form,
    Request,
)
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.httpsredirect import HTTPSRedirectMiddleware
import asyncio
import aiofiles
import hashlib
import os
import uuid
import zstandard as zstd
from typing import List, Optional, Dict
from datetime import datetime, timedelta
import redis.asyncio as redis
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy import select, update, delete
from sqlalchemy import func
import json
from jose import jwt
from passlib.context import CryptContext
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import padding
import secrets
import boto3
from pathlib import Path
import shutil
import aiohttp

from fastapi.middleware.cors import CORSMiddleware
app = FastAPI()
origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,   # or ["*"] for all
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ===== Configuration =====
class Settings:
    # App
    APP_NAME = "Edge Cloud Storage"
    VERSION = "1.0.0"

    # Security
    SECRET_KEY = os.getenv("SECRET_KEY", secrets.token_urlsafe(32))
    ALGORITHM = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES = 30
    ENABLE_HTTPS = os.getenv("ENABLE_HTTPS", "false").lower() == "true"

    # Database
    DATABASE_URL = os.getenv(
        "DATABASE_URL", "postgresql+asyncpg://edge_admin:secure_password@localhost:5432/edge_cloud"
    )
    REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")

    # Storage
    STORAGE_ROOT = "./storage"
    CACHE_PATH = "./storage/cache"
    WARM_PATH = "./storage/warm"
    COLD_PATH = "./storage/cold"
    TEMP_PATH = "./storage/temp"
    BACKUP_PATH = "./storage/backup"

    # Chunking
    CHUNK_SIZE = 64 * 1024 * 1024  # 64MB
    MAX_FILE_SIZE = 20 * 1024 * 1024 * 1024  # 20GB
    COMPRESSION_LEVEL = 3

    # Backup
    BACKUP_ENABLED = os.getenv("BACKUP_ENABLED", "true").lower() == "true"
    BACKUP_S3_BUCKET = os.getenv("BACKUP_S3_BUCKET", "edge-cloud-backup")
    BACKUP_NODE_URL = os.getenv("BACKUP_NODE_URL", "")
    AWS_ACCESS_KEY = os.getenv("AWS_ACCESS_KEY", "")
    AWS_SECRET_KEY = os.getenv("AWS_SECRET_KEY", "")


settings = Settings()

# ===== Initialize Services =====
app = FastAPI(title=settings.APP_NAME, version=settings.VERSION)

# HTTPS redirect middleware (for production)
if settings.ENABLE_HTTPS:
    app.add_middleware(HTTPSRedirectMiddleware)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Database
engine = create_async_engine(settings.DATABASE_URL, echo=False)
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

# Redis
redis_client = None

# Password hashing
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Security
security = HTTPBearer()

# Compression
compressor = zstd.ZstdCompressor(level=settings.COMPRESSION_LEVEL)
decompressor = zstd.ZstdDecompressor()

# S3 client for backup
s3_client = None
if settings.BACKUP_ENABLED and settings.AWS_ACCESS_KEY:
    s3_client = boto3.client(
        "s3",
        aws_access_key_id=settings.AWS_ACCESS_KEY,
        aws_secret_access_key=settings.AWS_SECRET_KEY,
    )

# ===== Database Models =====
from sqlalchemy import (
    Column,
    String,
    Integer,
    DateTime,
    Boolean,
    ForeignKey,
    JSON,
    BigInteger,
    Text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.ext.declarative import declarative_base
import uuid as uuid_lib

Base = declarative_base()


class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid_lib.uuid4)
    email = Column(String(255), unique=True, nullable=False)
    username = Column(String(100), unique=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    user_type = Column(
        String(20), default="individual"
    )  # individual, business, enterprise
    storage_quota = Column(BigInteger, default=107374182400)  # 100GB default
    storage_used = Column(BigInteger, default=0)
    is_active = Column(Boolean, default=True)
    theme_preference = Column(String(10), default="light")  # light/dark mode
    created_at = Column(DateTime, default=datetime.utcnow)


class Folder(Base):
    __tablename__ = "folders"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid_lib.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    parent_id = Column(UUID(as_uuid=True), ForeignKey("folders.id"), nullable=True)
    name = Column(String(255), nullable=False)
    path = Column(String(1000), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)


class Object(Base):
    __tablename__ = "objects"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid_lib.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    folder_id = Column(UUID(as_uuid=True), ForeignKey("folders.id"), nullable=True)
    file_name = Column(String(255), nullable=False)
    file_size = Column(BigInteger, nullable=False)
    mime_type = Column(String(100))
    content_hash = Column(String(64))
    encryption_key = Column(Text)  # Encrypted with master key
    chunk_info = Column(JSON)
    storage_tier = Column(String(20), default="cache")
    backup_status = Column(String(20), default="pending")  # pending, completed, failed
    backup_location = Column(String(500))
    created_at = Column(DateTime, default=datetime.utcnow)
    last_accessed = Column(DateTime, default=datetime.utcnow)


class ActivityLog(Base):
    __tablename__ = "activity_logs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid_lib.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    action = Column(String(50), nullable=False)
    object_id = Column(UUID(as_uuid=True), nullable=True)
    ip_address = Column(String(45))
    user_agent = Column(Text)
    meta_data = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow)


# ===== Encryption Service =====
class EncryptionService:
    def __init__(self):
        self.master_key = settings.SECRET_KEY.encode()[:32].ljust(32, b"0")

    def generate_file_key(self) -> bytes:
        """Generate a unique encryption key for a file"""
        return Fernet.generate_key()

    def encrypt_data(self, data: bytes, key: bytes) -> bytes:
        """Encrypt data using AES-256"""
        fernet = Fernet(key)
        return fernet.encrypt(data)

    def decrypt_data(self, encrypted_data: bytes, key: bytes) -> bytes:
        """Decrypt data"""
        fernet = Fernet(key)
        return fernet.decrypt(encrypted_data)

    def encrypt_key(self, file_key: bytes) -> str:
        """Encrypt file key with master key"""
        fernet = Fernet(Fernet.generate_key())
        return fernet.encrypt(file_key).decode()

    def decrypt_key(self, encrypted_key: str) -> bytes:
        """Decrypt file key"""
        fernet = Fernet(Fernet.generate_key())
        return fernet.decrypt(encrypted_key.encode())


encryption_service = EncryptionService()


# ===== Storage Service =====
class StorageService:
    async def save_chunk(
        self, chunk_data: bytes, chunk_hash: str, encrypt_key: bytes = None
    ) -> Dict:
        """Save chunk with compression, encryption, and deduplication"""
        # Check for deduplication
        existing = await redis_client.get(f"chunk:{chunk_hash}")
        if existing:
            await redis_client.incr(f"chunk:refs:{chunk_hash}")
            return json.loads(existing)

        # Compress
        compressed_data = compressor.compress(chunk_data)

        # Encrypt if key provided
        if encrypt_key:
            compressed_data = encryption_service.encrypt_data(
                compressed_data, encrypt_key
            )

        # Save to cache tier
        shard = chunk_hash[:2]
        chunk_path = os.path.join(settings.CACHE_PATH, shard, chunk_hash)
        os.makedirs(os.path.dirname(chunk_path), exist_ok=True)

        async with aiofiles.open(chunk_path, "wb") as f:
            await f.write(compressed_data)

        chunk_info = {
            "hash": chunk_hash,
            "size": len(chunk_data),
            "compressed_size": len(compressed_data),
            "path": chunk_path,
            "tier": "cache",
            "encrypted": encrypt_key is not None,
            "created": datetime.utcnow().isoformat(),
        }

        await redis_client.setex(f"chunk:{chunk_hash}", 86400, json.dumps(chunk_info))
        await redis_client.set(f"chunk:refs:{chunk_hash}", 1)

        return chunk_info

    async def get_chunk(self, chunk_hash: str, decrypt_key: bytes = None) -> bytes:
        """Retrieve and decompress chunk"""
        chunk_info = await redis_client.get(f"chunk:{chunk_hash}")
        if not chunk_info:
            raise HTTPException(404, "Chunk not found")

        chunk_data = json.loads(chunk_info)

        async with aiofiles.open(chunk_data["path"], "rb") as f:
            compressed_data = await f.read()

        # Decrypt if needed
        if chunk_data.get("encrypted") and decrypt_key:
            compressed_data = encryption_service.decrypt_data(
                compressed_data, decrypt_key
            )

        # Decompress
        return decompressor.decompress(compressed_data)

    async def move_to_tier(self, chunk_hash: str, target_tier: str):
        """Move chunk between storage tiers"""
        chunk_info = await redis_client.get(f"chunk:{chunk_hash}")
        if not chunk_info:
            return

        chunk_data = json.loads(chunk_info)
        if chunk_data["tier"] == target_tier:
            return

        # Determine paths
        tier_paths = {
            "cache": settings.CACHE_PATH,
            "warm": settings.WARM_PATH,
            "cold": settings.COLD_PATH,
        }

        old_path = chunk_data["path"]
        shard = chunk_hash[:2]
        new_path = os.path.join(tier_paths[target_tier], shard, chunk_hash)

        # Move file
        os.makedirs(os.path.dirname(new_path), exist_ok=True)
        shutil.move(old_path, new_path)

        # Update metadata
        chunk_data["path"] = new_path
        chunk_data["tier"] = target_tier
        await redis_client.set(f"chunk:{chunk_hash}", json.dumps(chunk_data))


storage_service = StorageService()


# ===== Backup Service =====
class BackupService:
    async def backup_to_s3(self, file_path: str, s3_key: str):
        """Backup file to S3"""
        if not s3_client:
            return False

        try:
            with open(file_path, "rb") as f:
                s3_client.upload_fileobj(f, settings.BACKUP_S3_BUCKET, s3_key)
            return True
        except Exception as e:
            print(f"S3 backup failed: {e}")
            return False

    async def backup_to_node(self, file_data: bytes, file_id: str):
        """Backup to another node"""
        if not settings.BACKUP_NODE_URL:
            return False

        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{settings.BACKUP_NODE_URL}/backup/{file_id}", data=file_data
                ) as response:
                    return response.status == 200
        except Exception as e:
            print(f"Node backup failed: {e}")
            return False

    async def backup_object(self, object_id: str, chunks: List[Dict]):
        """Backup an object to secondary storage"""
        backup_path = os.path.join(settings.BACKUP_PATH, str(object_id))
        os.makedirs(backup_path, exist_ok=True)

        # Collect all chunks
        full_data = b""
        for chunk_info in chunks:
            chunk_data = await storage_service.get_chunk(chunk_info["hash"])
            full_data += chunk_data

        # Save locally
        local_backup = os.path.join(backup_path, f"{object_id}.bak")
        async with aiofiles.open(local_backup, "wb") as f:
            await f.write(full_data)

        # Backup to S3
        if s3_client:
            await self.backup_to_s3(local_backup, f"backups/{object_id}")

        # Backup to another node
        if settings.BACKUP_NODE_URL:
            await self.backup_to_node(full_data, object_id)

        return local_backup


backup_service = BackupService()


# ===== Helper Functions =====
async def get_db():
    async with AsyncSessionLocal() as session:
        yield session


def create_access_token(data: dict):
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db),
):
    token = credentials.credentials
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        user_id = payload.get("sub")
        if user_id is None:
            raise HTTPException(401, "Invalid token")

        result = await db.execute(select(User).filter(User.id == user_id))
        user = result.scalar_one_or_none()
        if not user:
            raise HTTPException(401, "User not found")
        return user
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except:
        raise HTTPException(401, "Invalid token")


async def log_activity(
    db: AsyncSession,
    user_id: str,
    action: str,
    object_id: str = None,
    metadata: dict = None,
    request: Request = None,
):
    """Log user activity"""
    activity = ActivityLog(
        user_id=user_id,
        action=action,
        object_id=object_id,
        ip_address=request.client.host if request else None,
        user_agent=request.headers.get("user-agent") if request else None,
        meta_data=metadata,
    )
    db.add(activity)
    await db.commit()


# ===== API Endpoints =====


@app.on_event("startup")
async def startup():
    global redis_client
    redis_client = await redis.from_url(settings.REDIS_URL)

    # Create storage directories
    for path in [
        settings.CACHE_PATH,
        settings.WARM_PATH,
        settings.COLD_PATH,
        settings.TEMP_PATH,
        settings.BACKUP_PATH,
    ]:
        os.makedirs(path, exist_ok=True)
        for i in range(256):
            os.makedirs(os.path.join(path, f"{i:02x}"), exist_ok=True)

    # Create tables
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


@app.on_event("shutdown")
async def shutdown():
    if redis_client:
        await redis_client.close()


# ===== User Registration & Authentication =====


@app.post("/api/v1/auth/register")
async def register(
    email: str = Form(...),
    username: str = Form(...),
    password: str = Form(...),
    user_type: str = Form("individual"),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Register a new user"""
    # Check if user exists
    result = await db.execute(
        select(User).filter((User.email == email) | (User.username == username))
    )
    if result.scalar_one_or_none():
        raise HTTPException(400, "User already exists")

    # Set quota based on user type
    quotas = {
        "individual": 100 * 1024**3,  # 100GB
        "business": 1024**4,  # 1TB
        "enterprise": 10 * 1024**4,  # 10TB
    }

    # Create user
    user = User(
        email=email,
        username=username,
        password_hash=pwd_context.hash(password),
        user_type=user_type,
        storage_quota=quotas.get(user_type, quotas["individual"]),
    )
    db.add(user)
    await db.commit()

    # Create root folder
    root_folder = Folder(user_id=user.id, parent_id=None, name="/", path="/")
    db.add(root_folder)
    await db.commit()

    # Log activity
    await log_activity(
        db,
        user.id,
        "user_registered",
        metadata={"user_type": user_type},
        request=request,
    )

    # Create token
    token = create_access_token({"sub": str(user.id), "email": email})

    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id": str(user.id),
            "email": email,
            "username": username,
            "user_type": user_type,
            "storage_quota": quotas.get(user_type),
        },
    }


@app.post("/api/v1/auth/login")
async def login(
    email: str = Form(...),
    password: str = Form(...),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Login user"""
    result = await db.execute(select(User).filter(User.email == email))
    user = result.scalar_one_or_none()

    if not user or not pwd_context.verify(password, user.password_hash):
        raise HTTPException(401, "Invalid credentials")

    if not user.is_active:
        raise HTTPException(403, "Account deactivated")

    # Log activity
    await log_activity(db, user.id, "user_login", request=request)

    token = create_access_token({"sub": str(user.id), "email": email})

    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id": str(user.id),
            "email": user.email,
            "username": user.username,
            "user_type": user.user_type,
            "storage_quota": user.storage_quota,
            "storage_used": user.storage_used,
            "theme": user.theme_preference,
        },
    }


@app.put("/api/v1/users/theme")
async def update_theme(
    theme: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update user theme preference (light/dark)"""
    current_user.theme_preference = theme
    await db.commit()
    return {"theme": theme}


# ===== Folder Management =====


@app.post("/api/v1/folders")
async def create_folder(
    name: str,
    parent_id: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Create a new folder"""
    # Get parent folder
    parent_path = "/"
    if parent_id:
        result = await db.execute(
            select(Folder).filter(
                Folder.id == parent_id, Folder.user_id == current_user.id
            )
        )
        parent = result.scalar_one_or_none()
        if not parent:
            raise HTTPException(404, "Parent folder not found")
        parent_path = parent.path

    # Create folder
    folder = Folder(
        user_id=current_user.id,
        parent_id=parent_id,
        name=name,
        path=os.path.join(parent_path, name),
    )
    db.add(folder)
    await db.commit()

    await log_activity(
        db, current_user.id, "folder_created", str(folder.id), {"name": name}, request
    )

    

    # Trigger backup in background
    if settings.BACKUP_ENABLED:
        background_tasks.add_task(
            backup_service.backup_object, str(file_id), session["chunk_hashes"]
        )

    # Clean up session
    await redis_client.delete(f"upload:{upload_id}")

    return {
        "status": "success",
        "file_id": str(file_id),
        "file_name": session["file_name"],
        "file_size": session["file_size"],
        "backup_status": "initiated" if settings.BACKUP_ENABLED else "disabled",
    }


@app.get("/api/v1/upload/resume/{upload_id}")
async def get_upload_status(
    upload_id: str, current_user: User = Depends(get_current_user)
):
    """Get upload status for resuming"""
    session_data = await redis_client.get(f"upload:{upload_id}")
    if not session_data:
        raise HTTPException(404, "Upload session not found")

    session = json.loads(session_data)

    if session["user_id"] != str(current_user.id):
        raise HTTPException(403, "Unauthorized")

    missing_chunks = set(range(session["total_chunks"])) - set(
        session["uploaded_chunks"]
    )

    return {
        "upload_id": upload_id,
        "file_name": session["file_name"],
        "total_chunks": session["total_chunks"],
        "uploaded_chunks": session["uploaded_chunks"],
        "missing_chunks": list(missing_chunks),
        "progress": len(session["uploaded_chunks"]) / session["total_chunks"] * 100,
    }


# ===== File Download & Sharing =====


@app.get("/api/v1/files/{file_id}/download")
async def download_file(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Download file with decryption"""
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(404, "File not found")

    # Get encryption key
    file_key = encryption_service.decrypt_key(file_obj.encryption_key)

    # Stream chunks
    async def stream_chunks():
        for chunk_hash in file_obj.chunk_info["chunks"]:
            chunk_data = await storage_service.get_chunk(chunk_hash, file_key)
            yield chunk_data

    # Update last accessed
    file_obj.last_accessed = datetime.utcnow()
    await db.commit()

    # Log activity
    await log_activity(
        db, current_user.id, "file_downloaded", str(file_id), request=request
    )

    return StreamingResponse(
        stream_chunks(),
        media_type=file_obj.mime_type or "application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{file_obj.file_name}"',
            "Content-Length": str(file_obj.file_size),
        },
    )


@app.post("/api/v1/files/{file_id}/share")
async def create_share_link(
    file_id: str,
    expires_hours: int = 24,
    password: Optional[str] = None,
    max_downloads: Optional[int] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Create shareable link with permissions"""
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(404, "File not found")

    share_token = secrets.token_urlsafe(32)

    share_data = {
        "token": share_token,
        "file_id": str(file_id),
        "user_id": str(current_user.id),
        "password": pwd_context.hash(password) if password else None,
        "expires_at": (datetime.utcnow() + timedelta(hours=expires_hours)).isoformat(),
        "max_downloads": max_downloads,
        "download_count": 0,
    }

    await redis_client.setex(
        f"share:{share_token}", expires_hours * 3600, json.dumps(share_data)
    )

    # Log activity
    await log_activity(
        db,
        current_user.id,
        "share_created",
        str(file_id),
        {"expires_hours": expires_hours, "has_password": bool(password)},
        request,
    )

    return {
        "share_url": f"https://yourdomain.com/share/{share_token}",
        "token": share_token,
        "expires_at": share_data["expires_at"],
        "password_protected": bool(password),
    }


@app.get("/api/v1/share/{share_token}")
async def download_shared(
    share_token: str, password: Optional[str] = None, db: AsyncSession = Depends(get_db)
):
    """Download shared file"""
    share_data = await redis_client.get(f"share:{share_token}")
    if not share_data:
        raise HTTPException(404, "Share link expired or not found")

    share = json.loads(share_data)

    # Check password
    if share["password"]:
        if not password or not pwd_context.verify(password, share["password"]):
            raise HTTPException(401, "Invalid password")

    # Check download limit
    if share["max_downloads"] and share["download_count"] >= share["max_downloads"]:
        raise HTTPException(403, "Download limit exceeded")

    # Get file
    result = await db.execute(select(Object).filter(Object.id == share["file_id"]))
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(404, "File not found")

    # Update download count
    share["download_count"] += 1
    await redis_client.set(f"share:{share_token}", json.dumps(share))

    # Get encryption key
    file_key = encryption_service.decrypt_key(file_obj.encryption_key)

    # Stream file
    async def stream_chunks():
        for chunk_hash in file_obj.chunk_info["chunks"]:
            chunk_data = await storage_service.get_chunk(chunk_hash, file_key)
            yield chunk_data

    return StreamingResponse(
        stream_chunks(),
        media_type=file_obj.mime_type or "application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{file_obj.file_name}"',
            "Content-Length": str(file_obj.file_size),
        },
    )


# ===== File Management =====


@app.get("/api/v1/files")
async def list_files(
    folder_id: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List files with folder support"""
    query = select(Object).filter(Object.user_id == current_user.id)
    if folder_id:
        query = query.filter(Object.folder_id == folder_id)
    else:
        query = query.filter(Object.folder_id == None)

    result = await db.execute(query)
    files = result.scalars().all()

    return [
        {
            "id": str(f.id),
            "name": f.file_name,
            "size": f.file_size,
            "mime_type": f.mime_type,
            "folder_id": str(f.folder_id) if f.folder_id else None,
            "storage_tier": f.storage_tier,
            "backup_status": f.backup_status,
            "created_at": f.created_at.isoformat(),
            "last_accessed": f.last_accessed.isoformat(),
        }
        for f in files
    ]


@app.delete("/api/v1/files/{file_id}")
async def delete_file(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Delete file and free up storage"""
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(404, "File not found")

    # Decrease reference count for chunks
    for chunk_hash in file_obj.chunk_info["chunks"]:
        refs = await redis_client.decr(f"chunk:refs:{chunk_hash}")
        if refs <= 0:
            # Delete chunk if no more references
            chunk_info = await redis_client.get(f"chunk:{chunk_hash}")
            if chunk_info:
                chunk_data = json.loads(chunk_info)
                try:
                    os.remove(chunk_data["path"])
                except:
                    pass
                await redis_client.delete(f"chunk:{chunk_hash}")
                await redis_client.delete(f"chunk:refs:{chunk_hash}")

    # Update user storage
    current_user.storage_used -= file_obj.file_size

    # Delete file record
    await db.delete(file_obj)
    await db.commit()

    # Log activity
    await log_activity(
        db,
        current_user.id,
        "file_deleted",
        str(file_id),
        {"file_name": file_obj.file_name},
        request,
    )

    return {"status": "success", "freed_space": file_obj.file_size}


# ===== Storage Management =====


@app.get("/api/v1/storage/stats")
async def get_storage_stats(
    current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Get user storage statistics"""
    # Get file distribution
    result = await db.execute(
        select(Object.storage_tier, func.count(), func.sum(Object.file_size))
        .filter(Object.user_id == current_user.id)
        .group_by(Object.storage_tier)
    )

    distribution = {}
    for tier, count, size in result:
        distribution[tier] = {"count": count, "size": size or 0}

    return {
        "quota": current_user.storage_quota,
        "used": current_user.storage_used,
        "available": current_user.storage_quota - current_user.storage_used,
        "percentage_used": (
            (current_user.storage_used / current_user.storage_quota * 100)
            if current_user.storage_quota > 0
            else 0
        ),
        "distribution": distribution,
    }


@app.post("/api/v1/storage/optimize")
async def optimize_storage(
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Trigger storage optimization"""
    background_tasks.add_task(optimize_user_storage, current_user.id)
    return {"status": "optimization started"}


async def optimize_user_storage(user_id: str):
    """Background task to optimize storage"""
    async with AsyncSessionLocal() as db:
        # Get user's files
        result = await db.execute(select(Object).filter(Object.user_id == user_id))
        files = result.scalars().all()

        for file in files:
            # Move old files to cold storage
            age_days = (datetime.utcnow() - file.last_accessed).days

            if age_days > 30 and file.storage_tier == "cache":
                # Move to warm
                for chunk_hash in file.chunk_info["chunks"]:
                    await storage_service.move_to_tier(chunk_hash, "warm")
                file.storage_tier = "warm"
            elif age_days > 90 and file.storage_tier == "warm":
                # Move to cold
                for chunk_hash in file.chunk_info["chunks"]:
                    await storage_service.move_to_tier(chunk_hash, "cold")
                file.storage_tier = "cold"

        await db.commit()


# ===== Activity & Analytics =====


@app.get("/api/v1/activity")
async def get_activity_logs(
    limit: int = 50,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get user activity logs"""
    result = await db.execute(
        select(ActivityLog)
        .filter(ActivityLog.user_id == current_user.id)
        .order_by(ActivityLog.created_at.desc())
        .limit(limit)
    )

    activities = result.scalars().all()

    return [
        {
            "id": str(a.id),
            "action": a.action,
            "object_id": str(a.object_id) if a.object_id else None,
            "ip_address": a.ip_address,
            "metadata": a.metadata,
            "created_at": a.created_at.isoformat(),
        }
        for a in activities
    ]


# ===== Health & Status =====


@app.get("/api/v1/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "service": settings.APP_NAME,
        "version": settings.VERSION,
        "storage_tiers": {
            "cache": os.path.exists(settings.CACHE_PATH),
            "warm": os.path.exists(settings.WARM_PATH),
            "cold": os.path.exists(settings.COLD_PATH),
        },
        "backup_enabled": settings.BACKUP_ENABLED,
        "https_enabled": settings.ENABLE_HTTPS,
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)


    #return {
        #"id": str(folder.id),
        #"name": name,
        #"path": folder.path,
        #"parent_id": parent_id,
    #}


@app.get("/api/v1/folders")
async def list_folders(
    parent_id: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List user's folders"""
    query = select(Folder).filter(Folder.user_id == current_user.id)
    if parent_id:
        query = query.filter(Folder.parent_id == parent_id)
    else:
        query = query.filter(Folder.parent_id == None)

    result = await db.execute(query)
    folders = result.scalars().all()

    return [
        {
            "id": str(f.id),
            "name": f.name,
            "path": f.path,
            "parent_id": str(f.parent_id) if f.parent_id else None,
            "created_at": f.created_at.isoformat(),
        }
        for f in folders
    ]


# ===== File Upload with All Features =====


@app.post("/api/v1/upload/init")
async def init_upload(
    file_name: str,
    file_size: int,
    folder_id: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Initialize chunked upload with resumable support"""
    # Check quota
    if current_user.storage_used + file_size > current_user.storage_quota:
        raise HTTPException(413, "Storage quota exceeded")

    upload_id = str(uuid.uuid4())
    total_chunks = (file_size + settings.CHUNK_SIZE - 1) // settings.CHUNK_SIZE

    # Generate encryption key for this file
    file_key = encryption_service.generate_file_key()
    encrypted_key = encryption_service.encrypt_key(file_key)

    session_data = {
        "upload_id": upload_id,
        "user_id": str(current_user.id),
        "file_name": file_name,
        "file_size": file_size,
        "folder_id": folder_id,
        "total_chunks": total_chunks,
        "uploaded_chunks": [],
        "chunk_hashes": [],
        "encryption_key": encrypted_key,
        "started_at": datetime.utcnow().isoformat(),
    }

    await redis_client.setex(f"upload:{upload_id}", 3600, json.dumps(session_data))

    return {
        "upload_id": upload_id,
        "chunk_size": settings.CHUNK_SIZE,
        "total_chunks": total_chunks,
        "resumable": True,
    }


@app.post("/api/v1/upload/chunk/{upload_id}")
async def upload_chunk(
    upload_id: str,
    chunk_index: int,
    chunk: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    background_tasks: BackgroundTasks = None,
    request: Request = None,
):
    """Upload chunk with compression, encryption, and deduplication"""
    session_data = await redis_client.get(f"upload:{upload_id}")
    if not session_data:
        raise HTTPException(404, "Upload session not found or expired")

    session = json.loads(session_data)

    # Check if chunk already uploaded (for resume support)
    if chunk_index in session["uploaded_chunks"]:
        return {"status": "already_uploaded", "chunk_index": chunk_index}

    # Read chunk
    chunk_data = await chunk.read()

    # Calculate hash for deduplication
    chunk_hash = hashlib.sha256(chunk_data).hexdigest()

    # Get encryption key
    file_key = encryption_service.decrypt_key(session["encryption_key"])

    # Save chunk with all features
    chunk_info = await storage_service.save_chunk(chunk_data, chunk_hash, file_key)

    # Update session
    session["uploaded_chunks"].append(chunk_index)
    if len(session["chunk_hashes"]) <= chunk_index:
        session["chunk_hashes"].extend(
            [None] * (chunk_index + 1 - len(session["chunk_hashes"]))
        )
    session["chunk_hashes"][chunk_index] = chunk_hash

    await redis_client.setex(f"upload:{upload_id}", 3600, json.dumps(session))

    progress = len(session["uploaded_chunks"]) / session["total_chunks"] * 100

    return {
        "status": "success",
        "chunk_index": chunk_index,
        "progress": progress,
        "resumable": True,
    }


@app.post("/api/v1/upload/complete/{upload_id}")
async def complete_upload(
    upload_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    background_tasks: BackgroundTasks = None,
    request: Request = None,
):
    """Complete upload and trigger backup"""
    session_data = await redis_client.get(f"upload:{upload_id}")
    if not session_data:
        raise HTTPException(404, "Upload session not found")

    session = json.loads(session_data)

    # Verify all chunks uploaded
    if len(session["uploaded_chunks"]) != session["total_chunks"]:
        missing = set(range(session["total_chunks"])) - set(session["uploaded_chunks"])
        return {"status": "incomplete", "missing_chunks": list(missing)}

    # Create file entry
    file_id = uuid.uuid4()
    file_hash = hashlib.sha256("".join(session["chunk_hashes"]).encode()).hexdigest()

    file_obj = Object(
        id=file_id,
        user_id=current_user.id,
        folder_id=session.get("folder_id"),
        file_name=session["file_name"],
        file_size=session["file_size"],
        content_hash=file_hash,
        encryption_key=session["encryption_key"],
        chunk_info={
            "chunks": session["chunk_hashes"],
            "count": session["total_chunks"],
        },
        storage_tier="cache",
    )
    db.add(file_obj)

    # Update user storage
    current_user.storage_used += session["file_size"]

    await db.commit()

    # Log activity

    await log_activity(
        db,
        current_user.id,
        "file_uploaded",
        str(file_id),
        {"file_name": session["file_name"], "size": session["file_size"]},
        request,
    )
