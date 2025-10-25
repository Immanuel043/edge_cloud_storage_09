# services/storage-service/app/services/background_deduplication.py
"""
Background Deduplication Service
Processes uploaded files asynchronously without blocking upload completion
"""

import asyncio
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
from ..database import get_db, get_redis
import mimetypes


class BackgroundDeduplicationService:
    """Handles async deduplication of uploaded files"""

    def __init__(self, max_concurrent_dedups: int = 2):
        self.max_concurrent = max_concurrent_dedups
        self.semaphore = asyncio.Semaphore(max_concurrent_dedups)
        self.active_jobs = {}
        self.queue = asyncio.Queue()
        self.worker_task = None
        self.gc_task = None

    async def start(self):
        """Start background worker and garbage collection"""
        if not self.worker_task or self.worker_task.done():
            self.worker_task = asyncio.create_task(self._worker())
            print("Background deduplication worker started")

        if not self.gc_task or self.gc_task.done():
            self.gc_task = asyncio.create_task(self._garbage_collector())
            print("Garbage collection worker started")

    async def stop(self):
        """Stop background worker gracefully"""
        if self.worker_task and not self.worker_task.done():
            self.worker_task.cancel()
            try:
                await self.worker_task
            except asyncio.CancelledError:
                pass
            print("Background deduplication worker stopped")

        if self.gc_task and not self.gc_task.done():
            self.gc_task.cancel()
            try:
                await self.gc_task
            except asyncio.CancelledError:
                pass
            print("Garbage collection worker stopped")
    
    async def enqueue_for_dedup(
        self,
        file_id: str,
        upload_id: str,
        user_id: str,
        session_data: Dict
    ):
        """Add file to deduplication queue"""
        job = {
            "file_id": file_id,
            "upload_id": upload_id,
            "user_id": user_id,
            "session": session_data,
            "enqueued_at": datetime.utcnow().isoformat()
        }
        
        await self.queue.put(job)
        self.active_jobs[file_id] = "queued"
        
        print(f"Queued for deduplication: {session_data['name']} (file_id: {file_id})")
        
        redis_client = await get_redis()
        await redis_client.setex(
            f"dedup:job:{file_id}",
            7200,
            json.dumps({
                "status": "queued",
                "enqueued_at": job["enqueued_at"]
            })
        )
    
    async def _worker(self):
        """Background worker that processes dedup queue"""
        print("Background deduplication worker running...")
        
        while True:
            try:
                job = await self.queue.get()
                
                async with self.semaphore:
                    await self._process_dedup_job(job)
                
                self.queue.task_done()
                
            except asyncio.CancelledError:
                print("Worker cancelled")
                break
            except Exception as e:
                print(f"Worker error: {e}")
                await asyncio.sleep(1)
    
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
        """Remove original encrypted files after deduplication"""
        try:
            storage_strategy = session.get("strategy", "single")
            
            if storage_strategy == "single" and file_obj.object_path:
                if os.path.exists(file_obj.object_path):
                    os.remove(file_obj.object_path)
                    print(f"Removed original file: {file_obj.object_path}")
            
            elif storage_strategy == "chunked":
                upload_id = session["id"]
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
                    from ..services.deduplication import deduplication_service
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