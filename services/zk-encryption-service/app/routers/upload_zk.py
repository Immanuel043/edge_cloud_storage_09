"""
Zero-Knowledge Upload Coordination Endpoints

Coordinates upload of client-encrypted files to storage-service.
The ZK service NEVER sees plaintext data - all encryption happens client-side.

Upload Flow (Client-Side Encryption):
1. Client generates random file key (AES-256)
2. Client encrypts file with file key (AES-256-GCM)
3. Client encrypts file key with master key
4. Client sends encrypted file key to ZK service
5. ZK service stores encrypted file key in database
6. ZK service forwards encrypted chunks to storage-service
7. Storage-service stores encrypted chunks (cannot decrypt)

Security Properties:
- Server never sees plaintext file content
- Server never sees file encryption key
- Only user's master key can decrypt file keys
- Master key exists only in client's sessionStorage
"""
import structlog
from typing import Optional
from uuid import uuid4, UUID
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Form
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update
import httpx

from app.config import settings
from app.database import get_db
from app.dependencies import get_current_zk_user
from app.services.bandwidth_throttle import bandwidth_throttle_service

logger = structlog.get_logger()

router = APIRouter()


# ========== REQUEST/RESPONSE MODELS ==========

class InitUploadRequest(BaseModel):
    """Request to initialize ZK upload"""
    # V2: Pre-generated uploadId for AAD (optional - server generates if not provided)
    upload_id: Optional[str] = None

    # Encrypted filename (client-side encrypted with filename key derived from master key)
    encrypted_file_name: str = Field(..., max_length=1024)  # Base64 encoded encrypted filename
    file_name_iv: str = Field(..., max_length=64)  # Base64 encoded IV for filename encryption
    file_size: int = Field(..., gt=0, le=1_099_511_627_776)  # Max 1TB
    mime_type: str = Field(..., max_length=100)
    encrypted_file_key: str  # Base64 encoded - file key encrypted with master key
    file_key_iv: str  # Base64 encoded - IV used for file key encryption
    parent_folder_id: Optional[str] = None

    # File encryption metadata (for client reference)
    encryption_algorithm: str = Field(default="AES-256-GCM")
    encryption_version: int = Field(default=2, ge=1, le=2)  # 1=V1 (basic), 2=V2 (HKDF+AAD) - default V2
    chunk_size: int = Field(default=1048576, ge=65536, le=10_485_760)  # 64KB-10MB

    # ZK Thumbnail (client-side generated and encrypted with derived key)
    encrypted_thumbnail: Optional[str] = None  # Base64 encoded encrypted thumbnail
    thumbnail_iv: Optional[str] = None  # Base64 encoded IV for thumbnail
    thumbnail_width: Optional[int] = Field(default=None, ge=1, le=4096)
    thumbnail_height: Optional[int] = Field(default=None, ge=1, le=4096)


class InitUploadResponse(BaseModel):
    """Response for upload initialization"""
    upload_id: str
    file_id: str
    chunk_size: int
    max_chunks: int
    storage_upload_id: str  # Upload ID from storage-service


class CompleteUploadRequest(BaseModel):
    """Request to complete upload"""
    total_chunks: int
    file_hash: Optional[str] = None  # Hash of encrypted file (client-computed)


class UploadStatusResponse(BaseModel):
    """Upload status response"""
    upload_id: str
    file_id: str
    status: str  # "pending", "uploading", "completed", "failed"
    uploaded_chunks: int
    total_chunks: int
    progress_percentage: float


# ========== HELPER FUNCTIONS ==========

async def forward_to_storage_service(
    method: str,
    endpoint: str,
    token: str,
    json_data: dict = None,
    files: dict = None
) -> dict:
    """
    Forward request to storage-service.

    Args:
        method: HTTP method (GET, POST, etc.)
        endpoint: Storage-service endpoint (e.g., "/api/v1/upload/init")
        token: JWT access token
        json_data: JSON payload
        files: Files to upload

    Returns:
        Response JSON from storage-service

    Raises:
        HTTPException: If storage-service request fails
    """
    url = f"{settings.STORAGE_SERVICE_URL}{endpoint}"
    headers = {"Authorization": f"Bearer {token}"}

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            if method == "GET":
                response = await client.get(url, headers=headers)
            elif method == "POST":
                if files:
                    response = await client.post(url, headers=headers, files=files, data=json_data)
                else:
                    response = await client.post(url, headers=headers, json=json_data)
            elif method == "PUT":
                response = await client.put(url, headers=headers, json=json_data)
            elif method == "DELETE":
                response = await client.delete(url, headers=headers)
            else:
                raise ValueError(f"Unsupported HTTP method: {method}")

            response.raise_for_status()
            return response.json()

    except httpx.HTTPStatusError as e:
        logger.error(
            "storage_service_request_failed",
            method=method,
            endpoint=endpoint,
            status_code=e.response.status_code,
            response_text=e.response.text,
            error=str(e)
        )
        raise HTTPException(
            status_code=e.response.status_code,
            detail="Storage service error"
        )
    except Exception as e:
        logger.error("storage_service_connection_failed", error=str(e), exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Storage service unavailable"
        )


