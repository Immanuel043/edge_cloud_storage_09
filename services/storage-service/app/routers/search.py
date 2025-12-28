"""
Search API Router - Full-Text Search with Elasticsearch + Semantic Search
"""
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from typing import Optional, List
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_, func
from app.services.search_service import search_service
from app.services.embedding_service import embedding_service
from app.models.database import User, Object, FileEmbedding, Folder
from app.dependencies import get_current_user, get_db
from app.database import get_redis
from app.config import settings
from ..utils.rate_limiter_v2 import create_rate_limiter, RateLimitConfig
import logging

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/search", tags=["search"])


def safe_isoformat(dt):
    """Safely convert datetime to ISO format string, handling both datetime objects and strings."""
    if dt is None:
        return None
    if hasattr(dt, 'isoformat'):
        return dt.isoformat()
    return str(dt)


async def database_fallback_search(
    db: AsyncSession,
    user_id: str,
    query: str,
    size: int = 20,
    offset: int = 0
) -> dict:
    """
    Fallback search using database ILIKE when Elasticsearch is unavailable.
    Searches by filename pattern matching.
    """
    search_pattern = f"%{query}%"
    
    # Search files - Object model uses file_name not name
    files_query = select(Object).where(
        Object.user_id == user_id,
        Object.is_deleted == False,
        or_(
            Object.file_name.ilike(search_pattern),
            Object.mime_type.ilike(search_pattern)
        )
    ).order_by(Object.created_at.desc()).limit(size).offset(offset)
    
    files_result = await db.execute(files_query)
    files = files_result.scalars().all()
    
    # Count total files
    count_query = select(func.count()).select_from(Object).where(
        Object.user_id == user_id,
        Object.is_deleted == False,
        or_(
            Object.file_name.ilike(search_pattern),
            Object.mime_type.ilike(search_pattern)
        )
    )
    total_files = await db.scalar(count_query) or 0
    
    # Search folders - Folder model uses name
    folders_query = select(Folder).where(
        Folder.user_id == user_id,
        Folder.name.ilike(search_pattern)
    ).limit(size).offset(offset)
    
    folders_result = await db.execute(folders_query)
    folders = folders_result.scalars().all()
    
    return {
        "files": {
            "total": total_files,
            "hits": [
                {
                    "id": str(f.id),
                    "name": f.file_name,  # Object uses file_name
                    "size": f.file_size,  # Object uses file_size
                    "mime_type": f.mime_type,
                    "created_at": safe_isoformat(f.created_at),
                    "storage_tier": f.storage_tier,
                    "is_encrypted": f.is_encrypted,
                    "score": 1.0,
                    "source": "database"
                }
                for f in files
            ]
        },
        "folders": {
            "total": len(folders),
            "hits": [
                {
                    "id": str(f.id),
                    "name": f.name,
                    "created_at": safe_isoformat(f.created_at),
                    "score": 1.0,
                    "source": "database"
                }
                for f in folders
            ]
        }
    }

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
    - Database fallback when Elasticsearch is unavailable
    """
    try:
        filters_dict = request.filters.dict() if request.filters else {}
        from_ = (request.page - 1) * request.size

        # Try Elasticsearch first
        results = await search_service.search(
            query=request.query,
            user_id=str(current_user.id),
            filters=filters_dict,
            size=request.size,
            from_=from_,
            fuzzy=request.fuzzy
        )

        # If Elasticsearch returned no results or isn't connected, try database fallback
        es_file_count = results.get("files", {}).get("total", 0)
        es_folder_count = results.get("folders", {}).get("total", 0)
        
        if es_file_count == 0 and es_folder_count == 0:
            logger.info(f"Elasticsearch returned no results for '{request.query}', trying database fallback")
            results = await database_fallback_search(
                db=db,
                user_id=str(current_user.id),
                query=request.query,
                size=request.size,
                offset=from_
            )
            results["search_source"] = "database"
        else:
            results["search_source"] = "elasticsearch"

        return {
            "success": True,
            "query": request.query,
            "page": request.page,
            "size": request.size,
            "results": results
        }
    except Exception as e:
        logger.error(f"Search failed: {e}")
        # Try database fallback on any error
        try:
            from_ = (request.page - 1) * request.size
            results = await database_fallback_search(
                db=db,
                user_id=str(current_user.id),
                query=request.query,
                size=request.size,
                offset=from_
            )
            results["search_source"] = "database_fallback"
            return {
                "success": True,
                "query": request.query,
                "page": request.page,
                "size": request.size,
                "results": results
            }
        except Exception as fallback_error:
            logger.error(f"Database fallback also failed: {fallback_error}")
        raise HTTPException(status_code=500, detail="Search failed")

@router.get("/autocomplete", dependencies=[Depends(create_rate_limiter(**RateLimitConfig.SEARCH))])
async def autocomplete_search(
    request: Request,
    q: str = Query(..., min_length=2, description="Search query (min 2 characters)"),
    size: int = Query(5, ge=1, le=10, description="Number of suggestions"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get autocomplete suggestions as user types.
    Falls back to database search if Elasticsearch is unavailable.
    """
    try:
        suggestions = await search_service.autocomplete(
            query=q,
            user_id=str(current_user.id),
            size=size
        )

        # Database fallback if Elasticsearch returns no suggestions
        if not suggestions:
            search_pattern = f"{q}%"
            files_query = select(Object.file_name).where(
                Object.user_id == current_user.id,
                Object.is_deleted == False,
                Object.file_name.ilike(search_pattern)
            ).limit(size)
            result = await db.execute(files_query)
            suggestions = [row[0] for row in result.fetchall()]

        return {
            "success": True,
            "query": q,
            "suggestions": suggestions
        }
    except Exception as e:
        logger.error(f"Autocomplete failed: {e}")
        # Try database fallback on error
        try:
            search_pattern = f"{q}%"
            files_query = select(Object.file_name).where(
                Object.user_id == current_user.id,
                Object.is_deleted == False,
                Object.file_name.ilike(search_pattern)
            ).limit(size)
            result = await db.execute(files_query)
            suggestions = [row[0] for row in result.fetchall()]
            return {
                "success": True,
                "query": q,
                "suggestions": suggestions
            }
        except Exception as fallback_error:
            logger.error(f"Autocomplete database fallback failed: {fallback_error}")
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
            
            # Database fallback if Elasticsearch returns no results
            if total == 0:
                logger.info(f"Elasticsearch returned no results for smart search '{request.query}', trying database")
                db_results = await database_fallback_search(
                    db=db,
                    user_id=str(current_user.id),
                    query=request.query,
                    size=request.size,
                    offset=from_
                )
                results = db_results.get('files', {}).get('hits', [])
                total = db_results.get('files', {}).get('total', 0)

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
            
            # Database fallback if Elasticsearch returns no keyword results
            if not keyword_hits:
                logger.info(f"Elasticsearch returned no keyword results for '{request.query}', using database")
                db_results = await database_fallback_search(
                    db=db,
                    user_id=str(current_user.id),
                    query=request.query,
                    size=request.size,
                    offset=from_
                )
                results = db_results.get('files', {}).get('hits', [])
                total = db_results.get('files', {}).get('total', 0)
            else:
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
                Object.is_deleted == False
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
                    'created_at': safe_isoformat(file_obj.created_at),
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


