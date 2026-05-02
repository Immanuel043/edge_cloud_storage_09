"""Cancellation-safe file-streaming helpers for streaming responses.

Streaming-response generators (those whose output is consumed by Starlette's
`StreamingResponse`) cannot use `async with aiofiles.open(...)` because the
context manager's `__aexit__` awaits to close the file — an `await` during
PEP 525 generator cleanup that races with `aclose()` from outer layers and
raises `RuntimeError: aclose(): asynchronous generator is already running`
on client disconnect.

This module provides two helpers that own the file handle outside the async
cleanup path:

- `iter_file_chunks` — async generator yielding bytes from a file with
  range support. Uses sync `open()` + `try`/`finally` with sync `close()`.
  No `async with`, no `await` in finally. Reads run off-thread via
  `asyncio.to_thread` so the event loop is not blocked.
- `_read_all_bytes` — sync helper for the case where we want the entire
  contents of a file as bytes (used via `asyncio.to_thread`).

See `tests/unit/test_file_streaming.py` for coverage of range arithmetic
and cancellation behavior.

Note on `to_thread` cancellation: when the generator is closed mid-
`asyncio.to_thread(f.read, n)`, the future is cancelled but the underlying
thread continues its current `read(<= block_size)` call. The buffered
result is discarded by the cancelled future; `f.close()` then runs in
`finally`. POSIX permits closing an FD while another thread reads it; the
read returns EBADF or completes with already-buffered data. Benign for
read-only file streaming — see plan risk register for full discussion.
"""
import asyncio
from typing import AsyncGenerator, Optional


async def iter_file_chunks(
    path: str,
    start: int = 0,
    end: Optional[int] = None,
    block_size: int = 1024 * 1024,
) -> AsyncGenerator[bytes, None]:
    """Yield bytes from a file, range-aware, cancellation-safe.

    Args:
        path: File to stream.
        start: Byte offset to seek to before first read (default 0).
        end: Inclusive end byte; None = read to EOF.
        block_size: Max bytes per yield (default 1 MiB).

    Yields:
        Successive byte chunks of size <= block_size. Final chunk may be smaller.
    """
    f = open(path, "rb")
    try:
        if start:
            await asyncio.to_thread(f.seek, start)
        remaining: Optional[int] = (end - start + 1) if end is not None else None
        while True:
            to_read = block_size if remaining is None else min(block_size, remaining)
            if to_read <= 0:
                break
            chunk = await asyncio.to_thread(f.read, to_read)
            if not chunk:
                break
            yield chunk
            if remaining is not None:
                remaining -= len(chunk)
    finally:
        f.close()  # sync — no await, no PEP 525 race


def _read_all_bytes(path: str) -> bytes:
    """Synchronously read the entire file at `path` into memory.

    Intended to be invoked via `await asyncio.to_thread(_read_all_bytes, path)`
    from streaming-response generators that need to read a whole encrypted
    chunk before yielding decrypted bytes.
    """
    with open(path, "rb") as f:
        return f.read()
