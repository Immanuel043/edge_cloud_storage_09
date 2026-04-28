# services/storage-service/app/workers/combined_worker.py
"""
Combined Worker Entry Point

Starts all extractable background workers in a single process.
Used when WORKER_MODE=worker in docker-compose (separate from the API container).

Workers started:
- quota_prediction_worker (daily cycle)
- storage_optimization_worker (daily cycle)
- orphan_cleanup_worker (every 5 minutes)
- video_processing_worker (Kafka consumer, supervised with backoff)

Usage:
    python -m app.workers.combined_worker
"""

import asyncio
import logging
import os
import signal
import sys

# Add parent path for imports when running as __main__
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from app.config import settings
from app.database import close_redis, engine, init_redis

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("combined_worker")


async def _supervised_video_worker(video_worker):
    """Run video processing worker with supervised restart on crash."""
    retries = 0
    max_retries = 5
    while retries < max_retries:
        try:
            await video_worker.start()
        except asyncio.CancelledError:
            break
        except Exception as e:
            retries += 1
            backoff = min(2**retries, 60)
            logger.warning(
                f"Video processing worker crashed (attempt {retries}/{max_retries}): {e}. "
                f"Restarting in {backoff}s..."
            )
            await asyncio.sleep(backoff)
    if retries >= max_retries:
        logger.error("Video processing worker exceeded max retries, giving up")


async def main():
    logger.info("Starting combined worker (WORKER_MODE=worker)")
    logger.info(
        f"Config: QUOTA_PREDICTION_ENABLED={settings.QUOTA_PREDICTION_ENABLED}, "
        f"STORAGE_OPTIMIZATION_ENABLED={settings.STORAGE_OPTIMIZATION_ENABLED}"
    )

    # Initialize shared infrastructure
    await init_redis()
    logger.info("Redis connection established")

    # Import workers after Redis is initialized
    from app.workers.orphan_cleanup_worker import orphan_cleanup_worker
    from app.workers.quota_prediction_worker import quota_prediction_worker
    from app.workers.storage_optimization_worker import storage_optimization_worker
    from app.workers.video_processing_worker import VideoProcessingWorker

    workers = []
    video_worker = None
    video_task = None

    # Start extractable workers
    if settings.QUOTA_PREDICTION_ENABLED:
        try:
            await quota_prediction_worker.start()
            workers.append(("quota_prediction", quota_prediction_worker))
            logger.info("Quota prediction worker started")
        except Exception as e:
            logger.error(f"Failed to start quota prediction worker: {e}")

    if settings.STORAGE_OPTIMIZATION_ENABLED:
        try:
            await storage_optimization_worker.start()
            workers.append(("storage_optimization", storage_optimization_worker))
            logger.info("Storage optimization worker started")
        except Exception as e:
            logger.error(f"Failed to start storage optimization worker: {e}")

    try:
        await orphan_cleanup_worker.start()
        workers.append(("orphan_cleanup", orphan_cleanup_worker))
        logger.info("Orphan cleanup worker started")
    except Exception as e:
        logger.error(f"Failed to start orphan cleanup worker: {e}")

    try:
        video_worker = VideoProcessingWorker()
        video_task = asyncio.create_task(_supervised_video_worker(video_worker))
        logger.info("Video processing worker started (supervised)")
    except Exception as e:
        logger.error(f"Failed to start video processing worker: {e}")

    logger.info(f"Combined worker running with {len(workers)} timer workers + video consumer")

    # Wait for shutdown signal
    stop_event = asyncio.Event()
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop_event.set)

    await stop_event.wait()
    logger.info("Shutdown signal received, stopping workers...")

    # Graceful shutdown
    for name, worker in workers:
        try:
            await worker.stop()
            logger.info(f"{name} worker stopped")
        except Exception as e:
            logger.error(f"Error stopping {name} worker: {e}")

    if video_worker:
        try:
            await video_worker.stop()
            logger.info("Video processing worker stopped")
        except Exception as e:
            logger.error(f"Error stopping video processing worker: {e}")

    if video_task and not video_task.done():
        video_task.cancel()
        try:
            await video_task
        except asyncio.CancelledError:
            pass

    await close_redis()
    await engine.dispose()
    logger.info("Combined worker shutdown complete")


if __name__ == "__main__":
    asyncio.run(main())
