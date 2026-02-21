# services/storage-service/app/services/upload_session_store.py
"""
Upload session persistence layer.

Primary: Redis (fast, with 1-hour TTL)
Fallback: PostgreSQL (survives Redis restarts)

On read, tries Redis first. If missing, checks DB and repopulates Redis.
On write, writes to both Redis and DB.
"""

import json
import logging
from datetime import datetime, timedelta
from typing import Optional, Callable
import redis.asyncio as redis_exceptions

logger = logging.getLogger(__name__)

REDIS_TTL = 3600  # 1 hour


async def save_upload_session(
    redis_client,
    db,
    upload_id: str,
    session_data: dict,
) -> None:
    """Save upload session to Redis and DB."""
    session_json = json.dumps(session_data)

    # Primary: Redis
    await redis_client.setex(f"up:{upload_id}", REDIS_TTL, session_json)

    # Secondary: DB (fire-and-forget is OK here since Redis is the primary)
    try:
        from ..models.database import UploadSession
        from sqlalchemy import text
        from sqlalchemy.dialects.postgresql import insert

        expires_at = datetime.utcnow() + timedelta(seconds=REDIS_TTL)
        stmt = insert(UploadSession).values(
            upload_id=upload_id,
            user_id=session_data["user"],
            session_data=session_data,
            expires_at=expires_at,
            updated_at=datetime.utcnow(),
        ).on_conflict_do_update(
            index_elements=["upload_id"],
            set_={
                "session_data": session_data,
                "updated_at": datetime.utcnow(),
                "expires_at": expires_at,
            },
        )
        await db.execute(stmt)
        await db.commit()
    except Exception as e:
        logger.warning(f"Failed to persist upload session {upload_id} to DB: {e}")


async def get_upload_session(
    redis_client,
    db,
    upload_id: str,
) -> Optional[dict]:
    """
    Get upload session. Tries Redis first, falls back to DB.
    If found in DB but not Redis, repopulates Redis.
    """
    # Try Redis first
    session_data = await redis_client.get(f"up:{upload_id}")
    if session_data:
        if isinstance(session_data, bytes):
            session_data = session_data.decode("utf-8")
        return json.loads(session_data)

    # Fallback: try DB
    try:
        from ..models.database import UploadSession
        from sqlalchemy import select

        result = await db.execute(
            select(UploadSession).where(
                UploadSession.upload_id == upload_id,
                UploadSession.expires_at > datetime.utcnow(),
            )
        )
        row = result.scalar_one_or_none()
        if row:
            logger.info(f"Recovered upload session {upload_id} from DB (Redis miss)")
            session = row.session_data
            # Repopulate Redis
            remaining_ttl = int((row.expires_at - datetime.utcnow()).total_seconds())
            if remaining_ttl > 0:
                await redis_client.setex(
                    f"up:{upload_id}", remaining_ttl, json.dumps(session)
                )
            return session
    except Exception as e:
        logger.warning(f"Failed to recover upload session {upload_id} from DB: {e}")

    return None


async def delete_upload_session(
    redis_client,
    db,
    upload_id: str,
) -> None:
    """Delete upload session from both Redis and DB."""
    await redis_client.delete(f"up:{upload_id}")

    try:
        from ..models.database import UploadSession
        from sqlalchemy import delete

        await db.execute(
            delete(UploadSession).where(UploadSession.upload_id == upload_id)
        )
        await db.commit()
    except Exception as e:
        logger.warning(f"Failed to delete upload session {upload_id} from DB: {e}")


async def update_upload_session_atomic(
    redis_client,
    db,
    upload_id: str,
    update_fn: Callable[[dict], dict],
    max_retries: int = 5,
) -> Optional[dict]:
    """
    Atomically update an upload session using Redis WATCH/MULTI.

    Prevents the read-modify-write race where two concurrent chunk uploads
    both read the session, both append to done[], and one overwrites the other.

    Args:
        redis_client: Redis client
        db: DB session (for best-effort persistence)
        upload_id: Upload ID
        update_fn: Function that receives current session dict, returns modified dict
        max_retries: Max optimistic-lock retries before raising

    Returns:
        Updated session dict, or None if session not found
    """
    key = f"up:{upload_id}"
    for attempt in range(max_retries):
        try:
            await redis_client.watch(key)
            raw = await redis_client.get(key)
            if not raw:
                await redis_client.unwatch()
                return None
            session = json.loads(raw if isinstance(raw, str) else raw.decode())
            session = update_fn(session)
            pipe = redis_client.pipeline()
            pipe.multi()
            pipe.setex(key, REDIS_TTL, json.dumps(session))
            await pipe.execute()
            # Best-effort DB persistence
            try:
                await _persist_session_to_db(db, upload_id, session)
            except Exception as e:
                logger.warning(f"Failed to persist session {upload_id} to DB: {e}")
            return session
        except Exception as e:
            # redis.WatchError or similar — retry
            if "WATCH" in str(type(e).__name__).upper() or "watch" in str(e).lower():
                continue
            raise
    raise Exception(f"Session update conflict after {max_retries} retries for {upload_id}")


async def _persist_session_to_db(db, upload_id: str, session_data: dict) -> None:
    """Best-effort persist session to DB."""
    from ..models.database import UploadSession
    from sqlalchemy.dialects.postgresql import insert

    expires_at = datetime.utcnow() + timedelta(seconds=REDIS_TTL)
    stmt = insert(UploadSession).values(
        upload_id=upload_id,
        user_id=session_data["user"],
        session_data=session_data,
        expires_at=expires_at,
        updated_at=datetime.utcnow(),
    ).on_conflict_do_update(
        index_elements=["upload_id"],
        set_={
            "session_data": session_data,
            "updated_at": datetime.utcnow(),
            "expires_at": expires_at,
        },
    )
    await db.execute(stmt)
    await db.commit()
