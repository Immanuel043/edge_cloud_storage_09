# services/storage-service/app/routers/share_bundles.py
"""
Share Bundles - Multi-file sharing without folders (better than Google Drive)

Key features:
- Share multiple files with a single link
- Files stay in their original location (no folder creation required)
- Password protection, expiration, download limits
- ZIP download for all files
- View/download permissions
"""

from fastapi import APIRouter, Depends, HTTPException, Request, Query
from fastapi.responses import StreamingResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, delete
from typing import List, Optional
from datetime import datetime, timedelta
import secrets
import logging
import io
import zipfile

from ..dependencies import get_db, get_current_user, log_activity
from ..services.auth import pwd_context
from ..models.database import User, Object, ShareBundle, ShareBundleFile, Folder
from ..models.schemas import (
    ShareBundleCreate, ShareBundleUpdate, ShareBundleResponse,
    ShareBundleListResponse, ShareBundlePublicInfo, ShareBundleFileItem,
    ShareBundleAddFiles, ShareBundleRemoveFiles
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["share-bundles"])


# ============================================================================
# Helper Functions for Folder Handling
# ============================================================================

async def get_folder_path(db: AsyncSession, folder_id: str, user_id) -> str:
    """Get the full path of a folder"""
    path_parts = []
    current_id = folder_id

    while current_id:
        result = await db.execute(
            select(Folder).filter(Folder.id == current_id, Folder.user_id == user_id)
        )
        folder = result.scalar_one_or_none()
        if not folder:
            break
        path_parts.insert(0, folder.name)
        current_id = folder.parent_id

    return "/".join(path_parts) + "/" if path_parts else ""


async def get_files_in_folder_recursive(
    db: AsyncSession,
    folder_id: str,
    user_id,
    base_path: str = ""
) -> List[tuple]:
    """
    Recursively get all files in a folder and its subfolders.
    Returns list of tuples: (file_object, folder_path)
    """
    files_with_paths = []

    # Get the folder
    result = await db.execute(
        select(Folder).filter(Folder.id == folder_id, Folder.user_id == user_id)
    )
    folder = result.scalar_one_or_none()

    if not folder:
        return files_with_paths

    # Build current path
    current_path = f"{base_path}{folder.name}/"

    # Get files directly in this folder
    files_result = await db.execute(
        select(Object).filter(
            Object.folder_id == folder_id,
            Object.user_id == user_id,
            Object.is_deleted == False
        )
    )
    files = files_result.scalars().all()

    for file_obj in files:
        files_with_paths.append((file_obj, current_path))

    # Recursively get files from subfolders
    subfolders_result = await db.execute(
        select(Folder).filter(Folder.parent_id == folder_id, Folder.user_id == user_id)
    )
    subfolders = subfolders_result.scalars().all()

    for subfolder in subfolders:
        subfolder_files = await get_files_in_folder_recursive(
            db, str(subfolder.id), user_id, current_path
        )
        files_with_paths.extend(subfolder_files)

    return files_with_paths


# ============================================================================
# Authenticated Endpoints - Manage user's share bundles
# ============================================================================

