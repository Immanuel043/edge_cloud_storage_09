# services/storage-service/app/workers/file_analysis_worker.py
"""
Background File Analysis Worker

Consumes from 'file-analysis' Kafka topic and performs:
- AI-powered auto-tagging (Vision Transformer + NLP)
- OCR text extraction
- Metadata extraction
- Perceptual hash computation (for image similarity)

Features:
- LIFO priority (newest uploads first via timestamp sorting)
- Batch processing for efficiency
- Graceful shutdown handling
"""

import asyncio
import json
import logging
import os
import signal
import sys
from datetime import datetime
from typing import Any, Dict, List, Optional

import redis.asyncio as aioredis
from aiokafka import AIOKafkaConsumer

# Add parent path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from app.config import settings
from app.database import async_session, get_redis, init_redis
from app.models.database import FileHash, FileMetadata, FileOCR, FileTag, Object
from app.services.ai_tagging_service import ai_tagging_service
from app.services.encryption import encryption_service
from app.services.metadata_service import metadata_service
from app.services.ocr_service import ocr_service
from app.services.search_service import search_service
from app.services.similarity_service import similarity_service
from app.services.storage import storage_service
from sqlalchemy import delete, insert, select

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# Configuration
KAFKA_BOOTSTRAP_SERVERS = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092")
KAFKA_TOPIC = "file-analysis"
KAFKA_GROUP_ID = "file-analysis-processors"
MAX_BATCH_SIZE = int(os.getenv("ANALYSIS_BATCH_SIZE", "5"))
PROCESSING_INTERVAL = float(os.getenv("ANALYSIS_PROCESSING_INTERVAL", "2.0"))
MAX_RETRIES = 3


