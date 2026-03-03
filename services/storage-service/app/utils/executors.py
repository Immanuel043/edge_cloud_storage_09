"""
Dedicated thread pool for heavy background tasks.

Isolates CPU-bound and blocking I/O work (dedup hashing, chunk read/decrypt,
rolling hash) from the default asyncio thread pool, so API request handlers
and WebSocket coroutines are never starved -- even under concurrent upload load.
"""

import asyncio
import logging
import os
from concurrent.futures import ThreadPoolExecutor

logger = logging.getLogger(__name__)

_max_workers = min(os.cpu_count() * 2, 16) if os.cpu_count() else 8

HEAVY_TASK_EXECUTOR = ThreadPoolExecutor(
    max_workers=_max_workers,
    thread_name_prefix="heavy-bg",
)

logger.info("Heavy task executor: %d workers", _max_workers)


async def run_in_heavy_pool(func, *args):
    """Run *func(*args)* in the dedicated heavy-task thread pool.

    Unlike ``asyncio.to_thread`` (which uses the default executor), this
    guarantees that heavy CPU / IO work cannot saturate the pool used by
    normal API handlers and WebSocket ping/pong.
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(HEAVY_TASK_EXECUTOR, func, *args)
