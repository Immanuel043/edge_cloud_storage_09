# services/storage-service/app/routers/deduplication.py
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
from ..services.dedup_queue import smart_dedup_queue

# Get allowed emails from environment variable
ALLOWED_GC_EMAILS = os.getenv("ALLOWED_GC_EMAILS", "").split(",")
ALLOWED_GC_EMAILS = [email.strip() for email in ALLOWED_GC_EMAILS if email.strip()]


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
                AVG(cb.reference_count) as avg_refs,
                SUM(DISTINCT cb.block_size) as physical_size
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
            COALESCE(b.physical_size, 0) as physical_size
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
    
    # Use actual block sizes instead of assuming 16KB
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
                SUM(cb.block_size) as actual_physical_size  -- Use actual block sizes
            FROM content_blocks cb
            JOIN objects o ON cb.file_id = o.id
            WHERE o.user_id = :user_id
        )
        SELECT 
            f.file_count,
            f.logical_size,
            COALESCE(b.actual_physical_size, 0) as physical_size,
            f.logical_size - COALESCE(b.actual_physical_size, 0) as saved_size,
            CASE 
                WHEN f.logical_size > 0 
                THEN ROUND(((f.logical_size - COALESCE(b.actual_physical_size, 0))::numeric / f.logical_size) * 100, 2)
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
    """Run garbage collection (admin only or authorized users)"""
    
    # Get allowed emails from environment variable
    allowed_emails_env = os.getenv("ALLOWED_GC_EMAILS", "")
    allowed_emails = allowed_emails_env.split(",") if allowed_emails_env else []
    allowed_emails = [email.strip() for email in allowed_emails if email.strip()]
    
    # Allow admin users or emails in the allowed list
    if current_user.plan_type != "admin" and current_user.email not in allowed_emails:
        raise HTTPException(403, f"Access denied for {current_user.email}")
    
    # Run cleanup in background
    background_tasks.add_task(
        enhanced_dedup_service.garbage_collect, db
    )
    
    return {"status": "gc_initiated", "authorized_user": current_user.email}


