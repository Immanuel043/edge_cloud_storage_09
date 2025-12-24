"""
Zero-Knowledge Download Coordination Endpoints

Coordinates download of client-encrypted files from storage-service.
The ZK service NEVER decrypts data - all decryption happens client-side.

Download Flow (Client-Side Decryption):
1. Client requests file download
2. ZK service returns encrypted file key
3. Client decrypts file key with master key
4. ZK service streams encrypted chunks to client
5. Client decrypts each chunk with file key
6. Client reassembles decrypted file

Security Properties:
- Server never sees plaintext file content
- Server never sees file decryption key
- Only user's master key can decrypt file keys
- Chunks streamed to client are still encrypted
"""
import structlog
from typing import Optional, List
from uuid import UUID
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update, func

from app.config import settings
from app.database import get_db
from app.dependencies import get_current_zk_user

logger = structlog.get_logger()

router = APIRouter()


# ========== RESPONSE MODELS ==========

class FileMetadataResponse(BaseModel):
    """File metadata for download"""
    file_id: str
    filename: str
    file_size: int
    mime_type: str
    encrypted_file_key: str  # Client decrypts this with master key
    file_key_iv: str
    encryption_algorithm: str
    chunk_size: int
    total_chunks: int
    uploaded_at: Optional[str]
    file_hash: Optional[str]
    # Migration fields
    encryption_version: Optional[int] = 2  # 1=V1, 2=V2 (HKDF+AAD)
    is_encrypted: bool = True  # ZK files are always encrypted


class FileListResponse(BaseModel):
    """List of user's files"""
    files: List[FileMetadataResponse]
    total_files: int
    total_size: int


class DownloadTokenResponse(BaseModel):
    """Download token for streaming"""
    download_token: str
    expires_in: int  # seconds
    file_id: str


# ========== DOWNLOAD ENDPOINTS ==========

@router.get("/files", response_model=FileListResponse)
async def list_files(
    folder_id: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
    user=Depends(get_current_zk_user),
    db: AsyncSession = Depends(get_db)
):
    """
    List user's encrypted files.

    Returns file metadata including encrypted file keys.
    Client can decrypt file keys with master key.

    Args:
        folder_id: Optional folder filter
        limit: Max files to return
        offset: Pagination offset
        user: Current authenticated user

    Returns:
        List of files with metadata
    """
    from app.models.database import StorageObject

    logger.info(
        "zk_list_files",
        user_id=str(user.id),
        folder_id=folder_id,
        limit=limit,
        offset=offset
    )

    # Build query - ONLY return ZK-encrypted files (encryption_mode = 'client_zk')
    query = select(StorageObject).where(
        StorageObject.user_id == user.id,
        StorageObject.is_deleted == False,
        StorageObject.upload_status == "completed",
        StorageObject.encryption_mode == "client_zk"  # Only ZK-encrypted files
    )

    if folder_id:
        query = query.where(StorageObject.parent_folder_id == folder_id)

    # Get total count (only ZK files)
    count_query = select(func.count()).select_from(StorageObject).where(
        StorageObject.user_id == user.id,
        StorageObject.is_deleted == False,
        StorageObject.upload_status == "completed",
        StorageObject.encryption_mode == "client_zk"  # Only ZK-encrypted files
    )
    if folder_id:
        count_query = count_query.where(StorageObject.parent_folder_id == folder_id)

    total_count = await db.scalar(count_query) or 0

    # Get files
    query = query.order_by(StorageObject.uploaded_at.desc())
    query = query.limit(limit).offset(offset)

    result = await db.execute(query)
    files = result.scalars().all()

    # Calculate total size (only ZK files)
    size_query = select(func.sum(StorageObject.file_size)).where(
        StorageObject.user_id == user.id,
        StorageObject.is_deleted == False,
        StorageObject.upload_status == "completed",
        StorageObject.encryption_mode == "client_zk"  # Only ZK-encrypted files
    )
    total_size = await db.scalar(size_query) or 0

    # Build response
    file_list = []
    for file_obj in files:
        # Calculate chunks
        chunk_size = 1048576  # 1MB default
        total_chunks = (file_obj.file_size + chunk_size - 1) // chunk_size

        file_list.append(FileMetadataResponse(
            file_id=str(file_obj.id),
            filename=file_obj.file_name,
            file_size=file_obj.file_size,
            mime_type=file_obj.mime_type or "application/octet-stream",
            encrypted_file_key=file_obj.encrypted_file_key or "",
            file_key_iv=file_obj.file_key_iv or "",
            encryption_algorithm=file_obj.encryption_algorithm or "AES-256-GCM",
            chunk_size=chunk_size,
            total_chunks=total_chunks,
            uploaded_at=file_obj.uploaded_at.isoformat() if file_obj.uploaded_at else None,
            file_hash=file_obj.file_hash,
            encryption_version=file_obj.encryption_version,
            is_encrypted=True
        ))

    logger.info(
        "zk_files_listed",
        user_id=str(user.id),
        total_files=total_count,
        returned_files=len(file_list)
    )

    return FileListResponse(
        files=file_list,
        total_files=total_count,
        total_size=total_size
    )


