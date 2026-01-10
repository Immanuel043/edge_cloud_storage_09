"""
Zero-Knowledge Encryption Service - Main Application

A separate microservice for handling client-side encryption features.
This service coordinates ZK encryption workflows but NEVER has access
to unencrypted user data or plaintext encryption keys.

Key Responsibilities:
- User ZK enrollment/opt-in
- Recovery phrase management
- Hardware key (FIDO2) registration
- Social recovery coordination
- Key derivation parameter management
- ZK upload/download orchestration

What This Service Does NOT Do:
- Store plaintext encryption keys
- Decrypt user data
- Access file contents
- Generate file encryption keys (client does this)
"""
import time
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
import structlog

from app.config import settings


# Configure structured logging
structlog.configure(
    processors=[
        structlog.stdlib.filter_by_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.UnicodeDecoder(),
        structlog.processors.JSONRenderer()
    ],
    wrapper_class=structlog.stdlib.BoundLogger,
    context_class=dict,
    logger_factory=structlog.stdlib.LoggerFactory(),
    cache_logger_on_first_use=True,
)

logger = structlog.get_logger()


# Lifespan context manager for startup/shutdown events
@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator:
    """
    Lifespan context manager for the application.
    Handles startup and shutdown events.
    """
    # Import database and Redis modules
    from app.database import init_db, close_db
    from app.redis_client import init_redis, close_redis

    # Startup
    logger.info(
        "zk_service_startup",
        service=settings.SERVICE_NAME,
        version=settings.VERSION,
        port=settings.ZK_SERVICE_PORT
    )

    try:
        # Initialize database connection pool
        await init_db()
        logger.info("database_ready")

        # Initialize Redis connection
        await init_redis()
        logger.info("redis_ready")

        # Start background cleanup tasks
        import asyncio
        from app.tasks.cleanup import run_cleanup_tasks
        cleanup_task = asyncio.create_task(run_cleanup_tasks())
        logger.info("cleanup_tasks_started")

        logger.info("zk_service_ready", status="healthy")

    except Exception as e:
        logger.error("zk_service_startup_failed", error=str(e), exc_info=True)
        raise

    yield

    # Cancel cleanup task on shutdown
    if 'cleanup_task' in locals():
        cleanup_task.cancel()
        try:
            await cleanup_task
        except asyncio.CancelledError:
            pass

    # Shutdown
    logger.info("zk_service_shutdown")

    try:
        # Close database connections
        await close_db()

        # Close Redis connections
        await close_redis()

        logger.info("zk_service_shutdown_complete")
    except Exception as e:
        logger.error("zk_service_shutdown_failed", error=str(e), exc_info=True)


# Create FastAPI application
app = FastAPI(
    title="Zero-Knowledge Encryption Service",
    description=(
        "Microservice for managing client-side encryption features. "
        "This service never has access to plaintext user data or encryption keys."
    ),
    version=settings.VERSION,
    docs_url="/docs" if settings.DEBUG else None,
    redoc_url="/redoc" if settings.DEBUG else None,
    lifespan=lifespan
)


# ========== MIDDLEWARE ==========

# CORS Middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=[
        "X-ZK-Encrypted",
        "X-ZK-Thumbnail-IV",
        "X-ZK-File-Key",
        "X-ZK-File-Key-IV",
        "X-Encrypted-File-Name",
        "X-File-Name-IV",
        "Content-Disposition",
        "Content-Length",
        "Content-Type",
    ],
)

# GZip Compression
app.add_middleware(GZipMiddleware, minimum_size=1000)


