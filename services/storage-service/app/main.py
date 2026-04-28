# services/storage-service/app/main.py
import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.httpsredirect import HTTPSRedirectMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from .config import settings
from .database import close_redis, engine, get_redis, init_redis
from .monitoring.metrics import metrics_collector

# Import routers
from .routers import (
    audit,
    auth,
    auto_organization,
    billing_v2,
    deduplication,
    favorites,
    file_analysis,
    files,
    folder_upload,
    folders,
    gdpr,
    oauth,
    performance,
    quota_analytics,
    recommendations,
    search,
    security,
    share_bundles,
    sharing,
    similarity,
    storage,
    storage_optimization,
    subscription_helpers,
    upload,
    url_upload,
    versions,
    websocket,
)

# Import background services
from .routers.background_deduplication import background_dedup_service
from .services.cold_storage_tiering import cold_storage_service  # ENABLED
from .services.search_service import search_service
from .workers.orphan_cleanup_worker import orphan_cleanup_worker
from .workers.quota_prediction_worker import quota_prediction_worker
from .workers.storage_optimization_worker import storage_optimization_worker
from .workers.video_processing_worker import VideoProcessingWorker

# Initialize video processing worker
video_processing_worker = VideoProcessingWorker()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifecycle"""
    # Startup
    print("Starting Edge Storage Service...")

    # Check DEV_MODE status (already validated in config.py, but log again for visibility)
    if settings.DEV_MODE:
        print("\n" + "=" * 80)
        print("⚠️  WARNING: DEV_MODE IS ACTIVE")
        print("⚠️  Payment verification is BYPASSED")
        print("⚠️  This should NEVER be enabled in production")
        print("=" * 80 + "\n")

    # Initialize Redis
    try:
        await init_redis()
        print("Redis connection established")
    except Exception as e:
        print(f"Redis connection failed: {e}")

    # Initialize FastAPILimiter for rate limiting.
    # Uses the dedicated DB 2 client created by init_redis() so rate-limit
    # counters live in an isolated keyspace (independent FLUSHDB, separate
    # memory telemetry) away from sessions and upload state on DB 0.
    try:
        from fastapi_limiter import FastAPILimiter

        from .database import get_redis_ratelimit
        from .middleware.rate_limiter import RateLimiter

        ratelimit_redis = await get_redis_ratelimit()
        if ratelimit_redis is None:
            raise RuntimeError("Rate-limit Redis client not initialized")
        await FastAPILimiter.init(ratelimit_redis)
        print("FastAPILimiter initialized with Redis backend (DB 2)")

        # Initialize custom RateLimiter for billing endpoints on the same
        # DB 2 keyspace — billing rate buckets share the ratelimit namespace.
        app.state.rate_limiter = RateLimiter(ratelimit_redis)
        print("Custom RateLimiter initialized for billing endpoints (DB 2)")
    except Exception as e:
        print(f"Failed to initialize FastAPILimiter: {e}")

    # Create storage directories
    try:
        await create_storage_directories()
        print("Storage directories created")
    except Exception as e:
        print(f"Failed to create storage directories: {e}")

    # Verify database connection
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        print("Database connection successful")
    except Exception as e:
        print(f"Database connection failed: {e}")

    print(
        f"WORKER_MODE={settings.WORKER_MODE} (api={settings.is_api_mode}, worker={settings.is_worker_mode})"
    )

    # === API-coupled services (start in "all" and "api" modes) ===
    if settings.is_api_mode:
        # Start background services tightly coupled to the API lifecycle
        try:
            await background_dedup_service.start()
            print("Background deduplication service started")
        except Exception as e:
            print(f"Failed to start dedup service: {e}")

        try:
            await cold_storage_service.start()
            print("Cold storage tiering service started")
        except Exception as e:
            print(f"Failed to start tiering service: {e}")

        # Initialize Elasticsearch
        if settings.ELASTICSEARCH_ENABLED:
            try:
                await search_service.connect()
                if search_service.connected:
                    print("Elasticsearch connection established")
                else:
                    print("Elasticsearch disabled by configuration")
            except Exception as e:
                print(f"WARNING: Elasticsearch connection failed: {e}")
                print("WARNING: Search functionality will be unavailable")
                # Don't re-raise - allow app to run without search
        else:
            print("Elasticsearch is disabled (ELASTICSEARCH_ENABLED=false)")

        # Start WebSocket preview notification listener (Redis Pub/Sub -> WS push)
        try:
            from .routers.websocket import _listen_preview_notifications

            asyncio.create_task(_listen_preview_notifications())
            print("Preview notification WebSocket listener started")
        except Exception as e:
            print(f"Failed to start preview notification listener: {e}")

        # Event loop lag monitor -- early warning for event loop starvation
        import logging as _logging

        _lag_logger = _logging.getLogger("app.eventloop_monitor")

        async def _monitor_event_loop_lag():
            loop = asyncio.get_event_loop()
            while True:
                t0 = loop.time()
                await asyncio.sleep(0.5)
                lag_ms = (loop.time() - t0 - 0.5) * 1000
                if lag_ms > 500:
                    _lag_logger.error(f"CRITICAL event loop lag: {lag_ms:.0f}ms")
                elif lag_ms > 100:
                    _lag_logger.warning(f"Event loop lag: {lag_ms:.0f}ms (threshold: 100ms)")

        try:
            asyncio.create_task(_monitor_event_loop_lag())
            print("Event loop lag monitor started (warn >100ms, error >500ms)")
        except Exception as e:
            print(f"Failed to start event loop monitor: {e}")

    # === Extractable workers (start in "all" and "worker" modes) ===
    if settings.is_worker_mode:
        # Start quota prediction worker (ML feature)
        if settings.QUOTA_PREDICTION_ENABLED:
            try:
                await quota_prediction_worker.start()
                print("Quota prediction worker started")
            except Exception as e:
                print(f"Failed to start quota prediction worker: {e}")

        # Start storage optimization worker (ML feature)
        if settings.STORAGE_OPTIMIZATION_ENABLED:
            try:
                await storage_optimization_worker.start()
                print("Storage optimization worker started")
            except Exception as e:
                print(f"Failed to start storage optimization worker: {e}")

        # Start orphan cleanup worker (cleans expired upload sessions + orphan chunks)
        try:
            await orphan_cleanup_worker.start()
            print("Orphan cleanup worker started")
        except Exception as e:
            print(f"Failed to start orphan cleanup worker: {e}")

        # Start video processing worker (Kafka consumer for video optimization)
        # Supervised: restarts on crash with backoff, up to 5 retries
        async def _supervised_video_worker():
            retries = 0
            max_retries = 5
            while retries < max_retries:
                try:
                    await video_processing_worker.start()
                except asyncio.CancelledError:
                    break
                except Exception as e:
                    retries += 1
                    backoff = min(2**retries, 60)
                    print(
                        f"Video processing worker crashed (attempt {retries}/{max_retries}): {e}. Restarting in {backoff}s..."
                    )
                    await asyncio.sleep(backoff)
            if retries >= max_retries:
                print("Video processing worker exceeded max retries, giving up")

        try:
            asyncio.create_task(_supervised_video_worker())
            print("Video processing worker started (supervised)")
        except Exception as e:
            print(f"Failed to start video processing worker: {e}")

    print("Application startup complete")
    yield

    # Shutdown
    print("Shutting down Edge Storage Service...")

    # === Stop API-coupled services ===
    if settings.is_api_mode:
        # Close FastAPILimiter
        try:
            from fastapi_limiter import FastAPILimiter

            await FastAPILimiter.close()
            print("FastAPILimiter closed")
        except Exception as e:
            print(f"Error closing FastAPILimiter: {e}")

        # Stop background services
        try:
            await background_dedup_service.stop()
            print("Background dedup service stopped")
        except Exception as e:
            print(f"Error stopping dedup service: {e}")

        try:
            await cold_storage_service.stop()
            print("Cold storage service stopped")
        except Exception as e:
            print(f"Error stopping tiering service: {e}")

        # Close Elasticsearch
        try:
            await search_service.close()
            print("Elasticsearch connection closed")
        except Exception as e:
            print(f"Error closing Elasticsearch: {e}")

        # Stop Kafka producer (flush buffered messages before shutdown)
        try:
            from .routers.upload import kafka_producer as _kafka_producer

            if _kafka_producer is not None:
                await _kafka_producer.stop()
                print("Kafka producer stopped")
        except Exception as e:
            print(f"Error stopping Kafka producer: {e}")

    # === Stop extractable workers ===
    if settings.is_worker_mode:
        # Stop quota prediction worker
        if settings.QUOTA_PREDICTION_ENABLED:
            try:
                await quota_prediction_worker.stop()
                print("Quota prediction worker stopped")
            except Exception as e:
                print(f"Error stopping quota prediction worker: {e}")

        # Stop storage optimization worker
        if settings.STORAGE_OPTIMIZATION_ENABLED:
            try:
                await storage_optimization_worker.stop()
                print("Storage optimization worker stopped")
            except Exception as e:
                print(f"Error stopping storage optimization worker: {e}")

        # Stop orphan cleanup worker
        try:
            await orphan_cleanup_worker.stop()
            print("Orphan cleanup worker stopped")
        except Exception as e:
            print(f"Error stopping orphan cleanup worker: {e}")

        # Stop video processing worker
        try:
            await video_processing_worker.stop()
            print("Video processing worker stopped")
        except Exception as e:
            print(f"Error stopping video processing worker: {e}")

    await close_redis()
    await engine.dispose()
    print("Cleanup complete")


# Create FastAPI app
app = FastAPI(
    title=settings.APP_NAME,
    version=settings.VERSION,
    description="High-performance distributed storage service with encryption and multi-tier storage",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
)

# Instrument Prometheus metrics
try:
    metrics_collector.instrument_app(app)
except Exception as e:
    print(f"Failed to instrument metrics: {e}")

# Add rate limiting
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from .utils.rate_limiter import (
    limiter,
)
from .utils.rate_limiter import rate_limit_exceeded_handler as custom_rate_limit_handler
from .utils.rate_limiter import (
    share_limiter,
)

app.state.limiter = limiter
app.state.share_limiter = share_limiter
app.add_exception_handler(RateLimitExceeded, custom_rate_limit_handler)

# Add HTTPS redirect if enabled
if settings.ENABLE_HTTPS:
    app.add_middleware(HTTPSRedirectMiddleware)

# Global request timeout — wraps handler execution in asyncio.wait_for.
# Added before CORS/security/performance so it sits innermost: all outer
# middleware still run on the timeout response (including CORS header
# injection), but handler wall-time is bounded. Per-prefix overrides live
# inside the middleware module; see request_timeout.py.
try:
    from .middleware.request_timeout import RequestTimeoutMiddleware

    app.add_middleware(RequestTimeoutMiddleware)
    print("Request timeout middleware enabled")
except Exception as e:
    print(f"Failed to enable request timeout middleware: {e}")

# Configure CORS
cors_env = os.getenv("CORS_ORIGINS", "")
if cors_env:
    allow_origins = [o.strip() for o in cors_env.split(",") if o.strip()]
elif settings.is_production:
    allow_origins = []  # Must be set via CORS_ORIGINS in production
else:
    allow_origins = ["http://localhost:3000", "http://localhost:5173", "http://localhost:3001"]
# Note: With credentials=True, expose_headers=["*"] doesn't work for custom headers
# Must explicitly list custom headers for JavaScript to access them
app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=[
        "Content-Length",
        "Content-Type",
        "Content-Disposition",
        "X-Preview-Status",
        "X-ZK-Encrypted",
        "X-ZK-Thumbnail-IV",
        "X-ZK-Thumbnail-Width",
        "X-ZK-Thumbnail-Height",
    ],
)

# Add Security Headers Middleware
try:
    from .middleware.security_headers import CORSSecurityMiddleware, SecurityHeadersMiddleware

    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(CORSSecurityMiddleware)
    print("Security headers middleware enabled")
except Exception as e:
    print(f"Failed to enable security headers middleware: {e}")

# Add Performance Monitoring Middleware
try:
    from .middleware.performance import PerformanceMiddleware

    app.add_middleware(PerformanceMiddleware, slow_threshold=0.5)
    print("Performance monitoring enabled")
except ImportError:
    print("Performance middleware not found")

# Include routers
app.include_router(auth.router)
app.include_router(files.router)
app.include_router(folders.router)
app.include_router(upload.router)
app.include_router(url_upload.router)
app.include_router(folder_upload.router)
app.include_router(storage.router)
app.include_router(sharing.router)
app.include_router(versions.router)
app.include_router(search.router)
app.include_router(websocket.router)
app.include_router(deduplication.router)
app.include_router(file_analysis.router)
app.include_router(similarity.router)
app.include_router(security.router)
app.include_router(quota_analytics.router)
app.include_router(storage_optimization.router)
app.include_router(auto_organization.router)
app.include_router(recommendations.router)
app.include_router(favorites.router)
app.include_router(oauth.router)
app.include_router(gdpr.router)
app.include_router(audit.router)
app.include_router(performance.router)
app.include_router(share_bundles.router)
app.include_router(billing_v2.router)  # Database-driven billing system
app.include_router(subscription_helpers.router)  # Subscription UI helpers

# Internal API for cross-service communication
from .routers import internal

app.include_router(internal.router, prefix="/api/v1/auth/internal", tags=["Internal"])


# Helper functions
async def create_storage_directories():
    """Create required storage directories with sharding"""
    paths = [
        settings.CACHE_PATH,
        settings.WARM_PATH,
        settings.COLD_PATH,
        settings.TEMP_PATH,
        settings.BACKUP_PATH,
    ]

    for path in paths:
        os.makedirs(path, exist_ok=True)
        for i in range(256):
            shard_path = os.path.join(path, f"{i:02x}")
            os.makedirs(shard_path, exist_ok=True)
        os.makedirs(os.path.join(path, "objects"), exist_ok=True)


@app.get("/", tags=["Root"])
async def root():
    """Root endpoint with service information"""
    return {
        "service": settings.APP_NAME,
        "version": settings.VERSION,
        "status": "running",
        "documentation": "/docs",
        "health": "/api/v1/health",
    }


@app.get("/api/v1/health", tags=["Health"])
async def health_check():
    """Comprehensive health check endpoint"""
    health_status = {
        "status": "healthy",
        "service": settings.APP_NAME,
        "version": settings.VERSION,
        "environment": os.getenv("ENVIRONMENT", "development"),
        "checks": {},
    }

    # Database check
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        health_status["checks"]["database"] = "healthy"
    except Exception as e:
        health_status["checks"]["database"] = f"unhealthy: {str(e)}"
        health_status["status"] = "degraded"

    # Redis check
    try:
        redis = await get_redis()
        await redis.ping()
        health_status["checks"]["redis"] = "healthy"
    except Exception as e:
        health_status["checks"]["redis"] = f"unhealthy: {str(e)}"
        health_status["status"] = "degraded"

    # Background services check (safely check for worker_task attribute)
    def check_worker_status(service, service_name):
        try:
            worker_task = getattr(service, "worker_task", None)
            if worker_task and not worker_task.done():
                return "running"
            return "stopped"
        except Exception:
            return "unknown"

    health_status["checks"]["background_dedup"] = check_worker_status(
        background_dedup_service, "background_dedup"
    )
    health_status["checks"]["cold_storage_tiering"] = check_worker_status(
        cold_storage_service, "cold_storage"
    )
    health_status["checks"]["quota_prediction"] = check_worker_status(
        quota_prediction_worker, "quota_prediction"
    )
    health_status["checks"]["storage_optimization"] = check_worker_status(
        storage_optimization_worker, "storage_optimization"
    )
    health_status["checks"]["orphan_cleanup"] = check_worker_status(
        orphan_cleanup_worker, "orphan_cleanup"
    )

    # Storage directories check
    storage_status = {}
    for tier in ["cache", "warm", "cold"]:
        path = getattr(settings, f"{tier.upper()}_PATH", None)
        if path:
            storage_status[tier] = os.path.exists(path)
    health_status["storage_tiers"] = storage_status

    health_status["features"] = {
        "backup_enabled": settings.BACKUP_ENABLED,
        "https_enabled": settings.ENABLE_HTTPS,
        "compression_enabled": getattr(settings, "COMPRESSION_ENABLED", True),
        "encryption_enabled": getattr(settings, "ENCRYPTION_ENABLED", True),
        "background_dedup": True,
        "cold_storage_tiering": True,  # ENABLED
        "url_upload": settings.URL_UPLOAD_ENABLED,
        "folder_upload": settings.FOLDER_UPLOAD_ENABLED,
        "ml_features": settings.ML_FEATURES_ENABLED,
        "quota_prediction": settings.QUOTA_PREDICTION_ENABLED,
        "auto_organization": settings.AUTO_ORGANIZATION_ENABLED,
        "storage_optimization": settings.STORAGE_OPTIMIZATION_ENABLED,
        "content_recommendations": settings.CONTENT_RECOMMENDATIONS_ENABLED,
        "semantic_search": settings.SEMANTIC_SEARCH_ENABLED,
    }

    return health_status


# Service statistics endpoint
@app.get("/api/v1/stats", tags=["Info"])
async def get_service_stats():
    """Get real-time service statistics"""
    return {
        "deduplication": {
            "active_jobs": len(background_dedup_service.active_jobs),
            "queued_jobs": background_dedup_service.queue.qsize(),
        },
        "tiering": {
            "enabled": cold_storage_service.is_running,
            "cache_to_warm_days": cold_storage_service.cache_to_warm_days,
            "warm_to_cold_days": cold_storage_service.warm_to_cold_days,
        },
    }


@app.get("/api/v1/ready", tags=["Health"])
async def ready_check():
    """Readiness probe endpoint"""
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        redis = await get_redis()
        await redis.ping()
        return {"ready": True}
    except Exception as e:
        return JSONResponse(status_code=503, content={"ready": False, "error": str(e)})


@app.get("/api/v1/live", tags=["Health"])
async def live_check():
    """Liveness probe endpoint"""
    return {"live": True}


@app.get("/api/v1/version", tags=["Info"])
async def version_info():
    """Get service version and build information"""
    return {
        "service": settings.APP_NAME,
        "version": settings.VERSION,
        "api_version": "v1",
        "build_date": getattr(settings, "BUILD_DATE", "unknown"),
        "commit": getattr(settings, "GIT_COMMIT", "unknown"),
    }


@app.exception_handler(404)
async def not_found(request: Request, exc):
    """Custom 404 handler"""
    return JSONResponse(
        status_code=404,
        content={
            "error": "Not Found",
            "message": f"The path {request.url.path} was not found",
            "status": 404,
        },
    )


@app.exception_handler(500)
async def internal_error(request: Request, exc):
    """Custom 500 handler"""
    return JSONResponse(
        status_code=500,
        content={
            "error": "Internal Server Error",
            "message": "An unexpected error occurred",
            "status": 500,
        },
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8001,
        reload=True,
        log_level="info",
        access_log=True,
        workers=1,
        limit_concurrency=1000,
        timeout_keep_alive=60,
        timeout_graceful_shutdown=30,
    )
