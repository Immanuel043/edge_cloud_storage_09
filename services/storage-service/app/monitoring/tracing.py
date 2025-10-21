"""
Distributed Tracing with Jaeger

Provides end-to-end request tracing across the platform for performance
debugging and monitoring.

Features:
- Automatic FastAPI instrumentation
- Database query tracing
- Redis operation tracing
- Custom span creation
- Trace context propagation
"""

import os
from typing import Optional
from opentelemetry import trace
from opentelemetry.exporter.jaeger.thrift import JaegerExporter
from opentelemetry.sdk.resources import SERVICE_NAME, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor
from opentelemetry.instrumentation.redis import RedisInstrumentor
from opentelemetry.instrumentation.requests import RequestsInstrumentor


class TracingService:
    """Distributed tracing service using Jaeger."""

    def __init__(self):
        self.tracer: Optional[trace.Tracer] = None
        self.enabled = os.getenv("TRACING_ENABLED", "false").lower() == "true"

    def init_tracer(self, service_name: str = "edge-storage-api"):
        """Initialize Jaeger tracer."""

        if not self.enabled:
            print("Tracing is disabled")
            return

        # Create resource with service name
        resource = Resource(attributes={
            SERVICE_NAME: service_name
        })

        # Create tracer provider
        provider = TracerProvider(resource=resource)

        # Configure Jaeger exporter
        jaeger_exporter = JaegerExporter(
            agent_host_name=os.getenv("JAEGER_AGENT_HOST", "localhost"),
            agent_port=int(os.getenv("JAEGER_AGENT_PORT", "6831")),
        )

        # Add span processor
        provider.add_span_processor(
            BatchSpanProcessor(jaeger_exporter)
        )

        # Set as global tracer
        trace.set_tracer_provider(provider)

        # Get tracer instance
        self.tracer = trace.get_tracer(__name__)

        print(f"✅ Jaeger tracing initialized for service: {service_name}")

    def instrument_app(self, app):
        """Instrument FastAPI application."""

        if not self.enabled:
            return

        # Instrument FastAPI
        FastAPIInstrumentor.instrument_app(app)

        # Instrument requests library (for external HTTP calls)
        RequestsInstrumentor().instrument()

        print("✅ FastAPI instrumentation enabled")

    def instrument_database(self, engine):
        """Instrument SQLAlchemy database."""

        if not self.enabled:
            return

        SQLAlchemyInstrumentor().instrument(
            engine=engine,
            service="edge-storage-db"
        )

        print("✅ Database instrumentation enabled")

    def instrument_redis(self):
        """Instrument Redis client."""

        if not self.enabled:
            return

        RedisInstrumentor().instrument()

        print("✅ Redis instrumentation enabled")

    def create_span(self, name: str, attributes: Optional[dict] = None):
        """Create a custom span for tracing."""

        if not self.enabled or not self.tracer:
            return NoOpSpan()

        span = self.tracer.start_span(name)

        if attributes:
            for key, value in attributes.items():
                span.set_attribute(key, str(value))

        return span

    def add_event(self, span, name: str, attributes: Optional[dict] = None):
        """Add an event to a span."""

        if not self.enabled:
            return

        span.add_event(name, attributes=attributes or {})

    def set_error(self, span, error: Exception):
        """Mark span as error."""

        if not self.enabled:
            return

        span.set_status(trace.Status(trace.StatusCode.ERROR, str(error)))
        span.record_exception(error)


class NoOpSpan:
    """No-op span for when tracing is disabled."""

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def set_attribute(self, *args, **kwargs):
        pass

    def add_event(self, *args, **kwargs):
        pass

    def set_status(self, *args, **kwargs):
        pass

    def record_exception(self, *args, **kwargs):
        pass


# Global tracing service instance
tracing_service = TracingService()


# Decorator for tracing functions
def trace_function(name: Optional[str] = None):
    """Decorator to trace a function."""

    def decorator(func):
        from functools import wraps

        @wraps(func)
        async def async_wrapper(*args, **kwargs):
            span_name = name or f"{func.__module__}.{func.__name__}"

            with tracing_service.create_span(span_name) as span:
                try:
                    result = await func(*args, **kwargs)
                    return result
                except Exception as e:
                    tracing_service.set_error(span, e)
                    raise

        @wraps(func)
        def sync_wrapper(*args, **kwargs):
            span_name = name or f"{func.__module__}.{func.__name__}"

            with tracing_service.create_span(span_name) as span:
                try:
                    result = func(*args, **kwargs)
                    return result
                except Exception as e:
                    tracing_service.set_error(span, e)
                    raise

        # Return appropriate wrapper based on function type
        import asyncio
        if asyncio.iscoroutinefunction(func):
            return async_wrapper
        else:
            return sync_wrapper

    return decorator


# Usage Examples:
#
# @trace_function("upload_file")
# async def upload_file(file_id: str, data: bytes):
#     # Function is automatically traced
#     pass
#
# # Manual span creation:
# with tracing_service.create_span("process_upload") as span:
#     span.set_attribute("file_id", file_id)
#     # ... process upload ...
#     tracing_service.add_event(span, "upload_completed")
