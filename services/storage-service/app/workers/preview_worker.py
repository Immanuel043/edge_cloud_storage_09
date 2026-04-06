# services/storage-service/app/workers/preview_worker.py
"""
Background Preview Processing Worker

Consumes from 'preview-processing' Kafka topic and generates video previews
in the background without blocking the main API.

Features:
- LIFO priority (newest uploads first via timestamp sorting)
- Reuses existing preview_generator and preview_optimizer
- Caches results in Redis
- Updates status for frontend polling
- Semaphore to limit concurrent FFmpeg processes
"""

import asyncio
import json
import logging
import os
import sys
import signal
from datetime import datetime
from typing import Optional

from aiokafka import AIOKafkaConsumer, TopicPartition
import redis.asyncio as aioredis

# Add parent path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from app.services.preview_generator import preview_generator
from app.services.preview_optimizer import preview_optimizer
from app.services.encryption import encryption_service
from app.database import async_session, get_redis, init_redis
from app.models.database import Object

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Configuration
KAFKA_BOOTSTRAP_SERVERS = os.getenv('KAFKA_BOOTSTRAP_SERVERS', 'kafka:9092')
KAFKA_TOPIC = 'preview-processing'
KAFKA_GROUP_ID = 'preview-processors'
MAX_CONCURRENT_PREVIEWS = int(os.getenv('MAX_CONCURRENT_PREVIEWS', '2'))
PREVIEW_SIZES = ['small', 'medium', 'large']
PREVIEW_CACHE_TTL = 604800  # 7 days for videos


