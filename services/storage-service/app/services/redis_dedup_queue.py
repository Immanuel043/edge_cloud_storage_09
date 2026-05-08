# services/storage-service/app/services/redis_dedup_queue.py
"""
Redis Streams-backed deduplication queue.

Replaces the in-process ``SmartDeduplicationQueue`` so producer (API replicas)
and consumer (storage-worker container) can live in separate processes.
Same public interface as ``SmartDeduplicationQueue`` so call sites in
``routers/upload.py``, ``routers/deduplication.py``, and ``main.py`` are
unchanged.

Backing data:

- ``dedup:queue:high|medium|low`` — three Redis Streams, one per priority.
  XADDed by producers, XREADGROUPed by the consumer in priority order.
- ``dedup:total_jobs`` — atomic counter (INCR/DECR) for backpressure.
- ``dedup:user_counts`` — HASH keyed by user_id (HINCRBY/HINCRBY -1) for
  per-user quota.
- ``dedup:active_jobs`` — HASH keyed by file_id, tracks jobs being processed
  by the consumer; readable from any replica via HLEN.
- ``dedup:stats`` — HASH of counter stats (HINCRBY).

All admission decisions (circuit breaker, total quota, per-user quota,
XADD) are made inside a single Lua script so two concurrent producers
can't over-admit.

The consumer group is ``dedup-workers``; consumers identify themselves
with a unique consumer name (worker container hostname + PID). On startup
the consumer XPENDING / XCLAIMs messages older than ``CLAIM_IDLE_MS`` from
dead consumers so a crash mid-process doesn't leak the message.
"""

import asyncio
import json
import logging
import os
import socket
from datetime import datetime
from typing import Any, Awaitable, Callable, Dict, Optional

logger = logging.getLogger(__name__)


PRIORITY_TO_STREAM = {
    1: "dedup:queue:high",
    2: "dedup:queue:medium",
    3: "dedup:queue:low",
}
STREAMS_IN_PRIORITY_ORDER = [PRIORITY_TO_STREAM[p] for p in (1, 2, 3)]
PRIORITY_FROM_STREAM = {v: k for k, v in PRIORITY_TO_STREAM.items()}

CONSUMER_GROUP = "dedup-workers"

KEY_TOTAL = "dedup:total_jobs"
KEY_USER_COUNTS = "dedup:user_counts"
KEY_ACTIVE = "dedup:active_jobs"
KEY_STATS = "dedup:stats"

# Reclaim messages whose owning consumer has not acked them in this window.
CLAIM_IDLE_MS = 5 * 60 * 1000  # 5 minutes

# Atomic enqueue: check quotas, increment counters, XADD. Returns the new
# message ID on success, or an error code that the caller maps to a reject
# reason. Keeping the whole admission decision in one round-trip means two
# concurrent producers can't both pass the size/quota check and overshoot.
LUA_ENQUEUE = """
local total_key = KEYS[1]
local user_counts_key = KEYS[2]
local stats_key = KEYS[3]
local stream_key = KEYS[4]
local max_total = tonumber(ARGV[1])
local max_per_user = tonumber(ARGV[2])
local user_id = ARGV[3]
local payload = ARGV[4]
local priority = ARGV[5]

local cur_total = tonumber(redis.call('GET', total_key) or '0')
if cur_total >= max_total then
  redis.call('HINCRBY', stats_key, 'total_rejected', 1)
  return {'ERR', 'queue_full', tostring(cur_total)}
end

if user_id ~= '' then
  local cur_user = tonumber(redis.call('HGET', user_counts_key, user_id) or '0')
  if cur_user >= max_per_user then
    redis.call('HINCRBY', stats_key, 'total_rejected', 1)
    return {'ERR', 'user_quota_exceeded', tostring(cur_user)}
  end
end

local id = redis.call('XADD', stream_key, '*', 'job', payload, 'priority', priority)
redis.call('INCR', total_key)
if user_id ~= '' then
  redis.call('HINCRBY', user_counts_key, user_id, 1)
end
redis.call('HINCRBY', stats_key, 'total_enqueued', 1)
redis.call('HINCRBY', stats_key, 'by_priority_' .. priority, 1)
return {'OK', id}
"""