class FileAnalysisWorker:
    """
    Kafka consumer that processes file analysis requests
    in the background without blocking the main API.
    """

    def __init__(self):
        self.consumer: Optional[AIOKafkaConsumer] = None
        self.redis: Optional[aioredis.Redis] = None
        self.running = True
        self.pending_tasks: List = []

    async def start(self):
        """Start the file analysis worker"""
        logger.info(f"Starting File Analysis Worker...")
        logger.info(f"   Kafka: {KAFKA_BOOTSTRAP_SERVERS}")
        logger.info(f"   Topic: {KAFKA_TOPIC}")
        logger.info(f"   Batch size: {MAX_BATCH_SIZE}")

        # Setup signal handlers for graceful shutdown
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, self._handle_shutdown)

        try:
            # Initialize and connect to Redis
            await init_redis()
            self.redis = await get_redis()
            logger.info("Redis connected")

            # Create Kafka consumer
            self.consumer = AIOKafkaConsumer(
                KAFKA_TOPIC,
                bootstrap_servers=KAFKA_BOOTSTRAP_SERVERS,
                group_id=KAFKA_GROUP_ID,
                auto_offset_reset="earliest",
                enable_auto_commit=False,
                value_deserializer=lambda m: json.loads(m.decode("utf-8")),
                max_poll_records=MAX_BATCH_SIZE,
                fetch_max_wait_ms=2000,
            )

            await self.consumer.start()
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
            await asyncio.gather(*self.pending_tasks, return_exceptions=True)

        # Stop consumer
        if self.consumer:
            await self.consumer.stop()
            logger.info("   Kafka consumer stopped")

        logger.info("Cleanup complete")

    async def _process_loop(self):
        """Main processing loop with LIFO priority and batching"""
        logger.info("Waiting for file analysis requests...")

        while self.running:
            try:
                # Fetch batch of messages
                messages = await self.consumer.getmany(
                    timeout_ms=int(PROCESSING_INTERVAL * 1000), max_records=MAX_BATCH_SIZE
                )

                if not messages:
                    continue

                # Flatten all messages
                all_msgs = []
                for tp, msgs in messages.items():
                    all_msgs.extend(msgs)

                if not all_msgs:
                    continue

                # Sort by timestamp DESC (LIFO - newest first)
                all_msgs.sort(key=lambda m: m.value.get("timestamp", ""), reverse=True)

                logger.info(f"Processing batch of {len(all_msgs)} analysis requests (newest first)")

                # Process batch
                for msg in all_msgs:
                    await self._process_file(msg.value)

                # Commit offsets after successful batch processing
                await self.consumer.commit()

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Processing loop error: {e}")
                await asyncio.sleep(2)

    async def _process_file(self, data: Dict[str, Any]):
        """Process a single file for analysis"""
        file_id = data.get("file_id")
        user_id = data.get("user_id")
        file_name = data.get("file_name", "")
        mime_type = data.get("mime_type", "")

        if not file_id:
            logger.warning("Missing file_id in message")
            return

        # Check retry count — skip if exceeded max retries
        retry_key = f"analysis:retry:{file_id}"
        try:
            existing = await self.redis.get(retry_key)
            retry_count = int(existing) if existing else 0
        except Exception:
            retry_count = 0

        if retry_count >= MAX_RETRIES:
            logger.error(f"File {file_id} exceeded max retries ({MAX_RETRIES}), moving to DLQ")
            try:
                await self.redis.setex(
                    f"analysis:dlq:{file_id}",
                    86400 * 7,  # 7-day TTL
                    json.dumps(
                        {
                            **data,
                            "retry_count": retry_count,
                            "failed_at": datetime.utcnow().isoformat(),
                        }
                    ),
                )
            except Exception:
                pass
            return

        logger.info(f"Analyzing file: {file_name} ({file_id})")

        try:
            async with async_session() as db:
                # Verify file exists
                result = await db.execute(select(Object).filter(Object.id == file_id))
                file_obj = result.scalar_one_or_none()

                if not file_obj:
                    logger.warning(f"File not found: {file_id}")
                    return

                # Skip chunked files (too large to load into memory)
                if file_obj.storage_type == "chunked":
                    logger.info(f"Skipping analysis for chunked file {file_id} ({file_name})")
                    # Write terminal Redis status so frontend polling stops immediately
                    try:
                        import json as _json
                        from datetime import datetime as _dt
                        from datetime import timezone as _tz

                        status_data = _json.dumps(
                            {
                                "status": "skipped",
                                "reason": "chunked",
                                "completed_at": _dt.now(_tz.utc).isoformat(),
                            }
                        )
                        await redis.setex(f"analysis:status:{file_id}", 86400, status_data)
                    except Exception as e:
                        logger.warning(f"Failed to write skipped Redis status for {file_id}: {e}")
                    return

                # Decrypt file key and retrieve file data
                try:
                    file_key = encryption_service.decrypt_key(file_obj.encryption_key)
                    file_data = await storage_service.retrieve_file(file_obj, decrypt_key=file_key)
                    if not file_data:
                        logger.warning(f"Could not read file data for {file_id}")
                        return
                except Exception as e:
                    logger.error(f"Error reading file {file_id}: {e}")
                    return

                # 1. Extract metadata
                metadata = None
                try:
                    metadata = await metadata_service.extract_metadata(
                        file_data, mime_type, file_name
                    )
                    if metadata:
                        # Save metadata
                        await db.execute(
                            delete(FileMetadata).where(FileMetadata.file_id == file_id)
                        )
                        await db.execute(
                            insert(FileMetadata).values(
                                file_id=file_id,
                                **{k: v for k, v in metadata.items() if k != "success"},
                            )
                        )
                        logger.debug(f"Saved metadata for {file_id}")
                except Exception as e:
                    logger.error(f"Metadata extraction failed for {file_id}: {e}")

                # 2. OCR if applicable
                ocr_text = None
                if mime_type.startswith("image/") or mime_type == "application/pdf":
                    try:
                        ocr_result = await ocr_service.extract_text(file_data, mime_type)
                        if ocr_result.get("success"):
                            ocr_text = ocr_result["text"]

                            await db.execute(delete(FileOCR).where(FileOCR.file_id == file_id))
                            await db.execute(
                                insert(FileOCR).values(
                                    file_id=file_id,
                                    extracted_text=ocr_text,
                                    word_count=ocr_result.get("word_count", 0),
                                    confidence=int(ocr_result.get("confidence", 0)),
                                    ocr_engine=ocr_result.get("engine", "tesseract"),
                                    languages=ocr_result.get("languages", ["eng"]),
                                    page_count=ocr_result.get("page_count", 1),
                                    extraction_method=ocr_result.get("method", "ocr"),
                                )
                            )

                            # Index OCR text in Elasticsearch
                            try:
                                await search_service.update_file_text(str(file_id), ocr_text)
                            except Exception as e:
                                logger.error(f"Failed to index OCR: {e}")

                            logger.debug(f"Saved OCR for {file_id}")
                    except Exception as e:
                        logger.error(f"OCR failed for {file_id}: {e}")

                # 3. Compute perceptual hashes (for images)
                if mime_type.startswith("image/"):
                    try:
                        hashes = await similarity_service.compute_image_hashes(file_data)
                        if hashes.get("success"):
                            await db.execute(delete(FileHash).where(FileHash.file_id == file_id))
                            await db.execute(
                                insert(FileHash).values(
                                    file_id=file_id,
                                    phash=hashes.get("phash"),
                                    dhash=hashes.get("dhash"),
                                    whash=hashes.get("whash"),
                                    average_hash=hashes.get("average_hash"),
                                    colorhash=hashes.get("colorhash"),
                                )
                            )
                            logger.debug(f"Saved hashes for {file_id}")
                    except Exception as e:
                        logger.error(f"Hash computation failed for {file_id}: {e}")

                # 4. Generate AI tags
                try:
                    tags = await ai_tagging_service.generate_smart_tags(
                        file_data, mime_type, file_name, extracted_text=ocr_text, metadata=metadata
                    )

                    # Save tags (preserve manual tags)
                    await db.execute(
                        delete(FileTag).where(
                            FileTag.file_id == file_id, FileTag.source != "manual"
                        )
                    )
                    for tag_data in tags:
                        try:
                            await db.execute(
                                insert(FileTag).values(
                                    file_id=file_id,
                                    tag=tag_data["tag"],
                                    confidence=int(tag_data["confidence"]),
                                    source=tag_data["source"],
                                )
                            )
                        except:
                            pass  # Ignore duplicates

                    logger.info(f"Generated {len(tags)} tags for {file_name}")
                except Exception as e:
                    logger.error(f"AI tagging failed for {file_id}: {e}")

                await db.commit()

                # 5. Summarization (best-effort, after OCR)
                try:
                    from ..services.summarization_service import summarize_if_eligible

                    await summarize_if_eligible(file_id, db)
                except Exception as e:
                    logger.warning(f"Summarization failed for {file_id}: {e}")

                # 6. Smart naming (best-effort)
                has_name_suggestion = False
                try:
                    from ..services.file_naming_service import suggest_name_if_eligible

                    result = await suggest_name_if_eligible(file_id, db)
                    has_name_suggestion = result is not None
                except Exception as e:
                    logger.warning(f"Name suggestion failed for {file_id}: {e}")

                # Update analysis status in Redis
                await self.redis.setex(
                    f"analysis:status:{file_id}",
                    86400,  # 24 hour TTL
                    json.dumps(
                        {
                            "status": "completed",
                            "completed_at": datetime.utcnow().isoformat(),
                            "has_ocr": ocr_text is not None,
                            "has_metadata": metadata is not None,
                            "tag_count": len(tags) if "tags" in dir() else 0,
                            "has_suggestion": has_name_suggestion,
                        }
                    ),
                )

                logger.info(f"Analysis complete for {file_name}")

                # Clear retry counter on success
                try:
                    await self.redis.delete(retry_key)
                except Exception:
                    pass

        except Exception as e:
            logger.error(f"File analysis failed for {file_id}: {e}", exc_info=True)

            # Increment retry counter
            try:
                await self.redis.setex(retry_key, 3600, str(retry_count + 1))
                await self.redis.setex(
                    f"analysis:status:{file_id}",
                    3600,
                    json.dumps(
                        {
                            "status": "failed",
                            "error": str(e),
                            "retry_count": retry_count + 1,
                            "failed_at": datetime.utcnow().isoformat(),
                        }
                    ),
                )
            except Exception:
                pass


async def main():
    """Entry point"""
    worker = FileAnalysisWorker()
    await worker.start()


if __name__ == "__main__":
    print("=" * 60)
    print("File Analysis Worker (AI Tagging, OCR, Metadata)")
    print("=" * 60)
    asyncio.run(main())
