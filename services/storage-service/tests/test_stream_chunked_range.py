"""Tests for stream_chunked_range() CAS block decompression.

Covers Fix 15: Python fallback decompression, size validation,
and magic-byte safety net for zstd-compressed CAS blocks.
"""

import asyncio
import hashlib
import os
import tempfile
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import zstandard
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

BLOCK_HASH = "abcdef1234567890" * 4  # 64-char hex string
USER_ID = "test-user-id-1234"


def _convergent_encrypt(plaintext: bytes, block_hash: str, user_id: str) -> bytes:
    """Replicate the convergent encryption used by the Rust data plane."""
    content_hash_bytes = bytes.fromhex(block_hash)
    salt = hashlib.sha256(f"dedup_user_{user_id}_salt".encode()).digest()
    block_key = hashlib.pbkdf2_hmac("sha256", content_hash_bytes, salt, 100000, dklen=32)
    nonce = os.urandom(12)
    cipher = Cipher(algorithms.AES(block_key), modes.GCM(nonce), backend=default_backend())
    encryptor = cipher.encryptor()
    ciphertext = encryptor.update(plaintext) + encryptor.finalize()
    return nonce + encryptor.tag + ciphertext


def _make_file_obj(user_id: str, chunk_info: dict):
    """Create a minimal mock file object for stream_chunked_range."""
    obj = MagicMock()
    obj.user_id = user_id
    obj.chunk_info = chunk_info
    return obj


async def _collect_stream(gen):
    """Collect all bytes from an async generator."""
    result = b""
    async for chunk in gen:
        result += chunk
    return result


# ---------------------------------------------------------------------------
# Test 1: Python fallback decompresses was_compressed=true blocks
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_python_fallback_decompresses_compressed_block():
    """When Rust convergent_decrypt fails, the Python fallback must decompress."""
    from app.routers.files import stream_chunked_range

    # Create test data
    original_plaintext = os.urandom(50_000)
    cctx = zstandard.ZstdCompressor()
    compressed = cctx.compress(original_plaintext)
    assert len(compressed) != len(original_plaintext)

    # Encrypt the compressed data (as the Rust batch endpoint would)
    encrypted = _convergent_encrypt(compressed, BLOCK_HASH, USER_ID)

    # Write encrypted block to temp CAS file
    with tempfile.NamedTemporaryFile(delete=False, suffix=".enc") as f:
        f.write(encrypted)
        cas_path = f.name

    try:
        chunk_info = {
            "blocks": [{"hash": BLOCK_HASH, "size": len(original_plaintext), "offset": 0}],
            "stored_blocks": [
                {
                    "hash": BLOCK_HASH,
                    "path": cas_path,
                    "size": len(original_plaintext),
                    "offset": 0,
                    "was_compressed": True,
                }
            ],
            "version": 2,
            "convergent_encryption": True,
        }
        file_obj = _make_file_obj(USER_ID, chunk_info)

        # Force Rust path to fail so Python fallback is used
        with patch("app.services.rust_dataplane_client.get_rust_client", side_effect=RuntimeError("Rust unavailable")):
            result = await _collect_stream(
                stream_chunked_range(
                    file_obj, 0, len(original_plaintext) - 1, None, None
                )
            )

        assert result == original_plaintext
    finally:
        os.unlink(cas_path)


