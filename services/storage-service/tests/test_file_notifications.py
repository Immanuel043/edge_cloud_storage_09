import asyncio
import json
import importlib
import os
import sys
import types
from unittest.mock import AsyncMock

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://x:x@localhost:5432/test")
os.environ.setdefault("SECRET_KEY", "test_secret_key_for_testing_only_32b")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

routers_pkg = types.ModuleType("app.routers")
routers_pkg.__path__ = [os.path.join(os.path.dirname(__file__), "..", "app", "routers")]
sys.modules["app.routers"] = routers_pkg
sys.modules.setdefault("psutil", types.ModuleType("psutil"))
aiokafka_stub = types.ModuleType("aiokafka")
aiokafka_stub.AIOKafkaProducer = object
sys.modules.setdefault("aiokafka", aiokafka_stub)
fastapi_limiter_stub = types.ModuleType("fastapi_limiter")
fastapi_limiter_depends_stub = types.ModuleType("fastapi_limiter.depends")


class RateLimiterStub:
    def __init__(self, *args, **kwargs):
        pass

    async def __call__(self, *args, **kwargs):
        return None


fastapi_limiter_depends_stub.RateLimiter = RateLimiterStub
sys.modules.setdefault("fastapi_limiter", fastapi_limiter_stub)
sys.modules.setdefault("fastapi_limiter.depends", fastapi_limiter_depends_stub)
slowapi_stub = types.ModuleType("slowapi")
slowapi_util_stub = types.ModuleType("slowapi.util")
slowapi_util_stub.get_remote_address = lambda request: "127.0.0.1"
sys.modules.setdefault("slowapi", slowapi_stub)
sys.modules.setdefault("slowapi.util", slowapi_util_stub)

files_router = importlib.import_module("app.routers.files")  # noqa: E402
websocket_router = importlib.import_module("app.routers.websocket")  # noqa: E402


class FakeRedis:
    def __init__(self):
        self.publish_calls = []

    async def publish(self, channel, message):
        self.publish_calls.append((channel, message))


def _run(coro):
    return asyncio.run(coro)


def test_single_file_deleted_notification_publish(monkeypatch):
    fake_redis = FakeRedis()
    monkeypatch.setattr(files_router, "get_redis", AsyncMock(return_value=fake_redis))

    _run(
        files_router._publish_file_deleted_notifications(
            "user-1",
            [
                {
                    "file_id": "file-1",
                    "file_name": "report.pdf",
                    "folder_id": "folder-1",
                }
            ],
        )
    )

    assert len(fake_redis.publish_calls) == 1
    channel, message = fake_redis.publish_calls[0]
    assert channel == "file_notifications"
    payload = json.loads(message)
    assert payload == {
        "event": "file_deleted",
        "user_id": "user-1",
        "file_id": "file-1",
        "file_name": "report.pdf",
        "folder_id": "folder-1",
    }


def test_bulk_file_deleted_notification_publish(monkeypatch):
    fake_redis = FakeRedis()
    monkeypatch.setattr(files_router, "get_redis", AsyncMock(return_value=fake_redis))

    _run(
        files_router._publish_file_deleted_notifications(
            "user-1",
            [
                {"file_id": "file-1", "file_name": "one.txt", "folder_id": None},
                {"file_id": "file-2", "file_name": "two.txt", "folder_id": "folder-2"},
            ],
        )
    )

    assert len(fake_redis.publish_calls) == 2
    published = [json.loads(message) for _, message in fake_redis.publish_calls]
    assert [payload["file_id"] for payload in published] == ["file-1", "file-2"]
    assert all(payload["event"] == "file_deleted" for payload in published)


def test_file_created_notification_maps_to_file_uploaded():
    payload = websocket_router._build_file_notification_payload(
        {
            "event": "file_created",
            "file_id": "file-1",
            "file_name": "report.pdf",
            "file_size": 123,
            "mime_type": "application/pdf",
            "folder_id": "folder-1",
            "storage_type": "single",
        }
    )

    assert payload is not None
    assert payload["type"] == "notification"
    assert payload["event"] == "file_uploaded"
    assert payload["data"] == {
        "file_id": "file-1",
        "file_name": "report.pdf",
        "file_size": 123,
        "mime_type": "application/pdf",
        "folder_id": "folder-1",
        "storage_type": "single",
    }


def test_file_deleted_notification_maps_to_file_deleted():
    payload = websocket_router._build_file_notification_payload(
        {
            "event": "file_deleted",
            "file_id": "file-1",
            "file_name": "report.pdf",
            "folder_id": None,
        }
    )

    assert payload is not None
    assert payload["type"] == "notification"
    assert payload["event"] == "file_deleted"
    assert payload["data"] == {
        "file_id": "file-1",
        "file_name": "report.pdf",
        "folder_id": None,
    }


def test_unknown_file_notification_event_is_skipped():
    assert websocket_router._build_file_notification_payload({"event": "file_renamed"}) is None
