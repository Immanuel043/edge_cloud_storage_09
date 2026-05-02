# services/storage-service/app/routers/upload.py

import asyncio
import base64
import hashlib
import io
import json
import logging
import mimetypes
import os
import tempfile
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from functools import partial
from typing import AsyncGenerator, Optional

import aiofiles
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Body,
    Depends,
    File,
    HTTPException,
    Request,
    Response,
    UploadFile,
)
from fastapi.responses import StreamingResponse
from sqlalchemy import and_, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import get_redis
from ..dependencies import get_current_user, get_db, get_plan_quota, log_activity
from ..models.database import FileVersion, Object, User
from ..utils.file_streaming import _read_all_bytes
from ..models.schemas import UploadInitResponse, UploadStatusResponse
from ..monitoring.metrics import (
    active_uploads,
    chunk_processing_duration,
    errors_total,
    upload_completed,
    upload_duration,
    upload_initiated,
)
from ..services.audit_logging_service import AuditEventType
from ..services.audit_logging_service import audit_service as audit_logging_service
from ..services.audit_service import get_audit_service
from ..services.auth import auth_service
from ..services.bandwidth_throttle import bandwidth_throttle_service
from ..services.dedup_classifier import dedup_classifier
from ..services.deduplication_enhanced import enhanced_dedup_service
from ..services.dlp_service import get_dlp_service
from ..services.encryption import encryption_service
from ..services.kafka_client import get_kafka_producer
from ..services.rust_dataplane_client import get_rust_client
from ..services.scan_streaming import iter_decrypted_chunks
from ..services.search_service import search_service
from ..services.storage import storage_service
from ..services.upload_session_store import (
    REDIS_TTL,
    delete_upload_session,
    get_upload_session,
    save_upload_session,
    update_upload_session_atomic,
)
from ..services.video_ingestion_service import video_ingestion_service
from ..services.video_optimizer import video_optimizer
from ..services.virus_scanner import VirusScanResult, get_virus_scanner
from ..utils.cache import cached
from ..utils.chunk_lifecycle import acquire_chunk_hold, release_chunk_hold
from ..utils.compression import compressor
from ..utils.rate_limiter_v2 import RateLimitConfig, create_rate_limiter
from .background_deduplication import background_dedup_service

router = APIRouter(prefix="/api/v1/upload", tags=["upload"])
logger = logging.getLogger(__name__)

# Rust data plane client (lazy initialization)
_rust_client_initialized = False
_rust_client_available = False

executor = ThreadPoolExecutor(max_workers=min(os.cpu_count() + 1, 32))  # CPU-bound encryption work

# Optimized buffer sizes
# Read from environment variables with fallbacks
STREAM_BUFFER_SIZE = int(os.getenv("STREAM_BUFFER_SIZE", 8 * 1024 * 1024))  # 8MB default
INLINE_THRESHOLD = int(os.getenv("INLINE_THRESHOLD", 512 * 1024))  # 512KB
SINGLE_OBJECT_THRESHOLD = int(os.getenv("SINGLE_OBJECT_THRESHOLD", 50 * 1024 * 1024))  # 50MB
CHUNK_SIZE = int(os.getenv("CHUNK_SIZE", 32 * 1024 * 1024))  # 32MB default - CRITICAL CHANGE

# Files that are already compressed - DO NOT compress these
COMPRESSED_FORMATS = {
    ".zip",
    ".gz",
    ".rar",
    ".7z",
    ".bz2",
    ".xz",
    ".jpg",
    ".jpeg",
    ".png",
    ".mp4",
    ".mp3",
    ".avi",
    ".mkv",
    ".mov",
    ".webm",
    ".flac",
    ".aac",
    ".ogg",
    ".pdf",
    ".docx",
    ".xlsx",
    ".pptx",
}  # Most modern formats are compressed

# Only compress these text-based formats
COMPRESSIBLE_FORMATS = {
    ".txt",
    ".log",
    ".csv",
    ".json",
    ".xml",
    ".sql",
    ".html",
    ".css",
    ".js",
    ".py",
    ".java",
    ".c",
    ".cpp",
}


def _cleanup_rust_chunk(file_id: str, chunk_index: int):
    """Clean up a chunk file written by Rust's storage path scheme.

    Rust writes to: {STORAGE_ROOT}/files/{file_id}/chunks/chunk-{index:010}.enc
    This removes the chunk and any empty parent directories left behind.
    """
    storage_root = settings.STORAGE_ROOT
    chunk_path = os.path.join(
        storage_root, "files", file_id, "chunks", f"chunk-{chunk_index:010}.enc"
    )
    try:
        if os.path.exists(chunk_path):
            os.remove(chunk_path)
            logger.debug(f"Cleaned up Rust chunk: {chunk_path}")
            # Remove empty parent dirs
            chunks_dir = os.path.dirname(chunk_path)
            if os.path.isdir(chunks_dir) and not os.listdir(chunks_dir):
                os.rmdir(chunks_dir)
                file_dir = os.path.dirname(chunks_dir)
                if os.path.isdir(file_dir) and not os.listdir(file_dir):
                    os.rmdir(file_dir)
    except OSError as e:
        logger.warning(f"Failed to clean up Rust chunk {chunk_path}: {e}")


def _cleanup_rust_file(file_id: str):
    """Clean up all chunks written by Rust for a given file_id.

    Removes the entire {STORAGE_ROOT}/files/{file_id}/ directory tree.
    """
    storage_root = settings.STORAGE_ROOT
    file_dir = os.path.join(storage_root, "files", file_id)
    try:
        if os.path.isdir(file_dir):
            import shutil

            shutil.rmtree(file_dir)
            logger.debug(f"Cleaned up Rust file directory: {file_dir}")
    except OSError as e:
        logger.warning(f"Failed to clean up Rust file directory {file_dir}: {e}")


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


async def get_user_storage_info_fast(user_id: str, db: AsyncSession, redis_client):
    """Lightweight storage check with Redis caching"""
    # Try cache first (30 second TTL)
    cache_key = f"quota:{user_id}"
    cached = await redis_client.get(cache_key)

    if cached:
        # Redis returns bytes, decode to string
        if isinstance(cached, bytes):
            cached = cached.decode("utf-8")
        return json.loads(cached)

    # Cache miss - query database
    result = await db.execute(
        select(User.storage_quota, User.storage_used).where(User.id == user_id)
    )
    data = result.first()

    if not data:
        storage_info = {"quota": 0, "used": 0}
    else:
        storage_info = {"quota": int(data.storage_quota or 0), "used": int(data.storage_used or 0)}

    # Cache for 30 seconds (fire-and-forget)
    asyncio.create_task(redis_client.setex(cache_key, 30, json.dumps(storage_info)))

    return storage_info


async def check_rust_availability():
    """
    Check if Rust data plane is available and healthy.
    Called once on first upload to determine availability.
    """
    global _rust_client_initialized, _rust_client_available

    if _rust_client_initialized:
        return _rust_client_available

    if not settings.RUST_DATAPLANE_ENABLED:
        logger.info("Rust data plane disabled by configuration")
        _rust_client_initialized = True
        _rust_client_available = False
        return False

    try:
        rust_client = get_rust_client(settings.RUST_DATAPLANE_SOCKET)
        await rust_client.health_check()
        logger.info("✅ Rust data plane is available and healthy")
        _rust_client_initialized = True
        _rust_client_available = True
        return True
    except Exception as e:
        logger.warning(f"⚠️ Rust data plane unavailable: {e}")
        if settings.RUST_DATAPLANE_FALLBACK_TO_PYTHON:
            logger.info("Falling back to Python processing")
        _rust_client_initialized = True
        _rust_client_available = False
        return False


def process_chunk_cpu_bound(
    chunk_data: bytes, file_key: bytes, chunk_index: int, compress: bool = False
):
    """
    CPU-intensive operations in thread pool (Python fallback).
    This is used when Rust data plane is unavailable.
    """
    # Hash calculation (before any processing)
    original_hash = hashlib.sha256(chunk_data).hexdigest()

    # Optional compression (only for compressible files)
    if compress:
        from ..utils.compression import compressor

        chunk_data = compressor.compress(chunk_data)

    # Encryption (AES-GCM is fast with hardware acceleration)
    encrypted_chunk = encryption_service.encrypt_chunk(chunk_data, file_key, chunk_index)

    return encrypted_chunk, original_hash


