# services/storage-service/app/routers/upload.py

import asyncio
import hashlib
import json
import mimetypes
import os
import time
import uuid
from datetime import datetime
from typing import AsyncGenerator, List, Optional

import aiofiles
from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import get_redis
from ..dependencies import get_current_user, get_db, log_activity
from ..models.database import Object, User
from ..models.schemas import UploadInitResponse, UploadStatusResponse
from ..utils.file_streaming import _read_all_bytes
from ..monitoring.metrics import active_uploads, upload_completed, upload_duration, upload_initiated
from ..services.background_deduplication import background_dedup_service
from ..services.bandwidth_throttle import bandwidth_throttle_service
from ..services.encryption import encryption_service

# Import our services
from ..services.production_upload_service import production_upload_service
from ..services.upload_session_store import REDIS_TTL

router = APIRouter(prefix="/api/v1/upload", tags=["upload"])

# Configuration
STREAM_BUFFER_SIZE = int(os.getenv("STREAM_BUFFER_SIZE", 8 * 1024 * 1024))
INLINE_THRESHOLD = int(os.getenv("INLINE_THRESHOLD", 512 * 1024))
SINGLE_OBJECT_THRESHOLD = int(os.getenv("SINGLE_OBJECT_THRESHOLD", 50 * 1024 * 1024))
CHUNK_SIZE = int(os.getenv("CHUNK_SIZE", 32 * 1024 * 1024))

COMPRESSED_FORMATS = {
    ".zip",
    ".gz",
    ".rar",
    ".7z",
    ".bz2",
    ".xz",
    ".jpg",
    ".jpeg",
    ".png",
    ".mp4",
    ".mp3",
}
COMPRESSIBLE_FORMATS = {".txt", ".log", ".csv", ".json", ".xml"}


def should_compress(filename: str, size: int) -> bool:
    ext = os.path.splitext(filename)[1].lower()
    if ext in COMPRESSED_FORMATS:
        return False
    if ext in COMPRESSIBLE_FORMATS and size > 1024 * 1024:
        return True
    return False


async def get_user_storage_info_fast(user_id: str, db: AsyncSession):
    result = await db.execute(
        select(User.storage_quota, User.storage_used).where(User.id == user_id)
    )
    data = result.first()

    if not data:
        return {"quota": 0, "used": 0}

    return {"quota": int(data.storage_quota or 0), "used": int(data.storage_used or 0)}


