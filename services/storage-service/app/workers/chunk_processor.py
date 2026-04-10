# services/storage-service/app/workers/chunk_processor.py

import asyncio
import hashlib
import json
import logging
import os

import aiofiles
from aiokafka import AIOKafkaConsumer, AIOKafkaProducer

from ..database import get_redis
from ..services.encryption import encryption_service
from ..services.storage import storage_service
from ._kafka_dlq import dlq_producer

logger = logging.getLogger(__name__)

KAFKA_BOOTSTRAP_SERVERS = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092")
KAFKA_TOPIC = "chunk-processing"
KAFKA_GROUP_ID = "chunk-processors"


class ChunkProcessor:
    def __init__(self):
        self.consumer = None
        self.producer = None

    async def start(self):
        # Manual commits: we only advance the offset after a message has
        # either succeeded OR been published to the DLQ. This avoids the
        # auto-commit behavior where a worker crash between receive and
        # save silently drops the chunk.
        self.consumer = AIOKafkaConsumer(
            KAFKA_TOPIC,
            bootstrap_servers=KAFKA_BOOTSTRAP_SERVERS,
            group_id=KAFKA_GROUP_ID,
            auto_offset_reset="earliest",
            enable_auto_commit=False,
            max_poll_records=10,  # Process 10 chunks at a time
        )
        self.producer = AIOKafkaProducer(
            bootstrap_servers=KAFKA_BOOTSTRAP_SERVERS,
            value_serializer=lambda v: json.dumps(v).encode(),
        )

        await self.consumer.start()
        await self.producer.start()
        await dlq_producer.start()

        try:
            async for msg in self.consumer:
                try:
                    await self.process_chunk(json.loads(msg.value))
                    await self.consumer.commit()
                except Exception as e:
                    logger.exception(
                        "chunk_processor: unrecoverable error on offset %s",
                        msg.offset,
                    )
                    # Preserve legacy error channel for in-app reporting
                    try:
                        chunk_info = json.loads(msg.value)
                        await self.producer.send(
                            "chunk-error",
                            {
                                "upload_id": chunk_info.get("upload_id"),
                                "chunk_index": chunk_info.get("chunk_index"),
                                "error": str(e),
                            },
                        )
                    except Exception:
                        pass
                    # Route to Kafka DLQ so the partition advances past
                    # the poison pill, then commit the offset.
                    await dlq_producer.send_failed_message(
                        msg, error=e, worker="chunk-processor"
                    )
                    await self.consumer.commit()
        finally:
            await self.consumer.stop()
            await self.producer.stop()
            await dlq_producer.stop()

    async def process_chunk(self, chunk_info):
        # Read temp chunk
        async with aiofiles.open(chunk_info["chunk_path"], "rb") as f:
            chunk_data = await f.read()

        # Calculate hash
        chunk_hash = hashlib.sha256(chunk_data).hexdigest()

        # Decrypt key
        file_key = encryption_service.decrypt_key(chunk_info["encryption_key"])

        # Save chunk with dedup, compression, encryption
        await storage_service.save_chunk(chunk_data, chunk_hash, file_key)

        # Update Redis with chunk hash
        redis_client = await get_redis()
        session_key = f"upload:{chunk_info['upload_id']}"
        session_data = await redis_client.get(session_key)

        if session_data:
            session = json.loads(session_data)
            if len(session["chunk_hashes"]) <= chunk_info["chunk_index"]:
                session["chunk_hashes"].extend(
                    [None] * (chunk_info["chunk_index"] + 1 - len(session["chunk_hashes"]))
                )
            session["chunk_hashes"][chunk_info["chunk_index"]] = chunk_hash
            await redis_client.setex(session_key, 3600, json.dumps(session))

        # Clean up temp file
        os.remove(chunk_info["chunk_path"])

        # Send completion event
        await self.producer.send(
            "chunk-completed",
            {
                "upload_id": chunk_info["upload_id"],
                "chunk_index": chunk_info["chunk_index"],
                "chunk_hash": chunk_hash,
                "status": "success",
            },
        )


if __name__ == "__main__":
    processor = ChunkProcessor()
    asyncio.run(processor.start())
