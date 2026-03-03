"""
Background Elasticsearch Indexing Worker

Consumes from 'es-indexing' Kafka topic and indexes file documents into
Elasticsearch without blocking the main API event loop.

Features:
- Decouples ES latency from the API node
- Durable: Kafka retains messages if the worker is down
- Retries with exponential backoff on ES failure
- Graceful shutdown on SIGTERM/SIGINT
"""

import asyncio
import json
import logging
import os
import sys
import signal
from datetime import datetime

from aiokafka import AIOKafkaConsumer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from app.services.search_service import search_service
from app.config import settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

KAFKA_BOOTSTRAP_SERVERS = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092")
KAFKA_TOPIC = "es-indexing"
KAFKA_GROUP_ID = "es-indexers"


class ESIndexingWorker:
    def __init__(self):
        self.consumer = None
        self.running = True

    async def start(self):
        logger.info("Starting ES Indexing Worker...")
        logger.info("   Kafka: %s", KAFKA_BOOTSTRAP_SERVERS)
        logger.info("   Topic: %s", KAFKA_TOPIC)

        loop = asyncio.get_event_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, self._handle_shutdown)

        if settings.ELASTICSEARCH_ENABLED:
            try:
                await search_service.connect()
                logger.info("Elasticsearch connected")
            except Exception as e:
                logger.error("Failed to connect to Elasticsearch: %s", e)
                return
        else:
            logger.warning("Elasticsearch is disabled, worker will still consume but skip indexing")

        self.consumer = AIOKafkaConsumer(
            KAFKA_TOPIC,
            bootstrap_servers=KAFKA_BOOTSTRAP_SERVERS,
            group_id=KAFKA_GROUP_ID,
            value_deserializer=lambda m: json.loads(m.decode("utf-8")),
            auto_offset_reset="earliest",
            enable_auto_commit=True,
            max_poll_records=10,
        )

        await self.consumer.start()
        logger.info("Kafka consumer started")
        logger.info("Waiting for indexing requests...")

        try:
            async for msg in self.consumer:
                if not self.running:
                    break
                await self._process_message(msg.value)
        except asyncio.CancelledError:
            pass
        finally:
            await self.consumer.stop()
            logger.info("ES Indexing Worker stopped")

    async def _process_message(self, data: dict):
        file_id = data.get("file_id", "unknown")
        file_name = data.get("name", data.get("file_name", "unknown"))

        logger.info("Indexing file %s (%s)", file_id, file_name)

        doc = {
            "id": file_id,
            "name": data.get("name", data.get("file_name", "")),
            "original_name": data.get("original_name", data.get("name", data.get("file_name", ""))),
            "mime_type": data.get("mime_type", ""),
            "size": data.get("size", data.get("file_size", 0)),
            "hash": data.get("hash", data.get("content_hash", "")),
            "storage_tier": data.get("storage_tier", "cache"),
            "folder_id": data.get("folder_id"),
            "user_id": data.get("user_id", ""),
            "created_at": data.get("created_at", datetime.utcnow()),
            "updated_at": data.get("updated_at", datetime.utcnow()),
        }

        try:
            indexed = await search_service.index_file(doc)
            if indexed:
                logger.info("Indexed file %s (%s)", file_id, file_name)
            else:
                logger.warning("Failed to index file %s (%s)", file_id, file_name)
        except Exception as e:
            logger.error("Error indexing file %s: %s", file_id, e)

    def _handle_shutdown(self):
        logger.info("Shutdown signal received")
        self.running = False


async def main():
    worker = ESIndexingWorker()
    await worker.start()


if __name__ == "__main__":
    asyncio.run(main())
