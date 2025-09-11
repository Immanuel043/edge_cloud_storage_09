from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Dict, Any, Optional
from datetime import datetime, timedelta

from ..dependencies import get_db, get_current_user
from ..models.database import User, Object
from ..services.deduplication_enhanced import enhanced_dedup_service

router = APIRouter(prefix="/api/v1/dedup", tags=["deduplication"])

@router.get("/analytics")
async def get_dedup_analytics(
    user_only: bool = True,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get deduplication analytics"""
    
    # Check if user is admin for system-wide stats
    if not user_only and current_user.user_type != "admin":
        raise HTTPException(403, "Admin access required for system analytics")
    
    analytics = await enhanced_dedup_service.get_deduplication_analytics(
        db=db,
        user_id=str(current_user.id) if user_only else None
    )
    
    return analytics

@router.post("/optimize/{file_id}")
async def optimize_file_dedup(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Optimize a specific file for deduplication"""
    
    # Get file
    result = await db.execute(
        select(Object).where(
            Object.id == file_id,
            Object.user_id == current_user.id
        )
    )
    file_obj = result.scalar_one_or_none()
    
    if not file_obj:
        raise HTTPException(404, "File not found")
    
    if file_obj.storage_type in ['content_addressed', 'deduplicated_reference']:
        return {
            "status": "already_optimized",
            "current_dedup_ratio": file_obj.dedup_info.get('dedup_ratio', 0)
        }
    
    # Read file data
    if file_obj.storage_type == "single":
        async with aiofiles.open(file_obj.object_path, 'rb') as f:
            file_data = await f.read()
        
        # Decrypt if needed
        if file_obj.encryption_key:
            from ..services.encryption import encryption_service
            file_key = encryption_service.decrypt_key(file_obj.encryption_key)
            file_data = encryption_service.decrypt_file(file_data, file_key)
    else:
        # For chunked files, reassemble first
        # ... implement reassembly logic ...
        pass
    
    # Perform deduplication
    dedup_result = await enhanced_dedup_service.store_deduplicated_file(
        file_data=file_data,
        file_name=file_obj.file_name,
        user_id=str(current_user.id),
        db=db,
        metadata={'mime_type': file_obj.mime_type},
        encrypt=bool(file_obj.encryption_key)
    )
    
    # Delete old storage
    if file_obj.storage_type == "single" and os.path.exists(file_obj.object_path):
        os.remove(file_obj.object_path)
    
    return {
        "status": "optimized",
        "new_file_id": dedup_result['file_id'],
        "saved_size": dedup_result['saved_size'],
        "dedup_ratio": dedup_result['dedup_ratio']
    }

@router.post("/gc")
async def run_garbage_collection(
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Run garbage collection (admin only)"""
    
    if current_user.user_type != "admin":
        raise HTTPException(403, "Admin access required")
    
    # Run GC in background
    background_tasks.add_task(
        enhanced_dedup_service.garbage_collect, db
    )
    
    return {"status": "gc_initiated"}

@router.get("/savings")
async def get_storage_savings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get storage savings from deduplication"""
    
    # Calculate savings
    result = await db.execute(
        select(
            func.sum(Object.file_size).label('logical_size'),
            func.sum(
                Object.file_size - 
                func.coalesce(
                    func.cast(Object.dedup_info['saved_size'], Integer), 
                    0
                )
            ).label('physical_size')
        ).where(
            Object.user_id == current_user.id,
            Object.storage_type.in_(['content_addressed', 'deduplicated_reference'])
        )
    )
    
    stats = result.first()
    logical = stats.logical_size or 0
    physical = stats.physical_size or 0
    saved = logical - physical
    
    return {
        "logical_size": logical,
        "physical_size": physical,
        "saved_size": saved,
        "savings_percentage": round((saved / logical * 100), 2) if logical > 0 else 0,
        "storage_efficiency": round(logical / physical, 2) if physical > 0 else 1
    }