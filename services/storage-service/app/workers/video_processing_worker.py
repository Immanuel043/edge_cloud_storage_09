# services/storage-service/app/workers/video_processing_worker.py
"""
Background Video Processing Worker

Consumes from 'video-processing' Kafka topic and runs proactive video optimization
in the background without blocking uploads.

This worker implements the "write-time" optimization strategy:
- Videos are processed immediately after upload (not on playback)
- Ensures zero-latency playback for end users

Features:
- LIFO priority (newest uploads processed first)
- Integrates with VideoIngestionService for processing
- Semaphore-limited concurrent FFmpeg processes
- Database status updates for frontend polling
- Graceful shutdown handling
"""

import asyncio
import json
import logging
import os
import signal
import sys
from datetime import datetime
from typing import Optional

import redis.asyncio as aioredis
from aiokafka import AIOKafkaConsumer

# Add parent path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from app.database import async_session, get_redis, init_redis
from app.models.database import Object, User
from app.services.encryption import encryption_service
from app.services.video_ingestion_service import video_ingestion_service
from app.workers._kafka_dlq import dlq_producer

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# Configuration
KAFKA_BOOTSTRAP_SERVERS = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092")
KAFKA_TOPIC = "video-processing"
KAFKA_GROUP_ID = "video-processors"
MAX_CONCURRENT_TRANSCODES = int(os.getenv("MAX_CONCURRENT_TRANSCODES", "2"))