@router.post(
    "/init",
    response_model=UploadInitResponse,
    dependencies=[Depends(create_rate_limiter(**RateLimitConfig.FILE_UPLOAD))],
)
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

    # Check storage quota with atomic reservation to prevent TOCTOU race
    user_id_str = str(current_user.id)
    storage_info = await get_user_storage_info_fast(user_id_str, db, redis_client)
    if storage_info["used"] + file_size > storage_info["quota"]:
        raise HTTPException(status_code=413, detail="Storage quota exceeded")

    # Atomically reserve space in Redis to prevent concurrent uploads exceeding quota
    reserve_key = f"quota_reserved:{user_id_str}"
    pipe = redis_client.pipeline()
    pipe.incrby(reserve_key, file_size)
    pipe.expire(reserve_key, 86400)  # 24-hour TTL for cleanup
    results = await pipe.execute()
    reserved = results[0]
    if storage_info["used"] + reserved > storage_info["quota"]:
        # Over quota with reservation - undo and reject
        await redis_client.decrby(reserve_key, file_size)
        raise HTTPException(
            status_code=413, detail="Storage quota exceeded (concurrent upload limit)"
        )

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

    # Persist session state to Redis + DB fallback
    await save_upload_session(redis_client, db, upload_id, session_data)

    # Metrics
    upload_initiated.labels(
        plan_type=getattr(current_user, "plan_type", "free"), storage_strategy=storage_strategy
    ).inc()
    active_uploads.inc()

    print(
        f"📤 Upload initialized: {file_name} ({file_size/1024/1024:.1f}MB) - Compression: {use_compression}"
    )

    recommended_concurrency = await bandwidth_throttle_service.get_recommended_chunk_concurrency(
        str(current_user.id), current_user.plan_type or "free", current_user.max_concurrent_streams
    )

    # Fire-and-forget warmup to reduce Rust data plane cold-start penalty.
    # By the time the client sends the first chunk (~100-500ms), the warmup
    # will have primed memfd, SCM_RIGHTS, crypto, and socket paths.
    # check_rust_availability() is lazy-init (runs health check once), so call it
    # here to ensure _rust_client_available is set before the warmup guard.
    if storage_strategy == "chunked":
        await check_rust_availability()
    if storage_strategy == "chunked" and _rust_client_available:
        try:
            from ..services.rust_socket_client import get_rust_socket_client

            client = get_rust_socket_client(settings.RUST_DATAPLANE_SOCKET)
            asyncio.create_task(client.warmup())
        except Exception:
            pass  # Non-fatal

    return UploadInitResponse(
        upload_id=upload_id,
        storage_strategy=storage_strategy,
        chunk_size=CHUNK_SIZE if storage_strategy == "chunked" else 0,
        total_chunks=total_chunks,
        direct_upload=storage_strategy != "chunked",
        recommended_concurrency=recommended_concurrency,
    )


# ---------------------------------------------------------------------------
# LEGACY ZK: Zero-Knowledge uploads are handled by zk-encryption-service.
# This endpoint is deprecated (410 Gone). Kept only to redirect legacy clients.
# ---------------------------------------------------------------------------
@router.post("/init/zk")
async def init_zk_upload(current_user: User = Depends(get_current_user)):
    """
    Zero-Knowledge uploads are now handled by the dedicated ZK Private Vault service.

    This endpoint has been deprecated. Please use the ZK service at port 8002.
    """
    raise HTTPException(
        status_code=410,  # Gone - indicates resource moved permanently
        detail="Zero-Knowledge uploads have moved to the ZK Private Vault service. Please use the ZK service API.",
        headers={"X-ZK-Service-URL": "http://localhost:8002/api/v1/zk"},
    )


