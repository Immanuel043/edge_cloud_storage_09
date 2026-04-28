"""
File Similarity API Router
Endpoints for finding similar files and duplicates
"""

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_current_user, get_db
from ..models.database import FileHash, Object, User
from ..services.similarity_service import similarity_service
from ..services.storage import storage_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/files", tags=["similarity"])


@router.get("/{file_id}/similar")
async def find_similar_files(
    file_id: str,
    threshold: int = Query(10, ge=0, le=64, description="Hamming distance threshold"),
    limit: int = Query(20, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Find files similar to the given file

    Threshold guide:
    - 0-5: Near identical
    - 5-10: Very similar
    - 10-20: Similar
    - >20: Different
    """
    # Verify file ownership and get file
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Only works for images
    if not file_obj.mime_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Similarity search only supported for images")

    # Get hash for this file
    result = await db.execute(select(FileHash).filter(FileHash.file_id == file_id))
    file_hash = result.scalar_one_or_none()

    if not file_hash:
        raise HTTPException(
            status_code=404,
            detail="Perceptual hash not found. Run analysis first (/files/{file_id}/analyze)",
        )

    # Get all hashes for user's images
    result = await db.execute(
        select(Object, FileHash)
        .join(FileHash, Object.id == FileHash.file_id)
        .filter(
            Object.user_id == current_user.id,
            Object.mime_type.like("image/%"),
            Object.id != file_id,  # Exclude the query file itself
        )
    )

    all_hashes = []
    for obj, hash_obj in result.all():
        all_hashes.append(
            {
                "file_id": str(obj.id),
                "filename": obj.file_name,
                "phash": hash_obj.phash,
                "dhash": hash_obj.dhash,
                "whash": hash_obj.whash,
            }
        )

    if not all_hashes:
        return {"file_id": file_id, "similar_files": [], "count": 0}

    # Compare with all hashes
    query_hashes = {"phash": file_hash.phash, "dhash": file_hash.dhash, "whash": file_hash.whash}

    similar_files = similarity_service._find_similar_sync(query_hashes, all_hashes, threshold)

    # Limit results
    similar_files = similar_files[:limit]

    return {
        "file_id": file_id,
        "threshold": threshold,
        "similar_files": similar_files,
        "count": len(similar_files),
    }


@router.post("/duplicates")
async def find_duplicate_files(
    threshold: int = Query(5, ge=0, le=20, description="Hamming distance threshold for duplicates"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Find groups of duplicate/near-duplicate images

    Returns groups of similar images that are likely duplicates
    """
    # Get all image hashes for user
    result = await db.execute(
        select(Object, FileHash)
        .join(FileHash, Object.id == FileHash.file_id)
        .filter(Object.user_id == current_user.id, Object.mime_type.like("image/%"))
    )

    all_hashes = []
    file_info = {}

    for obj, hash_obj in result.all():
        file_id = str(obj.id)
        all_hashes.append(
            {
                "file_id": file_id,
                "phash": hash_obj.phash,
                "dhash": hash_obj.dhash,
                "whash": hash_obj.whash,
            }
        )
        file_info[file_id] = {
            "name": obj.file_name,
            "size": obj.file_size,
            "created_at": obj.created_at.isoformat(),
        }

    if len(all_hashes) < 2:
        return {
            "duplicate_groups": [],
            "total_groups": 0,
            "total_duplicates": 0,
            "potential_savings": 0,
        }

    # Find duplicates
    duplicate_groups = similarity_service._find_duplicates_sync(all_hashes, threshold)

    # Enrich with file info and calculate savings
    enriched_groups = []
    total_duplicates = 0
    potential_savings = 0

    for group in duplicate_groups:
        enriched_group = []
        group_sizes = []

        for item in group:
            file_id = item["file_id"]
            info = file_info.get(file_id, {})
            group_sizes.append(info.get("size", 0))

            enriched_group.append(
                {
                    "file_id": file_id,
                    "name": info.get("name"),
                    "size": info.get("size"),
                    "created_at": info.get("created_at"),
                    "phash": item["phash"],
                }
            )

        enriched_groups.append(enriched_group)
        total_duplicates += len(group) - 1  # All except one

        # Potential savings = sum of all file sizes except the largest
        if group_sizes:
            potential_savings += sum(group_sizes) - max(group_sizes)

    return {
        "duplicate_groups": enriched_groups,
        "total_groups": len(enriched_groups),
        "total_duplicates": total_duplicates,
        "potential_savings_bytes": potential_savings,
        "potential_savings_mb": round(potential_savings / (1024 * 1024), 2),
    }


@router.get("/{file_id}/compare/{other_file_id}")
async def compare_files(
    file_id: str,
    other_file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Compare two files in detail"""
    # Verify both files exist and belong to user
    result = await db.execute(
        select(Object).filter(
            Object.id.in_([file_id, other_file_id]), Object.user_id == current_user.id
        )
    )
    files = result.scalars().all()

    if len(files) != 2:
        raise HTTPException(status_code=404, detail="One or both files not found")

    # Get hashes for both files
    result = await db.execute(
        select(FileHash).filter(FileHash.file_id.in_([file_id, other_file_id]))
    )
    hashes = {h.file_id: h for h in result.scalars().all()}

    hash1 = hashes.get(file_id)
    hash2 = hashes.get(other_file_id)

    if not hash1 or not hash2:
        raise HTTPException(
            status_code=404, detail="Perceptual hashes not found. Run analysis first."
        )

    # Calculate distances
    phash_dist = similarity_service.calculate_hash_distance(hash1.phash, hash2.phash)
    dhash_dist = similarity_service.calculate_hash_distance(hash1.dhash, hash2.dhash)
    whash_dist = similarity_service.calculate_hash_distance(hash1.whash, hash2.whash)
    avg_distance = (phash_dist + dhash_dist + whash_dist) / 3

    # Calculate similarity percentage
    max_distance = 16 * 16  # Hash size squared
    similarity = max(0, 100 - (avg_distance / max_distance * 100))

    return {
        "file1_id": file_id,
        "file2_id": other_file_id,
        "similarity_percentage": round(similarity, 2),
        "average_distance": round(avg_distance, 2),
        "phash_distance": phash_dist,
        "dhash_distance": dhash_dist,
        "whash_distance": whash_dist,
        "verdict": (
            "near_identical"
            if avg_distance <= 5
            else (
                "very_similar"
                if avg_distance <= 10
                else "similar" if avg_distance <= 20 else "different"
            )
        ),
    }


@router.get("/search/ocr")
async def search_in_ocr_text(
    q: str = Query(..., min_length=1, description="Search query"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Search within OCR extracted text across all files"""
    from ..models.database import FileOCR

    # Search in OCR text
    result = await db.execute(
        select(Object, FileOCR)
        .join(FileOCR, Object.id == FileOCR.file_id)
        .filter(Object.user_id == current_user.id, FileOCR.extracted_text.ilike(f"%{q}%"))
        .limit(50)
    )

    matches = []
    for obj, ocr in result.all():
        # Find context around match
        text = ocr.extracted_text
        text_lower = text.lower()
        query_lower = q.lower()

        # Find first occurrence
        idx = text_lower.find(query_lower)
        if idx != -1:
            # Get 100 chars before and after
            start = max(0, idx - 100)
            end = min(len(text), idx + len(q) + 100)
            snippet = text[start:end]
            if start > 0:
                snippet = "..." + snippet
            if end < len(text):
                snippet = snippet + "..."
        else:
            snippet = text[:200]

        matches.append(
            {
                "file_id": str(obj.id),
                "filename": obj.file_name,
                "mime_type": obj.mime_type,
                "snippet": snippet,
                "word_count": ocr.word_count,
                "confidence": ocr.confidence,
                "created_at": obj.created_at,
            }
        )

    return {"query": q, "count": len(matches), "matches": matches}
