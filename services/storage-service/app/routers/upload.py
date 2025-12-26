# services/storage-service/app/routers/upload.py

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Request, BackgroundTasks, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from typing import Optional, AsyncGenerator
import uuid
import json
import os
import io
import base64
import hashlib
import mimetypes
from datetime import datetime
from ..dependencies import get_db, log_activity, get_current_user
from ..services.auth import auth_service
from ..services.storage import storage_service
from ..services.encryption import encryption_service
from ..models.database import User, Object, FileVersion
from ..models.schemas import UploadInitResponse, UploadStatusResponse
from ..database import get_redis
from ..config import settings
from ..utils.rate_limiter_v2 import create_rate_limiter, RateLimitConfig
from aiokafka import AIOKafkaProducer
import aiofiles
from ..utils.cache import cached
from ..monitoring.metrics import (
    upload_initiated, upload_completed, upload_duration,
    active_uploads, chunk_processing_duration, errors_total
)
import time
import asyncio
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from ..services.deduplication_enhanced import enhanced_dedup_service
from .background_deduplication import background_dedup_service
from ..services.dedup_classifier import dedup_classifier
from ..services.search_service import search_service
from ..services.virus_scanner import get_virus_scanner
from ..services.dlp_service import get_dlp_service
from ..services.audit_service import get_audit_service
from ..services.video_optimizer import video_optimizer
from ..services.video_ingestion_service import video_ingestion_service
import logging

router = APIRouter(prefix="/api/v1/upload", tags=["upload"])
logger = logging.getLogger(__name__)

# Global resources
kafka_producer = None
kafka_lock = asyncio.Lock()
executor = ThreadPoolExecutor(max_workers=100)  # Support 100 concurrent uploads

# Optimized buffer sizes
# Read from environment variables with fallbacks
STREAM_BUFFER_SIZE = int(os.getenv('STREAM_BUFFER_SIZE', 8 * 1024 * 1024))  # 8MB default
INLINE_THRESHOLD = int(os.getenv('INLINE_THRESHOLD', 512 * 1024))  # 512KB
SINGLE_OBJECT_THRESHOLD = int(os.getenv('SINGLE_OBJECT_THRESHOLD', 50 * 1024 * 1024))  # 50MB
CHUNK_SIZE = int(os.getenv('CHUNK_SIZE', 32 * 1024 * 1024))  # 32MB default - CRITICAL CHANGE

# Files that are already compressed - DO NOT compress these
COMPRESSED_FORMATS = {'.zip', '.gz', '.rar', '.7z', '.bz2', '.xz', 
                      '.jpg', '.jpeg', '.png', '.mp4', '.mp3', '.avi',
                      '.mkv', '.mov', '.webm', '.flac', '.aac', '.ogg',
                      '.pdf', '.docx', '.xlsx', '.pptx'}  # Most modern formats are compressed

# Only compress these text-based formats
COMPRESSIBLE_FORMATS = {'.txt', '.log', '.csv', '.json', '.xml', '.sql', 
                        '.html', '.css', '.js', '.py', '.java', '.c', '.cpp'}

def should_compress(filename: str, size: int) -> bool:
    """Determine if file should be compressed based on type and size"""
    ext = os.path.splitext(filename)[1].lower()
    
    # Never compress already-compressed formats
    if ext in COMPRESSED_FORMATS:
        return False
    
    # Only compress text formats larger than 1MB
    if ext in COMPRESSIBLE_FORMATS and size > 1024 * 1024:
        return True
    
    return False

async def get_kafka_producer():
    """Get or create Kafka producer with connection management"""
    global kafka_producer
    
    if not hasattr(settings, 'KAFKA_BROKERS'):
        return None
    
    async with kafka_lock:
        if kafka_producer is None:
            try:
                kafka_producer = AIOKafkaProducer(
                    bootstrap_servers=settings.KAFKA_BROKERS,
                    # Optimization: Only JSON encode if it's not already bytes
                    value_serializer=lambda v: v if isinstance(v, (bytes, bytearray)) else json.dumps(v).encode(),

                    # zstd compression (requires cramjam package)
                    compression_type='zstd',

                    # 100MB max request matches large-scale needs
                    max_request_size=104857600,

                    # Match 64MB upload chunk size
                    max_batch_size=67108864,

                    # Helps zstd find patterns across chunks
                    linger_ms=100,
                )
                await kafka_producer.start()
                logger.info("Kafka producer initialized with ZSTD compression")
            except Exception as e:
                logger.warning(f"Kafka unavailable: {e}")
                return None

    return kafka_producer

async def get_user_storage_info_fast(user_id: str, db: AsyncSession, redis_client):
    """Lightweight storage check with Redis caching"""
    # Try cache first (30 second TTL)
    cache_key = f"quota:{user_id}"
    cached = await redis_client.get(cache_key)

    if cached:
        # Redis returns bytes, decode to string
        if isinstance(cached, bytes):
            cached = cached.decode('utf-8')
        return json.loads(cached)

    # Cache miss - query database
    result = await db.execute(
        select(User.storage_quota, User.storage_used)
        .where(User.id == user_id)
    )
    data = result.first()

    if not data:
        storage_info = {"quota": 0, "used": 0}
    else:
        storage_info = {
            "quota": int(data.storage_quota or 0),
            "used": int(data.storage_used or 0)
        }

    # Cache for 30 seconds (fire-and-forget)
    asyncio.create_task(
        redis_client.setex(cache_key, 30, json.dumps(storage_info))
    )

    return storage_info

def process_chunk_cpu_bound(chunk_data: bytes, file_key: bytes, chunk_index: int, compress: bool = False):
    """CPU-intensive operations in thread pool"""
    # Hash calculation (before any processing)
    original_hash = hashlib.sha256(chunk_data).hexdigest()
    
    # Optional compression (only for compressible files)
    if compress:
        from ..utils.compression import compressor
        chunk_data = compressor.compress(chunk_data)
    
    # Encryption (AES-GCM is fast with hardware acceleration)
    encrypted_chunk = encryption_service.encrypt_chunk(chunk_data, file_key, chunk_index)
    
    return encrypted_chunk, original_hash

