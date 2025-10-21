# services/storage-service/app/main.py
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.httpsredirect import HTTPSRedirectMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from .config import settings
from .database import init_redis, close_redis, engine, get_redis
from .monitoring.metrics import metrics_collector

# Import routers
from .routers import auth, files, folders, upload, storage, websocket, deduplication, sharing, versions, search, file_analysis, similarity, security, url_upload, folder_upload, quota_analytics, storage_optimization, auto_organization, recommendations, favorites, oauth, gdpr, audit, performance

# Import background services
from .routers.background_deduplication import background_dedup_service
from .services.cold_storage_tiering import cold_storage_service  # ENABLED
from .services.search_service import search_service
from .workers.quota_prediction_worker import quota_prediction_worker
from .workers.storage_optimization_worker import storage_optimization_worker

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifecycle"""
    # Startup
    print("Starting Edge Storage Service...")

    # Initialize Redis
    try:
        await init_redis()
        print("Redis connection established")
    except Exception as e:
        print(f"Redis connection failed: {e}")

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

    # Start background services
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
    try:
        await search_service.connect()
        print("Elasticsearch connection established")
    except Exception as e:
        print(f"Elasticsearch connection failed: {e}")

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

    print("Application startup complete")
    yield

    # Shutdown
    print("Shutting down Edge Storage Service...")
    
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

    # try:
    #     production_upload_service.cleanup()
    #     print("Upload service cleaned up")
    # except Exception as e:
    #     print(f"Error cleaning up upload service: {e}")

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
from .utils.rate_limiter import limiter, rate_limit_exceeded_handler as custom_rate_limit_handler

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, custom_rate_limit_handler)

# Add HTTPS redirect if enabled
if settings.ENABLE_HTTPS:
    app.add_middleware(HTTPSRedirectMiddleware)

# Configure CORS
default_origins = ["http://localhost:3000", "http://localhost:5173", "http://localhost:3001"]
allow_origins = getattr(settings, "CORS_ORIGINS", default_origins)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# Add Security Headers Middleware
try:
    from .middleware.security_headers import SecurityHeadersMiddleware, CORSSecurityMiddleware
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(CORSSecurityMiddleware)
    print("Security headers middleware enabled")
except Exception as e:
    print(f"Failed to enable security headers middleware: {e}")

# Add Performance Monitoring Middleware
try:
    from .middleware.performance import PerformanceMiddleware
    app.add_middleware(
        PerformanceMiddleware,
        slow_threshold=0.5
    )
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

    # Background services check
    health_status["checks"]["background_dedup"] = (
        "running" if background_dedup_service.worker_task and
        not background_dedup_service.worker_task.done() else "stopped"
    )
    health_status["checks"]["cold_storage_tiering"] = (
        "running" if cold_storage_service.worker_task and
        not cold_storage_service.worker_task.done() else "stopped"
    )
    health_status["checks"]["quota_prediction"] = (
        "running" if quota_prediction_worker.worker_task and
        not quota_prediction_worker.worker_task.done() else "stopped"
    )
    health_status["checks"]["storage_optimization"] = (
        "running" if storage_optimization_worker.worker_task and
        not storage_optimization_worker.worker_task.done() else "stopped"
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
        }
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