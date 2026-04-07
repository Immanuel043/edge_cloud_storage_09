# services/storage-service/app/routers/sharing.py
"""
Advanced sharing endpoints - Google Drive style collaborative sharing
"""

from fastapi import APIRouter, Depends, HTTPException, Request, Query, Body, Header, BackgroundTasks
from fastapi.responses import StreamingResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_, and_, func as sql_func
from typing import List, Optional
from datetime import datetime, timedelta
import secrets
import logging
from urllib.parse import quote

logger = logging.getLogger(__name__)


def _content_disposition(disposition: str, filename: str) -> str:
    """Build a Content-Disposition header value safe for non-ASCII filenames (RFC 5987)."""
    ascii_safe = filename.encode('ascii', errors='replace').decode('ascii').replace('"', '\\"')
    try:
        filename.encode('latin-1')
        return f'{disposition}; filename="{ascii_safe}"'
    except UnicodeEncodeError:
        encoded = quote(filename, safe='')
        return f"{disposition}; filename=\"{ascii_safe}\"; filename*=UTF-8''{encoded}"

from ..dependencies import get_db, get_current_user, log_activity
from ..services.auth import auth_service, pwd_context
from ..utils.rate_limiter import limiter, share_limiter, RateLimitConfig, check_ip_whitelist
from ..utils.access_logger import log_share_access
from ..models.database import User, Object, Folder, ShareLink, SharedAccess, ShareAccessLog, ShareBundle
from ..models.schemas import (
    ShareCreate, ShareResponse,
    CollaborativeShareCreate, CollaborativeShareResponse,
    SharedItemResponse, PendingInvitationResponse,
    ShareLinkUpdate, ShareLinkDetail, ShareLinkListResponse,
    ShareAccessLogEntry, ShareAccessLogResponse,
    ShareAnalyticsSummary, ShareDailyStats, ShareAnalyticsTrends,
    ShareItemStats, ShareAnalyticsTopItems,
)

router = APIRouter(prefix="/api/v1", tags=["sharing"])


@router.post("/folders/{folder_id}/share", response_model=ShareResponse)
async def create_folder_share_link(
    folder_id: str,
    share_data: ShareCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Create shareable link for a folder - anyone with link"""
    # Verify folder exists and belongs to user
    result = await db.execute(
        select(Folder).filter(Folder.id == folder_id, Folder.user_id == current_user.id)
    )
    folder_obj = result.scalar_one_or_none()

    if not folder_obj:
        raise HTTPException(status_code=404, detail="Folder not found")

    # Check for ZK-encrypted files in folder (direct children only)
    zk_check = await db.execute(
        select(Object).filter(
            Object.folder_id == folder_id,
            Object.user_id == current_user.id,
            Object.is_deleted == False,
        )
    )
    all_folder_files = zk_check.scalars().all()
    zk_files_count = sum(1 for f in all_folder_files if f.encryption_mode == 'client_zk')
    non_zk_files_count = len(all_folder_files) - zk_files_count

    if zk_files_count > 0 and non_zk_files_count == 0:
        raise HTTPException(
            status_code=400,
            detail="All files in this folder use zero-knowledge encryption and cannot be shared via folder link"
        )

    # Generate unique share token
    share_token = secrets.token_urlsafe(32)

    # Calculate expiration
    expires_at = None
    if share_data.expires_hours:
        expires_at = datetime.utcnow() + timedelta(hours=share_data.expires_hours)

    # Hash password if provided
    password_hash = None
    if share_data.password:
        password_hash = await auth_service.async_get_password_hash(share_data.password)

    # Create share link in database
    share_link = ShareLink(
        share_token=share_token,
        folder_id=folder_id,
        user_id=current_user.id,
        share_type=share_data.share_type,
        password_hash=password_hash,
        expires_at=expires_at,
        max_downloads=share_data.max_downloads,
        download_count=0,
        view_count=0,
        is_active=True,
        allow_preview=share_data.allow_preview,
        allowed_ips=share_data.allowed_ips,
        watermark_text=share_data.watermark_text,
    )

    db.add(share_link)
    await db.commit()
    await db.refresh(share_link)

    # Log activity
    await log_activity(
        db, current_user.id, "folder_shared", str(folder_id),
        {
            "share_type": share_data.share_type,
            "expires_hours": share_data.expires_hours,
            "has_password": bool(share_data.password),
        },
        request,
    )

    # Build frontend share URL
    from ..config import settings
    frontend_url = getattr(settings, 'FRONTEND_URL', "http://localhost:3000")
    share_url = f"{frontend_url}/share/{share_token}"

    zk_warning = None
    if zk_files_count > 0:
        zk_warning = f"{zk_files_count} ZK-encrypted file{'s' if zk_files_count > 1 else ''} in this folder will be hidden from viewers"

    return ShareResponse(
        share_url=share_url,
        token=share_token,
        share_type=share_data.share_type,
        expires_at=expires_at.isoformat() if expires_at else None,
        password_protected=bool(share_data.password),
        max_downloads=share_data.max_downloads,
        downloads_used=0,
        allow_preview=share_data.allow_preview,
        zk_files_hidden=zk_files_count,
        warning=zk_warning,
    )


@router.post("/files/{file_id}/collaborate", response_model=List[CollaborativeShareResponse])
async def share_file_with_users(
    file_id: str,
    share_data: CollaborativeShareCreate,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Share file with specific users by email - collaborative sharing"""
    # Verify file exists and belongs to user
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Calculate expiration
    expires_at = None
    if share_data.expires_hours:
        expires_at = datetime.utcnow() + timedelta(hours=share_data.expires_hours)

    shared_items = []
    for email in share_data.emails:
        # Check if user exists
        user_result = await db.execute(select(User).filter(User.email == email))
        recipient_user = user_result.scalar_one_or_none()

        # Generate invitation token
        invitation_token = secrets.token_urlsafe(32)

        # Create shared access
        shared_access = SharedAccess(
            owner_id=current_user.id,
            shared_with_email=email,
            shared_with_user_id=recipient_user.id if recipient_user else None,
            file_id=file_id,
            permission=share_data.permission,
            invitation_status='accepted' if recipient_user else 'pending',
            invitation_token=invitation_token,
            expires_at=expires_at,
        )

        db.add(shared_access)
        shared_items.append((shared_access, email, invitation_token, recipient_user))

    # Single commit for all shares - atomic operation
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
        db, current_user.id, "file_shared_collaborative", str(file_id),
        {
            "emails": share_data.emails,
            "permission": share_data.permission,
        },
        request,
    )

    # Send email notifications (fire-and-forget)
    from ..services.email_service import email_service
    for email in share_data.emails:
        background_tasks.add_task(
            email_service.send_share_notification,
            to_email=email,
            owner_email=current_user.email,
            item_name=file_obj.file_name,
            item_type="file",
            permission=share_data.permission,
            message=share_data.message,
        )

    return responses