# ============================================================================
# RE-INDEX ENDPOINT - Rebuild Elasticsearch index for user's files
# ============================================================================

@router.post("/reindex", dependencies=[Depends(create_rate_limiter(**RateLimitConfig.FILE_UPDATE))])
async def reindex_user_files(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Re-index all files for the current user in Elasticsearch.
    
    This is useful when:
    - Files were uploaded but not indexed
    - Elasticsearch was down during uploads
    - Index got corrupted or out of sync
    
    Returns:
    - Number of files indexed
    - Number of failures
    - Status of the operation
    """
    try:
        # Get all user's files
        result = await db.execute(
            select(Object).where(
                Object.user_id == current_user.id,
                Object.is_deleted == False
            )
        )
        files = result.scalars().all()
        
        if not files:
            return {
                "success": True,
                "message": "No files to index",
                "indexed": 0,
                "failed": 0,
                "total": 0
            }
        
        indexed_count = 0
        failed_count = 0
        
        for file_obj in files:
            try:
                file_data = {
                    'id': str(file_obj.id),
                    'user_id': str(file_obj.user_id),
                    'name': file_obj.file_name,
                    'original_name': file_obj.file_name,
                    'size': file_obj.file_size,
                    'mime_type': file_obj.mime_type,
                    'storage_tier': file_obj.storage_tier or 'cache',
                    'folder_id': str(file_obj.folder_id) if file_obj.folder_id else None,
                    'created_at': safe_isoformat(file_obj.created_at),
                    'updated_at': safe_isoformat(file_obj.updated_at),
                    'is_encrypted': file_obj.is_encrypted or False,
                }
                
                success = await search_service.index_file(file_data)
                if success:
                    indexed_count += 1
                else:
                    failed_count += 1
                    
            except Exception as e:
                logger.warning(f"Failed to index file {file_obj.id}: {e}")
                failed_count += 1
        
        logger.info(f"Re-indexed {indexed_count}/{len(files)} files for user {current_user.id}")
        
        return {
            "success": True,
            "message": f"Re-indexed {indexed_count} files",
            "indexed": indexed_count,
            "failed": failed_count,
            "total": len(files)
        }
        
    except Exception as e:
        logger.error(f"Re-index failed: {e}")
        raise HTTPException(status_code=500, detail=f"Re-index failed: {str(e)}")


@router.get("/reindex/status")
async def get_index_status(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get the indexing status for the current user.
    
    Returns:
    - Total files in database
    - Elasticsearch connection status
    - Index health
    """
    try:
        # Count total files in database
        result = await db.execute(
            select(func.count()).select_from(Object).where(
                Object.user_id == current_user.id,
                Object.is_deleted == False
            )
        )
        total_files = result.scalar() or 0
        
        # Check Elasticsearch status
        es_connected = search_service.connected
        es_status = "connected" if es_connected else "disconnected"
        
        # Try to get count from Elasticsearch
        es_count = 0
        if es_connected and search_service.client:
            try:
                es_result = await search_service.client.count(
                    index=search_service.files_index,
                    body={
                        "query": {
                            "term": {"user_id": str(current_user.id)}
                        }
                    }
                )
                es_count = es_result.get('count', 0)
            except Exception as e:
                logger.warning(f"Failed to get ES count: {e}")
        
        sync_status = "synced" if es_count == total_files else "out_of_sync"
        
        return {
            "success": True,
            "elasticsearch_status": es_status,
            "database_files": total_files,
            "indexed_files": es_count,
            "sync_status": sync_status,
            "needs_reindex": es_count < total_files
        }
        
    except Exception as e:
        logger.error(f"Failed to get index status: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get status: {str(e)}")
