# services/storage-service/app/services/dedup_queue.py
"""
Smart Deduplication Queue with Priority & Backpressure

Features:
1. 3-tier priority queue (high/medium/low)
2. Per-user job limits (prevents single user monopolization)
3. Circuit breaker with health checks (pauses at 85% memory/90% disk)
4. Queue size limits with backpressure
5. Graceful degradation

Priority Levels:
- Priority 1 (HIGH): Small files (<10MB), documents, source code
- Priority 2 (MEDIUM): Medium files (10-100MB), typical media
- Priority 3 (LOW): Large files (>100MB), archives, VMs

Queue Limits:
- Max 10,000 total jobs in queue
- Max 50 jobs per user
- Max 2 concurrent processing jobs (configurable)
"""

import asyncio
import logging
import os
from collections import defaultdict
from datetime import datetime
from typing import Dict, List, Optional

import psutil

logger = logging.getLogger(__name__)


class CircuitBreaker:
    """
    Circuit breaker to prevent system overload

    States:
    - CLOSED: Normal operation
    - OPEN: System overloaded, reject new jobs
    - HALF_OPEN: Testing if system recovered
    """

    def __init__(
        self,
        memory_threshold: float = 0.85,  # Pause at 85% memory
        disk_threshold: float = 0.90,  # Pause at 90% disk
        check_interval: int = 30,  # Check every 30 seconds
    ):
        self.memory_threshold = memory_threshold
        self.disk_threshold = disk_threshold
        self.check_interval = check_interval
        self.state = "CLOSED"  # CLOSED, OPEN, HALF_OPEN
        self.failure_count = 0
        self.last_check = datetime.utcnow()
        self.last_health_info: Optional[Dict[str, float]] = None

    @staticmethod
    def _read_cgroup_memory() -> Optional[Dict[str, float]]:
        # psutil.virtual_memory() reports HOST memory inside a container, which
        # causes false-positive circuit trips on memory-constrained hosts (e.g.
        # 8GB Docker Desktop VMs). Prefer cgroup v2 / v1 readings when present.
        try:
            with open("/sys/fs/cgroup/memory.current") as f:
                used = int(f.read().strip())
            with open("/sys/fs/cgroup/memory.max") as f:
                raw = f.read().strip()
            if raw == "max":
                return None
            total = int(raw)
            if total <= 0:
                return None
            return {
                "used": used,
                "total": total,
                "percent": used / total,
                "available": total - used,
            }
        except (FileNotFoundError, ValueError, PermissionError):
            pass
        try:
            with open("/sys/fs/cgroup/memory/memory.usage_in_bytes") as f:
                used = int(f.read().strip())
            with open("/sys/fs/cgroup/memory/memory.limit_in_bytes") as f:
                total = int(f.read().strip())
            # cgroup v1 reports an absurdly large sentinel when unlimited
            if total <= 0 or total > (1 << 62):
                return None
            return {
                "used": used,
                "total": total,
                "percent": used / total,
                "available": total - used,
            }
        except (FileNotFoundError, ValueError, PermissionError):
            return None

    async def check_health(self) -> Dict:
        """Check system health and update circuit state"""
        now = datetime.utcnow()

        # Only check periodically
        if (now - self.last_check).seconds < self.check_interval:
            return {
                "state": self.state,
                "healthy": self.state == "CLOSED",
                "health_info": self.last_health_info,
            }

        self.last_check = now

        try:
            # Check memory usage — cgroup-aware, falls back to psutil
            cgroup_mem = self._read_cgroup_memory()
            if cgroup_mem is not None:
                memory_percent = cgroup_mem["percent"]
                memory_available = cgroup_mem["available"]
            else:
                memory = psutil.virtual_memory()
                memory_percent = memory.percent / 100.0
                memory_available = memory.available

            # Check disk usage for storage path
            storage_path = os.getenv("STORAGE_ROOT", "/app/storage")
            disk = psutil.disk_usage(storage_path)
            disk_percent = disk.percent / 100.0

            # Determine health status
            is_healthy = (
                memory_percent < self.memory_threshold and disk_percent < self.disk_threshold
            )

            health_info = {
                "memory_percent": round(memory_percent * 100, 2),
                "disk_percent": round(disk_percent * 100, 2),
                "memory_available_gb": round(memory_available / (1024**3), 2),
                "disk_available_gb": round(disk.free / (1024**3), 2),
            }
            self.last_health_info = health_info

            # Update circuit state
            if is_healthy:
                if self.state == "OPEN":
                    # Try half-open to test recovery
                    self.state = "HALF_OPEN"
                    logger.info("🔄 Circuit breaker: HALF_OPEN (testing recovery)")
                elif self.state == "HALF_OPEN":
                    # Confirmed healthy, close circuit
                    self.state = "CLOSED"
                    self.failure_count = 0
                    logger.info("✅ Circuit breaker: CLOSED (system healthy)")
            else:
                # System overloaded
                if self.state == "CLOSED" or self.state == "HALF_OPEN":
                    self.state = "OPEN"
                    self.failure_count += 1
                    logger.warning(
                        f"⚠️ Circuit breaker: OPEN (system overloaded)\n"
                        f"   Memory: {health_info['memory_percent']}% "
                        f"(threshold: {self.memory_threshold * 100}%)\n"
                        f"   Disk: {health_info['disk_percent']}% "
                        f"(threshold: {self.disk_threshold * 100}%)"
                    )

            return {
                "state": self.state,
                "healthy": self.state == "CLOSED",
                "health_info": health_info,
            }

        except Exception as e:
            logger.error(f"Health check failed: {e}")
            self.last_health_info = None
            return {"state": "OPEN", "healthy": False, "error": str(e)}


