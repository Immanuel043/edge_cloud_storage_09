"""Unit tests for BackupWorker.

Covers:
1. Selection query filters: pending + not-deleted + not-broken.
2. Successful row → backup_status='completed', backup_location set.
3. FileNotFoundError → backup_status='source_missing'.
4. NotImplementedError → backup_status='unsupported'.
5. Other exceptions → backup_status='failed'.
"""

import inspect
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def worker():
    from app.workers.backup_worker import BackupWorker

    return BackupWorker()


def test_selection_query_has_required_filters():
    """Static check on _cycle source: selection must filter pending/deleted/broken."""
    from app.workers import backup_worker as bw_mod

    src = inspect.getsource(bw_mod.BackupWorker._cycle)
    assert 'Object.backup_status == "pending"' in src
    assert "Object.is_deleted.is_(False)" in src
    assert 'Object.health_status != "broken"' in src


@pytest.mark.asyncio
async def test_backup_one_completed(worker):
    obj = MagicMock(id="o1", file_name="a.bin", storage_type="single")
    fake_backup = AsyncMock(return_value="local:ab/abc.enc")

    with patch("app.workers.backup_worker.backup_service") as svc:
        svc.backup_to_local_disk = fake_backup
        status, location = await worker._backup_one(obj)

    assert status == "completed"
    assert location == "local:ab/abc.enc"


@pytest.mark.asyncio
async def test_backup_one_source_missing(worker):
    obj = MagicMock(id="o2", file_name="b.bin", storage_type="single")
    fake_backup = AsyncMock(side_effect=FileNotFoundError("/missing.enc"))

    with patch("app.workers.backup_worker.backup_service") as svc:
        svc.backup_to_local_disk = fake_backup
        status, location = await worker._backup_one(obj)

    assert status == "source_missing"
    assert location is None


@pytest.mark.asyncio
async def test_backup_one_unsupported(worker):
    obj = MagicMock(id="o3", file_name="c.bin", storage_type="chunked")
    fake_backup = AsyncMock(side_effect=NotImplementedError("chunked"))

    with patch("app.workers.backup_worker.backup_service") as svc:
        svc.backup_to_local_disk = fake_backup
        status, location = await worker._backup_one(obj)

    assert status == "unsupported"
    assert location is None


@pytest.mark.asyncio
async def test_backup_one_failed_unexpected(worker):
    obj = MagicMock(id="o4", file_name="d.bin", storage_type="single")
    fake_backup = AsyncMock(side_effect=PermissionError("no perms"))

    with patch("app.workers.backup_worker.backup_service") as svc:
        svc.backup_to_local_disk = fake_backup
        status, location = await worker._backup_one(obj)

    assert status == "failed"
    assert location is None
