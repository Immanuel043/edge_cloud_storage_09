# services/storage-service/app/services/kafka_client.py
"""
Shared Kafka producer singleton.

Every module that needs to publish to Kafka should import
`get_kafka_producer` from here instead of creating its own producer.
"""

import asyncio
import json
import logging

from aiokafka import AIOKafkaProducer

from ..config import settings

logger = logging.getLogger(__name__)

# ── singleton state ──────────────────────────────────────────────────
_producer: AIOKafkaProducer | None = None
_lock = asyncio.Lock()


async def get_kafka_producer() -> AIOKafkaProducer | None:
    """Return (and lazily create) the shared Kafka producer.

    Returns ``None`` when Kafka is not configured or unreachable so
    callers can degrade gracefully.
    """
    global _producer

    if not hasattr(settings, "KAFKA_BROKERS"):
        return None

    async with _lock:
        if _producer is None:
            try:
                _producer = AIOKafkaProducer(
                    bootstrap_servers=settings.KAFKA_BROKERS,
                    # Only JSON-encode if the value is not already bytes
                    value_serializer=lambda v: (
                        v if isinstance(v, (bytes, bytearray)) else json.dumps(v).encode()
                    ),
                    # zstd compression (requires cramjam package)
                    compression_type="zstd",
                    # 100 MB max request – matches large-scale needs
                    max_request_size=104857600,
                    # 64 MB batch – matches upload chunk size
                    max_batch_size=67108864,
                    # Helps zstd find patterns across chunks
                    linger_ms=100,
                )
                await _producer.start()
                logger.info("Kafka producer initialized with ZSTD compression")
            except Exception as e:
                logger.warning(f"Kafka unavailable: {e}")
                _producer = None
                return None

    return _producer


async def close_kafka_producer() -> None:
    """Gracefully shut down the shared producer (call on app shutdown)."""
    global _producer

    async with _lock:
        if _producer is not None:
            try:
                await _producer.stop()
                logger.info("Kafka producer stopped")
            except Exception as e:
                logger.warning(f"Error stopping Kafka producer: {e}")
            finally:
                _producer = None
