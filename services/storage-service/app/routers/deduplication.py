from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from sqlalchemy.types import Integer
from typing import Dict, Any, Optional
import os
import aiofiles
import logging

from ..dependencies import get_db, get_current_user
from ..models.database import User, Object
from ..services.deduplication_enhanced import enhanced_dedup_service

router = APIRouter(prefix="/api/v1/dedup", tags=["deduplication"])
logger = logging.getLogger(__name__)

@router.get("/analytics")
async def get_dedup_analytics(
    user_only: bool = True,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get deduplication analytics"""
    
    stats = await enhanced_dedup_service.get_deduplication_analytics(
        db=db,
        user_id=str(current_user.id) if user_only else None
    )
    
    # The enhanced service already returns the correct format
    return stats

@router.get("/savings")
async def get_storage_savings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get storage savings from deduplication"""
    
    stats = await enhanced_dedup_service.get_deduplication_analytics(
        db=db,
        user_id=str(current_user.id)
    )
    
    # Extract summary data
    summary = stats.get('summary', {})
    logical = summary.get('logical_size', 0)
    physical = summary.get('physical_size', 0)
    saved = summary.get('saved_size', 0)
    
    return {
        "logical_size": logical,
        "physical_size": physical,
        "saved_size": saved,
        "savings_percentage": round((saved / logical * 100), 2) if logical > 0 else 0,
        "storage_efficiency": round(logical / physical, 2) if physical > 0 else 1
    }

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
    
    # Check if already deduplicated
    if file_obj.storage_type in ['content_addressed', 'deduplicated_reference']:
        dedup_info = file_obj.dedup_info or {}
        return {
            "status": "already_optimized",
            "current_dedup_ratio": dedup_info.get('dedup_ratio', 0)
        }
    
    # Read file data based on storage type
    if file_obj.storage_type == "single" and file_obj.object_path:
        if not os.path.exists(file_obj.object_path):
            raise HTTPException(404, "File data not found")
        
        async with aiofiles.open(file_obj.object_path, 'rb') as f:
            file_data = await f.read()
        
        # Decrypt if needed
        if file_obj.encryption_key:
            from ..services.encryption import encryption_service
            file_key = encryption_service.decrypt_key(file_obj.encryption_key)
            file_data = encryption_service.decrypt_file(file_data, file_key)
        
        # Perform deduplication
        dedup_result = await enhanced_dedup_service.store_deduplicated_file(
            file_data=file_data,
            file_name=file_obj.file_name,
            user_id=str(current_user.id),
            db=db,
            metadata={'mime_type': file_obj.mime_type},
            encrypt=bool(file_obj.encryption_key)
        )
        
        # Delete old storage if successful
        if dedup_result.get('status') in ['stored_with_dedup', 'full_duplicate']:
            try:
                os.remove(file_obj.object_path)
            except:
                pass
        
        return {
            "status": "optimized",
            "new_file_id": dedup_result.get('file_id'),
            "saved_size": dedup_result.get('saved_size', 0),
            "dedup_ratio": dedup_result.get('dedup_ratio', 0)
        }
    
    return {
        "status": "not_applicable",
        "message": "File type not suitable for optimization"
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
    
    # Run cleanup in background
    background_tasks.add_task(
        enhanced_dedup_service.garbage_collect, db
    )
    
    return {"status": "gc_initiated"}