class VideoProcessingWorker:
    """
    Kafka consumer that processes video optimization requests
    in the background without blocking uploads.

    Pipeline:
    1. Consumes message from 'video-processing' topic
    2. Fetches file and user from database
    3. Calls VideoIngestionService.process_video()
    4. Status updates visible via API for frontend polling
    """

    def __init__(self):
        self.consumer: Optional[AIOKafkaConsumer] = None
        self.redis: Optional[aioredis.Redis] = None
        self.semaphore = asyncio.Semaphore(MAX_CONCURRENT_TRANSCODES)
        self.running = True
        self.pending_tasks: list = []
        self.processed_count = 0
        self.failed_count = 0

    async def start(self):
        """Start the video processing worker"""
        logger.info("=" * 60)
        logger.info("Starting Video Processing Worker...")
        logger.info("=" * 60)
        logger.info(f"   Kafka: {KAFKA_BOOTSTRAP_SERVERS}")
        logger.info(f"   Topic: {KAFKA_TOPIC}")
        logger.info(f"   Max concurrent transcodes: {MAX_CONCURRENT_TRANSCODES}")

        # Setup signal handlers for graceful shutdown
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, self._handle_shutdown)

        try:
            # Initialize and connect to Redis
            await init_redis()
            self.redis = await get_redis()
            logger.info("Redis connected")

            # Create Kafka consumer.
            # Manual commit: we only advance the offset after the batch's
            # tasks complete (success or DLQ). The auto-commit behaviour
            # previously lost in-flight transcodes on worker crash.
            self.consumer = AIOKafkaConsumer(
                KAFKA_TOPIC,
                bootstrap_servers=KAFKA_BOOTSTRAP_SERVERS,
                group_id=KAFKA_GROUP_ID,
                auto_offset_reset="earliest",
                enable_auto_commit=False,
                value_deserializer=lambda m: json.loads(m.decode("utf-8")),
                # Fetch multiple messages for LIFO sorting
                max_poll_records=10,
                fetch_max_wait_ms=1000,
            )

            await self.consumer.start()
            await dlq_producer.start()
            logger.info("Kafka consumer started")

            # Main processing loop
            await self._process_loop()

        except Exception as e:
            logger.error(f"Worker error: {e}")
            raise
        finally:
            await self._cleanup()

    def _handle_shutdown(self):
        """Handle shutdown signal"""
        logger.info("Shutdown signal received...")
        self.running = False

    async def _cleanup(self):
        """Cleanup resources"""
        logger.info("Cleaning up...")

        # Wait for pending tasks
        if self.pending_tasks:
            logger.info(f"   Waiting for {len(self.pending_tasks)} pending tasks...")
            # Give tasks up to 60 seconds to complete
            try:
                await asyncio.wait_for(
                    asyncio.gather(*self.pending_tasks, return_exceptions=True), timeout=60
                )
            except asyncio.TimeoutError:
                logger.warning("   Some tasks did not complete within timeout")

        # Stop consumer
        if self.consumer:
            await self.consumer.stop()
            logger.info("   Kafka consumer stopped")

        # Flush DLQ producer
        await dlq_producer.stop()

        logger.info(
            f"Cleanup complete. Processed: {self.processed_count}, Failed: {self.failed_count}"
        )

    async def _process_loop(self):
        """Main processing loop with LIFO priority"""
        logger.info("Waiting for video processing requests...")

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

                # Sort by priority (lower number = higher priority) then by timestamp DESC
                # This ensures small videos are processed first, then newest within same priority
                all_msgs.sort(
                    key=lambda m: (
                        m.value.get("priority", 5),  # Lower priority first
                        -self._parse_timestamp(
                            m.value.get("timestamp", "")
                        ),  # Newest first within priority
                    )
                )

                logger.info(f"Processing batch of {len(all_msgs)} video requests")

                # Dispatch the batch concurrently and AWAIT before
                # committing. Parallelism inside the batch is still
                # bounded by the ``MAX_CONCURRENT_TRANSCODES`` semaphore.
                tasks = [
                    asyncio.create_task(self._process_video_wrapped(msg))
                    for msg in all_msgs
                    if self.running
                ]
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)

                # Commit offsets for the whole batch — DLQ handles the
                # failure path, so commit is unconditional.
                await self.consumer.commit()

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Processing loop error: {e}")
                await asyncio.sleep(1)

    async def _process_video_wrapped(self, msg):
        """Wrap per-message transcode so exceptions route to DLQ."""
        try:
            await self._process_video(msg.value)
        except Exception as e:
            logger.exception("video_processing_worker: failed offset %s", msg.offset)
            await dlq_producer.send_failed_message(msg, error=e, worker="video-processing-worker")

    def _parse_timestamp(self, timestamp_str: str) -> float:
        """Parse ISO timestamp to float for sorting"""
        try:
            dt = datetime.fromisoformat(timestamp_str.replace("Z", "+00:00"))
            return dt.timestamp()
        except (ValueError, AttributeError):
            return 0.0

    async def _process_video(self, data: dict):
        """Process a single video optimization request"""
        file_id = data.get("file_id")
        user_id = data.get("user_id")

        if not file_id or not user_id:
            logger.warning("Missing file_id or user_id in message")
            return

        file_name = data.get("file_name", "unknown")
        file_size_mb = data.get("file_size", 0) / (1024 * 1024)
        priority = data.get("priority", 5)

        logger.info(
            f"Processing video: {file_name} ({file_size_mb:.1f}MB) "
            f"[priority={priority}, file_id={file_id}]"
        )

        # Acquire semaphore to limit concurrent FFmpeg processes
        async with self.semaphore:
            try:
                # Get file and user from database
                async with async_session() as db:
                    from sqlalchemy import select

                    # Fetch file object
                    result = await db.execute(select(Object).filter(Object.id == file_id))
                    file_obj = result.scalar_one_or_none()

                    if not file_obj:
                        logger.warning(f"File not found: {file_id}")
                        return

                    # Fetch user for optimization preferences
                    user_result = await db.execute(select(User).filter(User.id == user_id))
                    user = user_result.scalar_one_or_none()

                    if not user:
                        logger.warning(f"User not found: {user_id}")
                        return

                    # Note: ZK encrypted files are handled by the separate ZK service
                    # and will never appear in this storage service

                    # Fetch user's plan features for video optimization gating
                    from shared_billing import BillingService

                    try:
                        billing = BillingService(db, service_type="normal")
                        subscription = await billing.get_user_subscription(
                            user.id, include_plan=True
                        )
                        plan_features = subscription.plan.features or {}
                    except Exception:
                        plan_features = {}

                    # Check if already processed (in case of duplicate messages).
                    # 'rejected' is also terminal: re-running would just hit the
                    # reject branch again and redo the poster-thumbnail attempt.
                    if file_obj.video_processing_status in ("ready", "skipped", "rejected"):
                        logger.info(
                            f"Video already processed ({file_obj.video_processing_status}): {file_name}"
                        )
                        return

                    # Process the video using VideoIngestionService
                    result = await video_ingestion_service.process_video(
                        file_obj=file_obj,
                        user=user,
                        encryption_service=encryption_service,
                        db_session=db,
                        plan_features=plan_features,
                    )

                    if result["success"]:
                        self.processed_count += 1
                        logger.info(
                            f"Video optimization complete: {file_name} "
                            f"[action={result['action']}, duration={result.get('duration_seconds', 0):.1f}s]"
                        )
                    elif result.get("action") == "rejected":
                        # Transcode rejected by size/duration policy is expected,
                        # not an error. The poster-frame thumbnail path may still
                        # have succeeded independently.
                        logger.info(
                            f"Video transcode rejected by policy: {file_name} "
                            f"[reason={result.get('error', 'policy')}]"
                        )
                    else:
                        self.failed_count += 1
                        logger.error(
                            f"Video optimization failed: {file_name} "
                            f"[error={result.get('error', 'unknown')}]"
                        )

            except Exception as e:
                self.failed_count += 1
                logger.exception(f"Error processing video {file_id}: {e}")

                # Update database status to failed
                try:
                    async with async_session() as db:
                        from sqlalchemy import select

                        result = await db.execute(select(Object).filter(Object.id == file_id))
                        file_obj = result.scalar_one_or_none()
                        if file_obj:
                            file_obj.video_processing_status = "failed"
                            file_obj.video_processing_error = str(e)[:500]
                            await db.commit()
                except Exception as db_error:
                    logger.error(f"Failed to update status after error: {db_error}")


async def main():
    """Entry point"""
    worker = VideoProcessingWorker()
    await worker.start()


if __name__ == "__main__":
    print("=" * 60)
    print("Video Processing Worker (Proactive Optimization Pipeline)")
    print("=" * 60)
    asyncio.run(main())
