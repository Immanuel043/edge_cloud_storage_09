# services/storage-service/app/routers/files.py

from fastapi import APIRouter, Depends, HTTPException, Request,Header, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select,text
from typing import List, Optional
import os
import json
import logging
from datetime import datetime

logger = logging.getLogger(__name__)
from ..dependencies import get_db, log_activity, get_current_user
from ..services.storage import storage_service
from ..services.encryption import encryption_service
from ..services.search_service import search_service
from ..services.download_optimizer import download_optimizer
from ..services.bandwidth_throttle import bandwidth_throttle_service
from ..models.database import User, Object, ActivityLog, Favorite
from ..models.schemas import FileResponse
from ..database import get_redis
from ..config import settings
from ..utils.rate_limiter_v2 import create_rate_limiter, RateLimitConfig
from ..utils.resolved_file_view import ResolvedFileView
from ..utils.dedup_promotion import promote_dedup_references, decrement_dedup_ref_counts
from pydantic import BaseModel
import re
import base64
import aiofiles
from typing import Optional, Tuple, AsyncGenerator

RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")
USE_X_ACCEL = bool(os.environ.get("USE_X_ACCEL", False))
NGINX_STORAGE_BASE = "/app/storage"  # must match nginx alias path


async def throttled_download_generator(
    user_id: str,
    data_generator: AsyncGenerator[bytes, None],
    file_size: int,
    plan_type: str = "free",
    db_bandwidth_override: int = None,
    db_streams_override: int = None
) -> AsyncGenerator[bytes, None]:
    """
    Wraps a download generator with bandwidth throttling and stream slot management.

    - Acquires a stream slot before starting (plan-based limit)
    - Applies per-user bandwidth limiting with token bucket algorithm
    - Releases stream slot on completion or error
    - Returns 429 if bandwidth limit causes long waits

    Args:
        user_id: User ID for throttling
        data_generator: Original async generator yielding data chunks
        file_size: Total file size (for logging)
        plan_type: User's subscription plan tier (free, basic, pro, team)
        db_bandwidth_override: Admin-set bandwidth override from User model
        db_streams_override: Admin-set max streams override from User model
    """
    stream_acquired = False

    # Get max streams for this user's plan (or override)
    max_streams = await bandwidth_throttle_service.get_max_streams_with_plan(
        user_id, plan_type, db_streams_override
    )

    try:
        # Try to acquire stream slot (plan-based limit)
        stream_acquired = await bandwidth_throttle_service.acquire_stream_slot(
            user_id,
            plan_type=plan_type,
            db_streams_override=db_streams_override
        )

        if not stream_acquired:
            raise HTTPException(
                status_code=429,
                detail=f"Too many concurrent downloads. Maximum {max_streams} streams allowed for your plan.",
                headers={"Retry-After": "10"}
            )

        logger.debug(f"Stream slot acquired for user {user_id} ({plan_type}), starting download ({file_size} bytes)")

        # Stream data with bandwidth throttling (plan-aware)
        async for chunk in bandwidth_throttle_service.throttled_transfer(
            user_id=user_id,
            data_generator=data_generator,
            raise_on_long_wait=True,
            plan_type=plan_type,
            db_bandwidth_override=db_bandwidth_override
        ):
            yield chunk

    except HTTPException:
        # Re-raise HTTP exceptions (429, etc.)
        raise
    except Exception as e:
        logger.error(f"Error in throttled download for user {user_id}: {e}")
        raise
    finally:
        # Always release stream slot
        if stream_acquired:
            await bandwidth_throttle_service.release_stream_slot(user_id)
            logger.debug(f"Stream slot released for user {user_id}")


