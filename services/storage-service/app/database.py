# services/storage-service/app/database.py
from urllib.parse import urlparse, urlunparse

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import sessionmaker
import redis.asyncio as redis

from .config import settings

# Database Engine with connection pool for 100 concurrent uploads.
#
# Sits behind PgBouncer in transaction-pool mode (see infrastructure
# docker-compose.yml pgbouncer service). PgBouncer multiplexes the
# SQLAlchemy-side pool (50 base + 100 overflow) onto a small number of
# real Postgres backends (default_pool_size=25), so the app can keep
# its existing concurrency without exhausting Postgres max_connections.
#
# asyncpg + PgBouncer transaction-pooling gotcha: asyncpg defaults to
# ``statement_cache_size=100`` which creates *server-side* prepared
# statements. Those statements are bound to a specific backend
# connection — and transaction pooling hands a different backend to
# the next transaction, so the cached statement either "already exists"
# (collision) or "does not exist" (miss). Forcing ``statement_cache_size=0``
# switches asyncpg to use unnamed prepared statements that are scoped
# to a single protocol round-trip, which is safe under any pooling mode.
engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,
    pool_size=50,          # Base pool size
    max_overflow=100,      # Additional connections beyond pool_size
    pool_pre_ping=True,    # Verify connections before using
    pool_timeout=30,       # Max seconds to wait for a connection from pool
    pool_recycle=3600,     # Recycle connections after 1 hour (prevent stale connections)
    connect_args={
        "command_timeout": 30,   # Max seconds for any single query
        "statement_cache_size": 0,  # Required for PgBouncer transaction pool mode
    }
)
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

# ---------------------------------------------------------------------------
# Redis logical-DB split
# ---------------------------------------------------------------------------
# The main Redis instance is partitioned by purpose via database indexes so
# each concern has independent keyspace, FLUSHDB, and telemetry — while still
# sharing a single container (cheap, and reversible when we later split into
# separate Redis instances).
#
# DB 0 → sessions, upload sessions, quota reservations, generic cache.
#        This is the default `redis_client` — all legacy callers stay here
#        unchanged.
# DB 1 → (reserved) pure ephemeral cache. Not yet wired; opt-in via a
#        future `get_redis_cache()` helper once call sites are migrated.
# DB 2 → rate-limit counters. Wired through FastAPILimiter + the billing
#        RateLimiter in main.py. Isolating this DB lets us FLUSHDB rate
#        buckets in an incident without blowing away user sessions.
# DB 3 → (reserved) pub/sub. NOTE: Redis pub/sub channels are GLOBAL across
#        databases, so moving publishers/subscribers is cosmetic for message
#        routing. A dedicated DB/client is still useful if we later want
#        to isolate the pub/sub connection pool — tracked for a future
#        migration, not done here.
# ---------------------------------------------------------------------------

REDIS_DB_DEFAULT = 0
REDIS_DB_CACHE = 1
REDIS_DB_RATELIMIT = 2
REDIS_DB_PUBSUB = 3


def build_redis_url(db_index: int) -> str:
    """Return ``settings.REDIS_URL`` with the database index set to ``db_index``.

    Handles URLs with and without an existing ``/db`` path suffix, as well as
    URLs that carry credentials or query parameters. Example::

        redis://localhost:6379       → redis://localhost:6379/2
        redis://edge_redis:6379/0    → redis://edge_redis:6379/2
        redis://:pw@host:6379/?ssl=1 → redis://:pw@host:6379/2?ssl=1
    """
    parsed = urlparse(settings.REDIS_URL)
    return urlunparse((
        parsed.scheme,
        parsed.netloc,
        f"/{db_index}",
        parsed.params,
        parsed.query,
        parsed.fragment,
    ))


# Client singletons (initialized at startup).
redis_client = None              # DB 0 — default client (sessions + legacy usage)
redis_ratelimit_client = None    # DB 2 — FastAPILimiter + billing RateLimiter


async def init_redis():
    """Initialize Redis connection pools.

    Creates two clients against the same Redis instance:
      - ``redis_client`` on DB 0 (default, bytes payloads for binary data).
      - ``redis_ratelimit_client`` on DB 2 (strings, as fastapi-limiter's
        Lua scripts expect decoded responses).

    Returns the default client so existing callers of
    ``await init_redis()`` see no change.
    """
    global redis_client, redis_ratelimit_client

    # DB 0 — default pool: sessions, upload sessions, quota reservations,
    # inline storage, generic cache. decode_responses=False so binary
    # payloads (inline file content) survive round-trips.
    redis_client = await redis.from_url(
        build_redis_url(REDIS_DB_DEFAULT),
        encoding="utf-8",
        decode_responses=False,
        max_connections=100,
        socket_connect_timeout=5,
        socket_timeout=5,
        socket_keepalive=True,
        retry_on_timeout=True,
        health_check_interval=30,
    )

    # DB 2 — rate-limit counters. fastapi-limiter and the billing
    # RateLimiter operate on numeric/string keys, so decode_responses=True
    # matches their existing expectations.
    redis_ratelimit_client = await redis.from_url(
        build_redis_url(REDIS_DB_RATELIMIT),
        encoding="utf-8",
        decode_responses=True,
        max_connections=50,
        socket_connect_timeout=5,
        socket_timeout=5,
        socket_keepalive=True,
        retry_on_timeout=True,
        health_check_interval=30,
    )

    return redis_client


async def close_redis():
    """Close all Redis connections opened by :func:`init_redis`.

    Defensive against double-close: ``FastAPILimiter.close()`` in the app
    shutdown path closes ``redis_ratelimit_client`` before this runs, so
    we swallow close-time errors here to keep shutdown idempotent.
    """
    global redis_client, redis_ratelimit_client
    if redis_client is not None:
        try:
            await redis_client.close()
        except Exception:
            pass
        redis_client = None
    if redis_ratelimit_client is not None:
        try:
            await redis_ratelimit_client.close()
        except Exception:
            pass
        redis_ratelimit_client = None


async def get_redis():
    """Get the default Redis client (DB 0).

    This is the legacy entry point — all existing callers continue to use it
    for sessions, upload sessions, quota reservations, and cache.
    """
    return redis_client


async def get_redis_ratelimit():
    """Get the rate-limit Redis client (DB 2).

    Used by FastAPILimiter and the billing RateLimiter. Future quota-counter
    code that should live in an isolated keyspace can also depend on this
    helper instead of ``get_redis``.
    """
    return redis_ratelimit_client


async def get_db():
    """Dependency to get database session"""
    async with AsyncSessionLocal() as session:
        yield session