@router.post(
    "/chunk/{upload_id}",
    dependencies=[Depends(create_rate_limiter(**RateLimitConfig.CHUNK_UPLOAD))],
)
async def upload_chunk(
    upload_id: str,
    chunk_index: int,
    request: Request,
    chunk: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Optimized chunk upload with smart compression and bandwidth throttling (plan-aware)"""
    redis_client = await get_redis()
    user_id_str = str(current_user.id)
    stream_slot_released = False  # Track if stream slot was already released
    t_total = time.monotonic()
    processing_mode = "unknown"

    # Pipeline independent Redis calls concurrently
    max_streams, stream_acquired, session = await asyncio.gather(
        bandwidth_throttle_service.get_max_streams_with_plan(
            user_id_str, current_user.plan_type, current_user.max_concurrent_streams
        ),
        bandwidth_throttle_service.acquire_stream_slot(
            user_id_str,
            plan_type=current_user.plan_type,
            db_streams_override=current_user.max_concurrent_streams,
        ),
        get_upload_session(redis_client, db, upload_id),
    )
    t_redis = time.monotonic()

    if not stream_acquired:
        raise HTTPException(
            status_code=429,
            detail=f"Too many concurrent uploads. Maximum {max_streams} streams allowed for your plan.",
            headers={"Retry-After": "10"},
        )

    try:
        # Bandwidth note: token-bucket throttle removed from chunk upload path.
        # The HTTP body is already received before this handler runs, so sleeping
        # only delays server processing without rate-limiting network bandwidth.
        # Concurrency is enforced by stream slots (above). Token-bucket throttling
        # remains active on streaming download paths (throttled_transfer).

        if not session:
            raise HTTPException(status_code=404, detail="Upload session not found")

        if session["user"] != str(current_user.id):
            raise HTTPException(status_code=403, detail="Unauthorized")

        # Validate chunk_index is within bounds
        if chunk_index < 0 or chunk_index >= session["chunks"]:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid chunk_index {chunk_index}, must be 0-{session['chunks']-1}",
            )

        if chunk_index in session["done"]:
            return {"status": "already_uploaded", "chunk_index": chunk_index}
        t_throttle = time.monotonic()

        # Prepare storage path
        storage_tier = "cache"
        shard = f"{upload_id[:2]}"
        storage_dir = f"/app/storage/{storage_tier}/{shard}"

        # Non-blocking directory creation
        await asyncio.to_thread(os.makedirs, storage_dir, exist_ok=True)
        storage_path = f"{storage_dir}/{upload_id}_chunk_{chunk_index}.enc"

        # Read chunk data
        chunk_data = await chunk.read()
        t_read = time.monotonic()
        chunk_len = len(chunk_data)

        # LEGACY ZK: Defensive reject - ZK uploads must use zk-encryption-service.
        if session.get("zk_mode", False):
            raise HTTPException(
                status_code=400,
                detail="Zero-Knowledge uploads are handled by the ZK Private Vault service.",
            )

        # Server-side encryption
        file_key = encryption_service.decrypt_key(session["key"])
        t_decrypt = time.monotonic()

        # Check Rust availability (cached after first call)
        use_compression = session.get("compress", False)
        rust_available = await check_rust_availability()

        # Process chunk via Rust or Python
        if rust_available:
            try:
                # Choose Rust mode based on configuration
                rust_mode = settings.RUST_DATAPLANE_MODE

                if rust_mode == "full":
                    # Full Rust processing: hash → compress → encrypt (requires SCM_RIGHTS)
                    from ..services.rust_socket_client import get_rust_socket_client

                    logger.debug(
                        f"Using full Rust processing (Non-ZK mode) for chunk {chunk_index}"
                    )
                    rust_socket_client = get_rust_socket_client(settings.RUST_DATAPLANE_SOCKET)

                    result = await rust_socket_client.process_non_zk_with_scm_rights(
                        chunk_data=chunk_data,
                        file_key=file_key,
                        file_id=upload_id,
                        chunk_index=chunk_index,
                        compress=use_compression,
                        filename=session.get("filename"),
                        file_size=session.get("size"),
                        target_path=storage_path,
                    )

                    chunk_hash = result.get("hash", "").replace("sha256:", "")

                    # Rust wrote directly to storage_path (zero-copy).
                    # Verify it landed; fall back to copy only if paths diverge.
                    encrypted_path = result.get("encrypted_chunk_path")
                    if encrypted_path and encrypted_path == storage_path:
                        # Zero-copy: Rust wrote directly — nothing to copy or clean up
                        if not await asyncio.to_thread(os.path.exists, storage_path):
                            raise Exception(
                                f"Rust reported success but chunk missing at {storage_path}"
                            )
                    elif encrypted_path and await asyncio.to_thread(os.path.exists, encrypted_path):
                        # Defensive fallback: paths differ — copy and clean up
                        logger.warning(
                            f"target_path mismatch: expected {storage_path}, got {encrypted_path}; copying"
                        )
                        async with aiofiles.open(encrypted_path, "rb") as src:
                            encrypted_chunk = await src.read()
                        async with aiofiles.open(
                            storage_path, "wb", buffering=STREAM_BUFFER_SIZE
                        ) as f:
                            await f.write(encrypted_chunk)
                        _cleanup_rust_chunk(upload_id, chunk_index)
                    else:
                        raise Exception(f"Rust encrypted chunk not found at {encrypted_path}")

                    logger.info(
                        f"Chunk {chunk_index} processed fully via Rust (zero-copy direct write)"
                    )
                    t_process = time.monotonic()
                    processing_mode = "rust-full"

                else:  # hybrid mode (default)
                    # Hybrid: Rust does hashing, Python does encryption
                    rust_client = get_rust_client(settings.RUST_DATAPLANE_SOCKET)

                    logger.debug(
                        f"Using hybrid Rust processing (hash-only) for chunk {chunk_index}"
                    )
                    result = await rust_client.process_hash_only(
                        chunk_data=chunk_data,
                        file_id=upload_id,
                        chunk_index=chunk_index,
                    )

                    chunk_hash = result.get("hash", "").replace("sha256:", "")

                    # Python still does encryption after Rust hashing
                    from ..utils.compression import compressor

                    if use_compression:
                        chunk_data = compressor.compress(chunk_data)
                    encrypted_chunk = encryption_service.encrypt_chunk(
                        chunk_data, file_key, chunk_index
                    )

                    # Write encrypted data
                    async with aiofiles.open(storage_path, "wb", buffering=STREAM_BUFFER_SIZE) as f:
                        await f.write(encrypted_chunk)

                    logger.debug(
                        f"Chunk {chunk_index} processed via Rust (hash) + Python (compress + encrypt)"
                    )
                    t_process = time.monotonic()
                    processing_mode = "hybrid"

            except Exception as e:
                logger.warning(f"Rust processing failed for chunk {chunk_index}: {e}")

                # Clean up any Rust-written chunk files from this failed attempt
                if rust_mode == "full":
                    _cleanup_rust_chunk(upload_id, chunk_index)

                if not settings.RUST_DATAPLANE_FALLBACK_TO_PYTHON:
                    raise HTTPException(status_code=500, detail="Chunk processing failed")

                # Fallback to Python processing
                logger.info("Falling back to Python processing")
                rust_available = False
                # Continue to Python processing below

        if not rust_available:
            # Python processing (original code path)
            loop = asyncio.get_event_loop()

            encrypted_chunk, chunk_hash = await loop.run_in_executor(
                executor,
                partial(
                    process_chunk_cpu_bound, chunk_data, file_key, chunk_index, use_compression
                ),
            )

            # Write encrypted data asynchronously with larger buffer
            async with aiofiles.open(storage_path, "wb", buffering=STREAM_BUFFER_SIZE) as f:
                await f.write(encrypted_chunk)
            t_process = time.monotonic()
            processing_mode = "python"

        # Atomically update session via Redis Lua script (single round-trip, no races)
        session = await update_upload_session_atomic(
            redis_client,
            db,
            upload_id,
            chunk_index=chunk_index,
            chunk_hash=chunk_hash,
            storage_path=storage_path,
        )
        t_session = time.monotonic()

        # Diagnostic timing summary (grep for "chunk-timing:")
        logger.info(
            f"chunk-timing: chunk={chunk_index}/{session['chunks']} "
            f"size={chunk_len / (1024*1024):.1f}MB mode={processing_mode} "
            f"total={(t_session - t_total)*1000:.0f}ms "
            f"redis={(t_redis - t_total)*1000:.0f}ms "
            f"throttle={(t_throttle - t_redis)*1000:.0f}ms "
            f"read={(t_read - t_throttle)*1000:.0f}ms "
            f"decrypt={(t_decrypt - t_read)*1000:.0f}ms "
            f"process={(t_process - t_decrypt)*1000:.0f}ms "
            f"session={(t_session - t_process)*1000:.0f}ms"
        )
        chunk_processing_duration.observe(t_session - t_total)

        progress = len(session["done"]) / session["chunks"] * 100 if session["chunks"] > 0 else 100

        return {
            "status": "success",
            "chunk_index": chunk_index,
            "progress": round(progress, 1),
            "encrypted": True,
            "compressed": session.get("compress", False),
        }

    finally:
        # ============ BANDWIDTH THROTTLING: Release stream slot (if not already released) ============
        if not stream_slot_released:
            await bandwidth_throttle_service.release_stream_slot(user_id_str)


@router.post(
    "/direct/{upload_id}",
    dependencies=[Depends(create_rate_limiter(**RateLimitConfig.FILE_UPLOAD))],
)
async def upload_direct(
    upload_id: str,
    request: Request,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Direct upload for small and medium files with optimized processing and bandwidth throttling (plan-aware)"""
    redis_client = await get_redis()
    user_id_str = str(current_user.id)
    stream_slot_released = False  # Track if stream slot was already released

    # Get max streams for this user's plan (or override)
    max_streams = await bandwidth_throttle_service.get_max_streams_with_plan(
        user_id_str, current_user.plan_type, current_user.max_concurrent_streams
    )

    # ============ BANDWIDTH THROTTLING: Acquire stream slot (plan-aware) ============
    stream_acquired = await bandwidth_throttle_service.acquire_stream_slot(
        user_id_str,
        plan_type=current_user.plan_type,
        db_streams_override=current_user.max_concurrent_streams,
    )
    if not stream_acquired:
        raise HTTPException(
            status_code=429,
            detail=f"Too many concurrent uploads. Maximum {max_streams} streams allowed for your plan.",
            headers={"Retry-After": "10"},
        )

    try:
        # ============ BANDWIDTH THROTTLING: Check bandwidth limit (plan-aware) ============
        file_size = int(request.headers.get("content-length", 0))
        if file_size > 0:
            # Cap pre-check to STREAM_BUFFER_SIZE — the actual transfer is
            # throttled chunk-by-chunk, so we only gate on a reasonable slice.
            check_size = min(file_size, STREAM_BUFFER_SIZE)
            allowed, wait_time = await bandwidth_throttle_service.can_transfer(
                user_id_str,
                check_size,
                plan_type=current_user.plan_type,
                db_bandwidth_override=current_user.bandwidth_limit_mbps,
            )
            if not allowed:
                wait_threshold = bandwidth_throttle_service.get_wait_threshold(
                    current_user.plan_type
                )
                if wait_time > wait_threshold:
                    bandwidth_mbps = current_user.bandwidth_limit_mbps or 5

                    await bandwidth_throttle_service.release_stream_slot(user_id_str)
                    stream_slot_released = True  # Mark as released to prevent double-release
                    raise HTTPException(
                        status_code=429,
                        detail=f"Bandwidth limit exceeded ({bandwidth_mbps} Mbps for {current_user.plan_type} plan). Please wait {int(wait_time)} seconds.",
                        headers={"Retry-After": str(int(wait_time))},
                    )
                await asyncio.sleep(min(wait_time, 1.0))

        session = await get_upload_session(redis_client, db, upload_id)
        if not session:
            raise HTTPException(status_code=404, detail="Upload session not found")

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

            async with aiofiles.open(storage_path, "wb", buffering=STREAM_BUFFER_SIZE) as f:
                await f.write(encrypted_data)

            session["storage_path"] = storage_path
            session["storage_type"] = "single"

        session["hash"] = file_hash

        await redis_client.setex(f"up:{upload_id}", REDIS_TTL, json.dumps(session))

        # Fire-and-forget: generate previews from plaintext still in memory
        from ..services.preview_service import preview_service

        asyncio.create_task(
            preview_service.generate_from_plaintext(
                file_id=str(session["id"]),
                plaintext_data=file_data,
                mime_type=session.get("mime_type") or mimetypes.guess_type(session["name"])[0],
                file_name=session["name"],
                redis_client=redis_client,
                content_hash=file_hash,
            )
        )

        return {
            "status": "success",
            "upload_id": upload_id,
            "encrypted": True,
            "compressed": use_compression,
            "ready_for_completion": True,
        }

    finally:
        # ============ BANDWIDTH THROTTLING: Release stream slot (if not already released) ============
        if not stream_slot_released:
            await bandwidth_throttle_service.release_stream_slot(user_id_str)


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

    session = await get_upload_session(redis_client, db, upload_id)
    if not session:
        raise HTTPException(status_code=404, detail="Upload session not found or expired")

    # Verify ownership
    if session["user"] != str(current_user.id):
        raise HTTPException(status_code=403, detail="Unauthorized")

    # Calculate missing chunks
    storage_strategy = session.get("strategy", "chunked")
    recommended_concurrency = await bandwidth_throttle_service.get_recommended_chunk_concurrency(
        str(current_user.id), current_user.plan_type or "free", current_user.max_concurrent_streams
    )

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
            "chunk_size": CHUNK_SIZE,
            "total_chunks": total_chunks,
            "uploaded_chunks": sorted(list(uploaded_chunks)),
            "missing_chunks": missing_chunks,
            "progress": round(progress, 2),
            "started_at": session.get("start"),
            "recommended_concurrency": recommended_concurrency,
        }
    else:
        # Direct upload
        return {
            "upload_id": upload_id,
            "status": "ready_for_completion" if session.get("hash") else "waiting_for_upload",
            "strategy": storage_strategy,
            "file_name": session["name"],
            "file_size": session["size"],
            "chunk_size": 0,
            "total_chunks": total_chunks if storage_strategy == "chunked" else 0,
            "uploaded_chunks": [],
            "missing_chunks": [],
            "progress": 100 if session.get("hash") else 0,
            "started_at": session.get("start"),
            "recommended_concurrency": recommended_concurrency,
        }


