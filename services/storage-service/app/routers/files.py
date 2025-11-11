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
from ..services.download_optimizer import download_optimizer
from ..models.database import User, Object, ActivityLog, Favorite
from ..models.schemas import FileResponse
from ..database import get_redis
from ..config import settings
from ..utils.rate_limiter_v2 import create_rate_limiter, RateLimitConfig
from pydantic import BaseModel
import re
import base64
import aiofiles
from typing import Optional, Tuple, AsyncGenerator

RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")
USE_X_ACCEL = bool(os.environ.get("USE_X_ACCEL", False))
NGINX_STORAGE_BASE = "/app/storage"  # must match nginx alias path

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
        )
        for f in files
    ]

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
                # Convergent encryption - key is derived from plaintext content
                from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
                from cryptography.hazmat.backends import default_backend
                import hashlib
                import hmac

                # Extract nonce (12 bytes), tag (16 bytes), and ciphertext
                nonce = encrypted_data[:12]
                tag = encrypted_data[12:28]
                ciphertext = encrypted_data[28:]

                # For convergent encryption, we need to derive the key from the plaintext
                # But we don't have plaintext yet - we need to use the block hash
                # The block hash is the SHA256 of the plaintext, which was used to derive the key

                # Reconstruct block key using the same method as encryption
                user_id = str(file_obj.user_id)

                # The key derivation uses the plaintext hash (which is block_hash)
                # Convert block_hash (hex string) to bytes for key derivation
                content_hash_bytes = bytes.fromhex(block_hash)

                # User-specific salt (same as encryption)
                salt = hashlib.sha256(f"dedup_user_{user_id}_salt".encode()).digest()

                # Derive the key using PBKDF2 (same as encryption)
                block_key = hashlib.pbkdf2_hmac('sha256', content_hash_bytes, salt, 100000, dklen=32)

                # Decrypt using AES-GCM
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

    # Decrypt key
    file_key = encryption_service.decrypt_key(file_obj.encryption_key)
    
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
    
    # Handle HEAD request
    if request.method == "HEAD":
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
    if compatible and mime_type.startswith('video/'):
        from ..services.video_transcoder import video_transcoder, VideoTranscodeError
        try:
            compat_path = await video_transcoder.get_or_create_stream(
                file_obj=file_obj,
                encryption_service=encryption_service
            )
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
    if file_obj.storage_type == "inline":
        # Decode and decrypt inline data
        encrypted_data = base64.b64decode(file_obj.storage_key)
        data = encryption_service.decrypt_file(encrypted_data, file_key)
        
        # Handle compression
        if file_obj.file_metadata and isinstance(file_obj.file_metadata, dict) and file_obj.file_metadata.get("compressed", False):
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
    elif file_obj.storage_type == "single":
        # Ensure on-disk path exists
        if not os.path.exists(file_obj.object_path):
            raise HTTPException(status_code=404, detail="File not found on disk")

        # If configured, offload plain (non-encrypted) files to nginx via X-Accel-Redirect.
        # Requires: USE_X_ACCEL=True in env and a boolean flag on the object (e.g. on_disk_plain)
        if USE_X_ACCEL and getattr(file_obj, "on_disk_plain", False):
            # Compute relative path under the storage base that nginx alias maps to.
            # NGINX_STORAGE_BASE must match nginx 'alias' path (e.g. /app/storage)
            internal_rel = os.path.relpath(file_obj.object_path, NGINX_STORAGE_BASE)
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
        was_compressed = file_obj.file_metadata and isinstance(file_obj.file_metadata, dict) and file_obj.file_metadata.get("compressed", False)

        if parsed_range:
            start, end = parsed_range
            headers = {
                **base_headers,
                "Content-Range": f"bytes {start}-{end}/{total_size}",
                "Content-Length": str(end - start + 1),
            }
            generator = download_optimizer.stream_single_file_optimized(
                file_path=file_obj.object_path,
                file_key=file_key,
                encryption_service=encryption_service,
                start_byte=start,
                end_byte=end,
                compressed=was_compressed
            )
            return StreamingResponse(
                generator,
                status_code=206,
                headers=headers,
                media_type=mime_type
            )
        else:
            headers = {
                **base_headers,
                "Content-Length": str(total_size),
            }
            generator = download_optimizer.stream_single_file_optimized(
                file_path=file_obj.object_path,
                file_key=file_key,
                encryption_service=encryption_service,
                start_byte=0,
                end_byte=total_size - 1,
                compressed=was_compressed
            )
            return StreamingResponse(
                generator,
                status_code=200,
                headers=headers,
                media_type=mime_type
            )
    
    # CHUNKED STORAGE (includes content_addressed and deduplicated_reference from deduplication)
    elif file_obj.storage_type in ("chunked", "content_addressed", "deduplicated_reference"):
        # Validate that chunk_info exists
        if not file_obj.chunk_info or not isinstance(file_obj.chunk_info, dict):
            raise HTTPException(
                status_code=500,
                detail="File deduplication is incomplete. Please re-upload the file."
            )

        # OPTIMIZED: Use parallel chunk decryption (4x faster)
        if parsed_range:
            start, end = parsed_range
            content_length = end - start + 1
            headers = {
                **base_headers,
                "Content-Range": f"bytes {start}-{end}/{total_size}",
                "Content-Length": str(content_length),
            }
            generator = download_optimizer.stream_chunked_file_parallel(
                file_obj=file_obj,
                file_key=file_key,
                encryption_service=encryption_service,
                start_byte=start,
                end_byte=end
            )
            return StreamingResponse(
                generator,
                status_code=206,
                headers=headers,
                media_type=mime_type
            )
        else:
            headers = {
                **base_headers,
                "Content-Length": str(total_size),
            }
            generator = download_optimizer.stream_chunked_file_parallel(
                file_obj=file_obj,
                file_key=file_key,
                encryption_service=encryption_service,
                start_byte=0,
                end_byte=total_size - 1
            )
            return StreamingResponse(
                generator,
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

    Features:
    - Redis caching for fast repeated access (7-30 day TTL)
    - Optimized video processing with ffmpeg
    - Async generation to avoid blocking
    """
    from ..services.preview_generator import preview_generator
    from ..services.preview_optimizer import preview_optimizer
    import base64
    import aiofiles
    import tempfile
    from ..database import get_redis

    # Get Redis client
    redis = await get_redis()

    # Check cache first
    cache_key = f"preview:{file_id}:{size}"
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

    # Step 1: OPTIMIZED partial download for large files
    # For 400MB video: downloads only 10MB instead of 400MB (98% faster)
    temp_file_path = None
    try:
        temp_file_path, is_complete = await preview_optimizer.download_partial_for_preview(
            file_obj=file_obj,
            encryption_service=encryption_service
        )

        # If download returned None, it means the file is too large for sync preview
        if temp_file_path is None:
            logger.info(
                f"⏳ Preview queued for background processing: {file_obj.file_name} "
                f"({file_obj.file_size/1024/1024:.1f}MB) - returning placeholder"
            )

            return await _return_placeholder(
                status="queued",
                reason="partial_download_unavailable"
            )

        if not is_complete:
            logger.info(
                f"⚡ Using partial download for preview "
                f"(saved {(file_obj.file_size - os.path.getsize(temp_file_path)) / 1024 / 1024:.1f}MB)"
            )

        # Step 2: Generate preview using preview_generator
        try:
            preview_bytes, content_type = await preview_generator.generate_preview(
                file_path=temp_file_path,
                mime_type=file_obj.mime_type,
                size=size,
                file_name=file_obj.file_name
            )
        except Exception as exc:
            logger.error(f"Preview generation failed for {file_id}: {exc}", exc_info=True)
            return await _return_placeholder(
                status="error",
                reason=str(exc)
            )

        # Step 3: Cache the generated preview in Redis
        # TTL: 7 days for videos (large, expensive to generate), 30 days for images/docs
        is_video = file_obj.mime_type and file_obj.mime_type.startswith('video/')
        cache_ttl = 604800 if is_video else 2592000  # 7 days vs 30 days

        await redis.setex(cache_key, cache_ttl, preview_bytes)
        logger.info(f"📦 Cached preview for {file_id} (size: {size}, TTL: {cache_ttl}s)")

        # Step 4: Return preview
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
        # Clean up temp file
        if temp_file_path and os.path.exists(temp_file_path):
            try:
                os.remove(temp_file_path)
            except Exception as e:
                print(f"Warning: Failed to cleanup temp file {temp_file_path}: {e}")


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
            storage_tier=f.storage_tier,
            backup_status=f.backup_status,
            created_at=f.created_at,
            last_accessed=f.last_accessed,
            updated_at=f.updated_at,
            path=f.object_path,
            is_favorite=(f.id in favorite_file_ids),
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

        else:  # chunked
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

        # Update user storage
        if hasattr(current_user, 'storage_used') and current_user.storage_used is not None:
            current_user.storage_used = max(0, current_user.storage_used - file_obj.file_size)

        # Store file metadata before deletion
        file_name = file_obj.file_name
        freed_space = file_obj.file_size

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
        for file_obj in files:
            try:
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

                else:  # chunked
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

                freed_space += file_obj.file_size
                deleted_count += 1

            except Exception as e:
                print(f"Failed to cleanup file {file_obj.id}: {e}")

        # Batch delete database records
        for file_obj in files:
            await db.delete(file_obj)

        # Update user storage
        if hasattr(current_user, 'storage_used') and current_user.storage_used is not None:
            current_user.storage_used = max(0, current_user.storage_used - freed_space)

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
        new_file_key = encryption_service.generate_key()
        encrypted_new_key = encryption_service.encrypt_key(new_file_key)

        # Handle storage based on type
        new_storage_key = None
        new_object_path = None

        if original_file.storage_type == "inline":
            # For inline storage, copy the encrypted data directly
            new_storage_key = original_file.storage_key

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