class SmartDeduplicationQueue:
    """
    Priority-based deduplication queue with backpressure and circuit breakers.

    KNOWN LIMITATION (tracked separately): the queues below are in-process
    asyncio.Queue instances. With multiple API replicas, each replica has its
    own queue and processes only what it produces. Moving the consumer to the
    storage-worker container requires first migrating producer/consumer to a
    durable backend (Redis Streams or Kafka topic) so jobs aren't stranded
    on whichever replica accepted the upload. Until then, dedup must stay
    on the API replica — see app/main.py and the comment at the
    background_dedup_service.start() call site.
    """

    def __init__(
        self,
        max_concurrent: int = 4,  # Increased from 2 to 4 for better throughput
        max_queue_size: int = 10_000,
        max_per_user: int = 50,
    ):
        # Priority queues (1=high, 2=medium, 3=low)
        self.queues = {
            1: asyncio.Queue(),  # High priority
            2: asyncio.Queue(),  # Medium priority
            3: asyncio.Queue(),  # Low priority
        }

        # Limits
        self.max_concurrent = max_concurrent
        self.max_queue_size = max_queue_size
        self.max_per_user = max_per_user

        # Tracking
        self.semaphore = asyncio.Semaphore(max_concurrent)
        self.user_job_counts = defaultdict(int)
        self.total_jobs = 0
        self.active_jobs = {}

        # Circuit breaker
        self.circuit_breaker = CircuitBreaker()

        # Worker task
        self.worker_task = None

        # Statistics
        self.stats = {
            "total_enqueued": 0,
            "total_processed": 0,
            "total_failed": 0,
            "total_rejected": 0,
            "by_priority": {1: 0, 2: 0, 3: 0},
        }

    async def start(self):
        """Start background worker"""
        if not self.worker_task or self.worker_task.done():
            self.worker_task = asyncio.create_task(self._worker())
            logger.info("📋 Smart deduplication queue started")

    async def stop(self):
        """Stop background worker gracefully"""
        if self.worker_task and not self.worker_task.done():
            self.worker_task.cancel()
            try:
                await self.worker_task
            except asyncio.CancelledError:
                pass
            logger.info("📋 Smart deduplication queue stopped")

    async def enqueue(self, job: Dict, priority: int = 2, user_id: Optional[str] = None) -> Dict:
        """
        Add job to priority queue with backpressure checks

        Args:
            job: Job data (file_id, upload_id, session, etc.)
            priority: 1=high, 2=medium, 3=low
            user_id: User ID for per-user limits

        Returns:
            Status dict with success/rejection reason
        """
        # Validate priority
        if priority not in [1, 2, 3]:
            priority = 2

        # Check circuit breaker
        health = await self.circuit_breaker.check_health()
        health_snapshot = health.get("health_info") or {}
        if not health["healthy"]:
            self.stats["total_rejected"] += 1
            return {
                "success": False,
                "reason": "circuit_breaker_open",
                "message": "System overloaded, try again later",
                "health": health_snapshot,
                "state": health.get("state", "UNKNOWN"),
            }

        # Check total queue size
        if self.total_jobs >= self.max_queue_size:
            self.stats["total_rejected"] += 1
            return {
                "success": False,
                "reason": "queue_full",
                "message": f"Queue full ({self.max_queue_size} jobs)",
                "queue_size": self.total_jobs,
            }

        # Check per-user limit
        if user_id and self.user_job_counts[user_id] >= self.max_per_user:
            self.stats["total_rejected"] += 1
            return {
                "success": False,
                "reason": "user_quota_exceeded",
                "message": f"User has {self.max_per_user} jobs in queue",
                "user_jobs": self.user_job_counts[user_id],
            }

        # Enqueue job
        job_with_meta = {
            **job,
            "priority": priority,
            "user_id": user_id,
            "enqueued_at": datetime.utcnow().isoformat(),
        }

        await self.queues[priority].put(job_with_meta)

        # Update tracking
        self.total_jobs += 1
        if user_id:
            self.user_job_counts[user_id] += 1

        self.stats["total_enqueued"] += 1
        self.stats["by_priority"][priority] += 1

        logger.info(
            f"📋 Enqueued job (priority={priority}, total={self.total_jobs}, "
            f"user_jobs={self.user_job_counts.get(user_id, 0)})"
        )

        return {
            "success": True,
            "priority": priority,
            "queue_position": self.total_jobs,
            "estimated_wait": self._estimate_wait_time(priority),
        }

    def _estimate_wait_time(self, priority: int) -> int:
        """Estimate wait time in seconds based on queue position"""
        # Count jobs ahead in queue
        jobs_ahead = 0
        for p in range(1, priority + 1):
            jobs_ahead += self.queues[p].qsize()

        # Estimate 60 seconds per job (conservative)
        avg_processing_time = 60

        # Account for concurrent processing
        return int(jobs_ahead * avg_processing_time / self.max_concurrent)

    async def _worker(self):
        """
        Background worker that processes jobs by priority

        Strategy:
        1. Check high priority queue first
        2. Fall back to medium priority
        3. Fall back to low priority
        4. Respect circuit breaker
        """
        logger.info("📋 Smart queue worker running...")

        while True:
            try:
                # Check circuit breaker
                health = await self.circuit_breaker.check_health()
                if not health["healthy"]:
                    logger.warning("⚠️ Circuit breaker open, pausing processing...")
                    await asyncio.sleep(30)  # Wait 30 seconds before retry
                    continue

                # Try to get job from priority queues (high to low)
                job = None
                priority = None

                for p in [1, 2, 3]:
                    try:
                        job = self.queues[p].get_nowait()
                        priority = p
                        break
                    except asyncio.QueueEmpty:
                        continue

                if job is None:
                    # All queues empty, wait a bit
                    await asyncio.sleep(1)
                    continue

                # Process job with semaphore
                async with self.semaphore:
                    await self._process_job(job)

                # Mark queue task done
                self.queues[priority].task_done()

            except asyncio.CancelledError:
                logger.info("📋 Worker cancelled")
                break
            except Exception as e:
                logger.error(f"Worker error: {e}")
                await asyncio.sleep(1)

    async def _deferred_enqueue(self, job: Dict, priority: int, delay: float):
        """Re-enqueue a deferred job after a delay."""
        await asyncio.sleep(delay)
        await self.queues[priority].put(job)
        logger.info(
            "📋 Re-enqueued deferred job %s (priority=%d, defer_count=%d)",
            job.get("file_id"),
            priority,
            job.get("_defer_count", 0),
        )

    async def _process_job(self, job: Dict):
        """Process a single deduplication job"""
        file_id = job.get("file_id")
        user_id = job.get("user_id")
        deferred = False

        logger.info(
            f"▶️ Processing job: {file_id} " f"(priority={job.get('priority')}, user={user_id})"
        )

        self.active_jobs[file_id] = job

        try:
            # Import here to avoid circular dependency
            from ..routers.background_deduplication import background_dedup_service

            # Delegate to existing background dedup processor
            result = await background_dedup_service._process_dedup_job(job)

            if result == "deferred":
                deferred = True
                asyncio.create_task(self._deferred_enqueue(job, job.get("priority", 2), delay=10))
            else:
                self.stats["total_processed"] += 1

        except Exception as e:
            logger.error(f"Job processing failed: {e}")
            self.stats["total_failed"] += 1

        finally:
            if not deferred:
                # Update tracking
                self.total_jobs = max(0, self.total_jobs - 1)
                if user_id:
                    self.user_job_counts[user_id] = max(0, self.user_job_counts[user_id] - 1)

            self.active_jobs.pop(file_id, None)

    async def get_status(self) -> Dict:
        """Get queue status and statistics"""
        health = await self.circuit_breaker.check_health()

        return {
            "queue_size": self.total_jobs,
            "active_jobs": len(self.active_jobs),
            "by_priority": {
                "high": self.queues[1].qsize(),
                "medium": self.queues[2].qsize(),
                "low": self.queues[3].qsize(),
            },
            "circuit_breaker": {
                "state": health["state"],
                "healthy": health["healthy"],
                "health_info": health.get("health_info", {}),
            },
            "statistics": self.stats,
            "capacity": {
                "max_queue_size": self.max_queue_size,
                "max_per_user": self.max_per_user,
                "max_concurrent": self.max_concurrent,
                "available_slots": self.max_queue_size - self.total_jobs,
            },
        }

    def get_user_status(self, user_id: str) -> Dict:
        """Get status for specific user"""
        return {
            "user_id": user_id,
            "jobs_in_queue": self.user_job_counts.get(user_id, 0),
            "max_allowed": self.max_per_user,
            "slots_available": self.max_per_user - self.user_job_counts.get(user_id, 0),
        }


# Global instance
smart_dedup_queue = SmartDeduplicationQueue(
    max_concurrent=2, max_queue_size=10_000, max_per_user=50
)
