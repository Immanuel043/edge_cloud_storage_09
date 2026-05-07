"""Unit tests for ColdStorageTieringService missing-file healing.

Covers:
1. Selection query filters out broken/deleted/no-path rows (age-based).
2. Selection query filters out broken/deleted/no-path rows (capacity-based).
3. Preflight branch heals — marks broken + emits audit.
4. Move-time FileNotFoundError heals.
5. Move-time OSError(ENOENT) heals.
6. Other exceptions (PermissionError) do NOT mark broken.
7. Happy path regression — no spurious broken-marking.
"""

import errno
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _make_to_thread(move_side_effect=None):
    """Return an async fake for asyncio.to_thread.

    The preflight `os.path.exists` and the move both go through
    asyncio.to_thread; we run the callable for `os.path.exists`
    (so module-level patches still work) and substitute behavior
    for any other callable (the move).
    """
    import os as _os

    async def fake(fn, *args, **kwargs):
        if fn is _os.path.exists:
            return fn(*args, **kwargs)
        if move_side_effect is None:
            return None
        if isinstance(move_side_effect, Exception):
            raise move_side_effect
        if callable(move_side_effect):
            return move_side_effect(*args, **kwargs)
        return move_side_effect

    return fake


@pytest.fixture
def service():
    from app.services.cold_storage_tiering import ColdStorageTieringService

    return ColdStorageTieringService()


@pytest.fixture
def fake_object():
    obj = MagicMock()
    obj.id = "obj-1"
    obj.user_id = "user-1"
    obj.file_name = "test.bin"
    obj.storage_tier = "warm"
    obj.object_path = "/storage/warm/objects/obj-1.enc"
    obj.is_deleted = False
    obj.health_status = "healthy"
    obj.health_checked_at = None
    obj.file_metadata = {}
    return obj


# ---------------------------------------------------------------------------
# Fix 1: selection-query filters
# ---------------------------------------------------------------------------


def test_age_based_query_includes_health_and_deleted_filters():
    """The age-based selection query must filter out broken/deleted rows."""
    import inspect

    from app.services import cold_storage_tiering

    src = inspect.getsource(cold_storage_tiering.ColdStorageTieringService._tier_files)
    assert "Object.is_deleted == False" in src
    assert 'Object.health_status != "broken"' in src
    assert "Object.object_path.isnot(None)" in src


def test_capacity_query_includes_all_filters():
    """The capacity-based query must filter out broken/deleted/no-path rows."""
    import inspect

    from app.services import cold_storage_tiering

    src = inspect.getsource(cold_storage_tiering.ColdStorageTieringService._check_tier_capacity)
    assert "Object.is_deleted == False" in src
    assert 'Object.health_status != "broken"' in src
    assert "Object.object_path.isnot(None)" in src


# ---------------------------------------------------------------------------
# Fix 2: heal paths
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_preflight_missing_marks_broken_and_emits_audit(service, fake_object):
    db = AsyncMock()
    with patch(
        "app.services.cold_storage_tiering.os.path.exists", return_value=False
    ), patch.object(
        service, "_emit_drift_audit", new_callable=AsyncMock
    ) as audit_mock:
        result = await service._move_file_to_tier(fake_object, "cold", db)

    assert result is False
    assert fake_object.health_status == "broken"
    assert fake_object.health_checked_at is not None
    audit_mock.assert_awaited_once()
    kwargs = audit_mock.await_args.kwargs
    assert kwargs.get("cause") == "preflight_missing"


@pytest.mark.asyncio
async def test_move_time_file_not_found_marks_broken(service, fake_object):
    db = AsyncMock()
    err = FileNotFoundError(errno.ENOENT, "gone")
    with patch(
        "app.services.cold_storage_tiering.os.path.exists", return_value=True
    ), patch(
        "app.services.cold_storage_tiering.os.makedirs"
    ), patch(
        "app.services.cold_storage_tiering.asyncio.to_thread",
        side_effect=_make_to_thread(move_side_effect=err),
    ), patch.object(
        service, "_emit_drift_audit", new_callable=AsyncMock
    ) as audit_mock:
        result = await service._move_file_to_tier(fake_object, "cold", db)

    assert result is False
    assert fake_object.health_status == "broken"
    assert fake_object.storage_tier == "warm"
    audit_mock.assert_awaited_once()
    assert audit_mock.await_args.kwargs.get("cause") == "move_time_missing"


@pytest.mark.asyncio
async def test_move_time_oserror_enoent_marks_broken(service, fake_object):
    db = AsyncMock()
    # Plain OSError (without ENOENT-arg auto-promotion to FileNotFoundError)
    # so the OSError-branch ENOENT handler is exercised.
    err = OSError("simulated enoent")
    err.errno = errno.ENOENT
    err.filename = "/some/path"
    with patch(
        "app.services.cold_storage_tiering.os.path.exists", return_value=True
    ), patch(
        "app.services.cold_storage_tiering.os.makedirs"
    ), patch(
        "app.services.cold_storage_tiering.asyncio.to_thread",
        side_effect=_make_to_thread(move_side_effect=err),
    ), patch.object(
        service, "_emit_drift_audit", new_callable=AsyncMock
    ) as audit_mock:
        result = await service._move_file_to_tier(fake_object, "cold", db)

    assert result is False
    assert fake_object.health_status == "broken"
    audit_mock.assert_awaited_once()
    cause = audit_mock.await_args.kwargs.get("cause", "")
    assert cause.startswith("move_time_enoent:")


@pytest.mark.asyncio
async def test_permission_error_does_not_mark_broken(service, fake_object):
    """PermissionError is NOT a missing-file signal — must not flip health."""
    db = AsyncMock()
    with patch(
        "app.services.cold_storage_tiering.os.path.exists", return_value=True
    ), patch(
        "app.services.cold_storage_tiering.os.makedirs"
    ), patch(
        "app.services.cold_storage_tiering.asyncio.to_thread",
        side_effect=_make_to_thread(move_side_effect=PermissionError("denied")),
    ), patch.object(
        service, "_emit_drift_audit", new_callable=AsyncMock
    ) as audit_mock:
        result = await service._move_file_to_tier(fake_object, "cold", db)

    assert result is False
    assert fake_object.health_status == "healthy"
    audit_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_happy_path_no_audit_no_broken_flip(service, fake_object):
    """Successful move must not touch health_status, must not emit audit."""
    db = AsyncMock()
    with patch(
        "app.services.cold_storage_tiering.os.path.exists", return_value=True
    ), patch(
        "app.services.cold_storage_tiering.os.makedirs"
    ), patch(
        "app.services.cold_storage_tiering.asyncio.to_thread",
        side_effect=_make_to_thread(),
    ), patch.object(
        service, "_emit_drift_audit", new_callable=AsyncMock
    ) as audit_mock:
        result = await service._move_file_to_tier(fake_object, "cold", db)

    assert result is True
    assert fake_object.storage_tier == "cold"
    assert fake_object.health_status == "healthy"
    audit_mock.assert_not_awaited()