# ---------------------------------------------------------------------------
# Test 2: Size mismatch after decrypt raises RuntimeError
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_size_mismatch_raises_runtime_error():
    """If decrypted block size != expected, stream must abort with RuntimeError."""
    from app.routers.files import stream_chunked_range

    # Create data where decrypted size won't match expected
    actual_data = os.urandom(40_000)
    expected_size = 50_000  # Mismatch!
    encrypted = _convergent_encrypt(actual_data, BLOCK_HASH, USER_ID)

    with tempfile.NamedTemporaryFile(delete=False, suffix=".enc") as f:
        f.write(encrypted)
        cas_path = f.name

    try:
        chunk_info = {
            "blocks": [{"hash": BLOCK_HASH, "size": expected_size, "offset": 0}],
            "stored_blocks": [
                {
                    "hash": BLOCK_HASH,
                    "path": cas_path,
                    "size": expected_size,
                    "offset": 0,
                    "was_compressed": False,
                }
            ],
            "version": 2,
            "convergent_encryption": True,
        }
        file_obj = _make_file_obj(USER_ID, chunk_info)

        with patch("app.services.rust_dataplane_client.get_rust_client", side_effect=RuntimeError("Rust unavailable")):
            with pytest.raises(RuntimeError, match="size mismatch"):
                await _collect_stream(
                    stream_chunked_range(
                        file_obj, 0, expected_size - 1, None, None
                    )
                )
    finally:
        os.unlink(cas_path)


# ---------------------------------------------------------------------------
# Test 3: Magic-byte safety net — Rust returns still-compressed bytes
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_magic_byte_safety_net_decompresses():
    """If Rust returns still-compressed data, magic-byte detector re-decompresses."""
    from app.routers.files import stream_chunked_range

    original_plaintext = os.urandom(50_000)
    cctx = zstandard.ZstdCompressor()
    compressed = cctx.compress(original_plaintext)

    # Mock Rust to return compressed bytes (as if it skipped decompression)
    mock_client = AsyncMock()
    mock_client.convergent_decrypt = AsyncMock(return_value=compressed)

    encrypted_dummy = b"\x00" * 100  # Won't be used since Rust is mocked

    with tempfile.NamedTemporaryFile(delete=False, suffix=".enc") as f:
        f.write(encrypted_dummy)
        cas_path = f.name

    try:
        chunk_info = {
            "blocks": [{"hash": BLOCK_HASH, "size": len(original_plaintext), "offset": 0}],
            "stored_blocks": [
                {
                    "hash": BLOCK_HASH,
                    "path": cas_path,
                    "size": len(original_plaintext),
                    "offset": 0,
                    "was_compressed": True,
                }
            ],
            "version": 2,
            "convergent_encryption": True,
        }
        file_obj = _make_file_obj(USER_ID, chunk_info)

        with patch("app.services.rust_dataplane_client.get_rust_client", return_value=mock_client):
            result = await _collect_stream(
                stream_chunked_range(
                    file_obj, 0, len(original_plaintext) - 1, None, None
                )
            )

        assert result == original_plaintext
    finally:
        os.unlink(cas_path)


# ---------------------------------------------------------------------------
# Test 4: Magic-byte safety net — second decompress fails
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_magic_byte_safety_net_fails_raises():
    """If magic-byte detector tries decompress and it fails, abort with RuntimeError."""
    from app.routers.files import stream_chunked_range

    # Craft data that starts with zstd magic but isn't valid zstd
    fake_compressed = b"\x28\xb5\x2f\xfd" + os.urandom(1000)
    expected_size = 50_000  # Different from len(fake_compressed)

    mock_client = AsyncMock()
    mock_client.convergent_decrypt = AsyncMock(return_value=fake_compressed)

    with tempfile.NamedTemporaryFile(delete=False, suffix=".enc") as f:
        f.write(b"\x00" * 100)
        cas_path = f.name

    try:
        chunk_info = {
            "blocks": [{"hash": BLOCK_HASH, "size": expected_size, "offset": 0}],
            "stored_blocks": [
                {
                    "hash": BLOCK_HASH,
                    "path": cas_path,
                    "size": expected_size,
                    "offset": 0,
                    "was_compressed": True,
                }
            ],
            "version": 2,
            "convergent_encryption": True,
        }
        file_obj = _make_file_obj(USER_ID, chunk_info)

        with patch("app.services.rust_dataplane_client.get_rust_client", return_value=mock_client):
            with pytest.raises(RuntimeError, match="decompression failed"):
                await _collect_stream(
                    stream_chunked_range(
                        file_obj, 0, expected_size - 1, None, None
                    )
                )
    finally:
        os.unlink(cas_path)
