# services/storage-service/app/routers/versioning.py

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from typing import List
from ..services.versioning import versioning_service
from ..services.auth import get_current_user
from ..dependencies import get_db
from ..models.schemas import FileVersionResponse

router = APIRouter(prefix="/api/v1/versions", tags=["versioning"])

@router.post("/files/{file_id}/versions")
async def create_new_version(
    file_id: str,
    file: UploadFile = File(...),
    comment: str = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Upload a new version of an existing file"""
    
    # Verify ownership
    result = await db.execute(
        select(Object).filter(
            Object.id == file_id,
            Object.user_id == current_user.id
        )
    )
    file_obj = result.scalar_one_or_none()
    
    if not file_obj:
        raise HTTPException(404, "File not found")
    
    # Read file content
    content = await file.read()
    
    # Create new version
    version = await versioning_service.create_version(
        db, file_id, content, str(current_user.id), comment
    )
    
    return {
        "version_number": version.version_number,
        "file_id": str(version.file_id),
        "size": version.file_size,
        "created_at": version.created_at.isoformat(),
        "comment": version.comment
    }

@router.get("/files/{file_id}/versions")
async def list_file_versions(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """List all versions of a file"""
    
    # Verify ownership
    result = await db.execute(
        select(Object).filter(
            Object.id == file_id,
            Object.user_id == current_user.id
        )
    )
    if not result.scalar_one_or_none():
        raise HTTPException(404, "File not found")
    
    versions = await versioning_service.list_versions(db, file_id)
    
    return [
        {
            "version_number": v.version_number,
            "size": v.file_size,
            "created_at": v.created_at.isoformat(),
            "created_by": str(v.created_by),
            "comment": v.comment
        }
        for v in versions
    ]

@router.get("/files/{file_id}/versions/{version_number}/download")
async def download_version(
    file_id: str,
    version_number: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Download a specific version"""
    
    version = await versioning_service.get_version(db, file_id, version_number)
    if not version:
        raise HTTPException(404, "Version not found")
    
    # Get file content based on storage type
    if version.chunk_info.get('storage_type') == 'inline':
        content = await storage_service.retrieve_file(version, decrypt_key)
    else:
        # Read from path
        async with aiofiles.open(version.storage_path, 'rb') as f:
            content = await f.read()
    
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f"attachment; filename=version_{version_number}.dat"
        }
    )

@router.post("/files/{file_id}/versions/{version_number}/restore")
async def restore_version(
    file_id: str,
    version_number: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Restore a previous version as current"""
    
    file_obj = await versioning_service.restore_version(
        db, file_id, version_number, str(current_user.id)
    )
    
    return {
        "message": "Version restored successfully",
        "current_version": file_obj.current_version,
        "file_id": str(file_obj.id)
    }

@router.get("/files/{file_id}/versions/diff")
async def compare_versions(
    file_id: str,
    v1: int,
    v2: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Compare two versions"""
    
    diff = await versioning_service.diff_versions(db, file_id, v1, v2)
    return diff