async def _stream_via_rust(
    resolved, file_key: bytes, start_byte: int, end_byte: int
) -> AsyncGenerator[bytes, None]:
    """Build chunk manifest and stream decrypted data from the Rust data plane."""
    from ..services.rust_dataplane_client import get_rust_client

    chunk_info = resolved.chunk_info
    chunk_size = chunk_info.get("chunk_size", 32 * 1024 * 1024)
    chunk_paths = chunk_info.get("paths", {})
    upload_id = chunk_info.get("upload_id", str(resolved.id))
    total_chunks = chunk_info.get("count", 0)
    was_compressed = chunk_info.get("compressed", False)

    # Build manifest of chunk descriptors
    first_chunk = start_byte // chunk_size
    last_chunk = min(end_byte // chunk_size, total_chunks - 1)
    chunks = []
    for idx in range(first_chunk, last_chunk + 1):
        path = chunk_paths.get(str(idx))
        if not path:
            shard = upload_id[:2]
            path = f"/app/storage/cache/{shard}/{upload_id}_chunk_{idx}.enc"
        chunks.append({"index": idx, "path": path})

    rust_client = get_rust_client()
    async for data in rust_client.stream_download_chunks(
        chunks=chunks,
        file_key=file_key,
        was_compressed=was_compressed,
        start_byte=start_byte,
        end_byte=end_byte,
        chunk_size=chunk_size,
    ):
        yield data


async def _try_rust_or_python(
    resolved, file_key: bytes, start_byte: int, end_byte: int
) -> AsyncGenerator[bytes, None]:
    """Try Rust data plane for chunked download, fall back to Python."""
    use_rust = False
    try:
        from ..services.rust_dataplane_client import get_rust_client
        rust_client = get_rust_client()
        if await rust_client.is_available():
            use_rust = True
    except Exception:
        pass

    if use_rust:
        logger.debug("Using Rust data plane for chunked download")
        async for data in _stream_via_rust(resolved, file_key, start_byte, end_byte):
            yield data
    else:
        logger.debug("Falling back to Python for chunked download")
        async for data in download_optimizer.stream_chunked_file_parallel(
            file_obj=resolved,
            file_key=file_key,
            encryption_service=encryption_service,
            start_byte=start_byte,
            end_byte=end_byte,
        ):
            yield data


class BulkDeleteRequest(BaseModel):
    file_ids: List[str]

class RenameRequest(BaseModel):
    name: str


router = APIRouter(prefix="/api/v1/files", tags=["files"])

@router.get("", response_model=List[FileResponse], dependencies=[Depends(create_rate_limiter(**RateLimitConfig.FILE_LIST))])
async def list_files(
    request: Request,
    folder_id: Optional[str] = None,
    limit: int = 100,  # Default 100 files per page
    offset: int = 0,  # Starting position
    sort_by: str = "created_at",  # Sort field: created_at, name, size
    sort_order: str = "desc",  # asc or desc
    current_user: User = Depends(get_current_user),  # Use get_current_user from dependencies
    db: AsyncSession = Depends(get_db),
):
    """
    List user's files with pagination and sorting

    - **folder_id**: Filter by folder (null for root files)
    - **limit**: Max files to return (default 100, max 500)
    - **offset**: Number of files to skip for pagination
    - **sort_by**: Field to sort by (created_at, name, size, last_accessed)
    - **sort_order**: Sort direction (asc or desc)
    """
    # Validate and cap limit
    limit = min(limit, 500)  # Max 500 files per request

    # Build base query - exclude deleted files
    query = select(Object).filter(Object.user_id == current_user.id, Object.is_deleted == False)

    # Filter by folder
    if folder_id:
        query = query.filter(Object.folder_id == folder_id)
    else:
        query = query.filter(Object.folder_id == None)

    # Apply sorting
    sort_column = {
        "created_at": Object.created_at,
        "name": Object.file_name,
        "size": Object.file_size,
        "last_accessed": Object.last_accessed,
    }.get(sort_by, Object.created_at)

    if sort_order.lower() == "asc":
        query = query.order_by(sort_column.asc())
    else:
        query = query.order_by(sort_column.desc())

    # Apply pagination
    query = query.limit(limit).offset(offset)

    # Execute query
    result = await db.execute(query)
    files = result.scalars().all()

    # Get all file IDs for favorite check
    file_ids = [f.id for f in files]

    # Batch query for favorites
    favorites_result = await db.execute(
        select(Favorite.file_id).filter(
            Favorite.user_id == current_user.id,
            Favorite.file_id.in_(file_ids)
        )
    )
    favorite_file_ids = set(favorites_result.scalars().all())

    return [
        FileResponse(
            id=str(f.id),
            name=f.file_name,
            size=f.file_size,
            mime_type=f.mime_type,
            folder_id=str(f.folder_id) if f.folder_id else None,
            storage_tier=f.storage_tier,
            backup_status=f.backup_status,
            created_at=f.created_at,
            last_accessed=f.last_accessed,
            updated_at=f.updated_at,
            path=f.object_path,
            is_favorite=(f.id in favorite_file_ids),
            # Encryption mode (server-side encryption for normal storage)
            # Note: ZK files are in a separate service
            is_encrypted=(f.encryption_mode == 'server_side'),
            encryption_version=getattr(f, 'encryption_version', None),
            encryption_mode=f.encryption_mode,
        )
        for f in files
    ]


@router.get("/stats", dependencies=[Depends(create_rate_limiter(**RateLimitConfig.FILE_LIST))])
async def get_file_stats(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Get file statistics including:
    - Total files count
    - Total storage used
    - File type distribution by MIME type
    """
    from sqlalchemy import func

    # Get total files and size
    total_query = select(
        func.count(Object.id).label('total_files'),
        func.coalesce(func.sum(Object.file_size), 0).label('total_size')
    ).filter(
        Object.user_id == current_user.id,
        Object.is_deleted == False
    )
    total_result = await db.execute(total_query)
    totals = total_result.one()

    # Get MIME type distribution
    mime_query = select(
        Object.mime_type,
        func.count(Object.id).label('count'),
        func.coalesce(func.sum(Object.file_size), 0).label('total_size')
    ).filter(
        Object.user_id == current_user.id,
        Object.is_deleted == False
    ).group_by(Object.mime_type)

    mime_result = await db.execute(mime_query)
    mime_distribution = {}
    for row in mime_result:
        mime_type = row.mime_type or 'unknown'
        mime_distribution[mime_type] = {
            'count': row.count,
            'total_size': row.total_size
        }

    return {
        'total_files': totals.total_files,
        'total_size': totals.total_size,
        'mime_type_distribution': mime_distribution
    }


###########Download with Range Support##################################
async def parse_range_header(range_header: Optional[str], file_size: int) -> Optional[Tuple[int, int]]:
    """Parse Range header and return (start, end) inclusive byte offsets."""
    if not range_header:
        return None
    
    match = RANGE_RE.match(range_header.strip())
    if not match:
        raise HTTPException(status_code=416, detail="Invalid Range header")
    
    start_str, end_str = match.groups()
    
    # Handle suffix-byte-range-spec (e.g., "bytes=-500" for last 500 bytes)
    if start_str == "":
        if end_str == "":
            raise HTTPException(status_code=416, detail="Invalid Range header")
        suffix_len = int(end_str)
        if suffix_len == 0:
            return None
        start = max(0, file_size - suffix_len)
        end = file_size - 1
    else:
        start = int(start_str)
        end = int(end_str) if end_str != "" else file_size - 1
    
    # Validate range
    if start > end or start >= file_size:
        raise HTTPException(
            status_code=416, 
            detail="Range Not Satisfiable",
            headers={"Content-Range": f"bytes */{file_size}"}
        )
    
    # Clamp end to file size
    end = min(end, file_size - 1)
    
    return (start, end)

async def stream_file_range_disk(path: str, start: int, end: int, block_size: int = 1024 * 1024):
    """Stream a byte range from a disk file."""
    async with aiofiles.open(path, "rb") as f:
        await f.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            read_size = min(block_size, remaining)
            chunk = await f.read(read_size)
            if not chunk:
                break
            yield chunk
            remaining -= len(chunk)

async def stream_full_file_disk(path: str, block_size: int = 1024 * 1024):
    """Stream entire file from disk."""
    async with aiofiles.open(path, "rb") as f:
        while True:
            chunk = await f.read(block_size)
            if not chunk:
                break
            yield chunk

async def stream_chunked_range(
    file_obj,
    start: int,
    end: int,
    file_key,
    encryption_service,
    block_size: int = 1024 * 1024
) -> AsyncGenerator[bytes, None]:
    """Stream byte range from chunked or content-addressed storage."""
    chunk_info = file_obj.chunk_info or {}

    # Check if this is content-addressed storage (from deduplication)
    if 'blocks' in chunk_info and 'stored_blocks' in chunk_info:
        # Content-addressed storage - reconstruct from blocks
        blocks = chunk_info['blocks']
        stored_blocks = chunk_info['stored_blocks']
        is_convergent = chunk_info.get('convergent_encryption', False)

        # Create a map of block hashes to stored paths
        block_map = {b['hash']: b for b in stored_blocks}

        current_pos = 0

        for block in blocks:
            block_hash = block['hash']
            block_size = block['size']
            block_end = current_pos + block_size - 1

            # Check if this block is in range
            if block_end < start:
                current_pos += block_size
                continue

            if current_pos > end:
                break

            # Get the stored block path
            stored_block = block_map.get(block_hash)
            if not stored_block:
                raise HTTPException(status_code=500, detail=f"Block {block_hash[:8]} not found")

            block_path = stored_block['path']

            if not os.path.exists(block_path):
                raise HTTPException(status_code=404, detail=f"Block file missing: {block_hash[:8]}")

            # Read encrypted block
            async with aiofiles.open(block_path, "rb") as f:
                encrypted_data = await f.read()

            # Decrypt block
            if is_convergent:
                user_id = str(file_obj.user_id)
                was_compressed = stored_block.get('was_compressed', False)

                # Try Rust data plane for fast PBKDF2 decryption
                try:
                    from ..services.rust_dataplane_client import get_rust_client
                    rust_client = get_rust_client()
                    decrypted_block = await rust_client.convergent_decrypt(
                        encrypted_data, block_hash, user_id,
                        was_compressed=was_compressed,
                    )
                except Exception:
                    # Fallback: Python PBKDF2 + AES-GCM
                    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
                    from cryptography.hazmat.backends import default_backend
                    import hashlib

                    nonce = encrypted_data[:12]
                    tag = encrypted_data[12:28]
                    ciphertext = encrypted_data[28:]

                    content_hash_bytes = bytes.fromhex(block_hash)
                    salt = hashlib.sha256(f"dedup_user_{user_id}_salt".encode()).digest()
                    block_key = hashlib.pbkdf2_hmac('sha256', content_hash_bytes, salt, 100000, dklen=32)

                    cipher = Cipher(
                        algorithms.AES(block_key),
                        modes.GCM(nonce, tag),
                        backend=default_backend()
                    )
                    decryptor = cipher.decryptor()
                    decrypted_block = decryptor.update(ciphertext) + decryptor.finalize()
            else:
                # Standard file-key encryption
                decrypted_block = encryption_service.decrypt_data(encrypted_data, file_key)

            # Calculate slice to yield
            slice_start = max(0, start - current_pos)
            slice_end = min(block_size, end - current_pos + 1)

            # Yield the relevant portion
            if slice_start < slice_end:
                yield decrypted_block[slice_start:slice_end]

            current_pos += block_size

    else:
        # Traditional chunked storage
        upload_id = chunk_info.get("upload_id", str(file_obj.id))
        total_chunks = chunk_info.get("count", 0)
        chunk_paths = chunk_info.get("paths", {})

        if total_chunks == 0:
            raise HTTPException(status_code=500, detail="No chunks found")

        # Track position in file
        current_pos = 0

        for chunk_idx in range(total_chunks):
            # Get chunk path
            chunk_path = chunk_paths.get(str(chunk_idx))
            if not chunk_path:
                shard = upload_id[:2] if len(upload_id) >= 2 else "00"
                chunk_path = f"/app/storage/cache/{shard}/{upload_id}_chunk_{chunk_idx}.enc"

            if not os.path.exists(chunk_path):
                raise HTTPException(status_code=404, detail=f"Chunk {chunk_idx} missing")

            # Read and decrypt chunk
            async with aiofiles.open(chunk_path, "rb") as f:
                encrypted_chunk = await f.read()

            decrypted_chunk = encryption_service.decrypt_chunk(encrypted_chunk, file_key, chunk_idx)

            # Handle compression
            was_compressed = chunk_info.get("compressed", False)
            if was_compressed:
                from ..utils.compression import compressor
                decrypted_chunk = compressor.decompress(decrypted_chunk)

            chunk_size = len(decrypted_chunk)
            chunk_end = current_pos + chunk_size - 1

            # Check if this chunk is in range
            if chunk_end < start:
                current_pos += chunk_size
                continue

            if current_pos > end:
                break

            # Calculate slice to yield
            slice_start = max(0, start - current_pos)
            slice_end = min(chunk_size, end - current_pos + 1)

            # Yield the relevant portion
            if slice_start < slice_end:
                yield decrypted_chunk[slice_start:slice_end]

            current_pos += chunk_size

@router.get("/{file_id}/download")
@router.head("/{file_id}/download", dependencies=[Depends(create_rate_limiter(**RateLimitConfig.FILE_DOWNLOAD))])
async def download_file(
    file_id: str,
    request: Request,
    range_header: Optional[str] = Header(None, alias="range"),
    accept_encoding: Optional[str] = Header(None, alias="accept-encoding"),
    inline: bool = False,  # Set to True for streaming video/audio in browser
    compatible: bool = False,  # Transcode to browser-friendly variant when needed
    original: bool = False,  # Force download of original file (skip optimization)
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Optimized download endpoint with:
    - HTTP Range support for resumable downloads
    - HEAD request support for metadata
    - Parallel chunk decryption (4x faster for large files)
    - True streaming (never loads full file in memory)
    - Optional gzip compression for text files (60-90% bandwidth savings)
    - Adaptive buffering based on file size
    """
    
    # Fetch file object
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    file_obj = result.scalar_one_or_none()
    
    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Block downloads of quarantined files
    if getattr(file_obj, 'is_quarantined', False):
        raise HTTPException(
            status_code=403,
            detail=f"This file has been quarantined due to a security threat: {file_obj.quarantine_reason or 'malware detected'}. "
                   "Contact support if you believe this is an error."
        )

    # Update last accessed time (for tiering)
    file_obj.last_accessed = datetime.utcnow()

    # TIERING: Promote file to hot storage if accessed from warm/cold tier
    from ..services.cold_storage_tiering import cold_storage_service
    try:
        await cold_storage_service.promote_file_on_access(str(file_id), db)
    except Exception as e:
        # Don't fail download if promotion fails
        print(f"Warning: Failed to promote file {file_id}: {e}")

    await db.commit()

    # Build a read-only view that resolves deduplicated_reference files to
    # the actual storage (CAS blocks) without mutating the ORM object.
    resolved = await ResolvedFileView.resolve(file_obj, db)

    if resolved.dangling_reference:
        logger.error(
            "Dangling dedup reference: file %s references missing file %s",
            file_obj.id,
            (file_obj.dedup_info or {}).get("reference_file_id", "unknown"),
        )
        raise HTTPException(
            status_code=404,
            detail="This file's storage reference is no longer available. "
                   "The original data has been removed. Please re-upload the file."
        )

    # Decrypt key (None for unencrypted files, for defensive compatibility)
    file_key = encryption_service.decrypt_key(resolved.encryption_key) if resolved.encryption_key else None

    # File metadata
    total_size = file_obj.file_size or 0
    mime_type = file_obj.mime_type or "application/octet-stream"
    filename = file_obj.file_name.replace('"', '\\"')

    # Determine Content-Disposition (inline for streaming, attachment for download)
    # Use inline for video/audio when inline=True, or auto-detect for video/audio types
    is_streamable = mime_type.startswith(('video/', 'audio/'))
    disposition = "inline" if (inline or is_streamable) else "attachment"

    # Browser compatibility fix: Some browsers have issues with video/quicktime MIME type
    # Use video/mp4 for MOV files to improve compatibility (most MOV files work with this)
    display_mime_type = mime_type
    if mime_type == 'video/quicktime' and file_obj.file_name.lower().endswith(('.mov', '.qt')):
        display_mime_type = 'video/mp4'  # Better browser support

    # Common headers
    base_headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": display_mime_type,
        "Content-Disposition": f'{disposition}; filename="{filename}"',
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "ETag": f'"{file_obj.content_hash[:16]}"' if file_obj.content_hash else None,
    }
    
    # Remove None values
    base_headers = {k: v for k, v in base_headers.items() if v is not None}
    
    # Handle HEAD request - check if video needs transcoding when compatible=true
    if request.method == "HEAD":
        # For videos with compatible=true, check if transcoding is needed/in-progress
        if compatible and mime_type.startswith('video/') and not original:
            from ..services.video_transcoder import video_transcoder
            
            file_id_str = str(file_id)
            
            # Check if proactively optimized version exists
            if file_obj.optimized_path and os.path.exists(file_obj.optimized_path):
                # Optimized version ready - return 200
                headers = {**base_headers, "Content-Length": str(os.path.getsize(file_obj.optimized_path))}
                headers["X-Video-Transcoded"] = "true"
                return Response(status_code=200, headers=headers)
            
            # Check if transcoded version is cached
            if video_transcoder.is_cached(file_id_str):
                target_path = video_transcoder._target_path(file_obj)
                if os.path.exists(target_path):
                    headers = {**base_headers, "Content-Length": str(os.path.getsize(target_path))}
                    headers["X-Video-Transcoded"] = "true"
                    return Response(status_code=200, headers=headers)
            
            # Check video processing status
            if file_obj.video_processing_status in ('processing', 'queued'):
                headers = {**base_headers, "Content-Length": "0"}
                headers["X-Transcode-Status"] = file_obj.video_processing_status
                return Response(status_code=202, headers=headers)
            
            # Check if video needs transcoding (MOV, HEVC, etc.)
            ext = file_obj.file_name.lower().rsplit('.', 1)[-1] if '.' in file_obj.file_name else ''
            needs_transcode = ext in video_transcoder.INCOMPATIBLE_EXTS or ext in {'mov', 'qt', 'm4v', '3gp', '3g2', 'hevc'}
            
            if needs_transcode:
                # Video needs transcoding but not started yet - return 202
                headers = {**base_headers, "Content-Length": "0"}
                headers["X-Transcode-Status"] = "not_started"
                return Response(status_code=202, headers=headers)
        
        # Non-video files or videos that don't need transcoding - return 200
        headers = {**base_headers, "Content-Length": str(total_size)}
        return Response(status_code=200, headers=headers)
    
    # Parse range header
    parsed_range = await parse_range_header(range_header, total_size)
    
    # Update last accessed
    file_obj.last_accessed = datetime.utcnow()
    await db.commit()
    
    # Log activity
    await log_activity(
        db, current_user.id, "file_downloaded", str(file_id),
        {"file_name": file_obj.file_name, "partial": parsed_range is not None},
        request
    )
    
    # Handle different storage types

    # Video compatibility stream (transcoded H.264 MP4)
    compat_path = None
    use_compat_stream = False

    # Gate original download access to keep_both plans
    if original and file_obj.optimized_path and file_obj.mime_type and file_obj.mime_type.startswith('video/'):
        try:
            from shared_billing import BillingService
            billing_svc = BillingService(db, service_type='normal')
            sub = await billing_svc.get_user_subscription(current_user.id, include_plan=True)
            video_opt = (sub.plan.features or {}).get('video_optimization', False)
            if video_opt != 'keep_both':
                original = False  # Plan doesn't allow original access
        except Exception:
            pass  # Fail open

    # Skip video optimization if user explicitly requests original file
    skip_optimization = original

    if not skip_optimization and compatible and mime_type.startswith('video/'):
        from ..services.video_transcoder import video_transcoder, VideoTranscodeError

        logger.info(f"Compatible stream requested for {file_obj.file_name} ({mime_type})")

        # ============ PROACTIVE OPTIMIZATION CHECK (FAST PATH) ============
        # Check if a proactively optimized version exists from write-time processing
        # This provides instant playback without waiting for transcoding
        if file_obj.optimized_path and os.path.exists(file_obj.optimized_path):
            # Instant stream from proactively optimized file
            compat_path = file_obj.optimized_path
            use_compat_stream = True
            logger.info(f"Using proactively optimized video: {file_obj.file_name}")

        # Check if video is still being processed
        elif file_obj.video_processing_status == 'processing':
            progress = file_obj.video_processing_progress or 0
            raise HTTPException(
                status_code=202,
                detail={
                    "status": "processing",
                    "message": f"Video is being optimized for playback ({progress}% complete). Please wait...",
                    "progress": progress
                }
            )

        # Check if video is queued but not yet processing
        elif file_obj.video_processing_status == 'queued':
            raise HTTPException(
                status_code=202,
                detail={
                    "status": "queued",
                    "message": "Video is queued for optimization. Playback will be available shortly.",
                    "progress": 0
                }
            )

        # ============ LEGACY REACTIVE TRANSCODING (FALLBACK) ============
        # If no proactive optimization, fall back to on-demand transcoding
        # This handles videos uploaded before the proactive pipeline was deployed
        if not use_compat_stream:
            try:
                compat_path = await video_transcoder.get_or_create_stream(
                    file_obj=resolved,
                    encryption_service=encryption_service
                )
                logger.info(f"get_or_create_stream returned: {compat_path}")
                if compat_path:
                    use_compat_stream = True
            except VideoTranscodeError as exc:
                if exc.status_code == 202:
                    raise HTTPException(
                        status_code=202,
                        detail={
                            "status": "transcoding",
                            "message": exc.message
                        }
                    )
                raise HTTPException(status_code=exc.status_code, detail=exc.message)

    if use_compat_stream and compat_path:
        compat_size = os.path.getsize(compat_path)
        compat_range = await parse_range_header(range_header, compat_size)
        start, end = compat_range if compat_range else (0, compat_size - 1)
        status_code = 206 if compat_range else 200
        headers = {
            "Accept-Ranges": "bytes",
            "Content-Type": "video/mp4",
            "Content-Disposition": f'inline; filename="{filename.rsplit(".", 1)[0]}.mp4"',
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "X-Video-Transcoded": "true",
            "Content-Length": str(end - start + 1)
        }
        if compat_range:
            headers["Content-Range"] = f"bytes {start}-{end}/{compat_size}"

        async def _stream_compat_file(path: str, start_byte: int, end_byte: int):
            chunk_size = download_optimizer.get_optimal_chunk_size(compat_size)
            async with aiofiles.open(path, 'rb') as f:
                await f.seek(start_byte)
                remaining = end_byte - start_byte + 1
                while remaining > 0:
                    chunk = await f.read(min(chunk_size, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk

        if request.method == "HEAD":
            return Response(status_code=status_code, headers=headers, media_type="video/mp4")

        return StreamingResponse(
            _stream_compat_file(compat_path, start, end),
            status_code=status_code,
            headers=headers,
            media_type="video/mp4"
        )

    # INLINE STORAGE
    if resolved.storage_type == "inline":
        # Decode and decrypt inline data
        encrypted_data = base64.b64decode(resolved.storage_key)
        data = encryption_service.decrypt_file(encrypted_data, file_key)

        # Handle compression
        if resolved.file_metadata and isinstance(resolved.file_metadata, dict) and resolved.file_metadata.get("compressed", False):
            from ..utils.compression import compressor
            data = compressor.decompress(data)
        
        # Handle range request
        if parsed_range:
            start, end = parsed_range
            chunk = data[start:end + 1]
            headers = {
                **base_headers,
                "Content-Range": f"bytes {start}-{end}/{total_size}",
                "Content-Length": str(len(chunk)),
            }
            return Response(content=chunk, status_code=206, headers=headers)
        else:
            headers = {
                **base_headers,
                "Content-Length": str(len(data)),
            }
            return Response(content=data, status_code=200, headers=headers)
    
    # SINGLE FILE STORAGE
    elif resolved.storage_type == "single":
        # Ensure on-disk path exists
        if not os.path.exists(resolved.object_path):
            raise HTTPException(status_code=404, detail="File not found on disk")

        # If configured, offload plain (non-encrypted) files to nginx via X-Accel-Redirect.
        # Requires: USE_X_ACCEL=True in env and a boolean flag on the object (e.g. on_disk_plain)
        if USE_X_ACCEL and getattr(file_obj, "on_disk_plain", False):
            # Compute relative path under the storage base that nginx alias maps to.
            # NGINX_STORAGE_BASE must match nginx 'alias' path (e.g. /app/storage)
            internal_rel = os.path.relpath(resolved.object_path, NGINX_STORAGE_BASE)
            accel_path = f"/internal_protected/{internal_rel}"

            headers = {
                **base_headers,
                "X-Accel-Redirect": accel_path,
                # Leave Content-Disposition in base_headers; nginx will handle Range and Content-Length.
            }
            # Return 200 — nginx will take over serving the file (handles ranges).
            return Response(status_code=200, headers=headers)

        # ---------- OPTIMIZED: encrypted or non-offloadable file: decrypt & stream in Python ----------
        # Use optimized streaming that never loads full file in memory
        # Now with per-user bandwidth throttling and stream limiting
        was_compressed = resolved.file_metadata and isinstance(resolved.file_metadata, dict) and resolved.file_metadata.get("compressed", False)
        user_id_str = str(current_user.id)

        if parsed_range:
            start, end = parsed_range
            content_length = end - start + 1
            headers = {
                **base_headers,
                "Content-Range": f"bytes {start}-{end}/{total_size}",
                "Content-Length": str(content_length),
            }
            base_generator = download_optimizer.stream_single_file_optimized(
                file_path=resolved.object_path,
                file_key=file_key,
                encryption_service=encryption_service,
                start_byte=start,
                end_byte=end,
                compressed=was_compressed
            )
            # Wrap with bandwidth throttling and stream limiting (plan-aware)
            throttled_generator = throttled_download_generator(
                user_id=user_id_str,
                data_generator=base_generator,
                file_size=content_length,
                plan_type=current_user.plan_type,
                db_bandwidth_override=current_user.bandwidth_limit_mbps,
                db_streams_override=current_user.max_concurrent_streams
            )
            return StreamingResponse(
                throttled_generator,
                status_code=206,
                headers=headers,
                media_type=mime_type
            )
        else:
            headers = {
                **base_headers,
                "Content-Length": str(total_size),
            }
            base_generator = download_optimizer.stream_single_file_optimized(
                file_path=resolved.object_path,
                file_key=file_key,
                encryption_service=encryption_service,
                start_byte=0,
                end_byte=total_size - 1,
                compressed=was_compressed
            )
            # Wrap with bandwidth throttling and stream limiting (plan-aware)
            throttled_generator = throttled_download_generator(
                user_id=user_id_str,
                data_generator=base_generator,
                file_size=total_size,
                plan_type=current_user.plan_type,
                db_bandwidth_override=current_user.bandwidth_limit_mbps,
                db_streams_override=current_user.max_concurrent_streams
            )
            return StreamingResponse(
                throttled_generator,
                status_code=200,
                headers=headers,
                media_type=mime_type
            )

    # CHUNKED STORAGE (includes content_addressed; deduplicated_reference resolves here after ResolvedFileView)
    elif resolved.storage_type in ("chunked", "content_addressed"):
        # Validate that chunk_info exists
        if not resolved.chunk_info or not isinstance(resolved.chunk_info, dict):
            raise HTTPException(
                status_code=500,
                detail="File deduplication is incomplete. Please re-upload the file."
            )

        user_id_str = str(current_user.id)

        # Detect content-addressed storage (CAS) — uses blocks/stored_blocks
        # instead of count/paths, so we must use stream_chunked_range.
        is_cas = (
            'blocks' in resolved.chunk_info
            and 'stored_blocks' in resolved.chunk_info
        )

        if parsed_range:
            start, end = parsed_range
            content_length = end - start + 1
            headers = {
                **base_headers,
                "Content-Range": f"bytes {start}-{end}/{total_size}",
                "Content-Length": str(content_length),
            }
            if is_cas:
                base_generator = stream_chunked_range(
                    resolved, start, end, file_key, encryption_service
                )
            else:
                base_generator = _try_rust_or_python(resolved, file_key, start, end)
            # Wrap with bandwidth throttling and stream limiting (plan-aware)
            throttled_generator = throttled_download_generator(
                user_id=user_id_str,
                data_generator=base_generator,
                file_size=content_length,
                plan_type=current_user.plan_type,
                db_bandwidth_override=current_user.bandwidth_limit_mbps,
                db_streams_override=current_user.max_concurrent_streams
            )
            return StreamingResponse(
                throttled_generator,
                status_code=206,
                headers=headers,
                media_type=mime_type
            )
        else:
            headers = {
                **base_headers,
                "Content-Length": str(total_size),
            }
            if is_cas:
                base_generator = stream_chunked_range(
                    resolved, 0, total_size - 1, file_key, encryption_service
                )
            else:
                base_generator = _try_rust_or_python(resolved, file_key, 0, total_size - 1)
            # Wrap with bandwidth throttling and stream limiting (plan-aware)
            throttled_generator = throttled_download_generator(
                user_id=user_id_str,
                data_generator=base_generator,
                file_size=total_size,
                plan_type=current_user.plan_type,
                db_bandwidth_override=current_user.bandwidth_limit_mbps,
                db_streams_override=current_user.max_concurrent_streams
            )
            return StreamingResponse(
                throttled_generator,
                status_code=200,
                headers=headers,
                media_type=mime_type
            )

    else:
        raise HTTPException(status_code=500, detail="Unknown storage type")


@router.get("/{file_id}/transcode/progress")
async def get_transcode_progress(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Get transcoding progress for a video file.

    Returns:
        - status: 'not_started', 'transcoding', 'complete', 'failed'
        - percent: Progress percentage (0-100)
        - fps: Current encoding speed (frames per second)
        - eta_seconds: Estimated time remaining (optional)
        - started_at: Transcoding start timestamp
    """
    from ..services.video_transcoder import video_transcoder

    # Verify file belongs to user
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Check if cached version exists
    if video_transcoder.is_cached(file_id):
        return {
            "status": "complete",
            "percent": 100,
            "file_id": file_id
        }

    # Get current progress
    progress = video_transcoder.get_progress(file_id)

    if not progress:
        # Check if task is running but hasn't produced progress yet
        if video_transcoder.is_inflight(file_id):
            return {
                "status": "transcoding",
                "percent": 0,
                "file_id": file_id,
                "message": "Transcoding starting..."
            }
        return {
            "status": "not_started",
            "percent": 0,
            "file_id": file_id
        }

    return {
        "status": progress.get("status", "transcoding"),
        "percent": progress.get("percent", 0),
        "fps": progress.get("fps", 0),
        "frame": progress.get("frame", 0),
        "eta_seconds": progress.get("eta_seconds"),
        "started_at": progress.get("started_at"),
        "file_id": file_id
    }


@router.get("/{file_id}/preview")
async def get_file_preview(
    file_id: str,
    size: str = 'medium',
    force_refresh: bool = False,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Generate file preview/thumbnail for all supported file types with Redis caching

    Supports:
    - Images (JPG, PNG, GIF, WebP, etc.)
    - PDFs (first page thumbnail)
    - Videos (frame extraction - optimized with ffmpeg)
    - Documents (DOCX, TXT, code files)
    - Placeholders for audio, archives, etc.

    Size options: small (150x150), medium (400x400), large (800x800)

    Query params:
    - force_refresh: Set to true to bypass cache and regenerate thumbnail

    Features:
    - Redis caching for fast repeated access (7-30 day TTL)
    - Optimized video processing with ffmpeg
    - Async generation to avoid blocking
    """
    from ..services.preview_generator import preview_generator
    from ..services.preview_optimizer import preview_optimizer
    from ..services.preview_service import preview_service
    import base64
    import aiofiles
    import tempfile
    from ..database import get_redis

    # Get Redis client
    redis = await get_redis()

    # Check cache first (unless force_refresh is requested)
    cache_key = f"preview:{file_id}:{size}"

    if force_refresh:
        # Delete any existing cached preview to force regeneration
        await redis.delete(cache_key)
        logger.info(f"🔄 Force refresh requested for {file_id} (size: {size}) - cache cleared")
    else:
        cached_preview = await redis.get(cache_key)

        if cached_preview:
            logger.info(f"✅ Preview cache HIT for {file_id} (size: {size})")
            # Cached preview is stored as raw bytes
            return Response(
                content=cached_preview,
                media_type='image/jpeg',
                headers={
                    "Cache-Control": "public, max-age=2592000",  # 30 days
                    "X-Cache": "HIT",
                    "X-Preview-Status": "cached"
                }
            )

    logger.info(f"❌ Preview cache MISS for {file_id} (size: {size}) - generating...")

    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Note: ZK files are now in a separate service (ZK Private Vault)
    # Normal Storage service only handles server-side encrypted files
    # Check if this is a server-side encrypted file (encryption_mode = 'server_side')
    is_zk_encrypted = getattr(file_obj, 'encryption_mode', None) == 'client_side'

    if is_zk_encrypted:
        # This shouldn't happen in Normal Storage service, but handle gracefully
        # ZK files should be in the ZK service now
        raise HTTPException(
            status_code=400,
            detail="Zero-Knowledge encrypted files are not available in Normal Storage. Please use the ZK Private Vault service."
        )

    # Resolve dedup references so preview reads from the correct storage
    resolved = await ResolvedFileView.resolve(file_obj, db)

    if resolved.dangling_reference:
        return await _return_placeholder(status="error", reason="dangling_dedup_reference")

    # ============ CHECK BACKGROUND PREVIEW STATUS FOR LARGE VIDEOS ============
    # For large videos (>50MB), check if preview is being generated in background
    PREVIEW_QUEUE_THRESHOLD = 50 * 1024 * 1024  # 50MB
    is_large_video = (
        file_obj.mime_type and
        file_obj.mime_type.startswith('video/') and
        file_obj.file_size > PREVIEW_QUEUE_THRESHOLD
    )

    if is_large_video:
        from fastapi.responses import JSONResponse
        from datetime import datetime

        status_key = f"preview:status:{file_id}"
        status_data = await redis.get(status_key)

        async def _queue_preview_to_kafka(carry_retry_count: int = 0):
            """Send preview request to Kafka worker. Returns True on success."""
            from aiokafka import AIOKafkaProducer
            from ..config import settings

            if not hasattr(settings, 'KAFKA_BROKERS'):
                return False

            producer = AIOKafkaProducer(
                bootstrap_servers=settings.KAFKA_BROKERS,
                value_serializer=lambda v: json.dumps(v).encode()
            )
            await producer.start()
            try:
                await producer.send_and_wait(
                    'preview-processing',
                    {
                        'file_id': str(file_id),
                        'timestamp': datetime.utcnow().isoformat(),
                        'file_name': file_obj.file_name,
                        'file_size': file_obj.file_size,
                        'mime_type': file_obj.mime_type,
                        'storage_type': file_obj.storage_type
                    }
                )
                new_status = {
                    'status': 'queued',
                    'queued_at': datetime.utcnow().isoformat(),
                }
                if carry_retry_count > 0:
                    new_status['retry_count'] = carry_retry_count
                await redis.setex(status_key, 3600, json.dumps(new_status))
                return True
            finally:
                await producer.stop()

        def _return_202(status_val='processing', message=None):
            return JSONResponse(
                status_code=202,
                content={
                    'status': status_val,
                    'message': message or f'Preview is being generated in background ({status_val})',
                    'retry_after': 5,
                    'file_id': file_id
                },
                headers={'Retry-After': '5'}
            )

        if status_data:
            try:
                if isinstance(status_data, bytes):
                    status_data = status_data.decode('utf-8')
                status_info = json.loads(status_data)
                status = status_info.get('status')

                if status in ['queued', 'processing']:
                    logger.info(f"🎬 Preview {status} for large video {file_id}, returning 202")
                    return _return_202(status)

                elif status == 'ready':
                    cached_preview = await redis.get(cache_key)
                    if cached_preview:
                        logger.info(f"✅ Preview cache HIT (post-ready) for {file_id} (size: {size})")
                        return Response(
                            content=cached_preview,
                            media_type='image/jpeg',
                            headers={
                                "Cache-Control": "public, max-age=2592000",
                                "X-Cache": "HIT",
                                "X-Preview-Status": "cached"
                            }
                        )
                    logger.warning(f"Preview status=ready but cache miss for {file_id}:{size}, re-queuing")
                    try:
                        await _queue_preview_to_kafka()
                    except Exception as e:
                        logger.warning(f"Failed to re-queue after cache miss for {file_id}: {e}")
                    return _return_202('queued', 'Preview cache expired, re-generating')

                elif status == 'failed':
                    retry_count = status_info.get('retry_count', 0)
                    if retry_count < 3:
                        logger.info(f"Re-queuing failed preview for {file_id} (retry {retry_count + 1}/3)")
                        try:
                            await _queue_preview_to_kafka(carry_retry_count=retry_count)
                        except Exception as e:
                            logger.warning(f"Failed to re-queue preview for {file_id}: {e}")
                        return _return_202('queued', 'Preview generation retrying')
                    else:
                        logger.warning(f"Preview generation failed after {retry_count} retries for {file_id}")
                        return _return_202('failed', 'Preview generation failed after multiple attempts')

                else:
                    logger.info(f"🎬 Unknown preview status '{status}' for large video {file_id}, returning 202")
                    return _return_202(status or 'processing')

            except (json.JSONDecodeError, KeyError) as e:
                logger.warning(f"Failed to parse preview status for {file_id}: {e}")
                return _return_202('processing', 'Preview is being processed')

        else:
            try:
                queued = await _queue_preview_to_kafka()
                if queued:
                    logger.info(f"🎬 Queued existing large video for background preview: {file_obj.file_name}")
                    return _return_202('queued', 'Preview is being generated in background')
            except Exception as e:
                logger.warning(f"Failed to queue large video for background preview: {e}")

            return _return_202('processing', 'Preview generation pending')

    size_tuple = preview_generator.SIZES.get(size, preview_generator.SIZES['medium'])

    def _placeholder_meta():
        mime = (file_obj.mime_type or '').lower() if file_obj.mime_type else ''
        ext = os.path.splitext(file_obj.file_name or '')[1].lower()

        if mime.startswith('video/') or ext in preview_generator.VIDEO_TYPES:
            return ('VIDEO', '🎬')
        if mime.startswith('audio/') or ext in preview_generator.AUDIO_TYPES:
            return ('AUDIO', '🎵')
        if 'pdf' in mime or ext == '.pdf':
            return ('PDF', '📄')
        if ext in preview_generator.ARCHIVE_TYPES:
            return ('ARCHIVE', '📦')
        if ext in preview_generator.DOCUMENT_TYPES:
            return ('DOC', '📄')
        return ('FILE', '📄')

    async def _return_placeholder(status: str, reason: Optional[str] = None):
        label, icon = _placeholder_meta()
        placeholder_bytes, media_type = preview_generator._generate_placeholder_preview(
            file_type=label,
            size=size_tuple,
            icon=icon
        )
        placeholder_cache_ttl = 3600
        await redis.setex(cache_key, placeholder_cache_ttl, placeholder_bytes)
        headers = {
            "Cache-Control": f"public, max-age={placeholder_cache_ttl}",
            "X-Cache": "MISS",
            "X-Preview-Status": status
        }
        if reason:
            headers["X-Preview-Reason"] = reason[:120]
        return Response(
            content=placeholder_bytes,
            media_type=media_type,
            headers=headers
        )

    # Step 1: For videos, check if transcoded version exists (faster preview generation)
    # Transcoded MP4s have metadata at the beginning (+faststart), making frame extraction instant
    from ..services.video_transcoder import video_transcoder

    mime = (file_obj.mime_type or '').lower()
    ext = os.path.splitext(file_obj.file_name or '')[1].lower()
    is_video = mime.startswith('video/') or ext in preview_generator.VIDEO_TYPES

    temp_file_path = None
    use_transcoded = False

    try:
        # For videos, prefer transcoded MP4 if available
        if is_video and video_transcoder.is_cached(file_id):
            transcoded_path = os.path.join(video_transcoder.OUTPUT_DIR, f"{file_id}.mp4")
            if os.path.exists(transcoded_path):
                logger.info(f"⚡ Using transcoded MP4 for preview generation: {file_obj.file_name}")
                temp_file_path = transcoded_path
                use_transcoded = True

        # If no transcoded version, use singleflight on-demand generation
        if not use_transcoded:
            result = await preview_service.generate_on_demand(
                file_id=file_id,
                file_obj=resolved,
                requested_size=size,
                redis_client=redis,
            )
            if result is None:
                return await _return_placeholder(
                    status="queued",
                    reason="generation_in_progress"
                )

            preview_bytes, content_type = result
            is_video_file = file_obj.mime_type and file_obj.mime_type.startswith('video/')
            cache_ttl = 604800 if is_video_file else 2592000
            return Response(
                content=preview_bytes,
                media_type=content_type,
                headers={
                    "Cache-Control": f"public, max-age={cache_ttl}",
                    "X-Cache": "MISS",
                    "X-Preview-Status": "generated"
                }
            )

        # Transcoded video path: generate single size directly
        try:
            preview_bytes, content_type = await preview_generator.generate_preview(
                file_path=temp_file_path,
                mime_type='video/mp4',
                size=size,
                file_name=file_obj.file_name
            )
        except Exception as exc:
            logger.error(f"Preview generation failed for {file_id}: {exc}", exc_info=True)
            return await _return_placeholder(
                status="error",
                reason=str(exc)
            )

        cache_ttl = 604800  # 7 days for video
        await redis.setex(cache_key, cache_ttl, preview_bytes)
        logger.info(f"Cached transcoded preview for {file_id} (size: {size})")

        return Response(
            content=preview_bytes,
            media_type=content_type,
            headers={
                "Cache-Control": f"public, max-age={cache_ttl}",
                "X-Cache": "MISS",
                "X-Preview-Status": "generated"
            }
        )

    finally:
        # No temp file cleanup needed for non-transcoded path (handled by preview_service)
        # For transcoded path, temp_file_path points to permanent cache - don't delete
        pass


@router.get("/{file_id}/preview/status")
async def get_preview_status(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Get the status of background preview generation for a file.

    Returns:
    - status: 'queued', 'processing', 'ready', 'failed', or 'unknown'
    - For ready status, the preview can be fetched from the preview endpoint
    - For queued/processing, the client should retry after the suggested delay
    """
    from ..database import get_redis

    redis = await get_redis()

    # First check if preview is already cached (ready)
    for size in ['small', 'medium', 'large']:
        cache_key = f"preview:{file_id}:{size}"
        if await redis.exists(cache_key):
            return {
                'status': 'ready',
                'file_id': file_id,
                'message': 'Preview is ready'
            }

    # Check status key
    status_key = f"preview:status:{file_id}"
    status_data = await redis.get(status_key)

    if status_data:
        try:
            if isinstance(status_data, bytes):
                status_data = status_data.decode('utf-8')
            status_info = json.loads(status_data)
            status = status_info.get('status', 'unknown')

            response = {
                'status': status,
                'file_id': file_id,
            }

            if status == 'queued':
                response['message'] = 'Preview is queued for generation'
                response['retry_after'] = 5
            elif status == 'processing':
                response['message'] = 'Preview is being generated'
                response['retry_after'] = 3
            elif status == 'failed':
                response['message'] = 'Preview generation failed'
                response['error'] = status_info.get('error', 'Unknown error')
            elif status == 'ready':
                response['message'] = 'Preview is ready'

            return response
        except (json.JSONDecodeError, KeyError):
            pass

    # No status found - preview hasn't been queued or status expired
    return {
        'status': 'unknown',
        'file_id': file_id,
        'message': 'No preview status found - preview will be generated on first request'
    }


@router.patch("/{file_id}/rename", response_model=FileResponse, dependencies=[Depends(create_rate_limiter(**RateLimitConfig.FILE_UPDATE))])
async def rename_file(
    file_id: str,
    rename_request: RenameRequest,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Rename a file

    - **file_id**: UUID of the file to rename
    - **name**: New file name
    """
    try:
        # Validate file name
        new_name = rename_request.name.strip()
        if not new_name:
            raise HTTPException(status_code=400, detail="File name cannot be empty")

        if len(new_name) > 255:
            raise HTTPException(status_code=400, detail="File name too long (max 255 characters)")

        # Check for invalid characters
        invalid_chars = ['<', '>', ':', '"', '/', '\\', '|', '?', '*']
        if any(char in new_name for char in invalid_chars):
            raise HTTPException(
                status_code=400,
                detail=f"File name contains invalid characters: {', '.join(invalid_chars)}"
            )

        # Get file and verify ownership
        result = await db.execute(
            select(Object).where(
                Object.id == file_id,
                Object.user_id == current_user.id
            )
        )
        file_obj = result.scalar_one_or_none()

        if not file_obj:
            raise HTTPException(status_code=404, detail="File not found")

        # Store old name for activity log
        old_name = file_obj.file_name

        # Check if name is actually different
        if old_name == new_name:
            raise HTTPException(status_code=400, detail="New name is the same as current name")

        # Check for duplicate name in same folder
        duplicate_check = await db.execute(
            select(Object).where(
                Object.user_id == current_user.id,
                Object.folder_id == file_obj.folder_id,
                Object.file_name == new_name,
                Object.id != file_id
            )
        )
        if duplicate_check.scalar_one_or_none():
            raise HTTPException(status_code=409, detail="A file with this name already exists in the same location")

        # Update file name and updated_at timestamp
        file_obj.file_name = new_name
        file_obj.updated_at = datetime.utcnow()

        await db.commit()
        await db.refresh(file_obj)

        # Log activity
        await log_activity(
            db,
            current_user.id,
            "file_renamed",
            str(file_id),
            {"old_name": old_name, "new_name": new_name},
            request
        )

        # Update Elasticsearch index with new name
        if search_service.connected:
            try:
                await search_service.index_file({
                    'id': str(file_obj.id),
                    'user_id': str(file_obj.user_id),
                    'name': file_obj.file_name,
                    'original_name': file_obj.file_name,
                    'size': file_obj.file_size,
                    'mime_type': file_obj.mime_type,
                    'storage_tier': file_obj.storage_tier or 'cache',
                    'folder_id': str(file_obj.folder_id) if file_obj.folder_id else None,
                    'created_at': file_obj.created_at.isoformat() if file_obj.created_at else None,
                    'updated_at': file_obj.updated_at.isoformat() if file_obj.updated_at else None,
                })
            except Exception as e:
                logger.warning(f"Failed to update search index after rename: {e}")

        # Return updated file details
        return FileResponse(
            id=str(file_obj.id),
            name=file_obj.file_name,
            size=file_obj.file_size,
            mime_type=file_obj.mime_type,
            folder_id=str(file_obj.folder_id) if file_obj.folder_id else None,
            storage_tier=file_obj.storage_tier,
            backup_status=file_obj.backup_status,
            created_at=file_obj.created_at,
            last_accessed=file_obj.last_accessed,
            updated_at=file_obj.updated_at,
            path=None,  # Can be computed if needed
            is_favorite=False  # Will be set by query if needed
        )

    except HTTPException:
        raise
    except Exception as e:
        await db.rollback()
        print(f"Rename error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to rename file: {str(e)}")


@router.get("/{file_id}/activity", dependencies=[Depends(create_rate_limiter(**RateLimitConfig.FILE_LIST))])
async def get_file_activity(
    file_id: str,
    limit: int = 50,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Get activity history for a specific file

    - **file_id**: UUID of the file
    - **limit**: Maximum number of activity records to return (default 50)
    """
    try:
        # First verify file exists and user has access
        result = await db.execute(
            select(Object).where(
                Object.id == file_id,
                Object.user_id == current_user.id
            )
        )
        file_obj = result.scalar_one_or_none()

        if not file_obj:
            raise HTTPException(status_code=404, detail="File not found")

        # Get activity logs for this file
        activity_result = await db.execute(
            select(ActivityLog)
            .where(
                ActivityLog.object_id == file_id,
                ActivityLog.user_id == current_user.id
            )
            .order_by(ActivityLog.created_at.desc())
            .limit(limit)
        )

        activities = activity_result.scalars().all()

        # Return activity list
        return [
            {
                "id": str(activity.id),
                "action": activity.action,
                "object_id": str(activity.object_id) if activity.object_id else None,
                "ip_address": activity.ip_address,
                "user_agent": activity.user_agent,
                "metadata": activity.meta_data,
                "created_at": activity.created_at,
            }
            for activity in activities
        ]

    except HTTPException:
        raise
    except Exception as e:
        print(f"Get file activity error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to get file activity: {str(e)}")


@router.delete("/{file_id}", dependencies=[Depends(create_rate_limiter(**RateLimitConfig.FILE_DELETE))])
async def delete_file(
    file_id: str,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Soft delete file - moves file to trash"""
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id, Object.is_deleted == False)
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    try:
        # Soft delete - mark as deleted and set timestamp
        file_obj.is_deleted = True
        file_obj.deleted_at = datetime.utcnow()
        file_name = file_obj.file_name

        # Log activity
        activity = ActivityLog(
            user_id=current_user.id,
            action="file_moved_to_trash",
            object_id=file_id,
            ip_address=request.client.host if request and request.client else None,
            user_agent=request.headers.get("user-agent") if request else None,
            meta_data={"file_name": file_name}
        )
        db.add(activity)

        await db.commit()

        # Remove from Elasticsearch index
        if search_service.connected:
            try:
                await search_service.delete_file(str(file_id))
            except Exception as e:
                logger.warning(f"Failed to remove file from search index: {e}")

        return {"status": "success", "message": "File moved to trash", "file_name": file_name}

    except Exception as e:
        await db.rollback()
        print(f"Delete error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/trash", response_model=List[FileResponse], dependencies=[Depends(create_rate_limiter(**RateLimitConfig.FILE_LIST))])
async def list_trash(
    request: Request,
    limit: int = 100,
    offset: int = 0,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List files in trash (soft-deleted files)"""
    # Query for deleted files
    query = select(Object).filter(
        Object.user_id == current_user.id,
        Object.is_deleted == True
    ).order_by(Object.deleted_at.desc()).limit(min(limit, 500)).offset(offset)

    result = await db.execute(query)
    files = result.scalars().all()

    # Get all file IDs for favorite check
    file_ids = [f.id for f in files]

    # Batch query for favorites
    favorites_result = await db.execute(
        select(Favorite.file_id).filter(
            Favorite.user_id == current_user.id,
            Favorite.file_id.in_(file_ids)
        )
    )
    favorite_file_ids = set(favorites_result.scalars().all())

    return [
        FileResponse(
            id=str(f.id),
            name=f.file_name,
            size=f.file_size,
            mime_type=f.mime_type,
            folder_id=str(f.folder_id) if f.folder_id else None,
            storage_tier=f.storage_tier or 'hot',
            backup_status=f.backup_status or 'none',
            created_at=f.created_at,
            last_accessed=f.last_accessed,
            updated_at=f.updated_at,
            path=f.object_path,
            is_favorite=(f.id in favorite_file_ids),
            # ZK encryption fields - Not applicable for storage-service files
            is_encrypted=False,
            encrypted_file_key=None,
            file_key_iv=None,
            encryption_algorithm=None,
            encryption_version=None,
            encryption_mode=f.encryption_mode or 'none',
        )
        for f in files
    ]


@router.post("/trash/{file_id}/restore", dependencies=[Depends(create_rate_limiter(**RateLimitConfig.FILE_UPDATE))])
async def restore_from_trash(
    file_id: str,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Restore a file from trash"""
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id, Object.is_deleted == True)
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found in trash")

    try:
        # Restore file
        file_obj.is_deleted = False
        file_obj.deleted_at = None
        file_name = file_obj.file_name

        # Log activity
        activity = ActivityLog(
            user_id=current_user.id,
            action="file_restored_from_trash",
            object_id=file_id,
            ip_address=request.client.host if request and request.client else None,
            user_agent=request.headers.get("user-agent") if request else None,
            meta_data={"file_name": file_name}
        )
        db.add(activity)

        await db.commit()

        # Re-index in Elasticsearch
        if search_service.connected:
            try:
                await search_service.index_file({
                    'id': str(file_obj.id),
                    'user_id': str(file_obj.user_id),
                    'name': file_obj.file_name,
                    'original_name': file_obj.file_name,
                    'size': file_obj.file_size,
                    'mime_type': file_obj.mime_type,
                    'storage_tier': file_obj.storage_tier or 'cache',
                    'folder_id': str(file_obj.folder_id) if file_obj.folder_id else None,
                    'created_at': file_obj.created_at.isoformat() if file_obj.created_at else None,
                    'updated_at': file_obj.updated_at.isoformat() if file_obj.updated_at else None,
                })
            except Exception as e:
                logger.warning(f"Failed to re-index restored file: {e}")

        return {"status": "success", "message": "File restored from trash", "file_name": file_name}

    except Exception as e:
        await db.rollback()
        print(f"Restore error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/trash/{file_id}/permanent", dependencies=[Depends(create_rate_limiter(**RateLimitConfig.FILE_DELETE))])
async def permanent_delete(
    file_id: str,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Permanently delete a file from trash - cannot be recovered"""
    redis_client = await get_redis()

    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id, Object.is_deleted == True)
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found in trash")

    try:
        # Dedup-aware deletion: promote a reference or decrement ref counts
        promoted = await promote_dedup_references(file_obj, db)

        if not promoted:
            # For references: decrement the original's blocks
            await decrement_dedup_ref_counts(file_obj, db)

            # Handle content_blocks with proper reference counting
            blocks_result = await db.execute(
                text("SELECT id, block_hash FROM content_blocks WHERE file_id = :file_id"),
                {"file_id": file_id}
            )
            file_blocks = blocks_result.fetchall()

            for block in file_blocks:
                await db.execute(
                    text("""
                        UPDATE content_blocks
                        SET reference_count = reference_count - 1
                        WHERE block_hash = :block_hash
                    """),
                    {"block_hash": block.block_hash}
                )

            # Delete blocks that are no longer referenced
            await db.execute(
                text("DELETE FROM content_blocks WHERE reference_count <= 0")
            )

            # Delete this file's block associations
            await db.execute(
                text("DELETE FROM content_blocks WHERE file_id = :file_id"),
                {"file_id": file_id}
            )

            # Handle different storage types
            if file_obj.storage_type == "inline":
                if file_obj.storage_key:
                    try:
                        await redis_client.delete(file_obj.storage_key)
                    except Exception as e:
                        print(f"Failed to delete from Redis: {e}")

            elif file_obj.storage_type == "single":
                if file_obj.object_path and os.path.exists(file_obj.object_path):
                    try:
                        os.remove(file_obj.object_path)
                    except Exception as e:
                        print(f"Failed to delete file: {e}")

            else:  # chunked / content_addressed
                if file_obj.chunk_info:
                    chunk_info = file_obj.chunk_info
                    upload_id = chunk_info.get("upload_id", str(file_obj.id))
                    chunk_count = chunk_info.get("count", 0)
                    chunk_paths = chunk_info.get("paths", {})

                    for i in range(chunk_count):
                        chunk_path = chunk_paths.get(str(i))
                        if not chunk_path:
                            shard = upload_id[:2] if len(upload_id) >= 2 else "00"
                            chunk_path = f"/app/storage/cache/{shard}/{upload_id}_chunk_{i}.enc"

                        if os.path.exists(chunk_path):
                            try:
                                os.remove(chunk_path)
                                print(f"Deleted chunk: {chunk_path}")
                            except Exception as e:
                                print(f"Failed to delete chunk {chunk_path}: {e}")

        # Delete optimized video file if it exists
        if file_obj.optimized_path and os.path.exists(file_obj.optimized_path):
            try:
                os.remove(file_obj.optimized_path)
            except Exception as e:
                print(f"Failed to delete optimized file: {e}")

        # Update user storage
        if hasattr(current_user, 'storage_used') and current_user.storage_used is not None:
            current_user.storage_used = max(0, current_user.storage_used - file_obj.file_size)

        # Invalidate cached quota so subsequent checks see fresh values
        try:
            await redis_client.delete(f"quota:{str(current_user.id)}")
        except Exception:
            pass

        # Store file metadata before deletion
        file_name = file_obj.file_name
        freed_space = file_obj.file_size

        # Delete related records first to avoid FK constraint violations
        # Only delete from tables that actually exist in the database
        await db.execute(
            text("DELETE FROM dlp_scan_logs WHERE file_id = :file_id"),
            {"file_id": file_id}
        )
        await db.execute(
            text("DELETE FROM virus_scan_logs WHERE file_id = :file_id"),
            {"file_id": file_id}
        )
        await db.execute(
            text("DELETE FROM favorites WHERE file_id = :file_id"),
            {"file_id": file_id}
        )
        await db.execute(
            text("DELETE FROM file_versions WHERE file_id = :file_id"),
            {"file_id": file_id}
        )
        await db.execute(
            text("DELETE FROM file_cluster_assignments WHERE file_id = :file_id"),
            {"file_id": file_id}
        )
        await db.execute(
            text("DELETE FROM file_similarities WHERE file_id = :file_id OR similar_file_id = :file_id"),
            {"file_id": file_id}
        )
        await db.execute(
            text("DELETE FROM share_bundle_files WHERE file_id = :file_id"),
            {"file_id": file_id}
        )
        await db.execute(
            text("DELETE FROM file_embeddings WHERE file_id = :file_id"),
            {"file_id": file_id}
        )
        await db.execute(
            text("DELETE FROM file_tags WHERE file_id = :file_id"),
            {"file_id": file_id}
        )
        await db.execute(
            text("DELETE FROM file_ocr WHERE file_id = :file_id"),
            {"file_id": file_id}
        )

        # Permanently delete the file object
        await db.delete(file_obj)

        # Log activity
        activity = ActivityLog(
            user_id=current_user.id,
            action="file_permanently_deleted",
            object_id=file_id,
            ip_address=request.client.host if request and request.client else None,
            user_agent=request.headers.get("user-agent") if request else None,
            meta_data={"file_name": file_name}
        )
        db.add(activity)

        await db.commit()

        return {"status": "success", "freed_space": freed_space, "message": "File permanently deleted"}

    except Exception as e:
        await db.rollback()
        print(f"Permanent delete error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/trash/empty", dependencies=[Depends(create_rate_limiter(**RateLimitConfig.FILE_DELETE))])
async def empty_trash(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Empty entire trash - permanently delete all files in trash"""
    redis_client = await get_redis()

    # Get all deleted files for current user
    result = await db.execute(
        select(Object).filter(Object.user_id == current_user.id, Object.is_deleted == True)
    )
    files = result.scalars().all()

    if not files:
        return {"status": "success", "deleted": 0, "freed_space": 0, "message": "Trash is already empty"}

    deleted_count = 0
    freed_space = 0

    try:
        batch_ids = {str(f.id) for f in files}

        for file_obj in files:
            try:
                # Dedup-aware deletion: promote a reference or decrement ref counts
                promoted = await promote_dedup_references(file_obj, db, exclude_ids=batch_ids)

                if promoted:
                    freed_space += file_obj.file_size
                    deleted_count += 1
                    if file_obj.optimized_path and os.path.exists(file_obj.optimized_path):
                        try:
                            os.remove(file_obj.optimized_path)
                        except Exception:
                            pass
                    continue

                # For references: decrement the original's blocks
                await decrement_dedup_ref_counts(file_obj, db)

                # Per-file block ref-count accounting
                blocks_result = await db.execute(
                    text("SELECT id, block_hash FROM content_blocks WHERE file_id = :file_id"),
                    {"file_id": str(file_obj.id)}
                )
                for block in blocks_result.fetchall():
                    await db.execute(
                        text("UPDATE content_blocks SET reference_count = reference_count - 1 WHERE block_hash = :hash"),
                        {"hash": block.block_hash}
                    )
                await db.execute(text("DELETE FROM content_blocks WHERE reference_count <= 0"))
                await db.execute(
                    text("DELETE FROM content_blocks WHERE file_id = :file_id"),
                    {"file_id": str(file_obj.id)}
                )

                # Handle storage cleanup
                if file_obj.storage_type == "inline":
                    if file_obj.storage_key:
                        try:
                            await redis_client.delete(file_obj.storage_key)
                        except Exception as e:
                            print(f"Failed to delete from Redis: {e}")

                elif file_obj.storage_type == "single":
                    if file_obj.object_path and os.path.exists(file_obj.object_path):
                        try:
                            os.remove(file_obj.object_path)
                        except Exception as e:
                            print(f"Failed to delete file: {e}")

                else:  # chunked / content_addressed
                    if file_obj.chunk_info:
                        chunk_info = file_obj.chunk_info
                        upload_id = chunk_info.get("upload_id", str(file_obj.id))
                        chunk_count = chunk_info.get("count", 0)
                        chunk_paths = chunk_info.get("paths", {})

                        for i in range(chunk_count):
                            chunk_path = chunk_paths.get(str(i))
                            if not chunk_path:
                                shard = upload_id[:2] if len(upload_id) >= 2 else "00"
                                chunk_path = f"/app/storage/cache/{shard}/{upload_id}_chunk_{i}.enc"

                            if os.path.exists(chunk_path):
                                try:
                                    os.remove(chunk_path)
                                except Exception as e:
                                    print(f"Failed to delete chunk: {e}")

                # Delete optimized video file if it exists
                if file_obj.optimized_path and os.path.exists(file_obj.optimized_path):
                    try:
                        os.remove(file_obj.optimized_path)
                    except Exception as e:
                        print(f"Failed to delete optimized file: {e}")

                freed_space += file_obj.file_size
                deleted_count += 1

            except Exception as e:
                print(f"Failed to cleanup file {file_obj.id}: {e}")

        # Delete related records first to avoid FK constraint violations
        file_ids = [str(f.id) for f in files]

        # Only delete from tables that actually exist in the database
        await db.execute(
            text("DELETE FROM dlp_scan_logs WHERE file_id = ANY(:file_ids)"),
            {"file_ids": file_ids}
        )
        await db.execute(
            text("DELETE FROM virus_scan_logs WHERE file_id = ANY(:file_ids)"),
            {"file_ids": file_ids}
        )
        await db.execute(
            text("DELETE FROM favorites WHERE file_id = ANY(:file_ids)"),
            {"file_ids": file_ids}
        )
        await db.execute(
            text("DELETE FROM file_versions WHERE file_id = ANY(:file_ids)"),
            {"file_ids": file_ids}
        )
        await db.execute(
            text("DELETE FROM file_cluster_assignments WHERE file_id = ANY(:file_ids)"),
            {"file_ids": file_ids}
        )
        await db.execute(
            text("DELETE FROM file_similarities WHERE file_id = ANY(:file_ids) OR similar_file_id = ANY(:file_ids)"),
            {"file_ids": file_ids}
        )
        await db.execute(
            text("DELETE FROM share_bundle_files WHERE file_id = ANY(:file_ids)"),
            {"file_ids": file_ids}
        )
        await db.execute(
            text("DELETE FROM file_embeddings WHERE file_id = ANY(:file_ids)"),
            {"file_ids": file_ids}
        )
        await db.execute(
            text("DELETE FROM file_tags WHERE file_id = ANY(:file_ids)"),
            {"file_ids": file_ids}
        )
        await db.execute(
            text("DELETE FROM file_ocr WHERE file_id = ANY(:file_ids)"),
            {"file_ids": file_ids}
        )

        # Batch delete database records
        for file_obj in files:
            await db.delete(file_obj)

        # Update user storage
        if hasattr(current_user, 'storage_used') and current_user.storage_used is not None:
            current_user.storage_used = max(0, current_user.storage_used - freed_space)

        # Invalidate cached quota so subsequent checks see fresh values
        try:
            await redis_client.delete(f"quota:{str(current_user.id)}")
        except Exception:
            pass

        # Log activity
        activity = ActivityLog(
            user_id=current_user.id,
            action="trash_emptied",
            object_id=None,
            ip_address=request.client.host if request and request.client else None,
            user_agent=request.headers.get("user-agent") if request else None,
            meta_data={"deleted_count": deleted_count, "freed_space": freed_space}
        )
        db.add(activity)

        await db.commit()

        return {"status": "success", "deleted": deleted_count, "freed_space": freed_space, "message": f"Emptied trash: {deleted_count} files permanently deleted"}

    except Exception as e:
        await db.rollback()
        print(f"Empty trash error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/bulk-delete", dependencies=[Depends(create_rate_limiter(**RateLimitConfig.FILE_DELETE))])
async def bulk_delete_files(
    request: Request,
    request_data: BulkDeleteRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Soft delete multiple files - move files to trash"""
    file_ids = request_data.file_ids

    if not file_ids:
        return {"deleted": 0, "deleted_files": [], "failed_files": []}

    deleted_count = 0
    deleted_files = []
    failed_files = []

    try:
        # Batch fetch all files at once (exclude already deleted)
        result = await db.execute(
            select(Object).filter(
                Object.id.in_(file_ids),
                Object.user_id == current_user.id,
                Object.is_deleted == False
            )
        )
        files = result.scalars().all()

        if not files:
            return {"deleted": 0, "deleted_files": [], "failed_files": file_ids}

        # Track found vs missing files
        found_ids = {str(f.id) for f in files}
        failed_files = [fid for fid in file_ids if fid not in found_ids]

        # Soft delete all files
        now = datetime.utcnow()
        for file_obj in files:
            file_obj.is_deleted = True
            file_obj.deleted_at = now
            deleted_count += 1
            deleted_files.append(str(file_obj.id))

        # Commit all changes once
        await db.commit()

        # Log activity
        if deleted_count > 0:
            await log_activity(
                db, current_user.id, "bulk_moved_to_trash", None,
                {"deleted_count": deleted_count},
                request
            )

        return {
            "deleted": deleted_count,
            "deleted_files": deleted_files,
            "failed_files": failed_files,
            "message": f"{deleted_count} files moved to trash"
        }

    except Exception as e:
        await db.rollback()
        print(f"Bulk delete error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{file_id}/copy", response_model=FileResponse, dependencies=[Depends(create_rate_limiter(**RateLimitConfig.FILE_UPDATE))])
async def copy_file(
    file_id: str,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Server-side file copy - efficient for large files

    - Creates a duplicate of the file with a new ID
    - Handles all storage types (inline, single)
    - Generates smart copy names (Copy, Copy 2, Copy 3, etc.)
    - Works seamlessly regardless of file size
    - Does not support Zero-Knowledge encrypted files
    """

    # Fetch original file
    result = await db.execute(
        select(Object).filter(
            Object.id == file_id,
            Object.user_id == current_user.id,
            Object.is_deleted == False
        )
    )
    original_file = result.scalar_one_or_none()

    if not original_file:
        raise HTTPException(status_code=404, detail="File not found")

    # Check if file is Zero-Knowledge encrypted
    if original_file.is_encrypted:
        raise HTTPException(
            status_code=400,
            detail="Copying Zero-Knowledge encrypted files is not currently supported. Please download and re-upload the file manually."
        )

    try:
        # Generate copy name
        base_name = original_file.file_name
        last_dot = base_name.rfind('.')
        if last_dot > 0:
            name_part = base_name[:last_dot]
            ext_part = base_name[last_dot:]
        else:
            name_part = base_name
            ext_part = ""

        # Check for existing copies in the same folder
        query = select(Object).filter(
            Object.user_id == current_user.id,
            Object.folder_id == original_file.folder_id,
            Object.is_deleted == False,
            Object.file_name.like(f"{name_part} (Copy%)%")
        )
        result = await db.execute(query)
        existing_copies = result.scalars().all()

        # Determine next copy number
        if not existing_copies:
            copy_name = f"{name_part} (Copy){ext_part}"
        else:
            # Extract numbers from existing copies
            import re
            numbers = []
            for copy in existing_copies:
                match = re.search(r'\(Copy(?: (\d+))?\)', copy.file_name)
                if match:
                    num = match.group(1)
                    numbers.append(int(num) if num else 1)

            next_num = max(numbers) + 1 if numbers else 2
            copy_name = f"{name_part} (Copy {next_num}){ext_part}"

        # Generate new encryption key for the copy
        new_file_key = encryption_service.generate_file_key()
        encrypted_new_key = encryption_service.encrypt_key(new_file_key)

        # Handle storage based on type
        new_storage_key = None
        new_object_path = None

        if original_file.storage_type == "inline":
            # For inline storage, decrypt and re-encrypt with new key
            import base64
            original_file_key = encryption_service.decrypt_key(original_file.encryption_key)
            original_encrypted_data = base64.b64decode(original_file.storage_key)
            decrypted_data = encryption_service.decrypt_file(original_encrypted_data, original_file_key)
            new_encrypted_data = encryption_service.encrypt_file(decrypted_data, new_file_key)
            new_storage_key = base64.b64encode(new_encrypted_data).decode('utf-8')

        elif original_file.storage_type == "single":
            # For single file storage, copy the file on disk
            if not original_file.object_path or not os.path.exists(original_file.object_path):
                raise HTTPException(status_code=404, detail="Original file data not found on disk")

            # Generate new storage path
            shard = "objects"
            storage_dir = os.path.join(settings.STORAGE_PATH, shard)
            os.makedirs(storage_dir, exist_ok=True)

            import uuid
            new_file_id = uuid.uuid4()
            new_filename = f"{new_file_id}.enc"
            new_object_path = os.path.join(storage_dir, new_filename)

            try:
                # Decrypt original file and re-encrypt with new key
                original_file_key = encryption_service.decrypt_key(original_file.encryption_key)

                file_size_mb = original_file.file_size / (1024 * 1024)
                logger.info(f"Copying file {original_file.file_name} ({file_size_mb:.2f} MB)...")

                # Strategy selection based on file size
                MEMORY_THRESHOLD = 2 * 1024 * 1024 * 1024  # 2 GB

                if original_file.file_size <= MEMORY_THRESHOLD:
                    # Small to medium files: load into memory (fastest)
                    logger.info(f"Using in-memory copy for file size {file_size_mb:.2f} MB")

                    async with aiofiles.open(original_file.object_path, 'rb') as src:
                        encrypted_data = await src.read()

                    # Decrypt with old key
                    decrypted_data = encryption_service.decrypt_data(encrypted_data, original_file_key)

                    # Re-encrypt with new key
                    new_encrypted_data = encryption_service.encrypt_data(decrypted_data, new_file_key)

                    # Write to new path
                    async with aiofiles.open(new_object_path, 'wb') as dst:
                        await dst.write(new_encrypted_data)

                    logger.info(f"In-memory copy completed successfully")

                else:
                    # Large files: use true chunked streaming (constant memory usage)
                    logger.info(f"Using chunked streaming copy for file size {file_size_mb:.2f} MB")

                    # Use 64 MB chunks (matches system CHUNK_SIZE)
                    CHUNK_SIZE = 64 * 1024 * 1024  # 64 MB
                    total_chunks = (original_file.file_size + CHUNK_SIZE - 1) // CHUNK_SIZE

                    logger.info(f"Processing {total_chunks} chunks of 64 MB each...")

                    try:
                        bytes_processed = 0
                        chunk_index = 0

                        # Open both files simultaneously for streaming
                        async with aiofiles.open(original_file.object_path, 'rb') as src, \
                                   aiofiles.open(new_object_path, 'wb') as dst:

                            while True:
                                # Read one 64 MB encrypted chunk
                                encrypted_chunk = await src.read(CHUNK_SIZE)
                                if not encrypted_chunk:
                                    break  # End of file

                                # Decrypt chunk with old key
                                decrypted_chunk = encryption_service.decrypt_chunk(
                                    encrypted_chunk,
                                    original_file_key,
                                    chunk_index
                                )

                                # Re-encrypt chunk with new key
                                new_encrypted_chunk = encryption_service.encrypt_chunk(
                                    decrypted_chunk,
                                    new_file_key,
                                    chunk_index
                                )

                                # Write encrypted chunk to new file
                                await dst.write(new_encrypted_chunk)

                                # Update progress
                                bytes_processed += len(encrypted_chunk)
                                chunk_index += 1

                                # Log progress every 10 chunks (~640 MB)
                                if chunk_index % 10 == 0:
                                    progress_pct = (bytes_processed / original_file.file_size) * 100
                                    progress_gb = bytes_processed / (1024 * 1024 * 1024)
                                    total_gb = original_file.file_size / (1024 * 1024 * 1024)
                                    logger.info(
                                        f"Progress: {progress_gb:.2f} GB / {total_gb:.2f} GB "
                                        f"({progress_pct:.1f}%) - {chunk_index}/{total_chunks} chunks"
                                    )

                                # Memory automatically cleared when chunk variables go out of scope

                        logger.info(f"Chunked streaming copy completed successfully: {chunk_index} chunks processed")

                    except Exception as chunk_error:
                        # If chunked copy fails, ensure partial file is cleaned up
                        logger.error(f"Chunked copy failed at chunk {chunk_index}: {chunk_error}")
                        raise chunk_error

            except Exception as copy_error:
                # Clean up destination file if copy failed
                if os.path.exists(new_object_path):
                    try:
                        os.remove(new_object_path)
                        logger.info(f"Cleaned up failed copy file: {new_object_path}")
                    except Exception:
                        pass

                # Re-raise the error
                raise copy_error

        else:
            raise HTTPException(status_code=400, detail=f"Unsupported storage type: {original_file.storage_type}")

        # Create new Object record
        new_file = Object(
            id=new_file_id if original_file.storage_type == "single" else None,
            user_id=current_user.id,
            folder_id=original_file.folder_id,
            file_name=copy_name,
            file_size=original_file.file_size,
            mime_type=original_file.mime_type,
            content_hash=original_file.content_hash,
            encryption_key=encrypted_new_key,
            storage_type=original_file.storage_type,
            storage_key=new_storage_key,
            object_path=new_object_path,
            file_metadata=original_file.file_metadata,
            storage_tier=original_file.storage_tier,
            versioning_enabled=original_file.versioning_enabled,
            is_encrypted=False,  # Not ZK encrypted
            upload_status="completed",
        )

        db.add(new_file)
        await db.commit()
        await db.refresh(new_file)

        # Log activity
        await log_activity(
            db, current_user.id, "file_copied", str(new_file.id),
            {
                "file_name": copy_name,
                "original_file_id": str(file_id),
                "original_file_name": original_file.file_name,
                "size": original_file.file_size,
            },
            request
        )

        logger.info(f"File copied successfully: {original_file.file_name} -> {copy_name} (size: {original_file.file_size} bytes)")

        # Return file response
        return FileResponse(
            id=str(new_file.id),
            name=new_file.file_name,
            size=new_file.file_size,
            mime_type=new_file.mime_type,
            created_at=new_file.created_at,
            last_accessed=new_file.last_accessed,
            storage_tier=new_file.storage_tier,
            folder_id=str(new_file.folder_id) if new_file.folder_id else None,
            is_favorite=False,  # New file, not favorited yet
            is_encrypted=False,
        )

    except HTTPException:
        raise
    except Exception as e:
        await db.rollback()
        logger.error(f"File copy error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to copy file: {str(e)}")


# ============================================================================
# ARQ STREAMING ENDPOINTS
# Automatic Repeat Request for reliable video streaming
# ============================================================================

@router.post("/{file_id}/stream/init")
async def init_arq_stream(
    file_id: str,
    chunk_size: Optional[int] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Initialize an ARQ streaming session for reliable video delivery.

    Returns session_id and chunk information for client-side ARQ handling.
    """
    from ..services.arq_streaming_service import arq_streaming_service
    from ..database import get_redis

    # Get file
    result = await db.execute(select(Object).filter(Object.id == file_id, Object.user_id == current_user.id))
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Determine file path (prefer optimized version for videos)
    file_path = None
    if file_obj.optimized_path and os.path.exists(file_obj.optimized_path):
        file_path = file_obj.optimized_path
    elif file_obj.object_path and os.path.exists(file_obj.object_path):
        file_path = file_obj.object_path
    else:
        raise HTTPException(
            status_code=400,
            detail="File not available for streaming (may require decryption)"
        )

    # Initialize Redis for session tracking
    redis = await get_redis()
    arq_streaming_service.set_redis(redis)

    # Create session
    try:
        session_info = await arq_streaming_service.init_stream_session(
            file_id=file_id,
            file_path=file_path,
            chunk_size=chunk_size
        )
        return session_info
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="File not found on disk")


@router.get("/{file_id}/stream/{session_id}/chunk/{chunk_index}")
async def get_stream_chunk(
    file_id: str,
    session_id: str,
    chunk_index: int,
    current_user: User = Depends(get_current_user)
):
    """
    Get a specific chunk with checksum for client verification.

    Returns chunk data with checksum header for ARQ validation.
    """
    from ..services.arq_streaming_service import arq_streaming_service

    try:
        chunk = await arq_streaming_service.get_chunk(session_id, chunk_index)

        headers = {
            "X-Chunk-Index": str(chunk.chunk_index),
            "X-Chunk-Checksum": chunk.checksum,
            "X-Chunk-Is-Last": str(chunk.is_last).lower(),
            "X-Byte-Range": f"{chunk.byte_start}-{chunk.byte_end}",
            "X-Total-Size": str(chunk.total_size),
            "Content-Length": str(len(chunk.data)),
            "Content-Type": "application/octet-stream"
        }

        return Response(
            content=chunk.data,
            media_type="application/octet-stream",
            headers=headers
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{file_id}/stream/{session_id}/ack")
async def ack_chunks(
    file_id: str,
    session_id: str,
    chunks: List[int],
    current_user: User = Depends(get_current_user)
):
    """
    Acknowledge successfully received chunks.

    Client calls this to confirm chunks were received correctly.
    """
    from ..services.arq_streaming_service import arq_streaming_service

    try:
        result = await arq_streaming_service.acknowledge_chunks(session_id, chunks)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{file_id}/stream/{session_id}/nack")
async def retransmit_chunks(
    file_id: str,
    session_id: str,
    chunks: List[int],
    current_user: User = Depends(get_current_user)
):
    """
    Request retransmission of lost or corrupt chunks.

    Client calls this when checksum validation fails or chunks are missing.
    """
    from ..services.arq_streaming_service import arq_streaming_service

    try:
        retransmitted = await arq_streaming_service.request_retransmit(session_id, chunks)

        return {
            "retransmitted_count": len(retransmitted),
            "chunks": [
                {
                    "chunk_index": c.chunk_index,
                    "checksum": c.checksum,
                    "size": len(c.data)
                }
                for c in retransmitted
            ]
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{file_id}/stream/{session_id}/status")
async def get_stream_status(
    file_id: str,
    session_id: str,
    current_user: User = Depends(get_current_user)
):
    """
    Get current streaming session status and statistics.
    """
    from ..services.arq_streaming_service import arq_streaming_service

    try:
        status = await arq_streaming_service.get_session_status(session_id)
        return status
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{file_id}/stream/{session_id}")
async def close_stream_session(
    file_id: str,
    session_id: str,
    current_user: User = Depends(get_current_user)
):
    """
    Close a streaming session and clean up resources.
    """
    from ..services.arq_streaming_service import arq_streaming_service

    try:
        await arq_streaming_service.close_session(session_id)
        return {"status": "closed", "session_id": session_id}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ============================================================================
# VIDEO PROCESSING STATUS ENDPOINT
# For frontend polling during proactive video optimization
# ============================================================================

@router.get("/{file_id}/video/status")
async def get_video_processing_status(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get video processing status for frontend polling.

    Returns current status of proactive video optimization:
    - 'queued': Waiting in processing queue
    - 'processing': FFmpeg transcoding in progress (includes progress %)
    - 'ready': Optimized version available for instant playback
    - 'failed': Processing failed (includes error message)
    - 'skipped': User has optimization disabled
    - null: Not a video or not processed
    """
    from ..services.video_ingestion_service import video_ingestion_service

    # Get file
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Check if it's a video
    mime_type = file_obj.mime_type or ''
    if not mime_type.startswith('video/'):
        return {
            "file_id": file_id,
            "status": "not_video",
            "message": "File is not a video"
        }

    # Get processing status
    status = await video_ingestion_service.get_processing_status(file_obj)

    return {
        "file_id": file_id,
        "file_name": file_obj.file_name,
        **status
    }


# ============================================================================
# LEGACY ZK: Zero-Knowledge file metadata and chunk download
# ============================================================================
# These endpoints serve ZK-style files stored in THIS service (Object with
# encrypted_file_key), e.g. from a legacy "upgrade to ZK" flow where data
# remained in storage-service. Primary ZK file operations (list, metadata,
# chunks, rename) for native ZK users are in zk-encryption-service.
# ============================================================================

@router.get("/{file_id}/zk/metadata")
async def get_zk_file_metadata(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get ZK file metadata for client-side decryption.

    Returns:
        - encrypted_file_key: Client decrypts with master key
        - file_key_iv: IV for file key decryption
        - file_size: Total file size
        - chunk_count: Number of chunks
        - chunk_size: Size of each chunk
        - mime_type: File MIME type
    """
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Verify this is a ZK-encrypted file
    if not file_obj.encrypted_file_key:
        raise HTTPException(
            status_code=400,
            detail="This is not a Zero-Knowledge encrypted file"
        )

    # Get chunk info
    chunk_info = file_obj.chunk_info or {}
    chunk_count = chunk_info.get("count", 1)

    # Get chunk size from upload session info (stored in chunk_info)
    # Default to 32MB which is the standard upload chunk size
    chunk_size = chunk_info.get("chunk_size", CHUNK_SIZE)

    return {
        "file_id": file_id,
        "filename": file_obj.file_name,
        "file_size": file_obj.file_size,
        "mime_type": file_obj.mime_type or "application/octet-stream",
        "encrypted_file_key": file_obj.encrypted_file_key,
        "file_key_iv": file_obj.file_key_iv,
        "encryption_algorithm": file_obj.encryption_algorithm or "AES-256-GCM",
        "chunk_count": chunk_count,
        "chunk_size": chunk_size,
        "is_encrypted": True
    }


@router.get("/{file_id}/zk/chunk/{chunk_index}")
async def download_zk_chunk(
    file_id: str,
    chunk_index: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Download a single encrypted chunk for ZK files.

    Returns raw encrypted chunk data for client-side decryption.
    The server NEVER decrypts ZK file contents.

    Args:
        file_id: File UUID
        chunk_index: Chunk number (0-based)

    Returns:
        Raw encrypted chunk bytes
    """
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Verify this is a ZK-encrypted file
    if not file_obj.encrypted_file_key:
        raise HTTPException(
            status_code=400,
            detail="This is not a Zero-Knowledge encrypted file. Use the standard download endpoint."
        )

    # Get chunk path from chunk_info
    chunk_info = file_obj.chunk_info or {}
    chunk_paths = chunk_info.get("paths", {})

    if str(chunk_index) not in chunk_paths:
        # Fallback 1: ZK service path format (user_id/file_id/chunk_N.enc)
        zk_path = f"/app/storage/zk/{current_user.id}/{file_id}/chunk_{chunk_index}.enc"
        if os.path.exists(zk_path):
            chunk_paths[str(chunk_index)] = zk_path
        else:
            # Fallback 2: Storage service path format (tier/shard/upload_id_chunk_N.enc)
            upload_id = chunk_info.get("upload_id")
            if upload_id:
                shard = upload_id[:2]
                for tier in ["cache", "hot", "warm", "cold"]:
                    fallback_path = f"/app/storage/{tier}/{shard}/{upload_id}_chunk_{chunk_index}.enc"
                    if os.path.exists(fallback_path):
                        chunk_paths[str(chunk_index)] = fallback_path
                        break

    chunk_path = chunk_paths.get(str(chunk_index))

    if not chunk_path or not os.path.exists(chunk_path):
        raise HTTPException(
            status_code=404,
            detail=f"Chunk {chunk_index} not found"
        )

    # Read and return encrypted chunk
    async with aiofiles.open(chunk_path, 'rb') as f:
        chunk_data = await f.read()

    return Response(
        content=chunk_data,
        media_type="application/octet-stream",
        headers={
            "Content-Length": str(len(chunk_data)),
            "X-Chunk-Index": str(chunk_index),
            "X-File-Encrypted": "true",
            "X-Encryption-Algorithm": file_obj.encryption_algorithm or "AES-256-GCM"
        }
    )
