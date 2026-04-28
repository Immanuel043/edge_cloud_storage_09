# services/storage-service/app/routers/storage.py

import json
import secrets
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import AsyncSessionLocal, get_redis
from ..dependencies import get_current_user, get_db, get_plan_quota, log_activity
from ..models.database import ActivityLog, Folder, Object, SharedAccess, ShareLink, User
from ..models.schemas import (
    ActivityResponse,
    CollaborativeShareCreate,
    CollaborativeShareResponse,
    ShareCreate,
    SharedItemResponse,
    ShareResponse,
    StorageStats,
    ThemeUpdate,
)
from ..services.auth import auth_service, pwd_context
from ..services.storage import storage_service
from ..utils.access_logger import log_share_access
from ..utils.cache import cached
from ..utils.rate_limiter import RateLimitConfig, check_ip_whitelist, limiter, share_limiter

router = APIRouter(prefix="/api/v1", tags=["storage"])


@router.get("/storage/stats", response_model=StorageStats)
async def get_storage_stats(
    current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Get user storage statistics (live calculation from objects table)"""

    # Calculate total storage used from objects table
    result = await db.execute(
        select(
            func.coalesce(func.sum(Object.file_size), 0).label("total_used"),
            func.count(Object.id).label("total_files"),
        ).filter(Object.user_id == current_user.id)
    )
    stats = result.first()
    total_used = stats.total_used or 0
    total_files = stats.total_files or 0

    # Get distribution by storage tier
    tier_result = await db.execute(
        select(
            Object.storage_tier,
            func.count(Object.id).label("count"),
            func.coalesce(func.sum(Object.file_size), 0).label("size"),
        )
        .filter(Object.user_id == current_user.id)
        .group_by(Object.storage_tier)
    )

    distribution = {}
    for tier, count, size in tier_result:
        distribution[tier] = {"count": count, "size": size}

    # Get storage by type (inline, single, chunked)
    type_result = await db.execute(
        select(
            Object.storage_type,
            func.count(Object.id).label("count"),
            func.coalesce(func.sum(Object.file_size), 0).label("size"),
        )
        .filter(Object.user_id == current_user.id)
        .group_by(Object.storage_type)
    )

    type_distribution = {}
    for storage_type, count, size in type_result:
        type_distribution[storage_type] = {"count": count, "size": size}

    # Resolve quota from subscription plan (self-heals stale users.storage_quota)
    original_quota = current_user.storage_quota
    original_pointer = current_user.current_subscription_id
    quota, _quota_healed = await get_plan_quota(current_user, db)

    # Sync storage_used and persist any self-heal (quota or pointer changes)
    current_storage_used = current_user.storage_used or 0
    used_changed = abs(current_storage_used - total_used) > 1024
    quota_changed = current_user.storage_quota != original_quota
    pointer_changed = current_user.current_subscription_id != original_pointer

    if used_changed or quota_changed or pointer_changed:
        current_user.storage_used = total_used
        await db.commit()

    used = int(total_used) if total_used else 0
    available = max(0, quota - used)

    # Calculate percentage safely (1 decimal — matches subscription_helpers)
    if quota > 0:
        percentage_used = round((used / quota) * 100, 1)
    else:
        percentage_used = 0.0

    return StorageStats(
        quota=quota,
        used=used,
        available=available,
        percentage_used=percentage_used,
        total_files=int(total_files) if total_files else 0,
        distribution=distribution,
        type_distribution=type_distribution,
    )


@router.get("/users/{user_id}/quota")
@cached(expire=60)  # Cache for 1 minute
async def get_user_quota(user_id: str, db: AsyncSession = Depends(get_db)):
    """Get user quota information (cached)"""
    result = await db.execute(select(User).filter(User.id == user_id))
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(404, "User not found")

    # Calculate actual usage (this is expensive, so we cache it)
    usage_result = await db.execute(
        select(func.sum(Object.file_size)).filter(Object.user_id == user_id)
    )
    actual_usage = usage_result.scalar() or 0

    return {
        "user_id": str(user_id),
        "quota": user.storage_quota,
        "used": actual_usage,
        "available": user.storage_quota - actual_usage,
        "percentage": (actual_usage / user.storage_quota * 100) if user.storage_quota > 0 else 0,
    }


@router.post("/storage/optimize")
async def optimize_storage(
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Trigger storage optimization"""
    background_tasks.add_task(optimize_user_storage, current_user.id)
    return {"status": "optimization started"}


@router.post("/files/{file_id}/share", response_model=ShareResponse)
async def create_share_link(
    file_id: str,
    share_data: ShareCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Create shareable link with optional expiration and password"""
    # Verify file exists and belongs to user
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

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
        file_id=file_id,
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
        db,
        current_user.id,
        "share_created",
        str(file_id),
        {
            "expires_hours": share_data.expires_hours,
            "has_password": bool(share_data.password),
            "max_downloads": share_data.max_downloads,
        },
        request,
    )

    # Build frontend share URL (not API URL)
    # In production, this should be the frontend domain
    # For development, use localhost:3000
    from ..config import settings

    if hasattr(settings, "FRONTEND_URL"):
        frontend_url = settings.FRONTEND_URL
    else:
        # Default to development frontend URL
        frontend_url = "http://localhost:3000"

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


@router.get("/share/{share_token}/zk-info")
@share_limiter.limit(RateLimitConfig.SHARE_PASSWORD_CHECK)
async def get_share_zk_info(
    share_token: str,
    request: Request,
    password: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """
    Get share link info for ZK-safe client-side decryption.
    Returns encrypted file metadata - client decrypts with share password.
    Note: Regular share info is at /share/{token}/info (handled by sharing.py)
    """
    # Get share link from database
    result = await db.execute(
        select(ShareLink).filter(ShareLink.share_token == share_token, ShareLink.is_active == True)
    )
    share_link = result.scalar_one_or_none()

    if not share_link:
        raise HTTPException(status_code=404, detail="Share link not found or has been disabled")

    # Check expiration
    if share_link.expires_at and share_link.expires_at < datetime.utcnow():
        raise HTTPException(status_code=410, detail="Share link has expired")

    # Check IP whitelist
    if not check_ip_whitelist(request, share_link.allowed_ips):
        raise HTTPException(
            status_code=403, detail="Access denied: your IP is not on the allow list"
        )

    # Check download limit
    if share_link.max_downloads and share_link.download_count >= share_link.max_downloads:
        raise HTTPException(status_code=403, detail="Download limit exceeded")

    # Get file object
    result = await db.execute(select(Object).filter(Object.id == share_link.file_id))
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Return encrypted metadata for client-side decryption
    # Server NEVER decrypts - client handles everything
    chunk_urls = []
    if file_obj.chunk_info and "chunks" in file_obj.chunk_info:
        for i, chunk_hash in enumerate(file_obj.chunk_info["chunks"]):
            chunk_urls.append(
                {"index": i, "hash": chunk_hash, "url": f"/api/v1/share/{share_token}/chunk/{i}"}
            )
    elif file_obj.content_hash:
        chunk_urls.append(
            {
                "index": 0,
                "hash": file_obj.content_hash,
                "url": f"/api/v1/share/{share_token}/chunk/0",
            }
        )

    return {
        "file_id": str(file_obj.id),
        "encrypted_file_key": file_obj.encrypted_file_key,  # Encrypted with share password
        "file_key_iv": file_obj.file_key_iv,
        "file_size": file_obj.file_size,
        "chunk_count": len(chunk_urls),
        "chunks": chunk_urls,
        "password_required": bool(share_link.password_hash),
        "encryption_algorithm": file_obj.encryption_algorithm or "AES-256-GCM",
    }


@router.get("/share/{share_token}/chunk/{chunk_index}")
@share_limiter.limit(RateLimitConfig.SHARE_ZK_CHUNK)
async def download_share_chunk(
    share_token: str,
    chunk_index: int,
    request: Request,
    password: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """
    Download encrypted chunk for client-side decryption.
    Returns raw encrypted bytes - server NEVER decrypts.
    """
    from fastapi.responses import Response

    # Get share link from database
    result = await db.execute(
        select(ShareLink).filter(ShareLink.share_token == share_token, ShareLink.is_active == True)
    )
    share_link = result.scalar_one_or_none()

    if not share_link:
        raise HTTPException(status_code=404, detail="Share link not found")

    # Check expiration
    if share_link.expires_at and share_link.expires_at < datetime.utcnow():
        raise HTTPException(status_code=410, detail="Share link has expired")

    # Check IP whitelist
    if not check_ip_whitelist(request, share_link.allowed_ips):
        raise HTTPException(
            status_code=403, detail="Access denied: your IP is not on the allow list"
        )

    # Verify password (accept from both header and query param, header takes precedence)
    pw = request.headers.get("X-Share-Password") or password
    if share_link.password_hash:
        if not pw:
            raise HTTPException(status_code=401, detail="Password required")
        if not await auth_service.async_verify_password(pw, share_link.password_hash):
            raise HTTPException(status_code=401, detail="Invalid password")

    # Check download limit
    if share_link.max_downloads and share_link.download_count >= share_link.max_downloads:
        raise HTTPException(status_code=403, detail="Download limit exceeded")

    # Get file object
    result = await db.execute(select(Object).filter(Object.id == share_link.file_id))
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Get the encrypted chunk WITHOUT decrypting
    if file_obj.storage_type == "inline":
        if chunk_index != 0:
            raise HTTPException(status_code=404, detail="Chunk not found")
        # Return encrypted inline data
        encrypted_data = (
            file_obj.storage_key.encode()
            if isinstance(file_obj.storage_key, str)
            else file_obj.storage_key
        )
        return Response(content=encrypted_data, media_type="application/octet-stream")
    elif file_obj.chunk_info and "chunks" in file_obj.chunk_info:
        chunks = file_obj.chunk_info["chunks"]
        if chunk_index >= len(chunks):
            raise HTTPException(status_code=404, detail="Chunk not found")
        chunk_hash = chunks[chunk_index]
        # Get encrypted chunk from storage (no decryption!)
        encrypted_chunk = await storage_service.get_encrypted_chunk(chunk_hash)
        return Response(content=encrypted_chunk, media_type="application/octet-stream")
    else:
        if chunk_index != 0:
            raise HTTPException(status_code=404, detail="Chunk not found")
        encrypted_chunk = await storage_service.get_encrypted_chunk(file_obj.content_hash)
        return Response(content=encrypted_chunk, media_type="application/octet-stream")


@router.get("/share/{share_token}")
@share_limiter.limit(RateLimitConfig.SHARE_DOWNLOAD)
async def download_shared(
    share_token: str,
    request: Request,
    background_tasks: BackgroundTasks,
    password: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """
    Download shared file with validation.
    NOTE: For ZK-encrypted files, use /share/{token}/zk-info and /share/{token}/chunk/{index}
    for proper client-side decryption. This endpoint is for legacy non-ZK files only.
    """
    from fastapi.responses import StreamingResponse

    # Get share link from database
    result = await db.execute(
        select(ShareLink).filter(ShareLink.share_token == share_token, ShareLink.is_active == True)
    )
    share_link = result.scalar_one_or_none()

    if not share_link:
        raise HTTPException(status_code=404, detail="Share link not found or has been disabled")

    # Check expiration
    if share_link.expires_at and share_link.expires_at < datetime.utcnow():
        raise HTTPException(status_code=410, detail="Share link has expired")

    # Check IP whitelist
    if not check_ip_whitelist(request, share_link.allowed_ips):
        raise HTTPException(
            status_code=403, detail="Access denied: your IP is not on the allow list"
        )

    # Verify password (accept from both header and query param, header takes precedence)
    pw = request.headers.get("X-Share-Password") or password
    if share_link.password_hash:
        if not pw:
            raise HTTPException(status_code=401, detail="Password required")
        if not await auth_service.async_verify_password(pw, share_link.password_hash):
            raise HTTPException(status_code=401, detail="Invalid password")

    # Check download limit
    if share_link.max_downloads and share_link.download_count >= share_link.max_downloads:
        raise HTTPException(status_code=403, detail="Download limit exceeded")

    # Get file object
    result = await db.execute(select(Object).filter(Object.id == share_link.file_id))
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Check if this is a ZK-encrypted file - redirect to ZK-safe endpoint
    if file_obj.encryption_mode == "client_zk":
        raise HTTPException(
            status_code=400,
            detail="This file uses zero-knowledge encryption. Use /share/{token}/zk-info for client-side decryption.",
        )

    # Update download count and last accessed
    share_link.download_count += 1
    share_link.last_accessed = datetime.utcnow()
    await db.commit()

    background_tasks.add_task(
        log_share_access, request, "download", share_link_id=share_link.id, file_id=file_obj.id
    )

    # LEGACY: Server-side decryption for non-ZK files only
    from ..services.encryption import encryption_service

    file_key = encryption_service.decrypt_key(file_obj.encryption_key)

    # Content-addressed storage (CAS) — use stream_chunked_range
    chunk_info = file_obj.chunk_info or {}
    if "blocks" in chunk_info and "stored_blocks" in chunk_info:
        from .files import stream_chunked_range

        total_size = file_obj.file_size
        generator = stream_chunked_range(file_obj, 0, total_size - 1, file_key, encryption_service)
        return StreamingResponse(
            generator,
            media_type=file_obj.mime_type or "application/octet-stream",
            headers={
                "Content-Disposition": f'attachment; filename="{file_obj.file_name}"',
                "Content-Length": str(total_size),
            },
        )

    async def stream_chunks():
        if file_obj.storage_type == "inline":
            # Inline data stored directly
            encrypted_data = (
                file_obj.storage_key.encode()
                if isinstance(file_obj.storage_key, str)
                else file_obj.storage_key
            )
            decrypted_data = encryption_service.decrypt_data(encrypted_data, file_key)
            yield decrypted_data
        elif file_obj.chunk_info and "chunks" in file_obj.chunk_info:
            # Chunked storage
            for chunk_hash in file_obj.chunk_info["chunks"]:
                chunk_data = await storage_service.get_chunk(chunk_hash, file_key)
                yield chunk_data
        else:
            # Single file storage
            chunk_data = await storage_service.get_chunk(file_obj.content_hash, file_key)
            yield chunk_data

    return StreamingResponse(
        stream_chunks(),
        media_type=file_obj.mime_type or "application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{file_obj.file_name}"',
            "Content-Length": str(file_obj.file_size),
        },
    )


@router.get("/activity", response_model=List[ActivityResponse])
async def get_activity_logs(
    limit: int = 50,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get user activity logs"""
    from typing import List

    result = await db.execute(
        select(ActivityLog)
        .filter(ActivityLog.user_id == current_user.id)
        .order_by(ActivityLog.created_at.desc())
        .limit(limit)
    )

    activities = result.scalars().all()

    return [
        ActivityResponse(
            id=str(a.id),
            action=a.action,
            object_id=str(a.object_id) if a.object_id else None,
            ip_address=a.ip_address,
            metadata=a.meta_data,
            created_at=a.created_at,
        )
        for a in activities
    ]


@router.get("/users/profile")
async def get_user_profile(
    current_user: User = Depends(get_current_user),
):
    """Get current user profile"""
    # Ensure storage values are never None
    storage_quota = current_user.storage_quota or 107374182400  # Default 100GB
    storage_used = current_user.storage_used or 0

    return {
        "id": str(current_user.id),
        "email": current_user.email,
        "username": current_user.username,
        "plan_type": current_user.plan_type,
        "storage_quota": storage_quota,
        "storage_used": storage_used,
        "theme": current_user.theme_preference,
        "created_at": current_user.created_at.isoformat(),
    }


@router.put("/users/theme")
async def update_theme(
    theme_data: ThemeUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update user theme preference (light/dark)"""
    current_user.theme_preference = theme_data.theme
    await db.commit()
    return {"theme": theme_data.theme}


# ============================================================================
# VIDEO OPTIMIZATION SETTINGS
# ============================================================================


@router.get("/users/settings/video-optimization")
async def get_video_optimization_settings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Get user's video optimization mode (derived from subscription plan).

    Returns:
        mode: 'optimized' | 'keep_both' | 'no_optimization'
        plan_gated: True (mode is determined by plan, not user setting)
    """
    from shared_billing import BillingService

    try:
        billing = BillingService(db, service_type="normal")
        subscription = await billing.get_user_subscription(current_user.id, include_plan=True)
        mode = (subscription.plan.features or {}).get("video_optimization", False)
        if not mode:
            mode = "no_optimization"
    except Exception:
        mode = "no_optimization"

    return {
        "mode": mode,
        "plan_gated": True,
        "description": {
            "optimized": "Videos are automatically optimized for browser playback",
            "keep_both": "Both original and optimized versions accessible",
            "no_optimization": "Video optimization not included in your plan",
        },
    }


# Background task for storage optimization
async def optimize_user_storage(user_id: str):
    """Background task to optimize storage"""
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Object).filter(Object.user_id == user_id))
        files = result.scalars().all()

        for file in files:
            age_days = (datetime.utcnow() - file.last_accessed).days

            if age_days > 30 and file.storage_tier == "cache":
                for chunk_hash in file.chunk_info.get("chunks", []):
                    await storage_service.move_to_tier(chunk_hash, "warm")
                file.storage_tier = "warm"
            elif age_days > 90 and file.storage_tier == "warm":
                for chunk_hash in file.chunk_info.get("chunks", []):
                    await storage_service.move_to_tier(chunk_hash, "cold")
                file.storage_tier = "cold"

        await db.commit()


from typing import List, Optional

from fastapi import HTTPException
