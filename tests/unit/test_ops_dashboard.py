"""Tests for the admin ops dashboard (app.ops_dashboard).

Covers:
- heartbeat.py round-trip (record + read) against an in-memory fake Redis that
  mimics the real DB-0 client (decode_responses=False → bytes in/out).
- The router's auth gating (401 unauth, 403 non-admin, 200 admin) and the
  five-section response contract.

Self-contained: overrides the exact dependencies the new router declares
(require_admin / get_current_user) and a fake Redis, rather than relying on the
shared conftest fixtures (which override app.database.get_db — a different
function — and use a stale mock_user shape).
"""

import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import app.database as app_database
from app.dependencies import get_current_user, require_admin
from app.main import app
from app.monitoring import worker_heartbeat as heartbeat


class FakeRedis:
    """Minimal async Redis mimicking decode_responses=False (bytes values)."""

    def __init__(self):
        self.kv: dict[str, bytes] = {}
        self.sets: dict[str, set] = {}

    @staticmethod
    def _b(v):
        return v.encode() if isinstance(v, str) else v

    async def set(self, key, value):
        self.kv[key] = self._b(value)

    async def sadd(self, key, *values):
        self.sets.setdefault(key, set()).update(self._b(v) for v in values)

    async def smembers(self, key):
        return self.sets.get(key, set())

    async def mget(self, keys):
        return [self.kv.get(k) for k in keys]


@pytest.fixture
def fake_redis(monkeypatch):
    fr = FakeRedis()
    # record_heartbeat / read_all_heartbeats do `from ..database import
    # redis_client` at call time, so patching the module attribute is enough.
    monkeypatch.setattr(app_database, "redis_client", fr, raising=False)
    return fr


def test_heartbeat_roundtrip(fake_redis):
    async def scenario():
        await heartbeat.record_heartbeat(
            "backup", "ok", 300, counts={"completed": 2, "failed": 0}
        )
        await heartbeat.record_heartbeat(
            "quota_prediction", "error", 86400, last_error=ValueError("boom")
        )
        return await heartbeat.read_all_heartbeats()

    beats = {b["name"]: b for b in asyncio.run(scenario())}

    assert set(beats) == {"backup", "quota_prediction"}
    assert beats["backup"]["status"] == "ok"
    assert beats["backup"]["counts"] == {"completed": 2, "failed": 0}
    assert beats["backup"]["interval_seconds"] == 300
    assert beats["backup"]["last_run"]  # ISO timestamp present
    # Exceptions are coerced to a string, never passed raw into json.dumps.
    assert beats["quota_prediction"]["status"] == "error"
    assert beats["quota_prediction"]["last_error"] == "boom"

    # Registry SET and value keys are written under the documented names.
    assert fake_redis.sets[heartbeat.HEARTBEAT_REGISTRY_KEY] == {b"backup", b"quota_prediction"}
    raw = fake_redis.kv[heartbeat.HEARTBEAT_KEY_PREFIX + "backup"]
    assert json.loads(raw.decode())["name"] == "backup"


def test_record_heartbeat_no_redis_is_noop(monkeypatch):
    monkeypatch.setattr(app_database, "redis_client", None, raising=False)
    # Must not raise when Redis is unavailable.
    asyncio.run(heartbeat.record_heartbeat("backup", "ok", 300))
    assert asyncio.run(heartbeat.read_all_heartbeats()) == []


def test_ops_data_requires_auth():
    client = TestClient(app)
    resp = client.get("/api/v1/admin/ops/data")
    assert resp.status_code == 401


def test_ops_data_forbidden_for_non_admin():
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id="u1", is_admin=False
    )
    try:
        client = TestClient(app)
        resp = client.get("/api/v1/admin/ops/data")
    finally:
        app.dependency_overrides.pop(get_current_user, None)
    assert resp.status_code == 403


def test_ops_data_admin_returns_five_sections(fake_redis):
    asyncio.run(heartbeat.record_heartbeat("backup", "ok", 300, counts={"completed": 1}))
    app.dependency_overrides[require_admin] = lambda: SimpleNamespace(
        id="admin1", is_admin=True
    )
    try:
        client = TestClient(app)
        resp = client.get("/api/v1/admin/ops/data")
    finally:
        app.dependency_overrides.pop(require_admin, None)

    assert resp.status_code == 200
    data = resp.json()
    assert set(["workers", "inventory", "infra", "users", "capacity"]).issubset(data)

    # Workers section is Redis-backed (not DB), so it should reflect our fake
    # heartbeat plus the static expected-worker list (dedup/video => unknown).
    workers = {w["name"]: w for w in data["workers"]["workers"]}
    assert workers["backup"]["state"] == "ok"
    assert workers["dedup_consumer"]["state"] in {"unknown", "disabled"}


def test_ops_page_admin_returns_html():
    app.dependency_overrides[require_admin] = lambda: SimpleNamespace(
        id="admin1", is_admin=True
    )
    try:
        client = TestClient(app)
        resp = client.get("/api/v1/admin/ops")
    finally:
        app.dependency_overrides.pop(require_admin, None)

    assert resp.status_code == 200
    assert "text/html" in resp.headers["content-type"]
    assert "/api/v1/admin/ops/data" in resp.text
