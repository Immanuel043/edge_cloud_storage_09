# services/storage-service/app/middleware/performance.py
import json
import logging
import time

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


class PerformanceMiddleware(BaseHTTPMiddleware):
    """
    Middleware to track API performance and identify redirect issues
    Properly inherits from BaseHTTPMiddleware for ASGI compatibility
    """

    def __init__(self, app, slow_threshold: float = 0.5):
        super().__init__(app)
        self.slow_threshold = slow_threshold  # seconds

    async def dispatch(self, request: Request, call_next) -> Response:
        """Process the request and add performance tracking.

        `process_time` measures the interval between request entry and the
        moment Starlette's `call_next` returns — which is BEFORE the response
        body has been sent over the socket and BEFORE any FastAPI
        `BackgroundTasks` have run. So this metric reflects handler-and-stack
        wall-clock time, not the user-perceived TTFB exactly, and it is
        deliberately *not* inflated by background work. If you optimize a
        handler by deferring work into BackgroundTasks, this number will
        drop accordingly.
        """

        # Skip health checks to reduce noise
        if request.url.path in ["/api/v1/health", "/api/v1/ready", "/api/v1/live"]:
            return await call_next(request)

        start_time = time.perf_counter()

        # Track the original URL
        original_path = request.url.path

        # Process request
        response = await call_next(request)

        # Calculate processing time
        process_time = time.perf_counter() - start_time

        # Add timing header
        response.headers["X-Process-Time"] = f"{round(process_time * 1000, 2)}ms"

        # Prepare log data
        log_data = {
            "method": request.method,
            "path": original_path,
            "status": response.status_code,
            "duration_ms": round(process_time * 1000, 2),
            "client": request.client.host if request.client else "unknown",
        }

        # IMPORTANT: Flag redirects - these are your performance killers!
        if response.status_code in [301, 302, 307, 308]:
            log_data["redirect"] = True
            log_data["location"] = response.headers.get("location", "unknown")
            logger.warning(f"🔄 REDIRECT DETECTED: {json.dumps(log_data)}")

            # Track redirect patterns
            if response.status_code == 307:
                logger.error(
                    f"❌ 307 REDIRECT: {original_path} -> {response.headers.get('location')} - FIX THIS!"
                )

        # Flag slow requests
        elif process_time > self.slow_threshold:
            log_data["slow"] = True
            logger.warning(f"🐢 SLOW REQUEST: {json.dumps(log_data)}")

        # Only log non-OPTIONS requests at INFO level
        elif request.method != "OPTIONS":
            logger.info(f"✓ {log_data['method']} {log_data['path']} - {log_data['duration_ms']}ms")

        return response
