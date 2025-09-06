# services/storage-service/app/routers/storage.py

from fastapi import APIRouter, Depends, BackgroundTasks, Request,HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from typing import Dict, Any
from datetime import datetime, timedelta
import json
import secrets
from ..dependencies import get_db, get_current_user, log_activity
from ..services.auth import auth_service, pwd_context
from ..models.database import User, Object, ActivityLog
from ..models.schemas import StorageStats, ShareCreate, ShareResponse, ActivityResponse, ThemeUpdate
from ..database import get_redis, AsyncSessionLocal
from ..services.storage import storage_service
from ..config import settings
from ..utils.cache import cached
from typing import Optional, List

router = APIRouter(prefix="/api/v1", tags=["storage"])


@router.get("/storage/stats", response_model=StorageStats)
async def get_storage_stats(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get user storage statistics (live calculation from objects table)"""
    
    # Calculate total storage used from objects table
    result = await db.execute(
        select(
            func.coalesce(func.sum(Object.file_size), 0).label('total_used'),
            func.count(Object.id).label('total_files')
        )
        .filter(Object.user_id == current_user.id)
    )
    stats = result.first()
    total_used = stats.total_used or 0
    total_files = stats.total_files or 0
    
    # Get distribution by storage tier
    tier_result = await db.execute(
        select(
            Object.storage_tier, 
            func.count(Object.id).label('count'), 
            func.coalesce(func.sum(Object.file_size), 0).label('size')
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
            func.count(Object.id).label('count'),
            func.coalesce(func.sum(Object.file_size), 0).label('size')
        )
        .filter(Object.user_id == current_user.id)
        .group_by(Object.storage_type)
    )
    
    type_distribution = {}
    for storage_type, count, size in type_result:
        type_distribution[storage_type] = {"count": count, "size": size}
    
    # Optionally update the user's storage_used field for caching
    if abs(current_user.storage_used - total_used) > 1024:  # Only update if difference > 1KB
        current_user.storage_used = total_used
        await db.commit()
    
    return StorageStats(
        quota=current_user.storage_quota,
        used=total_used,
        available=max(0, current_user.storage_quota - total_used),
        percentage_used=(
            (total_used / current_user.storage_quota * 100)
            if current_user.storage_quota > 0
            else 0
        ),
        total_files=total_files,
        distribution=distribution,
        type_distribution=type_distribution
    )

@router.get("/users/{user_id}/quota")
@cached(expire=60)  # Cache for 1 minute
async def get_user_quota(
    user_id: str,
    db: AsyncSession = Depends(get_db)
):
    """Get user quota information (cached)"""
    result = await db.execute(
        select(User).filter(User.id == user_id)
    )
    user = result.scalar_one_or_none()
    
    if not user:
        raise HTTPException(404, "User not found")
    
    # Calculate actual usage (this is expensive, so we cache it)
    usage_result = await db.execute(
        select(func.sum(Object.file_size))
        .filter(Object.user_id == user_id)
    )
    actual_usage = usage_result.scalar() or 0
    
    return {
        "user_id": str(user_id),
        "quota": user.storage_quota,
        "used": actual_usage,
        "available": user.storage_quota - actual_usage,
        "percentage": (actual_usage / user.storage_quota * 100) if user.storage_quota > 0 else 0
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
    """Create shareable link with permissions"""
    redis_client = await get_redis()
    
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    file_obj = result.scalar_one_or_none()
    
    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")
    
    share_token = secrets.token_urlsafe(32)
    
    share_info = {
        "token": share_token,
        "file_id": str(file_id),
        "user_id": str(current_user.id),
        "password": pwd_context.hash(share_data.password) if share_data.password else None,
        "expires_at": (datetime.utcnow() + timedelta(hours=share_data.expires_hours)).isoformat(),
        "max_downloads": share_data.max_downloads,
        "download_count": 0,
    }
    
    await redis_client.setex(
        f"share:{share_token}",
        share_data.expires_hours * 3600,
        json.dumps(share_info)
    )
    
    await log_activity(
        db, current_user.id, "share_created", str(file_id),
        {"expires_hours": share_data.expires_hours, "has_password": bool(share_data.password)},
        request,
    )
    
    return ShareResponse(
        share_url=f"https://yourdomain.com/share/{share_token}",
        token=share_token,
        expires_at=share_info["expires_at"],
        expires_hours=share_data.expires_hours,
        password=bool(share_data.password),
        max_downloads=share_data.max_downloads,
    )

@router.get("/share/{share_token}")
async def download_shared(
    share_token: str,
    password: Optional[str] = None,
    db: AsyncSession = Depends(get_db)
):
    """Download shared file"""
    from fastapi import HTTPException
    from fastapi.responses import StreamingResponse
    redis_client = await get_redis()
    
    share_data = await redis_client.get(f"share:{share_token}")
    if not share_data:
        raise HTTPException(status_code=404, detail="Share link expired or not found")
    
    share = json.loads(share_data)
    
    if share["password"]:
        if not password or not pwd_context.verify(password, share["password"]):
            raise HTTPException(status_code=401, detail="Invalid password")
    
    if share["max_downloads"] and share["download_count"] >= share["max_downloads"]:
        raise HTTPException(status_code=403, detail="Download limit exceeded")
    
    result = await db.execute(select(Object).filter(Object.id == share["file_id"]))
    file_obj = result.scalar_one_or_none()
    
    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")
    
    share["download_count"] += 1
    await redis_client.set(f"share:{share_token}", json.dumps(share))
    
    from ..services.encryption import encryption_service
    file_key = encryption_service.decrypt_key(file_obj.encryption_key)
    
    async def stream_chunks():
        for chunk_hash in file_obj.chunk_info["chunks"]:
            chunk_data = await storage_service.get_chunk(chunk_hash, file_key)
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
    return {
        "id": str(current_user.id),
        "email": current_user.email,
        "username": current_user.username,
        "user_type": current_user.user_type,
        "storage_quota": current_user.storage_quota,
        "storage_used": current_user.storage_used,
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

from fastapi import HTTPException
from typing import Optional, List