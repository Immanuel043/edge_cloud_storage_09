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
from .routers import auth, files, folders, upload, storage, websocket, deduplication

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifecycle"""
    # Startup
    print("🚀 Starting Edge Storage Service...")

    # Initialize Redis
    try:
        await init_redis()
        print("✅ Redis connection established")
    except Exception as e:
        print(f"⚠️ Redis connection failed: {e}")

    # Create storage directories
    try:
        await create_storage_directories()
        print("✅ Storage directories created")
    except Exception as e:
        print(f"⚠️ Failed to create storage directories: {e}")

    # Verify database connection
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        print("✅ Database connection successful")
    except Exception as e:
        print(f"⚠️ Database connection failed: {e}")

    print("✅ Application startup complete")
    yield

    # Shutdown
    print("👋 Shutting down Edge Storage Service...")
    await close_redis()
    await engine.dispose()
    print("✅ Cleanup complete")


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

# Instrument Prometheus metrics (if available)
try:
    metrics_collector.instrument_app(app)
except Exception as e:
    print(f"⚠️ Failed to instrument metrics: {e}")

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

# Add Performance Monitoring Middleware
# Import it after checking if the module exists
try:
    from .middleware.performance import PerformanceMiddleware
    app.add_middleware(
        PerformanceMiddleware,
        slow_threshold=0.5  # Log requests slower than 500ms
    )
    print("✅ Performance monitoring enabled")
except ImportError:
    print("⚠️ Performance middleware not found - create app/middleware/performance.py")

# Include routers
app.include_router(auth.router)
app.include_router(files.router)
app.include_router(folders.router)
app.include_router(upload.router)
app.include_router(storage.router)
app.include_router(websocket.router)
app.include_router(deduplication.router)


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
        # Sharded directories (00-ff)
        for i in range(256):
            shard_path = os.path.join(path, f"{i:02x}")
            os.makedirs(shard_path, exist_ok=True)
        # Objects directory for single-file storage mode
        os.makedirs(os.path.join(path, "objects"), exist_ok=True)


# Root endpoint
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


# Health check endpoint
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
    }

    return health_status


# Ready check endpoint (for Kubernetes readiness probe)
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


# Live check endpoint (for Kubernetes liveness probe)
@app.get("/api/v1/live", tags=["Health"])
async def live_check():
    """Liveness probe endpoint"""
    return {"live": True}


# Version endpoint
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


# Error handlers
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


# Run for local development
if __name__ == "__main__":
    import uvicorn
    
    # Development configuration optimized for debugging
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8001,
        reload=True,  # Auto-reload on code changes
        log_level="info",
        access_log=True,
        
        # Performance settings for handling 100 users
        workers=1,  # Use 1 worker in dev, multiple in prod
        limit_concurrency=1000,  # Handle many concurrent connections
        timeout_keep_alive=60,  # Keep connections alive longer
        timeout_graceful_shutdown=30,
    )