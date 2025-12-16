# services/storage-service/app/workers/embedding_worker.py
"""
Background Embedding Processing Worker

Consumes from 'embedding-processing' Kafka topic and generates semantic
embeddings in the background without blocking the main API.

Features:
- LIFO priority (newest uploads first via timestamp sorting)
- Uses sentence-transformers all-MiniLM-L6-v2 model
- Stores embeddings in PostgreSQL and caches in Redis
- Batch processing for efficiency
- Graceful shutdown handling
"""

import asyncio
import json
import logging
import os
import sys
import signal
from datetime import datetime
from typing import Optional, List, Dict, Any

from aiokafka import AIOKafkaConsumer
import redis.asyncio as aioredis

# Add parent path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from app.services.embedding_service import embedding_service
from app.database import async_session, get_redis, init_redis
from app.models.database import Object, FileEmbedding
from app.config import settings

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Configuration
KAFKA_BOOTSTRAP_SERVERS = os.getenv('KAFKA_BOOTSTRAP_SERVERS', 'kafka:9092')
KAFKA_TOPIC = 'embedding-processing'
KAFKA_GROUP_ID = 'embedding-processors'
MAX_BATCH_SIZE = int(os.getenv('EMBEDDING_BATCH_SIZE', '10'))
PROCESSING_INTERVAL = float(os.getenv('EMBEDDING_PROCESSING_INTERVAL', '1.0'))


class EmbeddingWorker:
    """
    Kafka consumer that processes embedding generation requests
    in the background without blocking the main API.
    """

    def __init__(self):
        self.consumer: Optional[AIOKafkaConsumer] = None
        self.redis: Optional[aioredis.Redis] = None
        self.running = True
        self.pending_tasks: List = []
        self.model_loaded = False

    async def start(self):
        """Start the embedding worker"""
        logger.info(f"Starting Embedding Worker...")
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
            embedding_service.set_redis(self.redis)
            logger.info("Redis connected")

            # Pre-load the embedding model (takes a few seconds)
            logger.info("Loading embedding model (this may take a moment)...")
            from app.services.embedding_service import get_embedding_model
            model = await get_embedding_model()
            if model:
                self.model_loaded = True
                logger.info("Embedding model loaded successfully")
            else:
                logger.error("Failed to load embedding model")
                return

            # Create Kafka consumer
            self.consumer = AIOKafkaConsumer(
                KAFKA_TOPIC,
                bootstrap_servers=KAFKA_BOOTSTRAP_SERVERS,
                group_id=KAFKA_GROUP_ID,
                auto_offset_reset='earliest',
                enable_auto_commit=True,
                value_deserializer=lambda m: json.loads(m.decode('utf-8')),
                max_poll_records=MAX_BATCH_SIZE,
                fetch_max_wait_ms=1000
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
        logger.info("Waiting for embedding requests...")

        while self.running:
            try:
                # Fetch batch of messages
                messages = await self.consumer.getmany(
                    timeout_ms=int(PROCESSING_INTERVAL * 1000),
                    max_records=MAX_BATCH_SIZE
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
                all_msgs.sort(
                    key=lambda m: m.value.get('timestamp', ''),
                    reverse=True
                )

                logger.info(f"Processing batch of {len(all_msgs)} embedding requests (newest first)")

                # Process batch
                await self._process_batch([m.value for m in all_msgs])

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Processing loop error: {e}")
                await asyncio.sleep(1)

    async def _process_batch(self, messages: List[Dict[str, Any]]):
        """Process a batch of embedding requests efficiently"""
        if not messages:
            return

        # Collect file IDs to process
        file_data_list = []
        for data in messages:
            file_id = data.get('file_id')
            if file_id:
                file_data_list.append({
                    'file_id': file_id,
                    'file_name': data.get('file_name', ''),
                    'user_id': data.get('user_id'),
                    'tags': data.get('tags', []),
                    'description': data.get('description', ''),
                    'ai_tags': data.get('ai_tags', [])
                })

        if not file_data_list:
            return

        async with async_session() as db:
            try:
                # Build searchable texts
                texts = []
                valid_items = []
                for item in file_data_list:
                    text = embedding_service.build_searchable_text(
                        file_name=item['file_name'],
                        tags=item.get('tags'),
                        description=item.get('description'),
                        ai_tags=item.get('ai_tags')
                    )
                    if text:
                        texts.append(text)
                        valid_items.append(item)

                if not texts:
                    logger.warning("No valid texts to embed in batch")
                    return

                # Generate embeddings in batch
                logger.info(f"Generating {len(texts)} embeddings...")
                embeddings = await embedding_service.generate_embeddings_batch(texts)

                # Store each embedding
                success_count = 0
                for item, embedding in zip(valid_items, embeddings):
                    if embedding is not None:
                        try:
                            from uuid import UUID
                            file_id = UUID(item['file_id']) if isinstance(item['file_id'], str) else item['file_id']
                            user_id = UUID(item['user_id']) if isinstance(item['user_id'], str) else item['user_id']

                            await embedding_service.store_embedding(
                                db=db,
                                file_id=file_id,
                                user_id=user_id,
                                embedding=embedding,
                                source_text=texts[valid_items.index(item)],
                                source_type='combined'
                            )
                            success_count += 1
                        except Exception as e:
                            logger.error(f"Failed to store embedding for {item['file_id']}: {e}")
                    else:
                        logger.warning(f"Failed to generate embedding for {item['file_name']}")

                logger.info(f"Successfully processed {success_count}/{len(valid_items)} embeddings")

            except Exception as e:
                logger.error(f"Batch processing error: {e}")


async def main():
    """Entry point"""
    worker = EmbeddingWorker()
    await worker.start()


if __name__ == "__main__":
    print("=" * 60)
    print("Semantic Search Embedding Worker")
    print("=" * 60)
    asyncio.run(main())
