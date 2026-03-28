# services/storage-service/app/routers/versions.py
"""
File versioning endpoints - Auto-versioning and version history
"""

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Request
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc
from typing import List
from datetime import datetime
from pydantic import BaseModel

from ..dependencies import get_db, get_current_user, log_activity
from ..models.database import User, Object, FileVersion
from ..services.encryption import encryption_service
from ..services.storage import storage_service
import hashlib

router = APIRouter(prefix="/api/v1", tags=["versions"])


class RestoreVersionRequest(BaseModel):
    version_number: int


@router.get("/files/{file_id}/versions")
async def get_file_versions(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get all versions of a file"""
    # Verify file belongs to user
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Get all versions
    versions_result = await db.execute(
        select(FileVersion, User)
        .outerjoin(User, FileVersion.created_by == User.id)
        .filter(FileVersion.file_id == file_id, FileVersion.is_deleted == False)
        .order_by(desc(FileVersion.version_number))
    )

    versions = []
    for version, user in versions_result.all():
        versions.append({
            "id": str(version.id),
            "version_number": version.version_number,
            "file_size": version.file_size,
            "content_hash": version.content_hash,
            "created_at": version.created_at.isoformat(),
            "created_by": user.email if user else "Unknown",
            "comment": version.comment,
            "is_current": version.version_number == file_obj.current_version,
        })

    return {
        "file_id": str(file_id),
        "file_name": file_obj.file_name,
        "current_version": file_obj.current_version,
        "total_versions": file_obj.version_count,
        "versions": versions,
    }


@router.post("/files/{file_id}/versions/restore")
async def restore_file_version(
    file_id: str,
    restore_request: RestoreVersionRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Restore a file to a previous version"""
    version_number = restore_request.version_number

    # Verify file belongs to user
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Get the version to restore
    version_result = await db.execute(
        select(FileVersion).filter(
            FileVersion.file_id == file_id,
            FileVersion.version_number == version_number,
            FileVersion.is_deleted == False
        )
    )
    version_to_restore = version_result.scalar_one_or_none()

    if not version_to_restore:
        raise HTTPException(status_code=404, detail="Version not found")

    # Create new version from current state (before restoring)
    current_version = FileVersion(
        file_id=file_id,
        version_number=file_obj.current_version,
        file_size=file_obj.file_size,
        content_hash=file_obj.content_hash,
        storage_path=file_obj.object_path,
        chunk_info=file_obj.chunk_info,
        created_by=current_user.id,
        comment=f"Auto-saved before restore to v{version_number}",
    )
    db.add(current_version)

    # Capture old hash BEFORE mutation for preview invalidation
    old_content_hash = file_obj.content_hash

    # Restore file to the selected version
    file_obj.content_hash = version_to_restore.content_hash
    file_obj.file_size = version_to_restore.file_size
    file_obj.chunk_info = version_to_restore.chunk_info
    file_obj.object_path = version_to_restore.storage_path
    file_obj.current_version = file_obj.version_count + 1
    file_obj.version_count += 1

    # Create a new version entry for the restore
    restored_version = FileVersion(
        file_id=file_id,
        version_number=file_obj.current_version,
        file_size=version_to_restore.file_size,
        content_hash=version_to_restore.content_hash,
        storage_path=version_to_restore.storage_path,
        chunk_info=version_to_restore.chunk_info,
        created_by=current_user.id,
        comment=f"Restored from v{version_number}",
    )
    db.add(restored_version)

    # Invalidate stale previews BEFORE commit
    if old_content_hash and old_content_hash != version_to_restore.content_hash:
        from ..services.preview_storage import invalidate_preview
        from ..database import get_redis
        redis_client = await get_redis()
        await invalidate_preview(file_id, old_content_hash, redis_client, db)

    await db.commit()
    await db.refresh(file_obj)

    # Log activity
    await log_activity(
        db, current_user.id, "version_restored", str(file_id),
        {"version_number": version_number, "new_version": file_obj.current_version},
        request,
    )

    return {
        "message": f"File restored to version {version_number}",
        "current_version": file_obj.current_version,
        "file_id": str(file_id),
    }


@router.delete("/files/{file_id}/versions/{version_number}")
async def delete_file_version(
    file_id: str,
    version_number: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Soft delete a specific version (cannot delete current version)"""
    # Verify file belongs to user
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Cannot delete current version
    if version_number == file_obj.current_version:
        raise HTTPException(status_code=400, detail="Cannot delete current version")

    # Get the version
    version_result = await db.execute(
        select(FileVersion).filter(
            FileVersion.file_id == file_id,
            FileVersion.version_number == version_number
        )
    )
    version = version_result.scalar_one_or_none()

    if not version:
        raise HTTPException(status_code=404, detail="Version not found")

    # Soft delete
    version.is_deleted = True
    await db.commit()

    # Log activity
    await log_activity(
        db, current_user.id, "version_deleted", str(file_id),
        {"version_number": version_number},
        request,
    )

    return {"message": f"Version {version_number} deleted"}


@router.get("/files/{file_id}/versions/{version_number}/download")
async def download_file_version(
    file_id: str,
    version_number: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Download a specific version of a file"""

    # Verify file belongs to user
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Get the version
    version_result = await db.execute(
        select(FileVersion).filter(
            FileVersion.file_id == file_id,
            FileVersion.version_number == version_number,
            FileVersion.is_deleted == False
        )
    )
    version = version_result.scalar_one_or_none()

    if not version:
        raise HTTPException(status_code=404, detail="Version not found")

    # Decrypt file from version storage
    import os
    file_key = encryption_service.decrypt_key(file_obj.encryption_key)

    storage_type = version.chunk_info.get("storage_type") if version.chunk_info else None

    if storage_type == "single" and version.storage_path and os.path.exists(version.storage_path):
        # Read encrypted file from disk and decrypt
        with open(version.storage_path, 'rb') as f:
            encrypted_data = f.read()
        file_content = encryption_service.decrypt_file(encrypted_data, file_key)
    elif storage_type == "inline" and version.chunk_info and "data" in version.chunk_info:
        # Inline storage - data in chunk_info
        import base64
        encrypted_data = base64.b64decode(version.chunk_info["data"])
        file_content = encryption_service.decrypt_file(encrypted_data, file_key)
    elif version.storage_path and os.path.exists(version.storage_path):
        # Fallback: try reading from storage_path
        with open(version.storage_path, 'rb') as f:
            encrypted_data = f.read()
        file_content = encryption_service.decrypt_file(encrypted_data, file_key)
    else:
        raise HTTPException(status_code=404, detail="Version file data not found on disk")

    return Response(
        content=file_content,
        media_type=file_obj.mime_type or "application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{file_obj.file_name}_v{version_number}"',
            "Content-Length": str(len(file_content)),
        },
    )


@router.post("/files/{file_id}/versions/comment")
async def add_version_comment(
    file_id: str,
    version_number: int,
    comment: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Add or update a comment for a version"""
    # Verify file belongs to user
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Get the version
    version_result = await db.execute(
        select(FileVersion).filter(
            FileVersion.file_id == file_id,
            FileVersion.version_number == version_number
        )
    )
    version = version_result.scalar_one_or_none()

    if not version:
        raise HTTPException(status_code=404, detail="Version not found")

    version.comment = comment
    await db.commit()

    return {"message": "Comment updated", "version_number": version_number}
