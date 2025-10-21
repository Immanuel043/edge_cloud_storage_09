"""
Search API Router - Full-Text Search with Elasticsearch
"""
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from typing import Optional, List
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from app.services.search_service import search_service
from app.models.database import User
from app.dependencies import get_current_user, get_db
from app.utils.rate_limiter import user_limiter, RateLimitConfig
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

@router.post("/")
@user_limiter.limit(RateLimitConfig.SEARCH)
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

@router.get("/autocomplete")
@user_limiter.limit(RateLimitConfig.SEARCH)
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
