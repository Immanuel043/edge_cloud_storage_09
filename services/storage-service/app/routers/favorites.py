# services/storage-service/app/routers/favorites.py

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, desc
from typing import List
from datetime import datetime, timedelta

from ..dependencies import get_db, get_current_user
from ..models.database import User, Object, Favorite
from ..models.schemas import FileResponse
from ..utils.rate_limiter_v2 import create_rate_limiter, RateLimitConfig

router = APIRouter(prefix="/api/v1", tags=["favorites"])


@router.get("/files/recents", response_model=List[FileResponse], dependencies=[Depends(create_rate_limiter(**RateLimitConfig.API_READ))])
async def get_recent_files(
    request: Request,
    days: int = 30,
    limit: int = 50,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get recently accessed files for the current user.

    Args:
        days: Number of days to look back (default: 30)
        limit: Maximum number of files to return (default: 50, max: 100)

    Returns:
        List of recently accessed files, ordered by last access time
    """
    # Validate parameters
    if days < 1 or days > 365:
        raise HTTPException(status_code=400, detail="Days must be between 1 and 365")

    if limit < 1 or limit > 100:
        raise HTTPException(status_code=400, detail="Limit must be between 1 and 100")

    # Calculate cutoff date
    cutoff_date = datetime.utcnow() - timedelta(days=days)

    # Query recent files
    result = await db.execute(
        select(Object)
        .filter(
            and_(
                Object.user_id == current_user.id,
                Object.last_accessed >= cutoff_date
            )
        )
        .order_by(desc(Object.last_accessed))
        .limit(limit)
    )

    files = result.scalars().all()

    # Convert to response format
    return [
        FileResponse(
            id=str(file.id),
            name=file.file_name,
            size=file.file_size,
            mime_type=file.mime_type or 'application/octet-stream',
            created_at=file.created_at,
            updated_at=file.updated_at,
            last_accessed=file.last_accessed,
            tier=file.storage_tier,
            path=file.path or '/',
            is_favorite=await _is_favorite(db, current_user.id, file.id)
        )
        for file in files
    ]


@router.get("/files/favorites", response_model=List[FileResponse], dependencies=[Depends(create_rate_limiter(**RateLimitConfig.API_READ))])
async def get_favorites(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get all favorited files for the current user.

    Returns:
        List of favorite files, ordered by when they were favorited (newest first)
    """
    # Query favorites with joined file data
    result = await db.execute(
        select(Object, Favorite.created_at.label('favorited_at'))
        .join(Favorite, Favorite.file_id == Object.id)
        .filter(Favorite.user_id == current_user.id)
        .order_by(desc(Favorite.created_at))
    )

    files_with_favorite_date = result.all()

    # Convert to response format
    return [
        FileResponse(
            id=str(file.id),
            name=file.file_name,
            size=file.file_size,
            mime_type=file.mime_type or 'application/octet-stream',
            created_at=file.created_at,
            updated_at=file.updated_at,
            last_accessed=file.last_accessed,
            tier=file.storage_tier,
            path=file.path or '/',
            is_favorite=True,
            favorited_at=favorited_at
        )
        for file, favorited_at in files_with_favorite_date
    ]


@router.post("/files/{file_id}/favorite", dependencies=[Depends(create_rate_limiter(**RateLimitConfig.API_WRITE))])
async def toggle_favorite(
    file_id: str,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Toggle favorite status for a file.

    Args:
        file_id: ID of the file to favorite/unfavorite

    Returns:
        {"favorited": true/false, "message": "..."}
    """
    # Verify file exists and belongs to user
    result = await db.execute(
        select(Object)
        .filter(
            and_(
                Object.id == file_id,
                Object.user_id == current_user.id
            )
        )
    )
    file = result.scalar_one_or_none()

    if not file:
        raise HTTPException(status_code=404, detail="File not found")

    # Check if already favorited
    result = await db.execute(
        select(Favorite)
        .filter(
            and_(
                Favorite.user_id == current_user.id,
                Favorite.file_id == file_id
            )
        )
    )
    favorite = result.scalar_one_or_none()

    if favorite:
        # Unfavorite - remove from favorites
        await db.delete(favorite)
        await db.commit()
        return {
            "favorited": False,
            "message": "File removed from favorites"
        }
    else:
        # Favorite - add to favorites
        new_favorite = Favorite(
            user_id=current_user.id,
            file_id=file_id
        )
        db.add(new_favorite)
        await db.commit()
        return {
            "favorited": True,
            "message": "File added to favorites"
        }


@router.delete("/files/{file_id}/favorite", dependencies=[Depends(create_rate_limiter(**RateLimitConfig.API_WRITE))])
async def remove_favorite(
    file_id: str,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Remove a file from favorites (explicit delete endpoint).

    Args:
        file_id: ID of the file to unfavorite

    Returns:
        {"message": "File removed from favorites"}
    """
    # Check if favorited
    result = await db.execute(
        select(Favorite)
        .filter(
            and_(
                Favorite.user_id == current_user.id,
                Favorite.file_id == file_id
            )
        )
    )
    favorite = result.scalar_one_or_none()

    if not favorite:
        raise HTTPException(status_code=404, detail="File is not in favorites")

    await db.delete(favorite)
    await db.commit()

    return {"message": "File removed from favorites"}


# Helper function to check if a file is favorited
async def _is_favorite(db: AsyncSession, user_id: str, file_id: str) -> bool:
    """Check if a file is favorited by the user"""
    result = await db.execute(
        select(Favorite)
        .filter(
            and_(
                Favorite.user_id == user_id,
                Favorite.file_id == file_id
            )
        )
    )
    return result.scalar_one_or_none() is not None
