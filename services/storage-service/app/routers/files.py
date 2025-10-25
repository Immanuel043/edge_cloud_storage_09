# services/storage-service/app/routers/files.py

from fastapi import APIRouter, Depends, HTTPException, Request,Header, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select,text
from typing import List, Optional
import os
import json
from datetime import datetime
from ..dependencies import get_db, log_activity, get_current_user
from ..services.storage import storage_service
from ..services.encryption import encryption_service
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
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Production-ready download endpoint with:
    - HTTP Range support for resumable downloads
    - HEAD request support for metadata
    - Efficient streaming for all storage types
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
    
    # Common headers
    base_headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": mime_type,
        "Content-Disposition": f'attachment; filename="{filename}"',
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

        # ---------- FALLBACK: encrypted or non-offloadable file: decrypt & stream in Python ----------
        # Read on-disk encrypted file, decrypt and stream. Support Range if requested.
        async with aiofiles.open(file_obj.object_path, "rb") as f:
            encrypted_data = await f.read()

        
        data = encryption_service.decrypt_file(encrypted_data, file_key)
        
        # Handle compression
        if file_obj.file_metadata and isinstance(file_obj.file_metadata, dict) and file_obj.file_metadata.get("compressed", False):
            from ..utils.compression import compressor
            data = compressor.decompress(data)
        
        # Convert to streaming response
        async def stream_decrypted_data():
            if parsed_range:
                start, end = parsed_range
                yield data[start:end + 1]
            else:
                # Stream in chunks to avoid memory issues
                chunk_size = 1024 * 1024  # 1MB chunks
                for i in range(0, len(data), chunk_size):
                    yield data[i:i + chunk_size]
        
        if parsed_range:
            start, end = parsed_range
            headers = {
                **base_headers,
                "Content-Range": f"bytes {start}-{end}/{total_size}",
                "Content-Length": str(end - start + 1),
            }
            return StreamingResponse(
                stream_decrypted_data(),
                status_code=206,
                headers=headers,
                media_type=mime_type
            )
        else:
            headers = {
                **base_headers,
                "Content-Length": str(total_size),
            }
            return StreamingResponse(
                stream_decrypted_data(),
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

        if parsed_range:
            start, end = parsed_range
            content_length = end - start + 1
            headers = {
                **base_headers,
                "Content-Range": f"bytes {start}-{end}/{total_size}",
                "Content-Length": str(content_length),
            }
            generator = stream_chunked_range(
                file_obj, start, end, file_key, encryption_service
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
            generator = stream_chunked_range(
                file_obj, 0, total_size - 1, file_key, encryption_service
            )
            return StreamingResponse(
                generator,
                status_code=200,
                headers=headers,
                media_type=mime_type
            )
    
    else:
        raise HTTPException(status_code=500, detail="Unknown storage type")


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
                "X-Cache": "HIT"
            }
        )

    logger.info(f"❌ Preview cache MISS for {file_id} (size: {size}) - generating...")

    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    file_key = encryption_service.decrypt_key(file_obj.encryption_key)

    # Check if file was compressed
    was_compressed = False
    if file_obj.file_metadata and isinstance(file_obj.file_metadata, dict):
        was_compressed = file_obj.file_metadata.get("compressed", False)
    elif file_obj.chunk_info and isinstance(file_obj.chunk_info, dict):
        was_compressed = file_obj.chunk_info.get("compressed", False)

    # Step 1: Download and decrypt the file to a temporary location
    temp_file_path = None
    try:
        # Create temp file
        temp_fd, temp_file_path = tempfile.mkstemp()
        os.close(temp_fd)  # Close file descriptor

        # Download/decrypt file based on storage type
        if file_obj.storage_type == "inline":
            # Decrypt inline data
            encrypted_data = base64.b64decode(file_obj.storage_key)
            file_data = encryption_service.decrypt_file(encrypted_data, file_key)

            # Decompress if needed
            if was_compressed:
                from ..utils.compression import compressor
                file_data = compressor.decompress(file_data)

            # Write to temp file
            async with aiofiles.open(temp_file_path, 'wb') as f:
                await f.write(file_data)

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

            # Write to temp file
            async with aiofiles.open(temp_file_path, 'wb') as f:
                await f.write(file_data)

        else:  # chunked
            # Reconstruct full file from chunks
            chunk_info = file_obj.chunk_info
            if not chunk_info:
                raise HTTPException(404, "File chunk info not found")

            upload_id = chunk_info.get("upload_id", str(file_obj.id))
            chunk_count = chunk_info.get("count", 0)
            chunk_paths = chunk_info.get("paths", {})

            async with aiofiles.open(temp_file_path, 'wb') as temp_f:
                for i in range(chunk_count):
                    # Get chunk path from stored paths or construct it
                    chunk_path = chunk_paths.get(str(i))

                    if not chunk_path:
                        # Fallback: construct path if not stored
                        shard = upload_id[:2]
                        chunk_path = f"/app/storage/cache/{shard}/{upload_id}_chunk_{i}.enc"

                    # Verify chunk exists
                    if not os.path.exists(chunk_path):
                        error_msg = f"Chunk {i} not found - file may be corrupted or upload incomplete"
                        print(f"ERROR: {error_msg} - path: {chunk_path}")
                        raise HTTPException(404, "File data not found - may be corrupted or incomplete")

                    # Read encrypted chunk
                    async with aiofiles.open(chunk_path, 'rb') as f:
                        encrypted_chunk = await f.read()

                    # Decrypt chunk
                    decrypted_chunk = encryption_service.decrypt_chunk(encrypted_chunk, file_key, i)

                    # Decompress if needed
                    if was_compressed:
                        from ..utils.compression import compressor
                        decrypted_chunk = compressor.decompress(decrypted_chunk)

                    # Write chunk to temp file
                    await temp_f.write(decrypted_chunk)

        # Step 2: Generate preview using preview_generator
        preview_bytes, content_type = await preview_generator.generate_preview(
            file_path=temp_file_path,
            mime_type=file_obj.mime_type,
            size=size,
            file_name=file_obj.file_name
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
                "X-Cache": "MISS"
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