@router.post("/folders/{folder_id}/collaborate", response_model=List[CollaborativeShareResponse])
async def share_folder_with_users(
    folder_id: str,
    share_data: CollaborativeShareCreate,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Share folder with specific users by email - collaborative sharing"""
    # Verify folder exists and belongs to user
    result = await db.execute(
        select(Folder).filter(Folder.id == folder_id, Folder.user_id == current_user.id)
    )
    folder_obj = result.scalar_one_or_none()

    if not folder_obj:
        raise HTTPException(status_code=404, detail="Folder not found")

    # Calculate expiration
    expires_at = None
    if share_data.expires_hours:
        expires_at = datetime.utcnow() + timedelta(hours=share_data.expires_hours)

    shared_items = []
    for email in share_data.emails:
        # Check if user exists
        user_result = await db.execute(select(User).filter(User.email == email))
        recipient_user = user_result.scalar_one_or_none()

        # Generate invitation token
        invitation_token = secrets.token_urlsafe(32)

        # Create shared access
        shared_access = SharedAccess(
            owner_id=current_user.id,
            shared_with_email=email,
            shared_with_user_id=recipient_user.id if recipient_user else None,
            folder_id=folder_id,
            permission=share_data.permission,
            invitation_status='accepted' if recipient_user else 'pending',
            invitation_token=invitation_token,
            expires_at=expires_at,
        )

        db.add(shared_access)
        shared_items.append((shared_access, email, invitation_token, recipient_user))

    # Single commit for all shares - atomic operation
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
        db, current_user.id, "folder_shared_collaborative", str(folder_id),
        {
            "emails": share_data.emails,
            "permission": share_data.permission,
        },
        request,
    )

    # Send email notifications (fire-and-forget)
    from ..services.email_service import email_service
    for email in share_data.emails:
        background_tasks.add_task(
            email_service.send_share_notification,
            to_email=email,
            owner_email=current_user.email,
            item_name=folder_obj.name,
            item_type="folder",
            permission=share_data.permission,
            message=share_data.message,
        )

    return responses


@router.get("/shared-with-me")
async def get_shared_with_me(
    limit: int = Query(50, ge=1, le=200, description="Max items to return"),
    offset: int = Query(0, ge=0, description="Number of items to skip"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get files/folders shared with current user (paginated)"""
    base_filter = [
        or_(
            SharedAccess.shared_with_email == current_user.email,
            SharedAccess.shared_with_user_id == current_user.id
        ),
        SharedAccess.invitation_status == 'accepted'
    ]

    # Get total count
    count_result = await db.execute(
        select(sql_func.count(SharedAccess.id)).filter(*base_filter)
    )
    total = count_result.scalar() or 0

    # Get paginated items (files, folders, and bundles)
    result = await db.execute(
        select(SharedAccess, User, Object, Folder, ShareBundle)
        .outerjoin(User, SharedAccess.owner_id == User.id)
        .outerjoin(Object, SharedAccess.file_id == Object.id)
        .outerjoin(Folder, SharedAccess.folder_id == Folder.id)
        .outerjoin(ShareBundle, SharedAccess.bundle_id == ShareBundle.id)
        .filter(*base_filter)
        .order_by(SharedAccess.created_at.desc())
        .limit(limit)
        .offset(offset)
    )

    shared_items = []
    for shared_access, owner, file_obj, folder_obj, bundle_obj in result.all():
        if bundle_obj:
            item_name = bundle_obj.name
            item_type = "bundle"
        elif file_obj:
            item_name = file_obj.file_name
            item_type = "file"
        elif folder_obj:
            item_name = folder_obj.name
            item_type = "folder"
        else:
            item_name = "Unknown"
            item_type = "file"

        shared_items.append(SharedItemResponse(
            id=str(shared_access.id),
            owner_email=owner.email if owner else "Unknown",
            item_name=item_name,
            item_type=item_type,
            permission=shared_access.permission,
            shared_at=shared_access.created_at,
            file_id=str(file_obj.id) if file_obj else None,
            folder_id=str(folder_obj.id) if folder_obj else None,
            bundle_id=str(bundle_obj.id) if bundle_obj else None,
        ))

    return {"items": shared_items, "total": total, "limit": limit, "offset": offset}


@router.delete("/shared-with-me/{share_access_id}")
async def remove_shared_access(
    share_access_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove a file/folder from 'Shared with me' (removes your access, not the original file)"""
    # Find the shared access record
    result = await db.execute(
        select(SharedAccess).filter(
            SharedAccess.id == share_access_id,
            or_(
                SharedAccess.shared_with_email == current_user.email,
                SharedAccess.shared_with_user_id == current_user.id
            )
        )
    )
    shared_access = result.scalar_one_or_none()

    if not shared_access:
        raise HTTPException(status_code=404, detail="Shared access not found")

    # Delete the shared access record (this removes it from user's "Shared with me")
    await db.delete(shared_access)
    await db.commit()

    logger.info(f"User {current_user.email} removed shared access {share_access_id}")

    return {"success": True, "message": "Removed from Shared with me"}


# ============================================================================
# Invitation Management - Accept/Decline pending invitations
# ============================================================================


@router.get("/invitations/pending", response_model=List[PendingInvitationResponse])
async def get_pending_invitations(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List pending invitations for the current user (matched by email)"""
    result = await db.execute(
        select(SharedAccess, User, Object, Folder)
        .outerjoin(User, SharedAccess.owner_id == User.id)
        .outerjoin(Object, SharedAccess.file_id == Object.id)
        .outerjoin(Folder, SharedAccess.folder_id == Folder.id)
        .filter(
            SharedAccess.shared_with_email == current_user.email,
            SharedAccess.invitation_status == 'pending',
        )
        .order_by(SharedAccess.created_at.desc())
    )

    invitations = []
    for shared_access, owner, file_obj, folder_obj in result.all():
        # Skip expired invitations
        if shared_access.expires_at and shared_access.expires_at < datetime.utcnow():
            continue

        item_name = file_obj.file_name if file_obj else (folder_obj.name if folder_obj else "Unknown")
        item_type = "file" if file_obj else "folder"

        invitations.append(PendingInvitationResponse(
            id=str(shared_access.id),
            owner_email=owner.email if owner else "Unknown",
            item_name=item_name,
            item_type=item_type,
            permission=shared_access.permission,
            invitation_token=shared_access.invitation_token,
            created_at=shared_access.created_at,
            expires_at=shared_access.expires_at,
            file_id=str(file_obj.id) if file_obj else None,
            folder_id=str(folder_obj.id) if folder_obj else None,
        ))

    return invitations


@router.post("/invitations/{invitation_token}/accept")
async def accept_invitation(
    invitation_token: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Accept a pending invitation"""
    result = await db.execute(
        select(SharedAccess).filter(
            SharedAccess.invitation_token == invitation_token,
            SharedAccess.shared_with_email == current_user.email,
            SharedAccess.invitation_status == 'pending',
        )
    )
    shared_access = result.scalar_one_or_none()

    if not shared_access:
        raise HTTPException(status_code=404, detail="Invitation not found or already processed")

    if shared_access.expires_at and shared_access.expires_at < datetime.utcnow():
        raise HTTPException(status_code=410, detail="Invitation has expired")

    shared_access.invitation_status = 'accepted'
    shared_access.shared_with_user_id = current_user.id
    shared_access.accepted_at = datetime.utcnow()
    await db.commit()

    logger.info(f"User {current_user.email} accepted invitation {invitation_token}")

    return {"success": True, "message": "Invitation accepted"}


@router.post("/invitations/{invitation_token}/decline")
async def decline_invitation(
    invitation_token: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Decline a pending invitation"""
    result = await db.execute(
        select(SharedAccess).filter(
            SharedAccess.invitation_token == invitation_token,
            SharedAccess.shared_with_email == current_user.email,
            SharedAccess.invitation_status == 'pending',
        )
    )
    shared_access = result.scalar_one_or_none()

    if not shared_access:
        raise HTTPException(status_code=404, detail="Invitation not found or already processed")

    shared_access.invitation_status = 'declined'
    await db.commit()

    logger.info(f"User {current_user.email} declined invitation {invitation_token}")

    return {"success": True, "message": "Invitation declined"}


@router.get("/share/{share_token}/info")
@share_limiter.limit(RateLimitConfig.SHARE_PASSWORD_CHECK)
async def get_share_info(
    share_token: str,
    request: Request,
    background_tasks: BackgroundTasks,
    password: Optional[str] = None,
    x_share_password: Optional[str] = Header(None, alias="X-Share-Password"),
    db: AsyncSession = Depends(get_db),
):
    """Get information about a shared item (for viewer page)"""
    # Get share link
    result = await db.execute(
        select(ShareLink, Object, Folder)
        .outerjoin(Object, ShareLink.file_id == Object.id)
        .outerjoin(Folder, ShareLink.folder_id == Folder.id)
        .filter(ShareLink.share_token == share_token, ShareLink.is_active == True)
    )
    share_data = result.first()

    if not share_data:
        raise HTTPException(status_code=404, detail="Share link not found")

    share_link, file_obj, folder_obj = share_data

    # Check expiration
    if share_link.expires_at and share_link.expires_at < datetime.utcnow():
        raise HTTPException(status_code=410, detail="Share link has expired")

    # Check IP whitelist
    if not check_ip_whitelist(request, share_link.allowed_ips):
        raise HTTPException(status_code=403, detail="Access denied: your IP is not on the allow list")

    # Verify password (accept from both header and query param, header takes precedence)
    pw = x_share_password or password
    if share_link.password_hash:
        if not pw:
            raise HTTPException(status_code=401, detail="Password required")
        if not await auth_service.async_verify_password(pw, share_link.password_hash):
            raise HTTPException(status_code=401, detail="Invalid password")

    # Increment view count
    share_link.view_count += 1
    share_link.last_accessed = datetime.utcnow()
    await db.commit()

    background_tasks.add_task(log_share_access, request, "view", share_link_id=share_link.id)

    # Return share info
    item_type = "file" if file_obj else "folder"
    item_name = file_obj.file_name if file_obj else (folder_obj.name if folder_obj else "Unknown")

    return {
        "item_type": item_type,
        "item_name": item_name,
        "share_type": share_link.share_type,
        "allow_preview": share_link.allow_preview,
        "file_id": str(file_obj.id) if file_obj else None,
        "folder_id": str(folder_obj.id) if folder_obj else None,
        "file_size": file_obj.file_size if file_obj else None,
        "mime_type": file_obj.mime_type if file_obj else None,
        "watermark_text": share_link.watermark_text,
    }


@router.get("/share/{share_token}/folder/contents")
@share_limiter.limit(RateLimitConfig.SHARE_PASSWORD_CHECK)
async def get_shared_folder_contents(
    share_token: str,
    request: Request,
    background_tasks: BackgroundTasks,
    password: Optional[str] = None,
    x_share_password: Optional[str] = Header(None, alias="X-Share-Password"),
    db: AsyncSession = Depends(get_db),
):
    """Get contents of a shared folder"""
    # Get share link
    result = await db.execute(
        select(ShareLink, Folder)
        .join(Folder, ShareLink.folder_id == Folder.id)
        .filter(ShareLink.share_token == share_token, ShareLink.is_active == True)
    )
    share_data = result.first()

    if not share_data:
        raise HTTPException(status_code=404, detail="Shared folder not found")

    share_link, folder_obj = share_data

    # Check expiration
    if share_link.expires_at and share_link.expires_at < datetime.utcnow():
        raise HTTPException(status_code=410, detail="Share link has expired")

    # Check IP whitelist
    if not check_ip_whitelist(request, share_link.allowed_ips):
        raise HTTPException(status_code=403, detail="Access denied: your IP is not on the allow list")

    # Verify password (accept from both header and query param, header takes precedence)
    pw = x_share_password or password
    if share_link.password_hash:
        if not pw:
            raise HTTPException(status_code=401, detail="Password required")
        if not await auth_service.async_verify_password(pw, share_link.password_hash):
            raise HTTPException(status_code=401, detail="Invalid password")

    background_tasks.add_task(log_share_access, request, "view", share_link_id=share_link.id)

    # Get visible files in folder (exclude deleted and ZK-encrypted)
    files_result = await db.execute(
        select(Object).filter(
            Object.folder_id == folder_obj.id,
            Object.is_deleted == False,
            or_(Object.encryption_mode == None, Object.encryption_mode != 'client_zk')
        )
    )
    files = files_result.scalars().all()

    response = {
        "folder_name": folder_obj.name,
        "folder_path": folder_obj.path,
        "share_type": share_link.share_type,
        "files": [
            {
                "id": str(f.id),
                "name": f.file_name,
                "size": f.file_size,
                "mime_type": f.mime_type,
                "created_at": f.created_at.isoformat(),
            }
            for f in files
        ],
    }

    if len(files) == 0:
        response["notice"] = "All files in this folder use zero-knowledge encryption and cannot be previewed or downloaded from a shared link."

    if share_link.watermark_text:
        response["watermark_text"] = share_link.watermark_text

    return response


@router.get("/share/{share_token}/file/{file_id}/download")
@share_limiter.limit(RateLimitConfig.SHARE_DOWNLOAD)
async def download_shared_folder_file(
    share_token: str,
    file_id: str,
    request: Request,
    background_tasks: BackgroundTasks,
    password: Optional[str] = None,
    x_share_password: Optional[str] = Header(None, alias="X-Share-Password"),
    db: AsyncSession = Depends(get_db),
):
    """Download an individual file from a shared folder (public, no auth required)"""
    from ..services.encryption import encryption_service
    from ..services.download_optimizer import download_optimizer
    import os
    import base64

    # Get share link and folder
    result = await db.execute(
        select(ShareLink, Folder)
        .join(Folder, ShareLink.folder_id == Folder.id)
        .filter(ShareLink.share_token == share_token, ShareLink.is_active == True)
    )
    share_data = result.first()

    if not share_data:
        raise HTTPException(status_code=404, detail="Shared folder not found")

    share_link, folder_obj = share_data

    # Check expiration
    if share_link.expires_at and share_link.expires_at < datetime.utcnow():
        raise HTTPException(status_code=410, detail="Share link has expired")

    # Check IP whitelist
    if not check_ip_whitelist(request, share_link.allowed_ips):
        raise HTTPException(status_code=403, detail="Access denied: your IP is not on the allow list")

    # Verify password (accept from both header and query param, header takes precedence)
    pw = x_share_password or password
    if share_link.password_hash:
        if not pw:
            raise HTTPException(status_code=401, detail="Password required")
        if not await auth_service.async_verify_password(pw, share_link.password_hash):
            raise HTTPException(status_code=401, detail="Invalid password")

    # Enforce download permission
    if share_link.share_type == 'view':
        raise HTTPException(status_code=403, detail="Download not allowed - view only")

    # Enforce download limit
    if share_link.max_downloads and share_link.download_count >= share_link.max_downloads:
        raise HTTPException(status_code=403, detail="Download limit reached")

    # Verify file belongs to the shared folder (direct children only)
    file_result = await db.execute(
        select(Object).filter(
            Object.id == file_id,
            Object.folder_id == folder_obj.id,
            Object.is_deleted == False
        )
    )
    file_obj = file_result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found in shared folder")

    # Block ZK-encrypted files
    if file_obj.encryption_mode == 'client_zk':
        raise HTTPException(status_code=404, detail="This file uses zero-knowledge encryption and cannot be downloaded from a shared folder")

    # Increment download count
    share_link.download_count += 1
    share_link.last_accessed = datetime.utcnow()
    await db.commit()

    background_tasks.add_task(log_share_access, request, "download_file", share_link_id=share_link.id, file_id=file_obj.id)

    # Decrypt file key
    file_key = encryption_service.decrypt_key(file_obj.encryption_key)

    mime_type = file_obj.mime_type or 'application/octet-stream'
    filename = file_obj.file_name.replace('"', '\\"')
    total_size = file_obj.file_size

    headers = {
        "Content-Type": mime_type,
        "Content-Disposition": _content_disposition("attachment", filename),
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


@router.get("/share/{share_token}/download")
@share_limiter.limit(RateLimitConfig.SHARE_DOWNLOAD)
async def download_shared_folder_as_zip(
    share_token: str,
    request: Request,
    background_tasks: BackgroundTasks,
    password: Optional[str] = None,
    x_share_password: Optional[str] = Header(None, alias="X-Share-Password"),
    db: AsyncSession = Depends(get_db),
):
    """Download all files in a shared folder as a ZIP (recursive)"""
    from ..services.encryption import encryption_service
    from ..utils.zip_builder import ZipFileEntry, build_zip_response

    # Get share link + folder
    result = await db.execute(
        select(ShareLink, Folder)
        .join(Folder, ShareLink.folder_id == Folder.id)
        .filter(ShareLink.share_token == share_token, ShareLink.is_active == True)
    )
    share_data = result.first()

    if not share_data:
        raise HTTPException(status_code=404, detail="Shared folder not found")

    share_link, root_folder = share_data

    # Check expiration
    if share_link.expires_at and share_link.expires_at < datetime.utcnow():
        raise HTTPException(status_code=410, detail="Share link has expired")

    # Check IP whitelist
    if not check_ip_whitelist(request, share_link.allowed_ips):
        raise HTTPException(status_code=403, detail="Access denied: your IP is not on the allow list")

    # Verify password
    pw = x_share_password or password
    if share_link.password_hash:
        if not pw:
            raise HTTPException(status_code=401, detail="Password required")
        if not await auth_service.async_verify_password(pw, share_link.password_hash):
            raise HTTPException(status_code=401, detail="Invalid password")

    # Check download permission
    if share_link.share_type == 'view':
        raise HTTPException(status_code=403, detail="Download not allowed — view only")

    # Check max downloads
    if share_link.max_downloads and share_link.download_count >= share_link.max_downloads:
        raise HTTPException(status_code=403, detail="Download limit reached")

    # Recursively collect all folders
    folder_ids = [root_folder.id]
    folder_paths = {str(root_folder.id): ""}

    queue = [(root_folder.id, "")]
    while queue:
        parent_id, parent_path = queue.pop(0)
        subfolder_result = await db.execute(
            select(Folder).filter(Folder.parent_id == parent_id)
        )
        for subfolder in subfolder_result.scalars().all():
            sub_path = f"{parent_path}{subfolder.name}/"
            folder_ids.append(subfolder.id)
            folder_paths[str(subfolder.id)] = sub_path
            queue.append((subfolder.id, sub_path))

    # Get all visible files across all folders (exclude deleted and ZK-encrypted)
    files_result = await db.execute(
        select(Object).filter(
            Object.folder_id.in_(folder_ids),
            Object.is_deleted == False,
            or_(Object.encryption_mode == None, Object.encryption_mode != 'client_zk'),
        )
    )
    files = files_result.scalars().all()

    if not files:
        raise HTTPException(status_code=404, detail="No downloadable files in folder")

    # Build ZIP entries with folder structure
    entries = []
    for file_obj in files:
        folder_path = folder_paths.get(str(file_obj.folder_id), "")
        zip_path = f"{folder_path}{file_obj.file_name}"
        entries.append(ZipFileEntry(file_obj, zip_path))

    # Generate ZIP filename
    safe_name = "".join(c for c in root_folder.name if c.isalnum() or c in (' ', '-', '_')).rstrip()
    zip_filename = f"{safe_name}.zip"

    response = await build_zip_response(entries, encryption_service, zip_filename)

    # Increment download count
    share_link.download_count += 1
    share_link.last_accessed = datetime.utcnow()
    await db.commit()

    background_tasks.add_task(log_share_access, request, "download_zip", share_link_id=share_link.id)

    return response


@router.get("/share/{share_token}/stream")
@limiter.limit(RateLimitConfig.SHARE_STREAM)
async def stream_shared_file(
    share_token: str,
    request: Request,
    background_tasks: BackgroundTasks,
    password: Optional[str] = None,
    x_share_password: Optional[str] = Header(None, alias="X-Share-Password"),
    inline: bool = Query(True, description="Serve as inline content"),
    compatible: bool = Query(False, description="Use compatible streaming for video"),
    db: AsyncSession = Depends(get_db),
):
    """Stream a shared file for preview (video, audio, PDF, images)"""
    from ..services.encryption import encryption_service
    from ..services.download_optimizer import download_optimizer
    from ..config import settings
    import os
    import base64
    import aiofiles

    # Get share link and file
    result = await db.execute(
        select(ShareLink, Object, User)
        .join(Object, ShareLink.file_id == Object.id)
        .join(User, ShareLink.user_id == User.id)
        .filter(ShareLink.share_token == share_token, ShareLink.is_active == True)
    )
    share_data = result.first()

    if not share_data:
        raise HTTPException(status_code=404, detail="Shared file not found")

    share_link, file_obj, owner = share_data

    # Check expiration
    if share_link.expires_at and share_link.expires_at < datetime.utcnow():
        raise HTTPException(status_code=410, detail="Share link has expired")

    # Check IP whitelist
    if not check_ip_whitelist(request, share_link.allowed_ips):
        raise HTTPException(status_code=403, detail="Access denied: your IP is not on the allow list")

    # Verify password (accept from both header and query param, header takes precedence)
    pw = x_share_password or password
    if share_link.password_hash:
        if not pw:
            raise HTTPException(status_code=401, detail="Password required")
        if not await auth_service.async_verify_password(pw, share_link.password_hash):
            raise HTTPException(status_code=401, detail="Invalid password")

    background_tasks.add_task(log_share_access, request, "stream", share_link_id=share_link.id, file_id=file_obj.id)

    # Check if preview is allowed
    if not share_link.allow_preview:
        raise HTTPException(status_code=403, detail="Preview not allowed for this share")

    # Get encryption key - decrypt the file's encryption key
    file_key = encryption_service.decrypt_key(file_obj.encryption_key)

    mime_type = file_obj.mime_type or 'application/octet-stream'
    filename = file_obj.file_name.replace('"', '\\"')
    total_size = file_obj.file_size

    # Browser compatibility fix for video
    display_mime_type = mime_type
    if mime_type == 'video/quicktime' and file_obj.file_name.lower().endswith(('.mov', '.qt')):
        display_mime_type = 'video/mp4'

    # Handle range requests
    range_header = request.headers.get("Range")

    # Parse range header helper
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
        "Content-Type": display_mime_type,
        "Content-Disposition": _content_disposition("inline", filename),
        "Cache-Control": "public, max-age=3600",
    }

    # Video compatible streaming (transcoded H.264 MP4)
    if compatible and mime_type.startswith('video/'):
        from ..services.video_transcoder import video_transcoder, VideoTranscodeError
        try:
            compat_path = await video_transcoder.get_or_create_stream(
                file_obj=file_obj,
                encryption_service=encryption_service
            )
            if compat_path:
                compat_size = os.path.getsize(compat_path)
                compat_range = await parse_range(range_header, compat_size)
                start, end = compat_range if compat_range else (0, compat_size - 1)
                status_code = 206 if compat_range else 200

                headers = {
                    **base_headers,
                    "Content-Type": "video/mp4",
                    "Content-Disposition": _content_disposition("inline", f'{filename.rsplit(".", 1)[0]}.mp4'),
                    "Content-Length": str(end - start + 1),
                    "X-Video-Transcoded": "true",
                }
                if compat_range:
                    headers["Content-Range"] = f"bytes {start}-{end}/{compat_size}"

                async def stream_compat():
                    async with aiofiles.open(compat_path, 'rb') as f:
                        await f.seek(start)
                        remaining = end - start + 1
                        while remaining > 0:
                            chunk = await f.read(min(1024 * 1024, remaining))
                            if not chunk:
                                break
                            remaining -= len(chunk)
                            yield chunk

                return StreamingResponse(stream_compat(), status_code=status_code, headers=headers, media_type="video/mp4")
        except VideoTranscodeError as exc:
            if exc.status_code == 202:
                raise HTTPException(status_code=202, detail={"status": "transcoding", "message": exc.message})
            # Fall back to regular streaming
            logger.warning(f"Video transcode failed, falling back: {exc.message}")

    # Handle different storage types
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
            return StreamingResponse(generator, status_code=206, headers=headers, media_type=display_mime_type)
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
            return StreamingResponse(generator, status_code=200, headers=headers, media_type=display_mime_type)

    # CHUNKED STORAGE (including content-addressed)
    else:
        from .files import stream_chunked_range

        if parsed_range:
            start, end = parsed_range
            headers = {**base_headers, "Content-Range": f"bytes {start}-{end}/{total_size}", "Content-Length": str(end - start + 1)}
            generator = stream_chunked_range(file_obj, start, end, file_key, encryption_service)
            return StreamingResponse(generator, status_code=206, headers=headers, media_type=display_mime_type)
        else:
            headers = {**base_headers, "Content-Length": str(total_size)}
            generator = stream_chunked_range(file_obj, 0, total_size - 1, file_key, encryption_service)
            return StreamingResponse(generator, status_code=200, headers=headers, media_type=display_mime_type)


# ============================================================================
# Share Link Management - List / Detail / Update / Revoke / Rotate
# ============================================================================


def _share_link_to_detail(link: ShareLink, item_name: str, item_type: str) -> ShareLinkDetail:
    """Convert a ShareLink DB row to ShareLinkDetail response."""
    return ShareLinkDetail(
        id=str(link.id),
        share_token=link.share_token,
        share_type=link.share_type or 'view',
        item_name=item_name,
        item_type=item_type,
        file_id=str(link.file_id) if link.file_id else None,
        folder_id=str(link.folder_id) if link.folder_id else None,
        password_protected=link.password_hash is not None,
        expires_at=link.expires_at,
        max_downloads=link.max_downloads,
        download_count=link.download_count or 0,
        view_count=link.view_count or 0,
        is_active=link.is_active if link.is_active is not None else True,
        allow_preview=link.allow_preview if link.allow_preview is not None else True,
        notify_on_access=link.notify_on_access if link.notify_on_access is not None else False,
        allowed_ips=link.allowed_ips,
        watermark_text=link.watermark_text,
        created_at=link.created_at,
        last_accessed=link.last_accessed,
    )


@router.get("/share-links", response_model=ShareLinkListResponse)
async def list_share_links(
    active_only: bool = Query(False, description="Filter to active links only"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List all share links created by the current user"""
    filters = [ShareLink.user_id == current_user.id]
    if active_only:
        filters.append(ShareLink.is_active == True)

    count_result = await db.execute(
        select(sql_func.count(ShareLink.id)).filter(*filters)
    )
    total = count_result.scalar() or 0

    result = await db.execute(
        select(ShareLink, Object, Folder)
        .outerjoin(Object, ShareLink.file_id == Object.id)
        .outerjoin(Folder, ShareLink.folder_id == Folder.id)
        .filter(*filters)
        .order_by(ShareLink.created_at.desc())
        .limit(limit)
        .offset(offset)
    )

    items = []
    for link, file_obj, folder_obj in result.all():
        item_name = file_obj.file_name if file_obj else (folder_obj.name if folder_obj else "Deleted item")
        item_type = "file" if link.file_id else "folder"
        items.append(_share_link_to_detail(link, item_name, item_type))

    return ShareLinkListResponse(items=items, total=total, limit=limit, offset=offset)


@router.get("/share-links/{link_id}", response_model=ShareLinkDetail)
async def get_share_link_detail(
    link_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get details of a specific share link"""
    result = await db.execute(
        select(ShareLink, Object, Folder)
        .outerjoin(Object, ShareLink.file_id == Object.id)
        .outerjoin(Folder, ShareLink.folder_id == Folder.id)
        .filter(ShareLink.id == link_id, ShareLink.user_id == current_user.id)
    )
    row = result.one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Share link not found")

    link, file_obj, folder_obj = row
    item_name = file_obj.file_name if file_obj else (folder_obj.name if folder_obj else "Deleted item")
    item_type = "file" if link.file_id else "folder"
    return _share_link_to_detail(link, item_name, item_type)


@router.put("/share-links/{link_id}", response_model=ShareLinkDetail)
async def update_share_link(
    link_id: str,
    update_data: ShareLinkUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update share link settings (permissions, password, expiry, download limits)"""
    result = await db.execute(
        select(ShareLink, Object, Folder)
        .outerjoin(Object, ShareLink.file_id == Object.id)
        .outerjoin(Folder, ShareLink.folder_id == Folder.id)
        .filter(ShareLink.id == link_id, ShareLink.user_id == current_user.id)
    )
    row = result.one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Share link not found")

    link, file_obj, folder_obj = row

    if update_data.share_type is not None:
        if update_data.share_type not in ('view', 'download', 'edit'):
            raise HTTPException(status_code=400, detail="Invalid share_type. Must be view, download, or edit")
        link.share_type = update_data.share_type

    if update_data.password is not None:
        if update_data.password == '':
            link.password_hash = None
        else:
            link.password_hash = await auth_service.async_get_password_hash(update_data.password)

    if update_data.expires_hours is not None:
        if update_data.expires_hours == 0:
            link.expires_at = None
        else:
            link.expires_at = datetime.utcnow() + timedelta(hours=update_data.expires_hours)

    if update_data.max_downloads is not None:
        link.max_downloads = None if update_data.max_downloads == -1 else update_data.max_downloads

    if update_data.allow_preview is not None:
        link.allow_preview = update_data.allow_preview

    if update_data.is_active is not None:
        link.is_active = update_data.is_active

    if update_data.notify_on_access is not None:
        link.notify_on_access = update_data.notify_on_access

    if update_data.allowed_ips is not None:
        link.allowed_ips = update_data.allowed_ips if update_data.allowed_ips else None
    if update_data.watermark_text is not None:
        link.watermark_text = update_data.watermark_text or None

    await db.commit()
    await db.refresh(link)

    item_name = file_obj.file_name if file_obj else (folder_obj.name if folder_obj else "Deleted item")
    item_type = "file" if link.file_id else "folder"

    logger.info(f"User {current_user.email} updated share link {link_id}")
    return _share_link_to_detail(link, item_name, item_type)


@router.delete("/share-links/{link_id}")
async def revoke_share_link(
    link_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Soft-deactivate a share link (the link stops working but history is preserved)"""
    result = await db.execute(
        select(ShareLink).filter(
            ShareLink.id == link_id,
            ShareLink.user_id == current_user.id,
        )
    )
    link = result.scalar_one_or_none()
    if not link:
        raise HTTPException(status_code=404, detail="Share link not found")

    link.is_active = False
    await db.commit()

    logger.info(f"User {current_user.email} revoked share link {link_id}")
    return {"success": True, "message": "Share link revoked"}


@router.post("/share-links/{link_id}/regenerate", response_model=ShareLinkDetail)
async def regenerate_share_link(
    link_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Generate a new token for an existing share link (old token stops working)"""
    result = await db.execute(
        select(ShareLink, Object, Folder)
        .outerjoin(Object, ShareLink.file_id == Object.id)
        .outerjoin(Folder, ShareLink.folder_id == Folder.id)
        .filter(ShareLink.id == link_id, ShareLink.user_id == current_user.id)
    )
    row = result.one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Share link not found")

    link, file_obj, folder_obj = row

    old_token = link.share_token
    link.share_token = secrets.token_urlsafe(32)
    link.is_active = True  # Re-activate on regeneration
    link.download_count = 0  # Reset counters for new token
    link.view_count = 0
    await db.commit()
    await db.refresh(link)

    item_name = file_obj.file_name if file_obj else (folder_obj.name if folder_obj else "Deleted item")
    item_type = "file" if link.file_id else "folder"

    logger.info(f"User {current_user.email} regenerated share link {link_id} (old token: {old_token[:8]}...)")
    return _share_link_to_detail(link, item_name, item_type)


# ============================================================================
# Share Access Logs - Audit trail for share link access
# ============================================================================


@router.get("/share-links/{link_id}/access-log", response_model=ShareAccessLogResponse)
async def get_share_link_access_log(
    link_id: str,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get access log for a share link (owner only)"""
    # Verify ownership
    link_result = await db.execute(
        select(ShareLink).filter(ShareLink.id == link_id, ShareLink.user_id == current_user.id)
    )
    if not link_result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Share link not found")

    count_result = await db.execute(
        select(sql_func.count(ShareAccessLog.id)).filter(ShareAccessLog.share_link_id == link_id)
    )
    total = count_result.scalar() or 0

    result = await db.execute(
        select(ShareAccessLog)
        .filter(ShareAccessLog.share_link_id == link_id)
        .order_by(ShareAccessLog.accessed_at.desc())
        .limit(limit)
        .offset(offset)
    )

    items = [
        ShareAccessLogEntry(
            id=str(log.id),
            access_type=log.access_type,
            ip_address=log.ip_address,
            user_agent=log.user_agent,
            file_id=str(log.file_id) if log.file_id else None,
            accessed_at=log.accessed_at,
        )
        for log in result.scalars().all()
    ]

    return ShareAccessLogResponse(items=items, total=total, limit=limit, offset=offset)


@router.get("/share-bundles/{bundle_id}/access-log", response_model=ShareAccessLogResponse)
async def get_share_bundle_access_log(
    bundle_id: str,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get access log for a share bundle (owner only)"""
    # Verify ownership
    bundle_result = await db.execute(
        select(ShareBundle).filter(ShareBundle.id == bundle_id, ShareBundle.user_id == current_user.id)
    )
    if not bundle_result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Share bundle not found")

    count_result = await db.execute(
        select(sql_func.count(ShareAccessLog.id)).filter(ShareAccessLog.bundle_id == bundle_id)
    )
    total = count_result.scalar() or 0

    result = await db.execute(
        select(ShareAccessLog)
        .filter(ShareAccessLog.bundle_id == bundle_id)
        .order_by(ShareAccessLog.accessed_at.desc())
        .limit(limit)
        .offset(offset)
    )

    items = [
        ShareAccessLogEntry(
            id=str(log.id),
            access_type=log.access_type,
            ip_address=log.ip_address,
            user_agent=log.user_agent,
            file_id=str(log.file_id) if log.file_id else None,
            accessed_at=log.accessed_at,
        )
        for log in result.scalars().all()
    ]

    return ShareAccessLogResponse(items=items, total=total, limit=limit, offset=offset)


# ============================================================================
# Share Analytics
# ============================================================================

@router.get("/share-analytics/summary", response_model=ShareAnalyticsSummary)
async def get_share_analytics_summary(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get aggregate analytics across all user's shares"""
    user_id = current_user.id

    # Count shares
    total_links = (await db.execute(
        select(sql_func.count(ShareLink.id)).filter(ShareLink.user_id == user_id)
    )).scalar() or 0

    total_bundles = (await db.execute(
        select(sql_func.count(ShareBundle.id)).filter(ShareBundle.user_id == user_id)
    )).scalar() or 0

    active_link_count = (await db.execute(
        select(sql_func.count(ShareLink.id)).filter(
            ShareLink.user_id == user_id, ShareLink.is_active == True
        )
    )).scalar() or 0

    active_bundle_count = (await db.execute(
        select(sql_func.count(ShareBundle.id)).filter(
            ShareBundle.user_id == user_id, ShareBundle.is_active == True
        )
    )).scalar() or 0

    # Total views/downloads from counters
    total_views = (
        ((await db.execute(
            select(sql_func.coalesce(sql_func.sum(ShareLink.view_count), 0))
            .filter(ShareLink.user_id == user_id)
        )).scalar() or 0)
        + ((await db.execute(
            select(sql_func.coalesce(sql_func.sum(ShareBundle.view_count), 0))
            .filter(ShareBundle.user_id == user_id)
        )).scalar() or 0)
    )

    total_downloads = (
        ((await db.execute(
            select(sql_func.coalesce(sql_func.sum(ShareLink.download_count), 0))
            .filter(ShareLink.user_id == user_id)
        )).scalar() or 0)
        + ((await db.execute(
            select(sql_func.coalesce(sql_func.sum(ShareBundle.download_count), 0))
            .filter(ShareBundle.user_id == user_id)
        )).scalar() or 0)
    )

    # Unique IPs from access logs
    total_unique_ips = (await db.execute(
        select(sql_func.count(sql_func.distinct(ShareAccessLog.ip_address))).filter(
            or_(
                ShareAccessLog.share_link_id.in_(
                    select(ShareLink.id).filter(ShareLink.user_id == user_id)
                ),
                ShareAccessLog.bundle_id.in_(
                    select(ShareBundle.id).filter(ShareBundle.user_id == user_id)
                ),
            )
        )
    )).scalar() or 0

    # Most viewed share
    most_viewed_share = None
    mvl_row = (await db.execute(
        select(ShareLink, Object, Folder)
        .outerjoin(Object, ShareLink.file_id == Object.id)
        .outerjoin(Folder, ShareLink.folder_id == Folder.id)
        .filter(ShareLink.user_id == user_id, ShareLink.view_count > 0)
        .order_by(ShareLink.view_count.desc())
        .limit(1)
    )).first()

    mvb = (await db.execute(
        select(ShareBundle)
        .filter(ShareBundle.user_id == user_id, ShareBundle.view_count > 0)
        .order_by(ShareBundle.view_count.desc())
        .limit(1)
    )).scalar_one_or_none()

    if mvl_row:
        link, obj, folder = mvl_row
        name = obj.file_name if obj else (folder.name if folder else "Unknown")
        item_type = "file" if obj else "folder"
        if not mvb or link.view_count >= mvb.view_count:
            most_viewed_share = {"id": str(link.id), "name": name, "type": item_type, "views": link.view_count}

    if mvb and (not most_viewed_share or mvb.view_count > most_viewed_share["views"]):
        most_viewed_share = {"id": str(mvb.id), "name": mvb.name, "type": "bundle", "views": mvb.view_count}

    # Most downloaded share
    most_downloaded_share = None
    mdl_row = (await db.execute(
        select(ShareLink, Object, Folder)
        .outerjoin(Object, ShareLink.file_id == Object.id)
        .outerjoin(Folder, ShareLink.folder_id == Folder.id)
        .filter(ShareLink.user_id == user_id, ShareLink.download_count > 0)
        .order_by(ShareLink.download_count.desc())
        .limit(1)
    )).first()

    mdb = (await db.execute(
        select(ShareBundle)
        .filter(ShareBundle.user_id == user_id, ShareBundle.download_count > 0)
        .order_by(ShareBundle.download_count.desc())
        .limit(1)
    )).scalar_one_or_none()

    if mdl_row:
        link, obj, folder = mdl_row
        name = obj.file_name if obj else (folder.name if folder else "Unknown")
        item_type = "file" if obj else "folder"
        if not mdb or link.download_count >= mdb.download_count:
            most_downloaded_share = {"id": str(link.id), "name": name, "type": item_type, "downloads": link.download_count}

    if mdb and (not most_downloaded_share or mdb.download_count > most_downloaded_share["downloads"]):
        most_downloaded_share = {"id": str(mdb.id), "name": mdb.name, "type": "bundle", "downloads": mdb.download_count}

    return ShareAnalyticsSummary(
        total_shares=total_links + total_bundles,
        active_shares=active_link_count + active_bundle_count,
        total_views=total_views,
        total_downloads=total_downloads,
        total_unique_ips=total_unique_ips,
        most_viewed_share=most_viewed_share,
        most_downloaded_share=most_downloaded_share,
    )


@router.get("/share-analytics/trends", response_model=ShareAnalyticsTrends)
async def get_share_analytics_trends(
    days: int = Query(30, ge=1, le=90),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get daily access trends for the user's shares over the specified period"""
    user_id = current_user.id
    since = datetime.utcnow() - timedelta(days=days)

    user_link_ids = select(ShareLink.id).filter(ShareLink.user_id == user_id)
    user_bundle_ids = select(ShareBundle.id).filter(ShareBundle.user_id == user_id)

    date_col = sql_func.date(ShareAccessLog.accessed_at)

    result = await db.execute(
        select(
            date_col.label("day"),
            ShareAccessLog.access_type,
            sql_func.count().label("cnt"),
        )
        .filter(
            ShareAccessLog.accessed_at >= since,
            or_(
                ShareAccessLog.share_link_id.in_(user_link_ids),
                ShareAccessLog.bundle_id.in_(user_bundle_ids),
            ),
        )
        .group_by(date_col, ShareAccessLog.access_type)
        .order_by(date_col)
    )

    daily_map: dict[str, dict[str, int]] = {}
    download_types = {"download", "download_file", "download_zip"}

    for row in result.all():
        day_str = str(row.day)
        if day_str not in daily_map:
            daily_map[day_str] = {"views": 0, "downloads": 0}
        if row.access_type in download_types:
            daily_map[day_str]["downloads"] += row.cnt
        elif row.access_type == "view":
            daily_map[day_str]["views"] += row.cnt

    daily = []
    for i in range(days):
        day = (since + timedelta(days=i + 1)).strftime("%Y-%m-%d")
        stats = daily_map.get(day, {"views": 0, "downloads": 0})
        daily.append(ShareDailyStats(date=day, views=stats["views"], downloads=stats["downloads"]))

    return ShareAnalyticsTrends(daily=daily, period_days=days)


@router.get("/share-analytics/top", response_model=ShareAnalyticsTopItems)
async def get_share_analytics_top(
    sort_by: str = Query("views", pattern="^(views|downloads)$"),
    limit: int = Query(10, ge=1, le=50),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get top shares by views or downloads"""
    user_id = current_user.id
    order_col = ShareLink.view_count if sort_by == "views" else ShareLink.download_count

    links_result = await db.execute(
        select(ShareLink, Object, Folder)
        .outerjoin(Object, ShareLink.file_id == Object.id)
        .outerjoin(Folder, ShareLink.folder_id == Folder.id)
        .filter(ShareLink.user_id == user_id)
        .order_by(order_col.desc())
        .limit(limit)
    )

    bundle_order = ShareBundle.view_count if sort_by == "views" else ShareBundle.download_count
    bundles_result = await db.execute(
        select(ShareBundle)
        .filter(ShareBundle.user_id == user_id)
        .order_by(bundle_order.desc())
        .limit(limit)
    )

    items: list[ShareItemStats] = []

    for link, obj, folder in links_result.all():
        name = obj.file_name if obj else (folder.name if folder else "Unknown")
        item_type = "file" if obj else "folder"
        ip_count = (await db.execute(
            select(sql_func.count(sql_func.distinct(ShareAccessLog.ip_address)))
            .filter(ShareAccessLog.share_link_id == link.id)
        )).scalar() or 0
        items.append(ShareItemStats(
            id=str(link.id),
            name=name,
            share_type="link",
            item_type=item_type,
            views=link.view_count,
            downloads=link.download_count,
            unique_ips=ip_count,
            is_active=link.is_active,
            created_at=link.created_at,
            last_accessed=link.last_accessed,
        ))

    for bundle in bundles_result.scalars().all():
        ip_count = (await db.execute(
            select(sql_func.count(sql_func.distinct(ShareAccessLog.ip_address)))
            .filter(ShareAccessLog.bundle_id == bundle.id)
        )).scalar() or 0
        items.append(ShareItemStats(
            id=str(bundle.id),
            name=bundle.name,
            share_type="bundle",
            item_type="bundle",
            views=bundle.view_count,
            downloads=bundle.download_count,
            unique_ips=ip_count,
            is_active=bundle.is_active,
            created_at=bundle.created_at,
            last_accessed=bundle.last_accessed,
        ))

    items.sort(key=lambda x: x.views if sort_by == "views" else x.downloads, reverse=True)
    items = items[:limit]

    total_count = (
        ((await db.execute(
            select(sql_func.count(ShareLink.id)).filter(ShareLink.user_id == user_id)
        )).scalar() or 0)
        + ((await db.execute(
            select(sql_func.count(ShareBundle.id)).filter(ShareBundle.user_id == user_id)
        )).scalar() or 0)
    )

    return ShareAnalyticsTopItems(items=items, total=total_count)
