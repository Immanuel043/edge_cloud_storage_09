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

from fastapi import APIRouter, Depends, HTTPException, Request, Query, BackgroundTasks
from fastapi.responses import StreamingResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, delete, or_
from typing import List, Optional
from datetime import datetime, timedelta
import asyncio
import secrets
import logging

from ..dependencies import get_db, get_current_user, log_activity
from ..services.auth import auth_service, pwd_context
from ..utils.rate_limiter import limiter, share_limiter, RateLimitConfig, check_ip_whitelist
from ..utils.access_logger import log_share_access
from ..models.database import User, Object, ShareBundle, ShareBundleFile, Folder, SharedAccess
from ..models.schemas import (
    ShareBundleCreate, ShareBundleUpdate, ShareBundleResponse,
    ShareBundleListResponse, ShareBundlePublicInfo, ShareBundleFileItem,
    ShareBundleAddFiles, ShareBundleRemoveFiles,
    CollaborativeShareCreate, CollaborativeShareResponse,
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

    # Filter out ZK-encrypted files (server cannot decrypt them for public sharing)
    zk_excluded = [(f, p) for f, p in files_with_paths if f.encryption_mode == 'client_zk']
    excluded_zk_count = len(zk_excluded)
    if excluded_zk_count > 0:
        files_with_paths = [(f, p) for f, p in files_with_paths if f.encryption_mode != 'client_zk']
        if not files_with_paths:
            raise HTTPException(
                status_code=400,
                detail="All selected files use zero-knowledge encryption and cannot be shared via bundles"
            )

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
        password_hash = await auth_service.async_get_password_hash(bundle_data.password)

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
        show_file_sizes=bundle_data.show_file_sizes,
        allowed_ips=bundle_data.allowed_ips,
        watermark_text=bundle_data.watermark_text,
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

    zk_warning = None
    if excluded_zk_count > 0:
        zk_warning = f"{excluded_zk_count} ZK-encrypted file{'s' if excluded_zk_count > 1 else ''} excluded from bundle"

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
        excluded_zk_count=excluded_zk_count,
        warning=zk_warning,
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
            bundle.password_hash = await auth_service.async_get_password_hash(update_data.password)
    if update_data.max_downloads is not None:
        bundle.max_downloads = update_data.max_downloads
    if update_data.allow_preview is not None:
        bundle.allow_preview = update_data.allow_preview
    if update_data.allow_zip_download is not None:
        bundle.allow_zip_download = update_data.allow_zip_download
    if update_data.show_file_sizes is not None:
        bundle.show_file_sizes = update_data.show_file_sizes
    if update_data.is_active is not None:
        bundle.is_active = update_data.is_active
    if update_data.allowed_ips is not None:
        bundle.allowed_ips = update_data.allowed_ips if update_data.allowed_ips else None
    if update_data.watermark_text is not None:
        bundle.watermark_text = update_data.watermark_text or None

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


@router.post("/share-bundles/{bundle_id}/collaborate", response_model=List[CollaborativeShareResponse])
async def share_bundle_with_users(
    bundle_id: str,
    share_data: CollaborativeShareCreate,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Share a bundle with specific users by email — collaborative sharing"""
    import secrets as _secrets

    # Verify bundle exists and belongs to user
    result = await db.execute(
        select(ShareBundle).filter(ShareBundle.id == bundle_id, ShareBundle.user_id == current_user.id)
    )
    bundle = result.scalar_one_or_none()
    if not bundle:
        raise HTTPException(status_code=404, detail="Share bundle not found")

    # Calculate expiration
    expires_at = None
    if share_data.expires_hours:
        from datetime import timedelta
        expires_at = datetime.utcnow() + timedelta(hours=share_data.expires_hours)

    shared_items = []
    for email in share_data.emails:
        if email == current_user.email:
            continue  # Skip self-sharing

        # Check for existing share
        existing = await db.execute(
            select(SharedAccess).filter(
                SharedAccess.bundle_id == bundle_id,
                SharedAccess.shared_with_email == email,
                SharedAccess.invitation_status != 'declined',
            )
        )
        if existing.scalar_one_or_none():
            continue  # Skip duplicates

        # Check if recipient is a registered user
        recipient_result = await db.execute(
            select(User).filter(User.email == email)
        )
        recipient_user = recipient_result.scalar_one_or_none()

        invitation_token = _secrets.token_urlsafe(32)

        shared_access = SharedAccess(
            owner_id=current_user.id,
            shared_with_email=email,
            shared_with_user_id=recipient_user.id if recipient_user else None,
            bundle_id=bundle_id,
            permission=share_data.permission,
            invitation_status='accepted' if recipient_user else 'pending',
            invitation_token=invitation_token,
            expires_at=expires_at,
        )
        db.add(shared_access)
        shared_items.append((shared_access, email, invitation_token, recipient_user))

    await db.commit()

    responses = []
    for shared_access, email, invitation_token, recipient_user in shared_items:
        await db.refresh(shared_access)
        responses.append(CollaborativeShareResponse(
            id=str(shared_access.id),
            shared_with_email=email,
            permission=share_data.permission,
            invitation_status=shared_access.invitation_status,
            invitation_token=invitation_token if not recipient_user else None,
            created_at=shared_access.created_at,
        ))

    # Log activity
    await log_activity(
        db, current_user.id, "bundle_shared_collaborative", str(bundle_id),
        {"emails": share_data.emails, "permission": share_data.permission},
        request,
    )

    # Send email notifications (fire-and-forget)
    from ..services.email_service import email_service
    from ..config import settings
    from urllib.parse import urlencode
    for _shared_access, email, invitation_token, recipient_user in shared_items:
        if recipient_user:
            share_url = f"{settings.FRONTEND_URL}/?view=shared-with-me"
        else:
            share_url = (
                f"{settings.FRONTEND_URL}/auth?"
                + urlencode({"invitation": invitation_token, "email": email})
            )
        background_tasks.add_task(
            email_service.send_share_notification,
            to_email=email,
            owner_email=current_user.email,
            item_name=bundle.name,
            item_type="bundle",
            permission=share_data.permission,
            message=share_data.message,
            share_url=share_url,
        )

    return responses


# ============================================================================
# Public Endpoints - For share bundle viewers (no auth required)
# ============================================================================

@router.get("/share/bundle/{token}/info", response_model=ShareBundlePublicInfo)
@share_limiter.limit(RateLimitConfig.SHARE_PASSWORD_CHECK)
async def get_public_bundle_info(
    token: str,
    request: Request,
    background_tasks: BackgroundTasks,
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

    # Check IP whitelist
    if not check_ip_whitelist(request, bundle.allowed_ips):
        raise HTTPException(status_code=403, detail="Access denied: your IP is not on the allow list")

    # Check password (accept from both header and query param, header takes precedence)
    pw = request.headers.get("X-Share-Password") or password
    if bundle.password_hash:
        if not pw:
            # Return minimal info indicating password is required
            return ShareBundlePublicInfo(
                name=bundle.name,
                description=None,
                file_count=bundle.file_count,
                total_size=bundle.total_size,
                share_type=bundle.share_type,
                allow_preview=bundle.allow_preview,
                allow_zip_download=bundle.allow_zip_download,
                show_file_sizes=bundle.show_file_sizes,
                requires_password=True,
                files=[],
                owner_name=owner.username,
                watermark_text=bundle.watermark_text,
            )
        if not await auth_service.async_verify_password(pw, bundle.password_hash):
            raise HTTPException(status_code=401, detail="Invalid password")

    # Increment view count
    bundle.view_count += 1
    bundle.last_accessed = datetime.utcnow()
    await db.commit()

    background_tasks.add_task(log_share_access, request, "view", bundle_id=bundle.id)

    # First check how many ShareBundleFile records exist
    bundle_files_check = await db.execute(
        select(ShareBundleFile).filter(ShareBundleFile.bundle_id == bundle.id)
    )
    bundle_file_records = bundle_files_check.scalars().all()
    logger.info(f"Bundle {bundle.id}: {len(bundle_file_records)} ShareBundleFile records exist")

    for bf in bundle_file_records:
        logger.info(f"  - ShareBundleFile: file_id={bf.file_id}, order={bf.display_order}")

    # Get visible files (exclude deleted and ZK-encrypted files)
    files_result = await db.execute(
        select(Object, ShareBundleFile)
        .select_from(ShareBundleFile)
        .join(Object, ShareBundleFile.file_id == Object.id)
        .filter(
            ShareBundleFile.bundle_id == bundle.id,
            Object.is_deleted == False,
            or_(Object.encryption_mode == None, Object.encryption_mode != 'client_zk')
        )
        .order_by(ShareBundleFile.display_order)
    )
    files_data = files_result.all()

    logger.info(f"Bundle {bundle.id}: found {len(files_data)} visible files after join (bundle claims {bundle.file_count})")

    # Compute real stats from visible files
    real_file_count = len(files_data)
    real_total_size = sum(f.file_size for f, bf in files_data)

    # Lazy write-on-read correction for stale stats
    if bundle.file_count != real_file_count or bundle.total_size != real_total_size:
        bundle.file_count = real_file_count
        bundle.total_size = real_total_size
        await db.commit()

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
        file_count=real_file_count,
        total_size=real_total_size,
        share_type=bundle.share_type,
        allow_preview=bundle.allow_preview,
        allow_zip_download=bundle.allow_zip_download,
        show_file_sizes=bundle.show_file_sizes,
        requires_password=False,
        files=file_items,
        owner_name=owner.username,
        watermark_text=bundle.watermark_text,
    )


@router.get("/share/bundle/{token}/file/{file_id}/stream")
@limiter.limit(RateLimitConfig.SHARE_STREAM)
async def stream_bundle_file(
    token: str,
    file_id: str,
    request: Request,
    background_tasks: BackgroundTasks,
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

    # Check IP whitelist
    if not check_ip_whitelist(request, bundle.allowed_ips):
        raise HTTPException(status_code=403, detail="Access denied: your IP is not on the allow list")

    # Verify password (accept from both header and query param, header takes precedence)
    pw = request.headers.get("X-Share-Password") or password
    if bundle.password_hash:
        if not pw or not await auth_service.async_verify_password(pw, bundle.password_hash):
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

    # Block ZK-encrypted files from preview
    if file_obj.encryption_mode == 'client_zk':
        raise HTTPException(status_code=404, detail="This file uses zero-knowledge encryption and cannot be previewed from a shared bundle")

    background_tasks.add_task(log_share_access, request, "stream", bundle_id=bundle.id, file_id=file_obj.id)

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
        if not await asyncio.to_thread(os.path.exists, file_obj.object_path):
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


@router.get("/share/bundle/{token}/file/{file_id}/download")
@share_limiter.limit(RateLimitConfig.SHARE_DOWNLOAD)
async def download_bundle_file(
    token: str,
    file_id: str,
    request: Request,
    background_tasks: BackgroundTasks,
    password: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """Download a single file from a share bundle (enforces share_type and max_downloads)"""
    from ..services.encryption import encryption_service
    from ..services.download_optimizer import download_optimizer
    import os
    import base64

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

    # Check IP whitelist
    if not check_ip_whitelist(request, bundle.allowed_ips):
        raise HTTPException(status_code=403, detail="Access denied: your IP is not on the allow list")

    # Verify password
    pw = request.headers.get("X-Share-Password") or password
    if bundle.password_hash:
        if not pw or not await auth_service.async_verify_password(pw, bundle.password_hash):
            raise HTTPException(status_code=401, detail="Password required")

    # Enforce download permission
    if bundle.share_type == 'view':
        raise HTTPException(status_code=403, detail="Download not allowed - view only")

    # Enforce download limit
    if bundle.max_downloads and bundle.download_count >= bundle.max_downloads:
        raise HTTPException(status_code=403, detail="Download limit reached")

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

    # Block ZK-encrypted files
    if file_obj.encryption_mode == 'client_zk':
        raise HTTPException(status_code=404, detail="This file uses zero-knowledge encryption and cannot be downloaded from a shared bundle")

    # Increment download count
    bundle.download_count += 1
    bundle.last_accessed = datetime.utcnow()
    await db.commit()

    background_tasks.add_task(log_share_access, request, "download_file", bundle_id=bundle.id, file_id=file_obj.id)

    # Decrypt file key
    file_key = encryption_service.decrypt_key(file_obj.encryption_key)

    mime_type = file_obj.mime_type or 'application/octet-stream'
    filename = file_obj.file_name.replace('"', '\\"')
    total_size = file_obj.file_size

    headers = {
        "Content-Type": mime_type,
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Content-Length": str(total_size),
    }

    was_compressed = file_obj.file_metadata and isinstance(file_obj.file_metadata, dict) and file_obj.file_metadata.get("compressed", False)

    # INLINE STORAGE
    if file_obj.storage_type == "inline":
        encrypted_data = base64.b64decode(file_obj.storage_key)
        file_data = encryption_service.decrypt_file(encrypted_data, file_key)

        if was_compressed:
            from ..utils.compression import compressor
            file_data = compressor.decompress(file_data)

        return Response(content=file_data, status_code=200, headers=headers)

    # SINGLE FILE STORAGE
    elif file_obj.storage_type == "single":
        if not os.path.exists(file_obj.object_path):
            raise HTTPException(status_code=404, detail="File not found on disk")

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

        generator = stream_chunked_range(file_obj, 0, total_size - 1, file_key, encryption_service)
        return StreamingResponse(generator, status_code=200, headers=headers, media_type=mime_type)


@router.get("/share/bundle/{token}/download")
@share_limiter.limit(RateLimitConfig.SHARE_DOWNLOAD)
async def download_bundle_as_zip(
    token: str,
    request: Request,
    background_tasks: BackgroundTasks,
    password: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """Download all files in bundle as a ZIP file"""
    from ..services.encryption import encryption_service
    from ..utils.zip_builder import ZipFileEntry, build_zip_response

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

    # Check IP whitelist
    if not check_ip_whitelist(request, bundle.allowed_ips):
        raise HTTPException(status_code=403, detail="Access denied: your IP is not on the allow list")

    # Verify password (accept from both header and query param, header takes precedence)
    pw = request.headers.get("X-Share-Password") or password
    if bundle.password_hash:
        if not pw or not await auth_service.async_verify_password(pw, bundle.password_hash):
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

    # Get visible files in bundle (filter out deleted and ZK-encrypted files)
    files_result = await db.execute(
        select(Object, ShareBundleFile)
        .select_from(ShareBundleFile)
        .join(Object, ShareBundleFile.file_id == Object.id)
        .filter(
            ShareBundleFile.bundle_id == bundle.id,
            Object.is_deleted == False,
            or_(Object.encryption_mode == None, Object.encryption_mode != 'client_zk')
        )
        .order_by(ShareBundleFile.display_order)
    )
    files_data = files_result.all()

    if not files_data:
        raise HTTPException(status_code=404, detail="No files in bundle (all files may have been deleted)")

    # Build ZIP entries with folder structure preserved
    entries = []
    for file_obj, bundle_file in files_data:
        zip_path = file_obj.file_name
        if bundle_file.folder_path:
            zip_path = f"{bundle_file.folder_path}{file_obj.file_name}"
        entries.append(ZipFileEntry(file_obj, zip_path))

    # Generate ZIP filename
    safe_name = "".join(c for c in bundle.name if c.isalnum() or c in (' ', '-', '_')).rstrip()
    zip_filename = f"{safe_name}.zip"

    # Build ZIP (in-memory for <500MB, temp file for larger)
    response = await build_zip_response(entries, encryption_service, zip_filename)

    # Increment download count only after ZIP is successfully created
    bundle.download_count += 1
    bundle.last_accessed = datetime.utcnow()
    await db.commit()

    background_tasks.add_task(log_share_access, request, "download_zip", bundle_id=bundle.id)

    return response


@router.get("/share/bundle/{token}/file/{file_id}/thumbnail")
@limiter.limit(RateLimitConfig.SHARE_THUMBNAIL)
async def get_bundle_file_thumbnail(
    token: str,
    file_id: str,
    request: Request,
    background_tasks: BackgroundTasks,
    size: str = 'medium',
    password: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """Get thumbnail for a file in a share bundle (public endpoint)"""
    from ..services.preview_generator import preview_generator
    from ..services.preview_optimizer import preview_optimizer
    from ..services.encryption import encryption_service
    import os

    # Get bundle and verify access
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

    # Check IP whitelist
    if not check_ip_whitelist(request, bundle.allowed_ips):
        raise HTTPException(status_code=403, detail="Access denied: your IP is not on the allow list")

    # Verify password (accept from both header and query param, header takes precedence)
    pw = request.headers.get("X-Share-Password") or password
    if bundle.password_hash:
        if not pw or not await auth_service.async_verify_password(pw, bundle.password_hash):
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

    # Get file
    file_result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.is_deleted == False)
    )
    file_obj = file_result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Check if ZK encrypted (no thumbnails for ZK files in public shares)
    if file_obj.encryption_mode == 'client_zk':
        raise HTTPException(status_code=404, detail="Thumbnails not available for encrypted files")

    background_tasks.add_task(log_share_access, request, "thumbnail", bundle_id=bundle.id, file_id=file_obj.id)

    # Validate size
    if size not in ['small', 'medium', 'large']:
        size = 'medium'

    # Check Redis preview cache first (shared with main files endpoint)
    try:
        from ..database import get_redis
        redis = await get_redis()
        cache_key = f"preview:{file_id}:{size}"
        cached_preview = await redis.get(cache_key)
        if cached_preview:
            return Response(
                content=cached_preview,
                media_type='image/jpeg',
                headers={
                    "Cache-Control": "public, max-age=86400",
                    "X-Preview-Status": "cached"
                }
            )
    except Exception:
        pass  # Redis unavailable, fall through to generation

    # Disk fallback: check disk before downloading/regenerating
    try:
        from ..services.preview_storage import (
            async_load_preview_from_disk, async_get_disk_content_hash,
            async_delete_previews_from_disk, async_save_preview_to_disk,
            preview_cache_ttl,
        )
        disk_bytes = await async_load_preview_from_disk(str(file_id), size)
        if disk_bytes:
            disk_hash = await async_get_disk_content_hash(str(file_id))
            current_hash = getattr(file_obj, 'content_hash', None)
            if disk_hash and current_hash and disk_hash == current_hash:
                # Re-populate Redis and serve
                try:
                    ttl = preview_cache_ttl(file_obj.mime_type)
                    await redis.setex(cache_key, ttl, disk_bytes)
                except Exception:
                    pass
                return Response(
                    content=disk_bytes,
                    media_type='image/jpeg',
                    headers={
                        "Cache-Control": "public, max-age=86400",
                        "X-Preview-Status": "cached"
                    }
                )
            else:
                if disk_hash and current_hash and disk_hash != current_hash:
                    await async_delete_previews_from_disk(str(file_id))
    except Exception:
        pass  # Disk check failure is non-fatal

    # --- Status-aware preview handling (mirrors files.py:1306-1401) ---
    import json as _json

    async def _queue_share_preview_to_kafka(_file_id, _file_obj, _redis, _status_key) -> bool:
        """Queue preview to Kafka. Sets status ONLY on success."""
        try:
            from ..services.kafka_client import get_kafka_producer
            producer = await get_kafka_producer()
            if not producer:
                return False
            await producer.send_and_wait(
                'preview-processing',
                _json.dumps({
                    'file_id': str(_file_id),
                    'upload_id': str((_file_obj.chunk_info or {}).get('upload_id', _file_id)) if _file_obj.chunk_info else str(_file_id),
                    'timestamp': datetime.utcnow().isoformat(),
                }).encode('utf-8')
            )
            # Status set AFTER successful publish
            await _redis.setex(_status_key, 3600, _json.dumps({
                'status': 'queued',
                'queued_at': datetime.utcnow().isoformat(),
            }))
            return True
        except Exception as e:
            logger.warning(f"Failed to queue preview for share: {e}")
            return False

    def _return_share_placeholder(mime_type=None):
        """Return a minimal 1x1 transparent PNG as placeholder."""
        # 1x1 transparent PNG (67 bytes)
        png_data = (
            b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01'
            b'\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89'
            b'\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01'
            b'\r\n\xb4\x00\x00\x00\x00IEND\xaeB`\x82'
        )
        return Response(
            content=png_data,
            media_type='image/png',
            headers={
                "Cache-Control": "no-cache",
                "X-Preview-Status": "processing",
            }
        )

    def _optimization_active() -> bool:
        return (
            hasattr(file_obj, 'video_processing_status')
            and file_obj.video_processing_status in ('queued', 'processing')
        )

    try:
        status_key = f"preview:status:{file_id}"
        status_raw = await redis.get(status_key)

        if status_raw:
            try:
                status_info = _json.loads(
                    status_raw if isinstance(status_raw, str) else status_raw.decode()
                )
                status = status_info.get('status')

                if status in ('queued', 'processing'):
                    return _return_share_placeholder(file_obj.mime_type)

                elif status == 'ready':
                    # Cache + disk already checked above; if we're here, both missed
                    if _optimization_active():
                        return _return_share_placeholder(file_obj.mime_type)
                    # Re-queue to regenerate
                    queued = await _queue_share_preview_to_kafka(
                        file_id, file_obj, redis, status_key
                    )
                    if queued:
                        return _return_share_placeholder(file_obj.mime_type)
                    # Fall through to try generation

                elif status == 'failed':
                    retry_count = status_info.get('retry_count', 0)
                    is_retryable = status_info.get('retryable', True)

                    if is_retryable and retry_count < 3:
                        if _optimization_active():
                            return _return_share_placeholder(file_obj.mime_type)
                        queued = await _queue_share_preview_to_kafka(
                            file_id, file_obj, redis, status_key
                        )
                        if queued:
                            return _return_share_placeholder(file_obj.mime_type)
                    else:
                        # Terminal failure
                        raise HTTPException(
                            status_code=404,
                            detail="Preview generation failed"
                        )
            except (_json.JSONDecodeError, ValueError):
                pass  # Malformed status — try generation
            except HTTPException:
                raise
    except HTTPException:
        raise
    except Exception:
        pass  # Redis error — fall through to generation

    temp_file_path = None
    try:
        # Download file content for preview generation
        result = await preview_optimizer.download_partial_for_preview(
            file_obj=file_obj,
            encryption_service=encryption_service
        )

        if result.status == 'deferred':
            if _optimization_active():
                return _return_share_placeholder(file_obj.mime_type)
            # Queue to Kafka, return placeholder
            queued = await _queue_share_preview_to_kafka(
                file_id, file_obj, redis, status_key
            )
            if queued:
                return _return_share_placeholder(file_obj.mime_type)
            # Kafka unavailable — fall through to 404
            raise HTTPException(
                status_code=404,
                detail="Could not generate thumbnail (deferred, Kafka unavailable)"
            )
        elif result.status != 'ok':
            raise HTTPException(status_code=404, detail="Could not download file for thumbnail")
        temp_file_path = result.temp_file_path

        # Generate preview using the preview generator
        preview_bytes, content_type = await preview_generator.generate_preview(
            file_path=temp_file_path,
            mime_type=file_obj.mime_type,
            size=size,
            file_name=file_obj.file_name
        )

        if preview_bytes:
            # Write-through: persist to Redis and disk for future requests
            try:
                from ..services.preview_storage import (
                    async_save_preview_to_disk as _async_save, preview_cache_ttl,
                )
                ttl = preview_cache_ttl(file_obj.mime_type)
                await redis.setex(cache_key, ttl, preview_bytes)
                source_hash = getattr(file_obj, 'content_hash', None)
                if source_hash:
                    await _async_save(str(file_id), size, preview_bytes, source_hash)
            except Exception:
                pass  # Non-fatal: preview is still served even if persistence fails

            return Response(
                content=preview_bytes,
                media_type=content_type or "image/jpeg",
                headers={
                    "Cache-Control": "public, max-age=86400",  # 1 day HTTP cache
                    "X-Preview-Status": "generated"
                }
            )
        else:
            raise HTTPException(status_code=404, detail="Could not generate thumbnail")

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error generating thumbnail for file {file_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to generate thumbnail")
    finally:
        # Clean up temp file if created (and not using cached transcoded version)
        if temp_file_path and temp_file_path.startswith('/tmp') and os.path.exists(temp_file_path):
            try:
                os.remove(temp_file_path)
            except Exception:
                pass


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
