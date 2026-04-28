"""
Folder Upload Router

Endpoints for uploading folders with structure preservation:
- Path traversal prevention
- Batch upload support
- Progress tracking
"""

import asyncio
import hashlib
import logging
import mimetypes
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

import aiofiles
from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_redis
from ..dependencies import get_current_user, get_db, get_plan_quota, log_activity
from ..models.database import Folder, Object, User
from ..models.schemas import (
    FolderUploadCompleteRequest,
    FolderUploadFileRequest,
    FolderUploadInit,
    FolderUploadInitResponse,
    FolderUploadStatusResponse,
)
from ..routers.upload import STREAM_BUFFER_SIZE, process_chunk_cpu_bound, should_compress
from ..services.encryption import encryption_service
from ..services.folder_upload_service import PathValidationError, folder_upload_service

router = APIRouter(prefix="/api/v1/upload/folder", tags=["folder-upload"])
logger = logging.getLogger(__name__)

executor = ThreadPoolExecutor(max_workers=50)


@router.post("/init", response_model=FolderUploadInitResponse)
async def init_folder_upload(
    init_data: FolderUploadInit,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """
    Initialize a folder upload session

    Args:
        init_data: Folder upload initialization data
        current_user: Authenticated user
        db: Database session
        request: HTTP request

    Returns:
        FolderUploadInitResponse with session_id and root_folder_id

    Raises:
        HTTPException: If validation fails or quota exceeded
    """
    redis_client = await get_redis()

    # Validate folder name
    try:
        folder_upload_service.validate_path(init_data.folder_name)
    except PathValidationError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Sanitize folder name
    safe_folder_name = folder_upload_service.sanitize_path(init_data.folder_name)

    # Self-heal quota from plan before check
    await get_plan_quota(current_user, db)

    # Check storage quota
    if current_user.storage_used + init_data.total_size > current_user.storage_quota:
        raise HTTPException(status_code=413, detail="Storage quota exceeded")

    # Atomically reserve space in Redis to prevent concurrent folder uploads exceeding quota
    user_id_str = str(current_user.id)
    reserve_key = f"quota_reserved:{user_id_str}"
    pipe = redis_client.pipeline()
    pipe.incrby(reserve_key, init_data.total_size)
    pipe.expire(reserve_key, 7200)  # 2-hour TTL for cleanup
    results = await pipe.execute()
    reserved = results[0]
    if (current_user.storage_used or 0) + reserved > (current_user.storage_quota or 0):
        # Over quota with reservation — undo and reject
        await redis_client.decrby(reserve_key, init_data.total_size)
        raise HTTPException(
            status_code=413, detail="Storage quota exceeded (concurrent upload limit)"
        )

    # Validate file count
    if init_data.total_files > folder_upload_service.MAX_FILES_PER_UPLOAD:
        raise HTTPException(
            status_code=400,
            detail=f"Too many files (max: {folder_upload_service.MAX_FILES_PER_UPLOAD})",
        )

    # Validate parent folder if specified
    parent_folder = None
    if init_data.parent_id:
        result = await db.execute(
            select(Folder).where(
                Folder.id == init_data.parent_id, Folder.user_id == current_user.id
            )
        )
        parent_folder = result.scalar_one_or_none()
        if not parent_folder:
            raise HTTPException(status_code=404, detail="Parent folder not found")

    # Create root folder
    parent_path = parent_folder.path if parent_folder else "/"
    folder_path = (
        os.path.join(parent_path, safe_folder_name)
        if parent_path != "/"
        else f"/{safe_folder_name}"
    )

    root_folder = Folder(
        user_id=current_user.id,
        parent_id=init_data.parent_id,
        name=safe_folder_name,
        path=folder_path,
    )
    db.add(root_folder)
    await db.commit()
    await db.refresh(root_folder)

    # Create upload session
    session_id = str(uuid.uuid4())

    session_data = await folder_upload_service.create_folder_session(
        session_id=session_id,
        user_id=str(current_user.id),
        root_folder_name=safe_folder_name,
        parent_folder_id=init_data.parent_id,
        total_files=init_data.total_files,
        total_size=init_data.total_size,
        redis_client=redis_client,
    )

    # Store root folder in session
    await folder_upload_service.add_created_folder(
        session_id, "", str(root_folder.id), redis_client
    )

    # Log activity
    await log_activity(
        db,
        current_user.id,
        "folder_upload_initiated",
        str(root_folder.id),
        {
            "folder_name": safe_folder_name,
            "total_files": init_data.total_files,
            "total_size": init_data.total_size,
        },
        request,
    )

    logger.info(f"Folder upload session {session_id} initiated by user {current_user.id}")

    return FolderUploadInitResponse(
        session_id=session_id,
        root_folder_id=str(root_folder.id),
        folder_name=safe_folder_name,
        message=f"Folder upload session created. Upload {init_data.total_files} files.",
    )


@router.post("/upload/{session_id}")
async def upload_folder_file(
    session_id: str,
    relative_path: str,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Upload a single file within a folder upload session

    Args:
        session_id: Folder upload session ID
        relative_path: Relative path of file (e.g., "docs/readme.txt")
        file: File to upload
        current_user: Authenticated user
        db: Database session

    Returns:
        Upload status

    Raises:
        HTTPException: If validation fails
    """
    redis_client = await get_redis()

    # Get session
    session_data = await folder_upload_service.get_session(session_id, redis_client)
    if not session_data:
        raise HTTPException(status_code=404, detail="Upload session not found")

    # Verify ownership
    if session_data["user_id"] != str(current_user.id):
        raise HTTPException(status_code=403, detail="Unauthorized")

    # Validate and sanitize path
    try:
        folder_upload_service.validate_path(relative_path)
        safe_path = folder_upload_service.sanitize_path(relative_path)
    except PathValidationError as e:
        await folder_upload_service.mark_file_failed(
            session_id, relative_path, str(e), redis_client
        )
        raise HTTPException(status_code=400, detail=str(e))

    try:
        # Parse path
        parts = safe_path.split("/")
        filename = parts[-1]
        folder_path = "/".join(parts[:-1]) if len(parts) > 1 else ""

        # Get or create folder
        folder_id = await _get_or_create_folder_path(
            session_id=session_id,
            session_data=session_data,
            folder_path=folder_path,
            user_id=current_user.id,
            db=db,
            redis_client=redis_client,
        )

        # Read file data
        file_data = await file.read()
        file_size = len(file_data)

        # Generate encryption key
        file_key = encryption_service.generate_file_key()
        encrypted_key = encryption_service.encrypt_key(file_key)

        # Determine compression
        use_compression = should_compress(filename, file_size)

        # Process file (encrypt + optional compress)
        loop = asyncio.get_event_loop()

        def process_file():
            if use_compression:
                from ..utils.compression import compressor

                processed_data = compressor.compress(file_data)
            else:
                processed_data = file_data

            encrypted_data = encryption_service.encrypt_file(processed_data, file_key)
            file_hash = hashlib.sha256(file_data).hexdigest()
            return encrypted_data, file_hash

        encrypted_data, file_hash = await loop.run_in_executor(executor, process_file)

        # Store file
        file_id = uuid.uuid4()
        storage_tier = "cache"
        shard = str(file_id)[:2]
        storage_dir = f"/app/storage/{storage_tier}/{shard}"
        os.makedirs(storage_dir, exist_ok=True)
        storage_path = f"{storage_dir}/{file_id}.enc"

        async with aiofiles.open(storage_path, "wb", buffering=STREAM_BUFFER_SIZE) as f:
            await f.write(encrypted_data)

        # Create database record
        mime_type = mimetypes.guess_type(filename)[0]

        file_obj = Object(
            id=file_id,
            user_id=current_user.id,
            folder_id=folder_id,
            file_name=filename,
            file_size=file_size,
            mime_type=mime_type,
            storage_type="single",
            object_path=storage_path,
            content_hash=file_hash,
            encryption_key=encrypted_key,
            storage_tier=storage_tier,
            file_metadata={
                "compressed": use_compression,
                "upload_method": "folder_upload",
                "relative_path": safe_path,
            },
        )
        db.add(file_obj)

        # Update user storage
        current_user.storage_used = (current_user.storage_used or 0) + file_size

        await db.commit()

        # Mark file as uploaded in session
        await folder_upload_service.mark_file_uploaded(session_id, str(file_id), redis_client)

        logger.info(
            f"File uploaded in folder session {session_id}: " f"{safe_path} ({file_size} bytes)"
        )

        return {
            "status": "success",
            "file_id": str(file_id),
            "filename": filename,
            "file_size": file_size,
            "relative_path": safe_path,
            "compressed": use_compression,
            "encrypted": True,
        }

    except Exception as e:
        logger.error(
            f"File upload failed in session {session_id} for {relative_path}: {e}", exc_info=True
        )
        await folder_upload_service.mark_file_failed(
            session_id, relative_path, str(e), redis_client
        )
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")


async def _get_or_create_folder_path(
    session_id: str,
    session_data: dict,
    folder_path: str,
    user_id: uuid.UUID,
    db: AsyncSession,
    redis_client,
) -> uuid.UUID:
    """
    Get or create folder at path, creating parent folders as needed

    Args:
        session_id: Session ID
        session_data: Session data
        folder_path: Relative folder path (e.g., "docs/images")
        user_id: User ID
        db: Database session
        redis_client: Redis client

    Returns:
        Folder ID
    """
    # If root folder, return it
    if not folder_path:
        return session_data["created_folders"][""]

    # Check if already created
    if folder_path in session_data["created_folders"]:
        return session_data["created_folders"][folder_path]

    # Split path and create parent folders first
    parts = folder_path.split("/")
    current_path = ""
    current_folder_id = session_data["created_folders"][""]  # Root folder

    for part in parts:
        parent_folder_id = current_folder_id
        current_path = f"{current_path}/{part}" if current_path else part

        # Check if this level already exists
        if current_path in session_data["created_folders"]:
            current_folder_id = session_data["created_folders"][current_path]
            continue

        # Get parent folder to construct full path
        result = await db.execute(select(Folder).where(Folder.id == parent_folder_id))
        parent_folder = result.scalar_one()

        full_path = f"{parent_folder.path}/{part}"

        # Create folder
        new_folder = Folder(user_id=user_id, parent_id=parent_folder_id, name=part, path=full_path)
        db.add(new_folder)
        await db.flush()
        await db.refresh(new_folder)

        current_folder_id = new_folder.id

        # Track in session
        await folder_upload_service.add_created_folder(
            session_id, current_path, str(new_folder.id), redis_client
        )

    return current_folder_id


@router.post("/complete", response_model=FolderUploadStatusResponse)
async def complete_folder_upload(
    complete_data: FolderUploadCompleteRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """
    Complete a folder upload session

    Args:
        complete_data: Completion request
        current_user: Authenticated user
        db: Database session
        request: HTTP request

    Returns:
        FolderUploadStatusResponse with final status

    Raises:
        HTTPException: If session not found or unauthorized
    """
    redis_client = await get_redis()

    # Get session
    session_data = await folder_upload_service.get_session(complete_data.session_id, redis_client)
    if not session_data:
        raise HTTPException(status_code=404, detail="Upload session not found")

    # Verify ownership
    if session_data["user_id"] != str(current_user.id):
        raise HTTPException(status_code=403, detail="Unauthorized")

    # Update session status
    await folder_upload_service.update_session(
        complete_data.session_id, {"status": "completed"}, redis_client
    )

    # Release quota reservation (actual usage is tracked in DB per-file)
    try:
        total_size = session_data.get("total_size", 0)
        if total_size > 0:
            await redis_client.decrby(f"quota_reserved:{str(current_user.id)}", total_size)
    except Exception:
        pass

    # Log activity
    root_folder_id = session_data["created_folders"].get("")
    await log_activity(
        db,
        current_user.id,
        "folder_upload_completed",
        root_folder_id,
        {
            "total_files": session_data["total_files"],
            "uploaded_files": session_data["uploaded_files"],
            "failed_files": session_data["failed_files"],
        },
        request,
    )

    progress = (
        (session_data["uploaded_files"] / session_data["total_files"] * 100)
        if session_data["total_files"] > 0
        else 100
    )

    logger.info(
        f"Folder upload session {complete_data.session_id} completed: "
        f"{session_data['uploaded_files']}/{session_data['total_files']} files"
    )

    return FolderUploadStatusResponse(
        session_id=complete_data.session_id,
        status="completed",
        root_folder_id=root_folder_id,
        total_files=session_data["total_files"],
        uploaded_files=session_data["uploaded_files"],
        failed_files=session_data["failed_files"],
        progress=progress,
        errors=[e.get("error", "") for e in session_data.get("errors", [])],
    )


@router.get("/status/{session_id}", response_model=FolderUploadStatusResponse)
async def get_folder_upload_status(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Get status of folder upload session

    Args:
        session_id: Session ID
        current_user: Authenticated user
        db: Database session

    Returns:
        FolderUploadStatusResponse

    Raises:
        HTTPException: If session not found or unauthorized
    """
    redis_client = await get_redis()

    session_data = await folder_upload_service.get_session(session_id, redis_client)
    if not session_data:
        raise HTTPException(status_code=404, detail="Upload session not found")

    if session_data["user_id"] != str(current_user.id):
        raise HTTPException(status_code=403, detail="Unauthorized")

    progress = (
        (session_data["uploaded_files"] / session_data["total_files"] * 100)
        if session_data["total_files"] > 0
        else 0
    )

    return FolderUploadStatusResponse(
        session_id=session_id,
        status=session_data["status"],
        root_folder_id=session_data["created_folders"].get(""),
        total_files=session_data["total_files"],
        uploaded_files=session_data["uploaded_files"],
        failed_files=session_data["failed_files"],
        progress=progress,
        errors=[e.get("error", "") for e in session_data.get("errors", [])],
    )
