"""Admin ops dashboard endpoints.

- GET /api/v1/admin/ops       -> self-contained HTML page (HTMLResponse)
- GET /api/v1/admin/ops/data  -> aggregated JSON (JSONResponse), 5 sections

Both are gated by ``require_admin`` (the ``is_admin`` flag on User). Auth works
for a browser navigation because get_current_user reads the ``access_token``
cookie first, then the Authorization header.

Read-only aggregates use ``get_read_db`` (read replica when configured, primary
otherwise). ``database_health`` keeps its own primary session because it
inspects the primary connection pool.

Neither endpoint streams, so the repo's async-generator streaming rule does not
apply here.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import HTMLResponse, JSONResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import AsyncSessionLocal, get_read_db
from ..dependencies import require_admin
from ..models.database import Object, User
from ..routers.health import database_health, redis_health, system_health
from ..monitoring.worker_heartbeat import read_all_heartbeats
from .page import OPS_HTML

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/admin", tags=["admin-ops"])


# Static list of workers we expect to exist (mirrors combined_worker.py). A
# worker that has never run is absent from the Redis registry, so the registry
# alone cannot show it — we merge heartbeats onto this list and classify each.
# ``interval`` is a display default used only for never-run ("unknown") rows;
# live rows carry their real interval in the heartbeat payload.
EXPECTED_WORKERS: list[dict] = [
    {"name": "backup", "interval": 300, "enabled_flag": "BACKUP_ENABLED"},
    {"name": "storage_reconcile", "interval": 6 * 3600},
    {"name": "storage_optimization", "interval": 24 * 3600},
    {"name": "quota_prediction", "interval": 24 * 3600},
    {"name": "orphan_cleanup", "interval": 300},
    {"name": "cold_storage_tiering", "interval": 4 * 3600},
    # No fixed timer cycle — shown as "unknown" until they emit a heartbeat.
    {"name": "dedup_consumer", "interval": 300},
    {"name": "video_processing", "interval": 300},
]


def _worker_enabled(spec: dict) -> bool:
    """Whether a worker is enabled, used to render an intentional 'disabled'
    state instead of a false alarm."""
    flag = spec.get("enabled_flag")
    if not flag:
        return True
    return bool(getattr(settings, flag, True))


def _classify_workers(heartbeats: list[dict]) -> list[dict]:
    by_name = {h.get("name"): h for h in heartbeats if h.get("name")}
    now = datetime.now(timezone.utc)
    out: list[dict] = []

    for spec in EXPECTED_WORKERS:
        name = spec["name"]
        hb = by_name.get(name)
        row: dict[str, Any] = {
            "name": name,
            "state": "unknown",
            "last_run": None,
            "age_seconds": None,
            "counts": {},
            "last_error": None,
        }

        if hb is None:
            row["state"] = "unknown" if _worker_enabled(spec) else "disabled"
            out.append(row)
            continue

        interval = hb.get("interval_seconds") or spec["interval"]
        last_run = hb.get("last_run")
        age = None
        if last_run:
            try:
                ts = datetime.fromisoformat(last_run)
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
                age = (now - ts).total_seconds()
            except ValueError:
                age = None

        row.update(
            {
                "last_run": last_run,
                "age_seconds": age,
                "counts": hb.get("counts") or {},
                "last_error": hb.get("last_error"),
            }
        )

        if hb.get("status") == "error":
            row["state"] = "error"
        elif age is not None and age > interval * 2 + 60:
            row["state"] = "stale"
        else:
            row["state"] = "ok"

        out.append(row)

    return out


async def _workers_section() -> dict:
    return {"workers": _classify_workers(await read_all_heartbeats())}


async def _inventory_section(db: AsyncSession) -> dict:
    live = Object.is_deleted.is_(False)

    backup_rows = (
        await db.execute(
            select(Object.backup_status, func.count(Object.id)).where(live).group_by(Object.backup_status)
        )
    ).all()
    health_rows = (
        await db.execute(
            select(Object.health_status, func.count(Object.id)).where(live).group_by(Object.health_status)
        )
    ).all()
    tier_rows = (
        await db.execute(
            select(
                Object.storage_tier,
                func.count(Object.id),
                func.coalesce(func.sum(Object.file_size), 0),
            )
            .where(live)
            .group_by(Object.storage_tier)
        )
    ).all()
    type_rows = (
        await db.execute(
            select(
                Object.storage_type,
                func.count(Object.id),
                func.coalesce(func.sum(Object.file_size), 0),
            )
            .where(live)
            .group_by(Object.storage_type)
        )
    ).all()
    quarantined = (
        await db.execute(
            select(func.count(Object.id)).where(Object.is_quarantined.is_(True), live)
        )
    ).scalar() or 0
    video_rows = (
        await db.execute(
            select(Object.video_processing_status, func.count(Object.id))
            .where(Object.video_processing_status.isnot(None))
            .group_by(Object.video_processing_status)
        )
    ).all()

    return {
        "backup_status": {(k or "unknown"): v for k, v in backup_rows},
        "health_status": {(k or "unknown"): v for k, v in health_rows},
        "storage_tier": {(k or "unknown"): {"count": c, "bytes": int(b)} for k, c, b in tier_rows},
        "storage_type": {(k or "unknown"): {"count": c, "bytes": int(b)} for k, c, b in type_rows},
        "quarantined": quarantined,
        "video_queue": {(k or "unknown"): v for k, v in video_rows},
    }


async def _infra_section(db: AsyncSession) -> dict:
    # database_health inspects the PRIMARY pool — give it its own primary session
    # rather than the read-replica session used for the aggregates.
    async with AsyncSessionLocal() as primary_db:
        db_health = await database_health(db=primary_db)
    return {
        "system": await system_health(),
        "redis": await redis_health(),
        "db": db_health,
    }


async def _users_section(db: AsyncSession) -> dict:
    by_plan = (
        await db.execute(
            select(
                User.plan_type,
                func.count(User.id),
                func.coalesce(func.sum(User.storage_used), 0),
            ).group_by(User.plan_type)
        )
    ).all()
    totals = (
        await db.execute(
            select(
                func.count(User.id),
                func.coalesce(func.sum(User.storage_used), 0),
                func.coalesce(func.sum(User.storage_quota), 0),
            )
        )
    ).one()
    limit = int(getattr(settings, "OPS_TOP_CONSUMERS_LIMIT", 10))
    top = (
        await db.execute(
            select(User.email, User.plan_type, User.storage_used, User.storage_quota)
            .order_by(User.storage_used.desc())
            .limit(limit)
        )
    ).all()

    return {
        "total_users": totals[0],
        "total_used": int(totals[1]),
        "total_quota": int(totals[2]),
        "by_plan": [
            {"plan_type": p, "users": u, "storage_used": int(s)} for p, u, s in by_plan
        ],
        "top_consumers": [
            {"email": e, "plan_type": p, "storage_used": int(u), "storage_quota": int(q)}
            for e, p, u, q in top
        ],
    }


def _disk_usage_blocking(paths: list[tuple[str, str]]) -> list[dict]:
    """Run in a thread: shutil.disk_usage does a blocking statvfs. De-duplicate
    by device so a single filesystem (dev) is reported once."""
    seen: dict[int, dict] = {}
    out: list[dict] = []
    for label, path in paths:
        try:
            st = os.stat(path)
        except OSError:
            continue
        if st.st_dev in seen:
            # Same filesystem already counted — append the label for context.
            seen[st.st_dev]["label"] += f", {label}"
            continue
        try:
            usage = shutil.disk_usage(path)
        except OSError:
            continue
        entry = {
            "label": label,
            "mount": path,
            "total": usage.total,
            "used": usage.used,
            "free": usage.free,
        }
        seen[st.st_dev] = entry
        out.append(entry)
    return out


async def _capacity_section(users: dict) -> dict:
    paths = [
        ("root", settings.STORAGE_ROOT),
        ("cache", settings.CACHE_PATH),
        ("warm", settings.WARM_PATH),
        ("cold", settings.COLD_PATH),
        ("temp", settings.TEMP_PATH),
        ("backup", settings.BACKUP_PATH),
    ]
    volumes = await asyncio.to_thread(_disk_usage_blocking, paths)
    headroom = None
    if users and "total_quota" in users and "total_used" in users:
        headroom = int(users["total_quota"]) - int(users["total_used"])
    return {"volumes": volumes, "quota_headroom": headroom}


async def _safe(coro) -> dict:
    """Run a section coroutine, degrading to {'error': ...} on failure so one
    bad panel doesn't 500 the whole dashboard."""
    try:
        return await coro
    except Exception as e:  # noqa: BLE001
        logger.warning("ops section failed: %s", e, exc_info=True)
        return {"error": str(e)}


@router.get("/ops/data")
async def ops_data(
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_read_db),
) -> JSONResponse:
    users = await _safe(_users_section(db))
    data = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "workers": await _safe(_workers_section()),
        "inventory": await _safe(_inventory_section(db)),
        "infra": await _safe(_infra_section(db)),
        "users": users,
        "capacity": await _safe(_capacity_section(users if "error" not in users else {})),
    }
    return JSONResponse(data)


@router.get("/ops")
async def ops_page(admin: User = Depends(require_admin)) -> HTMLResponse:
    return HTMLResponse(OPS_HTML)
