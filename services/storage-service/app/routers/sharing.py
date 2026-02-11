# services/storage-service/app/routers/sharing.py
"""
Advanced sharing endpoints - Google Drive style collaborative sharing
"""

from fastapi import APIRouter, Depends, HTTPException, Request, Query, Body, Header
from fastapi.responses import StreamingResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_, and_
from typing import List, Optional
from datetime import datetime, timedelta
import secrets
import logging

logger = logging.getLogger(__name__)

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

    return responses


@router.get("/shared-with-me")
async def get_shared_with_me(
    limit: int = Query(50, ge=1, le=200, description="Max items to return"),
    offset: int = Query(0, ge=0, description="Number of items to skip"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get files/folders shared with current user (paginated)"""
    from sqlalchemy import func as sql_func

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

    # Get paginated items
    result = await db.execute(
        select(SharedAccess, User, Object, Folder)
        .outerjoin(User, SharedAccess.owner_id == User.id)
        .outerjoin(Object, SharedAccess.file_id == Object.id)
        .outerjoin(Folder, SharedAccess.folder_id == Folder.id)
        .filter(*base_filter)
        .order_by(SharedAccess.created_at.desc())
        .limit(limit)
        .offset(offset)
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


@router.post("/share/{share_token}/info")
async def get_share_info(
    share_token: str,
    password: Optional[str] = Body(None, embed=True),
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


@router.post("/share/{share_token}/folder/contents")
async def get_shared_folder_contents(
    share_token: str,
    password: Optional[str] = Body(None, embed=True),
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


@router.get("/share/{share_token}/stream")
async def stream_shared_file(
    share_token: str,
    request: Request,
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

    # Verify password if required
    if share_link.password_hash:
        if not x_share_password:
            raise HTTPException(status_code=401, detail="Password required")
        if not pwd_context.verify(x_share_password, share_link.password_hash):
            raise HTTPException(status_code=401, detail="Invalid password")

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
        "Content-Disposition": f'inline; filename="{filename}"',
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
                    "Content-Disposition": f'inline; filename="{filename.rsplit(".", 1)[0]}.mp4"',
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
