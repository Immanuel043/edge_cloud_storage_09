"""Unit tests for `BackupService.backup_to_local_disk`.

Covers:
1. Happy path — single-storage row copied to sharded backup tree.
2. Idempotent re-run — destination already has matching size; no copy.
3. Inline-storage row — returns 'inline:db', no file written.
4. Source blob missing — FileNotFoundError propagates.
5. Unsupported storage_type (chunked/content_addressed) — NotImplementedError.
6. Malformed row missing content_hash — ValueError.
7. Tmp-file cleanup on copy failure.
"""

import os
from unittest.mock import MagicMock, patch

import pytest


def _obj(
    storage_type="single",
    object_path="/storage/cache/aa/blob.enc",
    content_hash="ab" * 32,
    obj_id="obj-1",
):
    o = MagicMock()
    o.id = obj_id
    o.storage_type = storage_type
    o.object_path = object_path
    o.content_hash = content_hash
    return o


def _service(backup_root):
    from app.services.backup import BackupService

    svc = BackupService()
    svc.backup_root = str(backup_root)
    return svc


@pytest.mark.asyncio
async def test_single_storage_happy_path(tmp_path):
    src = tmp_path / "src.enc"
    src.write_bytes(b"x" * 1234)
    backup_root = tmp_path / "backup"

    obj = _obj(object_path=str(src), content_hash="ab" * 32)
    svc = _service(backup_root)

    location = await svc.backup_to_local_disk(obj)

    expected_rel = os.path.join("ab", f"{'ab' * 32}.enc")
    assert location == f"local:{expected_rel}"
    dst = backup_root / expected_rel
    assert dst.exists()
    assert dst.read_bytes() == b"x" * 1234


@pytest.mark.asyncio
async def test_idempotent_skip_when_dest_size_matches(tmp_path):
    src = tmp_path / "src.enc"
    src.write_bytes(b"y" * 100)
    backup_root = tmp_path / "backup"

    obj = _obj(object_path=str(src), content_hash="cd" * 32)
    svc = _service(backup_root)

    await svc.backup_to_local_disk(obj)

    # Pre-stage the dst with matching size, then confirm second call doesn't rewrite it.
    dst = backup_root / "cd" / f"{'cd' * 32}.enc"
    pre_mtime = dst.stat().st_mtime_ns
    dst.write_bytes(b"y" * 100)  # rewrite to bump mtime baseline
    pre_mtime = dst.stat().st_mtime_ns

    location = await svc.backup_to_local_disk(obj)
    assert location.endswith(f"{'cd' * 32}.enc")
    assert dst.stat().st_mtime_ns == pre_mtime  # not re-copied


@pytest.mark.asyncio
async def test_inline_returns_db_marker_without_writing(tmp_path):
    backup_root = tmp_path / "backup"
    obj = _obj(storage_type="inline", object_path=None, content_hash=None)
    svc = _service(backup_root)

    location = await svc.backup_to_local_disk(obj)

    assert location == "inline:db"
    assert not backup_root.exists() or list(backup_root.iterdir()) == []


@pytest.mark.asyncio
async def test_source_missing_raises_filenotfound(tmp_path):
    backup_root = tmp_path / "backup"
    obj = _obj(object_path=str(tmp_path / "nope.enc"), content_hash="ee" * 32)
    svc = _service(backup_root)

    with pytest.raises(FileNotFoundError):
        await svc.backup_to_local_disk(obj)


@pytest.mark.parametrize("storage_type", ["chunked", "content_addressed"])
@pytest.mark.asyncio
async def test_unsupported_storage_types_raise(tmp_path, storage_type):
    backup_root = tmp_path / "backup"
    obj = _obj(storage_type=storage_type)
    svc = _service(backup_root)

    with pytest.raises(NotImplementedError):
        await svc.backup_to_local_disk(obj)


@pytest.mark.asyncio
async def test_missing_content_hash_raises_valueerror(tmp_path):
    src = tmp_path / "src.enc"
    src.write_bytes(b"z")
    backup_root = tmp_path / "backup"
    obj = _obj(object_path=str(src), content_hash=None)
    svc = _service(backup_root)

    with pytest.raises(ValueError):
        await svc.backup_to_local_disk(obj)


@pytest.mark.asyncio
async def test_tmp_file_cleaned_up_on_copy_failure(tmp_path):
    src = tmp_path / "src.enc"
    src.write_bytes(b"abc")
    backup_root = tmp_path / "backup"

    obj = _obj(object_path=str(src), content_hash="ff" * 32)
    svc = _service(backup_root)

    real_replace = os.replace

    def boom(*args, **kwargs):
        raise OSError("simulated failure during atomic rename")

    with patch("app.services.backup.os.replace", side_effect=boom):
        with pytest.raises(OSError):
            await svc.backup_to_local_disk(obj)

    # The temp file must not be left behind.
    shard = backup_root / "ff"
    if shard.exists():
        leftover = [p.name for p in shard.iterdir()]
        assert all(not n.endswith(".tmp") for n in leftover), leftover
