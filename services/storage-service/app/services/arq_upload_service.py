"""
ARQ Upload Service

Automatic Repeat Request for reliable chunk uploads.
Handles upload failures with exponential backoff retry and checksum verification.

Features:
- Exponential backoff retry (1s, 3s, 10s delays)
- SHA-256 checksum verification for data integrity
- Configurable retry limits
- Redis-based upload session tracking
- Integration with existing upload flow
"""

import asyncio
import hashlib
import logging
import os
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Tuple

import redis.asyncio as aioredis

logger = logging.getLogger(__name__)


@dataclass
class ChunkUploadResult:
    """Result of a chunk upload attempt with ARQ."""

    success: bool
    chunk_index: int
    attempts: int
    checksum: str
    error: Optional[str] = None
    retry_after: Optional[float] = None  # Seconds until next retry allowed


@dataclass
class ARQConfig:
    """Configuration for ARQ behavior."""

    max_retries: int = 3
    retry_delays: Tuple[float, ...] = (1.0, 3.0, 10.0)  # Exponential backoff delays in seconds
    verify_checksum: bool = True
    checksum_algorithm: str = "sha256"


class ARQUploadService:
    """
    Automatic Repeat Request for reliable chunk uploads.

    Provides retry logic with exponential backoff for upload failures,
    checksum verification for data integrity, and Redis-based session tracking.
    """

    def __init__(
        self, redis_client: Optional[aioredis.Redis] = None, config: Optional[ARQConfig] = None
    ):
        self.redis = redis_client
        self.config = config or ARQConfig()

        # In-memory retry tracking (per upload session)
        self._retry_counts: Dict[str, Dict[int, int]] = (
            {}
        )  # upload_id -> {chunk_index: retry_count}
        self._checksums: Dict[str, Dict[int, str]] = {}  # upload_id -> {chunk_index: checksum}

    def set_redis(self, redis_client: aioredis.Redis):
        """Set Redis client for session tracking."""
        self.redis = redis_client

    def compute_checksum(self, data: bytes) -> str:
        """
        Compute checksum for data integrity verification.

        Args:
            data: Raw chunk data

        Returns:
            Hex-encoded checksum string
        """
        if self.config.checksum_algorithm == "sha256":
            return hashlib.sha256(data).hexdigest()
        elif self.config.checksum_algorithm == "md5":
            return hashlib.md5(data).hexdigest()
        else:
            raise ValueError(f"Unsupported checksum algorithm: {self.config.checksum_algorithm}")

    async def upload_chunk_with_arq(
        self,
        chunk_data: bytes,
        chunk_index: int,
        upload_id: str,
        upload_func: Callable[[bytes, int, str], Any],
    ) -> ChunkUploadResult:
        """
        Upload chunk with ARQ retry logic.

        Args:
            chunk_data: Raw chunk data to upload
            chunk_index: Index of this chunk (0-based)
            upload_id: Upload session ID
            upload_func: Async function to call for actual upload
                        Signature: async (chunk_data, chunk_index, upload_id) -> Any

        Returns:
            ChunkUploadResult with success/failure status and metadata
        """
        # Initialize retry tracking for this upload
        if upload_id not in self._retry_counts:
            self._retry_counts[upload_id] = {}

        # Compute checksum before upload
        checksum = self.compute_checksum(chunk_data)

        # Store checksum for verification
        if upload_id not in self._checksums:
            self._checksums[upload_id] = {}
        self._checksums[upload_id][chunk_index] = checksum

        # Attempt upload with retries
        attempts = 0
        last_error = None

        while attempts <= self.config.max_retries:
            attempts += 1

            try:
                # Call the actual upload function
                await upload_func(chunk_data, chunk_index, upload_id)

                # Update retry count in tracking
                self._retry_counts[upload_id][chunk_index] = attempts

                # Store in Redis for persistence (if available)
                if self.redis:
                    await self._store_chunk_status(
                        upload_id, chunk_index, "success", checksum, attempts
                    )

                logger.info(
                    f"Chunk {chunk_index} uploaded successfully for upload {upload_id[:8]}... "
                    f"(attempts={attempts}, checksum={checksum[:16]}...)"
                )

                return ChunkUploadResult(
                    success=True, chunk_index=chunk_index, attempts=attempts, checksum=checksum
                )

            except Exception as e:
                last_error = str(e)
                logger.warning(
                    f"Chunk {chunk_index} upload failed for upload {upload_id[:8]}... "
                    f"(attempt {attempts}/{self.config.max_retries + 1}): {e}"
                )

                # Check if we have retries left
                if attempts <= self.config.max_retries:
                    # Calculate delay with exponential backoff
                    delay_index = min(attempts - 1, len(self.config.retry_delays) - 1)
                    delay = self.config.retry_delays[delay_index]

                    logger.info(f"Retrying chunk {chunk_index} in {delay}s...")
                    await asyncio.sleep(delay)
                else:
                    # No more retries
                    break

        # All retries exhausted
        logger.error(
            f"Chunk {chunk_index} upload failed after {attempts} attempts for upload {upload_id[:8]}..."
        )

        if self.redis:
            await self._store_chunk_status(
                upload_id, chunk_index, "failed", checksum, attempts, last_error
            )

        return ChunkUploadResult(
            success=False,
            chunk_index=chunk_index,
            attempts=attempts,
            checksum=checksum,
            error=last_error,
        )

    async def verify_chunk_integrity(
        self, upload_id: str, chunk_index: int, expected_checksum: str
    ) -> bool:
        """
        Verify chunk was stored correctly by comparing checksums.

        Args:
            upload_id: Upload session ID
            chunk_index: Index of chunk to verify
            expected_checksum: Expected checksum from client

        Returns:
            True if checksums match, False otherwise
        """
        stored_checksum = self._checksums.get(upload_id, {}).get(chunk_index)

        if not stored_checksum:
            # Try to get from Redis
            if self.redis:
                stored_checksum = await self._get_chunk_checksum(upload_id, chunk_index)

        if not stored_checksum:
            logger.warning(
                f"No stored checksum found for chunk {chunk_index} of upload {upload_id[:8]}..."
            )
            return False

        matches = stored_checksum == expected_checksum

        if not matches:
            logger.error(
                f"Checksum mismatch for chunk {chunk_index}: "
                f"expected={expected_checksum[:16]}..., got={stored_checksum[:16]}..."
            )

        return matches

    async def get_failed_chunks(self, upload_id: str) -> List[int]:
        """
        Get list of chunk indices that failed to upload.

        Args:
            upload_id: Upload session ID

        Returns:
            List of failed chunk indices
        """
        if self.redis:
            # Get from Redis
            pattern = f"arq:chunk:{upload_id}:*:status"
            failed = []

            async for key in self.redis.scan_iter(match=pattern):
                status = await self.redis.get(key)
                if status and status.decode() == "failed":
                    # Extract chunk index from key
                    parts = key.decode().split(":")
                    if len(parts) >= 4:
                        try:
                            chunk_index = int(parts[3])
                            failed.append(chunk_index)
                        except ValueError:
                            pass

            return sorted(failed)

        return []

    async def get_upload_progress(self, upload_id: str, total_chunks: int) -> Dict[str, Any]:
        """
        Get upload progress including ARQ retry statistics.

        Args:
            upload_id: Upload session ID
            total_chunks: Total number of chunks expected

        Returns:
            Dict with progress information
        """
        successful = 0
        failed = 0
        pending = 0
        total_retries = 0

        if self.redis:
            for chunk_index in range(total_chunks):
                status = await self.redis.get(f"arq:chunk:{upload_id}:{chunk_index}:status")
                if status:
                    status = status.decode()
                    if status == "success":
                        successful += 1
                    elif status == "failed":
                        failed += 1

                    # Get retry count
                    retries = await self.redis.get(f"arq:chunk:{upload_id}:{chunk_index}:attempts")
                    if retries:
                        total_retries += (
                            int(retries.decode()) - 1
                        )  # -1 because first attempt isn't a retry
                else:
                    pending += 1
        else:
            # Use in-memory tracking
            retry_data = self._retry_counts.get(upload_id, {})
            successful = len(retry_data)
            pending = total_chunks - successful
            total_retries = sum(max(0, v - 1) for v in retry_data.values())

        return {
            "upload_id": upload_id,
            "total_chunks": total_chunks,
            "successful": successful,
            "failed": failed,
            "pending": pending,
            "progress_percent": (successful / total_chunks * 100) if total_chunks > 0 else 0,
            "total_retries": total_retries,
            "arq_enabled": True,
        }

    async def cleanup_upload_session(self, upload_id: str):
        """
        Clean up ARQ tracking data for completed upload.

        Args:
            upload_id: Upload session ID to clean up
        """
        # Clean in-memory tracking
        self._retry_counts.pop(upload_id, None)
        self._checksums.pop(upload_id, None)

        # Clean Redis tracking
        if self.redis:
            pattern = f"arq:chunk:{upload_id}:*"
            async for key in self.redis.scan_iter(match=pattern):
                await self.redis.delete(key)

            logger.info(f"Cleaned up ARQ session for upload {upload_id[:8]}...")

    # Private helper methods

    async def _store_chunk_status(
        self,
        upload_id: str,
        chunk_index: int,
        status: str,
        checksum: str,
        attempts: int,
        error: Optional[str] = None,
    ):
        """Store chunk status in Redis."""
        if not self.redis:
            return

        prefix = f"arq:chunk:{upload_id}:{chunk_index}"
        ttl = 86400  # 24 hours

        pipe = self.redis.pipeline()
        pipe.setex(f"{prefix}:status", ttl, status)
        pipe.setex(f"{prefix}:checksum", ttl, checksum)
        pipe.setex(f"{prefix}:attempts", ttl, str(attempts))
        pipe.setex(f"{prefix}:timestamp", ttl, datetime.utcnow().isoformat())

        if error:
            pipe.setex(f"{prefix}:error", ttl, error)

        await pipe.execute()

    async def _get_chunk_checksum(self, upload_id: str, chunk_index: int) -> Optional[str]:
        """Get chunk checksum from Redis."""
        if not self.redis:
            return None

        checksum = await self.redis.get(f"arq:chunk:{upload_id}:{chunk_index}:checksum")
        return checksum.decode() if checksum else None


# Global instance
arq_upload_service = ARQUploadService()
