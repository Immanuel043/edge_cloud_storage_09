# services/storage-service/app/services/background_deduplication.py
"""
Background Deduplication Service
Processes uploaded files asynchronously without blocking upload completion

Uses SmartDeduplicationQueue for priority-based processing with backpressure.
"""

import asyncio
import time
from typing import Dict, Optional
from datetime import datetime
import json
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import aiofiles
import os

from ..models.database import Object, User
from ..services.encryption import encryption_service
from ..services.deduplication_enhanced import enhanced_dedup_service
from ..services.dedup_queue import smart_dedup_queue
from ..database import get_db, get_redis
from ..utils.chunk_lifecycle import wait_for_cleanup_ready
import mimetypes
import logging

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

    async def start(self):
        """Start smart queue and garbage collection"""
        # Start smart queue (replaces old worker)
        await smart_dedup_queue.start()
        logger.info("Smart deduplication queue started")

        if not self.gc_task or self.gc_task.done():
            self.gc_task = asyncio.create_task(self._garbage_collector())
            logger.info("Garbage collection worker started")

    async def stop(self):
        """Stop background workers gracefully"""
        # Stop smart queue
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
        self,
        file_id: str,
        upload_id: str,
        user_id: str,
        session_data: Dict,
        priority: int = 2
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
            "enqueued_at": datetime.utcnow().isoformat()
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
                json.dumps({
                    "status": "queued",
                    "priority": priority,
                    "queue_position": result["queue_position"],
                    "estimated_wait": result["estimated_wait"],
                    "enqueued_at": job["enqueued_at"]
                })
            )
        else:
            logger.warning(
                f"⚠️ Failed to enqueue {session_data['name']}: {result['reason']}"
            )

            # Store rejection in Redis
            redis_client = await get_redis()
            await redis_client.setex(
                f"dedup:job:{file_id}",
                7200,
                json.dumps({
                    "status": "rejected",
                    "reason": result["reason"],
                    "message": result["message"],
                    "rejected_at": datetime.utcnow().isoformat()
                })
            )

        return result

    async def _process_dedup_job(self, job: Dict):
        """Process a single deduplication job"""
        file_id = job["file_id"]
        session = job["session"]
        
        print(f"Processing deduplication: {session['name']} (file_id: {file_id})")
        
        self.active_jobs[file_id] = "processing"
        redis_client = await get_redis()
        
        try:
            await redis_client.setex(
                f"dedup:job:{file_id}",
                7200,
                json.dumps({
                    "status": "processing",
                    "started_at": datetime.utcnow().isoformat()
                })
            )
            
            # Get database session
            async for db in get_db():
                result = await db.execute(
                    select(Object).where(Object.id == file_id)
                )
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
                        'mime_type': mimetypes.guess_type(session["name"])[0],
                        'folder_id': session.get("folder")
                    },
                    encrypt=True,
                    existing_object=file_obj  # Pass existing object to update in-place
                )

                # If dedup was skipped (file too large), just keep the original storage
                if dedup_result is None:
                    print(f"Deduplication skipped for {session['name']} - file too large, keeping original storage")
                    await redis_client.setex(
                        f"dedup:job:{file_id}",
                        7200,
                        json.dumps({
                            "status": "skipped",
                            "reason": "file_too_large",
                            "completed_at": datetime.utcnow().isoformat()
                        })
                    )
                    self.active_jobs.pop(file_id, None)
                    return

                # Update storage usage
                if dedup_result['status'] in ['stored_with_dedup', 'full_duplicate']:
                    actual_saved = dedup_result.get('saved_size', 0)

                    if dedup_result['status'] == 'full_duplicate':
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

                    # Now safe to clean up original storage files (after successful DB commit)
                    await self._cleanup_original_storage(file_obj, session)
                    
                    print(f"Deduplication successful: {session['name']} - Saved {actual_saved/1024/1024:.1f}MB")
                    
                    await redis_client.setex(
                        f"dedup:job:{file_id}",
                        7200,
                        json.dumps({
                            "status": "completed",
                            "completed_at": datetime.utcnow().isoformat(),
                            "saved_size": actual_saved,
                            "dedup_ratio": dedup_result.get('dedup_ratio', 0)
                        })
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
                json.dumps({
                    "status": "failed",
                    "error": str(e),
                    "failed_at": datetime.utcnow().isoformat()
                })
            )
    
    async def _get_file_data(self, file_obj: Object, session: Dict) -> Optional[bytes]:
        """Read and decrypt file data"""
        try:
            file_key = encryption_service.decrypt_key(file_obj.encryption_key)
            storage_strategy = session.get("strategy", "single")
            
            if storage_strategy == "single":
                storage_path = file_obj.object_path
                if not storage_path or not os.path.exists(storage_path):
                    return None
                
                async with aiofiles.open(storage_path, 'rb') as f:
                    encrypted_data = await f.read()
                
                file_data = encryption_service.decrypt_file(encrypted_data, file_key)
                
                if session.get("compress", False):
                    from ..utils.compression import compressor
                    file_data = compressor.decompress(file_data)
                
                return file_data
            
            elif storage_strategy == "chunked":
                chunks_data = []
                upload_id = session["id"]
                
                for i in range(session["chunks"]):
                    chunk_path = session.get("chunk_paths", {}).get(str(i))
                    
                    if not chunk_path:
                        shard = upload_id[:2]
                        chunk_path = f"/app/storage/cache/{shard}/{upload_id}_chunk_{i}.enc"
                    
                    if not os.path.exists(chunk_path):
                        print(f"Chunk {i} not found: {chunk_path}")
                        return None
                    
                    async with aiofiles.open(chunk_path, 'rb') as f:
                        encrypted_chunk = await f.read()
                    
                    decrypted_chunk = encryption_service.decrypt_chunk(encrypted_chunk, file_key, i)
                    
                    if session.get("compress", False):
                        from ..utils.compression import compressor
                        decrypted_chunk = compressor.decompress(decrypted_chunk)
                    
                    chunks_data.append(decrypted_chunk)
                
                return b''.join(chunks_data)
            
            return None
            
        except Exception as e:
            print(f"Error reading file data: {e}")
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
                await wait_for_cleanup_ready(
                    redis_client, upload_id, upload_completed_at
                )

            if storage_strategy == "single" and file_obj.object_path:
                if os.path.exists(file_obj.object_path):
                    os.remove(file_obj.object_path)
                    print(f"Removed original file: {file_obj.object_path}")

            elif storage_strategy == "chunked":
                removed = 0

                for i in range(session.get("chunks", 0)):
                    chunk_path = session.get("chunk_paths", {}).get(str(i))

                    if not chunk_path:
                        shard = upload_id[:2]
                        chunk_path = f"/app/storage/cache/{shard}/{upload_id}_chunk_{i}.enc"

                    if os.path.exists(chunk_path):
                        os.remove(chunk_path)
                        removed += 1

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
                    from ..services.deduplication_old import deduplication_service
                    deleted_count = await deduplication_service.cleanup_unreferenced_blocks(db)
                    print(f"Garbage collection complete: {deleted_count} blocks cleaned")
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