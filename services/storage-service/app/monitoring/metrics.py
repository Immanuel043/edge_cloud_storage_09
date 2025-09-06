# services/storage-service/app/monitoring/metrics.py
from prometheus_client import Counter, Histogram, Gauge, Info
from prometheus_fastapi_instrumentator import Instrumentator
import psutil
import asyncio
from datetime import datetime

# Business Metrics
upload_initiated = Counter(
    'storage_upload_initiated_total',
    'Total number of uploads initiated',
    ['user_type', 'storage_strategy']
)

upload_completed = Counter(
    'storage_upload_completed_total',
    'Total number of uploads completed',
    ['user_type', 'storage_strategy', 'status']
)

upload_duration = Histogram(
    'storage_upload_duration_seconds',
    'Upload duration in seconds',
    ['storage_strategy'],
    buckets=(0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300)
)

active_uploads = Gauge(
    'storage_active_uploads',
    'Number of currently active uploads'
)

storage_used_bytes = Gauge(
    'storage_used_bytes_total',
    'Total storage used in bytes',
    ['storage_tier']
)

chunk_processing_duration = Histogram(
    'storage_chunk_processing_seconds',
    'Time to process a single chunk',
    buckets=(0.01, 0.05, 0.1, 0.5, 1, 2, 5)
)

# System Metrics
system_info = Info('storage_system', 'System information')
cpu_usage = Gauge('storage_cpu_usage_percent', 'CPU usage percentage')
memory_usage = Gauge('storage_memory_usage_bytes', 'Memory usage in bytes')
disk_io_read = Counter('storage_disk_read_bytes_total', 'Total disk read bytes')
disk_io_write = Counter('storage_disk_write_bytes_total', 'Total disk write bytes')
db_connections_active = Gauge('storage_db_connections_active', 'Active database connections')
redis_connections = Gauge('storage_redis_connections', 'Active Redis connections')

# Error tracking
errors_total = Counter(
    'storage_errors_total',
    'Total number of errors',
    ['error_type', 'endpoint']
)

class MetricsCollector:
    def __init__(self):
        self.instrumentator = Instrumentator(
            should_group_status_codes=False,
            should_ignore_untemplated=True,
            should_instrument_requests_inprogress=True,
            excluded_handlers=["/metrics", "/health"],
            inprogress_name="storage_requests_inprogress",
            inprogress_labels=True,
        )
        self._last_disk_io = None
        
    def instrument_app(self, app):
        """Add automatic instrumentation to FastAPI app"""
        self.instrumentator.instrument(app).expose(app, endpoint="/metrics")
        
        # Add custom metrics endpoint
        @app.on_event("startup")
        async def startup_metrics():
            asyncio.create_task(self.collect_system_metrics())
            system_info.info({
                'version': '1.0.0',
                'python_version': '3.11',
                'started_at': datetime.utcnow().isoformat()
            })
    
    async def collect_system_metrics(self):
        """Collect system metrics every 10 seconds"""
        while True:
            try:
                # CPU and Memory
                cpu_usage.set(psutil.cpu_percent(interval=1))
                memory = psutil.virtual_memory()
                memory_usage.set(memory.used)
                
                # Disk I/O
                disk_io = psutil.disk_io_counters()
                if self._last_disk_io:
                    disk_io_read.inc(disk_io.read_bytes - self._last_disk_io.read_bytes)
                    disk_io_write.inc(disk_io.write_bytes - self._last_disk_io.write_bytes)
                self._last_disk_io = disk_io
                
                # Database connections (from your pool)
                from ..database import engine
                db_connections_active.set(engine.pool.size())
                
                await asyncio.sleep(10)
            except Exception as e:
                print(f"Error collecting metrics: {e}")
                await asyncio.sleep(10)

metrics_collector = MetricsCollector()