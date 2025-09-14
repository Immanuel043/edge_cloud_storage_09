# services/storage-service/app/routers/upload.py

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Request, BackgroundTasks
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from typing import Optional, AsyncGenerator
import uuid
import json
import os
import io
import base64
import hashlib
import mimetypes
from datetime import datetime
from ..dependencies import get_db, log_activity, get_current_user
from ..services.auth import auth_service
from ..services.storage import storage_service
from ..services.encryption import encryption_service
from ..models.database import User, Object
from ..models.schemas import UploadInitResponse, UploadStatusResponse
from ..database import get_redis
from ..config import settings
from aiokafka import AIOKafkaProducer
import aiofiles
from ..utils.cache import cached
from ..monitoring.metrics import (
    upload_initiated, upload_completed, upload_duration,
    active_uploads, chunk_processing_duration, errors_total
)
import time
import asyncio
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from ..services.deduplication_enhanced import enhanced_dedup_service

router = APIRouter(prefix="/api/v1/upload", tags=["upload"])

# Global resources
kafka_producer = None
kafka_lock = asyncio.Lock()
executor = ThreadPoolExecutor(max_workers=8)  # For parallel processing

# Optimized buffer sizes
# Read from environment variables with fallbacks
STREAM_BUFFER_SIZE = int(os.getenv('STREAM_BUFFER_SIZE', 8 * 1024 * 1024))  # 8MB default
INLINE_THRESHOLD = int(os.getenv('INLINE_THRESHOLD', 512 * 1024))  # 512KB
SINGLE_OBJECT_THRESHOLD = int(os.getenv('SINGLE_OBJECT_THRESHOLD', 50 * 1024 * 1024))  # 50MB
CHUNK_SIZE = int(os.getenv('CHUNK_SIZE', 32 * 1024 * 1024))  # 32MB default - CRITICAL CHANGE

# Files that are already compressed - DO NOT compress these
COMPRESSED_FORMATS = {'.zip', '.gz', '.rar', '.7z', '.bz2', '.xz', 
                      '.jpg', '.jpeg', '.png', '.mp4', '.mp3', '.avi',
                      '.mkv', '.mov', '.webm', '.flac', '.aac', '.ogg',
                      '.pdf', '.docx', '.xlsx', '.pptx'}  # Most modern formats are compressed

# Only compress these text-based formats
COMPRESSIBLE_FORMATS = {'.txt', '.log', '.csv', '.json', '.xml', '.sql', 
                        '.html', '.css', '.js', '.py', '.java', '.c', '.cpp'}

def should_compress(filename: str, size: int) -> bool:
    """Determine if file should be compressed based on type and size"""
    ext = os.path.splitext(filename)[1].lower()
    
    # Never compress already-compressed formats
    if ext in COMPRESSED_FORMATS:
        return False
    
    # Only compress text formats larger than 1MB
    if ext in COMPRESSIBLE_FORMATS and size > 1024 * 1024:
        return True
    
    return False

async def get_kafka_producer():
    """Get or create Kafka producer with connection management"""
    global kafka_producer
    
    if not hasattr(settings, 'KAFKA_BROKERS'):
        return None
    
    async with kafka_lock:
        if kafka_producer is None:
            try:
                kafka_producer = AIOKafkaProducer(
                    bootstrap_servers=settings.KAFKA_BROKERS,
                    value_serializer=lambda v: json.dumps(v).encode(),
                    compression_type='snappy',
                    max_request_size=104857600,
                    linger_ms=100,
                    batch_size=524288,
                )
                await kafka_producer.start()
                print("✅ Kafka producer initialized")
            except Exception as e:
                print(f"⚠️ Kafka unavailable: {e}")
                return None
    
    return kafka_producer

async def get_user_storage_info_fast(user_id: str, db: AsyncSession):
    """Lightweight storage check"""
    result = await db.execute(
        select(User.storage_quota, User.storage_used)
        .where(User.id == user_id)
    )
    data = result.first()
    
    if not data:
        return {"quota": 0, "used": 0}
    
    return {
        "quota": int(data.storage_quota or 0),
        "used": int(data.storage_used or 0)
    }