# ========== UPLOAD ENDPOINTS ==========

@router.post("/upload/init", response_model=InitUploadResponse)
async def initialize_upload(
    request_data: InitUploadRequest,
    user=Depends(get_current_zk_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Initialize upload of client-encrypted file.

    Client has already:
    1. Generated random file key (32 bytes)
    2. Encrypted file key with master key
    3. Ready to encrypt file chunks with file key

    This endpoint:
    1. Stores encrypted file key in database
    2. Initializes upload session with storage-service
    3. Returns upload ID for chunk uploads

    Args:
        request_data: Upload initialization data
        user: Current authenticated user with ZK enabled

    Returns:
        Upload session information
    """
    from app.models.database import ZKObject

    logger.info(
        "zk_upload_init",
        user_id=str(user.id),
        file_size=request_data.file_size,
        filename_encrypted=True  # Filename is now encrypted client-side
    )

    # Check storage quota
    total_usage = await db.scalar(
        select(ZKObject.file_size).where(
            ZKObject.user_id == user.id,
            ZKObject.is_deleted == False
        )
    ) or 0

    if total_usage + request_data.file_size > user.storage_quota:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Storage quota exceeded. Used: {total_usage}, Available: {user.storage_quota}"
        )

    # Create file record
    file_id = uuid4()
    # V2: Use client-provided uploadId for AAD, or generate one
    if request_data.upload_id:
        try:
            upload_id = UUID(request_data.upload_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid upload_id format"
            )
    else:
        upload_id = uuid4()

    # Use client-encrypted filename directly (proper ZK encryption)
    encrypted_filename = request_data.encrypted_file_name
    filename_iv = request_data.file_name_iv

    # Build chunk_info with ZK thumbnail if provided
    chunk_info = {}
    if request_data.encrypted_thumbnail:
        chunk_info["thumbnail"] = {
            "encrypted_data": request_data.encrypted_thumbnail,
            "iv": request_data.thumbnail_iv,
            "width": request_data.thumbnail_width,
            "height": request_data.thumbnail_height,
        }
        logger.info(
            "zk_thumbnail_received",
            user_id=str(user.id),
            file_id=str(file_id)
        )
        # Also store in separate columns for easier backend access
        encrypted_thumbnail = request_data.encrypted_thumbnail
        thumbnail_iv = request_data.thumbnail_iv
    else:
        encrypted_thumbnail = None
        thumbnail_iv = None

    new_file = ZKObject(
        id=file_id,
        user_id=user.id,
        encrypted_file_name=encrypted_filename,
        file_name_iv=filename_iv,
        file_size=request_data.file_size,
        mime_type=request_data.mime_type,
        folder_id=request_data.parent_folder_id,

        # File encryption key (already encrypted client-side)
        encrypted_file_key=request_data.encrypted_file_key,
        file_key_iv=request_data.file_key_iv,
        encryption_algorithm=request_data.encryption_algorithm,
        encryption_version=request_data.encryption_version,

        # Thumbnail (encrypted client-side)
        encrypted_thumbnail=encrypted_thumbnail,
        thumbnail_iv=thumbnail_iv,

        # Chunk info with metadata
        chunk_info=chunk_info if chunk_info else None,

        # Upload tracking
        upload_status="pending",
        upload_id=str(upload_id),
        is_deleted=False
    )

    db.add(new_file)
    await db.commit()

    # Calculate max chunks
    max_chunks = (request_data.file_size + request_data.chunk_size - 1) // request_data.chunk_size

    logger.info(
        "zk_upload_initialized",
        user_id=str(user.id),
        file_id=str(file_id),
        upload_id=str(upload_id),
        max_chunks=max_chunks
    )

    return InitUploadResponse(
        upload_id=str(upload_id),
        file_id=str(file_id),
        chunk_size=request_data.chunk_size,
        max_chunks=max_chunks,
        storage_upload_id=str(upload_id)  # Same as upload_id for simplicity
    )


@router.post("/upload/chunk/{upload_id}")
async def upload_chunk(
    upload_id: str,
    chunk_index: int = Form(..., ge=0),
    chunk: UploadFile = File(...),
    user=Depends(get_current_zk_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Upload encrypted file chunk.

    Client sends chunk that is ALREADY ENCRYPTED with file key.
    ZK service forwards encrypted chunk to storage-service.

    Args:
        upload_id: Upload session ID
        chunk_index: Chunk sequence number (0-based)
        chunk: Encrypted chunk data
        user: Current authenticated user

    Returns:
        Chunk upload confirmation
    """
    from app.models.database import ZKObject

    user_id_str = str(user.id)

    # ============ BANDWIDTH THROTTLING: Acquire stream slot ============
    max_streams = await bandwidth_throttle_service.get_max_streams_with_plan(
        user_id_str,
        user.plan_type,
        getattr(user, 'max_concurrent_streams', None)
    )

    stream_acquired = await bandwidth_throttle_service.acquire_stream_slot(
        user_id_str,
        plan_type=user.plan_type,
        db_streams_override=getattr(user, 'max_concurrent_streams', None)
    )
    if not stream_acquired:
        raise HTTPException(
            status_code=429,
            detail=f"Too many concurrent uploads ({max_streams} max). Please wait and retry.",
            headers={"Retry-After": "10"}
        )

    try:
        logger.info(
            "zk_chunk_upload",
            user_id=user_id_str,
            upload_id=upload_id,
            chunk_index=chunk_index
        )

        # Verify upload exists
        result = await db.execute(
            select(ZKObject).where(
                ZKObject.upload_id == upload_id,
                ZKObject.user_id == user.id
            )
        )
        file_obj = result.scalar_one_or_none()

        if not file_obj:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Upload session not found"
            )

        if file_obj.upload_status == "completed":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Upload already completed"
            )

        # Update status to uploading
        if file_obj.upload_status == "pending":
            await db.execute(
                update(ZKObject)
                .where(ZKObject.id == file_obj.id)
                .values(upload_status="uploading")
            )
            await db.commit()

        # Read encrypted chunk
        chunk_data = await chunk.read()

        # ============ BANDWIDTH THROTTLING: Check bandwidth limit ============
        chunk_size = len(chunk_data)
        if chunk_size > 0:
            allowed, wait_time = await bandwidth_throttle_service.can_transfer(
                user_id_str,
                chunk_size,
                plan_type=user.plan_type,
                db_bandwidth_override=getattr(user, 'bandwidth_limit_mbps', None)
            )
            if not allowed:
                if wait_time > 5.0:
                    raise HTTPException(
                        status_code=429,
                        detail=f"Bandwidth limit exceeded. Retry after {int(wait_time)} seconds.",
                        headers={"Retry-After": str(int(wait_time))}
                    )
                import asyncio
                await asyncio.sleep(min(wait_time, 1.0))

        # TODO: Store chunk in object storage (S3, MinIO, local filesystem)
        # For now, we'll use a simple file storage approach
        # In production, integrate with your storage backend

        import os
        from pathlib import Path

        # Storage directory - use ZK-specific isolated path
        storage_dir = Path(settings.ZK_STORAGE_PATH) / str(user.id) / str(file_obj.id)
        storage_dir.mkdir(parents=True, exist_ok=True)

        # Write encrypted chunk
        chunk_path = storage_dir / f"chunk_{chunk_index}.enc"
        with open(chunk_path, "wb") as f:
            f.write(chunk_data)

        logger.info(
            "zk_chunk_stored",
            user_id=user_id_str,
            upload_id=upload_id,
            chunk_index=chunk_index,
            chunk_size=chunk_size
        )

        return {
            "upload_id": upload_id,
            "chunk_index": chunk_index,
            "status": "uploaded",
            "chunk_size": chunk_size
        }

    finally:
        # ============ BANDWIDTH THROTTLING: Always release stream slot ============
        await bandwidth_throttle_service.release_stream_slot(user_id_str)


