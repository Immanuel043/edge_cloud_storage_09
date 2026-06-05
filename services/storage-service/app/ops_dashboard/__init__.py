"""Admin ops dashboard package.

A standalone, DB + Redis backed operational dashboard served by the
storage-service itself (no Prometheus, no React build). It reads worker
liveness from the core ``app.monitoring.worker_heartbeat`` primitive plus
direct Postgres aggregates.

Intentionally does NOT import ``router`` at package load. Import it explicitly:

    from app.ops_dashboard.router import router as ops_dashboard_router
"""
