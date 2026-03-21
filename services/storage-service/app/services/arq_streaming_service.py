"""
ARQ Streaming Service

Automatic Repeat Request for reliable video streaming.
Provides checksummed chunks and retransmission support for lost packets.

Features:
- Chunked video streaming with checksums
- Session-based delivery tracking
- Retransmission endpoint for lost chunks
- Configurable chunk sizes
- Redis-based session management
- Per-user bandwidth throttling and stream limiting
- Retry-aware throttling with exponential backoff
"""

import asyncio
import hashlib
import logging
import os
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import AsyncGenerator, Dict, List, Optional, Set, Tuple

import aiofiles
import redis.asyncio as aioredis
from fastapi import HTTPException

from .bandwidth_throttle import bandwidth_throttle_service

logger = logging.getLogger(__name__)


@dataclass
class StreamingSession:
    """Represents an active streaming session."""
    session_id: str
    file_id: str
    file_path: str
    file_size: int
    chunk_size: int
    total_chunks: int
    created_at: datetime
    user_id: Optional[str] = None  # For bandwidth throttling
    plan_type: str = "free"  # User's subscription plan tier (for plan-based limits)
    db_bandwidth_override: Optional[int] = None  # Admin-set bandwidth override
    stream_slot_acquired: bool = False  # Track if stream slot is held
    delivered_chunks: Set[int] = field(default_factory=set)
    acknowledged_chunks: Set[int] = field(default_factory=set)
    checksums: Dict[int, str] = field(default_factory=dict)
    retransmit_counts: Dict[int, int] = field(default_factory=dict)  # Track retries per chunk


@dataclass
class StreamChunk:
    """A single chunk of streamed data with metadata."""
    chunk_index: int
    data: bytes
    checksum: str
    is_last: bool
    byte_start: int
    byte_end: int
    total_size: int


@dataclass
class ARQStreamingConfig:
    """Configuration for ARQ streaming."""
    default_chunk_size: int = 1 * 1024 * 1024  # 1MB default chunks
    min_chunk_size: int = 256 * 1024  # 256KB minimum
    max_chunk_size: int = 8 * 1024 * 1024  # 8MB maximum
    session_timeout_minutes: int = 30
    max_retransmissions: int = 5
    checksum_algorithm: str = 'sha256'