@router.get("/health/dangling-references")
async def check_dangling_references(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Detect deduplicated_reference files whose target no longer exists (admin only)."""
    allowed_emails_env = os.getenv("ALLOWED_GC_EMAILS", "")
    allowed_emails = [e.strip() for e in allowed_emails_env.split(",") if e.strip()]
    if current_user.plan_type != "admin" and current_user.email not in allowed_emails:
        raise HTTPException(403, f"Access denied for {current_user.email}")

    result = await db.execute(text("""
        SELECT o.id, o.file_name, o.file_size, o.dedup_info
        FROM objects o
        WHERE o.storage_type = 'deduplicated_reference'
          AND o.is_deleted = false
          AND NOT EXISTS (
              SELECT 1 FROM objects ref
              WHERE ref.id::text = o.dedup_info->>'reference_file_id'
                AND ref.is_deleted = false
          )
    """))
    rows = result.fetchall()
    return {
        "dangling_count": len(rows),
        "dangling_files": [
            {
                "id": str(r.id),
                "file_name": r.file_name,
                "file_size": r.file_size,
                "reference_file_id": (r.dedup_info or {}).get("reference_file_id"),
            }
            for r in rows
        ]
    }


@router.get("/analytics/detailed")
async def get_detailed_analytics(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Enhanced analytics with classification breakdown

    Returns:
    - Classification statistics (skip/inline/async counts)
    - Skip reason breakdown (compressed, encrypted, etc.)
    - Top duplicate blocks
    - Storage efficiency metrics
    """

    # Get classification breakdown from dedup_info JSON field
    classification_stats = await db.execute(text("""
        SELECT
            COUNT(*) FILTER (WHERE dedup_info->>'classification_mode' = 'skip') as skipped,
            COUNT(*) FILTER (WHERE dedup_info->>'classification_mode' = 'inline') as inline,
            COUNT(*) FILTER (WHERE dedup_info->>'classification_mode' = 'async') as async_mode,
            COUNT(*) FILTER (WHERE dedup_info->>'classification_mode' IS NULL) as unclassified,
            SUM(file_size) FILTER (WHERE dedup_info->>'classification_mode' = 'skip') as skipped_bytes
        FROM objects
        WHERE user_id = :user_id
    """), {"user_id": str(current_user.id)})

    class_stats = classification_stats.first()

    # Get skip reason breakdown
    skip_reasons = await db.execute(text("""
        SELECT
            dedup_info->>'classification_reason' as reason,
            COUNT(*) as count,
            SUM(file_size) as total_bytes
        FROM objects
        WHERE user_id = :user_id
        AND dedup_info->>'classification_mode' = 'skip'
        GROUP BY dedup_info->>'classification_reason'
        ORDER BY count DESC
        LIMIT 10
    """), {"user_id": str(current_user.id)})

    # Get top duplicate blocks
    top_duplicates = await db.execute(text("""
        SELECT
            cb.block_hash,
            cb.block_size,
            cb.reference_count,
            cb.block_size * (cb.reference_count - 1) as bytes_saved
        FROM content_blocks cb
        JOIN objects o ON cb.file_id = o.id
        WHERE o.user_id = :user_id
        AND cb.reference_count > 1
        ORDER BY bytes_saved DESC
        LIMIT 10
    """), {"user_id": str(current_user.id)})

    return {
        "classification": {
            "skipped": class_stats.skipped or 0,
            "inline": class_stats.inline or 0,
            "async": class_stats.async_mode or 0,
            "unclassified": class_stats.unclassified or 0,
            "skipped_bytes": class_stats.skipped_bytes or 0
        },
        "skip_reasons": [
            {
                "reason": row.reason,
                "count": row.count,
                "total_bytes": row.total_bytes
            }
            for row in skip_reasons
        ],
        "top_duplicates": [
            {
                "hash": row.block_hash[:12] + "...",
                "size": row.block_size,
                "references": row.reference_count,
                "bytes_saved": row.bytes_saved
            }
            for row in top_duplicates
        ]
    }


@router.get("/analytics/efficiency")
async def get_efficiency_breakdown(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Efficiency metrics by file type and size band

    Shows which file types benefit most from deduplication
    """

    # Get dedup efficiency by extension
    by_extension = await db.execute(text("""
        WITH file_extensions AS (
            SELECT
                LOWER(substring(file_name from '\\.([^.]+)$')) as ext,
                file_size,
                (dedup_info->>'saved_size')::bigint as saved_size
            FROM objects
            WHERE user_id = :user_id
            AND storage_type IN ('content_addressed', 'deduplicated_reference')
            AND dedup_info->>'saved_size' IS NOT NULL
        )
        SELECT
            ext,
            COUNT(*) as file_count,
            SUM(file_size) as total_logical,
            SUM(saved_size) as total_saved,
            ROUND(AVG(saved_size::numeric / NULLIF(file_size, 0) * 100), 2) as avg_dedup_ratio
        FROM file_extensions
        WHERE ext IS NOT NULL
        GROUP BY ext
        HAVING COUNT(*) >= 2  -- At least 2 files
        ORDER BY total_saved DESC
        LIMIT 15
    """), {"user_id": str(current_user.id)})

    # Get dedup efficiency by size band
    by_size = await db.execute(text("""
        WITH size_bands AS (
            SELECT
                CASE
                    WHEN file_size < 10485760 THEN '0-10MB'
                    WHEN file_size < 104857600 THEN '10-100MB'
                    WHEN file_size < 1073741824 THEN '100MB-1GB'
                    ELSE '1GB+'
                END as size_band,
                file_size,
                (dedup_info->>'saved_size')::bigint as saved_size
            FROM objects
            WHERE user_id = :user_id
            AND storage_type IN ('content_addressed', 'deduplicated_reference')
            AND dedup_info->>'saved_size' IS NOT NULL
        )
        SELECT
            size_band,
            COUNT(*) as file_count,
            SUM(file_size) as total_logical,
            SUM(saved_size) as total_saved,
            ROUND(AVG(saved_size::numeric / NULLIF(file_size, 0) * 100), 2) as avg_dedup_ratio
        FROM size_bands
        GROUP BY size_band
        ORDER BY
            CASE size_band
                WHEN '0-10MB' THEN 1
                WHEN '10-100MB' THEN 2
                WHEN '100MB-1GB' THEN 3
                ELSE 4
            END
    """), {"user_id": str(current_user.id)})

    return {
        "by_extension": [
            {
                "extension": row.ext,
                "file_count": row.file_count,
                "total_logical": row.total_logical,
                "total_saved": row.total_saved,
                "avg_dedup_ratio": float(row.avg_dedup_ratio or 0)
            }
            for row in by_extension
        ],
        "by_size_band": [
            {
                "size_band": row.size_band,
                "file_count": row.file_count,
                "total_logical": row.total_logical,
                "total_saved": row.total_saved,
                "avg_dedup_ratio": float(row.avg_dedup_ratio or 0)
            }
            for row in by_size
        ]
    }


@router.get("/queue/status")
async def get_queue_status(
    current_user: User = Depends(get_current_user)
):
    """
    Get smart queue status

    Returns:
    - Queue size by priority
    - Active jobs count
    - Circuit breaker health
    - User-specific job count
    """

    # Get overall queue status
    queue_status = await smart_dedup_queue.get_status()

    # Get user-specific status
    user_status = smart_dedup_queue.get_user_status(str(current_user.id))

    return {
        "queue": queue_status,
        "user": user_status,
        "recommendations": _get_recommendations(queue_status, user_status)
    }


def _get_recommendations(queue_status: Dict, user_status: Dict) -> list:
    """Generate smart recommendations based on queue status"""
    recommendations = []

    # Check circuit breaker
    if queue_status["circuit_breaker"]["state"] == "OPEN":
        recommendations.append({
            "type": "warning",
            "message": "System overloaded - uploads may be delayed",
            "action": "Wait a few minutes before uploading large files"
        })

    # Check user quota
    if user_status["jobs_in_queue"] >= user_status["max_allowed"] * 0.8:
        recommendations.append({
            "type": "info",
            "message": f"You have {user_status['jobs_in_queue']} files in queue",
            "action": f"Maximum {user_status['max_allowed']} files allowed per user"
        })

    # Check queue congestion
    total_queue = queue_status["queue_size"]
    max_queue = queue_status["capacity"]["max_queue_size"]

    if total_queue >= max_queue * 0.8:
        recommendations.append({
            "type": "warning",
            "message": "Deduplication queue is congested",
            "action": "Consider uploading smaller files or waiting for queue to clear"
        })
    elif total_queue < max_queue * 0.2:
        recommendations.append({
            "type": "success",
            "message": "System running smoothly",
            "action": "Good time to upload large files"
        })

    return recommendations