def process_chunk_cpu_bound(chunk_data: bytes, file_key: bytes, chunk_index: int, compress: bool = False):
    """CPU-intensive operations in thread pool"""
    # Hash calculation (before any processing)
    original_hash = hashlib.sha256(chunk_data).hexdigest()
    
    # Optional compression (only for compressible files)
    if compress:
        from ..utils.compression import compressor
        chunk_data = compressor.compress(chunk_data)
    
    # Encryption (AES-GCM is fast with hardware acceleration)
    encrypted_chunk = encryption_service.encrypt_chunk(chunk_data, file_key, chunk_index)
    
    return encrypted_chunk, original_hash

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
    
    # Check storage quota
    storage_info = await get_user_storage_info_fast(str(current_user.id), db)
    if storage_info['used'] + file_size > storage_info['quota']:
        raise HTTPException(status_code=413, detail="Storage quota exceeded")
    
    # Determine storage strategy
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
    
    # Generate encryption key for this upload
    file_key = encryption_service.generate_file_key()
    encrypted_key = encryption_service.encrypt_key(file_key)
    
    # Check if compression should be used
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
        "compress": use_compression,  # Store compression decision
        "start": datetime.utcnow().isoformat(),
    }
    
    await redis_client.setex(f"up:{upload_id}", 3600, json.dumps(session_data))
    
    # Metrics
    upload_initiated.labels(
        user_type=getattr(current_user, 'user_type', 'standard'),
        storage_strategy=storage_strategy
    ).inc()
    active_uploads.inc()
    
    print(f"📤 Upload initialized: {file_name} ({file_size/1024/1024:.1f}MB) - Compression: {use_compression}")
    
    return UploadInitResponse(
        upload_id=upload_id,
        storage_strategy=storage_strategy,
        chunk_size=CHUNK_SIZE if storage_strategy == "chunked" else 0,
        total_chunks=total_chunks,
        direct_upload=storage_strategy != "chunked"
    )

