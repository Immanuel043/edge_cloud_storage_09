"""Unit tests for iter_decrypted_chunks async generator.

Covers the streaming chunk source used by the new INSTREAM virus-scan path:
  * Yields one plaintext per chunk in order.
  * Decompresses each chunk when chunk_info.compressed is True, skips otherwise.
  * Surfaces FileNotFoundError on a missing chunk path.
  * Raises ValueError when chunk_info.count is non-positive.
  * Falls back to the shard-derived chunk path when paths[i] is missing
    (matches the canonical reassembly helper's behavior).

Run with: python -m pytest services/storage-service/tests/testiter_decrypted_chunks.py -v
"""

import os
import sys
from types import SimpleNamespace
from unittest.mock import patch

import pytest

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://x:x@localhost:5432/test")
os.environ.setdefault("SECRET_KEY", "test_secret_key_for_testing_only_32b")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.services.scan_streaming import iter_decrypted_chunks  # noqa: E402


def _fake_object(tmp_path, *, count: int, compressed: bool = False, paths_override=None):
    """Build a chunk-storage Object stub. Writes `count` placeholder ciphertext
    files so the existence checks in the generator pass."""
    upload_id = "abcdef0123"
    paths = {}
    for i in range(count):
        chunk_path = tmp_path / f"{upload_id}_chunk_{i}.enc"
        chunk_path.write_bytes(b"CIPHERTEXT-" + str(i).encode())
        paths[str(i)] = str(chunk_path)
    if paths_override is not None:
        paths = paths_override
    return SimpleNamespace(
        id="00000000-0000-0000-0000-000000000001",
        chunk_info={
            "count": count,
            "compressed": compressed,
            "upload_id": upload_id,
            "paths": paths,
        },
    )


@pytest.mark.asyncio
async def test_yields_one_plaintext_per_chunk_in_order(tmp_path):
    file_obj = _fake_object(tmp_path, count=3, compressed=False)

    def fake_decrypt(encrypted, key, idx):
        return f"plain-{idx}".encode()

    fake_decompressor = type("FakeDecompressor", (), {"decompress": lambda self, b: b})()
    with patch("app.services.scan_streaming.encryption_service.decrypt_chunk", side_effect=fake_decrypt):
        with patch("app.services.scan_streaming.decompressor", fake_decompressor):
            collected = [c async for c in iter_decrypted_chunks(file_obj, b"k" * 32)]

    assert collected == [b"plain-0", b"plain-1", b"plain-2"]


@pytest.mark.asyncio
async def test_decompresses_when_chunk_info_marks_compressed(tmp_path):
    file_obj = _fake_object(tmp_path, count=2, compressed=True)

    def fake_decrypt(encrypted, key, idx):
        return b"COMPRESSED-" + str(idx).encode()

    call_log = []

    class FakeDecompressor:
        def decompress(self, buf):
            call_log.append(buf)
            return b"DECOMPRESSED-" + buf

    with patch("app.services.scan_streaming.encryption_service.decrypt_chunk", side_effect=fake_decrypt):
        with patch("app.services.scan_streaming.decompressor", FakeDecompressor()):
            collected = [c async for c in iter_decrypted_chunks(file_obj, b"k" * 32)]

    assert collected == [
        b"DECOMPRESSED-COMPRESSED-0",
        b"DECOMPRESSED-COMPRESSED-1",
    ]
    assert len(call_log) == 2


@pytest.mark.asyncio
async def test_invalid_chunk_count_raises(tmp_path):
    file_obj = _fake_object(tmp_path, count=0)

    with patch("app.services.scan_streaming.encryption_service.decrypt_chunk"):
        with pytest.raises(ValueError):
            async for _ in iter_decrypted_chunks(file_obj, b"k" * 32):
                pass


@pytest.mark.asyncio
async def test_missing_chunk_path_raises(tmp_path):
    file_obj = _fake_object(tmp_path, count=2)
    # Wipe chunk 1 from disk and from paths map; the generator falls back
    # to the shard-derived path which also doesn't exist, so it raises.
    os.unlink(file_obj.chunk_info["paths"]["1"])
    file_obj.chunk_info["paths"].pop("1")

    with patch("app.services.scan_streaming.encryption_service.decrypt_chunk", return_value=b"x"):
        with pytest.raises(FileNotFoundError):
            async for _ in iter_decrypted_chunks(file_obj, b"k" * 32):
                pass


@pytest.mark.asyncio
async def test_path_fallback_uses_shard_directory(tmp_path, monkeypatch):
    """When paths[i] is absent, the helper looks under
    /app/storage/cache/<shard>/<upload_id>_chunk_<i>.enc. Patch os.path.exists
    so the canonical fallback resolves to our tmp file."""
    upload_id = "abcdef0123"
    fallback_dir = tmp_path / "fallback"
    fallback_dir.mkdir()
    chunk0 = fallback_dir / f"{upload_id}_chunk_0.enc"
    chunk0.write_bytes(b"CIPHERTEXT-fallback")

    file_obj = SimpleNamespace(
        id="00000000-0000-0000-0000-000000000001",
        chunk_info={
            "count": 1,
            "compressed": False,
            "upload_id": upload_id,
            "paths": {},
        },
    )

    expected_fallback = f"/app/storage/cache/{upload_id[:2]}/{upload_id}_chunk_0.enc"
    real_exists = os.path.exists

    def fake_exists(p):
        if p == expected_fallback:
            return True
        return real_exists(p)

    real_open = os.open  # not used; aiofiles uses io under the hood

    def fake_decrypt(enc, key, idx):
        assert enc == b"CIPHERTEXT-fallback"
        return b"plain-fallback"

    monkeypatch.setattr("app.services.scan_streaming.os.path.exists", fake_exists)

    # Patch aiofiles.open to redirect the synthetic /app/... path to our tmp file.
    import aiofiles
    real_aiofiles_open = aiofiles.open

    def fake_aiofiles_open(path, *args, **kwargs):
        if path == expected_fallback:
            return real_aiofiles_open(str(chunk0), *args, **kwargs)
        return real_aiofiles_open(path, *args, **kwargs)

    monkeypatch.setattr("app.services.scan_streaming.aiofiles.open", fake_aiofiles_open)

    with patch("app.services.scan_streaming.encryption_service.decrypt_chunk", side_effect=fake_decrypt):
        collected = [c async for c in iter_decrypted_chunks(file_obj, b"k" * 32)]

    assert collected == [b"plain-fallback"]