@router.get("/files/{file_id}/metadata", response_model=FileMetadataResponse)
async def get_file_metadata(
    file_id: str,
    user=Depends(get_current_zk_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get file metadata including encrypted file key.

    Client uses this to get the encrypted file key before downloading chunks.

    Args:
        file_id: File UUID
        user: Current authenticated user

    Returns:
        File metadata with encrypted file key
    """
    from app.models.database import StorageObject

    logger.info("zk_get_file_metadata", user_id=str(user.id), file_id=file_id)

    # Fetch file
    result = await db.execute(
        select(StorageObject).where(
            StorageObject.id == file_id,
            StorageObject.user_id == user.id,
            StorageObject.is_deleted == False
        )
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found"
        )

    if file_obj.upload_status != "completed":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File upload not completed"
        )

    # Calculate chunks
    chunk_size = 1048576  # 1MB default
    total_chunks = (file_obj.file_size + chunk_size - 1) // chunk_size

    return FileMetadataResponse(
        file_id=str(file_obj.id),
        filename=file_obj.file_name,
        file_size=file_obj.file_size,
        mime_type=file_obj.mime_type or "application/octet-stream",
        encrypted_file_key=file_obj.encrypted_file_key or "",
        file_key_iv=file_obj.file_key_iv or "",
        encryption_algorithm=file_obj.encryption_algorithm or "AES-256-GCM",
        chunk_size=chunk_size,
        total_chunks=total_chunks,
        uploaded_at=file_obj.uploaded_at.isoformat() if file_obj.uploaded_at else None,
        file_hash=file_obj.file_hash
    )


@router.get("/files/{file_id}/download")
async def download_file(
    file_id: str,
    user=Depends(get_current_zk_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Download encrypted file as stream.

    Returns encrypted chunks that client must decrypt with file key.

    Download Flow:
    1. Client fetches metadata to get encrypted_file_key
    2. Client decrypts file_key with master_key
    3. Client calls this endpoint to stream encrypted chunks
    4. Client decrypts each chunk with file_key
    5. Client reassembles decrypted file

    Args:
        file_id: File UUID
        user: Current authenticated user

    Returns:
        Streaming response of encrypted file chunks
    """
    from app.models.database import StorageObject
    from pathlib import Path

    logger.info("zk_download_file", user_id=str(user.id), file_id=file_id)

    # Fetch file
    result = await db.execute(
        select(StorageObject).where(
            StorageObject.id == file_id,
            StorageObject.user_id == user.id,
            StorageObject.is_deleted == False
        )
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found"
        )

    if file_obj.upload_status != "completed":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File upload not completed"
        )

    # Get storage directory - use ZK-specific isolated path
    storage_dir = Path(settings.ZK_STORAGE_PATH) / str(user.id) / str(file_obj.id)

    if not storage_dir.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File data not found"
        )

    # Calculate total chunks
    chunk_size = 1048576  # 1MB
    total_chunks = (file_obj.file_size + chunk_size - 1) // chunk_size

    # Stream encrypted chunks
    async def chunk_generator():
        """Generate encrypted chunks for streaming"""
        for chunk_index in range(total_chunks):
            chunk_path = storage_dir / f"chunk_{chunk_index}.enc"

            if not chunk_path.exists():
                logger.error(
                    "missing_chunk",
                    file_id=file_id,
                    chunk_index=chunk_index
                )
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=f"Missing chunk {chunk_index}"
                )

            # Read and yield encrypted chunk
            with open(chunk_path, "rb") as f:
                chunk_data = f.read()
                yield chunk_data

    logger.info(
        "zk_download_started",
        user_id=str(user.id),
        file_id=file_id,
        filename=file_obj.file_name,
        total_chunks=total_chunks
    )

    # Return streaming response
    return StreamingResponse(
        chunk_generator(),
        media_type=file_obj.mime_type or "application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{file_obj.file_name}"',
            "Content-Length": str(file_obj.file_size),
            "X-File-Encrypted": "true",
            "X-Encryption-Algorithm": file_obj.encryption_algorithm or "AES-256-GCM"
        }
    )


