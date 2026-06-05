"""Redis-backed worker heartbeats (core observability primitive).

Background workers run in a different process from the API (WORKER_MODE split,
see config.py), so the only channel between a worker and any reader is Redis.
Each worker writes a small JSON record at the end of every cycle; readers (the
admin ops dashboard, redis-cli, future alerting) consume them.

This lives under app/monitoring (not the dashboard package) because it is a
general liveness signal independent of any particular consumer.

Design notes:
- One JSON string per worker at ``worker:heartbeat:<name>``, plus a registry
  SET ``worker:heartbeat:names`` so readers use SMEMBERS + MGET instead of a
  blocking KEYS/SCAN in the request path.
- **No TTL.** A dead worker's record must persist so a reader can render "last
  seen 3h ago / STALE" rather than the row silently vanishing. Staleness is
  computed by age at read time, not by key expiry.
- Redis DB 0 is created with ``decode_responses=False`` (database.py), so both
  the SET members and the GET/MGET values come back as ``bytes`` and must be
  decoded before use.
- ``record_heartbeat`` is best-effort: it never raises. A heartbeat write must
  not be able to break a worker cycle.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)

HEARTBEAT_KEY_PREFIX = "worker:heartbeat:"
HEARTBEAT_REGISTRY_KEY = "worker:heartbeat:names"


def _key(name: str) -> str:
    return f"{HEARTBEAT_KEY_PREFIX}{name}"


async def record_heartbeat(
    name: str,
    status: str,
    interval_seconds: int,
    counts: Optional[dict[str, Any]] = None,
    last_error: Optional[Any] = None,
) -> None:
    """Best-effort heartbeat write. Never raises.

    Args:
        name: worker identifier (matches the EXPECTED_WORKERS list in the reader)
        status: "ok" or "error"
        interval_seconds: the worker's cycle interval, used for staleness calc
        counts: arbitrary per-cycle counters (e.g. backup completed/failed)
        last_error: any value; coerced to a truncated string in the payload
    """
    # Lazy import so we always read the live module global (it is None until
    # init_redis() runs), mirroring dependencies.py.
    from ..database import redis_client

    if redis_client is None:
        return

    payload = {
        "name": name,
        "status": status,
        "last_run": datetime.now(timezone.utc).isoformat(),
        "interval_seconds": interval_seconds,
        "counts": counts or {},
        "last_error": (str(last_error)[:500] if last_error else None),
    }

    try:
        await redis_client.set(_key(name), json.dumps(payload))
        await redis_client.sadd(HEARTBEAT_REGISTRY_KEY, name)
    except Exception as e:  # noqa: BLE001 - heartbeat must never break a cycle
        logger.warning("heartbeat write failed for %s: %s", name, e)


def _decode(value: Any) -> str:
    return value.decode() if isinstance(value, (bytes, bytearray)) else value


async def read_all_heartbeats() -> list[dict]:
    """Read every registered heartbeat. Tolerates missing/corrupt entries.

    Returns a list of decoded payload dicts. Never raises.
    """
    from ..database import redis_client

    if redis_client is None:
        return []

    try:
        raw_names = await redis_client.smembers(HEARTBEAT_REGISTRY_KEY)
        names = [_decode(n) for n in raw_names]
        if not names:
            return []

        raws = await redis_client.mget([_key(n) for n in names])
        out: list[dict] = []
        for raw in raws:
            if not raw:
                continue
            try:
                out.append(json.loads(_decode(raw)))
            except Exception:  # noqa: BLE001 - skip a single corrupt record
                continue
        return out
    except Exception as e:  # noqa: BLE001
        logger.warning("heartbeat read failed: %s", e)
        return []
