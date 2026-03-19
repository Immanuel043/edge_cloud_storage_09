"""Per-file locks for coordinating concurrent background workers.

Provides atomic non-blocking try_acquire() for dedup (never blocks the
serial queue) and async acquire() for video (can wait for dedup to finish).
"""

import asyncio
from typing import Dict


class FileLock:
    """Per-file coordination lock with atomic non-blocking try-acquire.

    Unlike asyncio.Lock, this supports a synchronous try_acquire() that
    atomically checks-and-claims with no await — guaranteed atomic in
    asyncio's single-threaded cooperative model.
    """

    __slots__ = ("_held", "_release_event")

    def __init__(self):
        self._held = False
        self._release_event = asyncio.Event()
        self._release_event.set()  # starts unlocked

    # -- non-blocking path (dedup) --

    def try_acquire(self) -> bool:
        """Atomically claim if free. Fully synchronous — no await, no interleaving.

        Returns True if acquired (caller MUST call release()).
        Returns False if already held (caller should defer).
        """
        if self._held:
            return False
        self._held = True
        self._release_event.clear()
        return True

    # -- blocking path (video) --

    async def acquire(self):
        """Wait until free, then acquire. For callers that can block."""
        while True:
            await self._release_event.wait()
            if self.try_acquire():
                return

    def release(self):
        """Release the lock and wake any waiters."""
        self._held = False
        self._release_event.set()

    # -- context manager for video (blocking acquire) --

    async def __aenter__(self):
        await self.acquire()
        return self

    async def __aexit__(self, *args):
        self.release()


_file_locks: Dict[str, FileLock] = {}


def get_file_lock(file_id: str) -> FileLock:
    """Get or create a per-file lock.

    Lock objects are never removed — removing after release() is unsafe
    when waiters are pending on _release_event.wait().
    """
    if file_id not in _file_locks:
        _file_locks[file_id] = FileLock()
    return _file_locks[file_id]