@router.post("/chunk/{upload_id}")
async def upload_chunk(
    upload_id: str,
    chunk_index: int,
    chunk: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Optimized chunk upload with smart compression"""
    redis_client = await get_redis()
    
    session_data = await redis_client.get(f"up:{upload_id}")
    if not session_data:
        raise HTTPException(status_code=404, detail="Upload session not found")
    
    session = json.loads(session_data)
    
    if session["user"] != str(current_user.id):
        raise HTTPException(status_code=403, detail="Unauthorized")
    
    if chunk_index in session["done"]:
        return {"status": "already_uploaded", "chunk_index": chunk_index}
    
    # Prepare storage path
    storage_tier = "cache"
    shard = f"{upload_id[:2]}"
    storage_dir = f"/app/storage/{storage_tier}/{shard}"
    os.makedirs(storage_dir, exist_ok=True)
    storage_path = f"{storage_dir}/{upload_id}_chunk_{chunk_index}.enc"
    
    # Read chunk data
    chunk_data = await chunk.read()
    
    # Get encryption key
    file_key = encryption_service.decrypt_key(session["key"])
    
    # Process in thread pool (encryption + optional compression)
    loop = asyncio.get_event_loop()
    use_compression = session.get("compress", False)
    
    encrypted_chunk, chunk_hash = await loop.run_in_executor(
        executor,
        partial(process_chunk_cpu_bound, chunk_data, file_key, chunk_index, use_compression)
    )
    
    # Write encrypted data asynchronously with larger buffer
    async with aiofiles.open(storage_path, 'wb', buffering=STREAM_BUFFER_SIZE) as f:
        await f.write(encrypted_chunk)
    
    # Update session
    session["done"].append(chunk_index)
    session["hashes"].append(chunk_hash)
    session["chunk_paths"][str(chunk_index)] = storage_path
    
    # Fire-and-forget Redis update
    asyncio.create_task(
        redis_client.setex(f"up:{upload_id}", 3600, json.dumps(session))
    )
    
    progress = len(session["done"]) / session["chunks"] * 100 if session["chunks"] > 0 else 100
    
    return {
        "status": "success",
        "chunk_index": chunk_index,
        "progress": round(progress, 1),
        "encrypted": True,
        "compressed": use_compression,
    }

@router.post("/direct/{upload_id}")
async def upload_direct(
    upload_id: str,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Direct upload for small and medium files with optimized processing"""
    redis_client = await get_redis()
    
    session_data = await redis_client.get(f"up:{upload_id}")
    if not session_data:
        raise HTTPException(status_code=404, detail="Upload session not found")
    
    session = json.loads(session_data)
    
    if session["user"] != str(current_user.id):
        raise HTTPException(status_code=403, detail="Unauthorized")
    
    # Read file data
    file_data = await file.read()
    
    # Process in thread pool
    loop = asyncio.get_event_loop()
    file_key = encryption_service.decrypt_key(session["key"])
    use_compression = session.get("compress", False)
    
    def process_file():
        # Optional compression
        if use_compression:
            from ..utils.compression import compressor
            file_data_processed = compressor.compress(file_data)
        else:
            file_data_processed = file_data
        
        # Encrypt
        encrypted_data = encryption_service.encrypt_file(file_data_processed, file_key)
        file_hash = hashlib.sha256(file_data).hexdigest()  # Hash of original data
        return encrypted_data, file_hash
    
    encrypted_data, file_hash = await loop.run_in_executor(executor, process_file)
    
    # Determine storage location
    file_id = session["id"]
    storage_tier = "cache"
    
    if session["strategy"] == "inline":
        # For inline, store in database
        session["encrypted_data"] = base64.b64encode(encrypted_data).decode()
        session["storage_type"] = "inline"
    else:  # single
        # For single files, store on disk
        shard = "objects"
        storage_dir = f"/app/storage/{storage_tier}/{shard}"
        os.makedirs(storage_dir, exist_ok=True)
        
        storage_path = f"{storage_dir}/{file_id}.enc"
        
        async with aiofiles.open(storage_path, 'wb', buffering=STREAM_BUFFER_SIZE) as f:
            await f.write(encrypted_data)
        
        session["storage_path"] = storage_path
        session["storage_type"] = "single"
    
    session["hash"] = file_hash
    
    await redis_client.setex(f"up:{upload_id}", 3600, json.dumps(session))
    
    return {
        "status": "success",
        "upload_id": upload_id,
        "encrypted": True,
        "compressed": use_compression,
        "ready_for_completion": True
    }

@router.post("/complete/{upload_id}")
async def complete_upload(
    upload_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    """Complete upload and create database record with deduplication"""
    redis_client = await get_redis()
    
    session_data = await redis_client.get(f"up:{upload_id}")
    if not session_data:
        raise HTTPException(status_code=404, detail="Upload session not found")
    
    session = json.loads(session_data)
    
    if session["user"] != str(current_user.id):
        raise HTTPException(status_code=403, detail="Unauthorized")
    
    storage_strategy = session.get("strategy", "chunked")
    start_time = datetime.fromisoformat(session["start"])
    
    # Verify upload completion
    if storage_strategy == "chunked":
        if len(session["done"]) != session["chunks"]:
            missing = set(range(session["chunks"])) - set(session["done"])
            return {"status": "incomplete", "missing_chunks": list(missing)}
    
    # ============ FIXED DEDUPLICATION INTEGRATION ============
    # Check if file should be deduplicated (files > 10MB)
    enable_dedup = session["size"] > 10 * 1024 * 1024 and storage_strategy in ["single", "chunked"]
    
    if enable_dedup:
        print(f"🔍 Checking deduplication for {session['name']} ({session['size']/1024/1024:.1f}MB)")
        
        # CRITICAL: We need to get the ORIGINAL file data, not the encrypted version
        file_data = None
        file_key = encryption_service.decrypt_key(session["key"])
        
        if storage_strategy == "single":
            # Read and DECRYPT the single file to get original data
            storage_path = session.get("storage_path")
            if storage_path and os.path.exists(storage_path):
                async with aiofiles.open(storage_path, 'rb') as f:
                    encrypted_data = await f.read()
                
                # Decrypt to get original data
                file_data = encryption_service.decrypt_file(encrypted_data, file_key)
                
                # Decompress if needed to get truly original data
                if session.get("compress", False):
                    from ..utils.compression import compressor
                    file_data = compressor.decompress(file_data)
        
        elif storage_strategy == "chunked":
            # Assemble and decrypt chunks to get original file
            chunks_data = []
            
            for i in range(session["chunks"]):
                chunk_path = session.get("chunk_paths", {}).get(str(i))
                if not chunk_path:
                    shard = upload_id[:2]
                    chunk_path = f"/app/storage/cache/{shard}/{upload_id}_chunk_{i}.enc"
                
                if os.path.exists(chunk_path):
                    async with aiofiles.open(chunk_path, 'rb') as f:
                        encrypted_chunk = await f.read()
                    
                    # Decrypt chunk to get original data
                    decrypted_chunk = encryption_service.decrypt_chunk(encrypted_chunk, file_key, i)
                    
                    # Decompress if needed
                    if session.get("compress", False):
                        from ..utils.compression import compressor
                        decrypted_chunk = compressor.decompress(decrypted_chunk)
                    
                    chunks_data.append(decrypted_chunk)
            
            if chunks_data:
                file_data = b''.join(chunks_data)
        
        # Now we have the ORIGINAL file data, perform deduplication
        if file_data:
            try:
                # This will now properly deduplicate based on original content
                dedup_result = await enhanced_dedup_service.store_deduplicated_file(
                    file_data=file_data,
                    file_name=session["name"],
                    user_id=str(current_user.id),
                    db=db,
                    metadata={
                        'mime_type': mimetypes.guess_type(session["name"])[0],
                        'folder_id': session.get("folder")
                    },
                    encrypt=True  # Will encrypt with a new key for CAS storage
                )
                
                # If deduplication succeeded, clean up original storage
                if dedup_result['status'] in ['stored_with_dedup', 'full_duplicate']:
                    # Calculate actual savings
                    actual_saved = dedup_result.get('saved_size', 0)
                    
                    # For full duplicates, the entire file is saved
                    if dedup_result['status'] == 'full_duplicate':
                        actual_saved = session["size"]
                    
                    print(f"✅ Deduplication successful! Saved {actual_saved/1024/1024:.1f}MB ({dedup_result.get('dedup_ratio', 0):.1f}%)")
                    
                    # Clean up original encrypted files since we now have deduplicated storage
                    if storage_strategy == "single" and session.get("storage_path"):
                        try:
                            os.remove(session["storage_path"])
                            print(f"🗑️ Removed original encrypted file: {session['storage_path']}")
                        except Exception as e:
                            print(f"⚠️ Could not remove original file: {e}")
                    
                    elif storage_strategy == "chunked":
                        removed_count = 0
                        for path in session.get("chunk_paths", {}).values():
                            try:
                                os.remove(path)
                                removed_count += 1
                            except:
                                pass
                        print(f"🗑️ Removed {removed_count} original encrypted chunks")
                    
                    # Update user storage with actual usage
                    if hasattr(current_user, 'storage_used'):
                        # Only add the actual storage used (after deduplication)
                        actual_used = session["size"] - actual_saved
                        current_user.storage_used = (current_user.storage_used or 0) + actual_used
                    
                    await db.commit()
                    
                    # Log activity
                    await log_activity(
                        db, current_user.id, "file_uploaded", dedup_result['file_id'],
                        {
                            "file_name": session["name"], 
                            "size": session["size"],
                            "storage_type": "deduplicated",
                            "saved_size": actual_saved,
                            "dedup_ratio": dedup_result.get('dedup_ratio', 0)
                        },
                        request,
                    )
                    
                    # Clean up Redis
                    await redis_client.delete(f"up:{upload_id}")
                    
                    # Metrics
                    duration = (datetime.utcnow() - start_time).total_seconds()
                    upload_completed.labels(
                        user_type=getattr(current_user, 'user_type', 'standard'),
                        storage_strategy="deduplicated",
                        status="success"
                    ).inc()
                    upload_duration.labels(storage_strategy="deduplicated").observe(duration)
                    active_uploads.dec()
                    
                    return {
                        "status": "success",
                        "file_id": dedup_result['file_id'],
                        "file_name": session["name"],
                        "file_size": session["size"],
                        "storage_type": "deduplicated",
                        "deduplication": {
                            "enabled": True,
                            "saved_size": actual_saved,
                            "dedup_ratio": dedup_result.get('dedup_ratio', 0),
                            "status": dedup_result['status'],
                            "unique_blocks": dedup_result.get('unique_blocks', 0),
                            "duplicate_blocks": len(dedup_result.get('duplicate_blocks', []))
                        },
                        "encrypted": True,
                        "duration": round(duration, 2)
                    }
                    
            except Exception as e:
                print(f"⚠️ Deduplication failed, falling back to normal storage: {str(e)}")
                import traceback
                traceback.print_exc()
    
    # ============ DEDUPLICATION INTEGRATION END ============
    
    file_id = uuid.uuid4()
    mime_type = mimetypes.guess_type(session["name"])[0]
    
    # Create database record based on storage type
    if storage_strategy == "inline":
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
            file_metadata={"compressed": session.get("compress", False)}
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
            file_metadata={"compressed": session.get("compress", False)}
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
                "compressed": session.get("compress", False)
            },
            storage_tier="cache",
        )
    
    # Save to database
    db.add(file_obj)
    
    # Update user storage
    if hasattr(current_user, 'storage_used'):
        current_user.storage_used = (current_user.storage_used or 0) + session["size"]
    
    await db.commit()
    
    # Log activity
    await log_activity(
        db, current_user.id, "file_uploaded", str(file_id),
        {
            "file_name": session["name"], 
            "size": session["size"], 
            "storage_type": storage_strategy,
            "compressed": session.get("compress", False)
        },
        request,
    )
    
    # Clean up Redis
    await redis_client.delete(f"up:{upload_id}")
    
    # Metrics
    duration = (datetime.utcnow() - start_time).total_seconds()
    upload_completed.labels(
        user_type=getattr(current_user, 'user_type', 'standard'),
        storage_strategy=storage_strategy,
        status="success"
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
        "throughput_mbps": round(throughput, 2)
    }

