# services/storage-service/app/middleware/request_timeout.py
"""
Global ASGI request timeout middleware.

Wraps handler execution in `asyncio.wait_for` so a hung downstream (cold ES,
stalled ClamAV socket, slow dedup lock) cannot tie up a uvicorn worker
indefinitely. On timeout the client receives HTTP 504.

Per-prefix overrides exist for long-running routes (upload/download) that
legitimately need minutes-to-hours of wall time. These align with the nginx
proxy timeouts in `infrastructure/nginx/nginx.conf` so the layers agree on
when to give up.

Streaming responses (FastAPI `StreamingResponse`, `FileResponse`) are not
affected: the timeout bounds the time for `call_next` to *return* the
`Response` object, not the time to stream its body. A handler that returns
quickly and streams for an hour is still allowed through.

WebSocket upgrades use a different ASGI scope ("websocket") and are not
dispatched through `BaseHTTPMiddleware`, so WS connections are naturally
exempt from this timeout.
"""
import asyncio
import logging
from typing import Dict, Tuple

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger(__name__)


# Default per-request wall-time budget. 60s is enough for any non-upload
# handler and is well under the uvicorn keep-alive window.
DEFAULT_TIMEOUT_SECONDS = 60.0

# Paths skipped entirely (no timeout wrapping). Health probes must stay
# snappy and docs should never 504.
SKIP_PREFIXES: Tuple[str, ...] = (
    "/api/v1/health",
    "/api/v1/ready",
    "/api/v1/live",
    "/docs",
    "/redoc",
    "/openapi.json",
    "/metrics",
)

# Prefix → timeout seconds. Longest-prefix wins. These values are aligned
# with nginx `proxy_read_timeout` / `client_body_timeout` for the same paths.
PREFIX_TIMEOUTS: Dict[str, float] = {
    # Uploads: chunk streaming + virus scan + dedup lookup can legitimately
    # take hours on 200GB files over mobile connections.
    "/api/v1/upload": 7200.0,
    "/api/v1/url-upload": 7200.0,
    "/api/v1/folder-upload": 7200.0,
    # Downloads: large-file streaming; bounded by nginx's 300s for the
    # response-start, but we allow the handler itself up to 600s in case
    # of cold-tier promotion or dedup block reassembly.
    "/api/v1/files": 600.0,
    "/api/v1/download": 600.0,
    # Background-heavy ML analysis endpoints.
    "/api/v1/file-analysis": 300.0,
    "/api/v1/search": 120.0,
}


def _resolve_timeout(path: str) -> float:
    """Return the timeout for a given path, longest-prefix match."""
    best: float = DEFAULT_TIMEOUT_SECONDS
    best_len = -1
    for prefix, seconds in PREFIX_TIMEOUTS.items():
        if path.startswith(prefix) and len(prefix) > best_len:
            best = seconds
            best_len = len(prefix)
    return best


class RequestTimeoutMiddleware(BaseHTTPMiddleware):
    """Enforce a per-request wall-time budget via asyncio.wait_for."""

    def __init__(self, app, default_timeout: float = DEFAULT_TIMEOUT_SECONDS):
        super().__init__(app)
        self.default_timeout = default_timeout

    async def dispatch(self, request: Request, call_next) -> Response:
        path = request.url.path

        # Skip health/docs/metrics — these must never 504.
        for prefix in SKIP_PREFIXES:
            if path.startswith(prefix):
                return await call_next(request)

        timeout = _resolve_timeout(path)

        try:
            return await asyncio.wait_for(call_next(request), timeout=timeout)
        except asyncio.TimeoutError:
            logger.error(
                "Request timed out after %.1fs: %s %s",
                timeout,
                request.method,
                path,
            )
            return JSONResponse(
                status_code=504,
                content={
                    "error": "Gateway Timeout",
                    "message": (
                        f"Request exceeded the {int(timeout)}s server-side "
                        "processing budget and was aborted."
                    ),
                    "status": 504,
                    "path": path,
                },
            )