# Request logging middleware
@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Log all requests with timing information"""
    start_time = time.time()

    # Generate request ID
    request_id = request.headers.get("X-Request-ID", f"req_{int(time.time() * 1000)}")

    # Add request ID to context
    structlog.contextvars.bind_contextvars(request_id=request_id)

    logger.info(
        "request_started",
        method=request.method,
        path=request.url.path,
        client_ip=request.client.host if request.client else None
    )

    try:
        response = await call_next(request)

        process_time = time.time() - start_time

        logger.info(
            "request_completed",
            method=request.method,
            path=request.url.path,
            status_code=response.status_code,
            process_time_ms=round(process_time * 1000, 2)
        )

        # Add custom headers
        response.headers["X-Request-ID"] = request_id
        response.headers["X-Process-Time"] = str(round(process_time * 1000, 2))

        return response

    except Exception as exc:
        process_time = time.time() - start_time

        logger.error(
            "request_failed",
            method=request.method,
            path=request.url.path,
            error=str(exc),
            process_time_ms=round(process_time * 1000, 2),
            exc_info=True
        )
        raise

    finally:
        structlog.contextvars.clear_contextvars()


# ========== EXCEPTION HANDLERS ==========

@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    """Handle HTTP exceptions with structured logging"""
    logger.warning(
        "http_exception",
        status_code=exc.status_code,
        detail=exc.detail,
        path=request.url.path
    )

    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": {
                "code": exc.status_code,
                "message": exc.detail,
                "path": request.url.path
            }
        }
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """Handle request validation errors"""
    logger.warning(
        "validation_error",
        errors=exc.errors(),
        path=request.url.path
    )

    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "error": {
                "code": 422,
                "message": "Validation error",
                "details": exc.errors()
            }
        }
    )


@app.exception_handler(Exception)
async def general_exception_handler(request: Request, exc: Exception):
    """Handle unexpected exceptions"""
    logger.error(
        "unexpected_error",
        error=str(exc),
        path=request.url.path,
        exc_info=True
    )

    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "error": {
                "code": 500,
                "message": "Internal server error",
                "detail": str(exc) if settings.DEBUG else "An unexpected error occurred"
            }
        }
    )


# ========== HEALTH CHECK ==========

@app.get("/health", tags=["Health"])
async def health_check():
    """
    Health check endpoint for container orchestration.

    Returns:
        Service health status
    """
    from app.database import engine
    from app.redis_client import get_redis
    import sqlalchemy as sa

    health_status = {
        "status": "healthy",
        "service": settings.SERVICE_NAME,
        "version": settings.VERSION,
        "timestamp": time.time(),
        "checks": {}
    }

    # Check database connection
    try:
        async with engine.begin() as conn:
            await conn.execute(sa.text("SELECT 1"))
        health_status["checks"]["database"] = "healthy"
    except Exception as e:
        logger.error("database_health_check_failed", error=str(e))
        health_status["checks"]["database"] = "unhealthy"
        health_status["status"] = "unhealthy"

    # Check Redis connection
    try:
        redis = get_redis()
        await redis.ping()
        health_status["checks"]["redis"] = "healthy"
    except Exception as e:
        logger.error("redis_health_check_failed", error=str(e))
        health_status["checks"]["redis"] = "unhealthy"
        health_status["status"] = "unhealthy"

    # Return 503 if unhealthy
    status_code = 200 if health_status["status"] == "healthy" else 503

    return JSONResponse(content=health_status, status_code=status_code)


@app.get("/", tags=["Root"])
async def root():
    """Root endpoint with service information"""
    return {
        "service": settings.SERVICE_NAME,
        "version": settings.VERSION,
        "description": "Zero-Knowledge Encryption Service",
        "documentation": "/docs" if settings.DEBUG else None,
        "health": "/health"
    }


# ========== METRICS ENDPOINT (Prometheus) ==========

if settings.ENABLE_METRICS:
    from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST
    from fastapi.responses import Response

    # Define metrics
    request_count = Counter(
        'zk_http_requests_total',
        'Total HTTP requests',
        ['method', 'endpoint', 'status']
    )

    request_duration = Histogram(
        'zk_http_request_duration_seconds',
        'HTTP request duration',
        ['method', 'endpoint']
    )

    zk_enrollments = Counter(
        'zk_enrollments_total',
        'Total ZK enrollments',
        ['tier']
    )

    recovery_attempts = Counter(
        'zk_recovery_attempts_total',
        'Total recovery attempts',
        ['method', 'success']
    )

    @app.get("/metrics", tags=["Monitoring"])
    async def metrics():
        """Prometheus metrics endpoint"""
        return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


# ========== ROUTER REGISTRATION ==========

# Import routers
from app.routers import auth_zk, keys, upload_zk, download_zk, billing, subscription_helpers

# Register routers with API prefix
app.include_router(
    auth_zk.router,
    prefix=settings.API_PREFIX,
    tags=["Zero-Knowledge Authentication"]
)

app.include_router(
    keys.router,
    prefix=settings.API_PREFIX,
    tags=["Key Management & Recovery"]
)

app.include_router(
    upload_zk.router,
    prefix=settings.API_PREFIX,
    tags=["Encrypted Upload"]
)

app.include_router(
    download_zk.router,
    prefix=settings.API_PREFIX,
    tags=["Encrypted Download"]
)

app.include_router(
    billing.router,
    prefix="/api/v1/billing",
    tags=["Billing & Subscriptions"]
)

app.include_router(
    subscription_helpers.router,
    prefix="/api/v1/subscription-ui",
    tags=["Subscription UI Helpers"]
)


# ========== STARTUP MESSAGE ==========

if __name__ == "__main__":
    import uvicorn

    logger.info(
        "starting_zk_service",
        host="0.0.0.0",
        port=settings.ZK_SERVICE_PORT,
        debug=settings.DEBUG
    )

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=settings.ZK_SERVICE_PORT,
        reload=settings.DEBUG,
        log_level=settings.LOG_LEVEL.lower()
    )
