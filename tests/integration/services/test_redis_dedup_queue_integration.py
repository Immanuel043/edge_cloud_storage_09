"""Integration tests for RedisStreamDeduplicationQueue against a real Redis.

The matching unit-test file (tests/unit/services/test_redis_dedup_queue.py)
covers admission, quotas, and counters with fakeredis. Two behaviors don't
round-trip cleanly under fakeredis 2.23 — XREADGROUP across multiple streams
in one call (priority order) and BLOCK semantics in the consumer loop — so
they live here against a real Redis 7+.

Run with:
    pytest tests/integration/services/test_redis_dedup_queue_integration.py \
        -v -m integration --asyncio-mode=auto

Requires REDIS_URL pointing at a Redis 7+ instance with auth (the
docker-compose `edge-redis` works once REDIS_PASSWORD is in env). Tests use
a unique key prefix per session so they don't clobber a running stack.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from typing import Any, Dict, List

import pytest
import redis.asyncio as aioredis

from app.services.redis_dedup_queue import (
    PRIORITY_TO_STREAM,
    RedisStreamDeduplicationQueue,
)


pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


def _redis_url() -> str:
    return os.environ.get("REDIS_URL", "redis://localhost:6379/0")


@pytest.fixture
async def real_redis():
    """Connect to a real Redis. Skips the test if unreachable (so the suite
    still passes locally without the docker-compose stack running)."""
    client = aioredis.from_url(_redis_url(), decode_responses=False)
    try:
        await client.ping()
    except Exception as exc:  # noqa: BLE001
        await client.aclose()
        pytest.skip(f"Redis not reachable at {_redis_url()}: {exc}")
    yield client
    await client.aclose()


@pytest.fixture
async def isolated_queue(real_redis, monkeypatch):
    """Spin up the queue against a unique key namespace so tests don't
    collide with the running stack's `dedup:*` keys."""
    suffix = uuid.uuid4().hex[:8]
    # Patch the module-level keys so the queue uses an isolated namespace.
    import app.services.redis_dedup_queue as mod

    monkeypatch.setattr(mod, "PRIORITY_TO_STREAM", {
        1: f"test:{suffix}:dedup:queue:high",
        2: f"test:{suffix}:dedup:queue:medium",
        3: f"test:{suffix}:dedup:queue:low",
    })
    monkeypatch.setattr(mod, "STREAMS_IN_PRIORITY_ORDER", [
        mod.PRIORITY_TO_STREAM[p] for p in (1, 2, 3)
    ])
    monkeypatch.setattr(mod, "PRIORITY_FROM_STREAM", {
        v: k for k, v in mod.PRIORITY_TO_STREAM.items()
    })
    monkeypatch.setattr(mod, "KEY_TOTAL", f"test:{suffix}:dedup:total_jobs")
    monkeypatch.setattr(mod, "KEY_USER_COUNTS", f"test:{suffix}:dedup:user_counts")
    monkeypatch.setattr(mod, "KEY_ACTIVE", f"test:{suffix}:dedup:active_jobs")
    monkeypatch.setattr(mod, "KEY_STATS", f"test:{suffix}:dedup:stats")
    monkeypatch.setattr(mod, "CONSUMER_GROUP", f"test-{suffix}-workers")

    q = mod.RedisStreamDeduplicationQueue(
        max_concurrent=4, max_queue_size=10, max_per_user=5
    )

    async def _always_healthy():
        return {"healthy": True, "state": "CLOSED", "health_info": {}}

    q.circuit_breaker.check_health = _always_healthy  # type: ignore[assignment]

    yield q

    # Teardown: cancel consumer if running, then remove this test's keys.
    try:
        await q.stop()
    except Exception:  # noqa: BLE001
        pass
    keys = await real_redis.keys(f"test:{suffix}:*")
    if keys:
        await real_redis.delete(*keys)


# ------------------------------------------------------------------ #
# Priority order — high stream is consumed before medium and low even
# when low is XADDed first. Real Redis preserves the listed-stream
# ordering in XREADGROUP responses.
# ------------------------------------------------------------------ #


async def test_priority_order_real_redis(real_redis, isolated_queue):
    q = isolated_queue
    await q.start(real_redis, consumer=False)

    # Enqueue lowest priority first, then medium, then high.
    assert (await q.enqueue({"file_id": "low1"}, priority=3, user_id="u1"))["success"]
    assert (await q.enqueue({"file_id": "med1"}, priority=2, user_id="u2"))["success"]
    assert (await q.enqueue({"file_id": "high1"}, priority=1, user_id="u3"))["success"]

    # Read using the same consumer-group + ordering the queue uses.
    import app.services.redis_dedup_queue as mod

    streams_arg = {s: ">" for s in mod.STREAMS_IN_PRIORITY_ORDER}
    seen: List[str] = []
    deadline = asyncio.get_event_loop().time() + 3.0
    while len(seen) < 3 and asyncio.get_event_loop().time() < deadline:
        resp = await real_redis.xreadgroup(
            groupname=mod.CONSUMER_GROUP,
            consumername="test-reader",
            streams=streams_arg,
            count=10,
            block=200,
        )
        for _stream_name, msgs in resp or []:
            for _id, fields in msgs:
                payload = fields.get(b"job") or fields.get("job") or b"{}"
                if isinstance(payload, bytes):
                    payload = payload.decode()
                seen.append(json.loads(payload)["file_id"])

    assert seen == ["high1", "med1", "low1"], (
        f"expected high → med → low order, got {seen}"
    )


# ------------------------------------------------------------------ #
# End-to-end consumer round-trip — XADD via the producer, the consumer
# loop dispatches, the test processor runs, the message is XACKed, and
# the counters decrement back to zero.
# ------------------------------------------------------------------ #


async def test_consumer_round_trip_real_redis(real_redis, isolated_queue):
    q = isolated_queue
    await q.start(real_redis, consumer=False)

    res = await q.enqueue({"file_id": "real-rt-1"}, priority=1, user_id="userA")
    assert res["success"]

    processed: List[Dict[str, Any]] = []

    async def proc(job: Dict[str, Any]) -> None:
        processed.append(job)
        return None  # success → consumer ACKs and decrements counters

    await q.stop()
    # Re-bind health check (stop() may have invalidated the override).
    async def _ok():
        return {"healthy": True, "state": "CLOSED", "health_info": {}}
    q.circuit_breaker.check_health = _ok  # type: ignore[assignment]
    await q.start(real_redis, consumer=True, processor=proc)

    # Wait for the consumer loop to pick up the message.
    deadline = asyncio.get_event_loop().time() + 5.0
    while not processed and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.1)

    assert len(processed) == 1
    assert processed[0]["file_id"] == "real-rt-1"

    # Counters should be back to zero post-ack.
    import app.services.redis_dedup_queue as mod

    deadline = asyncio.get_event_loop().time() + 3.0
    while asyncio.get_event_loop().time() < deadline:
        cur = int((await real_redis.get(mod.KEY_TOTAL)) or 0)
        if cur == 0:
            break
        await asyncio.sleep(0.1)

    assert int((await real_redis.get(mod.KEY_TOTAL)) or 0) == 0
    assert int((await real_redis.hget(mod.KEY_USER_COUNTS, "userA")) or 0) == 0
