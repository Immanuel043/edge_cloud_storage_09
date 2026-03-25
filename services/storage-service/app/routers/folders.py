# services/storage-service/app/routers/folders.py

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import List, Optional
import os
from ..dependencies import get_db, get_current_user, log_activity
from ..services.auth import auth_service
from ..models.database import User, Folder
from ..models.schemas import FolderCreate, FolderResponse
from ..services.search_service import search_service
import asyncio
import logging

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/folders", tags=["folders"])

@router.post("/", response_model=FolderResponse)
async def create_folder(
    folder_data: FolderCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Create a new folder"""
    parent_path = "/"
    if folder_data.parent_id:
        result = await db.execute(
            select(Folder).filter(
                Folder.id == folder_data.parent_id, 
                Folder.user_id == current_user.id
            )
        )
        parent = result.scalar_one_or_none()
        if not parent:
            raise HTTPException(status_code=404, detail="Parent folder not found")
        parent_path = parent.path
    
    # Construct folder path
    folder_path = os.path.join(parent_path, folder_data.name) if parent_path != "/" else f"/{folder_data.name}"
    
    folder = Folder(
        user_id=current_user.id,
        parent_id=folder_data.parent_id,
        name=folder_data.name,
        path=folder_path,
    )
    db.add(folder)
    await db.commit()

    await log_activity(
        db, current_user.id, "folder_created", str(folder.id),
        {"name": folder_data.name}, request
    )

    # Index folder in Elasticsearch (fire and forget)
    asyncio.create_task(
        search_service.index_folder({
            'id': folder.id,
            'name': folder.name,
            'parent_id': folder.parent_id,
            'user_id': current_user.id,
            'path': folder.path,
            'created_at': folder.created_at,
            'updated_at': folder.created_at
        })
    )

    return FolderResponse(
        id=str(folder.id),
        name=folder.name,
        path=folder.path,
        parent_id=str(folder.parent_id) if folder.parent_id else None,
        created_at=folder.created_at,
    )

@router.get("", response_model=List[FolderResponse])
async def list_folders(
    parent_id: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List user's folders"""
    query = select(Folder).filter(Folder.user_id == current_user.id)
    if parent_id:
        query = query.filter(Folder.parent_id == parent_id)
    else:
        query = query.filter(Folder.parent_id == None)
    
    result = await db.execute(query)
    folders = result.scalars().all()
    
    return [
        FolderResponse(
            id=str(f.id),
            name=f.name,
            path=f.path,
            parent_id=str(f.parent_id) if f.parent_id else None,
            created_at=f.created_at,
        )
        for f in folders
    ]

@router.get("/{folder_id}", response_model=FolderResponse)
async def get_folder(
    folder_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get a specific folder"""
    result = await db.execute(
        select(Folder).filter(
            Folder.id == folder_id,
            Folder.user_id == current_user.id
        )
    )
    folder = result.scalar_one_or_none()
    
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    
    return FolderResponse(
        id=str(folder.id),
        name=folder.name,
        path=folder.path,
        parent_id=str(folder.parent_id) if folder.parent_id else None,
        created_at=folder.created_at,
    )

@router.put("/{folder_id}")
async def update_folder(
    folder_id: str,
    folder_data: FolderCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Update folder name or move to different parent"""
    result = await db.execute(
        select(Folder).filter(
            Folder.id == folder_id,
            Folder.user_id == current_user.id
        )
    )
    folder = result.scalar_one_or_none()
    
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    
    # Update name if changed
    if folder_data.name != folder.name:
        folder.name = folder_data.name
    
    # Update parent if changed
    if folder_data.parent_id != folder.parent_id:
        if folder_data.parent_id:
            # Verify new parent exists and belongs to user
            parent_result = await db.execute(
                select(Folder).filter(
                    Folder.id == folder_data.parent_id,
                    Folder.user_id == current_user.id
                )
            )
            parent = parent_result.scalar_one_or_none()
            if not parent:
                raise HTTPException(status_code=404, detail="Parent folder not found")
            
            # Check for circular reference
            if str(parent.id) == folder_id:
                raise HTTPException(status_code=400, detail="Cannot move folder into itself")
            
            # Update path
            folder.parent_id = folder_data.parent_id
            folder.path = os.path.join(parent.path, folder.name)
        else:
            # Moving to root
            folder.parent_id = None
            folder.path = f"/{folder.name}"
    
    await db.commit()

    # Re-index folder in Elasticsearch
    if search_service.connected:
        try:
            await search_service.index_folder({
                'id': str(folder.id),
                'name': folder.name,
                'parent_id': str(folder.parent_id) if folder.parent_id else None,
                'user_id': str(current_user.id),
                'path': folder.path,
                'created_at': folder.created_at,
                'updated_at': folder.created_at,
            })
        except Exception as e:
            logger.warning(f"Failed to update folder in search index: {e}")

    await log_activity(
        db, current_user.id, "folder_updated", str(folder_id),
        {"name": folder.name}, request
    )

    return {
        "id": str(folder.id),
        "name": folder.name,
        "path": folder.path,
        "parent_id": str(folder.parent_id) if folder.parent_id else None,
        "updated": True
    }

@router.delete("/{folder_id}")
async def delete_folder(
    folder_id: str,
    force: bool = False,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Delete a folder (must be empty unless force=True)"""
    result = await db.execute(
        select(Folder).filter(
            Folder.id == folder_id,
            Folder.user_id == current_user.id
        )
    )
    folder = result.scalar_one_or_none()
    
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    
    # Don't allow deletion of root folder
    if folder.name == "/" and folder.parent_id is None:
        raise HTTPException(status_code=400, detail="Cannot delete root folder")
    
    # Initialize for non-force path
    deleted_file_ids: list[str] = []
    deleted_folder_ids: list[str] = []

    if not force:
        # Check if folder has subfolders
        subfolders = await db.execute(
            select(Folder).filter(Folder.parent_id == folder_id)
        )
        if subfolders.scalar_one_or_none():
            raise HTTPException(
                status_code=400,
                detail="Folder contains subfolders. Use force=true to delete recursively"
            )

        # Check if folder has files
        from ..models.database import Object
        files = await db.execute(
            select(Object).filter(Object.folder_id == folder_id)
        )
        if files.scalar_one_or_none():
            raise HTTPException(
                status_code=400,
                detail="Folder contains files. Use force=true to delete all contents"
            )
    else:
        # Force delete - recursively delete all contents
        deleted_file_ids, deleted_folder_ids = await delete_folder_contents_recursive(db, folder_id, current_user.id)

    await db.delete(folder)
    await db.commit()

    # Remove folder + contents from Elasticsearch index (after successful commit)
    if search_service.connected:
        try:
            await search_service.delete_folder(str(folder_id))
        except Exception as e:
            logger.warning(f"Failed to remove folder {folder_id} from search index: {e}")
        if force:
            for fid in deleted_file_ids:
                try:
                    await search_service.delete_file(fid)
                except Exception as e:
                    logger.warning(f"Failed to remove file {fid} from search index: {e}")
            for fold_id in deleted_folder_ids:
                try:
                    await search_service.delete_folder(fold_id)
                except Exception as e:
                    logger.warning(f"Failed to remove folder {fold_id} from search index: {e}")

    await log_activity(
        db, current_user.id, "folder_deleted", str(folder_id),
        {"name": folder.name, "forced": force}, request
    )

    return {"status": "success", "message": "Folder deleted"}

async def delete_folder_contents_recursive(
    db: AsyncSession, folder_id: str, user_id: str
) -> tuple[list[str], list[str]]:
    """Recursively delete folder contents. Returns (file_ids, folder_ids) deleted."""
    from ..models.database import Object

    deleted_file_ids: list[str] = []
    deleted_folder_ids: list[str] = []

    # Delete all files in this folder
    files_result = await db.execute(
        select(Object).filter(Object.folder_id == folder_id)
    )
    files = files_result.scalars().all()
    for file in files:
        deleted_file_ids.append(str(file.id))
        await db.delete(file)

    # Recursively delete subfolders
    subfolders_result = await db.execute(
        select(Folder).filter(Folder.parent_id == folder_id)
    )
    subfolders = subfolders_result.scalars().all()

    for subfolder in subfolders:
        child_files, child_folders = await delete_folder_contents_recursive(
            db, str(subfolder.id), user_id
        )
        deleted_file_ids.extend(child_files)
        deleted_folder_ids.extend(child_folders)
        deleted_folder_ids.append(str(subfolder.id))
        await db.delete(subfolder)

    return deleted_file_ids, deleted_folder_ids