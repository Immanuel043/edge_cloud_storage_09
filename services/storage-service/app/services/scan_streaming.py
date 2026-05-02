"""Streaming sources for the virus scanner.

Lives in ``app/services`` rather than inside the upload router so that
operational scripts and unit tests can import the chunk iterator without
pulling the entire router stack (which depends on settings, redis, billing
etc.) into their import graph.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, AsyncGenerator

import aiofiles

from ..utils.compression import decompressor
from ..utils.file_streaming import _read_all_bytes
from .encryption import encryption_service


async def iter_decrypted_chunks(file_obj: Any, file_key: bytes) -> AsyncGenerator[bytes, None]:
    """Yield decrypted (+ optionally decompressed) plaintext bytes per chunk.

    Mirrors the loop in `_reassemble_chunked_file_for_scan` but emits chunks
    rather than writing them to a temp file — used by the streaming virus scan
    path so we never materialize the full plaintext on disk.

    Per-chunk decrypt and decompress run on a worker thread so AES-GCM and
    zstd don't block the asyncio event loop. Memory peak is one encrypted
    chunk + one plaintext chunk (~128 MB worst case for 64 MB chunks).
    """
    chunk_info = file_obj.chunk_info or {}
    paths = chunk_info.get("paths") or {}
    count = int(chunk_info.get("count") or 0)
    compressed = bool(chunk_info.get("compressed"))
    upload_id = chunk_info.get("upload_id") or str(file_obj.id)
    if count <= 0:
        raise ValueError(f"Invalid chunk_info for file {file_obj.id}")

    for i in range(count):
        chunk_path = paths.get(str(i))
        if not chunk_path or not os.path.exists(chunk_path):
            shard = upload_id[:2]
            chunk_path = f"/app/storage/cache/{shard}/{upload_id}_chunk_{i}.enc"
        if not os.path.exists(chunk_path):
            raise FileNotFoundError(f"Missing chunk {i} for file {file_obj.id} at {chunk_path!r}")
        # Sync open via to_thread — async-with inside this streaming
        # generator races with PEP 525 cleanup on cancellation.
        encrypted = await asyncio.to_thread(_read_all_bytes, chunk_path)
        plaintext = await asyncio.to_thread(
            encryption_service.decrypt_chunk, encrypted, file_key, i
        )
        if compressed:
            plaintext = await asyncio.to_thread(decompressor.decompress, plaintext)
        yield plaintext
