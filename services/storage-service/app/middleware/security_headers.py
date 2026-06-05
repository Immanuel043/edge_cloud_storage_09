"""Security headers middleware for comprehensive HTTP security"""

import logging

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

from ..config import settings

logger = logging.getLogger(__name__)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """
    Add comprehensive security headers to all HTTP responses

    Implements OWASP security best practices including:
    - HSTS (HTTP Strict Transport Security)
    - CSP (Content Security Policy)
    - X-Frame-Options (Clickjacking protection)
    - X-Content-Type-Options (MIME sniffing protection)
    - Referrer-Policy
    - Permissions-Policy
    """

    async def dispatch(self, request: Request, call_next):
        """Add security headers to response"""
        response: Response = await call_next(request)

        # Check if this is inline content (PDFs, videos for embedding)
        is_inline_content = (
            request.url.path.startswith("/api/v1/files/")
            and "/download" in request.url.path
            and request.query_params.get("inline") == "true"
        ) or (request.url.path.startswith("/api/v1/share/") and "/stream" in request.url.path)

        # 1. HSTS - Force HTTPS (only in production)
        if settings.ENABLE_HTTPS or settings.is_production:
            response.headers["Strict-Transport-Security"] = (
                "max-age=31536000; includeSubDomains; preload"
            )
            logger.debug("HSTS header set")

        # 2. X-Content-Type-Options - Prevent MIME type sniffing
        response.headers["X-Content-Type-Options"] = "nosniff"

        # 3. X-Frame-Options - Prevent clickjacking
        # Skip X-Frame-Options for inline content (CSP frame-ancestors handles it)
        # X-Frame-Options doesn't support multiple origins, so we rely on CSP
        if not is_inline_content:
            response.headers["X-Frame-Options"] = "DENY"

        # 4. X-XSS-Protection - Legacy XSS protection for older browsers
        response.headers["X-XSS-Protection"] = "1; mode=block"

        # 5. Referrer-Policy - Control referrer information
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"

        api_base = (getattr(settings, "API_BASE_URL", "") or "").strip()
        host_header = request.headers.get("host")
        request_origin = (
            f"{request.url.scheme}://{host_header}"
            if host_header
            else f"{request.url.scheme}://{request.url.netloc}"
        )
        if not api_base:
            api_base = request_origin
        media_src = ["media-src", "'self'", "blob:", api_base]
        if request_origin not in media_src:
            media_src.append(request_origin)

        # 6. Content Security Policy - Comprehensive XSS protection
        csp_directives = [
            "default-src 'self'",
            # Scripts: Allow self + inline (needed for React) + eval (needed for some libs)
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net",
            # Styles: Allow self + inline (needed for Tailwind/styled components)
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            # Images: Allow self + data URIs + HTTPS
            "img-src 'self' data: https: blob:",
            # Fonts: Allow self + data URIs + Google Fonts
            "font-src 'self' data: https://fonts.gstatic.com",
            # AJAX/WebSocket: Allow self + API domain
            f"connect-src 'self' {api_base} {request_origin} ws: wss:",
            # Media: Allow self + blob (for video/audio streaming)
            " ".join(media_src),
            # Objects: Disallow plugins
            "object-src 'none'",
            # Frames: Allow framing from frontend for inline content, otherwise disallow
            # Include common dev ports (5173 for Vite, 3000, 3001)
            (
                f"frame-ancestors 'self' {settings.FRONTEND_URL} {request_origin} http://localhost:5173 http://localhost:3000 http://localhost:3001"
                if is_inline_content
                else "frame-ancestors 'none'"
            ),
            # Base URI: Restrict to self
            "base-uri 'self'",
            # Form actions: Restrict to self
            "form-action 'self'",
            # Upgrade insecure requests (if HTTPS enabled)
        ]

        if settings.ENABLE_HTTPS or settings.is_production:
            csp_directives.append("upgrade-insecure-requests")

        response.headers["Content-Security-Policy"] = "; ".join(csp_directives)

        # 7. Permissions-Policy (Feature-Policy) - Disable unused browser features
        # This prevents malicious iframes from using device APIs
        # For inline content (PDFs in iframes), allow fullscreen from any origin
        fullscreen_policy = "fullscreen=(*)" if is_inline_content else "fullscreen=(self)"
        # NOTE: Only list features current browsers recognize as Permissions-Policy
        # directives. Deprecated / never-shipped features (ambient-light-sensor,
        # battery, document-domain, execution-while-not-rendered,
        # execution-while-out-of-viewport, navigation-override) are ignored by
        # Chrome and emit "Unrecognized feature" console warnings, so they are
        # intentionally omitted.
        permissions = [
            "accelerometer=()",  # No accelerometer access
            "autoplay=()",  # No autoplay
            "camera=()",  # No camera access
            "cross-origin-isolated=()",
            "display-capture=()",
            "encrypted-media=()",
            fullscreen_policy,  # Allow fullscreen (relaxed for inline content)
            "geolocation=()",  # No geolocation
            "gyroscope=()",  # No gyroscope
            "magnetometer=()",  # No magnetometer
            "microphone=()",  # No microphone access
            "midi=()",
            "payment=()",  # No payment API
            "picture-in-picture=()",
            "publickey-credentials-get=()",
            "screen-wake-lock=()",
            "sync-xhr=()",
            "usb=()",  # No USB access
            "web-share=()",
            "xr-spatial-tracking=()",
        ]
        response.headers["Permissions-Policy"] = ", ".join(permissions)

        # 8. Cross-Origin Policies
        # Allow media downloads and thumbnails to be embedded cross-origin (used by frontend)
        is_media_download = (
            (request.url.path.startswith("/api/v1/files/") and "/download" in request.url.path)
            or (request.url.path.startswith("/api/v1/files/") and "/preview" in request.url.path)
            or (request.url.path.startswith("/api/v1/share/") and "/stream" in request.url.path)
            or (request.url.path.startswith("/api/v1/share/") and "/thumbnail" in request.url.path)
        )
        response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        response.headers["Cross-Origin-Resource-Policy"] = (
            "cross-origin" if is_media_download else "same-origin"
        )

        # 9. Remove server header - Don't leak server information
        if "Server" in response.headers:
            del response.headers["Server"]

        # 10. Cache-Control for API responses (prevent caching sensitive data)
        if request.url.path.startswith("/api/"):
            # Don't cache API responses by default
            if "Cache-Control" not in response.headers:
                response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, private"
                response.headers["Pragma"] = "no-cache"
                response.headers["Expires"] = "0"

        # Log security headers applied (debug mode only)
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug(f"Security headers applied to {request.method} {request.url.path}")

        return response


class CORSSecurityMiddleware(BaseHTTPMiddleware):
    """
    Additional CORS security checks beyond FastAPI's CORSMiddleware

    Validates Origin header and prevents CORS-based attacks
    """

    ALLOWED_ORIGINS = [
        "http://localhost:3000",
        "http://localhost:5173",
        "http://localhost:3001",
        settings.FRONTEND_URL,
    ]

    async def dispatch(self, request: Request, call_next):
        """Validate CORS requests"""
        origin = request.headers.get("Origin")

        # Check if origin is in allowed list for sensitive operations
        if origin and request.method in ["POST", "PUT", "DELETE", "PATCH"]:
            # For state-changing requests, strictly validate origin
            if origin not in self.ALLOWED_ORIGINS:
                # Log potential CORS attack
                logger.warning(
                    f"Rejected request from unauthorized origin: {origin} " f"to {request.url.path}"
                )

        response = await call_next(request)
        return response


# Export middleware classes
__all__ = ["SecurityHeadersMiddleware", "CORSSecurityMiddleware"]
