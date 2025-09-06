# services/storage-service/app/services/storage.py

import os
import json
import hashlib
import shutil
import base64
from typing import Dict, Optional
import aiofiles
from fastapi import HTTPException
from ..config import settings
from ..database import get_redis
from .encryption import encryption_service
from ..utils.compression import compressor, decompressor
from datetime import datetime

ZSTD_MAGIC = b'\x28\xb5\x2f\xfd'  # zstd frame magic (little-endian)

class StorageService:
    """Handles file storage operations across different tiers and strategies"""
    
    async def store_file_auto(self, file_data: bytes, file_info: dict, encrypt_key: bytes) -> dict:
        """Automatically choose best storage method based on file size"""
        file_size = len(file_data)
        
        if file_size < settings.INLINE_THRESHOLD:
            return await self.store_inline(file_data, file_info, encrypt_key)
        elif file_size < settings.SINGLE_OBJECT_THRESHOLD:
            return await self.store_single(file_data, file_info, encrypt_key)
        else:
            return {"storage_type": "chunked", "requires_chunking": True}
    
    async def store_inline(self, file_data: bytes, file_info: dict, encrypt_key: bytes) -> dict:
        """Store tiny files directly in Redis (compress -> encrypt)"""
        redis_client = await get_redis()
        file_hash = hashlib.sha256(file_data).hexdigest()
        
        # Compress first
        compressed = compressor.compress(file_data)
        # Encrypt compressed payload if a key is provided
        if encrypt_key:
            compressed = encryption_service.encrypt_data(compressed, encrypt_key)
        
        # Store in Redis
        storage_key = f"inline:{file_info['user_id']}:{file_hash}"
        # Redis client may accept bytes or str; store bytes
        await redis_client.set(storage_key, compressed)
        
        return {
            "storage_type": "inline",
            "storage_key": storage_key,
            "hash": file_hash,
            "size": len(file_data),
            "compressed_size": len(compressed)
        }
    
    async def store_single(self, file_data: bytes, file_info: dict, encrypt_key: bytes) -> dict:
        """Store medium files as single objects (compress -> encrypt -> write)"""
        file_hash = hashlib.sha256(file_data).hexdigest()
        
        # Compress first
        compressed = compressor.compress(file_data)
        if encrypt_key:
            compressed = encryption_service.encrypt_data(compressed, encrypt_key)
        
        # Store as single file (use .obj extension to indicate internal format)
        shard = file_hash[:2]
        object_path = os.path.join(settings.CACHE_PATH, "objects", shard, f"{file_hash}.obj")
        os.makedirs(os.path.dirname(object_path), exist_ok=True)
        
        async with aiofiles.open(object_path, "wb") as f:
            await f.write(compressed)
        
        return {
            "storage_type": "single",
            "path": object_path,
            "hash": file_hash,
            "size": len(file_data),
            "compressed_size": len(compressed)
        }
    
    async def save_chunk(self, chunk_data: bytes, chunk_hash: str, 
                        encrypt_key: bytes = None) -> Dict:
        """Save chunk with compression, encryption, and deduplication"""
        redis_client = await get_redis()
        
        # Check for deduplication
        existing = await redis_client.get(f"chunk:{chunk_hash}")
        if existing:
            await redis_client.incr(f"chunk:refs:{chunk_hash}")
            return json.loads(existing)
        
        # Compress
        compressed_data = compressor.compress(chunk_data)
        
        # Encrypt if key provided
        if encrypt_key:
            compressed_data = encryption_service.encrypt_data(compressed_data, encrypt_key)
        
        # Save to cache tier
        shard = chunk_hash[:2]
        chunk_path = os.path.join(settings.CACHE_PATH, shard, chunk_hash)
        os.makedirs(os.path.dirname(chunk_path), exist_ok=True)
        
        async with aiofiles.open(chunk_path, "wb") as f:
            await f.write(compressed_data)
        
        chunk_info = {
            "hash": chunk_hash,
            "size": len(chunk_data),
            "compressed_size": len(compressed_data),
            "path": chunk_path,
            "tier": "cache",
            "encrypted": encrypt_key is not None,
            "created": datetime.utcnow().isoformat(),
        }
        
        # Store metadata
        await redis_client.set(f"chunk:{chunk_hash}", json.dumps(chunk_info))
        await redis_client.set(f"chunk:refs:{chunk_hash}", 1)
        
        return chunk_info
    
    async def get_chunk(self, chunk_hash: str, decrypt_key: bytes = None) -> bytes:
        """Retrieve and decompress chunk (handling uncompressed legacy payloads)"""
        redis_client = await get_redis()
        chunk_info_raw = await redis_client.get(f"chunk:{chunk_hash}")
        
        if not chunk_info_raw:
            raise HTTPException(404, "Chunk not found")
        
        chunk_info = json.loads(chunk_info_raw)
        
        async with aiofiles.open(chunk_info["path"], "rb") as f:
            stored_bytes = await f.read()
        
        # Decrypt if needed
        if chunk_info.get("encrypted"):
            if not decrypt_key:
                raise HTTPException(401, "Missing decryption key for encrypted chunk")
            stored_bytes = encryption_service.decrypt_data(stored_bytes, decrypt_key)
        
        # If data appears to be zstd frame, decompress; otherwise assume plaintext
        if isinstance(stored_bytes, str):
            stored_bytes = stored_bytes.encode()
        if stored_bytes.startswith(ZSTD_MAGIC):
            try:
                return decompressor.decompress(stored_bytes)
            except Exception as e:
                raise HTTPException(500, f"Decompression failed for chunk {chunk_hash}: {e}")
        else:
            # Not compressed -> return as-is
            return stored_bytes
    
    async def retrieve_file(self, file_obj, decrypt_key: bytes = None) -> bytes:
        """Retrieve file based on storage type. Decrypt then decompress if compressed."""
        redis_client = await get_redis()
        
        if file_obj.storage_type == "inline":
            data = await redis_client.get(file_obj.storage_key)
            if data is None:
                raise HTTPException(404, "Inline object not found")
            # Redis may return string or bytes; ensure bytes
            if isinstance(data, str):
                data = data.encode()
            if decrypt_key:
                data = encryption_service.decrypt_data(data, decrypt_key)
            # If it looks like zstd, decompress; else return raw bytes
            if data.startswith(ZSTD_MAGIC):
                try:
                    return decompressor.decompress(data)
                except Exception as e:
                    raise HTTPException(500, f"Decompression failed for inline object: {e}")
            return data
        
        elif file_obj.storage_type == "single":
            async with aiofiles.open(file_obj.object_path, "rb") as f:
                data = await f.read()
            if decrypt_key:
                data = encryption_service.decrypt_data(data, decrypt_key)
            if isinstance(data, str):
                data = data.encode()
            if data.startswith(ZSTD_MAGIC):
                try:
                    return decompressor.decompress(data)
                except Exception as e:
                    raise HTTPException(500, f"Decompression failed for object: {e}")
            return data
        
        else:
            # For chunked files, caller should use get_chunk; but you can also reassemble here
            raise ValueError("Use get_chunk for chunked files")
    
    async def move_to_tier(self, chunk_hash: str, target_tier: str):
        """Move chunk between storage tiers"""
        redis_client = await get_redis()
        chunk_info = await redis_client.get(f"chunk:{chunk_hash}")
        
        if not chunk_info:
            return
        
        chunk_data = json.loads(chunk_info)
        if chunk_data["tier"] == target_tier:
            return
        
        tier_paths = {
            "cache": settings.CACHE_PATH,
            "warm": settings.WARM_PATH,
            "cold": settings.COLD_PATH,
        }
        
        old_path = chunk_data["path"]
        shard = chunk_hash[:2]
        new_path = os.path.join(tier_paths[target_tier], shard, chunk_hash)
        
        os.makedirs(os.path.dirname(new_path), exist_ok=True)
        shutil.move(old_path, new_path)
        
        chunk_data["path"] = new_path
        chunk_data["tier"] = target_tier
        await redis_client.set(f"chunk:{chunk_hash}", json.dumps(chunk_data))

storage_service = StorageService()