@router.delete("/cancel/{upload_id}")
async def cancel_upload(
    upload_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Cancel an in-progress upload and clean up server-side resources.

    - Deletes chunk files from disk
    - Releases reserved quota
    - Removes upload session from Redis and DB
    """
    redis_client = await get_redis()

    session = await get_upload_session(redis_client, db, upload_id)
    if not session:
        # Already cleaned up or never existed — treat as success
        return {"status": "cancelled", "chunks_deleted": 0, "bytes_freed": 0}

    # Verify ownership
    if session["user"] != str(current_user.id):
        raise HTTPException(status_code=403, detail="Unauthorized")

    chunks_deleted = 0
    bytes_freed = session.get("size", 0)

    # Delete chunk files from disk
    for chunk_path in session.get("chunk_paths", []):
        try:
            if os.path.exists(chunk_path):
                os.remove(chunk_path)
                chunks_deleted += 1
        except OSError as e:
            logger.warning(f"Failed to delete chunk {chunk_path}: {e}")

    # Delete single/inline storage file
    storage_path = session.get("storage_path")
    if storage_path:
        try:
            if os.path.exists(storage_path):
                os.remove(storage_path)
                chunks_deleted += 1
        except OSError as e:
            logger.warning(f"Failed to delete storage file {storage_path}: {e}")

    # Release reserved quota
    try:
        await redis_client.decrby(f"quota_reserved:{current_user.id}", session.get("size", 0))
    except Exception as e:
        logger.warning(f"Failed to release quota for upload {upload_id}: {e}")

    # Delete session
    await delete_upload_session(redis_client, db, upload_id)

    # Decrement active uploads metric
    active_uploads.dec()

    logger.info(
        f"Upload cancelled: {upload_id}, {chunks_deleted} chunks deleted, {bytes_freed} bytes freed"
    )

    return {
        "status": "cancelled",
        "chunks_deleted": chunks_deleted,
        "bytes_freed": bytes_freed,
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

    session = await get_upload_session(redis_client, db, upload_id)
    if not session:
        raise HTTPException(status_code=404, detail="Upload session not found")

    if session["user"] != str(current_user.id):
        raise HTTPException(status_code=403, detail="Unauthorized")

    storage_strategy = session.get("strategy", "chunked")
    start_time = datetime.fromisoformat(session["start"])

    # Verify upload completion
    if storage_strategy == "chunked":
        done_set = set(session["done"])
        if len(done_set) != session["chunks"]:
            missing = set(range(session["chunks"])) - done_set
            return {"status": "incomplete", "missing_chunks": list(missing)}

    file_id = uuid.uuid4()
    mime_type = session.get("mime_type") or mimetypes.guess_type(session["name"])[0]

    # Check if this is a ZK upload - ZK is now a completely separate service
    is_zk_mode = session.get("zk_mode", False)

    if is_zk_mode:
        # ZK uploads should go to the dedicated ZK service (vault.yourservice.com)
        raise HTTPException(
            status_code=400,
            detail="Zero-Knowledge uploads are handled by the ZK Private Vault service. "
            "Please use vault.yourservice.com for encrypted storage.",
        )

    # ============ QUOTA ENFORCEMENT ============
    # Self-heal quota from plan before locked read
    await get_plan_quota(current_user, db)

    # Lock user row and check quota atomically to prevent TOCTOU race
    file_size = session["size"]
    user_row = (
        await db.execute(
            select(User.storage_used, User.storage_quota)
            .where(User.id == current_user.id)
            .with_for_update()
        )
    ).first()

    storage_used = user_row.storage_used or 0
    storage_quota = user_row.storage_quota or 0

    if storage_used + file_size > storage_quota:
        raise HTTPException(
            status_code=413,
            detail=f"Storage quota exceeded. Used: {storage_used / (1024**3):.2f} GB, "
            f"Limit: {storage_quota / (1024**3):.2f} GB, "
            f"File size: {file_size / (1024**2):.2f} MB",
        )

    # ============ IDEMPOTENCY CHECK ============
    # Check if this upload_id was already completed to prevent duplicates
    if storage_strategy == "chunked":
        # For chunked uploads, check by upload_id in chunk_info
        existing_file_query = await db.execute(
            select(Object).where(
                and_(
                    Object.chunk_info.op("->>")("upload_id") == upload_id,
                    Object.user_id == current_user.id,
                )
            )
        )
        existing_file = existing_file_query.scalar_one_or_none()

        if existing_file:
            logger.info(
                f"✓ Upload {upload_id} already completed for file {existing_file.id} "
                f"({existing_file.file_name}). Returning existing file (idempotent)."
            )
            # Clean up session from Redis + DB
            await delete_upload_session(redis_client, db, upload_id)

            return {
                "file_id": str(existing_file.id),
                "file_name": existing_file.file_name,
                "size": existing_file.file_size,
                "storage_type": existing_file.storage_type,
                "mime_type": existing_file.mime_type,
                "created_at": existing_file.created_at.isoformat(),
                "status": "completed",
                "already_exists": True,  # Flag for client
            }

    # Build file metadata
    file_metadata_dict = {"compressed": session.get("compress", False)}

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
            encryption_key=session.get("key"),
            encryption_mode="aes-gcm" if session.get("key") else "none",
            storage_tier="cache",
            file_metadata=file_metadata_dict,
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
            encryption_key=session.get("key"),
            encryption_mode="aes-gcm" if session.get("key") else "none",
            storage_tier="cache",
            file_metadata=file_metadata_dict,
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
            encryption_key=session.get("key"),
            encryption_mode="aes-gcm" if session.get("key") else "none",
            chunk_info={
                "chunks": session["hashes"],
                "count": session["chunks"],
                "paths": session.get("chunk_paths", {}),
                "upload_id": upload_id,
                "compressed": session.get("compress", False),
                "chunk_size": CHUNK_SIZE,  # Store chunk size for download
            },
            storage_tier="cache",
            file_metadata=file_metadata_dict,
        )

    # Save to database with proper error handling
    try:
        db.add(file_obj)

        # Atomic increment of storage_used within the same transaction
        await db.execute(
            update(User)
            .where(User.id == current_user.id)
            .values(storage_used=User.storage_used + session["size"])
        )

        # Release quota reservation (actual usage is now tracked in DB)
        try:
            await redis_client.decrby(f"quota_reserved:{current_user.id}", session["size"])
        except Exception:
            pass  # Non-critical

        # Commit transaction
        await db.commit()

        # Invalidate cached quota so subsequent checks see fresh values
        try:
            await redis_client.delete(f"quota:{str(current_user.id)}")
        except Exception:
            pass

        # Create initial version (Version 1) for version history
        initial_version = FileVersion(
            file_id=file_id,
            version_number=1,
            file_size=session["size"],
            content_hash=file_obj.content_hash,
            storage_path=file_obj.object_path if storage_strategy in ["single"] else None,
            chunk_info=(
                file_obj.chunk_info
                if storage_strategy == "chunked"
                else ({"storage_type": "inline"} if storage_strategy == "inline" else None)
            ),
            created_by=current_user.id,
            comment="Initial upload",
        )
        db.add(initial_version)
        await db.commit()

        # Log activity (separate transaction)
        await log_activity(
            db,
            current_user.id,
            "file_uploaded",
            str(file_id),
            {
                "file_name": session["name"],
                "size": session["size"],
                "storage_type": storage_strategy,
                "compressed": session.get("compress", False),
            },
            request,
        )

        # Audit log (best-effort)
        try:
            await audit_logging_service.log_event(
                db,
                AuditEventType.FILE_UPLOADED,
                user_id=current_user.id,
                resource_type="file",
                resource_id=str(file_id),
                action="upload",
                request=request,
                details={"file_name": session["name"], "size": session["size"]},
            )
        except Exception:
            try:
                await db.rollback()
            except Exception:
                pass

        # Notify connected WebSocket clients via Redis Pub/Sub
        try:
            await redis_client.publish(
                "file_notifications",
                json.dumps(
                    {
                        "event": "file_created",
                        "user_id": str(current_user.id),
                        "file_id": str(file_id),
                        "file_name": session["name"],
                        "file_size": session["size"],
                        "mime_type": mime_type,
                        "folder_id": session.get("folder"),
                        "storage_type": storage_strategy,
                    }
                ),
            )
        except Exception:
            pass
    except Exception as e:
        # Rollback on any database error
        await db.rollback()
        logger.error(f"Upload completion failed for {session['name']}: {e}", exc_info=True)

        # Release quota reservation that would otherwise leak until TTL
        try:
            await redis_client.decrby(f"quota_reserved:{current_user.id}", session["size"])
        except Exception:
            pass

        # Clean up uploaded files
        if storage_strategy == "single" and session.get("storage_path"):
            try:
                os.remove(session.get("storage_path"))
            except Exception as cleanup_error:
                logger.error(f"Failed to cleanup file: {cleanup_error}")

        # Clean up Rust-written chunks if full Rust mode was used
        if settings.RUST_DATAPLANE_ENABLED and settings.RUST_DATAPLANE_MODE == "full":
            _cleanup_rust_file(upload_id)

        raise HTTPException(status_code=500, detail=f"Failed to save file: {str(e)}")

    # ============ NON-CRITICAL POST-UPLOAD WORK (BACKGROUND) ============
    # Dedup classification, security scanning, video optimization, Kafka sends,
    # preview generation, embedding, file analysis, and ES indexing all run in a
    # single background task so the /complete response returns immediately.
    asyncio.create_task(
        _run_post_upload_tasks(
            file_id=file_id,
            upload_id=upload_id,
            user_id=current_user.id,
            file_name=session["name"],
            file_size=session["size"],
            mime_type=mime_type,
            storage_strategy=storage_strategy,
            session_data=session,
            file_obj=file_obj,
            redis_client=redis_client,
            content_hash=file_obj.content_hash,
            object_path=file_obj.object_path if storage_strategy == "single" else None,
        )
    )

    # Clean up session from Redis + DB
    await delete_upload_session(redis_client, db, upload_id)

    # Metrics
    duration = (datetime.utcnow() - start_time).total_seconds()
    upload_completed.labels(
        plan_type=getattr(current_user, "plan_type", "free"),
        storage_strategy=storage_strategy,
        status="success",
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
        "deduplication": {"status": "pending"},
        "duration": round(duration, 2),
        "throughput_mbps": round(throughput, 2),
    }


@router.get("/download/{file_id}")
async def download_file(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Download and decrypt file with streaming"""
    # Get file metadata
    result = await db.execute(select(Object).where(Object.id == file_id))
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

            # Sync open via to_thread — async-with inside this streaming
            # generator races with PEP 525 cleanup on client disconnect.
            encrypted_data = await asyncio.to_thread(_read_all_bytes, file_obj.object_path)

            file_data = encryption_service.decrypt_file(encrypted_data, file_key)

            # Decompress if needed
            if was_compressed:
                from ..utils.compression import compressor

                file_data = compressor.decompress(file_data)

            # Stream in chunks
            chunk_size = 8 * 1024 * 1024  # 8MB chunks
            for i in range(0, len(file_data), chunk_size):
                yield file_data[i : i + chunk_size]

        else:  # chunked, content_addressed
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

                # Sync open via to_thread — see comment above.
                encrypted_chunk = await asyncio.to_thread(_read_all_bytes, chunk_path)

                # Decrypt chunk
                decrypted_chunk = encryption_service.decrypt_chunk(encrypted_chunk, file_key, i)

                # Decompress if needed
                if was_compressed:
                    from ..utils.compression import compressor

                    decrypted_chunk = compressor.decompress(decrypted_chunk)

                yield decrypted_chunk

    return StreamingResponse(
        stream_file(),
        media_type=file_obj.mime_type or "application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename={file_obj.file_name}"},
    )