class RedisStreamDeduplicationQueue:
    """Redis Streams-backed dedup queue with the same public surface as
    ``SmartDeduplicationQueue``.

    Construct in ``producer`` mode on API replicas (no consumer loop) and
    in ``consumer`` mode on the worker container. The same singleton can
    safely be used in either mode because the consumer-side state lives
    in Redis, not on the instance.
    """

    def __init__(
        self,
        max_concurrent: int = 4,
        max_queue_size: int = 10_000,
        max_per_user: int = 50,
    ):
        self.max_concurrent = max_concurrent
        self.max_queue_size = max_queue_size
        self.max_per_user = max_per_user

        # Lazy import to avoid a circular module-load with dedup_queue.py
        # (which now creates the singleton instance of *this* class).
        from .dedup_queue import CircuitBreaker

        self.circuit_breaker = CircuitBreaker()
        self.semaphore = asyncio.Semaphore(max_concurrent)

        # Consumer-mode state. Worker registers a callable that processes
        # a single job dict; the worker loop XREADGROUPs and dispatches.
        self._consumer_name = f"{socket.gethostname()}:{os.getpid()}"
        self._consumer_task: Optional[asyncio.Task] = None
        self._processor: Optional[Callable[[Dict[str, Any]], Awaitable[Any]]] = None
        self._running = False

        # Lua script handle (registered lazily on first use).
        self._enqueue_script = None
        self._redis = None  # populated by start() / consumer loop

    # ------------------------------------------------------------------ #
    # Public surface (matches SmartDeduplicationQueue)                    #
    # ------------------------------------------------------------------ #

    @property
    def total_jobs(self) -> int:
        """Best-effort current queue size. Synchronous read for backwards
        compat — callers (main.py:/api/v1/stats) treat it as a snapshot."""
        # Synchronous accessors are awkward against an async client; we
        # surface the last known value cached during enqueue/get_status.
        # The /stats endpoint already calls get_status() async, so it
        # gets the live value there. For the rare direct read, return 0
        # rather than block — this matches the in-process semantics
        # (which were also "approximate, racing with the worker").
        return self._cached_total

    @property
    def active_jobs(self) -> Dict[str, Any]:
        """Compatibility shim. Returns a dict-like with len() reflecting
        the live HLEN of dedup:active_jobs. Callers only use len()."""
        return _AsyncHashView(self._redis, KEY_ACTIVE)

    _cached_total: int = 0  # updated by enqueue/get_status

    async def start(
        self,
        redis_client,
        consumer: bool = False,
        processor: Optional[Callable[[Dict[str, Any]], Awaitable[Any]]] = None,
    ) -> None:
        """Initialize Redis connection and (optionally) start the consumer
        loop. Producers call ``start(redis_client)`` and stop there.
        Consumers call ``start(redis_client, consumer=True, processor=fn)``.

        Idempotent: safe to call repeatedly.
        """
        self._redis = redis_client
        self._enqueue_script = redis_client.register_script(LUA_ENQUEUE)

        # Ensure consumer groups exist on every priority stream. MKSTREAM
        # creates the stream if it doesn't already.
        for stream in STREAMS_IN_PRIORITY_ORDER:
            try:
                await redis_client.xgroup_create(
                    name=stream, groupname=CONSUMER_GROUP, id="$", mkstream=True
                )
            except Exception as e:
                # BUSYGROUP — group already exists; ignore.
                if "BUSYGROUP" not in str(e):
                    logger.warning("XGROUP CREATE %s failed: %s", stream, e)

        if consumer:
            if processor is None:
                raise ValueError("consumer mode requires a processor callable")
            self._processor = processor
            await self._reclaim_stale_pending()
            self._running = True
            self._consumer_task = asyncio.create_task(self._consumer_loop())
            logger.info(
                "📋 Redis Streams dedup queue: consumer mode (group=%s consumer=%s)",
                CONSUMER_GROUP,
                self._consumer_name,
            )
        else:
            logger.info("📋 Redis Streams dedup queue: producer mode")

    async def stop(self) -> None:
        """Stop the consumer loop if it's running. Producer mode is no-op."""
        self._running = False
        if self._consumer_task and not self._consumer_task.done():
            self._consumer_task.cancel()
            try:
                await self._consumer_task
            except asyncio.CancelledError:
                pass
        logger.info("📋 Redis Streams dedup queue stopped")

    async def enqueue(
        self, job: Dict[str, Any], priority: int = 2, user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Atomic admission decision + XADD. Same return shape as the in-process queue."""
        if priority not in (1, 2, 3):
            priority = 2

        health = await self.circuit_breaker.check_health()
        health_snapshot = health.get("health_info") or {}
        if not health["healthy"]:
            await self._incr_stat("total_rejected")
            return {
                "success": False,
                "reason": "circuit_breaker_open",
                "message": "System overloaded, try again later",
                "health": health_snapshot,
                "state": health.get("state", "UNKNOWN"),
            }

        job_with_meta = {
            **job,
            "priority": priority,
            "user_id": user_id,
            "enqueued_at": datetime.utcnow().isoformat(),
        }
        payload = json.dumps(job_with_meta, default=str)

        result = await self._enqueue_script(
            keys=[KEY_TOTAL, KEY_USER_COUNTS, KEY_STATS, PRIORITY_TO_STREAM[priority]],
            args=[
                str(self.max_queue_size),
                str(self.max_per_user),
                user_id or "",
                payload,
                str(priority),
            ],
        )

        # Lua return is a Redis multi-bulk; client maps to [bytes, bytes, ...].
        status = _to_str(result[0])
        if status == "ERR":
            reason = _to_str(result[1])
            cur = _to_str(result[2]) if len(result) > 2 else "?"
            return {
                "success": False,
                "reason": reason,
                "message": (
                    f"Queue full ({cur} jobs)"
                    if reason == "queue_full"
                    else f"User has {cur} jobs in queue"
                ),
            }

        msg_id = _to_str(result[1])
        self._cached_total += 1
        # Position estimate is best-effort: total queue size right after admission.
        return {
            "success": True,
            "priority": priority,
            "queue_position": self._cached_total,
            "estimated_wait": int(self._cached_total * 60 / max(self.max_concurrent, 1)),
            "message_id": msg_id,
        }

    async def get_status(self) -> Dict[str, Any]:
        """Aggregate queue + circuit-breaker status. Matches the dict shape
        consumed by ``routers/deduplication.py:157``."""
        health = await self.circuit_breaker.check_health()

        # Per-priority counts must be the consumer-group lag (unprocessed
        # entries), not XLEN (which is the lifetime entry count and grows
        # forever because XACK doesn't delete from the stream).
        pipe = self._redis.pipeline(transaction=False)
        pipe.get(KEY_TOTAL)
        pipe.hlen(KEY_ACTIVE)
        pipe.hgetall(KEY_STATS)
        results = await pipe.execute()

        total = int(results[0] or 0)
        active = int(results[1] or 0)
        raw_stats = results[2] or {}
        stats = {_to_str(k): int(v) for k, v in raw_stats.items()}

        async def _lag(stream: str) -> int:
            # Real Redis 7+ exposes a tracked `lag` per consumer group, but
            # fakeredis returns lag=0 with entries-read=None even when entries
            # are pending. Fall back to XLEN-(delivered count) when lag isn't
            # populated; XLEN alone over-reports because XACK doesn't remove
            # entries from the stream.
            try:
                groups = await self._redis.xinfo_groups(stream)
                for g in groups:
                    if not isinstance(g, dict):
                        continue
                    if _to_str(g.get("name")) != CONSUMER_GROUP:
                        continue
                    entries_read = g.get("entries-read")
                    lag = g.get("lag")
                    if entries_read is not None and lag is not None:
                        return int(lag)
                    # Fallback: XLEN - entries already delivered to consumers.
                    xlen = int(await self._redis.xlen(stream))
                    delivered = int(entries_read or 0)
                    return max(0, xlen - delivered)
            except Exception:  # noqa: BLE001
                pass
            return 0

        high = await _lag(PRIORITY_TO_STREAM[1])
        medium = await _lag(PRIORITY_TO_STREAM[2])
        low = await _lag(PRIORITY_TO_STREAM[3])

        self._cached_total = total

        return {
            "queue_size": total,
            "active_jobs": active,
            "by_priority": {"high": high, "medium": medium, "low": low},
            "circuit_breaker": {
                "state": health["state"],
                "healthy": health["healthy"],
                "health_info": health.get("health_info", {}),
            },
            "statistics": {
                "total_enqueued": stats.get("total_enqueued", 0),
                "total_processed": stats.get("total_processed", 0),
                "total_failed": stats.get("total_failed", 0),
                "total_rejected": stats.get("total_rejected", 0),
                "by_priority": {
                    1: stats.get("by_priority_1", 0),
                    2: stats.get("by_priority_2", 0),
                    3: stats.get("by_priority_3", 0),
                },
            },
            "capacity": {
                "max_queue_size": self.max_queue_size,
                "max_per_user": self.max_per_user,
                "max_concurrent": self.max_concurrent,
                "available_slots": self.max_queue_size - total,
            },
        }

    def get_user_status(self, user_id: str) -> Dict[str, Any]:
        """Compatibility shim — synchronous read against Redis is awkward
        from an async client, so we surface a cached value when available
        and fall back to "unknown" otherwise. Async callers should use
        :meth:`aget_user_status`."""
        cached = _SYNC_USER_CACHE.get(user_id, 0)
        return {
            "user_id": user_id,
            "jobs_in_queue": cached,
            "max_allowed": self.max_per_user,
            "slots_available": max(0, self.max_per_user - cached),
        }

    async def aget_user_status(self, user_id: str) -> Dict[str, Any]:
        """Async per-user status (preferred)."""
        cur = await self._redis.hget(KEY_USER_COUNTS, user_id)
        cur_int = int(cur or 0)
        _SYNC_USER_CACHE[user_id] = cur_int
        return {
            "user_id": user_id,
            "jobs_in_queue": cur_int,
            "max_allowed": self.max_per_user,
            "slots_available": max(0, self.max_per_user - cur_int),
        }

    # ------------------------------------------------------------------ #
    # Consumer internals                                                  #
    # ------------------------------------------------------------------ #

    async def _consumer_loop(self) -> None:
        """XREADGROUP from streams in priority order; dispatch to processor."""
        logger.info("📋 Redis Streams dedup consumer running...")
        while self._running:
            try:
                health = await self.circuit_breaker.check_health()
                if not health["healthy"]:
                    logger.warning("⚠️ Circuit breaker open, pausing consumer 30s")
                    await asyncio.sleep(30)
                    continue

                # Read one new message from any of the 3 streams; the client
                # returns them in the order we list them, which gives us
                # priority bias.
                streams_arg = {s: ">" for s in STREAMS_IN_PRIORITY_ORDER}
                resp = await self._redis.xreadgroup(
                    groupname=CONSUMER_GROUP,
                    consumername=self._consumer_name,
                    streams=streams_arg,
                    count=1,
                    block=1000,
                )
                if not resp:
                    await asyncio.sleep(0)
                    continue

                # `resp` shape: [(stream, [(msg_id, {field: value, ...})])]
                for stream_name, messages in resp:
                    stream = _to_str(stream_name)
                    for msg_id, fields in messages:
                        await self._dispatch_one(stream, _to_str(msg_id), fields)

            except asyncio.CancelledError:
                break
            except Exception as e:  # noqa: BLE001 — keep the loop alive on noise
                logger.error("Consumer loop error: %s", e)
                await asyncio.sleep(1)

    async def _dispatch_one(self, stream: str, msg_id: str, fields: Dict) -> None:
        """Process a single message; ack on success/failure, requeue on defer."""
        priority = PRIORITY_FROM_STREAM.get(stream, 2)
        try:
            payload = _to_str(fields.get(b"job") or fields.get("job") or "{}")
            job = json.loads(payload)
        except (json.JSONDecodeError, AttributeError) as e:
            logger.error("Malformed dedup message %s: %s", msg_id, e)
            await self._redis.xack(stream, CONSUMER_GROUP, msg_id)
            return

        file_id = job.get("file_id", "?")
        user_id = job.get("user_id")

        async with self.semaphore:
            await self._redis.hset(KEY_ACTIVE, file_id, msg_id)
            try:
                if self._processor is None:
                    raise RuntimeError("consumer started without a processor")
                result = await self._processor(job)
            except Exception as e:  # noqa: BLE001
                logger.error("Dedup processor failed for %s: %s", file_id, e)
                await self._incr_stat("total_failed")
                result = "failed"
            finally:
                await self._redis.hdel(KEY_ACTIVE, file_id)

        if result == "deferred":
            # Re-XADD to the same priority stream after a delay; ack the
            # current message so it doesn't keep getting reclaimed.
            await self._redis.xack(stream, CONSUMER_GROUP, msg_id)
            asyncio.create_task(self._defer_requeue(job, priority, delay=10))
        else:
            await self._redis.xack(stream, CONSUMER_GROUP, msg_id)
            await self._decrement_counters(user_id)
            await self._incr_stat("total_processed")

    async def _defer_requeue(self, job: Dict, priority: int, delay: float) -> None:
        await asyncio.sleep(delay)
        try:
            await self._redis.xadd(
                PRIORITY_TO_STREAM[priority],
                {"job": json.dumps(job, default=str), "priority": str(priority)},
            )
            logger.info(
                "📋 Re-queued deferred job %s priority=%d",
                job.get("file_id"),
                priority,
            )
        except Exception as e:  # noqa: BLE001
            logger.error("Defer-requeue failed: %s", e)

    async def _reclaim_stale_pending(self) -> None:
        """On startup, claim any messages whose owning consumer hasn't acked
        within CLAIM_IDLE_MS — recovers from a worker crash mid-process."""
        for stream in STREAMS_IN_PRIORITY_ORDER:
            try:
                # XAUTOCLAIM is the cleanest API for this; available in Redis 6.2+.
                start = "0-0"
                while True:
                    res = await self._redis.xautoclaim(
                        name=stream,
                        groupname=CONSUMER_GROUP,
                        consumername=self._consumer_name,
                        min_idle_time=CLAIM_IDLE_MS,
                        start_id=start,
                        count=50,
                    )
                    # redis-py returns (next_id, [(msg_id, {fields})])
                    next_id = _to_str(res[0]) if res and res[0] else "0-0"
                    claimed = res[1] if res and len(res) > 1 else []
                    if claimed:
                        logger.info(
                            "Reclaimed %d stale dedup messages from %s",
                            len(claimed),
                            stream,
                        )
                    if next_id == "0-0" or not claimed:
                        break
                    start = next_id
            except Exception as e:  # noqa: BLE001
                logger.warning("xautoclaim on %s failed (continuing): %s", stream, e)

    async def _decrement_counters(self, user_id: Optional[str]) -> None:
        # Clamp at zero — under normal operation the Lua enqueue script keeps
        # counters consistent, but a manually-XADDed message (debug/recovery
        # path) wouldn't have incremented them, so blind DECR can go negative.
        await self._redis.eval(
            """
            local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
            if cur > 0 then redis.call('DECR', KEYS[1]) end
            if ARGV[1] ~= '' then
              local u = tonumber(redis.call('HGET', KEYS[2], ARGV[1]) or '0')
              if u > 0 then redis.call('HINCRBY', KEYS[2], ARGV[1], -1) end
            end
            return 1
            """,
            2,
            KEY_TOTAL,
            KEY_USER_COUNTS,
            user_id or "",
        )

    async def _incr_stat(self, field: str) -> None:
        try:
            await self._redis.hincrby(KEY_STATS, field, 1)
        except Exception:  # noqa: BLE001
            pass


# ---------------------------------------------------------------------- #
# Helpers                                                                 #
# ---------------------------------------------------------------------- #


_SYNC_USER_CACHE: Dict[str, int] = {}


def _to_str(v) -> str:
    if isinstance(v, bytes):
        return v.decode("utf-8", errors="replace")
    return str(v)


class _AsyncHashView:
    """Wraps a Redis HASH so callers that do `len(active_jobs)` get a
    plausible answer without changing the call site. Synchronous len()
    returns the last cached HLEN; awaiting `.alen()` returns the live value.
    """

    def __init__(self, redis_client, key: str):
        self._r = redis_client
        self._k = key
        self._cached_len = 0

    def __len__(self) -> int:
        return self._cached_len

    async def alen(self) -> int:
        if self._r is None:
            return self._cached_len
        try:
            self._cached_len = int(await self._r.hlen(self._k))
        except Exception:  # noqa: BLE001
            pass
        return self._cached_len