@router.post("/share-bundles", response_model=ShareBundleResponse)
async def create_share_bundle(
    bundle_data: ShareBundleCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Create a new share bundle with multiple files and/or folders"""

    file_ids = bundle_data.file_ids or []
    folder_ids = bundle_data.folder_ids or []

    if not file_ids and not folder_ids:
        raise HTTPException(status_code=400, detail="At least one file or folder is required")

    # Collect all files with their paths
    # files_with_paths is a list of tuples: (file_object, folder_path)
    files_with_paths = []

    # 1. Add directly selected files (no folder path)
    if file_ids:
        result = await db.execute(
            select(Object).filter(
                Object.id.in_(file_ids),
                Object.user_id == current_user.id,
                Object.is_deleted == False
            )
        )
        direct_files = result.scalars().all()

        if len(direct_files) != len(file_ids):
            raise HTTPException(status_code=404, detail="One or more files not found")

        for file_obj in direct_files:
            files_with_paths.append((file_obj, None))  # No folder path for directly selected files

    # 2. Add files from selected folders (with folder paths)
    folder_names = []
    for folder_id in folder_ids:
        folder_files = await get_files_in_folder_recursive(
            db, folder_id, current_user.id, ""
        )
        files_with_paths.extend(folder_files)

        # Get folder name for bundle naming
        folder_result = await db.execute(
            select(Folder).filter(Folder.id == folder_id, Folder.user_id == current_user.id)
        )
        folder = folder_result.scalar_one_or_none()
        if folder:
            folder_names.append(folder.name)

    if not files_with_paths:
        raise HTTPException(status_code=400, detail="No files found in selected items")

    if len(files_with_paths) > 500:
        raise HTTPException(status_code=400, detail="Maximum 500 files per bundle")

    # Calculate total size
    total_size = sum(f.file_size for f, _ in files_with_paths)

    # Generate bundle name if not provided
    bundle_name = bundle_data.name
    if not bundle_name:
        if len(folder_names) == 1 and not file_ids:
            bundle_name = folder_names[0]
        elif len(folder_names) > 0:
            bundle_name = f"{', '.join(folder_names[:2])}{'...' if len(folder_names) > 2 else ''}"
        elif len(files_with_paths) == 1:
            bundle_name = files_with_paths[0][0].file_name
        else:
            bundle_name = f"Shared Files ({len(files_with_paths)} items)"

    # Generate unique share token
    share_token = secrets.token_urlsafe(32)

    # Calculate expiration
    expires_at = None
    if bundle_data.expires_hours:
        expires_at = datetime.utcnow() + timedelta(hours=bundle_data.expires_hours)

    # Hash password if provided
    password_hash = None
    if bundle_data.password:
        password_hash = pwd_context.hash(bundle_data.password)

    # Create share bundle
    bundle = ShareBundle(
        user_id=current_user.id,
        name=bundle_name,
        description=bundle_data.description,
        share_token=share_token,
        share_type=bundle_data.share_type,
        password_hash=password_hash,
        expires_at=expires_at,
        max_downloads=bundle_data.max_downloads,
        allow_preview=bundle_data.allow_preview,
        allow_zip_download=bundle_data.allow_zip_download,
        total_size=total_size,
        file_count=len(files_with_paths),
    )

    db.add(bundle)
    await db.flush()  # Get bundle ID

    logger.info(f"Creating bundle {bundle.id} with {len(files_with_paths)} files")

    # Add files to bundle with folder paths
    seen_file_ids = set()  # Prevent duplicates
    added_count = 0
    for idx, (file_obj, folder_path) in enumerate(files_with_paths):
        if file_obj.id in seen_file_ids:
            logger.debug(f"Skipping duplicate file {file_obj.id}")
            continue
        seen_file_ids.add(file_obj.id)

        bundle_file = ShareBundleFile(
            bundle_id=bundle.id,
            file_id=file_obj.id,
            display_order=idx,
            folder_path=folder_path,
        )
        db.add(bundle_file)
        added_count += 1
        logger.info(f"  Added file {file_obj.id} ({file_obj.file_name}) to bundle")

    logger.info(f"Bundle {bundle.id}: added {added_count} ShareBundleFile records")

    await db.commit()
    await db.refresh(bundle)

    # Log activity
    await log_activity(
        db, current_user.id, "share_bundle_created", str(bundle.id),
        {
            "file_count": len(files_with_paths),
            "folder_count": len(folder_ids),
            "total_size": total_size,
            "share_type": bundle_data.share_type,
            "has_password": bool(bundle_data.password),
            "expires_hours": bundle_data.expires_hours,
        },
        request,
    )

    # Build share URL
    from ..config import settings
    frontend_url = getattr(settings, 'FRONTEND_URL', "http://localhost:3001")
    share_url = f"{frontend_url}/share/bundle/{share_token}"

    # Build file list for response
    file_items = [
        ShareBundleFileItem(
            id=str(f.id),
            name=f.file_name,
            size=f.file_size,
            mime_type=f.mime_type,
            can_preview=bundle_data.allow_preview and _can_preview(f.mime_type),
            display_order=idx,
            folder_path=path,
        )
        for idx, (f, path) in enumerate(files_with_paths)
    ]

    return ShareBundleResponse(
        id=str(bundle.id),
        name=bundle.name,
        description=bundle.description,
        share_url=share_url,
        token=share_token,
        share_type=bundle.share_type,
        file_count=bundle.file_count,
        total_size=bundle.total_size,
        expires_at=bundle.expires_at,
        password_protected=bool(bundle.password_hash),
        max_downloads=bundle.max_downloads,
        download_count=bundle.download_count,
        view_count=bundle.view_count,
        allow_preview=bundle.allow_preview,
        allow_zip_download=bundle.allow_zip_download,
        is_active=bundle.is_active,
        created_at=bundle.created_at,
        last_accessed=bundle.last_accessed,
        files=file_items,
    )


@router.get("/share-bundles", response_model=List[ShareBundleListResponse])
async def list_share_bundles(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    include_inactive: bool = False,
):
    """List all share bundles created by the current user"""

    query = select(ShareBundle).filter(ShareBundle.user_id == current_user.id)

    if not include_inactive:
        query = query.filter(ShareBundle.is_active == True)

    query = query.order_by(ShareBundle.created_at.desc())

    result = await db.execute(query)
    bundles = result.scalars().all()

    return [
        ShareBundleListResponse(
            id=str(b.id),
            name=b.name,
            share_type=b.share_type,
            file_count=b.file_count,
            total_size=b.total_size,
            expires_at=b.expires_at,
            password_protected=bool(b.password_hash),
            view_count=b.view_count,
            download_count=b.download_count,
            is_active=b.is_active,
            created_at=b.created_at,
        )
        for b in bundles
    ]


@router.get("/share-bundles/{bundle_id}", response_model=ShareBundleResponse)
async def get_share_bundle(
    bundle_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get details of a specific share bundle"""

    result = await db.execute(
        select(ShareBundle).filter(
            ShareBundle.id == bundle_id,
            ShareBundle.user_id == current_user.id
        )
    )
    bundle = result.scalar_one_or_none()

    if not bundle:
        raise HTTPException(status_code=404, detail="Share bundle not found")

    # Get files in bundle (filter out deleted files)
    files_result = await db.execute(
        select(Object, ShareBundleFile)
        .select_from(ShareBundleFile)
        .join(Object, ShareBundleFile.file_id == Object.id)
        .filter(
            ShareBundleFile.bundle_id == bundle.id,
            Object.is_deleted == False
        )
        .order_by(ShareBundleFile.display_order)
    )
    files_data = files_result.all()

    from ..config import settings
    frontend_url = getattr(settings, 'FRONTEND_URL', "http://localhost:3001")
    share_url = f"{frontend_url}/share/bundle/{bundle.share_token}"

    file_items = [
        ShareBundleFileItem(
            id=str(f.id),
            name=f.file_name,
            size=f.file_size,
            mime_type=f.mime_type,
            can_preview=bundle.allow_preview and _can_preview(f.mime_type),
            display_order=bf.display_order,
        )
        for f, bf in files_data
    ]

    return ShareBundleResponse(
        id=str(bundle.id),
        name=bundle.name,
        description=bundle.description,
        share_url=share_url,
        token=bundle.share_token,
        share_type=bundle.share_type,
        file_count=bundle.file_count,
        total_size=bundle.total_size,
        expires_at=bundle.expires_at,
        password_protected=bool(bundle.password_hash),
        max_downloads=bundle.max_downloads,
        download_count=bundle.download_count,
        view_count=bundle.view_count,
        allow_preview=bundle.allow_preview,
        allow_zip_download=bundle.allow_zip_download,
        is_active=bundle.is_active,
        created_at=bundle.created_at,
        last_accessed=bundle.last_accessed,
        files=file_items,
    )


@router.put("/share-bundles/{bundle_id}", response_model=ShareBundleResponse)
async def update_share_bundle(
    bundle_id: str,
    update_data: ShareBundleUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Update share bundle settings"""

    result = await db.execute(
        select(ShareBundle).filter(
            ShareBundle.id == bundle_id,
            ShareBundle.user_id == current_user.id
        )
    )
    bundle = result.scalar_one_or_none()

    if not bundle:
        raise HTTPException(status_code=404, detail="Share bundle not found")

    # Update fields
    if update_data.name is not None:
        bundle.name = update_data.name
    if update_data.description is not None:
        bundle.description = update_data.description
    if update_data.share_type is not None:
        bundle.share_type = update_data.share_type
    if update_data.expires_hours is not None:
        bundle.expires_at = datetime.utcnow() + timedelta(hours=update_data.expires_hours)
    if update_data.password is not None:
        if update_data.password == "":
            bundle.password_hash = None  # Remove password
        else:
            bundle.password_hash = pwd_context.hash(update_data.password)
    if update_data.max_downloads is not None:
        bundle.max_downloads = update_data.max_downloads
    if update_data.allow_preview is not None:
        bundle.allow_preview = update_data.allow_preview
    if update_data.allow_zip_download is not None:
        bundle.allow_zip_download = update_data.allow_zip_download
    if update_data.is_active is not None:
        bundle.is_active = update_data.is_active

    await db.commit()
    await db.refresh(bundle)

    # Log activity
    await log_activity(
        db, current_user.id, "share_bundle_updated", str(bundle.id),
        {"updates": update_data.model_dump(exclude_none=True)},
        request,
    )

    # Return updated bundle
    return await get_share_bundle(bundle_id, current_user, db)


@router.delete("/share-bundles/{bundle_id}")
async def delete_share_bundle(
    bundle_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Delete a share bundle (does NOT delete the files)"""

    result = await db.execute(
        select(ShareBundle).filter(
            ShareBundle.id == bundle_id,
            ShareBundle.user_id == current_user.id
        )
    )
    bundle = result.scalar_one_or_none()

    if not bundle:
        raise HTTPException(status_code=404, detail="Share bundle not found")

    # Delete bundle files first (cascade should handle this, but being explicit)
    await db.execute(
        delete(ShareBundleFile).where(ShareBundleFile.bundle_id == bundle.id)
    )

    # Delete bundle
    await db.delete(bundle)
    await db.commit()

    # Log activity
    await log_activity(
        db, current_user.id, "share_bundle_deleted", str(bundle_id),
        {"name": bundle.name, "file_count": bundle.file_count},
        request,
    )

    return {"message": "Share bundle deleted", "id": bundle_id}


@router.post("/share-bundles/{bundle_id}/files")
async def add_files_to_bundle(
    bundle_id: str,
    file_data: ShareBundleAddFiles,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Add files to an existing share bundle"""

    result = await db.execute(
        select(ShareBundle).filter(
            ShareBundle.id == bundle_id,
            ShareBundle.user_id == current_user.id
        )
    )
    bundle = result.scalar_one_or_none()

    if not bundle:
        raise HTTPException(status_code=404, detail="Share bundle not found")

    # Verify files exist and belong to user
    files_result = await db.execute(
        select(Object).filter(
            Object.id.in_(file_data.file_ids),
            Object.user_id == current_user.id,
            Object.is_deleted == False
        )
    )
    files = files_result.scalars().all()

    if len(files) != len(file_data.file_ids):
        raise HTTPException(status_code=404, detail="One or more files not found")

    # Get current max display_order
    max_order_result = await db.execute(
        select(func.max(ShareBundleFile.display_order))
        .filter(ShareBundleFile.bundle_id == bundle.id)
    )
    max_order = max_order_result.scalar() or 0

    # Add files
    added_count = 0
    added_size = 0
    for idx, file_obj in enumerate(files):
        # Check if file already in bundle
        existing = await db.execute(
            select(ShareBundleFile).filter(
                ShareBundleFile.bundle_id == bundle.id,
                ShareBundleFile.file_id == file_obj.id
            )
        )
        if existing.scalar_one_or_none():
            continue  # Skip duplicates

        bundle_file = ShareBundleFile(
            bundle_id=bundle.id,
            file_id=file_obj.id,
            display_order=max_order + idx + 1,
        )
        db.add(bundle_file)
        added_count += 1
        added_size += file_obj.file_size

    # Update bundle stats
    bundle.file_count += added_count
    bundle.total_size += added_size

    await db.commit()

    return {
        "message": f"Added {added_count} files to bundle",
        "added_count": added_count,
        "new_file_count": bundle.file_count,
        "new_total_size": bundle.total_size,
    }


@router.delete("/share-bundles/{bundle_id}/files")
async def remove_files_from_bundle(
    bundle_id: str,
    file_data: ShareBundleRemoveFiles,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove files from a share bundle"""

    result = await db.execute(
        select(ShareBundle).filter(
            ShareBundle.id == bundle_id,
            ShareBundle.user_id == current_user.id
        )
    )
    bundle = result.scalar_one_or_none()

    if not bundle:
        raise HTTPException(status_code=404, detail="Share bundle not found")

    # Get files to remove (need their sizes)
    files_result = await db.execute(
        select(Object, ShareBundleFile)
        .join(ShareBundleFile, ShareBundleFile.file_id == Object.id)
        .filter(
            ShareBundleFile.bundle_id == bundle.id,
            Object.id.in_(file_data.file_ids)
        )
    )
    files_to_remove = files_result.all()

    removed_count = len(files_to_remove)
    removed_size = sum(f.file_size for f, bf in files_to_remove)

    # Remove files
    await db.execute(
        delete(ShareBundleFile).where(
            ShareBundleFile.bundle_id == bundle.id,
            ShareBundleFile.file_id.in_(file_data.file_ids)
        )
    )

    # Update bundle stats
    bundle.file_count -= removed_count
    bundle.total_size -= removed_size

    # Deactivate if no files left
    if bundle.file_count <= 0:
        bundle.is_active = False

    await db.commit()

    return {
        "message": f"Removed {removed_count} files from bundle",
        "removed_count": removed_count,
        "new_file_count": bundle.file_count,
        "new_total_size": bundle.total_size,
    }


# ============================================================================
# Public Endpoints - For share bundle viewers (no auth required)
# ============================================================================

@router.get("/share/bundle/{token}/info", response_model=ShareBundlePublicInfo)
async def get_public_bundle_info(
    token: str,
    password: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """Get public info about a share bundle (for viewer page)"""

    result = await db.execute(
        select(ShareBundle, User)
        .join(User, ShareBundle.user_id == User.id)
        .filter(ShareBundle.share_token == token, ShareBundle.is_active == True)
    )
    data = result.first()

    if not data:
        raise HTTPException(status_code=404, detail="Share bundle not found")

    bundle, owner = data

    # Check expiration
    if bundle.expires_at and bundle.expires_at < datetime.utcnow():
        raise HTTPException(status_code=410, detail="Share link has expired")

    # Check password
    if bundle.password_hash:
        if not password:
            # Return minimal info indicating password is required
            return ShareBundlePublicInfo(
                name=bundle.name,
                description=None,
                file_count=bundle.file_count,
                total_size=bundle.total_size,
                share_type=bundle.share_type,
                allow_preview=bundle.allow_preview,
                allow_zip_download=bundle.allow_zip_download,
                requires_password=True,
                files=[],
                owner_name=owner.username,
            )
        if not pwd_context.verify(password, bundle.password_hash):
            raise HTTPException(status_code=401, detail="Invalid password")

    # Increment view count
    bundle.view_count += 1
    bundle.last_accessed = datetime.utcnow()
    await db.commit()

    # First check how many ShareBundleFile records exist
    bundle_files_check = await db.execute(
        select(ShareBundleFile).filter(ShareBundleFile.bundle_id == bundle.id)
    )
    bundle_file_records = bundle_files_check.scalars().all()
    logger.info(f"Bundle {bundle.id}: {len(bundle_file_records)} ShareBundleFile records exist")

    for bf in bundle_file_records:
        logger.info(f"  - ShareBundleFile: file_id={bf.file_id}, order={bf.display_order}")

    # Get files (join ShareBundleFile to Object)
    files_result = await db.execute(
        select(Object, ShareBundleFile)
        .select_from(ShareBundleFile)
        .join(Object, ShareBundleFile.file_id == Object.id)
        .filter(
            ShareBundleFile.bundle_id == bundle.id,
            Object.is_deleted == False  # Don't show deleted files
        )
        .order_by(ShareBundleFile.display_order)
    )
    files_data = files_result.all()

    logger.info(f"Bundle {bundle.id}: found {len(files_data)} active files after join (bundle claims {bundle.file_count})")

    file_items = [
        ShareBundleFileItem(
            id=str(f.id),
            name=f.file_name,
            size=f.file_size,
            mime_type=f.mime_type,
            can_preview=bundle.allow_preview and _can_preview(f.mime_type),
            display_order=bf.display_order,
            folder_path=bf.folder_path,
        )
        for f, bf in files_data
    ]

    return ShareBundlePublicInfo(
        name=bundle.name,
        description=bundle.description,
        file_count=bundle.file_count,
        total_size=bundle.total_size,
        share_type=bundle.share_type,
        allow_preview=bundle.allow_preview,
        allow_zip_download=bundle.allow_zip_download,
        requires_password=False,
        files=file_items,
        owner_name=owner.username,
    )


@router.get("/share/bundle/{token}/file/{file_id}/stream")
async def stream_bundle_file(
    token: str,
    file_id: str,
    request: Request,
    password: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """Stream a single file from a share bundle for preview"""
    from ..services.encryption import encryption_service
    from ..services.download_optimizer import download_optimizer
    import os
    import base64
    import aiofiles

    # Get bundle and verify access
    result = await db.execute(
        select(ShareBundle, User)
        .join(User, ShareBundle.user_id == User.id)
        .filter(ShareBundle.share_token == token, ShareBundle.is_active == True)
    )
    data = result.first()

    if not data:
        raise HTTPException(status_code=404, detail="Share bundle not found")

    bundle, owner = data

    # Check expiration
    if bundle.expires_at and bundle.expires_at < datetime.utcnow():
        raise HTTPException(status_code=410, detail="Share link has expired")

    # Verify password
    if bundle.password_hash:
        if not password or not pwd_context.verify(password, bundle.password_hash):
            raise HTTPException(status_code=401, detail="Password required")

    # Check preview allowed
    if not bundle.allow_preview:
        raise HTTPException(status_code=403, detail="Preview not allowed")

    # Verify file is in bundle
    file_in_bundle = await db.execute(
        select(ShareBundleFile).filter(
            ShareBundleFile.bundle_id == bundle.id,
            ShareBundleFile.file_id == file_id
        )
    )
    if not file_in_bundle.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="File not in bundle")

    # Get file (ensure it's not deleted)
    file_result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.is_deleted == False)
    )
    file_obj = file_result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found or has been deleted")

    # Decrypt file key
    file_key = encryption_service.decrypt_key(file_obj.encryption_key)

    mime_type = file_obj.mime_type or 'application/octet-stream'
    filename = file_obj.file_name.replace('"', '\\"')
    total_size = file_obj.file_size

    # Handle range requests
    range_header = request.headers.get("Range")

    async def parse_range(header: str, file_size: int):
        if not header or not header.startswith("bytes="):
            return None
        try:
            range_spec = header[6:]
            if '-' not in range_spec:
                return None
            parts = range_spec.split('-')
            start = int(parts[0]) if parts[0] else 0
            end = int(parts[1]) if parts[1] else file_size - 1
            if start > end or start >= file_size:
                return None
            end = min(end, file_size - 1)
            return (start, end)
        except ValueError:
            return None

    parsed_range = await parse_range(range_header, total_size) if total_size else None

    base_headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": mime_type,
        "Content-Disposition": f'inline; filename="{filename}"',
        "Cache-Control": "public, max-age=3600",
    }

    was_compressed = file_obj.file_metadata and isinstance(file_obj.file_metadata, dict) and file_obj.file_metadata.get("compressed", False)

    # INLINE STORAGE
    if file_obj.storage_type == "inline":
        encrypted_data = base64.b64decode(file_obj.storage_key)
        data = encryption_service.decrypt_file(encrypted_data, file_key)

        if was_compressed:
            from ..utils.compression import compressor
            data = compressor.decompress(data)

        if parsed_range:
            start, end = parsed_range
            chunk = data[start:end + 1]
            headers = {**base_headers, "Content-Range": f"bytes {start}-{end}/{total_size}", "Content-Length": str(len(chunk))}
            return Response(content=chunk, status_code=206, headers=headers)
        else:
            headers = {**base_headers, "Content-Length": str(len(data))}
            return Response(content=data, status_code=200, headers=headers)

    # SINGLE FILE STORAGE
    elif file_obj.storage_type == "single":
        if not os.path.exists(file_obj.object_path):
            raise HTTPException(status_code=404, detail="File not found on disk")

        if parsed_range:
            start, end = parsed_range
            headers = {**base_headers, "Content-Range": f"bytes {start}-{end}/{total_size}", "Content-Length": str(end - start + 1)}
            generator = download_optimizer.stream_single_file_optimized(
                file_path=file_obj.object_path,
                file_key=file_key,
                encryption_service=encryption_service,
                start_byte=start,
                end_byte=end,
                compressed=was_compressed
            )
            return StreamingResponse(generator, status_code=206, headers=headers, media_type=mime_type)
        else:
            headers = {**base_headers, "Content-Length": str(total_size)}
            generator = download_optimizer.stream_single_file_optimized(
                file_path=file_obj.object_path,
                file_key=file_key,
                encryption_service=encryption_service,
                start_byte=0,
                end_byte=total_size - 1,
                compressed=was_compressed
            )
            return StreamingResponse(generator, status_code=200, headers=headers, media_type=mime_type)

    # CHUNKED STORAGE
    else:
        from .files import stream_chunked_range

        if parsed_range:
            start, end = parsed_range
            headers = {**base_headers, "Content-Range": f"bytes {start}-{end}/{total_size}", "Content-Length": str(end - start + 1)}
            generator = stream_chunked_range(file_obj, start, end, file_key, encryption_service)
            return StreamingResponse(generator, status_code=206, headers=headers, media_type=mime_type)
        else:
            headers = {**base_headers, "Content-Length": str(total_size)}
            generator = stream_chunked_range(file_obj, 0, total_size - 1, file_key, encryption_service)
            return StreamingResponse(generator, status_code=200, headers=headers, media_type=mime_type)


@router.get("/share/bundle/{token}/download")
async def download_bundle_as_zip(
    token: str,
    password: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """Download all files in bundle as a ZIP file"""
    from ..services.encryption import encryption_service
    import os
    import base64

    # Get bundle
    result = await db.execute(
        select(ShareBundle).filter(
            ShareBundle.share_token == token,
            ShareBundle.is_active == True
        )
    )
    bundle = result.scalar_one_or_none()

    if not bundle:
        raise HTTPException(status_code=404, detail="Share bundle not found")

    # Check expiration
    if bundle.expires_at and bundle.expires_at < datetime.utcnow():
        raise HTTPException(status_code=410, detail="Share link has expired")

    # Verify password
    if bundle.password_hash:
        if not password or not pwd_context.verify(password, bundle.password_hash):
            raise HTTPException(status_code=401, detail="Password required")

    # Check ZIP download allowed
    if not bundle.allow_zip_download:
        raise HTTPException(status_code=403, detail="ZIP download not allowed")

    # Check download permission
    if bundle.share_type == 'view':
        raise HTTPException(status_code=403, detail="Download not allowed - view only")

    # Check max downloads
    if bundle.max_downloads and bundle.download_count >= bundle.max_downloads:
        raise HTTPException(status_code=403, detail="Download limit reached")

    # Get all files in bundle (filter out deleted files)
    files_result = await db.execute(
        select(Object, ShareBundleFile)
        .select_from(ShareBundleFile)
        .join(Object, ShareBundleFile.file_id == Object.id)
        .filter(
            ShareBundleFile.bundle_id == bundle.id,
            Object.is_deleted == False
        )
        .order_by(ShareBundleFile.display_order)
    )
    files_data = files_result.all()

    if not files_data:
        raise HTTPException(status_code=404, detail="No files in bundle (all files may have been deleted)")

    # Increment download count
    bundle.download_count += 1
    bundle.last_accessed = datetime.utcnow()
    await db.commit()

    # Create ZIP in memory
    zip_buffer = io.BytesIO()

    with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zip_file:
        for file_obj, bundle_file in files_data:
            try:
                # Decrypt file key
                file_key = encryption_service.decrypt_key(file_obj.encryption_key)

                # Get file content
                if file_obj.storage_type == "inline":
                    encrypted_data = base64.b64decode(file_obj.storage_key)
                    file_content = encryption_service.decrypt_file(encrypted_data, file_key)
                elif file_obj.storage_type == "single" and os.path.exists(file_obj.object_path):
                    # Read and decrypt file
                    with open(file_obj.object_path, 'rb') as f:
                        encrypted_data = f.read()
                    file_content = encryption_service.decrypt_file(encrypted_data, file_key)
                else:
                    # Skip files we can't read
                    logger.warning(f"Skipping file {file_obj.id} - storage type {file_obj.storage_type}")
                    continue

                # Handle compression
                if file_obj.file_metadata and isinstance(file_obj.file_metadata, dict) and file_obj.file_metadata.get("compressed", False):
                    from ..utils.compression import compressor
                    file_content = compressor.decompress(file_content)

                # Add to ZIP with folder structure preserved
                zip_path = file_obj.file_name
                if bundle_file.folder_path:
                    zip_path = f"{bundle_file.folder_path}{file_obj.file_name}"
                zip_file.writestr(zip_path, file_content)

            except Exception as e:
                logger.error(f"Error adding file {file_obj.id} to ZIP: {e}")
                continue

    zip_buffer.seek(0)

    # Generate ZIP filename
    safe_name = "".join(c for c in bundle.name if c.isalnum() or c in (' ', '-', '_')).rstrip()
    zip_filename = f"{safe_name}.zip"

    return StreamingResponse(
        io.BytesIO(zip_buffer.read()),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{zip_filename}"',
            "Content-Type": "application/zip",
        }
    )


# ============================================================================
# Helper Functions
# ============================================================================

def _can_preview(mime_type: Optional[str]) -> bool:
    """Check if a file type can be previewed"""
    if not mime_type:
        return False

    previewable_types = [
        'image/',
        'video/',
        'audio/',
        'application/pdf',
        'text/',
    ]

    return any(mime_type.startswith(t) for t in previewable_types)
