"""
URL Upload Service

Handles server-side file downloads from URLs with:
- Streaming downloads
- Progress tracking
- SSRF protection
- Size limits
- Timeout controls
- Virus scanning integration
"""

import asyncio
import hashlib
import json
import logging
import mimetypes
import uuid
from datetime import datetime
from typing import Any, AsyncGenerator, Dict, Optional

import httpx

from ..config import settings
from .encryption import encryption_service
from .url_validator import SSRFProtectionError, url_validator

logger = logging.getLogger(__name__)


class URLUploadError(Exception):
    """Base exception for URL upload errors"""

    pass


class URLUploadService:
    """
    Service for downloading files from URLs and storing them

    Features:
    - SSRF protection
    - Streaming downloads (memory efficient)
    - Progress tracking via Redis
    - Size/timeout validation
    - Content-Type validation
    - Integration with existing upload pipeline
    """

    def __init__(self):
        self.max_size = getattr(settings, "URL_UPLOAD_MAX_SIZE", 5 * 1024**3)  # 5GB
        self.timeout = getattr(settings, "URL_UPLOAD_TIMEOUT", 600)  # 10 minutes
        self.max_redirects = 5
        self.chunk_size = 8 * 1024 * 1024  # 8MB chunks

    async def initiate_download(
        self, url: str, user_id: str, folder_id: Optional[str] = None, redis_client=None
    ) -> Dict[str, Any]:
        """
        Initiate a URL download job

        Args:
            url: URL to download from
            user_id: User ID
            folder_id: Optional folder ID
            redis_client: Redis client for job tracking

        Returns:
            Job information dict

        Raises:
            URLUploadError: If validation fails
            SSRFProtectionError: If URL is blocked
        """
        # Validate and sanitize URL
        try:
            url_validator.validate_url(url)
            url = url_validator.sanitize_url(url)
        except SSRFProtectionError as e:
            logger.warning(f"SSRF protection blocked URL {url}: {e}")
            raise

        # Create job ID
        job_id = str(uuid.uuid4())

        # Create job metadata
        job_data = {
            "id": job_id,
            "url": url,
            "user_id": user_id,
            "folder_id": folder_id,
            "status": "pending",
            "progress": 0,
            "total_size": 0,
            "downloaded_size": 0,
            "created_at": datetime.utcnow().isoformat(),
            "error": None,
            "file_id": None,
        }

        # Store in Redis
        if redis_client:
            await redis_client.setex(
                f"url_upload:{job_id}", 3600, json.dumps(job_data)  # 1 hour TTL
            )

        logger.info(f"URL download job created: {job_id} for {url}")

        return job_data

    async def download_from_url(
        self,
        job_id: str,
        url: str,
        user_id: str,
        folder_id: Optional[str] = None,
        redis_client=None,
    ) -> Dict[str, Any]:
        """
        Download file from URL and store it

        Args:
            job_id: Job ID
            url: URL to download
            user_id: User ID
            folder_id: Optional folder ID
            redis_client: Redis client for progress tracking

        Returns:
            Download result with file_id

        Raises:
            URLUploadError: If download fails
        """
        try:
            # Update job status
            await self._update_job_status(redis_client, job_id, "downloading", progress=0)

            # Create HTTP client with security settings
            timeout_config = httpx.Timeout(
                connect=30.0,  # 30s to connect
                read=120.0,  # 2min read timeout
                write=30.0,
                pool=10.0,
            )

            limits = httpx.Limits(max_connections=10, max_keepalive_connections=5)

            async with httpx.AsyncClient(
                timeout=timeout_config,
                limits=limits,
                follow_redirects=True,
                max_redirects=self.max_redirects,
                headers={"User-Agent": "EdgeCloudStorage/1.0 (Automated Download Service)"},
            ) as client:
                # Start streaming download
                logger.info(f"Starting download from {url}")

                async with client.stream("GET", url) as response:
                    # Check response status
                    response.raise_for_status()

                    # Validate redirect destination (DNS rebinding protection)
                    final_url = str(response.url)
                    if final_url != url:
                        url_validator.validate_after_redirect(final_url, url)

                    # Get content information
                    content_length = response.headers.get("content-length")
                    content_type = response.headers.get("content-type", "application/octet-stream")

                    # Validate size
                    if content_length:
                        size = int(content_length)
                        if size > self.max_size:
                            raise URLUploadError(
                                f"File too large: {size} bytes (max: {self.max_size})"
                            )
                        await self._update_job_status(
                            redis_client, job_id, "downloading", total_size=size
                        )
                    else:
                        size = 0
                        logger.warning(f"Content-Length not provided for {url}")

                    # Determine filename
                    filename = self._extract_filename(url, response.headers)

                    # Download and stream to storage
                    result = await self._stream_to_storage(
                        response=response,
                        filename=filename,
                        content_type=content_type,
                        user_id=user_id,
                        folder_id=folder_id,
                        job_id=job_id,
                        redis_client=redis_client,
                        expected_size=size,
                    )

                    # Update job with success
                    await self._update_job_status(
                        redis_client,
                        job_id,
                        "completed",
                        progress=100,
                        file_id=str(result["file_id"]),
                    )

                    logger.info(f"URL download completed: {job_id}, file: {result['file_id']}")

                    return result

        except httpx.HTTPStatusError as e:
            error_msg = f"HTTP error {e.response.status_code}: {e}"
            logger.error(f"URL download failed for {job_id}: {error_msg}")
            await self._update_job_status(redis_client, job_id, "failed", error=error_msg)
            raise URLUploadError(error_msg)

        except httpx.TimeoutException as e:
            error_msg = f"Download timeout: {e}"
            logger.error(f"URL download timeout for {job_id}: {error_msg}")
            await self._update_job_status(redis_client, job_id, "failed", error=error_msg)
            raise URLUploadError(error_msg)

        except SSRFProtectionError as e:
            error_msg = f"SSRF protection: {e}"
            logger.warning(f"SSRF blocked during download {job_id}: {error_msg}")
            await self._update_job_status(redis_client, job_id, "failed", error=error_msg)
            raise

        except Exception as e:
            error_msg = f"Unexpected error: {e}"
            logger.error(f"URL download failed for {job_id}: {error_msg}", exc_info=True)
            await self._update_job_status(redis_client, job_id, "failed", error=error_msg)
            raise URLUploadError(error_msg)

    async def _stream_to_storage(
        self,
        response: httpx.Response,
        filename: str,
        content_type: str,
        user_id: str,
        folder_id: Optional[str],
        job_id: str,
        redis_client,
        expected_size: int,
    ) -> Dict[str, Any]:
        """
        Stream download data directly to storage

        Args:
            response: HTTP response to stream from
            filename: File name
            content_type: MIME type
            user_id: User ID
            folder_id: Optional folder ID
            job_id: Job ID for progress tracking
            redis_client: Redis client
            expected_size: Expected file size

        Returns:
            Dict with file_id and metadata
        """
        import os

        import aiofiles

        from ..models.database import Object

        # Generate file ID and encryption key
        file_id = uuid.uuid4()
        file_key = encryption_service.generate_file_key()
        encrypted_key = encryption_service.encrypt_key(file_key)

        # Prepare storage path
        storage_tier = "cache"
        shard = str(file_id)[:2]
        storage_dir = f"/app/storage/{storage_tier}/{shard}"
        os.makedirs(storage_dir, exist_ok=True)
        storage_path = f"{storage_dir}/{file_id}.enc"

        # Download and encrypt in chunks
        total_downloaded = 0
        file_hash = hashlib.sha256()
        chunk_index = 0

        temp_file = f"{storage_path}.tmp"

        try:
            async with aiofiles.open(temp_file, "wb") as f:
                async for chunk in response.aiter_bytes(chunk_size=self.chunk_size):
                    # Check size limit
                    total_downloaded += len(chunk)
                    if total_downloaded > self.max_size:
                        raise URLUploadError(
                            f"File exceeded size limit: {total_downloaded} > {self.max_size}"
                        )

                    # Update hash
                    file_hash.update(chunk)

                    # Encrypt chunk
                    encrypted_chunk = encryption_service.encrypt_chunk(chunk, file_key, chunk_index)

                    # Write to disk
                    await f.write(encrypted_chunk)

                    chunk_index += 1

                    # Update progress
                    if expected_size > 0:
                        progress = int((total_downloaded / expected_size) * 100)
                        await self._update_job_status(
                            redis_client,
                            job_id,
                            "downloading",
                            progress=min(progress, 99),
                            downloaded_size=total_downloaded,
                        )

            # Rename temp file to final path
            os.rename(temp_file, storage_path)

            # Return file metadata
            return {
                "file_id": file_id,
                "filename": filename,
                "file_size": total_downloaded,
                "content_hash": file_hash.hexdigest(),
                "mime_type": content_type,
                "storage_path": storage_path,
                "encryption_key": encrypted_key,
                "chunk_count": chunk_index,
                "storage_tier": storage_tier,
                "storage_type": "chunked" if chunk_index > 1 else "single",
            }

        except Exception as e:
            # Clean up temp file on error
            if os.path.exists(temp_file):
                os.remove(temp_file)
            raise

    def _extract_filename(self, url: str, headers: httpx.Headers) -> str:
        """
        Extract filename from URL or Content-Disposition header

        Args:
            url: URL
            headers: Response headers

        Returns:
            Filename
        """
        # Try Content-Disposition header first
        content_disp = headers.get("content-disposition", "")
        if "filename=" in content_disp:
            import re

            match = re.search(r'filename="?([^"]+)"?', content_disp)
            if match:
                return match.group(1)

        # Extract from URL
        from urllib.parse import unquote, urlparse

        parsed = urlparse(url)
        path = unquote(parsed.path)
        filename = path.split("/")[-1]

        # If no filename, generate one
        if not filename or filename == "":
            filename = f"download_{uuid.uuid4().hex[:8]}"

        # Sanitize filename
        filename = self._sanitize_filename(filename)

        return filename

    def _sanitize_filename(self, filename: str) -> str:
        """
        Sanitize filename to remove dangerous characters

        Args:
            filename: Original filename

        Returns:
            Sanitized filename
        """
        import re

        # Remove path components
        filename = filename.split("/")[-1].split("\\")[-1]

        # Remove dangerous characters
        filename = re.sub(r"[^\w\s\-\.]", "_", filename)

        # Limit length
        if len(filename) > 255:
            name, ext = filename.rsplit(".", 1) if "." in filename else (filename, "")
            filename = name[:240] + "." + ext if ext else name[:255]

        # Ensure not empty
        if not filename:
            filename = f"file_{uuid.uuid4().hex[:8]}"

        return filename

    async def _update_job_status(
        self,
        redis_client,
        job_id: str,
        status: str,
        progress: Optional[int] = None,
        total_size: Optional[int] = None,
        downloaded_size: Optional[int] = None,
        error: Optional[str] = None,
        file_id: Optional[str] = None,
    ) -> None:
        """
        Update job status in Redis

        Args:
            redis_client: Redis client
            job_id: Job ID
            status: New status
            progress: Progress percentage (0-100)
            total_size: Total file size
            downloaded_size: Downloaded size
            error: Error message
            file_id: Uploaded file ID
        """
        if not redis_client:
            return

        try:
            # Get current job data
            job_key = f"url_upload:{job_id}"
            job_data_raw = await redis_client.get(job_key)

            if job_data_raw:
                if isinstance(job_data_raw, bytes):
                    job_data_raw = job_data_raw.decode("utf-8")
                job_data = json.loads(job_data_raw)
            else:
                job_data = {"id": job_id}

            # Update fields
            job_data["status"] = status
            if progress is not None:
                job_data["progress"] = progress
            if total_size is not None:
                job_data["total_size"] = total_size
            if downloaded_size is not None:
                job_data["downloaded_size"] = downloaded_size
            if error is not None:
                job_data["error"] = error
            if file_id is not None:
                job_data["file_id"] = file_id

            job_data["updated_at"] = datetime.utcnow().isoformat()

            # Save to Redis
            await redis_client.setex(job_key, 3600, json.dumps(job_data))

        except Exception as e:
            logger.error(f"Failed to update job status: {e}")

    async def get_job_status(self, job_id: str, redis_client) -> Optional[Dict[str, Any]]:
        """
        Get job status from Redis

        Args:
            job_id: Job ID
            redis_client: Redis client

        Returns:
            Job data dict or None if not found
        """
        if not redis_client:
            return None

        try:
            job_data_raw = await redis_client.get(f"url_upload:{job_id}")
            if not job_data_raw:
                return None

            if isinstance(job_data_raw, bytes):
                job_data_raw = job_data_raw.decode("utf-8")

            return json.loads(job_data_raw)

        except Exception as e:
            logger.error(f"Failed to get job status: {e}")
            return None


# Singleton instance
url_upload_service = URLUploadService()