@router.get("/download/{file_id}")
async def download_file(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Download and decrypt file with streaming"""
    # Get file metadata
    result = await db.execute(
        select(Object).where(Object.id == file_id)
    )
    file_obj = result.scalar_one_or_none()
    
    if not file_obj:
        raise HTTPException(404, "File not found")
    
    if file_obj.user_id != current_user.id:
        raise HTTPException(403, "Unauthorized")
    
    # Get encryption key
    file_key = encryption_service.decrypt_key(file_obj.encryption_key)
    
    # Check if file was compressed
    was_compressed = False
    if file_obj.metadata and isinstance(file_obj.metadata, dict):
        was_compressed = file_obj.metadata.get("compressed", False)
    elif file_obj.chunk_info and isinstance(file_obj.chunk_info, dict):
        was_compressed = file_obj.chunk_info.get("compressed", False)
    
    async def stream_file() -> AsyncGenerator[bytes, None]:
        """Stream file content in chunks"""
        if file_obj.storage_type == "inline":
            # Decrypt inline data
            encrypted_data = base64.b64decode(file_obj.storage_key)
            file_data = encryption_service.decrypt_file(encrypted_data, file_key)
            
            # Decompress if needed
            if was_compressed:
                from ..utils.compression import compressor
                file_data = compressor.decompress(file_data)
            
            yield file_data
        
        elif file_obj.storage_type == "single":
            # Read and decrypt single file
            if not os.path.exists(file_obj.object_path):
                raise HTTPException(404, "File data not found on disk")
            
            async with aiofiles.open(file_obj.object_path, 'rb') as f:
                encrypted_data = await f.read()
            
            file_data = encryption_service.decrypt_file(encrypted_data, file_key)
            
            # Decompress if needed
            if was_compressed:
                from ..utils.compression import compressor
                file_data = compressor.decompress(file_data)
            
            # Stream in chunks
            chunk_size = 8 * 1024 * 1024  # 8MB chunks
            for i in range(0, len(file_data), chunk_size):
                yield file_data[i:i+chunk_size]
        
        else:  # chunked
            # Stream chunks sequentially
            chunk_info = file_obj.chunk_info
            upload_id = chunk_info.get("upload_id", str(file_obj.id))
            
            for i in range(chunk_info["count"]):
                chunk_path = chunk_info.get("paths", {}).get(str(i))
                
                if not chunk_path:
                    shard = upload_id[:2]
                    chunk_path = f"/app/storage/cache/{shard}/{upload_id}_chunk_{i}.enc"
                
                if not os.path.exists(chunk_path):
                    raise HTTPException(404, f"Chunk {i} not found")
                
                async with aiofiles.open(chunk_path, 'rb') as f:
                    encrypted_chunk = await f.read()
                
                # Decrypt chunk
                decrypted_chunk = encryption_service.decrypt_chunk(encrypted_chunk, file_key, i)
                
                # Decompress if needed
                if was_compressed:
                    from ..utils.compression import compressor
                    decrypted_chunk = compressor.decompress(decrypted_chunk)
                
                yield decrypted_chunk
    
    return StreamingResponse(
        stream_file(),
        media_type=file_obj.mime_type or 'application/octet-stream',
        headers={
            "Content-Disposition": f"attachment; filename={file_obj.file_name}"
        }
    )

@router.get("/resume/{upload_id}", response_model=UploadStatusResponse)
async def get_upload_status(
    upload_id: str,
    current_user: User = Depends(get_current_user)
):
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
    
    return UploadStatusResponse(
        upload_id=upload_id,
        file_name=session["name"],
        total_chunks=session["chunks"],
        uploaded_chunks=session["done"],
        missing_chunks=list(missing_chunks),
        progress=progress,
    )

@router.post("/test-speed")
async def test_speed(file: UploadFile = File(...)):
    """Test raw upload speed without any processing"""
    start = time.time()
    total = 0
    
    while content := await file.read(64 * 1024 * 1024):
        total += len(content)
    
    elapsed = time.time() - start
    speed_mbps = (total / (1024 * 1024)) / elapsed if elapsed > 0 else 0
    
    return {
        "size_mb": round(total / (1024 * 1024), 2),
        "time_seconds": round(elapsed, 2),
        "speed_mbps": round(speed_mbps, 2),
        "speed_gbps": round(speed_mbps * 8 / 1000, 2),
        "note": "Raw speed without any processing"
    }

@router.post("/test-speed-encrypted")
async def test_speed_encrypted(file: UploadFile = File(...)):
    """Test upload speed with encryption only"""
    start = time.time()
    total = 0
    file_key = encryption_service.generate_file_key()
    
    chunk_index = 0
    while content := await file.read(CHUNK_SIZE):
        # Encrypt chunk
        encrypted = encryption_service.encrypt_chunk(content, file_key, chunk_index)
        total += len(content)
        chunk_index += 1
    
    elapsed = time.time() - start
    speed_mbps = (total / (1024 * 1024)) / elapsed if elapsed > 0 else 0
    
    return {
        "size_mb": round(total / (1024 * 1024), 2),
        "time_seconds": round(elapsed, 2),
        "speed_mbps": round(speed_mbps, 2),
        "speed_gbps": round(speed_mbps * 8 / 1000, 2),
        "note": "Speed with AES-GCM encryption only (no compression)"
    }