@router.post("/upload/complete/{upload_id}")
async def complete_upload(
    upload_id: str,
    request_data: CompleteUploadRequest,
    user=Depends(get_current_zk_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Complete file upload.

    Marks upload as completed and makes file available for download.

    Args:
        upload_id: Upload session ID
        request_data: Completion data (total chunks, hash)
        user: Current authenticated user

    Returns:
        Upload completion confirmation
    """
    from app.models.database import ZKObject

    logger.info(
        "zk_upload_complete",
        user_id=str(user.id),
        upload_id=upload_id,
        total_chunks=request_data.total_chunks
    )

    # Verify upload exists
    result = await db.execute(
        select(ZKObject).where(
            ZKObject.upload_id == upload_id,
            ZKObject.user_id == user.id
        )
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Upload session not found"
        )

    if file_obj.upload_status == "completed":
        return {
            "message": "Upload already completed",
            "file_id": str(file_obj.id),
            "upload_id": upload_id
        }

    # Verify all chunks exist
    import os
    from pathlib import Path

    storage_dir = Path(settings.ZK_STORAGE_PATH) / str(user.id) / str(file_obj.id)

    for chunk_index in range(request_data.total_chunks):
        chunk_path = storage_dir / f"chunk_{chunk_index}.enc"
        if not chunk_path.exists():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Missing chunk {chunk_index}"
            )

    # Update file status
    await db.execute(
        update(ZKObject)
        .where(ZKObject.id == file_obj.id)
        .values(
            upload_status="completed",
            uploaded_at=datetime.utcnow(),
            content_hash=request_data.file_hash
        )
    )
    await db.commit()

    logger.info(
        "zk_upload_completed",
        user_id=str(user.id),
        file_id=str(file_obj.id),
        upload_id=upload_id,
        total_chunks=request_data.total_chunks
    )

    # ✅ Emit WebSocket event for real-time UI update
    try:
        from app.websocket.manager import connection_manager
        await connection_manager.send_to_user(
            user_id=user.id,
            event="zk:file:uploaded",
            data={
                "file": {
                    "id": str(file_obj.id),
                    "encrypted_file_name": file_obj.encrypted_file_name,
                    "file_name_iv": file_obj.file_name_iv,
                    "file_size": file_obj.file_size,
                    "uploaded_at": file_obj.uploaded_at.isoformat() if file_obj.uploaded_at else None,
                }
            }
        )
    except Exception as e:
        logger.error("websocket_emit_failed", error=str(e), ws_event="zk:file:uploaded")

    # Return encrypted filename (client will decrypt)
    return {
        "message": "Upload completed successfully",
        "file_id": str(file_obj.id),
        "upload_id": upload_id,
        "encrypted_file_name": file_obj.encrypted_file_name,
        "file_name_iv": file_obj.file_name_iv,
        "file_size": file_obj.file_size,
        "total_chunks": request_data.total_chunks
    }


@router.get("/upload/status/{upload_id}", response_model=UploadStatusResponse)
async def get_upload_status(
    upload_id: str,
    user=Depends(get_current_zk_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get upload status.

    Args:
        upload_id: Upload session ID
        user: Current authenticated user

    Returns:
        Upload progress information
    """
    from app.models.database import ZKObject

    # Fetch upload
    result = await db.execute(
        select(ZKObject).where(
            ZKObject.upload_id == upload_id,
            ZKObject.user_id == user.id
        )
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Upload session not found"
        )

    # Count uploaded chunks
    import os
    from pathlib import Path

    storage_dir = Path(settings.ZK_STORAGE_PATH) / str(user.id) / str(file_obj.id)

    uploaded_chunks = 0
    if storage_dir.exists():
        uploaded_chunks = len(list(storage_dir.glob("chunk_*.enc")))

    # Calculate total chunks
    chunk_size = 1048576  # 1MB default
    total_chunks = (file_obj.file_size + chunk_size - 1) // chunk_size

    # Calculate progress
    progress = (uploaded_chunks / total_chunks * 100) if total_chunks > 0 else 0

    return UploadStatusResponse(
        upload_id=upload_id,
        file_id=str(file_obj.id),
        status=file_obj.upload_status,
        uploaded_chunks=uploaded_chunks,
        total_chunks=total_chunks,
        progress_percentage=round(progress, 2)
    )


@router.delete("/upload/{upload_id}")
async def cancel_upload(
    upload_id: str,
    user=Depends(get_current_zk_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Cancel ongoing upload.

    Deletes uploaded chunks and removes upload record.

    Args:
        upload_id: Upload session ID
        user: Current authenticated user

    Returns:
        Cancellation confirmation
    """
    from app.models.database import ZKObject

    logger.info("zk_upload_cancel", user_id=str(user.id), upload_id=upload_id)

    # Fetch upload
    result = await db.execute(
        select(ZKObject).where(
            ZKObject.upload_id == upload_id,
            ZKObject.user_id == user.id
        )
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Upload session not found"
        )

    # Delete uploaded chunks
    import shutil
    from pathlib import Path

    storage_dir = Path(settings.ZK_STORAGE_PATH) / str(user.id) / str(file_obj.id)
    if storage_dir.exists():
        shutil.rmtree(storage_dir)

    # Delete file record
    await db.delete(file_obj)
    await db.commit()

    logger.info("zk_upload_cancelled", user_id=str(user.id), upload_id=upload_id)

    return {
        "message": "Upload cancelled successfully",
        "upload_id": upload_id
    }