@router.post("/init", response_model=UploadInitResponse)
async def init_upload(
    file_name: str,
    file_size: int,
    folder_id: Optional[str] = None,
    request: Request = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Initialize upload with smart storage decision"""
    if not file_name or file_size is None:
        raise HTTPException(400, "file_name and file_size required")

    redis_client = await get_redis()

    storage_info = await get_user_storage_info_fast(str(current_user.id), db)
    if storage_info["used"] + file_size > storage_info["quota"]:
        raise HTTPException(status_code=413, detail="Storage quota exceeded")

    if file_size < INLINE_THRESHOLD:
        storage_strategy = "inline"
        total_chunks = 0
    elif file_size < SINGLE_OBJECT_THRESHOLD:
        storage_strategy = "single"
        total_chunks = 0
    else:
        storage_strategy = "chunked"
        total_chunks = (file_size + CHUNK_SIZE - 1) // CHUNK_SIZE

    upload_id = str(uuid.uuid4())

    file_key = encryption_service.generate_file_key()
    encrypted_key = encryption_service.encrypt_key(file_key)
    use_compression = should_compress(file_name, file_size)

    session_data = {
        "id": upload_id,
        "user": str(current_user.id),
        "name": file_name,
        "size": file_size,
        "folder": folder_id,
        "strategy": storage_strategy,
        "chunks": total_chunks,
        "done": [],
        "hashes": [],
        "chunk_paths": {},
        "key": encrypted_key,
        "compress": use_compression,
        "start": datetime.utcnow().isoformat(),
    }

    await redis_client.setex(f"up:{upload_id}", REDIS_TTL, json.dumps(session_data))

    upload_initiated.labels(
        plan_type=getattr(current_user, "plan_type", "free"), storage_strategy=storage_strategy
    ).inc()
    active_uploads.inc()

    print(f"Upload initialized: {file_name} ({file_size/1024/1024:.1f}MB)")

    recommended_concurrency = await bandwidth_throttle_service.get_recommended_chunk_concurrency(
        str(current_user.id), current_user.plan_type or "free", current_user.max_concurrent_streams
    )

    return UploadInitResponse(
        upload_id=upload_id,
        storage_strategy=storage_strategy,
        chunk_size=CHUNK_SIZE if storage_strategy == "chunked" else 0,
        total_chunks=total_chunks,
        direct_upload=storage_strategy != "chunked",
        recommended_concurrency=recommended_concurrency,
    )


@router.post("/chunk/{upload_id}")
async def upload_chunk(
    upload_id: str,
    chunk_index: int,
    chunk: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Upload single chunk with parallel processing"""
    redis_client = await get_redis()

    session_data = await redis_client.get(f"up:{upload_id}")
    if not session_data:
        raise HTTPException(status_code=404, detail="Upload session not found")

    session = json.loads(session_data)

    if session["user"] != str(current_user.id):
        raise HTTPException(status_code=403, detail="Unauthorized")

    if chunk_index in session["done"]:
        return {"status": "already_uploaded", "chunk_index": chunk_index}

    storage_tier = "cache"
    shard = f"{upload_id[:2]}"
    storage_dir = f"/app/storage/{storage_tier}/{shard}"
    os.makedirs(storage_dir, exist_ok=True)

    chunk_data = await chunk.read()
    file_key = encryption_service.decrypt_key(session["key"])
    use_compression = session.get("compress", False)

    result = await production_upload_service.process_chunk_async(
        upload_id=upload_id,
        chunk_index=chunk_index,
        chunk_data=chunk_data,
        file_key=file_key,
        use_compression=use_compression,
        storage_dir=storage_dir,
    )

    if result["status"] != "success":
        raise HTTPException(500, f"Chunk processing failed: {result.get('error')}")

    session["done"].append(chunk_index)
    session["hashes"].append(result["hash"])
    session["chunk_paths"][str(chunk_index)] = result["storage_path"]

    asyncio.create_task(redis_client.setex(f"up:{upload_id}", REDIS_TTL, json.dumps(session)))

    progress = len(session["done"]) / session["chunks"] * 100 if session["chunks"] > 0 else 100

    return {
        "status": "success",
        "chunk_index": chunk_index,
        "progress": round(progress, 1),
        "encrypted": True,
        "compressed": use_compression,
    }


@router.post("/chunks-bulk/{upload_id}")
async def upload_chunks_bulk(
    upload_id: str,
    chunks: List[UploadFile] = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Upload multiple chunks in parallel"""
    redis_client = await get_redis()

    session_data = await redis_client.get(f"up:{upload_id}")
    if not session_data:
        raise HTTPException(status_code=404, detail="Upload session not found")

    session = json.loads(session_data)

    if session["user"] != str(current_user.id):
        raise HTTPException(status_code=403, detail="Unauthorized")

    storage_tier = "cache"
    shard = f"{upload_id[:2]}"
    storage_dir = f"/app/storage/{storage_tier}/{shard}"
    os.makedirs(storage_dir, exist_ok=True)

    chunks_data = []
    chunk_indices = []

    for i, chunk_file in enumerate(chunks):
        chunk_index = i

        if chunk_index not in session["done"]:
            chunk_data = await chunk_file.read()
            chunks_data.append(chunk_data)
            chunk_indices.append(chunk_index)

    if not chunks_data:
        return {"status": "success", "message": "All chunks already uploaded", "progress": 100.0}

    file_key = encryption_service.decrypt_key(session["key"])
    use_compression = session.get("compress", False)

    print(f"Processing {len(chunks_data)} chunks in parallel...")

    tasks = [
        production_upload_service.process_chunk_async(
            upload_id=upload_id,
            chunk_index=chunk_indices[i],
            chunk_data=chunk_data,
            file_key=file_key,
            use_compression=use_compression,
            storage_dir=storage_dir,
        )
        for i, chunk_data in enumerate(chunks_data)
    ]

    results = await asyncio.gather(*tasks, return_exceptions=True)

    successful = 0
    failed = 0

    for i, result in enumerate(results):
        if isinstance(result, Exception):
            failed += 1
        elif result["status"] == "success":
            chunk_idx = chunk_indices[i]
            session["done"].append(chunk_idx)
            session["hashes"].append(result["hash"])
            session["chunk_paths"][str(chunk_idx)] = result["storage_path"]
            successful += 1
        else:
            failed += 1

    await redis_client.setex(f"up:{upload_id}", REDIS_TTL, json.dumps(session))

    progress = len(session["done"]) / session["chunks"] * 100 if session["chunks"] > 0 else 100

    return {
        "status": "success" if failed == 0 else "partial",
        "uploaded_chunks": successful,
        "failed_chunks": failed,
        "total_chunks": len(chunks_data),
        "progress": round(progress, 1),
    }


@router.post("/direct/{upload_id}")
async def upload_direct(
    upload_id: str,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Direct upload for small/medium files"""
    redis_client = await get_redis()

    session_data = await redis_client.get(f"up:{upload_id}")
    if not session_data:
        raise HTTPException(status_code=404, detail="Upload session not found")

    session = json.loads(session_data)

    if session["user"] != str(current_user.id):
        raise HTTPException(status_code=403, detail="Unauthorized")

    file_data = await file.read()

    loop = asyncio.get_event_loop()
    file_key = encryption_service.decrypt_key(session["key"])
    use_compression = session.get("compress", False)

    def process_file():
        if use_compression:
            from ..utils.compression import compressor

            file_data_processed = compressor.compress(file_data)
        else:
            file_data_processed = file_data

        encrypted_data = encryption_service.encrypt_file(file_data_processed, file_key)
        file_hash = hashlib.sha256(file_data).hexdigest()
        return encrypted_data, file_hash

    encrypted_data, file_hash = await loop.run_in_executor(
        production_upload_service.executor, process_file
    )

    file_id = session["id"]
    storage_tier = "cache"

    if session["strategy"] == "inline":
        import base64

        session["encrypted_data"] = base64.b64encode(encrypted_data).decode()
        session["storage_type"] = "inline"
    else:
        shard = "objects"
        storage_dir = f"/app/storage/{storage_tier}/{shard}"
        os.makedirs(storage_dir, exist_ok=True)

        storage_path = f"{storage_dir}/{file_id}.enc"

        async with aiofiles.open(storage_path, "wb", buffering=STREAM_BUFFER_SIZE) as f:
            await f.write(encrypted_data)

        session["storage_path"] = storage_path
        session["storage_type"] = "single"

    session["hash"] = file_hash

    await redis_client.setex(f"up:{upload_id}", REDIS_TTL, json.dumps(session))

    return {
        "status": "success",
        "upload_id": upload_id,
        "encrypted": True,
        "compressed": use_compression,
        "ready_for_completion": True,
    }


@router.post("/complete/{upload_id}")
async def complete_upload(
    upload_id: str,
    background_tasks: BackgroundTasks,  # NEW: Added BackgroundTasks
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """
    Complete upload and create database record
    NEW: Deduplication runs as background task
    """
    redis_client = await get_redis()

    session_data = await redis_client.get(f"up:{upload_id}")
    if not session_data:
        raise HTTPException(status_code=404, detail="Upload session not found")

    session = json.loads(session_data)

    if session["user"] != str(current_user.id):
        raise HTTPException(status_code=403, detail="Unauthorized")

    storage_strategy = session.get("strategy", "chunked")
    start_time = datetime.fromisoformat(session["start"])

    # Verify completion
    if storage_strategy == "chunked":
        if len(session["done"]) != session["chunks"]:
            missing = set(range(session["chunks"])) - set(session["done"])
            return {"status": "incomplete", "missing_chunks": list(missing)}

    file_id = uuid.uuid4()
    mime_type = mimetypes.guess_type(session["name"])[0]

    # Create database record IMMEDIATELY (no waiting for dedup)
    if storage_strategy == "inline":
        import base64

        file_obj = Object(
            id=file_id,
            user_id=current_user.id,
            folder_id=session.get("folder"),
            file_name=session["name"],
            file_size=session["size"],
            mime_type=mime_type,
            storage_type="inline",
            storage_key=session.get("encrypted_data", ""),
            content_hash=session.get("hash", ""),
            encryption_key=session["key"],
            storage_tier="cache",
            file_metadata={"compressed": session.get("compress", False)},
        )

    elif storage_strategy == "single":
        file_obj = Object(
            id=file_id,
            user_id=current_user.id,
            folder_id=session.get("folder"),
            file_name=session["name"],
            file_size=session["size"],
            mime_type=mime_type,
            storage_type="single",
            object_path=session.get("storage_path", ""),
            content_hash=session.get("hash", ""),
            encryption_key=session["key"],
            storage_tier="cache",
            file_metadata={"compressed": session.get("compress", False)},
        )

    else:  # chunked
        combined_hash = hashlib.sha256("".join(session["hashes"]).encode()).hexdigest()

        file_obj = Object(
            id=file_id,
            user_id=current_user.id,
            folder_id=session.get("folder"),
            file_name=session["name"],
            file_size=session["size"],
            mime_type=mime_type,
            storage_type="chunked",
            content_hash=combined_hash,
            encryption_key=session["key"],
            chunk_info={
                "chunks": session["hashes"],
                "count": session["chunks"],
                "paths": session.get("chunk_paths", {}),
                "upload_id": upload_id,
                "compressed": session.get("compress", False),
            },
            storage_tier="cache",
        )

    db.add(file_obj)

    # Update user storage
    if hasattr(current_user, "storage_used"):
        current_user.storage_used = (current_user.storage_used or 0) + session["size"]

    await db.commit()

    await log_activity(
        db,
        current_user.id,
        "file_uploaded",
        str(file_id),
        {"file_name": session["name"], "size": session["size"]},
        request,
    )

    # ============ KEY CHANGE: Background Deduplication ============
    # Queue file for background deduplication if eligible
    enable_dedup = session["size"] > 10 * 1024 * 1024 and storage_strategy in ["single", "chunked"]

    if enable_dedup:
        await background_dedup_service.enqueue_for_dedup(
            file_id=str(file_id),
            upload_id=upload_id,
            user_id=str(current_user.id),
            session_data=session,
        )
        dedup_status = "queued"
    else:
        dedup_status = "not_applicable"
    # ============================================================

    # Clean up Redis
    await redis_client.delete(f"up:{upload_id}")

    duration = (datetime.utcnow() - start_time).total_seconds()
    upload_completed.labels(
        plan_type=getattr(current_user, "plan_type", "free"),
        storage_strategy=storage_strategy,
        status="success",
    ).inc()
    upload_duration.labels(storage_strategy=storage_strategy).observe(duration)
    active_uploads.dec()

    throughput = (session["size"] / (1024 * 1024)) / duration if duration > 0 else 0

    return {
        "status": "success",
        "file_id": str(file_id),
        "file_name": session["name"],
        "file_size": session["size"],
        "storage_type": storage_strategy,
        "encrypted": True,
        "compressed": session.get("compress", False),
        "duration": round(duration, 2),
        "throughput_mbps": round(throughput, 2),
        "deduplication": {
            "status": dedup_status,
            "message": (
                "Deduplication running in background"
                if dedup_status == "queued"
                else "File too small for deduplication"
            ),
        },
    }


@router.get("/dedup-status/{file_id}")
async def get_dedup_status(
    file_id: str, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Check deduplication status for a file"""

    # Verify file ownership
    result = await db.execute(
        select(Object).where(Object.id == file_id, Object.user_id == current_user.id)
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(404, "File not found")

    # Get dedup job status
    job_status = await background_dedup_service.get_job_status(file_id)

    if not job_status:
        # Check if file is already deduplicated
        if file_obj.storage_type == "content_addressed":
            return {
                "status": "completed",
                "message": "File already deduplicated",
                "dedup_info": file_obj.dedup_info,
            }
        else:
            return {"status": "not_queued", "message": "File not queued for deduplication"}

    return job_status


@router.get("/download/{file_id}")
async def download_file(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Download and decrypt file with streaming"""
    result = await db.execute(select(Object).where(Object.id == file_id))
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(404, "File not found")

    if file_obj.user_id != current_user.id:
        raise HTTPException(403, "Unauthorized")

    file_key = encryption_service.decrypt_key(file_obj.encryption_key)

    was_compressed = False
    if file_obj.metadata and isinstance(file_obj.metadata, dict):
        was_compressed = file_obj.metadata.get("compressed", False)
    elif file_obj.chunk_info and isinstance(file_obj.chunk_info, dict):
        was_compressed = file_obj.chunk_info.get("compressed", False)

    async def stream_file() -> AsyncGenerator[bytes, None]:
        """Stream file content in chunks"""
        if file_obj.storage_type == "inline":
            import base64

            encrypted_data = base64.b64decode(file_obj.storage_key)
            file_data = encryption_service.decrypt_file(encrypted_data, file_key)

            if was_compressed:
                from ..utils.compression import compressor

                file_data = compressor.decompress(file_data)

            yield file_data

        elif file_obj.storage_type == "single":
            if not os.path.exists(file_obj.object_path):
                raise HTTPException(404, "File data not found on disk")

            # Sync open via to_thread — async-with inside this streaming
            # generator races with PEP 525 cleanup on client disconnect.
            encrypted_data = await asyncio.to_thread(_read_all_bytes, file_obj.object_path)

            file_data = encryption_service.decrypt_file(encrypted_data, file_key)

            if was_compressed:
                from ..utils.compression import compressor

                file_data = compressor.decompress(file_data)

            chunk_size = 8 * 1024 * 1024
            for i in range(0, len(file_data), chunk_size):
                yield file_data[i : i + chunk_size]

        else:  # chunked
            chunk_info = file_obj.chunk_info
            upload_id = chunk_info.get("upload_id", str(file_obj.id))

            for i in range(chunk_info["count"]):
                chunk_path = chunk_info.get("paths", {}).get(str(i))

                if not chunk_path:
                    shard = upload_id[:2]
                    chunk_path = f"/app/storage/cache/{shard}/{upload_id}_chunk_{i}.enc"

                if not os.path.exists(chunk_path):
                    raise HTTPException(404, f"Chunk {i} not found")

                # Sync open via to_thread — see comment above.
                encrypted_chunk = await asyncio.to_thread(_read_all_bytes, chunk_path)

                decrypted_chunk = encryption_service.decrypt_chunk(encrypted_chunk, file_key, i)

                if was_compressed:
                    from ..utils.compression import compressor

                    decrypted_chunk = compressor.decompress(decrypted_chunk)

                yield decrypted_chunk

    return StreamingResponse(
        stream_file(),
        media_type=file_obj.mime_type or "application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename={file_obj.file_name}"},
    )


@router.get("/resume/{upload_id}", response_model=UploadStatusResponse)
async def get_upload_status(upload_id: str, current_user: User = Depends(get_current_user)):
    """Get upload status for resuming"""
    redis_client = await get_redis()

    session_data = await redis_client.get(f"up:{upload_id}")
    if not session_data:
        raise HTTPException(status_code=404, detail="Upload session not found")

    session = json.loads(session_data)
    if session["user"] != str(current_user.id):
        raise HTTPException(status_code=403, detail="Unauthorized")

    if session["strategy"] == "chunked":
        missing_chunks = set(range(session["chunks"])) - set(session["done"])
        progress = len(session["done"]) / session["chunks"] * 100 if session["chunks"] > 0 else 100
    else:
        missing_chunks = []
        progress = 100 if session.get("hash") else 0

    recommended_concurrency = await bandwidth_throttle_service.get_recommended_chunk_concurrency(
        str(current_user.id), current_user.plan_type or "free", current_user.max_concurrent_streams
    )

    return UploadStatusResponse(
        upload_id=upload_id,
        file_name=session["name"],
        total_chunks=session["chunks"],
        uploaded_chunks=session["done"],
        missing_chunks=list(missing_chunks),
        progress=progress,
        recommended_concurrency=recommended_concurrency,
    )