@router.get("/resume/{upload_id}", response_model=UploadStatusResponse)
async def get_upload_status(
    upload_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get upload status for resuming"""
    redis_client = await get_redis()

    session = await get_upload_session(redis_client, db, upload_id)
    if not session:
        raise HTTPException(status_code=404, detail="Upload session not found")

    if session["user"] != str(current_user.id):
        raise HTTPException(status_code=403, detail="Unauthorized")

    if session["strategy"] == "chunked":
        missing_chunks = set(range(session["chunks"])) - set(session["done"])
        progress = len(session["done"]) / session["chunks"] * 100 if session["chunks"] > 0 else 100
    else:
        missing_chunks = []
        progress = 100 if session.get("hash") else 0

    recommended_concurrency = await bandwidth_throttle_service.get_recommended_chunk_concurrency(
        str(current_user.id), current_user.plan_type or "free", current_user.max_concurrent_streams
    )

    return UploadStatusResponse(
        upload_id=upload_id,
        file_name=session["name"],
        file_size=session.get("size"),
        chunk_size=CHUNK_SIZE if session["strategy"] == "chunked" else 0,
        total_chunks=session["chunks"],
        uploaded_chunks=session["done"],
        missing_chunks=list(missing_chunks),
        progress=progress,
        recommended_concurrency=recommended_concurrency,
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
        "note": "Raw speed without any processing",
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
        "note": "Speed with AES-GCM encryption only (no compression)",
    }


# ============================================================================
# SECURITY SCANNING BACKGROUND TASK
# ============================================================================


async def _reassemble_chunked_file_for_scan(
    file_obj: Object, file_key: bytes, max_bytes: int
) -> str:
    """Sequentially decrypt (+ decompress) chunks into a temp plaintext file.

    Raises on any missing/corrupt chunk — never returns a partial file. Caller
    MUST unlink the returned path in a finally block.

    `max_bytes` is enforced inside the helper as defense-in-depth: every caller
    must pass an explicit cap so a future caller can't accidentally reassemble
    multi-GB files into temp space. Raises ValueError before any IO if the
    file's declared size exceeds the cap.
    """
    if file_obj.file_size is not None and file_obj.file_size > max_bytes:
        raise ValueError(
            f"File {file_obj.id} size {file_obj.file_size} exceeds reassembly cap {max_bytes}"
        )

    chunk_info = file_obj.chunk_info or {}
    paths = chunk_info.get("paths") or {}
    count = int(chunk_info.get("count") or 0)
    compressed = bool(chunk_info.get("compressed"))
    upload_id = chunk_info.get("upload_id") or str(file_obj.id)
    if count <= 0:
        raise ValueError(f"Invalid chunk_info for file {file_obj.id}")

    os.makedirs(settings.TEMP_PATH, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        prefix=f"scan_{file_obj.id}_", suffix=".bin", dir=settings.TEMP_PATH
    )
    os.close(fd)

    try:
        async with aiofiles.open(tmp_path, "wb") as out:
            for i in range(count):
                chunk_path = paths.get(str(i))
                if not chunk_path or not os.path.exists(chunk_path):
                    shard = upload_id[:2]
                    chunk_path = f"/app/storage/cache/{shard}/{upload_id}_chunk_{i}.enc"
                if not os.path.exists(chunk_path):
                    raise FileNotFoundError(
                        f"Missing chunk {i} for file {file_obj.id} at {chunk_path!r}"
                    )
                async with aiofiles.open(chunk_path, "rb") as cf:
                    encrypted = await cf.read()
                plaintext = encryption_service.decrypt_chunk(encrypted, file_key, i)
                if compressed:
                    plaintext = compressor.decompress(plaintext)
                await out.write(plaintext)
        return tmp_path
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


async def run_security_scans(
    file_id: uuid.UUID,
    user_id: uuid.UUID,
    file_name: str,
    file_size: int,
    mime_type: str,
    storage_strategy: str,
    file_obj: Object,
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

    # Hoisted so the outer finally below can release them regardless of where
    # inside the try an exception fires.
    file_data: Optional[bytes] = None
    scan_source_path: Optional[str] = None
    scan_result_override: Optional[VirusScanResult] = None
    chunk_hold_id: Optional[str] = None
    chunk_hold_upload_id: Optional[str] = None

    try:
        logger.info(f"🔒 Starting security scans for {file_name} ({file_id})")

        def _needs_decompress() -> bool:
            return isinstance(file_obj.file_metadata, dict) and bool(
                file_obj.file_metadata.get("compressed")
            )

        try:
            # Decrypt the wrapped file key first
            file_key = encryption_service.decrypt_key(file_obj.encryption_key)

            if storage_strategy == "inline":
                encrypted_data = base64.b64decode(file_obj.storage_key)
                file_data = encryption_service.decrypt_data(encrypted_data, file_key)
                if _needs_decompress():
                    file_data = compressor.decompress(file_data)
            elif storage_strategy == "single":
                if file_obj.object_path and os.path.exists(file_obj.object_path):
                    async with aiofiles.open(file_obj.object_path, "rb") as f:
                        encrypted_data = await f.read()
                    file_data = encryption_service.decrypt_data(encrypted_data, file_key)
                    if _needs_decompress():
                        file_data = compressor.decompress(file_data)
            elif storage_strategy == "chunked":
                if file_size > settings.MAX_INSTREAM_BYTES:
                    # Too large for ClamAV's StreamMaxLength. Surface as a
                    # bypass verdict so paid-tier fail-closed still runs;
                    # the size-specific error code drives a distinct
                    # quarantine reason downstream so admins can tell this
                    # apart from "scanner was down".
                    logger.info(
                        f"Chunked file {file_name} ({file_size} bytes) exceeds "
                        f"MAX_INSTREAM_BYTES={settings.MAX_INSTREAM_BYTES}; "
                        f"emitting bypass verdict"
                    )
                    scan_result_override = VirusScanResult(
                        is_infected=False,
                        error="file_too_large_for_instream",
                        scan_status=VirusScanResult.STATUS_BYPASSED,
                    )
                else:
                    # Streaming scan — no plaintext temp file. Acquire a
                    # chunk hold so GC can't reap chunks mid-iteration.
                    chunk_hold_upload_id = (file_obj.chunk_info or {}).get("upload_id")
                    if chunk_hold_upload_id:
                        redis_client = await get_redis()
                        chunk_hold_id = await acquire_chunk_hold(
                            redis_client, chunk_hold_upload_id, "security_scan"
                        )
                    # No scan_source_path / file_data populated. The dispatch
                    # block below detects chunked + neither set and routes
                    # to scan_stream against _iter_decrypted_chunks.

        except Exception as e:
            logger.error(f"Failed to retrieve file data for scanning: {e}")
            # The outer try/finally below releases the chunk hold and unlinks
            # any partial temp file that the helper may have already cleaned up.
            return

        # The streaming chunked path leaves both file_data and scan_source_path
        # None on purpose — its source is the _iter_decrypted_chunks generator.
        # Only treat the absence of all three as a real "no source" failure.
        if (
            file_data is None
            and scan_source_path is None
            and scan_result_override is None
            and storage_strategy != "chunked"
        ):
            logger.warning(f"No file data available for security scanning: {file_name}")
            return

        # ============ VIRUS SCANNING ============
        #
        # Three outcomes, each handled differently:
        #   clean    → allow, log.
        #   infected → quarantine, alert.
        #   bypassed → scanner gave no verdict (unavailable / circuit open /
        #              timeout / daemon error). For FREE tiers we log and
        #              allow (legacy behavior). For PAID tiers we treat an
        #              un-verdicted file as untrusted and quarantine it
        #              until a successful rescan — "fail closed". A future
        #              rescan worker should promote bypassed files back to
        #              clean once ClamAV recovers.
        try:
            # Skip virus scanning if disabled in config
            if not settings.VIRUS_SCANNING_ENABLED:
                logger.info("Virus scanning disabled in configuration, skipping...")
            else:
                virus_scanner = get_virus_scanner()

                # Determine the user's plan tier once so we can label metrics
                # and branch on bypass behavior. Treat lookup failure as "free"
                # (fail-open for plan lookup; fail-closed for scan bypass is
                # already the conservative choice below).
                plan_tier = "free"
                try:
                    from shared_billing import BillingService as _BillingService

                    from ..database import async_session as _async_session_plan

                    async with _async_session_plan() as _plan_db:
                        _billing_svc = _BillingService(_plan_db, service_type="normal")
                        _sub = await _billing_svc.get_user_subscription(user_id, include_plan=True)
                        if _sub and _sub.plan:
                            tier_name = (_sub.plan.tier_name or "").lower()
                            price = float(_sub.plan.price_monthly or 0)
                            if tier_name != "free" and price > 0:
                                plan_tier = "paid"
                except Exception as _plan_err:
                    logger.warning(
                        f"Plan lookup failed for {user_id}, assuming free tier: {_plan_err}"
                    )

                # Run the scan. The scanner itself owns retries + circuit
                # breaker; we just consume the verdict. The source varies by
                # storage strategy: chunked streams decrypted chunks straight
                # to clamd via INSTREAM (no temp file); inline/single uses
                # bytes; oversized-chunked produces a synthetic bypass upstream.
                if scan_result_override is not None:
                    scan_result = scan_result_override
                elif (
                    storage_strategy == "chunked" and file_data is None and scan_source_path is None
                ):
                    scan_result = await virus_scanner.scan_stream(
                        iter_decrypted_chunks(file_obj, file_key),
                        total_size=file_size,
                    )
                elif scan_source_path is not None:
                    scan_result = await virus_scanner.scan_file(scan_source_path)
                else:
                    scan_result = await virus_scanner.scan_bytes(file_data)

                # Record outcome metric for every path.
                try:
                    from ..monitoring.metrics import virus_scan_outcomes

                    virus_scan_outcomes.labels(
                        outcome=scan_result.scan_status,
                        plan_tier=plan_tier,
                    ).inc()
                except Exception:
                    pass  # metrics must never break the scan flow

                # Map scan_status to audit action for the log entry.
                if scan_result.is_infected:
                    action_taken = "blocked"
                elif scan_result.bypassed and plan_tier == "paid":
                    action_taken = "quarantined_pending_rescan"
                else:
                    action_taken = "allowed"

                await audit_service.log_virus_scan(
                    file_id=file_id,
                    user_id=user_id,
                    is_infected=scan_result.is_infected,
                    virus_name=scan_result.virus_name,
                    scan_time=scan_result.scan_time,
                    file_size=file_size,
                    file_hash=file_obj.content_hash,
                    error_message=scan_result.error,
                    action_taken=action_taken,
                )

                if scan_result.is_infected:
                    logger.critical(f"🚨 VIRUS DETECTED: {scan_result.virus_name} in {file_name}")

                    # Log suspicious activity
                    await audit_service.log_action(
                        action="security.virus_detected",
                        user_id=user_id,
                        resource_type="file",
                        resource_id=file_id,
                        resource_name=file_name,
                        status="blocked",
                        metadata={
                            "virus_name": scan_result.virus_name,
                            "file_size": file_size,
                        },
                        is_suspicious=True,
                        risk_level="critical",
                    )

                    # Quarantine infected file - block downloads
                    try:
                        from sqlalchemy import update as _update

                        from ..database import async_session as _async_session

                        async with _async_session() as quarantine_db:
                            await quarantine_db.execute(
                                _update(Object)
                                .where(Object.id == file_id)
                                .values(
                                    is_quarantined=True,
                                    quarantined_at=datetime.utcnow(),
                                    quarantine_reason=f"Virus detected: {scan_result.virus_name}",
                                )
                            )
                            await quarantine_db.commit()
                        logger.info(f"File {file_id} quarantined: {scan_result.virus_name}")
                    except Exception as qe:
                        logger.error(f"Failed to quarantine file {file_id}: {qe}")

                elif scan_result.bypassed:
                    # Scanner never produced a verdict. Free-tier: log and
                    # allow. Paid-tier: fail closed by quarantining until a
                    # rescan proves the file is clean.
                    if plan_tier == "paid":
                        logger.error(
                            f"ClamAV unavailable for paid-tier upload ({file_name}); "
                            f"quarantining pending rescan. reason={scan_result.error}"
                        )
                        # Distinct reason strings let the rescan script and
                        # admin UI tell scanner-down (rescannable) from
                        # file-too-large (permanently bypassed at this cap).
                        if scan_result.error == "file_too_large_for_instream":
                            quarantine_reason_text = (
                                "File exceeds maximum scan size; pending rescan"
                            )
                        else:
                            quarantine_reason_text = (
                                "Virus scanner unavailable at upload time; " "pending rescan"
                            )
                        try:
                            from sqlalchemy import update as _update

                            from ..database import async_session as _async_session

                            async with _async_session() as quarantine_db:
                                await quarantine_db.execute(
                                    _update(Object)
                                    .where(Object.id == file_id)
                                    .values(
                                        is_quarantined=True,
                                        quarantined_at=datetime.utcnow(),
                                        quarantine_reason=quarantine_reason_text,
                                    )
                                )
                                await quarantine_db.commit()
                        except Exception as qe:
                            logger.error(
                                f"Failed to quarantine bypassed paid-tier file {file_id}: {qe}"
                            )

                        try:
                            from ..monitoring.metrics import virus_scan_quarantine_on_bypass

                            virus_scan_quarantine_on_bypass.labels(plan_tier="paid").inc()
                        except Exception:
                            pass

                        # Track as a suspicious operational event so SOC dashboards
                        # see paid-tier bypasses.
                        await audit_service.log_action(
                            action="security.virus_scan_bypassed",
                            user_id=user_id,
                            resource_type="file",
                            resource_id=file_id,
                            resource_name=file_name,
                            status="quarantined",
                            metadata={
                                "reason": scan_result.error or "unknown",
                                "plan_tier": plan_tier,
                                "file_size": file_size,
                            },
                            is_suspicious=True,
                            risk_level="high",
                        )
                    else:
                        logger.warning(
                            f"ClamAV unavailable for free-tier upload ({file_name}); "
                            f"allowing without scan. reason={scan_result.error}"
                        )

                else:
                    logger.info(f"✅ Virus scan clean: {file_name} ({scan_result.scan_time:.2f}s)")

        except Exception as e:
            logger.error(f"Virus scan failed for {file_name}: {e}")

        # ============ DLP SCANNING ============
        # Only scan text-based files, and only up to the DLP size cap. The cap
        # (dlp_service.max_file_size) applies to every storage strategy so we
        # don't push multi-hundred-MB text files through regex matchers.
        text_mime_types = [
            "text/",
            "application/json",
            "application/xml",
            "application/pdf",
            "application/msword",
            "application/vnd.openxmlformats",
        ]

        should_dlp_scan = any(
            mime_type.startswith(mt) if mime_type else False for mt in text_mime_types
        )
        dlp_service = get_dlp_service()
        dlp_size_cap = dlp_service.max_file_size

        if not should_dlp_scan:
            pass
        elif file_size > dlp_size_cap:
            logger.info(
                f"Skipping DLP scan for {file_name}: size {file_size} exceeds "
                f"DLP cap {dlp_size_cap}"
            )
        else:
            try:
                if file_data is not None:
                    dlp_bytes = file_data
                elif scan_source_path is not None:
                    async with aiofiles.open(scan_source_path, "rb") as _dlp_f:
                        dlp_bytes = await _dlp_f.read()
                elif storage_strategy == "chunked":
                    # Streaming virus-scan path didn't materialize a temp
                    # file. Reassemble now, bounded by the DLP cap so this
                    # can't slip through with an oversized chunked file.
                    scan_source_path = await _reassemble_chunked_file_for_scan(
                        file_obj, file_key, max_bytes=dlp_size_cap
                    )
                    async with aiofiles.open(scan_source_path, "rb") as _dlp_f:
                        dlp_bytes = await _dlp_f.read()
                else:
                    dlp_bytes = None  # Nothing to scan; skip DLP gracefully.
                if dlp_bytes is None:
                    raise RuntimeError("No bytes available for DLP scan")
                dlp_result = await dlp_service.scan_bytes(dlp_bytes, file_name)

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
                    action_taken="flagged" if dlp_result.has_sensitive_data else "allowed",
                    blocked=dlp_result.blocked,
                )

                if dlp_result.has_sensitive_data:
                    logger.warning(
                        f"⚠️  Sensitive data detected in {file_name}: "
                        f"risk={dlp_result.risk_score:.1f}, types={detected_types}"
                    )

                    # Log if high risk
                    if dlp_result.risk_score > 50:
                        await audit_service.log_action(
                            action="security.sensitive_data_detected",
                            user_id=user_id,
                            resource_type="file",
                            resource_id=file_id,
                            resource_name=file_name,
                            status="flagged",
                            metadata={
                                "risk_score": dlp_result.risk_score,
                                "detected_types": detected_types,
                                "total_matches": dlp_result.total_matches,
                            },
                            is_suspicious=dlp_result.risk_score > 70,
                            risk_level="high" if dlp_result.risk_score > 70 else "medium",
                        )
                else:
                    logger.info(f"✅ DLP scan clean: {file_name} ({dlp_result.scan_time:.2f}s)")

            except Exception as e:
                logger.error(f"DLP scan failed for {file_name}: {e}")

        logger.info(f"🔒 Security scans completed for {file_name}")

    except Exception as e:
        logger.error(f"Security scanning failed for {file_name}: {e}", exc_info=True)
    finally:
        # Always release the chunk hold and unlink any scan temp file, even on
        # early returns from the inner retrieval except-block or mid-scan
        # exceptions. Both cleanups are best-effort; failures are logged, not
        # re-raised.
        if chunk_hold_id and chunk_hold_upload_id:
            try:
                redis_client = await get_redis()
                await release_chunk_hold(redis_client, chunk_hold_upload_id, chunk_hold_id)
            except Exception as e:
                logger.warning(f"Failed to release chunk hold: {e}")
        if scan_source_path:
            try:
                os.unlink(scan_source_path)
            except OSError as e:
                logger.warning(f"Failed to remove scan temp file {scan_source_path}: {e}")


async def run_video_optimization(
    file_id: uuid.UUID, file_name: str, file_path: str, mime_type: str, storage_strategy: str
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
        if not mime_type or not mime_type.startswith("video/"):
            return

        # Only optimize MOV and MP4 files (most benefit from faststart)
        video_formats = ["video/quicktime", "video/mp4", "video/x-m4v"]
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
            file_path=file_path, replace_original=True
        )

        # Get new database session to update metadata
        from ..database import get_db

        async for db in get_db():
            try:
                # Re-query the file object
                result_query = await db.execute(select(Object).where(Object.id == file_id))
                file_obj = result_query.scalar_one_or_none()

                if not file_obj:
                    logger.warning(f"File not found in database for optimization update: {file_id}")
                    return

                # Update file metadata with optimization status
                if result["success"] and result["optimized"]:
                    logger.info(f"✅ Video optimized successfully: {file_name}")

                    # Update file metadata in database
                    metadata = file_obj.file_metadata or {}
                    metadata.update(
                        {
                            "video_optimized": True,
                            "faststart_applied": True,
                            "moov_location": "start",
                            "optimization_date": datetime.utcnow().isoformat(),
                            "original_moov_location": result["metadata"].get(
                                "moov_location", "unknown"
                            ),
                        }
                    )

                    file_obj.file_metadata = metadata

                    # Commit to database
                    await db.commit()

                    logger.info(
                        f"🎬 Video optimization completed and metadata updated: {file_name}"
                    )

                elif result["success"] and not result["optimized"]:
                    logger.info(f"ℹ️  Video already optimized: {file_name}")

                    # Still update metadata to mark as checked
                    metadata = file_obj.file_metadata or {}
                    metadata.update(
                        {
                            "video_optimized": True,
                            "faststart_applied": False,
                            "moov_location": result["metadata"].get("moov_location", "start"),
                            "optimization_checked": datetime.utcnow().isoformat(),
                        }
                    )

                    file_obj.file_metadata = metadata
                    await db.commit()

                else:
                    error_msg = result.get("error", "Unknown error")
                    logger.error(f"❌ Video optimization failed for {file_name}: {error_msg}")

                    # Mark as failed in metadata
                    metadata = file_obj.file_metadata or {}
                    metadata.update(
                        {
                            "video_optimized": False,
                            "optimization_error": error_msg,
                            "optimization_attempted": datetime.utcnow().isoformat(),
                        }
                    )

                    file_obj.file_metadata = metadata
                    await db.commit()

                break  # Exit the async for loop after processing

            except Exception as e:
                await db.rollback()
                logger.error(f"Failed to update video optimization metadata: {e}")
                raise

    except Exception as e:
        logger.error(f"Video optimization failed for {file_name}: {e}", exc_info=True)


# ============================================================================
# CONSOLIDATED POST-UPLOAD BACKGROUND TASK
# ============================================================================

PREVIEW_QUEUE_THRESHOLD = 50 * 1024 * 1024  # 50 MB


async def _run_post_upload_tasks(
    file_id: uuid.UUID,
    upload_id: str,
    user_id: uuid.UUID,
    file_name: str,
    file_size: int,
    mime_type: str,
    storage_strategy: str,
    session_data: dict,
    file_obj: Object,
    redis_client,
    content_hash: str,
    object_path: str | None,
):
    """All non-critical post-upload work in a single background coroutine.

    Covers: dedup classification, security scanning, video optimization,
    Kafka event fan-out (parallelized), preview generation, and ES indexing.
    """
    from ..database import async_session as _async_session

    # Record upload completion time for chunk hold grace period
    session_data["_upload_completed_at"] = time.time()

    is_video = bool(mime_type and mime_type.startswith("video/"))

    try:
        # ===== SMART DEDUPLICATION CLASSIFICATION =====
        file_classification = None
        enable_dedup = False

        if storage_strategy in ("single", "chunked") and file_size > 1_048_576:
            try:
                file_path = (
                    session_data.get("storage_path") if storage_strategy == "single" else None
                )

                if file_path and os.path.exists(file_path):
                    file_classification = await dedup_classifier.classify_file(
                        file_path=file_path,
                        file_size=file_size,
                        filename=file_name,
                    )
                    logger.info(
                        f"Classification: {file_name} -> "
                        f"mode={file_classification.dedup_mode}, "
                        f"reason={file_classification.reason}, "
                        f"strategy={file_classification.chunk_strategy}"
                    )

                    async with _async_session() as bg_db:
                        await bg_db.execute(
                            update(Object)
                            .where(Object.id == file_id)
                            .values(
                                dedup_info={
                                    "classification_mode": file_classification.dedup_mode,
                                    "classification_reason": file_classification.reason,
                                    "classification_priority": file_classification.priority,
                                    "chunk_strategy": file_classification.chunk_strategy,
                                    "classified_at": datetime.utcnow().isoformat(),
                                }
                            )
                        )
                        await bg_db.commit()

                    enable_dedup = file_classification.dedup_mode in ("inline", "async")
                else:
                    enable_dedup = file_size > 10 * 1024 * 1024
            except Exception as e:
                logger.error(f"Classification failed for {file_name}: {e}")
                enable_dedup = file_size > 10 * 1024 * 1024

        if enable_dedup:
            if file_size > 1024 * 1024 * 1024:
                logger.info(
                    f"Large file {file_name} ({file_size / 1024 / 1024 / 1024:.2f}GB) "
                    f"uploaded. Deduplication skipped (> 1GB limit)."
                )
            else:
                priority = file_classification.priority if file_classification else 2
                logger.info(
                    f"Queuing {file_name} for background dedup "
                    f"(priority={priority}, reason="
                    f"{file_classification.reason if file_classification else 'size-based'})"
                )
                await background_dedup_service.enqueue_for_dedup(
                    file_id=str(file_id),
                    upload_id=upload_id,
                    user_id=str(user_id),
                    session_data=session_data,
                    priority=priority,
                )
        elif file_classification and file_classification.dedup_mode == "skip":
            logger.info(f"Skipping dedup for {file_name}: {file_classification.reason}")

        # ===== SECURITY SCANNING =====
        await run_security_scans(
            file_id=file_id,
            user_id=user_id,
            file_name=file_name,
            file_size=file_size,
            mime_type=mime_type,
            storage_strategy=storage_strategy,
            file_obj=file_obj,
        )

        # ===== VIDEO OPTIMIZATION =====
        if storage_strategy == "single" and object_path:
            await run_video_optimization(
                file_id=file_id,
                file_name=file_name,
                file_path=object_path,
                mime_type=mime_type,
                storage_strategy=storage_strategy,
            )

        # ===== KAFKA SENDS (PARALLELIZED) =====
        producer = await get_kafka_producer()
        kafka_futures = []

        if is_video:
            video_opt_enabled = False
            try:
                async with _async_session() as bg_db:
                    from shared_billing import BillingService

                    billing_svc = BillingService(bg_db, service_type="normal")
                    sub = await billing_svc.get_user_subscription(user_id, include_plan=True)
                    video_opt_enabled = bool((sub.plan.features or {}).get("video_optimization"))
            except Exception:
                pass

            if video_opt_enabled and producer:

                async def _queue_video_ingestion():
                    try:
                        queue_result = await video_ingestion_service.on_upload_complete(
                            file_id=str(file_id),
                            user_id=str(user_id),
                            file_name=file_name,
                            file_size=file_size,
                            mime_type=mime_type,
                            kafka_producer=producer,
                        )
                        if queue_result["queued"]:
                            async with _async_session() as bg_db:
                                await bg_db.execute(
                                    update(Object)
                                    .where(Object.id == file_id)
                                    .values(video_processing_status="queued")
                                )
                                await bg_db.commit()
                            logger.info(f"Queued video for proactive optimization: {file_name}")
                        else:
                            logger.info(
                                f"Video not queued: {file_name} "
                                f"[reason={queue_result.get('reason', 'unknown')}]"
                            )
                    except Exception as e:
                        logger.error(f"Failed to queue video for proactive optimization: {e}")

                kafka_futures.append(_queue_video_ingestion())
            elif not video_opt_enabled:
                logger.info(
                    f"Skipping video optimization for {file_name} (plan does not include it)"
                )

        if is_video and file_size > PREVIEW_QUEUE_THRESHOLD and producer:

            async def _queue_video_preview():
                try:
                    await producer.send_and_wait(
                        "preview-processing",
                        {
                            "file_id": str(file_id),
                            "upload_id": upload_id,
                            "timestamp": datetime.utcnow().isoformat(),
                            "file_name": file_name,
                            "file_size": file_size,
                            "mime_type": mime_type,
                            "storage_type": storage_strategy,
                        },
                    )
                    await redis_client.setex(
                        f"preview:status:{file_id}",
                        3600,
                        json.dumps(
                            {"status": "queued", "queued_at": datetime.utcnow().isoformat()}
                        ),
                    )
                    logger.info(f"Queued video preview: {file_name}")
                except Exception as e:
                    logger.error(f"Failed to queue video preview for {file_name}: {e}")

            kafka_futures.append(_queue_video_preview())

        if settings.SEMANTIC_SEARCH_ENABLED and producer:
            kafka_futures.append(
                producer.send_and_wait(
                    "embedding-processing",
                    {
                        "file_id": str(file_id),
                        "user_id": str(user_id),
                        "timestamp": datetime.utcnow().isoformat(),
                        "file_name": file_name,
                        "mime_type": mime_type,
                        "tags": session_data.get("tags", []),
                        "description": session_data.get("description", ""),
                        "ai_tags": [],
                    },
                )
            )

        if settings.ML_FEATURES_ENABLED and producer:
            kafka_futures.append(
                producer.send_and_wait(
                    "file-analysis",
                    {
                        "file_id": str(file_id),
                        "user_id": str(user_id),
                        "timestamp": datetime.utcnow().isoformat(),
                        "file_name": file_name,
                        "mime_type": mime_type,
                        "file_size": file_size,
                    },
                )
            )

        # ===== ELASTICSEARCH INDEXING (via Kafka worker) =====
        if settings.ELASTICSEARCH_ENABLED and producer:
            kafka_futures.append(
                producer.send_and_wait(
                    "es-indexing",
                    {
                        "file_id": str(file_id),
                        "name": file_name,
                        "mime_type": mime_type,
                        "size": file_size,
                        "hash": content_hash,
                        "storage_tier": "cache",
                        "folder_id": (
                            str(session_data.get("folder")) if session_data.get("folder") else None
                        ),
                        "user_id": str(user_id),
                        "timestamp": datetime.utcnow().isoformat(),
                    },
                )
            )

        if kafka_futures:
            results = await asyncio.gather(*kafka_futures, return_exceptions=True)
            for idx, result in enumerate(results):
                if isinstance(result, Exception):
                    logger.warning(f"Background Kafka task {idx} failed: {result}")

        # ===== NON-VIDEO PREVIEW PRE-GENERATION =====
        if not is_video and storage_strategy != "inline":
            from ..services.preview_service import preview_service
            from ..utils.chunk_lifecycle import acquire_chunk_hold, release_chunk_hold

            hold_id = None
            try:
                hold_id = await acquire_chunk_hold(redis_client, upload_id, "preview_sync")
                await preview_service.generate_on_demand_background(
                    file_id=str(file_id),
                    file_obj=file_obj,
                    redis_client=redis_client,
                )
            finally:
                if hold_id:
                    await release_chunk_hold(redis_client, upload_id, hold_id)

    except Exception as e:
        logger.error(
            f"Post-upload background processing failed for {file_name}: {e}",
            exc_info=True,
        )
