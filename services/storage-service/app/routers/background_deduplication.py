# services/storage-service/app/services/background_deduplication.py
"""
Background Deduplication Service
Processes uploaded files asynchronously without blocking upload completion

Uses SmartDeduplicationQueue for priority-based processing with backpressure.
"""

import asyncio
import json
import logging
import mimetypes
import mmap
import os
import time
from datetime import datetime
from typing import Dict, Optional

import aiofiles
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db, get_redis
from ..models.database import Object, User
from ..services.dedup_queue import smart_dedup_queue
from ..services.deduplication_enhanced import enhanced_dedup_service
from ..services.encryption import encryption_service
from ..utils.chunk_lifecycle import wait_for_cleanup_ready
from ..utils.executors import run_in_heavy_pool

logger = logging.getLogger(__name__)


class BackgroundDeduplicationService:
    """Handles async deduplication of uploaded files"""

    def __init__(self, max_concurrent_dedups: int = 2):
        self.max_concurrent = max_concurrent_dedups
        self.gc_task = None
        self.active_jobs = {}  # Track currently processing jobs

    @property
    def worker_task(self):
        """Alias for gc_task to support health check compatibility"""
        return self.gc_task

    async def start(self, consumer_mode: bool = False):
        """Start the dedup queue.

        Producer mode (api replicas) — initializes the Redis Streams client
        on the singleton so ``enqueue_for_dedup`` can XADD, but does not
        start a consumer loop and does not run garbage collection.

        Consumer mode (storage-worker) — additionally starts the consumer
        loop dispatching to ``_process_dedup_job`` and the periodic GC.
        """
        redis_client = await get_redis()

        if consumer_mode:
            await smart_dedup_queue.start(
                redis_client,
                consumer=True,
                processor=self._process_dedup_job,
            )
            logger.info("Smart deduplication queue started (consumer mode)")
            if not self.gc_task or self.gc_task.done():
                self.gc_task = asyncio.create_task(self._garbage_collector())
                logger.info("Garbage collection worker started")
        else:
            await smart_dedup_queue.start(redis_client, consumer=False)
            logger.info("Smart deduplication queue started (producer mode)")

    async def stop(self):
        """Stop background workers gracefully"""
        await smart_dedup_queue.stop()
        logger.info("Smart deduplication queue stopped")

        if self.gc_task and not self.gc_task.done():
            self.gc_task.cancel()
            try:
                await self.gc_task
            except asyncio.CancelledError:
                pass
            logger.info("Garbage collection worker stopped")

    async def enqueue_for_dedup(
        self, file_id: str, upload_id: str, user_id: str, session_data: Dict, priority: int = 2
    ):
        """
        Add file to smart deduplication queue with priority

        Args:
            file_id: File UUID
            upload_id: Upload session ID
            user_id: User ID
            session_data: Upload session metadata
            priority: 1=high, 2=medium, 3=low (from classification)
        """
        job = {
            "file_id": file_id,
            "upload_id": upload_id,
            "user_id": user_id,
            "session": session_data,
            "enqueued_at": datetime.utcnow().isoformat(),
        }

        # Enqueue with priority and backpressure checks
        result = await smart_dedup_queue.enqueue(job, priority=priority, user_id=user_id)

        if result["success"]:
            logger.info(
                f"📋 Queued for deduplication: {session_data['name']} "
                f"(priority={priority}, position={result['queue_position']})"
            )

            # Store status in Redis
            redis_client = await get_redis()
            await redis_client.setex(
                f"dedup:job:{file_id}",
                7200,
                json.dumps(
                    {
                        "status": "queued",
                        "priority": priority,
                        "queue_position": result["queue_position"],
                        "estimated_wait": result["estimated_wait"],
                        "enqueued_at": job["enqueued_at"],
                    }
                ),
            )
        else:
            logger.warning(f"⚠️ Failed to enqueue {session_data['name']}: {result['reason']}")

            # Store rejection in Redis
            redis_client = await get_redis()
            await redis_client.setex(
                f"dedup:job:{file_id}",
                7200,
                json.dumps(
                    {
                        "status": "rejected",
                        "reason": result["reason"],
                        "message": result["message"],
                        "rejected_at": datetime.utcnow().isoformat(),
                    }
                ),
            )

        return result

    async def _process_dedup_job(self, job: Dict):
        """Process a single deduplication job"""
        file_id = job["file_id"]
        session = job["session"]

        # --- Per-file lock: atomic non-blocking claim ---
        from ..utils.file_locks import get_file_lock

        lock = get_file_lock(file_id)

        if not lock.try_acquire():
            # Another worker (video) is active on this file — defer without blocking
            job["_defer_count"] = job.get("_defer_count", 0) + 1
            logger.info(
                "⏳ Deferring dedup for %s: file locked by another worker " "(attempt %d)",
                file_id,
                job["_defer_count"],
            )
            return "deferred"

        # Lock acquired atomically — do heavy work, release after DB commit
        lock_held = True
        try:
            print(f"Processing deduplication: {session['name']} (file_id: {file_id})")

            self.active_jobs[file_id] = "processing"
            redis_client = await get_redis()

            try:
                await redis_client.setex(
                    f"dedup:job:{file_id}",
                    7200,
                    json.dumps(
                        {"status": "processing", "started_at": datetime.utcnow().isoformat()}
                    ),
                )

                # Get database session
                async for db in get_db():
                    result = await db.execute(select(Object).where(Object.id == file_id))
                    file_obj = result.scalar_one_or_none()

                    if not file_obj:
                        print(f"File not found: {file_id}")
                        return

                    # Read and decrypt original file data
                    file_data = await self._get_file_data(file_obj, session)

                    if not file_data:
                        print(f"Could not read file data for {file_id}")
                        return

                    # Perform deduplication - pass existing object to update in-place
                    dedup_result = await enhanced_dedup_service.store_deduplicated_file(
                        file_data=file_data,
                        file_name=session["name"],
                        user_id=job["user_id"],
                        db=db,
                        metadata={
                            "mime_type": mimetypes.guess_type(session["name"])[0],
                            "folder_id": session.get("folder"),
                        },
                        encrypt=True,
                        existing_object=file_obj,  # Pass existing object to update in-place
                    )

                    # If dedup was skipped (file too large), just keep the original storage
                    if dedup_result is None:
                        print(
                            f"Deduplication skipped for {session['name']} - file too large, keeping original storage"
                        )
                        await redis_client.setex(
                            f"dedup:job:{file_id}",
                            7200,
                            json.dumps(
                                {
                                    "status": "skipped",
                                    "reason": "file_too_large",
                                    "completed_at": datetime.utcnow().isoformat(),
                                }
                            ),
                        )
                        self.active_jobs.pop(file_id, None)
                        return

                    # Update storage usage
                    if dedup_result["status"] in ["stored_with_dedup", "full_duplicate"]:
                        actual_saved = dedup_result.get("saved_size", 0)

                        if dedup_result["status"] == "full_duplicate":
                            actual_saved = session["size"]

                        # No need to delete old object - it was updated in-place
                        # This preserves the file_id so downloads continue to work

                        # Update user storage
                        user_result = await db.execute(
                            select(User).where(User.id == job["user_id"])
                        )
                        user = user_result.scalar_one_or_none()

                        if user:
                            # Adjust storage used (subtract saved amount)
                            user.storage_used = max(0, (user.storage_used or 0) - actual_saved)

                        # CRITICAL: Commit BEFORE cleanup to prevent orphaned files
                        await db.commit()

                        # Release lock early — DB committed with new CAS paths,
                        # video will see them after db_session.refresh(file_obj).
                        # Cleanup only removes old files and doesn't need the lock.
                        lock.release()
                        lock_held = False

                        # Fire cleanup as background task — grace period wait
                        # (up to 5 min) must not block the serial dedup queue.
                        asyncio.create_task(self._cleanup_original_storage(file_obj, session))

                        print(
                            f"Deduplication successful: {session['name']} - Saved {actual_saved/1024/1024:.1f}MB"
                        )

                        await redis_client.setex(
                            f"dedup:job:{file_id}",
                            7200,
                            json.dumps(
                                {
                                    "status": "completed",
                                    "completed_at": datetime.utcnow().isoformat(),
                                    "saved_size": actual_saved,
                                    "dedup_ratio": dedup_result.get("dedup_ratio", 0),
                                }
                            ),
                        )

                    break

                self.active_jobs.pop(file_id, None)

            except Exception as e:
                print(f"Deduplication failed for {file_id}: {e}")
                import traceback

                traceback.print_exc()

                self.active_jobs[file_id] = "failed"
                await redis_client.setex(
                    f"dedup:job:{file_id}",
                    7200,
                    json.dumps(
                        {
                            "status": "failed",
                            "error": str(e),
                            "failed_at": datetime.utcnow().isoformat(),
                        }
                    ),
                )
        finally:
            if lock_held:
                lock.release()

    async def _get_file_data(self, file_obj: Object, session: Dict) -> Optional[bytes]:
        """Read and decrypt file data.

        Prefers the Rust data plane for decryption when available (avoids
        blocking the event loop with Python AES-GCM).  Falls back to the
        thread-pool-offloaded Python path on any Rust error.
        """
        try:
            file_key = await run_in_heavy_pool(
                encryption_service.decrypt_key,
                file_obj.encryption_key,
            )
            storage_strategy = session.get("strategy", "single")
            compress = session.get("compress", False)

            # --- Try Rust bulk-decrypt first ---
            rust_result = await self._get_file_data_rust(
                file_obj,
                session,
                file_key,
                storage_strategy,
                compress,
            )
            if rust_result is not None:
                return rust_result

            # --- Python fallback ---
            if storage_strategy == "single":
                storage_path = file_obj.object_path
                if not storage_path:
                    return None
                exists = await asyncio.to_thread(os.path.exists, storage_path)
                if not exists:
                    return None

                async with aiofiles.open(storage_path, "rb") as f:
                    encrypted_data = await f.read()

                def _decrypt_single(enc, key, do_decompress):
                    data = encryption_service.decrypt_file(enc, key)
                    if do_decompress:
                        from ..utils.compression import decompressor

                        data = decompressor.decompress(data)
                    return data

                return await run_in_heavy_pool(
                    _decrypt_single,
                    encrypted_data,
                    file_key,
                    compress,
                )

            elif storage_strategy == "chunked":
                upload_id = session["id"]
                num_chunks = session["chunks"]

                # Resolve and validate all chunk paths first
                chunk_paths = []
                for i in range(num_chunks):
                    chunk_path = session.get("chunk_paths", {}).get(str(i))
                    if not chunk_path:
                        shard = upload_id[:2]
                        chunk_path = f"/app/storage/cache/{shard}/{upload_id}_chunk_{i}.enc"
                    chunk_paths.append(chunk_path)

                def _check_paths(paths):
                    for p in paths:
                        if not os.path.exists(p):
                            return p
                    return None

                missing = await asyncio.to_thread(_check_paths, chunk_paths)
                if missing is not None:
                    print(f"Chunk not found: {missing}")
                    return None

                # Read all encrypted chunks via async I/O
                encrypted_chunks = []
                for chunk_path in chunk_paths:
                    async with aiofiles.open(chunk_path, "rb") as f:
                        encrypted_chunks.append(await f.read())

                # Decrypt + decompress all chunks in one heavy pool call
                def _decrypt_all(enc_chunks, key, do_decompress):
                    from ..utils.compression import decompressor

                    parts = []
                    for idx, enc in enumerate(enc_chunks):
                        dec = encryption_service.decrypt_chunk(enc, key, idx)
                        if do_decompress:
                            dec = decompressor.decompress(dec)
                        parts.append(dec)
                    return b"".join(parts)

                return await run_in_heavy_pool(
                    _decrypt_all,
                    encrypted_chunks,
                    file_key,
                    compress,
                )

            return None

        except Exception as e:
            print(f"Error reading file data: {e}")
            return None

    async def _get_file_data_rust(
        self,
        file_obj: Object,
        session: Dict,
        file_key: bytes,
        storage_strategy: str,
        compress: bool,
    ) -> Optional[bytes]:
        """Attempt decryption via Rust /bulk-decrypt. Returns None to signal fallback."""
        from ..config import settings

        if not getattr(settings, "RUST_DATAPLANE_ENABLED", False):
            return None

        try:
            from ..services.rust_dataplane_client import get_rust_client

            rust_client = get_rust_client()
            if not await rust_client.is_available():
                return None

            chunk_size = int(os.getenv("CHUNK_SIZE", str(32 * 1024 * 1024)))

            if storage_strategy == "single":
                storage_path = file_obj.object_path
                if not storage_path:
                    return None
                exists = await asyncio.to_thread(os.path.exists, storage_path)
                if not exists:
                    return None
                chunks = [{"index": 0, "path": storage_path}]
            elif storage_strategy == "chunked":
                upload_id = session["id"]
                num_chunks = session["chunks"]
                chunks = []
                for i in range(num_chunks):
                    chunk_path = session.get("chunk_paths", {}).get(str(i))
                    if not chunk_path:
                        shard = upload_id[:2]
                        chunk_path = f"/app/storage/cache/{shard}/{upload_id}_chunk_{i}.enc"
                    chunks.append({"index": i, "path": chunk_path})
            else:
                return None

            DECRYPT_SUB_BATCH_BYTES = 96 * 1024 * 1024  # ~96MB per Rust call

            # Partition chunks into sub-batches by cumulative byte size
            total_bytes = sum(c.get("size", chunk_size) for c in chunks)

            if total_bytes <= DECRYPT_SUB_BATCH_BYTES:
                # Small file: single call (unchanged)
                plaintext = await rust_client.bulk_decrypt_chunks(
                    chunks=chunks,
                    file_key=file_key,
                    was_compressed=compress,
                    chunk_size=chunk_size,
                )
                batch_count = 1
            else:
                # Large file: sub-batch by byte budget
                t_alloc = time.monotonic()
                plaintext = mmap.mmap(-1, file_obj.file_size)
                alloc_ms = (time.monotonic() - t_alloc) * 1000
                if alloc_ms > 100:
                    logger.warning(
                        "Dedup buffer alloc %dMB took %.0fms",
                        file_obj.file_size >> 20,
                        alloc_ms,
                    )
                view = memoryview(plaintext)
                write_offset = 0
                sub_batch = []
                sub_bytes = 0
                batch_num = 0

                COPY_SLICE = (
                    1_048_576  # 1MB — small enough to keep GIL hold <15ms under Docker page faults
                )

                async def _flush(batch, batch_idx):
                    nonlocal write_offset, view, plaintext
                    t0 = time.monotonic()
                    try:
                        bytes_written = await rust_client.bulk_decrypt_into(
                            chunks=batch,
                            file_key=file_key,
                            was_compressed=compress,
                            chunk_size=chunk_size,
                            target=view,
                            target_offset=write_offset,
                        )
                        elapsed = time.monotonic() - t0
                        logger.info(
                            "Dedup sub-decrypt %d: chunks=%d bytes=%d elapsed=%.1fs (direct)",
                            batch_idx,
                            len(batch),
                            bytes_written,
                            elapsed,
                        )
                        write_offset += bytes_written
                    except ValueError as exc:
                        # Pre-flight rejected (header missing or overflow)
                        # No bytes written to mmap — safe to fall back
                        elapsed = time.monotonic() - t0
                        logger.error(
                            "Dedup sub-decrypt %d rejected after %.1fs: %s — "
                            "falling back to bulk_decrypt_chunks",
                            batch_idx,
                            elapsed,
                            exc,
                        )
                        part = await rust_client.bulk_decrypt_chunks(
                            chunks=batch,
                            file_key=file_key,
                            was_compressed=compress,
                            chunk_size=chunk_size,
                        )
                        n = len(part)
                        if write_offset + n > len(plaintext):
                            # Overflow — convert mmap to bytearray for extend
                            # CRITICAL: release view BEFORE closing mmap
                            view.release()
                            old_buf = plaintext
                            plaintext = bytearray(old_buf[:write_offset])
                            if isinstance(old_buf, mmap.mmap):
                                old_buf.close()
                            part_mv = memoryview(part)
                            fb_pos = 0
                            while fb_pos < n:
                                fb_end = min(fb_pos + COPY_SLICE, n)
                                plaintext.extend(part_mv[fb_pos:fb_end])
                                fb_pos = fb_end
                                if fb_pos < n:
                                    await asyncio.sleep(0)
                            part_mv.release()
                            del part
                            write_offset = len(plaintext)
                            view = memoryview(plaintext)
                        else:
                            # Fits in existing buffer — copy via slices
                            part_mv = memoryview(part)
                            copied = 0
                            while copied < n:
                                end = min(copied + COPY_SLICE, n)
                                view[write_offset + copied : write_offset + end] = part_mv[
                                    copied:end
                                ]
                                copied = end
                                if copied < n:
                                    await asyncio.sleep(0)
                            part_mv.release()
                            del part
                            write_offset += n
                    await asyncio.sleep(0)  # yield between sub-batches

                await asyncio.sleep(0)  # yield after alloc before first decrypt
                logger.info(
                    "Dedup decrypt setup complete: chunks=%d alloc=%dMB",
                    len(chunks),
                    file_obj.file_size >> 20,
                )

                for c in chunks:
                    c_size = c.get("size", chunk_size)
                    sub_batch.append(c)
                    sub_bytes += c_size
                    if sub_bytes >= DECRYPT_SUB_BATCH_BYTES:
                        batch_num += 1
                        await _flush(sub_batch, batch_num)
                        sub_batch = []
                        sub_bytes = 0

                if sub_batch:
                    batch_num += 1
                    await _flush(sub_batch, batch_num)

                view.release()
                # Trim if actual plaintext is smaller than allocated size
                if write_offset < len(plaintext):
                    logger.error(
                        "Dedup trim needed: write_offset=%d < alloc=%d — "
                        "file_size metadata is inconsistent",
                        write_offset,
                        len(plaintext),
                    )
                    trimmed = bytearray(plaintext[:write_offset])
                    if isinstance(plaintext, mmap.mmap):
                        plaintext.close()
                    plaintext = trimmed

                batch_count = batch_num

            logger.info(
                "Dedup decrypt via Rust bulk-decrypt: file=%s size=%d chunks=%d batches=%d",
                file_obj.id,
                len(plaintext),
                len(chunks),
                batch_count,
            )
            return plaintext

        except Exception as e:
            logger.warning(
                "Rust bulk-decrypt failed for %s, falling back to Python: %s",
                file_obj.id,
                e,
            )
            return None

    async def _cleanup_original_storage(self, file_obj: Object, session: Dict):
        """Remove original encrypted files after deduplication.

        Waits for any active chunk holds (from preview workers) to be released
        before deleting, preventing race-condition data loss.
        """
        try:
            storage_strategy = session.get("strategy", "single")
            upload_id = session.get("id", "")
            upload_completed_at = session.get("_upload_completed_at", 0)

            # Wait for preview workers to finish reading these chunks
            if upload_id and upload_completed_at:
                redis_client = await get_redis()
                await wait_for_cleanup_ready(redis_client, upload_id, upload_completed_at)

            if storage_strategy == "single" and file_obj.object_path:

                def _remove_single(path):
                    if os.path.exists(path):
                        os.remove(path)
                        return True
                    return False

                if await asyncio.to_thread(_remove_single, file_obj.object_path):
                    print(f"Removed original file: {file_obj.object_path}")

            elif storage_strategy == "chunked":
                paths_to_remove = []
                for i in range(session.get("chunks", 0)):
                    chunk_path = session.get("chunk_paths", {}).get(str(i))
                    if not chunk_path:
                        shard = upload_id[:2]
                        chunk_path = f"/app/storage/cache/{shard}/{upload_id}_chunk_{i}.enc"
                    paths_to_remove.append(chunk_path)

                def _remove_chunks(paths):
                    count = 0
                    for p in paths:
                        if os.path.exists(p):
                            os.remove(p)
                            count += 1
                    return count

                removed = await asyncio.to_thread(_remove_chunks, paths_to_remove)
                if removed > 0:
                    print(f"Removed {removed} chunks")

        except Exception as e:
            print(f"Cleanup error: {e}")

    async def get_job_status(self, file_id: str) -> Optional[Dict]:
        """Get status of a deduplication job"""
        redis_client = await get_redis()
        status_data = await redis_client.get(f"dedup:job:{file_id}")

        if status_data:
            return json.loads(status_data)

        return None

    async def _garbage_collector(self):
        """Periodic garbage collection of unreferenced blocks"""
        print("Garbage collection worker running...")

        while True:
            try:
                # Run GC every 30 minutes
                await asyncio.sleep(1800)

                print("Running garbage collection...")

                async for db in get_db():
                    from ..services.deduplication_enhanced import enhanced_dedup_service

                    result = await enhanced_dedup_service.garbage_collect(db)
                    print(f"Garbage collection: {result['deleted_blocks']} orphan blocks cleaned")
                    break

            except asyncio.CancelledError:
                print("Garbage collector cancelled")
                break
            except Exception as e:
                print(f"Garbage collection error: {e}")
                import traceback

                traceback.print_exc()
                await asyncio.sleep(60)  # Wait 1 minute before retry


# Global instance
background_dedup_service = BackgroundDeduplicationService(max_concurrent_dedups=2)
