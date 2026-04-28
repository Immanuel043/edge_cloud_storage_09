"""
Sentry Error Tracking Integration

Provides comprehensive error tracking, performance monitoring, and
crash reporting for the Edge Cloud Storage platform.

Features:
- Automatic error capture
- Performance transaction tracking
- User context tracking
- Breadcrumbs for debugging
- Release tracking
- Environment tagging
"""

import os
from typing import Dict, Optional

import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.logging import LoggingIntegration
from sentry_sdk.integrations.redis import RedisIntegration
from sentry_sdk.integrations.sqlalchemy import SqlalchemyIntegration


class SentryService:
    """Sentry error tracking and performance monitoring service."""

    def __init__(self):
        self.enabled = os.getenv("SENTRY_ENABLED", "false").lower() == "true"
        self.dsn = os.getenv("SENTRY_DSN", "")
        self.environment = os.getenv("ENVIRONMENT", "development")
        self.release = os.getenv("RELEASE_VERSION", "1.0.0")

    def init_sentry(self):
        """Initialize Sentry SDK."""

        if not self.enabled or not self.dsn:
            print("Sentry is disabled or DSN not configured")
            return

        sentry_sdk.init(
            dsn=self.dsn,
            environment=self.environment,
            release=f"edge-storage@{self.release}",
            # Integrations
            integrations=[
                FastApiIntegration(),
                SqlalchemyIntegration(),
                RedisIntegration(),
                LoggingIntegration(
                    level=None,  # Capture all log levels
                    event_level=None,  # Send all events to Sentry
                ),
            ],
            # Performance monitoring
            traces_sample_rate=float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "0.1")),
            # Error sampling
            sample_rate=1.0,  # 100% error capture
            # Send default PII (Personally Identifiable Information)
            send_default_pii=False,  # Don't send PII by default for GDPR compliance
            # Before send callback for filtering
            before_send=self.before_send,
            # Before breadcrumb callback
            before_breadcrumb=self.before_breadcrumb,
            # Max breadcrumbs
            max_breadcrumbs=50,
            # Attach stack traces
            attach_stacktrace=True,
            # Enable profiling
            profiles_sample_rate=float(os.getenv("SENTRY_PROFILES_SAMPLE_RATE", "0.1")),
        )

        print(f"✅ Sentry initialized for environment: {self.environment}")

    def before_send(self, event, hint):
        """Filter events before sending to Sentry."""

        # Don't send certain exceptions
        if "exc_info" in hint:
            exc_type, exc_value, tb = hint["exc_info"]

            # Skip common exceptions
            if exc_type.__name__ in ["HTTPException", "ValidationError"]:
                return None

        # Add custom tags
        event.setdefault("tags", {})
        event["tags"]["environment"] = self.environment

        return event

    def before_breadcrumb(self, crumb, hint):
        """Filter breadcrumbs before adding to Sentry."""

        # Skip noisy breadcrumbs
        if crumb.get("category") == "query" and "SELECT 1" in str(crumb.get("message", "")):
            return None

        return crumb

    def capture_exception(self, error: Exception, context: Optional[Dict] = None):
        """Manually capture an exception."""

        if not self.enabled:
            return

        with sentry_sdk.push_scope() as scope:
            if context:
                for key, value in context.items():
                    scope.set_context(key, value)

            sentry_sdk.capture_exception(error)

    def capture_message(self, message: str, level: str = "info", context: Optional[Dict] = None):
        """Capture a message."""

        if not self.enabled:
            return

        with sentry_sdk.push_scope() as scope:
            if context:
                for key, value in context.items():
                    scope.set_context(key, value)

            sentry_sdk.capture_message(message, level=level)

    def set_user(self, user_id: str, email: Optional[str] = None, username: Optional[str] = None):
        """Set user context."""

        if not self.enabled:
            return

        sentry_sdk.set_user({"id": user_id, "email": email, "username": username})

    def set_tag(self, key: str, value: str):
        """Set a tag."""

        if not self.enabled:
            return

        sentry_sdk.set_tag(key, value)

    def set_context(self, name: str, context: Dict):
        """Set additional context."""

        if not self.enabled:
            return

        sentry_sdk.set_context(name, context)

    def add_breadcrumb(
        self,
        message: str,
        category: str = "default",
        level: str = "info",
        data: Optional[Dict] = None,
    ):
        """Add a breadcrumb for debugging."""

        if not self.enabled:
            return

        sentry_sdk.add_breadcrumb(message=message, category=category, level=level, data=data or {})

    def start_transaction(self, name: str, op: str = "http"):
        """Start a performance transaction."""

        if not self.enabled:
            return NoOpTransaction()

        return sentry_sdk.start_transaction(name=name, op=op)

    def start_span(self, operation: str, description: Optional[str] = None):
        """Start a performance span."""

        if not self.enabled:
            return NoOpSpan()

        return sentry_sdk.start_span(op=operation, description=description)


class NoOpTransaction:
    """No-op transaction for when Sentry is disabled."""

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def set_tag(self, *args, **kwargs):
        pass

    def set_context(self, *args, **kwargs):
        pass


class NoOpSpan:
    """No-op span for when Sentry is disabled."""

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def set_tag(self, *args, **kwargs):
        pass

    def set_data(self, *args, **kwargs):
        pass


# Global Sentry service instance
sentry_service = SentryService()


# Decorator for tracking function performance
def track_performance(operation: str):
    """Decorator to track function performance in Sentry."""

    def decorator(func):
        from functools import wraps

        @wraps(func)
        async def async_wrapper(*args, **kwargs):
            with sentry_service.start_span(operation=operation, description=func.__name__):
                return await func(*args, **kwargs)

        @wraps(func)
        def sync_wrapper(*args, **kwargs):
            with sentry_service.start_span(operation=operation, description=func.__name__):
                return func(*args, **kwargs)

        # Return appropriate wrapper
        import asyncio

        if asyncio.iscoroutinefunction(func):
            return async_wrapper
        else:
            return sync_wrapper

    return decorator


# Usage Examples:
#
# # Capture exception
# try:
#     risky_operation()
# except Exception as e:
#     sentry_service.capture_exception(e, context={"file_id": file_id})
#
# # Set user context
# sentry_service.set_user(user_id=current_user.id, email=current_user.email)
#
# # Add breadcrumb
# sentry_service.add_breadcrumb("Starting file upload", category="upload", data={"size": file_size})
#
# # Performance tracking
# @track_performance("database.query")
# async def get_user_files(user_id: str):
#     # Automatically tracked in Sentry
#     pass
#
# # Manual transaction
# with sentry_service.start_transaction(name="upload_file", op="upload") as transaction:
#     transaction.set_tag("file_type", "image")
#     # ... upload logic ...