@router.get("/files/{file_id}/chunk/{chunk_index}")
async def download_chunk(
    file_id: str,
    chunk_index: int,
    user=Depends(get_current_zk_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Download single encrypted chunk.

    Useful for progressive decryption or resumable downloads.

    Args:
        file_id: File UUID
        chunk_index: Chunk number (0-based)
        user: Current authenticated user

    Returns:
        Encrypted chunk data
    """
    from app.models.database import StorageObject
    from pathlib import Path

    logger.info(
        "zk_download_chunk",
        user_id=str(user.id),
        file_id=file_id,
        chunk_index=chunk_index
    )

    # Fetch file
    result = await db.execute(
        select(StorageObject).where(
            StorageObject.id == file_id,
            StorageObject.user_id == user.id,
            StorageObject.is_deleted == False
        )
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found"
        )

    # Get chunk path - use ZK-specific isolated path
    storage_dir = Path(settings.ZK_STORAGE_PATH) / str(user.id) / str(file_obj.id)
    chunk_path = storage_dir / f"chunk_{chunk_index}.enc"

    if not chunk_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Chunk {chunk_index} not found"
        )

    # Read encrypted chunk
    with open(chunk_path, "rb") as f:
        chunk_data = f.read()

    logger.info(
        "zk_chunk_downloaded",
        user_id=str(user.id),
        file_id=file_id,
        chunk_index=chunk_index,
        chunk_size=len(chunk_data)
    )

    return StreamingResponse(
        iter([chunk_data]),
        media_type="application/octet-stream",
        headers={
            "Content-Length": str(len(chunk_data)),
            "X-Chunk-Index": str(chunk_index),
            "X-File-Encrypted": "true"
        }
    )


@router.delete("/files/{file_id}")
async def delete_file(
    file_id: str,
    permanent: bool = False,
    user=Depends(get_current_zk_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Delete file (soft delete by default).

    Args:
        file_id: File UUID
        permanent: If True, permanently delete file data
        user: Current authenticated user

    Returns:
        Deletion confirmation
    """
    from app.models.database import StorageObject
    from pathlib import Path
    import shutil

    logger.info(
        "zk_delete_file",
        user_id=str(user.id),
        file_id=file_id,
        permanent=permanent
    )

    # Fetch file
    result = await db.execute(
        select(StorageObject).where(
            StorageObject.id == file_id,
            StorageObject.user_id == user.id
        )
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found"
        )

    if permanent:
        # Permanently delete file data - use ZK-specific isolated path
        storage_dir = Path(settings.ZK_STORAGE_PATH) / str(user.id) / str(file_obj.id)
        if storage_dir.exists():
            shutil.rmtree(storage_dir)

        # Delete database record
        await db.delete(file_obj)
        await db.commit()

        logger.info(
            "zk_file_permanently_deleted",
            user_id=str(user.id),
            file_id=file_id,
            filename=file_obj.file_name
        )

        return {
            "message": "File permanently deleted",
            "file_id": file_id,
            "filename": file_obj.file_name
        }

    else:
        # Soft delete (set is_deleted flag and update updated_at)
        await db.execute(
            update(StorageObject)
            .where(StorageObject.id == file_id)
            .values(
                is_deleted=True,
                updated_at=datetime.utcnow()
            )
        )
        await db.commit()

        logger.info(
            "zk_file_soft_deleted",
            user_id=str(user.id),
            file_id=file_id,
            filename=file_obj.file_name
        )

        return {
            "message": "File moved to trash",
            "file_id": file_id,
            "filename": file_obj.file_name,
            "can_restore": True
        }


@router.post("/files/{file_id}/restore")
async def restore_file(
    file_id: str,
    user=Depends(get_current_zk_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Restore soft-deleted file.

    Args:
        file_id: File UUID
        user: Current authenticated user

    Returns:
        Restoration confirmation
    """
    from app.models.database import StorageObject

    logger.info("zk_restore_file", user_id=str(user.id), file_id=file_id)

    # Fetch file
    result = await db.execute(
        select(StorageObject).where(
            StorageObject.id == file_id,
            StorageObject.user_id == user.id,
            StorageObject.is_deleted == True
        )
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Deleted file not found"
        )

    # Restore file
    await db.execute(
        update(StorageObject)
        .where(StorageObject.id == file_id)
        .values(
            is_deleted=False,
            deleted_at=None
        )
    )
    await db.commit()

    logger.info(
        "zk_file_restored",
        user_id=str(user.id),
        file_id=file_id,
        filename=file_obj.file_name
    )

    return {
        "message": "File restored successfully",
        "file_id": file_id,
        "filename": file_obj.file_name
    }


@router.get("/storage/usage")
async def get_storage_usage(
    user=Depends(get_current_zk_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get user's storage usage statistics.

    Args:
        user: Current authenticated user

    Returns:
        Storage usage information
    """
    from app.models.database import StorageObject

    logger.info("zk_storage_usage", user_id=str(user.id))

    # Total storage used (excluding deleted files)
    total_used = await db.scalar(
        select(func.sum(StorageObject.file_size)).where(
            StorageObject.user_id == user.id,
            StorageObject.is_deleted == False,
            StorageObject.upload_status == "completed"
        )
    ) or 0

    # Total files
    total_files = await db.scalar(
        select(func.count()).select_from(StorageObject).where(
            StorageObject.user_id == user.id,
            StorageObject.is_deleted == False,
            StorageObject.upload_status == "completed"
        )
    ) or 0

    # Deleted files (in trash)
    deleted_files = await db.scalar(
        select(func.count()).select_from(StorageObject).where(
            StorageObject.user_id == user.id,
            StorageObject.is_deleted == True
        )
    ) or 0

    deleted_size = await db.scalar(
        select(func.sum(StorageObject.file_size)).where(
            StorageObject.user_id == user.id,
            StorageObject.is_deleted == True
        )
    ) or 0

    # Calculate usage percentage
    quota = user.storage_quota
    usage_percentage = (total_used / quota * 100) if quota > 0 else 0

    return {
        "total_used": total_used,
        "total_files": total_files,
        "storage_quota": quota,
        "usage_percentage": round(usage_percentage, 2),
        "available_space": quota - total_used,
        "deleted_files": deleted_files,
        "deleted_size": deleted_size
    }
