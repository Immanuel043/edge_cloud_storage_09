# services/storage-service/app/routers/files.py

from fastapi import APIRouter, Depends, HTTPException, Request,Header, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import List, Optional
import os
import json
from datetime import datetime
from ..dependencies import get_db, log_activity, get_current_user
from ..services.storage import storage_service
from ..services.encryption import encryption_service
from ..models.database import User, Object
from ..models.schemas import FileResponse
from ..database import get_redis
from ..config import settings
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


router = APIRouter(prefix="/api/v1/files", tags=["files"])

@router.get("/", response_model=List[FileResponse])
async def list_files(
    folder_id: Optional[str] = None,
    current_user: User = Depends(get_current_user),  # Use get_current_user from dependencies
    db: AsyncSession = Depends(get_db),
):
    """List user's files"""
    query = select(Object).filter(Object.user_id == current_user.id)
    if folder_id:
        query = query.filter(Object.folder_id == folder_id)
    else:
        query = query.filter(Object.folder_id == None)
    
    result = await db.execute(query)
    files = result.scalars().all()
    
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
    """Stream byte range from chunked storage."""
    chunk_info = file_obj.chunk_info or {}
    
    # Get chunk metadata
    upload_id = chunk_info.get("upload_id", str(file_obj.id))
    total_chunks = chunk_info.get("count", 0)
    chunk_paths = chunk_info.get("paths", {})
    
    if total_chunks == 0:
        raise HTTPException(status_code=500, detail="No chunks found")
    
    # Determine chunk size (from first chunk or estimate)
    estimated_chunk_size = file_obj.file_size // total_chunks if total_chunks > 1 else file_obj.file_size
    
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
@router.head("/{file_id}/download")
async def download_file(
    file_id: str,
    request: Request,
    range: Optional[str] = Header(None),
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
    parsed_range = await parse_range_header(range, total_size)
    
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
        if file_obj.metadata and file_obj.metadata.get("compressed", False):
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
        if file_obj.metadata and file_obj.metadata.get("compressed", False):
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
    
    # CHUNKED STORAGE
    elif file_obj.storage_type == "chunked":
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
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get file preview with support for all storage types"""
    import base64
    import aiofiles
    
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    file_obj = result.scalar_one_or_none()
    
    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")
    
    if not file_obj.mime_type or not file_obj.mime_type.startswith('image/'):
        raise HTTPException(status_code=400, detail="Preview only available for images")
    
    file_key = encryption_service.decrypt_key(file_obj.encryption_key)
    
    # Check if file was compressed
    was_compressed = False
    if file_obj.metadata and isinstance(file_obj.metadata, dict):
        was_compressed = file_obj.metadata.get("compressed", False)
    elif file_obj.chunk_info and isinstance(file_obj.chunk_info, dict):
        was_compressed = file_obj.chunk_info.get("compressed", False)
    
    async def stream_preview():
        """Stream preview content based on storage type"""
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
            
            yield file_data
        
        else:  # chunked
            # For preview, we might want to limit to first chunk or few chunks
            chunk_info = file_obj.chunk_info
            upload_id = chunk_info.get("upload_id", str(file_obj.id))
            chunk_count = min(chunk_info.get("count", 0), 2)  # Limit preview to first 2 chunks
            chunk_paths = chunk_info.get("paths", {})
            
            for i in range(chunk_count):
                # Get chunk path from stored paths or construct it
                chunk_path = chunk_paths.get(str(i))
                
                if not chunk_path:
                    # Fallback: construct path if not stored
                    shard = upload_id[:2]
                    chunk_path = f"/app/storage/cache/{shard}/{upload_id}_chunk_{i}.enc"
                
                # Verify chunk exists
                if not os.path.exists(chunk_path):
                    error_msg = f"Chunk {i} not found at path: {chunk_path}"
                    print(f"ERROR: {error_msg}")
                    raise HTTPException(404, error_msg)
                
                # Read encrypted chunk
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
        stream_preview(),
        media_type=file_obj.mime_type,
    )

@router.delete("/{file_id}")
async def delete_file(
    file_id: str,
    current_user: User = Depends(get_current_user),  # Fixed
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Delete file with support for all storage types"""
    redis_client = await get_redis()
    
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    file_obj = result.scalar_one_or_none()
    
    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")
    
    # Handle different storage types
    if file_obj.storage_type == "inline":
        if file_obj.storage_key:
            await redis_client.delete(file_obj.storage_key)
    
    elif file_obj.storage_type == "single":
        if file_obj.object_path and os.path.exists(file_obj.object_path):
            try:
                os.remove(file_obj.object_path)
            except Exception as e:
                print(f"Failed to delete file: {e}")
    
    else:  # chunked
        if file_obj.chunk_info:
            for chunk_hash in file_obj.chunk_info.get("chunks", []):
                refs = await redis_client.decr(f"chunk:refs:{chunk_hash}")
                if refs <= 0:
                    chunk_info = await redis_client.get(f"chunk:{chunk_hash}")
                    if chunk_info:
                        chunk_data = json.loads(chunk_info)
                        try:
                            os.remove(chunk_data["path"])
                        except Exception:
                            pass
                        await redis_client.delete(f"chunk:{chunk_hash}")
                        await redis_client.delete(f"chunk:refs:{chunk_hash}")
    
    # Update user storage and delete from DB
    current_user.storage_used -= file_obj.file_size
    await db.delete(file_obj)
    await db.commit()
    
    await log_activity(
        db, current_user.id, "file_deleted", str(file_id),
        {"file_name": file_obj.file_name, "storage_type": file_obj.storage_type},
        request
    )
    
    return {"status": "success", "freed_space": file_obj.file_size}

@router.post("/bulk-delete")
async def bulk_delete_files(
    request_data: BulkDeleteRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Delete multiple files"""
    file_ids = request_data.file_ids
    redis_client = await get_redis()
    deleted_count = 0
    freed_space = 0
    
    for file_id in file_ids:
        result = await db.execute(
            select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
        )
        file_obj = result.scalar_one_or_none()
        
        if file_obj:
            # Handle different storage types (same logic as single delete)
            if file_obj.storage_type == "inline":
                if file_obj.storage_key:
                    await redis_client.delete(file_obj.storage_key)
            
            elif file_obj.storage_type == "single":
                if file_obj.object_path and os.path.exists(file_obj.object_path):
                    try:
                        os.remove(file_obj.object_path)
                    except Exception:
                        pass
            
            else:  # chunked
                if file_obj.chunk_info:
                    for chunk_hash in file_obj.chunk_info.get("chunks", []):
                        refs = await redis_client.decr(f"chunk:refs:{chunk_hash}")
                        if refs <= 0:
                            chunk_info = await redis_client.get(f"chunk:{chunk_hash}")
                            if chunk_info:
                                chunk_data = json.loads(chunk_info)
                                try:
                                    os.remove(chunk_data["path"])
                                except Exception:
                                    pass
                                await redis_client.delete(f"chunk:{chunk_hash}")
                                await redis_client.delete(f"chunk:refs:{chunk_hash}")
            
            freed_space += file_obj.file_size
            await db.delete(file_obj)
            deleted_count += 1
    
    current_user.storage_used -= freed_space
    await db.commit()
    
    return {"deleted": deleted_count, "freed_space": freed_space}