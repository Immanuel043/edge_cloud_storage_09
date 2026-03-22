"""
URL Upload Router

Endpoints for uploading files from URLs with:
- SSRF protection
- Background job processing
- Progress tracking
- Security scanning
"""

from fastapi import APIRouter, Depends, HTTPException, Request, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import List
import logging
from datetime import datetime

from ..dependencies import get_db, get_current_user, log_activity, get_plan_quota
from ..database import get_redis
from ..models.database import User, Object, URLUploadJob, Folder
from ..models.schemas import (
    URLUploadRequest,
    URLUploadResponse,
    URLUploadStatusResponse
)
from ..services.url_upload_service import url_upload_service, URLUploadError
from ..services.url_validator import SSRFProtectionError
from ..services.encryption import encryption_service
from ..config import settings

router = APIRouter(prefix="/api/v1/upload", tags=["url-upload"])
logger = logging.getLogger(__name__)

# Rate limiting: track concurrent uploads per user
user_active_uploads = {}  # user_id -> count
MAX_CONCURRENT_URL_UPLOADS = getattr(settings, 'URL_UPLOAD_CONCURRENT_LIMIT', 5)


@router.post("/from-url", response_model=URLUploadResponse)
async def upload_from_url(
    request_data: URLUploadRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """
    Upload a file from a URL (server-side download)

    Security features:
    - SSRF protection (blocks private IPs, localhost, metadata endpoints)
    - File size limits
    - Timeout controls
    - Virus scanning
    - Rate limiting

    Args:
        request_data: URL upload request
        background_tasks: FastAPI background tasks
        current_user: Authenticated user
        db: Database session
        request: HTTP request

    Returns:
        URLUploadResponse with job_id

    Raises:
        HTTPException: If validation fails or quota exceeded
    """
    redis_client = await get_redis()

    # Check rate limit
    user_id_str = str(current_user.id)
    active_count = user_active_uploads.get(user_id_str, 0)
    if active_count >= MAX_CONCURRENT_URL_UPLOADS:
        raise HTTPException(
            status_code=429,
            detail=f"Too many concurrent URL uploads. Maximum: {MAX_CONCURRENT_URL_UPLOADS}"
        )

    # Validate folder if provided
    folder_id = None
    if request_data.folder_id:
        result = await db.execute(
            select(Folder).where(
                Folder.id == request_data.folder_id,
                Folder.user_id == current_user.id
            )
        )
        folder = result.scalar_one_or_none()
        if not folder:
            raise HTTPException(status_code=404, detail="Folder not found")
        folder_id = request_data.folder_id

    # Create database job record
    job = URLUploadJob(
        user_id=current_user.id,
        folder_id=folder_id,
        source_url=request_data.url,
        filename=request_data.filename,
        status='pending'
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    job_id = str(job.id)

    # Log activity
    await log_activity(
        db, current_user.id, "url_upload_initiated", job_id,
        {"url": request_data.url, "folder_id": folder_id},
        request
    )

    # Start background download
    background_tasks.add_task(
        process_url_download,
        job_id=job_id,
        url=request_data.url,
        user_id=user_id_str,
        folder_id=folder_id,
        override_filename=request_data.filename
    )

    # Increment active uploads counter
    user_active_uploads[user_id_str] = active_count + 1

    logger.info(f"URL upload job {job_id} initiated for user {current_user.id}")

    return URLUploadResponse(
        job_id=job_id,
        status="pending",
        url=request_data.url,
        message="Download started in background. Use /status endpoint to track progress."
    )


async def process_url_download(
    job_id: str,
    url: str,
    user_id: str,
    folder_id: str = None,
    override_filename: str = None
):
    """
    Background task to process URL download

    Args:
        job_id: URL upload job ID
        url: URL to download
        user_id: User ID
        folder_id: Optional folder ID
        override_filename: Optional filename override
    """
    from ..database import async_session_maker

    redis_client = await get_redis()

    try:
        logger.info(f"Starting URL download for job {job_id}")

        # Update job status to downloading
        async with async_session_maker() as db:
            result = await db.execute(
                select(URLUploadJob).where(URLUploadJob.id == job_id)
            )
            job = result.scalar_one_or_none()
            if job:
                job.status = 'downloading'
                job.started_at = datetime.utcnow()
                await db.commit()

        # Download file
        download_result = await url_upload_service.download_from_url(
            job_id=job_id,
            url=url,
            user_id=user_id,
            folder_id=folder_id,
            redis_client=redis_client
        )

        # Use override filename if provided
        if override_filename:
            download_result['filename'] = override_filename

        # Create file record in database
        async with async_session_maker() as db:
            # Create Object record
            file_obj = Object(
                id=download_result['file_id'],
                user_id=user_id,
                folder_id=folder_id,
                file_name=download_result['filename'],
                file_size=download_result['file_size'],
                mime_type=download_result['mime_type'],
                content_hash=download_result['content_hash'],
                encryption_key=download_result['encryption_key'],
                storage_type=download_result['storage_type'],
                object_path=download_result['storage_path'],
                storage_tier=download_result['storage_tier'],
                file_metadata={
                    'source_url': url,
                    'download_method': 'url_upload'
                }
            )
            db.add(file_obj)

            # Check quota before updating storage
            user_result = await db.execute(
                select(User).where(User.id == user_id)
            )
            user = user_result.scalar_one_or_none()
            if user:
                await get_plan_quota(user, db)
                available = (user.storage_quota or 0) - (user.storage_used or 0)
                if download_result['file_size'] > available:
                    # Over quota — clean up downloaded file and fail
                    if download_result.get('storage_path'):
                        import os
                        try:
                            os.remove(download_result['storage_path'])
                        except OSError:
                            pass
                    await db.rollback()
                    raise URLUploadError(
                        f"Storage quota exceeded. Available: {available} bytes, "
                        f"File size: {download_result['file_size']} bytes"
                    )
                user.storage_used = (user.storage_used or 0) + download_result['file_size']

            # Update job record
            job_result = await db.execute(
                select(URLUploadJob).where(URLUploadJob.id == job_id)
            )
            job = job_result.scalar_one_or_none()
            if job:
                job.status = 'completed'
                job.file_id = download_result['file_id']
                job.filename = download_result['filename']
                job.mime_type = download_result['mime_type']
                job.total_size = download_result['file_size']
                job.downloaded_size = download_result['file_size']
                job.progress = 100
                job.completed_at = datetime.utcnow()

            await db.commit()

        logger.info(
            f"URL download completed for job {job_id}, "
            f"file {download_result['file_id']}"
        )

        # Run virus scan in background (fire and forget)
        # Note: Integrate with existing virus scanner if needed

    except SSRFProtectionError as e:
        logger.warning(f"SSRF blocked for job {job_id}: {e}")
        await _mark_job_failed(job_id, f"Security check failed: {str(e)}")

    except URLUploadError as e:
        logger.error(f"URL upload failed for job {job_id}: {e}")
        await _mark_job_failed(job_id, str(e))

    except Exception as e:
        logger.error(f"Unexpected error in URL upload {job_id}: {e}", exc_info=True)
        await _mark_job_failed(job_id, f"Internal error: {str(e)}")

    finally:
        # Decrement active uploads counter
        if user_id in user_active_uploads:
            user_active_uploads[user_id] = max(0, user_active_uploads[user_id] - 1)


async def _mark_job_failed(job_id: str, error_message: str):
    """Mark job as failed in database"""
    from ..database import async_session_maker

    try:
        async with async_session_maker() as db:
            result = await db.execute(
                select(URLUploadJob).where(URLUploadJob.id == job_id)
            )
            job = result.scalar_one_or_none()
            if job:
                job.status = 'failed'
                job.error_message = error_message
                job.completed_at = datetime.utcnow()
                await db.commit()
    except Exception as e:
        logger.error(f"Failed to mark job {job_id} as failed: {e}")


@router.get("/from-url/status/{job_id}", response_model=URLUploadStatusResponse)
async def get_url_upload_status(
    job_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Get status of URL upload job

    Args:
        job_id: Job ID
        current_user: Authenticated user
        db: Database session

    Returns:
        URLUploadStatusResponse with job status

    Raises:
        HTTPException: If job not found or unauthorized
    """
    # Get job from database
    result = await db.execute(
        select(URLUploadJob).where(URLUploadJob.id == job_id)
    )
    job = result.scalar_one_or_none()

    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    # Verify ownership
    if job.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Unauthorized")

    return URLUploadStatusResponse(
        job_id=str(job.id),
        status=job.status,
        progress=job.progress,
        total_size=job.total_size,
        downloaded_size=job.downloaded_size,
        file_id=str(job.file_id) if job.file_id else None,
        filename=job.filename,
        error=job.error_message,
        created_at=job.created_at,
        updated_at=job.updated_at
    )


@router.get("/from-url/jobs", response_model=List[URLUploadStatusResponse])
async def list_url_upload_jobs(
    status: str = None,
    limit: int = 20,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    List URL upload jobs for current user

    Args:
        status: Filter by status (pending, downloading, completed, failed)
        limit: Maximum number of jobs to return
        current_user: Authenticated user
        db: Database session

    Returns:
        List of URLUploadStatusResponse
    """
    query = select(URLUploadJob).where(
        URLUploadJob.user_id == current_user.id
    ).order_by(URLUploadJob.created_at.desc()).limit(limit)

    if status:
        query = query.where(URLUploadJob.status == status)

    result = await db.execute(query)
    jobs = result.scalars().all()

    return [
        URLUploadStatusResponse(
            job_id=str(job.id),
            status=job.status,
            progress=job.progress,
            total_size=job.total_size,
            downloaded_size=job.downloaded_size,
            file_id=str(job.file_id) if job.file_id else None,
            filename=job.filename,
            error=job.error_message,
            created_at=job.created_at,
            updated_at=job.updated_at
        )
        for job in jobs
    ]


@router.delete("/from-url/{job_id}")
async def cancel_url_upload(
    job_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Cancel or delete a URL upload job

    Note: Can only cancel pending jobs. Completed jobs will have their
    record deleted but the file will remain.

    Args:
        job_id: Job ID
        current_user: Authenticated user
        db: Database session

    Returns:
        Success message

    Raises:
        HTTPException: If job not found or unauthorized
    """
    result = await db.execute(
        select(URLUploadJob).where(URLUploadJob.id == job_id)
    )
    job = result.scalar_one_or_none()

    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if job.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Unauthorized")

    # Delete job record
    await db.delete(job)
    await db.commit()

    logger.info(f"URL upload job {job_id} deleted by user {current_user.id}")

    return {
        "status": "success",
        "message": "Job deleted",
        "job_id": job_id
    }