class PreviewWorker:
    """
    Kafka consumer that processes video preview generation requests
    in the background without blocking the main API.
    """

    def __init__(self):
        self.consumer: Optional[AIOKafkaConsumer] = None
        self.redis: Optional[aioredis.Redis] = None
        self.semaphore = asyncio.Semaphore(MAX_CONCURRENT_PREVIEWS)
        self.running = True
        self.pending_tasks: list = []

    async def start(self):
        """Start the preview worker"""
        logger.info(f"🚀 Starting Preview Worker...")
        logger.info(f"   Kafka: {KAFKA_BOOTSTRAP_SERVERS}")
        logger.info(f"   Topic: {KAFKA_TOPIC}")
        logger.info(f"   Max concurrent: {MAX_CONCURRENT_PREVIEWS}")

        # Setup signal handlers for graceful shutdown
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, self._handle_shutdown)

        try:
            # Initialize and connect to Redis
            await init_redis()
            self.redis = await get_redis()
            logger.info("✅ Redis connected")

            # Create Kafka consumer
            self.consumer = AIOKafkaConsumer(
                KAFKA_TOPIC,
                bootstrap_servers=KAFKA_BOOTSTRAP_SERVERS,
                group_id=KAFKA_GROUP_ID,
                auto_offset_reset='earliest',
                enable_auto_commit=True,
                value_deserializer=lambda m: json.loads(m.decode('utf-8')),
                # Fetch multiple messages for LIFO sorting
                max_poll_records=10,
                fetch_max_wait_ms=1000
            )

            await self.consumer.start()
            logger.info("✅ Kafka consumer started")

            # Main processing loop
            await self._process_loop()

        except Exception as e:
            logger.error(f"❌ Worker error: {e}")
            raise
        finally:
            await self._cleanup()

    def _handle_shutdown(self):
        """Handle shutdown signal"""
        logger.info("🛑 Shutdown signal received...")
        self.running = False

    async def _cleanup(self):
        """Cleanup resources"""
        logger.info("🧹 Cleaning up...")

        # Wait for pending tasks
        if self.pending_tasks:
            logger.info(f"   Waiting for {len(self.pending_tasks)} pending tasks...")
            await asyncio.gather(*self.pending_tasks, return_exceptions=True)

        # Stop consumer
        if self.consumer:
            await self.consumer.stop()
            logger.info("   Kafka consumer stopped")

        logger.info("✅ Cleanup complete")

    async def _process_loop(self):
        """Main processing loop with LIFO priority"""
        logger.info("📥 Waiting for preview requests...")

        while self.running:
            try:
                # Fetch batch of messages
                messages = await self.consumer.getmany(timeout_ms=1000, max_records=10)

                if not messages:
                    continue

                # Flatten all messages
                all_msgs = []
                for tp, msgs in messages.items():
                    all_msgs.extend(msgs)

                if not all_msgs:
                    continue

                # Sort by timestamp DESC (LIFO - newest first)
                all_msgs.sort(
                    key=lambda m: m.value.get('timestamp', ''),
                    reverse=True
                )

                logger.info(f"📦 Processing batch of {len(all_msgs)} preview requests (newest first)")

                # Process messages
                for msg in all_msgs:
                    if not self.running:
                        break

                    task = asyncio.create_task(self._process_preview(msg.value))
                    self.pending_tasks.append(task)

                    # Remove completed tasks
                    self.pending_tasks = [t for t in self.pending_tasks if not t.done()]

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"❌ Processing loop error: {e}")
                await asyncio.sleep(1)

    async def _process_preview(self, data: dict):
        """Process a single preview generation request"""
        file_id = data.get('file_id')
        if not file_id:
            logger.warning("⚠️ Missing file_id in message")
            return

        upload_id = data.get('upload_id', '')
        logger.info(f"🎬 Processing preview for file {file_id}...")

        # Distributed lock: prevent duplicate processing of the same file
        lock_key = f"preview:lock:{file_id}"
        acquired = await self.redis.set(lock_key, "1", nx=True, ex=600)
        if not acquired:
            status_raw = await self.redis.get(f"preview:status:{file_id}")
            if status_raw:
                try:
                    info = json.loads(status_raw if isinstance(status_raw, str) else status_raw.decode())
                    if info.get("status") == "ready":
                        logger.info(f"Preview already ready for {file_id}, skipping duplicate")
                        return
                except (json.JSONDecodeError, ValueError):
                    pass
            logger.info(f"Another worker is processing {file_id}, skipping")
            return

        # Acquire chunk hold to prevent dedup from deleting chunks during preview
        from app.utils.chunk_lifecycle import acquire_chunk_hold, release_chunk_hold
        chunk_hold_id = None
        if upload_id:
            try:
                chunk_hold_id = await acquire_chunk_hold(self.redis, upload_id, "preview_worker")
            except Exception as e:
                logger.warning(f"Failed to acquire chunk hold for {upload_id}: {e}")

        # Acquire semaphore to limit concurrent FFmpeg processes
        file_obj = None
        async with self.semaphore:
            try:
                # Update status to 'processing'
                await self._set_status(file_id, 'processing')

                # Get file from database
                async with async_session() as db:
                    from sqlalchemy import select
                    result = await db.execute(
                        select(Object).filter(Object.id == file_id)
                    )
                    file_obj = result.scalar_one_or_none()

                    if not file_obj:
                        logger.warning(f"⚠️ File not found: {file_id}")
                        await self._set_status(file_id, 'failed', 'File not found')
                        # No user_id available, skip notification
                        return

                    # Check for transcoded/optimized MP4 first (avoids re-downloading raw CAS)
                    temp_file_path = None
                    use_transcoded = False

                    mime = (file_obj.mime_type or '').lower()
                    ext = os.path.splitext(file_obj.file_name or '')[1].lower()
                    is_video = mime.startswith('video/') or ext in preview_generator.VIDEO_TYPES

                    if is_video:
                        # Check optimized_path (from video ingestion pipeline)
                        if file_obj.optimized_path and os.path.exists(file_obj.optimized_path):
                            logger.info(f"Using optimized MP4 for preview: {file_obj.file_name} -> {file_obj.optimized_path}")
                            temp_file_path = file_obj.optimized_path
                            use_transcoded = True
                        else:
                            # Check transcoder cache
                            from app.services.video_transcoder import video_transcoder
                            transcoded_path = os.path.join(video_transcoder.OUTPUT_DIR, f"{file_id}.mp4")
                            if os.path.exists(transcoded_path):
                                logger.info(f"Using transcoded MP4 for preview: {file_obj.file_name}")
                                temp_file_path = transcoded_path
                                use_transcoded = True

                    if not use_transcoded:
                        # Download file for preview (can take time - that's OK, we're in background!)
                        logger.info(f"   Downloading file: {file_obj.file_name} ({file_obj.file_size / 1024 / 1024:.1f}MB)")

                        result = await preview_optimizer.download_partial_for_preview(
                            file_obj=file_obj,
                            encryption_service=encryption_service,
                            background=True,
                        )

                        if result.status != 'ok':
                            error_msg = result.error or f"Download failed ({file_obj.file_size / 1024 / 1024:.0f}MB)"
                            logger.warning(f"❌ {error_msg}: {file_id} ({file_obj.file_name})")

                            # If optimization pipeline is active, it will generate thumbnails —
                            # suppress WS notification to avoid false "failed" flash in frontend
                            optimization_active = (
                                hasattr(file_obj, 'video_processing_status')
                                and file_obj.video_processing_status in ('queued', 'processing')
                            )
                            if optimization_active:
                                await self._set_status(file_id, 'failed', error_msg, retryable=True)
                                logger.info(
                                    f"Optimization pipeline active for {file_obj.file_name}, "
                                    f"set failed+retryable (no WS push)"
                                )
                            else:
                                await self._set_status(file_id, 'failed', error_msg, retryable=False)
                                await self._publish_notification(file_id, str(file_obj.user_id), 'failed', error_msg)
                            return

                        temp_file_path = result.temp_file_path
                    try:
                        # Generate previews for all sizes with per-size tracking
                        sizes_cached = 0
                        for size in PREVIEW_SIZES:
                            try:
                                persisted = await self._generate_and_cache_preview(
                                    file_obj, temp_file_path, size
                                )
                                if persisted:
                                    sizes_cached += 1
                            except Exception as e:
                                logger.warning(f"Failed to generate {size} preview: {e}")

                        if sizes_cached > 0:
                            # Verify ALL 3 sizes are actually in Redis
                            all_present = True
                            for check_size in PREVIEW_SIZES:
                                if not await self.redis.exists(f"preview:{file_obj.id}:{check_size}"):
                                    all_present = False
                                    break

                            if all_present:
                                await self._set_status(file_id, 'ready')
                                # Atomic single-notify: only first pipeline to SET NX publishes
                                should_notify = await self.redis.set(
                                    f"preview:notified:{file_id}", "1", nx=True, ex=3600
                                )
                                if should_notify:
                                    await self._publish_notification(file_id, str(file_obj.user_id), 'ready')
                                # Update DB preview columns
                                try:
                                    file_obj.preview_generated_at = datetime.utcnow()
                                    file_obj.preview_content_hash = file_obj.content_hash
                                    await db.commit()
                                except Exception:
                                    logger.warning(f"Failed to update preview columns for {file_id}")
                                logger.info(
                                    f"Preview ready for {file_obj.file_name} "
                                    f"({sizes_cached}/{len(PREVIEW_SIZES)} sizes, notified={bool(should_notify)})"
                                )
                            else:
                                # Partial: some sizes cached but not all confirmed in Redis.
                                # Monotonic guard: don't downgrade if already ready.
                                if not await self._is_already_ready(file_id):
                                    await self._set_status(
                                        file_id, 'failed',
                                        f'Partial preview generation ({sizes_cached}/{len(PREVIEW_SIZES)} sizes)',
                                        retryable=True,
                                    )
                                    logger.warning(
                                        f"Only {sizes_cached}/{len(PREVIEW_SIZES)} sizes confirmed in cache "
                                        f"for {file_obj.file_name}, set failed+retryable (no WS push)"
                                    )
                                else:
                                    logger.info(f"Preview already ready for {file_obj.file_name}, skipping partial downgrade")
                        else:
                            # Total failure (0/3). Monotonic guard: don't downgrade if already ready.
                            if not await self._is_already_ready(file_id):
                                await self._set_status(file_id, 'failed', 'All preview sizes failed to generate')
                                await self._publish_notification(file_id, str(file_obj.user_id), 'failed', 'All preview sizes failed')
                                logger.warning(f"All preview sizes failed for {file_obj.file_name}")
                            else:
                                logger.info(f"Preview already ready for {file_obj.file_name}, skipping failure downgrade")

                    finally:
                        # Cleanup temp file (but never delete transcoded/optimized files)
                        if temp_file_path and not use_transcoded and os.path.exists(temp_file_path):
                            try:
                                os.remove(temp_file_path)
                            except Exception as e:
                                logger.warning(f"Failed to cleanup temp file: {e}")

            except Exception as e:
                logger.error(f"Preview generation failed for {file_id}: {e}")
                # Monotonic guard: don't downgrade ready
                if not await self._is_already_ready(file_id):
                    await self._set_status(file_id, 'failed', str(e)[:200])
                    try:
                        if file_obj:
                            await self._publish_notification(file_id, str(file_obj.user_id), 'failed', str(e)[:200])
                    except Exception:
                        pass
                else:
                    logger.info(f"Preview already ready for {file_id}, skipping exception downgrade")
            finally:
                # Release chunk hold so dedup cleanup can proceed
                if chunk_hold_id and upload_id:
                    try:
                        await release_chunk_hold(self.redis, upload_id, chunk_hold_id)
                    except Exception as e:
                        logger.warning(f"Failed to release chunk hold: {e}")
                try:
                    await self.redis.delete(lock_key)
                except Exception:
                    pass

    async def _is_already_ready(self, file_id: str) -> bool:
        """Check if preview is already marked ready (monotonic-status guard).

        Prevents a late failure from downgrading a ready established by
        another pipeline (e.g. the optimization pipeline)."""
        status_raw = await self.redis.get(f"preview:status:{file_id}")
        if status_raw:
            try:
                info = json.loads(
                    status_raw if isinstance(status_raw, str) else status_raw.decode()
                )
                if info.get('status') == 'ready':
                    return True
            except (json.JSONDecodeError, ValueError):
                pass
        return False

    async def _generate_and_cache_preview(self, file_obj, temp_file_path: str, size: str) -> bool:
        """Generate preview and cache in Redis + disk. Returns True if persisted."""
        from app.services.preview_storage import (
            save_preview_to_disk, should_persist_preview, preview_cache_ttl,
        )

        preview_bytes, content_type = await preview_generator.generate_preview(
            file_path=temp_file_path,
            mime_type=file_obj.mime_type,
            size=size,
            file_name=file_obj.file_name
        )

        source_hash = getattr(file_obj, 'content_hash', None)
        if source_hash:
            fresh = await should_persist_preview(str(file_obj.id), source_hash, self.redis)
            if not fresh:
                logger.info(f"Skipping stale preview write for {file_obj.id}:{size}")
                return False

        # Cache in Redis + disk
        cache_key = f"preview:{file_obj.id}:{size}"
        ttl = preview_cache_ttl(file_obj.mime_type)
        await self.redis.setex(cache_key, ttl, preview_bytes)
        if source_hash:
            save_preview_to_disk(str(file_obj.id), size, preview_bytes, source_hash)
        logger.info(f"Cached preview {size} for {file_obj.id}")
        return True

    async def _set_status(self, file_id: str, status: str, error: str = None, retryable: Optional[bool] = None):
        """Update preview status in Redis, preserving retry_count across transitions."""
        status_key = f"preview:status:{file_id}"
        retry_count = 0

        existing = await self.redis.get(status_key)
        if existing:
            try:
                prev = json.loads(existing if isinstance(existing, str) else existing.decode())
                retry_count = prev.get('retry_count', 0)
            except (json.JSONDecodeError, ValueError):
                pass

        if status == 'failed':
            retry_count += 1

        status_data = {
            'status': status,
            'updated_at': datetime.utcnow().isoformat(),
        }
        if error:
            status_data['error'] = error
        if retry_count > 0:
            status_data['retry_count'] = retry_count
        if retryable is not None:
            status_data['retryable'] = retryable

        await self.redis.setex(
            status_key,
            3600,
            json.dumps(status_data)
        )

    async def _publish_notification(self, file_id: str, user_id: str, status: str, error: str = None):
        """Publish preview status change to Redis Pub/Sub for WebSocket push"""
        try:
            message = {
                'file_id': file_id,
                'user_id': user_id,
                'status': status,
            }
            if error:
                message['error'] = error
            await self.redis.publish('preview_notifications', json.dumps(message))
            logger.info(f"   Published preview notification: file={file_id} status={status}")
        except Exception as e:
            logger.warning(f"   Failed to publish preview notification: {e}")


async def main():
    """Entry point"""
    worker = PreviewWorker()
    await worker.start()


if __name__ == "__main__":
    print("=" * 60)
    print("🎬 Preview Processing Worker")
    print("=" * 60)
    asyncio.run(main())
