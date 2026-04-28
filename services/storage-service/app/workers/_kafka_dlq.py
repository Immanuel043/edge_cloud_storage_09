# services/storage-service/app/workers/_kafka_dlq.py
"""
Shared Kafka Dead-Letter Queue helper for background workers.

Background workers consume messages from Kafka topics (preview-processing,
es-indexing, embedding-processing, chunk-processing, file-analysis). Before
this helper existed, a malformed or unprocessable ("poison-pill") message
would either:

  - block a partition forever when offsets were not committed, or
  - be silently lost under ``enable_auto_commit=True`` when a worker
    crashed mid-processing.

This module centralizes a single producer that publishes failed messages
to ``{original_topic}.dlq`` with enough metadata to diagnose and replay,
and makes it safe for callers to *unconditionally* commit the offset
after the publish — the poison pill never blocks the partition again.

Usage sketch::

    from ._kafka_dlq import dlq_producer

    await dlq_producer.start()        # idempotent, safe to call many times
    ...
    try:
        await process(msg.value)
        await consumer.commit()
    except Exception as e:
        await dlq_producer.send_failed_message(
            msg, error=e, worker="preview-worker"
        )
        await consumer.commit()       # poison pill advances forward

    # On shutdown
    await dlq_producer.stop()

Design notes
------------
- The producer is a module-level singleton so we don't spin up one per
  message or per worker instance.
- Serialization mirrors the worker consumers: JSON + UTF-8. Binary keys
  and headers are preserved as-is (encoded safely).
- ``send_failed_message`` is best-effort — a DLQ publish failure is
  logged but does NOT re-raise, because the caller must still commit
  the offset to advance past the poison pill. Losing a DLQ record is
  strictly better than a stuck partition.
- DLQ topics are created lazily by Kafka auto-topic-create, which is
  enabled in ``infrastructure/docker-compose.yml``
  (``KAFKA_AUTO_CREATE_TOPICS_ENABLE: true``). No manual topic
  provisioning is required.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import traceback
from datetime import datetime
from typing import Any, Optional

from aiokafka import AIOKafkaProducer

logger = logging.getLogger(__name__)

KAFKA_BOOTSTRAP_SERVERS = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092")
DLQ_TOPIC_SUFFIX = ".dlq"


def _safe_value(obj: Any) -> Any:
    """Return ``obj`` if JSON-serializable, otherwise its ``repr``."""
    try:
        json.dumps(obj)
        return obj
    except (TypeError, ValueError):
        return repr(obj)


class KafkaDLQProducer:
    """Singleton async producer for publishing to ``{topic}.dlq`` topics."""

    def __init__(self) -> None:
        self._producer: Optional[AIOKafkaProducer] = None
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        """Lazily initialize and start the shared producer.

        Safe to call repeatedly; only the first call actually starts a
        producer. Callers don't need to coordinate startup order.
        """
        if self._producer is not None:
            return
        async with self._lock:
            if self._producer is not None:
                return
            producer = AIOKafkaProducer(
                bootstrap_servers=KAFKA_BOOTSTRAP_SERVERS,
                value_serializer=lambda v: json.dumps(v).encode("utf-8"),
                # DLQ volume is low by definition; we don't need massive
                # batching, but keep the request size matching the main
                # producer so large payloads fit.
                max_request_size=10 * 1024 * 1024,
                # Small linger so failures flush quickly in an incident.
                linger_ms=10,
            )
            await producer.start()
            self._producer = producer
            logger.info(
                "KafkaDLQProducer started (bootstrap=%s)",
                KAFKA_BOOTSTRAP_SERVERS,
            )

    async def stop(self) -> None:
        """Flush and stop the shared producer. Safe to call at shutdown."""
        if self._producer is None:
            return
        try:
            await self._producer.stop()
        except Exception as e:
            logger.warning("Error stopping KafkaDLQProducer: %s", e)
        finally:
            self._producer = None
            logger.info("KafkaDLQProducer stopped")

    async def send_failed_message(
        self,
        msg: Any,
        *,
        error: BaseException,
        worker: str,
        original_topic: Optional[str] = None,
    ) -> None:
        """Publish a failed Kafka message to the matching DLQ topic.

        Args:
            msg: The aiokafka ``ConsumerRecord`` (has ``value``, ``topic``,
                ``partition``, ``offset``, ``timestamp``). ``value`` is
                expected to already be deserialized (workers pass
                ``value_deserializer=json.loads``).
            error: The exception that caused the failure.
            worker: Short identifier for the failing worker (e.g.
                ``"preview-worker"``).
            original_topic: Override for the source topic. Defaults to
                ``msg.topic`` when available.

        This function never raises — DLQ publish failures are logged so
        the caller can still commit the consumer offset and unblock the
        partition. Losing a DLQ record is strictly preferable to a stuck
        poison-pill loop.
        """
        if self._producer is None:
            # Start-on-first-use is fine — eagerly start instead of failing.
            try:
                await self.start()
            except Exception as e:
                logger.error(
                    "DLQ publish suppressed: producer failed to start (%s). "
                    "Offset will still be committed by caller.",
                    e,
                )
                return

        topic = original_topic or getattr(msg, "topic", None) or "unknown"
        dlq_topic = f"{topic}{DLQ_TOPIC_SUFFIX}"

        payload = {
            "worker": worker,
            "original_topic": topic,
            "partition": getattr(msg, "partition", None),
            "offset": getattr(msg, "offset", None),
            "message_timestamp": getattr(msg, "timestamp", None),
            "failed_at": datetime.utcnow().isoformat() + "Z",
            "error": str(error),
            "error_type": type(error).__name__,
            "traceback": "".join(
                traceback.format_exception(type(error), error, error.__traceback__)
            )[
                -4000:
            ],  # cap at 4KB
            "value": _safe_value(getattr(msg, "value", None)),
        }

        try:
            assert self._producer is not None  # for type-checkers
            await self._producer.send_and_wait(dlq_topic, payload)
            logger.warning(
                "DLQ publish → %s (worker=%s partition=%s offset=%s error=%s)",
                dlq_topic,
                worker,
                payload["partition"],
                payload["offset"],
                payload["error_type"],
            )
        except Exception as pub_err:
            logger.error(
                "DLQ publish FAILED for %s (worker=%s offset=%s): %s. " "Original error was: %s",
                dlq_topic,
                worker,
                payload["offset"],
                pub_err,
                error,
            )


# Module-level singleton — import and use directly.
dlq_producer = KafkaDLQProducer()
