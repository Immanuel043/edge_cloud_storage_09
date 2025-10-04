# services/storage-service/app/routers/sharing.py
"""
Advanced sharing endpoints - Google Drive style collaborative sharing
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_, and_
from typing import List, Optional
from datetime import datetime, timedelta
import secrets

from ..dependencies import get_db, get_current_user, log_activity
from ..services.auth import pwd_context
from ..models.database import User, Object, Folder, ShareLink, SharedAccess
from ..models.schemas import (
    ShareCreate, ShareResponse,
    CollaborativeShareCreate, CollaborativeShareResponse,
    SharedItemResponse
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

    # Generate unique share token
    share_token = secrets.token_urlsafe(32)

    # Calculate expiration
    expires_at = None
    if share_data.expires_hours:
        expires_at = datetime.utcnow() + timedelta(hours=share_data.expires_hours)

    # Hash password if provided
    password_hash = None
    if share_data.password:
        password_hash = pwd_context.hash(share_data.password)

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

    return ShareResponse(
        share_url=share_url,
        token=share_token,
        share_type=share_data.share_type,
        expires_at=expires_at.isoformat() if expires_at else None,
        password_protected=bool(share_data.password),
        max_downloads=share_data.max_downloads,
        downloads_used=0,
        allow_preview=share_data.allow_preview,
    )


@router.post("/files/{file_id}/collaborate", response_model=List[CollaborativeShareResponse])
async def share_file_with_users(
    file_id: str,
    share_data: CollaborativeShareCreate,
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

    responses = []
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
        await db.commit()
        await db.refresh(shared_access)

        # TODO: Send email invitation
        # await send_share_invitation(email, current_user.email, file_obj.file_name, invitation_token, share_data.message)

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

    return responses


@router.post("/folders/{folder_id}/collaborate", response_model=List[CollaborativeShareResponse])
async def share_folder_with_users(
    folder_id: str,
    share_data: CollaborativeShareCreate,
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

    responses = []
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
        await db.commit()
        await db.refresh(shared_access)

        # TODO: Send email invitation

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

    return responses


@router.get("/shared-with-me", response_model=List[SharedItemResponse])
async def get_shared_with_me(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get all files/folders shared with current user"""
    # Get shared items by email or user_id
    result = await db.execute(
        select(SharedAccess, User, Object, Folder)
        .outerjoin(User, SharedAccess.owner_id == User.id)
        .outerjoin(Object, SharedAccess.file_id == Object.id)
        .outerjoin(Folder, SharedAccess.folder_id == Folder.id)
        .filter(
            or_(
                SharedAccess.shared_with_email == current_user.email,
                SharedAccess.shared_with_user_id == current_user.id
            ),
            SharedAccess.invitation_status == 'accepted'
        )
        .order_by(SharedAccess.created_at.desc())
    )

    shared_items = []
    for shared_access, owner, file_obj, folder_obj in result.all():
        item_name = file_obj.file_name if file_obj else (folder_obj.name if folder_obj else "Unknown")
        item_type = "file" if file_obj else "folder"

        shared_items.append(SharedItemResponse(
            id=str(shared_access.id),
            owner_email=owner.email if owner else "Unknown",
            item_name=item_name,
            item_type=item_type,
            permission=shared_access.permission,
            shared_at=shared_access.created_at,
            file_id=str(file_obj.id) if file_obj else None,
            folder_id=str(folder_obj.id) if folder_obj else None,
        ))

    return shared_items


@router.get("/share/{share_token}/info")
async def get_share_info(
    share_token: str,
    password: Optional[str] = None,
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

    # Verify password if required
    if share_link.password_hash:
        if not password:
            raise HTTPException(status_code=401, detail="Password required")
        if not pwd_context.verify(password, share_link.password_hash):
            raise HTTPException(status_code=401, detail="Invalid password")

    # Increment view count
    share_link.view_count += 1
    share_link.last_accessed = datetime.utcnow()
    await db.commit()

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
    }


@router.get("/share/{share_token}/folder/contents")
async def get_shared_folder_contents(
    share_token: str,
    password: Optional[str] = None,
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

    # Verify password
    if share_link.password_hash:
        if not password:
            raise HTTPException(status_code=401, detail="Password required")
        if not pwd_context.verify(password, share_link.password_hash):
            raise HTTPException(status_code=401, detail="Invalid password")

    # Get all files in folder
    files_result = await db.execute(
        select(Object).filter(Object.folder_id == folder_obj.id)
    )
    files = files_result.scalars().all()

    return {
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
