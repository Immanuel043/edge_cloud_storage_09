# services/storage-service/app/services/upload_session_store.py
"""
Upload session persistence layer.

Primary: Redis (fast, with 24-hour TTL)
Fallback: PostgreSQL (survives Redis restarts)

On read, tries Redis first. If missing, checks DB and repopulates Redis.
On write, writes to both Redis and DB.
"""

import json
import logging
from datetime import datetime, timedelta
from typing import Optional

logger = logging.getLogger(__name__)

REDIS_TTL = 86400  # 24 hours

# Lua script for atomic chunk update — single round-trip, no WATCH needed.
# KEYS[1] = "up:{upload_id}"
# ARGV[1] = chunk_index, ARGV[2] = chunk_hash
# ARGV[3] = storage_path, ARGV[4] = TTL
UPDATE_CHUNK_LUA = """
if cjson.encode_empty_table_as_object then
  cjson.encode_empty_table_as_object(false)
end

local raw = redis.call("GET", KEYS[1])
if not raw then return false end
local session = cjson.decode(raw)
local chunk_idx = tonumber(ARGV[1])

local found = false
if session["done"] then
  for _, v in ipairs(session["done"]) do
    if v == chunk_idx then found = true; break end
  end
end

if not found then
  if not session["done"] then session["done"] = {} end
  if not session["hashes"] then session["hashes"] = {} end
  table.insert(session["done"], chunk_idx)
  table.insert(session["hashes"], ARGV[2])
end

if not session["chunk_paths"] then session["chunk_paths"] = {} end
session["chunk_paths"][tostring(chunk_idx)] = ARGV[3]

local updated = cjson.encode(session)
redis.call("SETEX", KEYS[1], tonumber(ARGV[4]), updated)
return updated
"""


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
        from sqlalchemy import text
        from sqlalchemy.dialects.postgresql import insert

        from ..models.database import UploadSession

        expires_at = datetime.utcnow() + timedelta(seconds=REDIS_TTL)
        stmt = (
            insert(UploadSession)
            .values(
                upload_id=upload_id,
                user_id=session_data["user"],
                session_data=session_data,
                expires_at=expires_at,
                updated_at=datetime.utcnow(),
            )
            .on_conflict_do_update(
                index_elements=["upload_id"],
                set_={
                    "session_data": session_data,
                    "updated_at": datetime.utcnow(),
                    "expires_at": expires_at,
                },
            )
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
        from sqlalchemy import select

        from ..models.database import UploadSession

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
                await redis_client.setex(f"up:{upload_id}", remaining_ttl, json.dumps(session))
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
        from sqlalchemy import delete

        from ..models.database import UploadSession

        await db.execute(delete(UploadSession).where(UploadSession.upload_id == upload_id))
        await db.commit()
    except Exception as e:
        logger.warning(f"Failed to delete upload session {upload_id} from DB: {e}")


async def update_upload_session_atomic(
    redis_client,
    db,
    upload_id: str,
    *,
    chunk_index: int,
    chunk_hash: str,
    storage_path: str,
) -> Optional[dict]:
    """
    Atomically update an upload session using a Redis Lua script.

    Single round-trip, zero retries, true atomicity — the Lua script runs
    entirely on the Redis server so concurrent chunk uploads cannot interleave.

    Returns:
        Updated session dict, or None if session key not found
    """
    key = f"up:{upload_id}"
    result = await redis_client.eval(
        UPDATE_CHUNK_LUA,
        1,
        key,
        str(chunk_index),
        chunk_hash,
        storage_path,
        str(REDIS_TTL),
    )
    if result is None:
        return None
    session = json.loads(result.decode("utf-8") if isinstance(result, bytes) else result)

    # Best-effort DB persistence
    try:
        await _persist_session_to_db(db, upload_id, session)
    except Exception as e:
        logger.warning(f"Failed to persist session {upload_id} to DB: {e}")

    return session


async def _persist_session_to_db(db, upload_id: str, session_data: dict) -> None:
    """Best-effort persist session to DB."""
    from sqlalchemy.dialects.postgresql import insert

    from ..models.database import UploadSession

    expires_at = datetime.utcnow() + timedelta(seconds=REDIS_TTL)
    stmt = (
        insert(UploadSession)
        .values(
            upload_id=upload_id,
            user_id=session_data["user"],
            session_data=session_data,
            expires_at=expires_at,
            updated_at=datetime.utcnow(),
        )
        .on_conflict_do_update(
            index_elements=["upload_id"],
            set_={
                "session_data": session_data,
                "updated_at": datetime.utcnow(),
                "expires_at": expires_at,
            },
        )
    )
    await db.execute(stmt)
    await db.commit()