@router.post("/init", response_model=UploadInitResponse, dependencies=[Depends(create_rate_limiter(**RateLimitConfig.FILE_UPLOAD))])
async def init_upload(
    request: Request,
    file_name: str,
    file_size: int,
    folder_id: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Initialize upload with smart storage decision"""
    if not file_name or file_size is None:
        raise HTTPException(400, "file_name and file_size required")
    
    redis_client = await get_redis()

    # Check storage quota (with caching)
    storage_info = await get_user_storage_info_fast(str(current_user.id), db, redis_client)
    if storage_info['used'] + file_size > storage_info['quota']:
        raise HTTPException(status_code=413, detail="Storage quota exceeded")
    
    # Determine storage strategy
    if file_size < INLINE_THRESHOLD:
        storage_strategy = "inline"
        total_chunks = 0
    elif file_size < SINGLE_OBJECT_THRESHOLD:
        storage_strategy = "single"
        total_chunks = 0
    else:
        storage_strategy = "chunked"
        total_chunks = (file_size + CHUNK_SIZE - 1) // CHUNK_SIZE
    
    upload_id = str(uuid.uuid4())
    
    # Generate encryption key for this upload
    file_key = encryption_service.generate_file_key()
    encrypted_key = encryption_service.encrypt_key(file_key)
    
    # Check if compression should be used
    use_compression = should_compress(file_name, file_size)
    
    session_data = {
        "id": upload_id,
        "user": str(current_user.id),
        "name": file_name,
        "size": file_size,
        "folder": folder_id,
        "strategy": storage_strategy,
        "chunks": total_chunks,
        "done": [],
        "hashes": [],
        "chunk_paths": {},
        "key": encrypted_key,
        "compress": use_compression,  # Store compression decision
        "start": datetime.utcnow().isoformat(),
    }

    # Fire-and-forget Redis update (non-blocking)
    asyncio.create_task(
        redis_client.setex(f"up:{upload_id}", 3600, json.dumps(session_data))
    )
    
    # Metrics
    upload_initiated.labels(
        user_type=getattr(current_user, 'user_type', 'standard'),
        storage_strategy=storage_strategy
    ).inc()
    active_uploads.inc()
    
    print(f"📤 Upload initialized: {file_name} ({file_size/1024/1024:.1f}MB) - Compression: {use_compression}")
    
    return UploadInitResponse(
        upload_id=upload_id,
        storage_strategy=storage_strategy,
        chunk_size=CHUNK_SIZE if storage_strategy == "chunked" else 0,
        total_chunks=total_chunks,
        direct_upload=storage_strategy != "chunked"
    )


@router.post("/init/zk", response_model=UploadInitResponse, dependencies=[Depends(create_rate_limiter(**RateLimitConfig.FILE_UPLOAD))])
async def init_zk_upload(
    request: Request,
    file_name: str,
    file_size: int,
    encrypted_file_key: str,
    file_key_iv: str,
    encryption_algorithm: str = "AES-256-GCM",
    mime_type: Optional[str] = None,
    folder_id: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Initialize Zero-Knowledge upload

    This endpoint is for ZK-enabled users who encrypt files client-side.
    The server will NOT re-encrypt the chunks - they're already encrypted.

    Args:
        file_name: Original filename
        file_size: Total file size (before client encryption)
        encrypted_file_key: Base64-encoded file key encrypted with master key
        file_key_iv: Base64-encoded IV used for file key encryption
        encryption_algorithm: Encryption algorithm used (default: AES-256-GCM)
        mime_type: MIME type of the original file
        folder_id: Optional parent folder ID

    Returns:
        UploadInitResponse with zk_mode metadata
    """
    # Input validation
    if not file_name or not file_name.strip():
        raise HTTPException(400, "file_name cannot be empty")
    if file_size is None or file_size <= 0:
        raise HTTPException(400, "file_size must be greater than 0")
    if not encrypted_file_key or not file_key_iv:
        raise HTTPException(400, "encrypted_file_key and file_key_iv are required for ZK uploads")

    # Validate base64 encoding
    try:
        base64.b64decode(encrypted_file_key)
        base64.b64decode(file_key_iv)
    except Exception as e:
        logger.error(f"Invalid base64 encoding in ZK upload: {e}")
        raise HTTPException(400, "Invalid base64 encoding for encrypted_file_key or file_key_iv")

    # Security: Validate filename (no path traversal)
    file_name = file_name.strip()
    if '..' in file_name or '/' in file_name or '\\' in file_name:
        raise HTTPException(400, "Invalid filename - path traversal not allowed")
    if len(file_name) > 255:
        raise HTTPException(400, "Filename too long (max 255 characters)")

    # Size limits (10GB max)
    MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024  # 10GB
    if file_size > MAX_FILE_SIZE:
        raise HTTPException(413, f"File size exceeds maximum allowed size of {MAX_FILE_SIZE} bytes")

    redis_client = await get_redis()

    # Check storage quota
    storage_info = await get_user_storage_info_fast(str(current_user.id), db, redis_client)
    if storage_info['used'] + file_size > storage_info['quota']:
        logger.warning(
            f"ZK upload quota exceeded",
            extra={
                "user_id": str(current_user.id),
                "current_usage": storage_info['used'],
                "quota": storage_info['quota'],
                "requested_size": file_size
            }
        )
        raise HTTPException(status_code=413, detail="Storage quota exceeded")

    # Determine storage strategy (same as standard upload)
    if file_size < INLINE_THRESHOLD:
        storage_strategy = "inline"
        total_chunks = 0
    elif file_size < SINGLE_OBJECT_THRESHOLD:
        storage_strategy = "single"
        total_chunks = 0
    else:
        storage_strategy = "chunked"
        total_chunks = (file_size + CHUNK_SIZE - 1) // CHUNK_SIZE

    upload_id = str(uuid.uuid4())

    # ZK Mode: Do NOT generate file_key - client already did
    # Store the encrypted file key from client instead
    session_data = {
        "id": upload_id,
        "user": str(current_user.id),
        "name": file_name,
        "size": file_size,
        "folder": folder_id,
        "strategy": storage_strategy,
        "chunks": total_chunks,
        "done": [],
        "hashes": [],
        "chunk_paths": {},

        # ZK-specific metadata
        "zk_mode": True,  # Flag to skip server-side encryption
        "encrypted_file_key": encrypted_file_key,  # Store encrypted file key
        "file_key_iv": file_key_iv,  # Store IV
        "encryption_algorithm": encryption_algorithm,
        "client_encrypted": True,  # Mark as client-encrypted

        # Metadata
        "mime_type": mime_type,
        "compress": False,  # Never compress ZK files (already encrypted)
        "start": datetime.utcnow().isoformat(),
    }

    # Store session in Redis
    await redis_client.setex(f"up:{upload_id}", 3600, json.dumps(session_data))

    # Structured logging
    logger.info(
        "ZK upload initialized",
        extra={
            "event": "zk_upload_init",
            "user_id": str(current_user.id),
            "upload_id": upload_id,
            "filename": file_name,
            "file_size": file_size,
            "storage_strategy": storage_strategy,
            "total_chunks": total_chunks,
            "encryption_algorithm": encryption_algorithm,
            "mime_type": mime_type
        }
    )

    # Metrics
    upload_initiated.labels(
        user_type=getattr(current_user, 'user_type', 'standard'),
        storage_strategy=f"zk_{storage_strategy}"  # Tag as ZK upload
    ).inc()
    active_uploads.inc()

    print(f"🔐 ZK Upload initialized: {file_name} ({file_size/1024/1024:.1f}MB) - Client encrypted")

    return UploadInitResponse(
        upload_id=upload_id,
        storage_strategy=storage_strategy,
        chunk_size=CHUNK_SIZE if storage_strategy == "chunked" else 0,
        total_chunks=total_chunks,
        direct_upload=storage_strategy != "chunked"
    )


@router.post("/chunk/{upload_id}", dependencies=[Depends(create_rate_limiter(**RateLimitConfig.CHUNK_UPLOAD))])
async def upload_chunk(
    upload_id: str,
    chunk_index: int,
    request: Request,
    chunk: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Optimized chunk upload with smart compression"""
    redis_client = await get_redis()
    
    session_data = await redis_client.get(f"up:{upload_id}")
    if not session_data:
        raise HTTPException(status_code=404, detail="Upload session not found")

    # Handle both bytes and string from Redis
    if isinstance(session_data, bytes):
        session_data = session_data.decode('utf-8')
    session = json.loads(session_data)
    
    if session["user"] != str(current_user.id):
        raise HTTPException(status_code=403, detail="Unauthorized")
    
    if chunk_index in session["done"]:
        return {"status": "already_uploaded", "chunk_index": chunk_index}
    
    # Prepare storage path
    storage_tier = "cache"
    shard = f"{upload_id[:2]}"
    storage_dir = f"/app/storage/{storage_tier}/{shard}"

    # Non-blocking directory creation
    await asyncio.to_thread(os.makedirs, storage_dir, exist_ok=True)
    storage_path = f"{storage_dir}/{upload_id}_chunk_{chunk_index}.enc"
    
    # Read chunk data
    chunk_data = await chunk.read()

    # Check if this is a ZK (Zero-Knowledge) upload
    is_zk_mode = session.get("zk_mode", False)

    if is_zk_mode:
        # ZK Mode: Chunk is ALREADY encrypted by client
        # Just store it directly, no server-side encryption
        encrypted_chunk = chunk_data
        chunk_hash = hashlib.sha256(chunk_data).hexdigest()

        logger.debug(
            f"ZK chunk uploaded (no server encryption)",
            extra={
                "upload_id": upload_id,
                "chunk_index": chunk_index,
                "chunk_size": len(chunk_data),
                "zk_mode": True
            }
        )

        # Write encrypted data directly (no re-encryption)
        async with aiofiles.open(storage_path, 'wb', buffering=STREAM_BUFFER_SIZE) as f:
            await f.write(encrypted_chunk)
    else:
        # Standard Mode: Server-side encryption (existing flow)
        # Get encryption key
        file_key = encryption_service.decrypt_key(session["key"])

        # Process in thread pool (encryption + optional compression)
        loop = asyncio.get_event_loop()
        use_compression = session.get("compress", False)

        encrypted_chunk, chunk_hash = await loop.run_in_executor(
            executor,
            partial(process_chunk_cpu_bound, chunk_data, file_key, chunk_index, use_compression)
        )

        # Write encrypted data asynchronously with larger buffer
        async with aiofiles.open(storage_path, 'wb', buffering=STREAM_BUFFER_SIZE) as f:
            await f.write(encrypted_chunk)
    
    # Update session
    session["done"].append(chunk_index)
    session["hashes"].append(chunk_hash)
    session["chunk_paths"][str(chunk_index)] = storage_path
    
    # Fire-and-forget Redis update
    asyncio.create_task(
        redis_client.setex(f"up:{upload_id}", 3600, json.dumps(session))
    )
    
    progress = len(session["done"]) / session["chunks"] * 100 if session["chunks"] > 0 else 100

    return {
        "status": "success",
        "chunk_index": chunk_index,
        "progress": round(progress, 1),
        "encrypted": True,
        "compressed": session.get("compress", False) if not is_zk_mode else False,
        "zk_mode": is_zk_mode,  # Indicate if this is a ZK upload
    }

@router.post("/direct/{upload_id}", dependencies=[Depends(create_rate_limiter(**RateLimitConfig.FILE_UPLOAD))])
async def upload_direct(
    upload_id: str,
    request: Request,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Direct upload for small and medium files with optimized processing"""
    redis_client = await get_redis()
    
    session_data = await redis_client.get(f"up:{upload_id}")
    if not session_data:
        raise HTTPException(status_code=404, detail="Upload session not found")

    # Handle both bytes and string from Redis
    if isinstance(session_data, bytes):
        session_data = session_data.decode('utf-8')
    session = json.loads(session_data)
    
    if session["user"] != str(current_user.id):
        raise HTTPException(status_code=403, detail="Unauthorized")
    
    # Read file data
    file_data = await file.read()
    
    # Process in thread pool
    loop = asyncio.get_event_loop()
    file_key = encryption_service.decrypt_key(session["key"])
    use_compression = session.get("compress", False)
    
    def process_file():
        # Optional compression
        if use_compression:
            from ..utils.compression import compressor
            file_data_processed = compressor.compress(file_data)
        else:
            file_data_processed = file_data
        
        # Encrypt
        encrypted_data = encryption_service.encrypt_file(file_data_processed, file_key)
        file_hash = hashlib.sha256(file_data).hexdigest()  # Hash of original data
        return encrypted_data, file_hash
    
    encrypted_data, file_hash = await loop.run_in_executor(executor, process_file)
    
    # Determine storage location
    file_id = session["id"]
    storage_tier = "cache"
    
    if session["strategy"] == "inline":
        # For inline, store in database
        session["encrypted_data"] = base64.b64encode(encrypted_data).decode()
        session["storage_type"] = "inline"
    else:  # single
        # For single files, store on disk
        shard = "objects"
        storage_dir = f"/app/storage/{storage_tier}/{shard}"

        # Non-blocking directory creation
        await asyncio.to_thread(os.makedirs, storage_dir, exist_ok=True)

        storage_path = f"{storage_dir}/{file_id}.enc"
        
        async with aiofiles.open(storage_path, 'wb', buffering=STREAM_BUFFER_SIZE) as f:
            await f.write(encrypted_data)
        
        session["storage_path"] = storage_path
        session["storage_type"] = "single"
    
    session["hash"] = file_hash
    
    await redis_client.setex(f"up:{upload_id}", 3600, json.dumps(session))
    
    return {
        "status": "success",
        "upload_id": upload_id,
        "encrypted": True,
        "compressed": use_compression,
        "ready_for_completion": True
    }

@router.get("/status/{upload_id}")
async def get_upload_status(
    upload_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Get upload status - useful for resuming interrupted uploads

    Returns:
        - Upload session data
        - List of uploaded chunks
        - Missing chunks
        - Progress percentage
    """
    redis_client = await get_redis()

    session_data = await redis_client.get(f"up:{upload_id}")
    if not session_data:
        raise HTTPException(status_code=404, detail="Upload session not found or expired")

    # Handle both bytes and string from Redis
    if isinstance(session_data, bytes):
        session_data = session_data.decode('utf-8')
    session = json.loads(session_data)

    # Verify ownership
    if session["user"] != str(current_user.id):
        raise HTTPException(status_code=403, detail="Unauthorized")

    # Calculate missing chunks
    storage_strategy = session.get("strategy", "chunked")
    if storage_strategy == "chunked":
        total_chunks = session.get("chunks", 0)
        uploaded_chunks = set(session.get("done", []))
        missing_chunks = [i for i in range(total_chunks) if i not in uploaded_chunks]

        progress = (len(uploaded_chunks) / total_chunks * 100) if total_chunks > 0 else 0

        return {
            "upload_id": upload_id,
            "status": "in_progress" if missing_chunks else "ready_for_completion",
            "strategy": storage_strategy,
            "file_name": session["name"],
            "file_size": session["size"],
            "total_chunks": total_chunks,
            "uploaded_chunks": sorted(list(uploaded_chunks)),
            "missing_chunks": missing_chunks,
            "progress": round(progress, 2),
            "started_at": session.get("start"),
        }
    else:
        # Direct upload
        return {
            "upload_id": upload_id,
            "status": "ready_for_completion" if session.get("hash") else "waiting_for_upload",
            "strategy": storage_strategy,
            "file_name": session["name"],
            "file_size": session["size"],
            "progress": 100 if session.get("hash") else 0,
            "started_at": session.get("start"),
        }


@router.post("/resume/{upload_id}")
async def resume_upload(
    upload_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Resume an interrupted upload

    This endpoint allows clients to:
    1. Get the list of missing chunks
    2. Continue uploading from where they left off

    Returns the same structure as /status endpoint
    """
    # Use existing status endpoint
    return await get_upload_status(upload_id, current_user, db)


@router.post("/complete/{upload_id}")
async def complete_upload(
    upload_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Complete upload and create database record with deduplication"""
    redis_client = await get_redis()

    session_data = await redis_client.get(f"up:{upload_id}")
    if not session_data:
        raise HTTPException(status_code=404, detail="Upload session not found")

    # Handle both bytes and string from Redis
    if isinstance(session_data, bytes):
        session_data = session_data.decode('utf-8')
    session = json.loads(session_data)
    
    if session["user"] != str(current_user.id):
        raise HTTPException(status_code=403, detail="Unauthorized")
    
    storage_strategy = session.get("strategy", "chunked")
    start_time = datetime.fromisoformat(session["start"])
    
    # Verify upload completion
    if storage_strategy == "chunked":
        if len(session["done"]) != session["chunks"]:
            missing = set(range(session["chunks"])) - set(session["done"])
            return {"status": "incomplete", "missing_chunks": list(missing)}
    
    
    file_id = uuid.uuid4()
    mime_type = session.get("mime_type") or mimetypes.guess_type(session["name"])[0]

    # Check if this is a ZK upload
    is_zk_mode = session.get("zk_mode", False)

    # Prepare ZK-specific fields if applicable
    zk_fields = {}
    if is_zk_mode:
        zk_fields = {
            "is_encrypted": True,
            "encrypted_file_key": session.get("encrypted_file_key"),
            "file_key_iv": session.get("file_key_iv"),
            "encryption_algorithm": session.get("encryption_algorithm", "AES-256-GCM"),
            "uploaded_at": datetime.utcnow(),
            "upload_id": upload_id,
        }
        logger.info(
            "ZK upload completed",
            extra={
                "event": "zk_upload_complete",
                "user_id": str(current_user.id),
                "upload_id": upload_id,
                "file_id": str(file_id),
                "filename": session["name"],
                "file_size": session["size"],
                "storage_strategy": storage_strategy,
                "encryption_algorithm": session.get("encryption_algorithm")
            }
        )

    # Create database record based on storage type
    if storage_strategy == "inline":
        file_obj = Object(
            id=file_id,
            user_id=current_user.id,
            folder_id=session.get("folder"),
            file_name=session["name"],
            file_size=session["size"],
            mime_type=mime_type,
            storage_type="inline",
            storage_key=session.get("encrypted_data", ""),
            content_hash=session.get("hash", ""),
            encryption_key=session.get("key") if not is_zk_mode else None,
            storage_tier="cache",
            file_metadata={"compressed": session.get("compress", False)},
            **zk_fields  # Add ZK fields if applicable
        )
    
    elif storage_strategy == "single":
        file_obj = Object(
            id=file_id,
            user_id=current_user.id,
            folder_id=session.get("folder"),
            file_name=session["name"],
            file_size=session["size"],
            mime_type=mime_type,
            storage_type="single",
            object_path=session.get("storage_path", ""),
            content_hash=session.get("hash", ""),
            encryption_key=session.get("key") if not is_zk_mode else None,
            storage_tier="cache",
            file_metadata={"compressed": session.get("compress", False)},
            **zk_fields  # Add ZK fields if applicable
        )
    
    else:  # chunked
        combined_hash = hashlib.sha256("".join(session["hashes"]).encode()).hexdigest()

        file_obj = Object(
            id=file_id,
            user_id=current_user.id,
            folder_id=session.get("folder"),
            file_name=session["name"],
            file_size=session["size"],
            mime_type=mime_type,
            storage_type="chunked",
            content_hash=combined_hash,
            encryption_key=session.get("key") if not is_zk_mode else None,
            chunk_info={
                "chunks": session["hashes"],
                "count": session["chunks"],
                "paths": session.get("chunk_paths", {}),
                "upload_id": upload_id,
                "compressed": session.get("compress", False),
                "zk_mode": is_zk_mode  # Mark chunks as ZK-encrypted
            },
            storage_tier="cache",
            **zk_fields  # Add ZK fields if applicable
        )
    
    # Save to database with proper error handling
    try:
        db.add(file_obj)

        # Update user storage
        if hasattr(current_user, 'storage_used'):
            current_user.storage_used = (current_user.storage_used or 0) + session["size"]

        # Commit transaction
        await db.commit()

        # Create initial version (Version 1) for version history
        initial_version = FileVersion(
            file_id=file_id,
            version_number=1,
            file_size=session["size"],
            content_hash=file_obj.content_hash,
            storage_path=file_obj.object_path if storage_strategy in ["single"] else None,
            chunk_info=file_obj.chunk_info if storage_strategy == "chunked" else (
                {"storage_type": "inline"} if storage_strategy == "inline" else None
            ),
            created_by=current_user.id,
            comment="Initial upload",
        )
        db.add(initial_version)
        await db.commit()

        # Log activity (separate transaction)
        await log_activity(
            db, current_user.id, "file_uploaded", str(file_id),
            {
                "file_name": session["name"],
                "size": session["size"],
                "storage_type": storage_strategy,
                "compressed": session.get("compress", False)
            },
            request,
        )
    except Exception as e:
        # Rollback on any database error
        await db.rollback()
        logger.error(f"Upload completion failed for {session['name']}: {e}", exc_info=True)

        # Clean up uploaded files
        if storage_strategy == "single" and session.get("storage_path"):
            try:
                os.remove(session.get("storage_path"))
            except Exception as cleanup_error:
                logger.error(f"Failed to cleanup file: {cleanup_error}")

        raise HTTPException(status_code=500, detail=f"Failed to save file: {str(e)}")
    
    # ============ SMART DEDUPLICATION CLASSIFICATION ============
    # Classify file to determine optimal dedup strategy
    file_classification = None
    enable_dedup = False

    if storage_strategy in ["single", "chunked"] and session["size"] > 1_048_576:  # > 1MB
        try:
            # Get file path for classification
            file_path = session.get("storage_path") if storage_strategy == "single" else None

            # If chunked, we can't classify yet (no single file)
            # For now, only classify single files
            if file_path and os.path.exists(file_path):
                file_classification = await dedup_classifier.classify_file(
                    file_path=file_path,
                    file_size=session["size"],
                    filename=session["name"]
                )

                logger.info(
                    f"📊 Classification: {session['name']} → "
                    f"mode={file_classification.dedup_mode}, "
                    f"reason={file_classification.reason}, "
                    f"strategy={file_classification.chunk_strategy}"
                )

                # Store classification metadata in dedup_info
                file_obj.dedup_info = {
                    "classification_mode": file_classification.dedup_mode,
                    "classification_reason": file_classification.reason,
                    "classification_priority": file_classification.priority,
                    "chunk_strategy": file_classification.chunk_strategy,
                    "classified_at": datetime.utcnow().isoformat()
                }
                await db.commit()

                # Enable dedup only if not skipped
                enable_dedup = file_classification.dedup_mode in ['inline', 'async']
            else:
                # Fallback to old logic for chunked files
                enable_dedup = session["size"] > 10 * 1024 * 1024

        except Exception as e:
            logger.error(f"Classification failed for {session['name']}: {e}")
            # Fallback to old logic
            enable_dedup = session["size"] > 10 * 1024 * 1024

    if enable_dedup:
        priority = file_classification.priority if file_classification else 2
        print(
            f"📋 Queuing {session['name']} for background deduplication "
            f"(priority={priority}, reason={file_classification.reason if file_classification else 'size-based'})"
        )
        # Queue job without awaiting - fire and forget
        asyncio.create_task(
            background_dedup_service.enqueue_for_dedup(
                file_id=str(file_id),
                upload_id=upload_id,
                user_id=str(current_user.id),
                session_data=session,
                priority=priority  # Pass priority from classification
            )
        )
    elif file_classification and file_classification.dedup_mode == 'skip':
        logger.info(
            f"⏭️  Skipping dedup for {session['name']}: {file_classification.reason}"
        )

    # ============ SECURITY SCANNING (BACKGROUND) ============
    # Run virus scan and DLP scan in background
    asyncio.create_task(
        run_security_scans(
            file_id=file_id,
            user_id=current_user.id,
            file_name=session['name'],
            file_size=session['size'],
            mime_type=mime_type,
            storage_strategy=storage_strategy,
            file_obj=file_obj
        )
    )

    # ============ VIDEO OPTIMIZATION (BACKGROUND) ============
    # Run video faststart optimization for MOV/MP4 files (legacy single-file path)
    if storage_strategy == "single" and file_obj.object_path:
        asyncio.create_task(
            run_video_optimization(
                file_id=file_id,
                file_name=session['name'],
                file_path=file_obj.object_path,
                mime_type=mime_type,
                storage_strategy=storage_strategy
            )
        )

    # ============ PROACTIVE VIDEO TRANSCODING (BACKGROUND) ============
    # Queue video for proactive transcoding to ensure zero-latency playback
    # This replaces the reactive transcoding that occurred on playback
    is_video = mime_type and mime_type.startswith('video/')
    if is_video:
        try:
            producer = await get_kafka_producer()
            queue_result = await video_ingestion_service.on_upload_complete(
                file_id=str(file_id),
                user_id=str(current_user.id),
                file_name=session['name'],
                file_size=session['size'],
                mime_type=mime_type,
                kafka_producer=producer
            )

            if queue_result['queued']:
                # Update database status to 'queued'
                file_obj.video_processing_status = 'queued'
                await db.commit()
                logger.info(
                    f"Queued video for proactive optimization: {session['name']} "
                    f"({session['size'] / 1024 / 1024:.1f}MB)"
                )
            else:
                logger.info(
                    f"Video not queued for optimization: {session['name']} "
                    f"[reason={queue_result.get('reason', 'unknown')}]"
                )
        except Exception as e:
            logger.error(f"Failed to queue video for proactive optimization: {e}")
            # Non-fatal - video can still be transcoded on-demand

    # ============ VIDEO PREVIEW QUEUEING (BACKGROUND) ============
    # Queue large videos (>50MB) for background preview generation
    PREVIEW_QUEUE_THRESHOLD = 50 * 1024 * 1024  # 50MB
    is_video = mime_type and mime_type.startswith('video/')

    if is_video and session["size"] > PREVIEW_QUEUE_THRESHOLD:
        try:
            producer = await get_kafka_producer()
            if producer:
                await producer.send_and_wait(
                    'preview-processing',
                    {
                        'file_id': str(file_id),
                        'timestamp': datetime.utcnow().isoformat(),
                        'file_name': session['name'],
                        'file_size': session['size'],
                        'mime_type': mime_type,
                        'storage_type': storage_strategy
                    }
                )
                # Set initial status in Redis
                await redis_client.setex(
                    f'preview:status:{file_id}',
                    3600,  # 1 hour TTL
                    json.dumps({'status': 'queued', 'queued_at': datetime.utcnow().isoformat()})
                )
                logger.info(f"🎬 Queued video preview for background processing: {session['name']} ({session['size'] / 1024 / 1024:.1f}MB)")
            else:
                logger.warning(f"Kafka producer not available, skipping preview queue for {session['name']}")
        except Exception as e:
            logger.error(f"Failed to queue video preview for {session['name']}: {e}")
            # Non-fatal - preview can still be generated on-demand

    # ============ SEMANTIC EMBEDDING QUEUEING (BACKGROUND) ============
    # Queue file for semantic embedding generation (for AI-powered search)
    if settings.SEMANTIC_SEARCH_ENABLED:
        try:
            producer = await get_kafka_producer()
            if producer:
                await producer.send_and_wait(
                    'embedding-processing',
                    {
                        'file_id': str(file_id),
                        'user_id': str(current_user.id),
                        'timestamp': datetime.utcnow().isoformat(),
                        'file_name': session['name'],
                        'mime_type': mime_type,
                        'tags': session.get('tags', []),
                        'description': session.get('description', ''),
                        'ai_tags': []  # Will be populated by AI tagging service
                    }
                )
                logger.debug(f"🧠 Queued file for semantic embedding: {session['name']}")
        except Exception as e:
            logger.warning(f"Failed to queue embedding for {session['name']}: {e}")
            # Non-fatal - embedding can still be generated on-demand

    # ============ FILE ANALYSIS QUEUEING (BACKGROUND) ============
    # Queue file for AI analysis (OCR, metadata, auto-tagging)
    if settings.ML_FEATURES_ENABLED:
        try:
            producer = await get_kafka_producer()
            if producer:
                await producer.send_and_wait(
                    'file-analysis',
                    {
                        'file_id': str(file_id),
                        'user_id': str(current_user.id),
                        'timestamp': datetime.utcnow().isoformat(),
                        'file_name': session['name'],
                        'mime_type': mime_type,
                        'file_size': session['size']
                    }
                )
                logger.debug(f"🏷️ Queued file for AI analysis: {session['name']}")
        except Exception as e:
            logger.warning(f"Failed to queue analysis for {session['name']}: {e}")
            # Non-fatal - analysis can still be triggered manually

    # Index file in Elasticsearch (fire and forget)
    asyncio.create_task(
        search_service.index_file({
            'id': file_id,
            'name': session['name'],
            'original_name': session['name'],
            'mime_type': mime_type,
            'size': session['size'],
            'hash': file_obj.content_hash,
            'storage_tier': 'cache',
            'folder_id': session.get('folder'),
            'user_id': current_user.id,
            'created_at': datetime.utcnow(),
            'updated_at': datetime.utcnow()
        })
    )

    # Clean up Redis
    await redis_client.delete(f"up:{upload_id}")

    # Metrics
    duration = (datetime.utcnow() - start_time).total_seconds()
    upload_completed.labels(
        user_type=getattr(current_user, 'user_type', 'standard'),
        storage_strategy=storage_strategy,
        status="success"
    ).inc()
    upload_duration.labels(storage_strategy=storage_strategy).observe(duration)
    active_uploads.dec()

    throughput = (session["size"] / (1024 * 1024)) / duration if duration > 0 else 0

    return {
        "status": "success",
        "file_id": str(file_id),
        "file_name": session["name"],
        "file_size": session["size"],
        "storage_type": storage_strategy,
        "encrypted": True,
        "compressed": session.get("compress", False),
        "deduplication": {
            "enabled": enable_dedup,
            "status": "queued" if enable_dedup else "disabled"
        },
        "duration": round(duration, 2),
        "throughput_mbps": round(throughput, 2)
    }

@router.get("/download/{file_id}")
async def download_file(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Download and decrypt file with streaming"""
    # Get file metadata
    result = await db.execute(
        select(Object).where(Object.id == file_id)
    )
    file_obj = result.scalar_one_or_none()
    
    if not file_obj:
        raise HTTPException(404, "File not found")
    
    if file_obj.user_id != current_user.id:
        raise HTTPException(403, "Unauthorized")
    
    # Get encryption key
    file_key = encryption_service.decrypt_key(file_obj.encryption_key)
    
    # Check if file was compressed
    was_compressed = False
    if file_obj.metadata and isinstance(file_obj.metadata, dict):
        was_compressed = file_obj.metadata.get("compressed", False)
    elif file_obj.chunk_info and isinstance(file_obj.chunk_info, dict):
        was_compressed = file_obj.chunk_info.get("compressed", False)
    
    async def stream_file() -> AsyncGenerator[bytes, None]:
        """Stream file content in chunks"""
        if file_obj.storage_type == "inline":
            # Decrypt inline data
            encrypted_data = base64.b64decode(file_obj.storage_key)
            file_data = encryption_service.decrypt_file(encrypted_data, file_key)
            
            # Decompress if needed
            if was_compressed:
                from ..utils.compression import compressor
                file_data = compressor.decompress(file_data)
            
            yield file_data
        
        elif file_obj.storage_type == "single":
            # Read and decrypt single file
            if not os.path.exists(file_obj.object_path):
                raise HTTPException(404, "File data not found on disk")
            
            async with aiofiles.open(file_obj.object_path, 'rb') as f:
                encrypted_data = await f.read()
            
            file_data = encryption_service.decrypt_file(encrypted_data, file_key)
            
            # Decompress if needed
            if was_compressed:
                from ..utils.compression import compressor
                file_data = compressor.decompress(file_data)
            
            # Stream in chunks
            chunk_size = 8 * 1024 * 1024  # 8MB chunks
            for i in range(0, len(file_data), chunk_size):
                yield file_data[i:i+chunk_size]
        
        else:  # chunked, content_addressed, deduplicated_reference
            # Stream chunks sequentially
            chunk_info = file_obj.chunk_info
            upload_id = chunk_info.get("upload_id", str(file_obj.id))
            
            for i in range(chunk_info["count"]):
                chunk_path = chunk_info.get("paths", {}).get(str(i))
                
                if not chunk_path:
                    shard = upload_id[:2]
                    chunk_path = f"/app/storage/cache/{shard}/{upload_id}_chunk_{i}.enc"
                
                if not os.path.exists(chunk_path):
                    raise HTTPException(404, f"Chunk {i} not found")
                
                async with aiofiles.open(chunk_path, 'rb') as f:
                    encrypted_chunk = await f.read()
                
                # Decrypt chunk
                decrypted_chunk = encryption_service.decrypt_chunk(encrypted_chunk, file_key, i)
                
                # Decompress if needed
                if was_compressed:
                    from ..utils.compression import compressor
                    decrypted_chunk = compressor.decompress(decrypted_chunk)
                
                yield decrypted_chunk
    
    return StreamingResponse(
        stream_file(),
        media_type=file_obj.mime_type or 'application/octet-stream',
        headers={
            "Content-Disposition": f"attachment; filename={file_obj.file_name}"
        }
    )

@router.get("/resume/{upload_id}", response_model=UploadStatusResponse)
async def get_upload_status(
    upload_id: str,
    current_user: User = Depends(get_current_user)
):
    """Get upload status for resuming"""
    redis_client = await get_redis()
    
    session_data = await redis_client.get(f"up:{upload_id}")
    if not session_data:
        raise HTTPException(status_code=404, detail="Upload session not found")

    # Handle both bytes and string from Redis
    if isinstance(session_data, bytes):
        session_data = session_data.decode('utf-8')
    session = json.loads(session_data)
    if session["user"] != str(current_user.id):
        raise HTTPException(status_code=403, detail="Unauthorized")
    
    if session["strategy"] == "chunked":
        missing_chunks = set(range(session["chunks"])) - set(session["done"])
        progress = len(session["done"]) / session["chunks"] * 100 if session["chunks"] > 0 else 100
    else:
        missing_chunks = []
        progress = 100 if session.get("hash") else 0
    
    return UploadStatusResponse(
        upload_id=upload_id,
        file_name=session["name"],
        total_chunks=session["chunks"],
        uploaded_chunks=session["done"],
        missing_chunks=list(missing_chunks),
        progress=progress,
    )

@router.post("/test-speed")
async def test_speed(file: UploadFile = File(...)):
    """Test raw upload speed without any processing"""
    start = time.time()
    total = 0
    
    while content := await file.read(64 * 1024 * 1024):
        total += len(content)
    
    elapsed = time.time() - start
    speed_mbps = (total / (1024 * 1024)) / elapsed if elapsed > 0 else 0
    
    return {
        "size_mb": round(total / (1024 * 1024), 2),
        "time_seconds": round(elapsed, 2),
        "speed_mbps": round(speed_mbps, 2),
        "speed_gbps": round(speed_mbps * 8 / 1000, 2),
        "note": "Raw speed without any processing"
    }

@router.post("/test-speed-encrypted")
async def test_speed_encrypted(file: UploadFile = File(...)):
    """Test upload speed with encryption only"""
    start = time.time()
    total = 0
    file_key = encryption_service.generate_file_key()
    
    chunk_index = 0
    while content := await file.read(CHUNK_SIZE):
        # Encrypt chunk
        encrypted = encryption_service.encrypt_chunk(content, file_key, chunk_index)
        total += len(content)
        chunk_index += 1
    
    elapsed = time.time() - start
    speed_mbps = (total / (1024 * 1024)) / elapsed if elapsed > 0 else 0
    
    return {
        "size_mb": round(total / (1024 * 1024), 2),
        "time_seconds": round(elapsed, 2),
        "speed_mbps": round(speed_mbps, 2),
        "speed_gbps": round(speed_mbps * 8 / 1000, 2),
        "note": "Speed with AES-GCM encryption only (no compression)"
    }


# ============================================================================
# SECURITY SCANNING BACKGROUND TASK
# ============================================================================

async def run_security_scans(
    file_id: uuid.UUID,
    user_id: uuid.UUID,
    file_name: str,
    file_size: int,
    mime_type: str,
    storage_strategy: str,
    file_obj: Object
):
    """
    Run virus scan and DLP scan in background after file upload

    Args:
        file_id: ID of uploaded file
        user_id: User who uploaded file
        file_name: Name of file
        file_size: Size in bytes
        mime_type: MIME type
        storage_strategy: Storage strategy used
        file_obj: Database object
    """
    audit_service = get_audit_service()

    try:
        logger.info(f"🔒 Starting security scans for {file_name} ({file_id})")

        # Retrieve file data
        file_data = None
        try:
            # Decrypt the wrapped file key first
            file_key = encryption_service.decrypt_key(file_obj.encryption_key)

            if storage_strategy == "inline":
                # Decrypt inline data
                encrypted_data = base64.b64decode(file_obj.storage_key)
                file_data = encryption_service.decrypt_data(encrypted_data, file_key)
            elif storage_strategy == "single":
                # Read from file
                if file_obj.object_path and os.path.exists(file_obj.object_path):
                    async with aiofiles.open(file_obj.object_path, 'rb') as f:
                        encrypted_data = await f.read()
                    file_data = encryption_service.decrypt_data(encrypted_data, file_key)
            elif storage_strategy == "chunked":
                # For chunked files, reassemble chunks
                # Skip scanning very large chunked files to avoid memory issues
                if file_size > 100 * 1024 * 1024:  # Skip files > 100MB for now
                    logger.info(f"Skipping security scan for large chunked file: {file_name}")
                    return

        except Exception as e:
            logger.error(f"Failed to retrieve file data for scanning: {e}")
            return

        if not file_data:
            logger.warning(f"No file data available for security scanning: {file_name}")
            return

        # ============ VIRUS SCANNING ============
        try:
            # Skip virus scanning if disabled in config
            if not settings.VIRUS_SCANNING_ENABLED:
                logger.info("Virus scanning disabled in configuration, skipping...")
            else:
                virus_scanner = get_virus_scanner()

                # Check if ClamAV is available
                if await virus_scanner.ping():
                    scan_result = await virus_scanner.scan_bytes(file_data)

                    # Log virus scan result
                    await audit_service.log_virus_scan(
                        file_id=file_id,
                        user_id=user_id,
                        is_infected=scan_result.is_infected,
                        virus_name=scan_result.virus_name,
                        scan_time=scan_result.scan_time,
                        file_size=file_size,
                        file_hash=file_obj.content_hash,
                        error_message=scan_result.error,
                        action_taken='blocked' if scan_result.is_infected else 'allowed'
                    )

                    if scan_result.is_infected:
                        logger.critical(f"🚨 VIRUS DETECTED: {scan_result.virus_name} in {file_name}")

                        # Log suspicious activity
                        await audit_service.log_action(
                            action='security.virus_detected',
                            user_id=user_id,
                            resource_type='file',
                            resource_id=file_id,
                            resource_name=file_name,
                            status='blocked',
                            metadata={
                                'virus_name': scan_result.virus_name,
                                'file_size': file_size
                            },
                            is_suspicious=True,
                            risk_level='critical'
                        )

                        # TODO: Quarantine or delete infected file
                        # For now, just log it
                    else:
                        logger.info(f"✅ Virus scan clean: {file_name} ({scan_result.scan_time:.2f}s)")
                else:
                    logger.warning("ClamAV not available, skipping virus scan")

        except Exception as e:
            logger.error(f"Virus scan failed for {file_name}: {e}")

        # ============ DLP SCANNING ============
        # Only scan text-based files for DLP
        text_mime_types = [
            'text/', 'application/json', 'application/xml',
            'application/pdf', 'application/msword',
            'application/vnd.openxmlformats'
        ]

        should_dlp_scan = any(mime_type.startswith(mt) if mime_type else False for mt in text_mime_types)

        if should_dlp_scan:
            try:
                dlp_service = get_dlp_service()
                dlp_result = await dlp_service.scan_bytes(file_data, file_name)

                # Get detected types
                detected_types = list(set([m.type for m in dlp_result.matches]))

                # Log DLP scan result
                await audit_service.log_dlp_scan(
                    file_id=file_id,
                    user_id=user_id,
                    has_sensitive_data=dlp_result.has_sensitive_data,
                    risk_score=dlp_result.risk_score,
                    total_matches=dlp_result.total_matches,
                    scan_time=dlp_result.scan_time,
                    detected_types=detected_types,
                    file_size=file_size,
                    action_taken='flagged' if dlp_result.has_sensitive_data else 'allowed',
                    blocked=dlp_result.blocked
                )

                if dlp_result.has_sensitive_data:
                    logger.warning(
                        f"⚠️  Sensitive data detected in {file_name}: "
                        f"risk={dlp_result.risk_score:.1f}, types={detected_types}"
                    )

                    # Log if high risk
                    if dlp_result.risk_score > 50:
                        await audit_service.log_action(
                            action='security.sensitive_data_detected',
                            user_id=user_id,
                            resource_type='file',
                            resource_id=file_id,
                            resource_name=file_name,
                            status='flagged',
                            metadata={
                                'risk_score': dlp_result.risk_score,
                                'detected_types': detected_types,
                                'total_matches': dlp_result.total_matches
                            },
                            is_suspicious=dlp_result.risk_score > 70,
                            risk_level='high' if dlp_result.risk_score > 70 else 'medium'
                        )
                else:
                    logger.info(f"✅ DLP scan clean: {file_name} ({dlp_result.scan_time:.2f}s)")

            except Exception as e:
                logger.error(f"DLP scan failed for {file_name}: {e}")

        logger.info(f"🔒 Security scans completed for {file_name}")

    except Exception as e:
        logger.error(f"Security scanning failed for {file_name}: {e}", exc_info=True)


async def run_video_optimization(
    file_id: uuid.UUID,
    file_name: str,
    file_path: str,
    mime_type: str,
    storage_strategy: str
):
    """
    Run video optimization in background after file upload

    For MOV/MP4 files, applies faststart optimization to move moov atom
    to the beginning of the file for better streaming performance.

    Args:
        file_id: ID of uploaded file
        file_name: Name of file
        file_path: Path to video file
        mime_type: MIME type
        storage_strategy: Storage strategy used
    """
    try:
        # Only optimize video files
        if not mime_type or not mime_type.startswith('video/'):
            return

        # Only optimize MOV and MP4 files (most benefit from faststart)
        video_formats = ['video/quicktime', 'video/mp4', 'video/x-m4v']
        if mime_type not in video_formats:
            logger.debug(f"Skipping video optimization for {mime_type}")
            return

        # Only optimize single file storage (chunked files would need reassembly)
        if storage_strategy != "single":
            logger.debug(f"Skipping video optimization for {storage_strategy} storage")
            return

        # Verify file exists
        if not file_path or not os.path.exists(file_path):
            logger.warning(f"Video file path not found for optimization: {file_name}")
            return

        logger.info(f"🎬 Starting video optimization for {file_name} ({file_id})")

        # Run optimization
        result = await video_optimizer.optimize_video_for_streaming(
            file_path=file_path,
            replace_original=True
        )

        # Get new database session to update metadata
        from ..database import get_async_session
        async for db in get_async_session():
            try:
                # Re-query the file object
                result_query = await db.execute(
                    select(Object).where(Object.id == file_id)
                )
                file_obj = result_query.scalar_one_or_none()

                if not file_obj:
                    logger.warning(f"File not found in database for optimization update: {file_id}")
                    return

                # Update file metadata with optimization status
                if result['success'] and result['optimized']:
                    logger.info(f"✅ Video optimized successfully: {file_name}")

                    # Update file metadata in database
                    metadata = file_obj.file_metadata or {}
                    metadata.update({
                        'video_optimized': True,
                        'faststart_applied': True,
                        'moov_location': 'start',
                        'optimization_date': datetime.utcnow().isoformat(),
                        'original_moov_location': result['metadata'].get('moov_location', 'unknown')
                    })

                    file_obj.file_metadata = metadata

                    # Commit to database
                    await db.commit()

                    logger.info(f"🎬 Video optimization completed and metadata updated: {file_name}")

                elif result['success'] and not result['optimized']:
                    logger.info(f"ℹ️  Video already optimized: {file_name}")

                    # Still update metadata to mark as checked
                    metadata = file_obj.file_metadata or {}
                    metadata.update({
                        'video_optimized': True,
                        'faststart_applied': False,
                        'moov_location': result['metadata'].get('moov_location', 'start'),
                        'optimization_checked': datetime.utcnow().isoformat()
                    })

                    file_obj.file_metadata = metadata
                    await db.commit()

                else:
                    error_msg = result.get('error', 'Unknown error')
                    logger.error(f"❌ Video optimization failed for {file_name}: {error_msg}")

                    # Mark as failed in metadata
                    metadata = file_obj.file_metadata or {}
                    metadata.update({
                        'video_optimized': False,
                        'optimization_error': error_msg,
                        'optimization_attempted': datetime.utcnow().isoformat()
                    })

                    file_obj.file_metadata = metadata
                    await db.commit()

                break  # Exit the async for loop after processing

            except Exception as e:
                await db.rollback()
                logger.error(f"Failed to update video optimization metadata: {e}")
                raise

    except Exception as e:
        logger.error(f"Video optimization failed for {file_name}: {e}", exc_info=True)