class ARQStreamingService:
    """
    Automatic Repeat Request for reliable video streaming.

    Tracks delivered chunks and handles retransmission requests
    when clients detect missing or corrupt data.
    """

    def __init__(
        self,
        redis_client: Optional[aioredis.Redis] = None,
        config: Optional[ARQStreamingConfig] = None
    ):
        self.redis = redis_client
        self.config = config or ARQStreamingConfig()

        # In-memory session tracking (backup when Redis unavailable)
        self._sessions: Dict[str, StreamingSession] = {}
        self._cleanup_task: Optional[asyncio.Task] = None

    def set_redis(self, redis_client: aioredis.Redis):
        """Set Redis client for session tracking."""
        self.redis = redis_client

    async def start(self):
        """Start background cleanup task."""
        self._cleanup_task = asyncio.create_task(self._cleanup_expired_sessions())

    async def stop(self):
        """Stop background tasks."""
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass

    def compute_checksum(self, data: bytes) -> str:
        """Compute checksum for data integrity verification."""
        if self.config.checksum_algorithm == 'sha256':
            return hashlib.sha256(data).hexdigest()
        elif self.config.checksum_algorithm == 'md5':
            return hashlib.md5(data).hexdigest()
        else:
            raise ValueError(f"Unsupported checksum algorithm: {self.config.checksum_algorithm}")

    async def init_stream_session(
        self,
        file_id: str,
        file_path: str,
        chunk_size: Optional[int] = None,
        user_id: Optional[str] = None,
        plan_type: str = "free",
        db_streams_override: int = None
    ) -> Dict:
        """
        Initialize a new ARQ streaming session with bandwidth throttling (plan-aware).

        Args:
            file_id: ID of the file to stream
            file_path: Path to the file on disk
            chunk_size: Optional chunk size override
            user_id: User ID for bandwidth throttling (required for throttling)
            plan_type: User's subscription plan tier (free, individual, creator, business)
            db_streams_override: Admin-set max streams override from User model

        Returns:
            Session info dict with session_id, chunk_size, total_chunks

        Raises:
            HTTPException 429 if user has too many concurrent streams
        """
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"File not found: {file_path}")

        file_size = os.path.getsize(file_path)

        # ============ BANDWIDTH THROTTLING: Acquire stream slot (plan-aware) ============
        stream_slot_acquired = False
        if user_id:
            # Get max streams for this user's plan
            max_streams = await bandwidth_throttle_service.get_max_streams_with_plan(
                user_id, plan_type, db_streams_override
            )

            stream_slot_acquired = await bandwidth_throttle_service.acquire_stream_slot(
                user_id,
                plan_type=plan_type,
                db_streams_override=db_streams_override
            )
            if not stream_slot_acquired:
                raise HTTPException(
                    status_code=429,
                    detail=f"Too many concurrent streams. Maximum {max_streams} streams allowed for your plan.",
                    headers={"Retry-After": "10"}
                )
            logger.debug(f"ARQ stream slot acquired for user {user_id} ({plan_type})")

        # Determine chunk size
        if chunk_size:
            chunk_size = max(
                self.config.min_chunk_size,
                min(chunk_size, self.config.max_chunk_size)
            )
        else:
            chunk_size = self.config.default_chunk_size

        # Calculate total chunks
        total_chunks = (file_size + chunk_size - 1) // chunk_size

        # Create session
        session_id = str(uuid.uuid4())
        session = StreamingSession(
            session_id=session_id,
            file_id=file_id,
            file_path=file_path,
            file_size=file_size,
            chunk_size=chunk_size,
            total_chunks=total_chunks,
            created_at=datetime.utcnow(),
            user_id=user_id,
            plan_type=plan_type,
            stream_slot_acquired=stream_slot_acquired
        )

        # Store session
        self._sessions[session_id] = session

        if self.redis:
            await self._store_session_to_redis(session)

        logger.info(
            f"Initialized ARQ streaming session: {session_id[:8]}... "
            f"(file={file_id}, size={file_size}, chunks={total_chunks}, user={user_id})"
        )

        return {
            'session_id': session_id,
            'file_id': file_id,
            'file_size': file_size,
            'chunk_size': chunk_size,
            'total_chunks': total_chunks,
            'checksum_algorithm': self.config.checksum_algorithm,
            'throttling_enabled': user_id is not None
        }

    async def get_chunk(
        self,
        session_id: str,
        chunk_index: int,
        is_retransmit: bool = False
    ) -> StreamChunk:
        """
        Get a specific chunk with checksum for verification.
        Applies bandwidth throttling with retry-aware penalties.

        Args:
            session_id: Active session ID
            chunk_index: Index of chunk to retrieve (0-based)
            is_retransmit: True if this is a retransmission request

        Returns:
            StreamChunk with data and checksum

        Raises:
            HTTPException 429 if bandwidth limit exceeded
        """
        session = await self._get_session(session_id)

        if chunk_index < 0 or chunk_index >= session.total_chunks:
            raise ValueError(
                f"Invalid chunk index {chunk_index}. "
                f"Valid range: 0-{session.total_chunks - 1}"
            )

        # Calculate byte range
        byte_start = chunk_index * session.chunk_size
        byte_end = min(byte_start + session.chunk_size, session.file_size) - 1
        chunk_size = byte_end - byte_start + 1

        # ============ BANDWIDTH THROTTLING ============
        if session.user_id:
            # Track retransmission count for this chunk
            if is_retransmit:
                retry_count = session.retransmit_counts.get(chunk_index, 0) + 1
                session.retransmit_counts[chunk_index] = retry_count
            else:
                retry_count = 0

            # Apply throttling with retry-aware penalty (plan-aware)
            allowed, wait_time = await bandwidth_throttle_service.can_transfer_with_priority(
                user_id=session.user_id,
                bytes_requested=chunk_size,
                retry_count=retry_count,
                plan_type=session.plan_type,
                db_bandwidth_override=session.db_bandwidth_override
            )

            if not allowed:
                wait_threshold = bandwidth_throttle_service.get_wait_threshold(
                    getattr(session, 'plan_type', 'free') or 'free'
                )
                if wait_time > wait_threshold:
                    # Return 429 with Retry-After for long waits
                    raise HTTPException(
                        status_code=429,
                        detail=f"Bandwidth limit exceeded. Please retry after {int(wait_time)} seconds.",
                        headers={"Retry-After": str(int(wait_time))}
                    )
                # Short wait - apply throttling (capped at 1 second)
                await asyncio.sleep(min(wait_time, 1.0))
                await bandwidth_throttle_service.force_consume(
                    user_id=session.user_id,
                    bytes_consumed=chunk_size,
                    plan_type=session.plan_type,
                    db_bandwidth_override=session.db_bandwidth_override
                )

        # Read chunk data
        async with aiofiles.open(session.file_path, 'rb') as f:
            await f.seek(byte_start)
            data = await f.read(chunk_size)

        # Compute checksum
        checksum = self.compute_checksum(data)

        # Track delivery
        session.delivered_chunks.add(chunk_index)
        session.checksums[chunk_index] = checksum

        if self.redis:
            await self._update_session_delivery(session_id, chunk_index, checksum)

        is_last = chunk_index == session.total_chunks - 1

        return StreamChunk(
            chunk_index=chunk_index,
            data=data,
            checksum=checksum,
            is_last=is_last,
            byte_start=byte_start,
            byte_end=byte_end,
            total_size=session.file_size
        )

    async def stream_with_arq(
        self,
        session_id: str,
        start_chunk: int = 0,
        end_chunk: Optional[int] = None
    ) -> AsyncGenerator[StreamChunk, None]:
        """
        Stream chunks with ARQ support.

        Yields StreamChunk objects that include checksums for client verification.

        Args:
            session_id: Active session ID
            start_chunk: First chunk to stream (0-based)
            end_chunk: Last chunk to stream (inclusive), None for all remaining

        Yields:
            StreamChunk objects
        """
        session = await self._get_session(session_id)

        if end_chunk is None:
            end_chunk = session.total_chunks - 1

        end_chunk = min(end_chunk, session.total_chunks - 1)
        start_chunk = max(start_chunk, 0)

        logger.info(
            f"Streaming chunks {start_chunk}-{end_chunk} for session {session_id[:8]}..."
        )

        for chunk_index in range(start_chunk, end_chunk + 1):
            chunk = await self.get_chunk(session_id, chunk_index)
            yield chunk

    async def acknowledge_chunks(
        self,
        session_id: str,
        chunk_indices: List[int]
    ) -> Dict:
        """
        Acknowledge successfully received chunks.

        Args:
            session_id: Active session ID
            chunk_indices: List of chunk indices to acknowledge

        Returns:
            Acknowledgment status
        """
        session = await self._get_session(session_id)

        for idx in chunk_indices:
            if 0 <= idx < session.total_chunks:
                session.acknowledged_chunks.add(idx)

        if self.redis:
            await self._update_session_acks(session_id, chunk_indices)

        acked_count = len(session.acknowledged_chunks)
        progress = (acked_count / session.total_chunks * 100) if session.total_chunks > 0 else 0

        logger.debug(
            f"Acknowledged {len(chunk_indices)} chunks for session {session_id[:8]}... "
            f"(total acked: {acked_count}/{session.total_chunks})"
        )

        return {
            'session_id': session_id,
            'acknowledged': chunk_indices,
            'total_acknowledged': acked_count,
            'total_chunks': session.total_chunks,
            'progress_percent': progress,
            'complete': acked_count == session.total_chunks
        }

    async def request_retransmit(
        self,
        session_id: str,
        chunk_indices: List[int]
    ) -> List[StreamChunk]:
        """
        Request retransmission of lost/corrupt chunks.
        Applies retry-aware throttling with exponential backoff penalty.

        Args:
            session_id: Active session ID
            chunk_indices: List of chunk indices to retransmit

        Returns:
            List of retransmitted StreamChunks
        """
        session = await self._get_session(session_id)

        logger.info(
            f"Retransmitting {len(chunk_indices)} chunks for session {session_id[:8]}..."
        )

        chunks = []
        for idx in chunk_indices:
            if 0 <= idx < session.total_chunks:
                # Mark as retransmit to apply throttling penalty
                chunk = await self.get_chunk(session_id, idx, is_retransmit=True)
                chunks.append(chunk)
            else:
                logger.warning(
                    f"Invalid chunk index {idx} for retransmit "
                    f"(valid range: 0-{session.total_chunks - 1})"
                )

        return chunks

    async def get_missing_chunks(self, session_id: str) -> List[int]:
        """
        Get list of chunks not yet acknowledged by client.

        Args:
            session_id: Active session ID

        Returns:
            List of missing chunk indices
        """
        session = await self._get_session(session_id)

        all_chunks = set(range(session.total_chunks))
        missing = all_chunks - session.acknowledged_chunks

        return sorted(missing)

    async def get_session_status(self, session_id: str) -> Dict:
        """
        Get current session status and statistics.

        Args:
            session_id: Session ID to query

        Returns:
            Session status dict
        """
        session = await self._get_session(session_id)

        delivered = len(session.delivered_chunks)
        acknowledged = len(session.acknowledged_chunks)
        total = session.total_chunks

        return {
            'session_id': session_id,
            'file_id': session.file_id,
            'file_size': session.file_size,
            'chunk_size': session.chunk_size,
            'total_chunks': total,
            'delivered_chunks': delivered,
            'acknowledged_chunks': acknowledged,
            'missing_chunks': total - acknowledged,
            'delivery_progress': (delivered / total * 100) if total > 0 else 0,
            'ack_progress': (acknowledged / total * 100) if total > 0 else 0,
            'complete': acknowledged == total,
            'created_at': session.created_at.isoformat(),
            'age_seconds': (datetime.utcnow() - session.created_at).total_seconds()
        }

    async def close_session(self, session_id: str):
        """
        Close a streaming session and clean up resources.
        Releases the bandwidth throttling stream slot.

        Args:
            session_id: Session ID to close
        """
        # Get session first to release stream slot
        session = self._sessions.get(session_id)

        # ============ BANDWIDTH THROTTLING: Release stream slot ============
        if session and session.stream_slot_acquired and session.user_id:
            await bandwidth_throttle_service.release_stream_slot(session.user_id)
            logger.debug(f"ARQ stream slot released for user {session.user_id}")

        if session_id in self._sessions:
            del self._sessions[session_id]

        if self.redis:
            await self._delete_session_from_redis(session_id)

        logger.info(f"Closed ARQ streaming session: {session_id[:8]}...")

    # Private helper methods

    async def _get_session(self, session_id: str) -> StreamingSession:
        """Get session from memory or Redis."""
        if session_id in self._sessions:
            return self._sessions[session_id]

        if self.redis:
            session = await self._load_session_from_redis(session_id)
            if session:
                self._sessions[session_id] = session
                return session

        raise ValueError(f"Session not found: {session_id}")

    async def _store_session_to_redis(self, session: StreamingSession):
        """Store session metadata to Redis."""
        if not self.redis:
            return

        key = f"arq:stream:{session.session_id}"
        ttl = self.config.session_timeout_minutes * 60

        data = {
            'file_id': session.file_id,
            'file_path': session.file_path,
            'file_size': str(session.file_size),
            'chunk_size': str(session.chunk_size),
            'total_chunks': str(session.total_chunks),
            'created_at': session.created_at.isoformat(),
            'user_id': session.user_id or '',
            'stream_slot_acquired': '1' if session.stream_slot_acquired else '0'
        }

        await self.redis.hset(key, mapping=data)
        await self.redis.expire(key, ttl)

    async def _load_session_from_redis(self, session_id: str) -> Optional[StreamingSession]:
        """Load session from Redis."""
        if not self.redis:
            return None

        key = f"arq:stream:{session_id}"
        data = await self.redis.hgetall(key)

        if not data:
            return None

        # Decode bytes to strings
        data = {k.decode(): v.decode() for k, v in data.items()}

        return StreamingSession(
            session_id=session_id,
            file_id=data['file_id'],
            file_path=data['file_path'],
            file_size=int(data['file_size']),
            chunk_size=int(data['chunk_size']),
            total_chunks=int(data['total_chunks']),
            created_at=datetime.fromisoformat(data['created_at']),
            user_id=data.get('user_id') or None,
            stream_slot_acquired=data.get('stream_slot_acquired') == '1'
        )

    async def _update_session_delivery(self, session_id: str, chunk_index: int, checksum: str):
        """Update delivery tracking in Redis."""
        if not self.redis:
            return

        ttl = self.config.session_timeout_minutes * 60
        await self.redis.setex(
            f"arq:stream:{session_id}:chunk:{chunk_index}:checksum",
            ttl,
            checksum
        )
        await self.redis.sadd(f"arq:stream:{session_id}:delivered", chunk_index)
        await self.redis.expire(f"arq:stream:{session_id}:delivered", ttl)

    async def _update_session_acks(self, session_id: str, chunk_indices: List[int]):
        """Update acknowledgment tracking in Redis."""
        if not self.redis:
            return

        ttl = self.config.session_timeout_minutes * 60
        key = f"arq:stream:{session_id}:acked"

        for idx in chunk_indices:
            await self.redis.sadd(key, idx)

        await self.redis.expire(key, ttl)

    async def _delete_session_from_redis(self, session_id: str):
        """Delete session data from Redis."""
        if not self.redis:
            return

        # Delete main session key
        await self.redis.delete(f"arq:stream:{session_id}")
        await self.redis.delete(f"arq:stream:{session_id}:delivered")
        await self.redis.delete(f"arq:stream:{session_id}:acked")

        # Delete chunk checksums
        pattern = f"arq:stream:{session_id}:chunk:*"
        async for key in self.redis.scan_iter(match=pattern):
            await self.redis.delete(key)

    async def _cleanup_expired_sessions(self):
        """Background task to clean up expired sessions."""
        while True:
            try:
                await asyncio.sleep(60)  # Check every minute

                now = datetime.utcnow()
                timeout = timedelta(minutes=self.config.session_timeout_minutes)

                expired = [
                    sid for sid, session in list(self._sessions.items())
                    if now - session.created_at > timeout
                ]

                for session_id in expired:
                    await self.close_session(session_id)
                    logger.info(f"Cleaned up expired session: {session_id[:8]}...")

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in session cleanup: {e}")


# Global instance
arq_streaming_service = ARQStreamingService()
