"""
Search API Router - Full-Text Search with Elasticsearch + Semantic Search
"""
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from typing import Optional, List
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.services.search_service import search_service
from app.services.embedding_service import embedding_service
from app.models.database import User, Object, FileEmbedding
from app.dependencies import get_current_user, get_db
from app.database import get_redis
from app.config import settings
from ..utils.rate_limiter_v2 import create_rate_limiter, RateLimitConfig
import logging

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/search", tags=["search"])

class SearchFilters(BaseModel):
    mime_type: Optional[str] = None
    storage_tier: Optional[str] = None
    size_min: Optional[int] = None
    size_max: Optional[int] = None
    date_from: Optional[str] = None
    date_to: Optional[str] = None

class SearchRequest(BaseModel):
    query: str
    filters: Optional[SearchFilters] = None
    size: int = 20
    page: int = 1
    fuzzy: bool = True

@router.post("/", dependencies=[Depends(create_rate_limiter(**RateLimitConfig.SEARCH))])
async def search_files_and_folders(
    http_request: Request,
    request: SearchRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Full-text search across files and folders

    **Features:**
    - Fuzzy search for typo tolerance
    - Filter by file type, size, date, storage tier
    - Highlight matched terms
    - Relevance scoring
    """
    try:
        filters_dict = request.filters.dict() if request.filters else {}
        from_ = (request.page - 1) * request.size

        results = await search_service.search(
            query=request.query,
            user_id=str(current_user.id),
            filters=filters_dict,
            size=request.size,
            from_=from_,
            fuzzy=request.fuzzy
        )

        return {
            "success": True,
            "query": request.query,
            "page": request.page,
            "size": request.size,
            "results": results
        }
    except Exception as e:
        logger.error(f"Search failed: {e}")
        raise HTTPException(status_code=500, detail="Search failed")

@router.get("/autocomplete", dependencies=[Depends(create_rate_limiter(**RateLimitConfig.SEARCH))])
async def autocomplete_search(
    request: Request,
    q: str = Query(..., min_length=2, description="Search query (min 2 characters)"),
    size: int = Query(5, ge=1, le=10, description="Number of suggestions"),
    current_user: User = Depends(get_current_user)
):
    """
    Get autocomplete suggestions as user types
    """
    try:
        suggestions = await search_service.autocomplete(
            query=q,
            user_id=str(current_user.id),
            size=size
        )

        return {
            "success": True,
            "query": q,
            "suggestions": suggestions
        }
    except Exception as e:
        logger.error(f"Autocomplete failed: {e}")
        raise HTTPException(status_code=500, detail="Autocomplete failed")

@router.get("/filters/options")
async def get_filter_options(
    current_user: User = Depends(get_current_user)
):
    """
    Get available filter options for the search UI
    """
    return {
        "success": True,
        "filters": {
            "storage_tiers": ["cache", "warm", "cold"],
            "file_types": [
                {"value": "image/jpeg", "label": "JPEG Images"},
                {"value": "image/png", "label": "PNG Images"},
                {"value": "application/pdf", "label": "PDF Documents"},
                {"value": "video/mp4", "label": "MP4 Videos"},
                {"value": "video/quicktime", "label": "MOV Videos"},
                {"value": "application/zip", "label": "ZIP Archives"},
                {"value": "text/plain", "label": "Text Files"}
            ],
            "size_ranges": [
                {"label": "< 1 MB", "max": 1048576},
                {"label": "1 MB - 10 MB", "min": 1048576, "max": 10485760},
                {"label": "10 MB - 100 MB", "min": 10485760, "max": 104857600},
                {"label": "100 MB - 1 GB", "min": 104857600, "max": 1073741824},
                {"label": "> 1 GB", "min": 1073741824}
            ]
        }
    }


# ============================================================================
# SMART SEARCH - AI-Powered Semantic Search
# ============================================================================

class SmartSearchRequest(BaseModel):
    """Request model for smart search"""
    query: str
    filters: Optional[SearchFilters] = None
    size: int = 20
    page: int = 1
    mode: str = "hybrid"  # "semantic", "keyword", "hybrid"


class SmartSearchResponse(BaseModel):
    """Response model for smart search"""
    success: bool
    query: str
    mode: str
    page: int
    size: int
    total: int
    results: List[dict]
    semantic_enabled: bool


@router.post("/smart", dependencies=[Depends(create_rate_limiter(**RateLimitConfig.SEARCH))])
async def smart_search(
    http_request: Request,
    request: SmartSearchRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    AI-Powered Smart Search with Semantic Understanding

    **Features:**
    - Semantic search: Find files by meaning (e.g., "vacation photos from beach")
    - Keyword search: Traditional full-text search with Elasticsearch
    - Hybrid mode: Combines both for best results (default)

    **Modes:**
    - `semantic`: Pure semantic similarity search
    - `keyword`: Traditional keyword search (same as /search)
    - `hybrid`: Combines keyword and semantic results with weighted scoring

    **Example queries:**
    - "photos from summer vacation" (finds beach, sunset, travel images)
    - "important documents for meeting" (finds relevant PDFs, presentations)
    - "that video from last week" (uses temporal and content context)
    """
    try:
        # Initialize Redis for embedding service if not set
        redis = await get_redis()
        embedding_service.set_redis(redis)

        # Check if semantic search is enabled
        semantic_enabled = settings.SEMANTIC_SEARCH_ENABLED

        # Get pagination offset
        from_ = (request.page - 1) * request.size
        filters_dict = request.filters.dict() if request.filters else {}

        results = []
        total = 0

        if request.mode == "semantic" and semantic_enabled:
            # Pure semantic search
            semantic_results = await embedding_service.semantic_search(
                db=db,
                query=request.query,
                user_id=current_user.id,
                top_k=request.size + from_,  # Get enough for pagination
                min_score=settings.SEMANTIC_MIN_SCORE
            )

            # Paginate results
            paginated = semantic_results[from_:from_ + request.size]

            # Enrich with file metadata
            results = await _enrich_results_with_metadata(db, paginated, current_user.id)
            total = len(semantic_results)

        elif request.mode == "keyword" or not semantic_enabled:
            # Pure keyword search (fallback to Elasticsearch)
            es_results = await search_service.search(
                query=request.query,
                user_id=str(current_user.id),
                filters=filters_dict,
                size=request.size,
                from_=from_,
                fuzzy=True
            )

            results = es_results.get('files', {}).get('hits', [])
            total = es_results.get('files', {}).get('total', 0)

        else:
            # Hybrid search (default)
            # Step 1: Get keyword results from Elasticsearch
            es_results = await search_service.search(
                query=request.query,
                user_id=str(current_user.id),
                filters=filters_dict,
                size=settings.SEMANTIC_SEARCH_TOP_K,  # Get more for hybrid
                from_=0,
                fuzzy=True
            )

            keyword_hits = es_results.get('files', {}).get('hits', [])

            # Step 2: Combine with semantic search
            hybrid_results = await embedding_service.hybrid_search(
                db=db,
                keyword_results=keyword_hits,
                query=request.query,
                user_id=current_user.id,
                top_k=settings.SEMANTIC_SEARCH_TOP_K
            )

            # Paginate hybrid results
            paginated = hybrid_results[from_:from_ + request.size]

            # Enrich with metadata if needed
            results = await _enrich_results_with_metadata(db, paginated, current_user.id)
            total = len(hybrid_results)

        return {
            "success": True,
            "query": request.query,
            "mode": request.mode if semantic_enabled else "keyword",
            "page": request.page,
            "size": request.size,
            "total": total,
            "results": results,
            "semantic_enabled": semantic_enabled
        }

    except Exception as e:
        logger.error(f"Smart search failed: {e}")
        raise HTTPException(status_code=500, detail=f"Smart search failed: {str(e)}")


@router.get("/smart/status")
async def smart_search_status(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get status of semantic search for current user

    Returns:
    - Whether semantic search is enabled
    - Number of files with embeddings
    - Total files
    - Coverage percentage
    """
    try:
        # Count total files
        total_result = await db.execute(
            select(Object).filter(
                Object.user_id == current_user.id,
                Object.is_folder == False,
                Object.deleted_at == None
            )
        )
        total_files = len(total_result.scalars().all())

        # Count files with embeddings
        embedding_result = await db.execute(
            select(FileEmbedding).filter(
                FileEmbedding.user_id == current_user.id,
                FileEmbedding.status == 'completed'
            )
        )
        embedded_files = len(embedding_result.scalars().all())

        coverage = (embedded_files / total_files * 100) if total_files > 0 else 0

        return {
            "success": True,
            "semantic_enabled": settings.SEMANTIC_SEARCH_ENABLED,
            "model_name": settings.SEMANTIC_MODEL_NAME,
            "total_files": total_files,
            "embedded_files": embedded_files,
            "coverage_percent": round(coverage, 1),
            "weights": {
                "keyword": settings.HYBRID_KEYWORD_WEIGHT,
                "semantic": settings.HYBRID_SEMANTIC_WEIGHT
            }
        }
    except Exception as e:
        logger.error(f"Failed to get smart search status: {e}")
        raise HTTPException(status_code=500, detail="Failed to get status")


async def _enrich_results_with_metadata(
    db: AsyncSession,
    results: List[dict],
    user_id
) -> List[dict]:
    """
    Enrich search results with full file metadata from database
    """
    from uuid import UUID

    enriched = []
    for r in results:
        file_id = r.get('id') or r.get('file_id')
        if not file_id:
            enriched.append(r)
            continue

        try:
            # Convert to UUID if string
            if isinstance(file_id, str):
                file_id = UUID(file_id)

            # Fetch file metadata
            result = await db.execute(
                select(Object).filter(
                    Object.id == file_id,
                    Object.user_id == user_id
                )
            )
            file_obj = result.scalar_one_or_none()

            if file_obj:
                enriched_result = {
                    'id': str(file_obj.id),
                    'name': file_obj.file_name,
                    'mime_type': file_obj.mime_type,
                    'size': file_obj.file_size,
                    'created_at': file_obj.created_at.isoformat() if file_obj.created_at else None,
                    'folder_id': str(file_obj.folder_id) if file_obj.folder_id else None,
                    **{k: v for k, v in r.items() if k not in ['file_id', 'id']}
                }
                enriched.append(enriched_result)
            else:
                enriched.append(r)
        except Exception as e:
            logger.warning(f"Failed to enrich result {file_id}: {e}")
            enriched.append(r)

    return enriched
