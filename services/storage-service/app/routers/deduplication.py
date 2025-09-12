from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, text
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
    """Get deduplication analytics with accurate calculations"""
    
    # Get real statistics based on unique blocks
    result = await db.execute(text("""
        WITH file_stats AS (
            SELECT 
                COUNT(DISTINCT o.id) as file_count,
                SUM(o.file_size) as logical_size
            FROM objects o
            WHERE o.user_id = :user_id
            AND o.storage_type IN ('content_addressed', 'deduplicated_reference')
        ),
        block_stats AS (
            SELECT 
                COUNT(DISTINCT cb.block_hash) as unique_blocks,
                COUNT(*) as total_block_refs,
                AVG(cb.reference_count) as avg_refs
            FROM content_blocks cb
            JOIN objects o ON cb.file_id = o.id
            WHERE o.user_id = :user_id
        )
        SELECT 
            f.file_count,
            f.logical_size,
            b.unique_blocks,
            b.total_block_refs,
            b.avg_refs,
            b.unique_blocks * 16384 as physical_size
        FROM file_stats f, block_stats b
    """), {"user_id": str(current_user.id)})
    
    stats = result.first()
    
    if not stats or not stats.logical_size:
        # Return default values if no deduplicated files
        return {
            "summary": {
                "total_files": 0,
                "logical_size": 0,
                "physical_size": 0,
                "saved_size": 0,
                "dedup_ratio": 0,
                "compression_ratio": 1
            },
            "blocks": {
                "total_blocks": 0,
                "total_size": 0,
                "avg_references": 0
            },
            "top_duplicates": []
        }
    
    saved_size = stats.logical_size - stats.physical_size if stats.logical_size and stats.physical_size else 0
    dedup_ratio = (saved_size / stats.logical_size * 100) if stats.logical_size > 0 else 0
    
    return {
        "summary": {
            "total_files": stats.file_count or 0,
            "logical_size": stats.logical_size or 0,
            "physical_size": stats.physical_size or 0,
            "saved_size": saved_size,
            "dedup_ratio": round(dedup_ratio, 2),
            "compression_ratio": round(stats.logical_size / stats.physical_size, 2) if stats.physical_size > 0 else 1
        },
        "blocks": {
            "total_blocks": stats.total_block_refs or 0,
            "total_size": stats.physical_size or 0,
            "avg_references": float(stats.avg_refs or 0)
        },
        "top_duplicates": []
    }

@router.get("/savings")
async def get_storage_savings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get accurate storage savings from deduplication"""
    
    # Calculate real savings based on unique blocks
    result = await db.execute(text("""
        WITH file_stats AS (
            SELECT 
                COUNT(DISTINCT o.id) as file_count,
                SUM(o.file_size) as logical_size
            FROM objects o
            WHERE o.user_id = :user_id
            AND o.storage_type IN ('content_addressed', 'deduplicated_reference')
        ),
        block_stats AS (
            SELECT 
                COUNT(DISTINCT cb.block_hash) as unique_blocks
            FROM content_blocks cb
            JOIN objects o ON cb.file_id = o.id
            WHERE o.user_id = :user_id
        )
        SELECT 
            f.file_count,
            f.logical_size,
            b.unique_blocks * 16384 as physical_size,
            f.logical_size - (b.unique_blocks * 16384) as saved_size,
            CASE 
                WHEN f.logical_size > 0 
                THEN ROUND(((f.logical_size - (b.unique_blocks * 16384))::numeric / f.logical_size) * 100, 2)
                ELSE 0 
            END as savings_percentage
        FROM file_stats f, block_stats b
    """), {"user_id": str(current_user.id)})
    
    stats = result.first()
    
    if not stats or not stats.logical_size:
        return {
            "logical_size": 0,
            "physical_size": 0,
            "saved_size": 0,
            "savings_percentage": 0,
            "storage_efficiency": 1
        }
    
    return {
        "logical_size": stats.logical_size or 0,
        "physical_size": stats.physical_size or 0,
        "saved_size": stats.saved_size or 0,
        "savings_percentage": float(stats.savings_percentage or 0),
        "storage_efficiency": round(stats.logical_size / stats.physical_size, 2) if stats.physical_size > 0 else 1
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