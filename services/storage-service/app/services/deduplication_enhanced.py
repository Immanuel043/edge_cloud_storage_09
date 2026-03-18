# services/storage-service/app/services/deduplication_enhanced.py
import hashlib
import os
import asyncio
from typing import Optional, Dict, Tuple, List
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, update, and_
from datetime import datetime
import aiofiles
from ..models.database import Object, ContentBlock, User
from ..config import settings
from ..services.encryption import encryption_service
from ..services.dedup_db_batch import batch_writer
import json
import xxhash  # For faster non-cryptographic hashing
from ..utils.executors import run_in_heavy_pool
from collections import defaultdict
import logging
from concurrent.futures import ThreadPoolExecutor

logger = logging.getLogger(__name__)


def _slice_chunks(file_data: bytes, boundaries: list) -> list:
    """Slice file_data at each boundary. Used only on Python hash fallback path."""
    chunks = []
    start = 0
    for boundary in boundaries:
        chunks.append(file_data[start:boundary])
        start = boundary
    return chunks


def _classify_blocks(
    block_hashes: list,
    chunk_sizes: list,
    chunk_offsets: list,
    existing_block_map: dict,
) -> tuple:
    """Classify blocks as new or duplicate. Plain data in, plain data out.

    Returns:
        (blocks, new_block_ranges, duplicate_blocks, duplicate_block_ids,
         new_hashes_for_bloom, deduplicated_size, saved_size)

    ``new_block_ranges`` entries carry ``hash``, ``size``, ``offset``, ``index``
    but **no** ``data`` key — bytes are materialized later by ``_extract_unique_blocks``.
    """
    blocks = []
    new_block_ranges = []
    duplicate_blocks = []
    duplicate_block_ids = []
    new_hashes_for_bloom = []
    deduplicated_size = 0
    saved_size = 0

    for i, block_hash in enumerate(block_hashes):
        size = chunk_sizes[i]
        offset = chunk_offsets[i]
        existing_id = existing_block_map.get(block_hash)

        if existing_id is not None:
            duplicate_blocks.append({
                'hash': block_hash,
                'size': size,
                'offset': offset,
                'existing_block_id': str(existing_id),
            })
            saved_size += size
            duplicate_block_ids.append(existing_id)
        else:
            new_block_ranges.append({
                'hash': block_hash,
                'size': size,
                'offset': offset,
                'index': i,
            })
            deduplicated_size += size
            new_hashes_for_bloom.append(block_hash)

        blocks.append({
            'hash': block_hash,
            'size': size,
            'offset': offset,
            'is_duplicate': existing_id is not None,
        })

    return (
        blocks, new_block_ranges, duplicate_blocks, duplicate_block_ids,
        new_hashes_for_bloom, deduplicated_size, saved_size,
    )


def _extract_unique_blocks(
    file_data: bytes,
    boundaries: list,
    new_block_ranges: list,
) -> list:
    """Slice only the unique chunks from file_data.

    Returns list of dicts with ``hash``, ``size``, ``offset``, ``data`` —
    matching the downstream contract expected by ``store_deduplicated_file``.
    """
    # Build a start-offset list from boundaries: [0, b0, b1, ...]
    starts = [0] + boundaries[:-1]
    result = []
    for entry in new_block_ranges:
        idx = entry['index']
        chunk_start = starts[idx]
        chunk_end = boundaries[idx]
        result.append({
            'hash': entry['hash'],
            'size': entry['size'],
            'offset': entry['offset'],
            'data': file_data[chunk_start:chunk_end],
        })
    return result


class EnhancedDeduplicationService:
    """
    Enhanced Content-Addressed Storage with improved deduplication.
    
    Improvements:
    - Variable block size with content-defined chunking
    - Pre-encryption deduplication for better ratios
    - Global deduplication across users (optional)
    - Bloom filter for quick duplicate detection
    - Async batch processing
    """
    
    def __init__(self):
        self.min_block_size = 2 * 1024 * 1024   # 2MB min
        self.avg_block_size = 4 * 1024 * 1024   # 4MB average
        self.max_block_size = 8 * 1024 * 1024   # 8MB max
        self.cas_path = getattr(settings, 'CAS_PATH', '/app/storage/cas')
        self.enable_cross_user_dedup = getattr(settings, 'CROSS_USER_DEDUP', False)

        # Rabin fingerprinting parameters for CDC
        self.window_size = 48
        self.prime = 3
        self.modulus = (1 << 13) - 1  # For average 4MB chunks

        # Size limits for deduplication
        self.max_dedup_size = 1024 * 1024 * 1024  # 1GB - skip dedup for larger files

        # Thread pool for parallel hashing (dynamic based on CPU cores)
        max_workers = min(os.cpu_count() * 2, 16)  # 2x CPU cores, capped at 16
        self.hash_executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="hash_worker")
        logger.info(f"Initialized hash executor with {max_workers} workers")

        # Use Rust byte processor if available (CDC + batch SHA-256 + bloom)
        from ..utils.byte_processor import (
            native_find_chunk_boundaries,
            native_batch_sha256,
            NativeBloomFilter,
        )
        if native_find_chunk_boundaries is not None:
            self._native_cdc = native_find_chunk_boundaries
            self._native_batch_sha256 = native_batch_sha256
            logger.info("Using Rust byte processor for CDC + batch SHA-256")
        else:
            self._native_cdc = None
            self._native_batch_sha256 = None
            # Fall back to old C extension
            try:
                from ..utils.rolling_hash import native_find_chunk_boundaries as c_cdc
                if c_cdc is not None:
                    self._native_cdc = c_cdc
                    logger.info("Using C rolling hash fallback for CDC")
            except Exception:
                pass
            if self._native_cdc is None:
                logger.info("No native CDC available, using Python fallback")

        # Bloom filter: prefer Rust, fall back to pybloom_live
        self._init_bloom_filter(NativeBloomFilter)
        
    def _init_bloom_filter(self, NativeBloomFilter=None):
        """Initialize bloom filter for quick duplicate detection."""
        if NativeBloomFilter is not None:
            try:
                self.bloom_filter = NativeBloomFilter(capacity=1_000_000, error_rate=0.001)
                self.bloom_enabled = True
                logger.info("Using Rust bloom filter")
                return
            except Exception as exc:
                logger.warning("Rust bloom filter init failed: %s", exc)

        try:
            from pybloom_live import BloomFilter
            self.bloom_filter = BloomFilter(capacity=1000000, error_rate=0.001)
            self.bloom_enabled = True
        except ImportError:
            self.bloom_filter = None
            self.bloom_enabled = False
    
    def calculate_block_hash(self, data: bytes) -> str:
        """Calculate SHA-256 hash of data block"""
        return hashlib.sha256(data).hexdigest()
    
    def calculate_weak_hash(self, data: bytes) -> str:
        """Calculate fast weak hash for initial duplicate detection"""
        return xxhash.xxh64(data).hexdigest()

    async def calculate_hashes_parallel(
        self, chunks: List[bytes], boundaries: List[int] = None, file_data: bytes = None,
    ) -> List[str]:
        """
        Calculate SHA-256 hashes for all chunks.

        When the Rust batch hasher is available AND contiguous file_data +
        boundaries are provided, hashes are computed in a single native call
        (zero Python-per-chunk overhead).  Otherwise falls back to the Python
        hashlib loop with executor batching.
        """
        # Fast path: Rust batch SHA-256
        if (
            self._native_batch_sha256 is not None
            and boundaries is not None
            and file_data is not None
        ):
            logger.info("Batch-hashing %d chunks via Rust byte processor", len(boundaries))
            return await run_in_heavy_pool(
                self._native_batch_sha256, file_data, boundaries
            )

        # Slow path: Python hashlib with executor batching
        loop = asyncio.get_event_loop()
        all_hashes: List[str] = []
        batch_size = 500  # Smaller batches for finer event loop yielding

        for batch_start in range(0, len(chunks), batch_size):
            batch_end = min(batch_start + batch_size, len(chunks))
            batch = chunks[batch_start:batch_end]

            logger.info(
                "Hashing batch %d/%d (%d chunks)",
                batch_start // batch_size + 1,
                (len(chunks) + batch_size - 1) // batch_size,
                len(batch),
            )

            hash_tasks = [
                loop.run_in_executor(self.hash_executor, self.calculate_block_hash, chunk)
                for chunk in batch
            ]

            batch_hashes = await asyncio.gather(*hash_tasks)
            all_hashes.extend(batch_hashes)

            await asyncio.sleep(0)

        return all_hashes

    def find_chunk_boundaries(self, data: bytes) -> List[int]:
        """
        Content-defined chunking using rolling hash.
        Returns list of chunk boundary positions.

        Delegates to the native C implementation when available (~100x faster).
        """
        if self._native_cdc is not None:
            try:
                return self._native_cdc(
                    data,
                    self.min_block_size,
                    self.max_block_size,
                    self.window_size,
                    self.prime,
                    self.modulus,
                )
            except Exception as exc:
                logger.warning("Native CDC failed, falling back to Python: %s", exc)

        return self._find_chunk_boundaries_py(data)

    def _find_chunk_boundaries_py(self, data: bytes) -> List[int]:
        """Pure-Python fallback for content-defined chunking."""
        if len(data) < self.min_block_size:
            return [len(data)]

        boundaries = []
        hash_val = 0

        for i in range(len(data)):
            if i >= self.window_size:
                hash_val = (hash_val * self.prime + data[i] -
                           data[i - self.window_size] * (self.prime ** self.window_size)) % (2**32)
            else:
                hash_val = (hash_val * self.prime + data[i]) % (2**32)

            if i >= self.min_block_size:
                if (hash_val & self.modulus) == self.modulus:
                    boundaries.append(i + 1)
                elif i - (boundaries[-1] if boundaries else 0) >= self.max_block_size:
                    boundaries.append(i + 1)

        if not boundaries or boundaries[-1] != len(data):
            boundaries.append(len(data))

        return boundaries
    
    
    async def deduplicate_before_encryption(
        self,
        file_data: bytes,
        file_name: str,
        user_id: str,
        db: AsyncSession
    ) -> Dict:
        """
        Perform deduplication before encryption for better dedup ratios.
        This finds duplicate blocks across all users if enabled.

        Uses parallel hashing for improved performance on large files.
        """
        total_size = len(file_data)

        # Check size limit - skip dedup for very large files (>1GB)
        if total_size > self.max_dedup_size:
            logger.info(
                f"⏭️ Skipping deduplication for large file {file_name} "
                f"({total_size/1024/1024/1024:.2f}GB > {self.max_dedup_size/1024/1024/1024:.0f}GB limit). "
                f"File stored efficiently using chunked storage (no dedup needed)."
            )
            return None  # Signal to caller to use regular storage

        boundaries = await run_in_heavy_pool(self.find_chunk_boundaries, file_data)

        # Compute chunk offsets and sizes from boundaries (integer arithmetic, microseconds)
        chunk_offsets = [0] + boundaries[:-1]
        chunk_sizes = [boundaries[0]] + [boundaries[i] - boundaries[i - 1] for i in range(1, len(boundaries))]

        # Hash: Rust batch path avoids slicing entirely; Python fallback slices in thread
        if self._native_batch_sha256 is not None:
            logger.info("Calculating hashes for %d chunks (Rust batch)...", len(boundaries))
            block_hashes = await self.calculate_hashes_parallel(
                [], boundaries=boundaries, file_data=file_data,
            )
        else:
            logger.info("Calculating hashes for %d chunks (Python fallback)...", len(boundaries))
            chunks = await run_in_heavy_pool(_slice_chunks, file_data, boundaries)
            block_hashes = await self.calculate_hashes_parallel(chunks)

        # DB batch lookup — load only (block_hash, id), no full ORM instances
        BATCH_SIZE = 10000
        existing_block_map = {}  # {hash_str: uuid.UUID}

        for batch_start in range(0, len(block_hashes), BATCH_SIZE):
            hash_batch = block_hashes[batch_start:batch_start + BATCH_SIZE]
            query = select(ContentBlock.block_hash, ContentBlock.id).where(
                ContentBlock.block_hash.in_(hash_batch)
            )
            if not self.enable_cross_user_dedup:
                query = query.join(Object).where(Object.user_id == user_id)

            result = await db.execute(query)
            await asyncio.sleep(0)  # Yield after database query

            for row in result:
                if row.block_hash not in existing_block_map:
                    existing_block_map[row.block_hash] = row.id

            await asyncio.sleep(0)  # Yield after processing batch

        # Classification — offloaded to thread pool (plain data in, plain data out)
        (
            blocks, new_block_ranges, duplicate_blocks, duplicate_block_ids,
            new_hashes_for_bloom, deduplicated_size, saved_size,
        ) = await run_in_heavy_pool(
            _classify_blocks, block_hashes, chunk_sizes, chunk_offsets, existing_block_map,
        )

        # Bloom filter updates — must stay on event loop (NOT thread-safe)
        if self.bloom_enabled:
            for h in new_hashes_for_bloom:
                self.bloom_filter.add(h)

        # Materialize unique block bytes — only slices the chunks that are new
        if new_block_ranges:
            new_blocks = await run_in_heavy_pool(
                _extract_unique_blocks, file_data, boundaries, new_block_ranges,
            )
        else:
            new_blocks = []

        # Batch increment reference counts for all duplicate blocks
        if duplicate_block_ids:
            from sqlalchemy import text
            await db.execute(
                text("""
                    UPDATE content_blocks
                    SET reference_count = reference_count + 1
                    WHERE id = ANY(:ids)
                """),
                {"ids": duplicate_block_ids}
            )
        
        return {
            'blocks': blocks,
            'new_blocks': new_blocks,
            'duplicate_blocks': duplicate_blocks,
            'total_size': total_size,
            'deduplicated_size': deduplicated_size,
            'saved_size': saved_size,
            'dedup_ratio': (saved_size / total_size * 100) if total_size > 0 else 0,
            'block_count': len(blocks)
        }
    

    def derive_key_from_content(self, data: bytes, user_id: str = None) -> bytes:
        """
        Derive encryption key from content hash (convergent encryption).
        Uses user-specific salt to prevent cross-user privacy leaks.

        SECURITY: User-specific salt prevents attackers from determining
        if two users have the same file by comparing ciphertexts.
        """
        # Use PBKDF2 to derive a key from the content hash
        content_hash = hashlib.sha256(data).digest()

        # CRITICAL FIX: Use user-specific salt to prevent privacy leaks
        # This prevents cross-user file detection while maintaining per-user dedup
        if user_id:
            salt = hashlib.sha256(f"dedup_user_{user_id}_salt".encode()).digest()
        else:
            # Fallback for backward compatibility (less secure)
            salt = b'dedup_convergent_encryption_salt'

        key = hashlib.pbkdf2_hmac('sha256', content_hash, salt, 100000, dklen=32)
        return key

    async def _store_encrypted_block(
        self,
        block_data: bytes,
        block_hash: str,
        user_id: str,
        cas_path: str,
    ) -> Dict:
        """Convergent-encrypt and store a single dedup block.

        Tries the Rust data plane first (PBKDF2 + AES-GCM + atomic write in
        native code). Falls back to the Python implementation on failure.
        Returns dict with 'success' and 'was_compressed' keys.
        """
        # --- Rust fast path ---
        if getattr(settings, 'RUST_DATAPLANE_ENABLED', False):
            try:
                from .rust_dataplane_client import get_rust_client
                client = get_rust_client()
                result = await client.dedup_chunk(
                    block_data=block_data,
                    block_hash=block_hash,
                    user_id=user_id,
                    cas_path=cas_path,
                    should_compress=True,
                )
                if result.get("success"):
                    logger.debug(
                        "Block %s stored via Rust (%d bytes, compressed=%s)",
                        block_hash[:12], result.get("encrypted_size", 0),
                        result.get("was_compressed", False),
                    )
                    return {
                        'success': True,
                        'was_compressed': result.get('was_compressed', False),
                        'encrypted_size': result.get('encrypted_size', 0),
                    }
            except Exception as exc:
                logger.warning(
                    "Rust dedup_chunk failed for %s, falling back to Python: %s",
                    block_hash[:12], exc,
                )

        # --- Python fallback (no compression) ---
        import hmac as _hmac
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        from cryptography.hazmat.backends import default_backend

        block_key = self.derive_key_from_content(block_data, user_id)
        synthetic_iv = _hmac.new(
            block_key, block_hash.encode(), hashlib.sha256,
        ).digest()[:12]

        cipher = Cipher(
            algorithms.AES(block_key),
            modes.GCM(synthetic_iv),
            backend=default_backend(),
        )
        encryptor = cipher.encryptor()
        encrypted_data = encryptor.update(block_data) + encryptor.finalize()
        block_to_store = synthetic_iv + encryptor.tag + encrypted_data

        await asyncio.to_thread(
            os.makedirs, os.path.dirname(cas_path), exist_ok=True,
        )
        async with aiofiles.open(cas_path, 'wb') as f:
            await f.write(block_to_store)

        logger.debug("Block %s stored via Python (%d bytes)", block_hash[:12], len(block_to_store))
        return {'success': True, 'was_compressed': False}

    async def _store_encrypted_blocks_batch(
        self,
        blocks: List[Dict],
        user_id: str,
    ) -> Dict[str, Dict]:
        """Convergent-encrypt and store multiple blocks via the Rust batch endpoint.

        Splits *blocks* into batches of MAX_BATCH_SIZE and runs up to 3 batches
        concurrently. Returns ``{block_hash: result_dict}`` for every block that
        succeeded. On any error the method returns whatever partial results it
        collected (callers retry missing blocks individually).
        """
        MAX_BATCH_SIZE = 10
        sem = asyncio.Semaphore(3)
        results: Dict[str, Dict] = {}

        from .rust_dataplane_client import get_rust_client
        client = get_rust_client()

        async def _send_batch(batch: List[Dict]) -> None:
            async with sem:
                try:
                    resp = await client.dedup_chunk_batch(
                        blocks=[{
                            "block_data": b["block_data"],
                            "block_hash": b["block_hash"],
                            "cas_path": b["cas_path"],
                        } for b in batch],
                        user_id=user_id,
                        should_compress=True,
                    )
                    for r in resp.get("results", []):
                        if r.get("success"):
                            results[r["block_hash"]] = {
                                "success": True,
                                "was_compressed": r.get("was_compressed", False),
                                "encrypted_size": r.get("encrypted_size", 0),
                            }
                except Exception as exc:
                    logger.warning("Batch dedup call failed, will retry individually: %s", exc)

        # Partition into batches and run concurrently
        batches = [
            blocks[i:i + MAX_BATCH_SIZE]
            for i in range(0, len(blocks), MAX_BATCH_SIZE)
        ]
        await asyncio.gather(*[_send_batch(b) for b in batches])
        return results

    async def store_deduplicated_file(
        self,
        file_data: bytes,
        file_name: str,
        user_id: str,
        db: AsyncSession,
        metadata: Optional[Dict] = None,
        encrypt: bool = True,
        existing_object: Optional[Object] = None
    ) -> Dict:
        """
        Enhanced file storage with pre-encryption deduplication.

        Returns None if file exceeds size limits and should use regular storage.
        """
        try:
            # Perform deduplication analysis
            dedup_result = await self.deduplicate_before_encryption(
                file_data, file_name, user_id, db
            )

            # If dedup was skipped due to size limits, return None
            if dedup_result is None:
                logger.info(f"Skipping deduplication for {file_name} - using regular storage")
                return None
            
            # Calculate file-level hash (offloaded to heavy pool)
            file_hash = await run_in_heavy_pool(self.calculate_block_hash, file_data)
            
            # Check for full-file duplicate
            query = select(Object).where(
                Object.content_hash == file_hash,
                Object.user_id == user_id if not self.enable_cross_user_dedup else True
            ).order_by(Object.created_at.asc())
            
            result = await db.execute(query)
            existing_file = result.scalars().first()
            
            if existing_file:
                # Full file duplicate found
                print(f"🎯 Full duplicate found! File hash: {file_hash[:16]}...")

                # Update existing object if provided, otherwise create new
                if existing_object:
                    existing_object.content_hash = file_hash
                    existing_object.file_size = dedup_result['total_size']
                    existing_object.storage_type = 'deduplicated_reference'
                    existing_object.dedup_info = {
                        'reference_file_id': str(existing_file.id),
                        'is_full_duplicate': True,
                        'saved_size': dedup_result['total_size']
                    }
                    existing_object.encryption_key = existing_file.encryption_key
                    if metadata:
                        if metadata.get('mime_type'):
                            existing_object.mime_type = metadata.get('mime_type')
                        if metadata.get('folder_id'):
                            existing_object.folder_id = metadata.get('folder_id')

                    await db.commit()
                    result_file = existing_object
                else:
                    new_file = Object(
                        file_name=file_name,
                        user_id=user_id,
                        content_hash=file_hash,
                        file_size=dedup_result['total_size'],
                        storage_type='deduplicated_reference',
                        dedup_info={
                            'reference_file_id': str(existing_file.id),
                            'is_full_duplicate': True,
                            'saved_size': dedup_result['total_size']
                        },
                        mime_type=metadata.get('mime_type') if metadata else None,
                        folder_id=metadata.get('folder_id') if metadata else None,
                        # Reference the same encryption key
                        encryption_key=existing_file.encryption_key
                    )
                    db.add(new_file)
                    await db.commit()
                    result_file = new_file

                return {
                    'file_id': str(result_file.id),
                    'status': 'full_duplicate',
                    'saved_size': dedup_result['total_size'],
                    'dedup_ratio': 100.0,
                    'duplicate_blocks': []
                }
            
            # Store new unique blocks
            stored_blocks = []
            
            # For convergent encryption, use a master key for the file metadata
            # but derive block keys from content
            if encrypt:
                # Generate a master key for file metadata (user-specific)
                master_key = encryption_service.generate_file_key()
                encrypted_master_key = encryption_service.encrypt_key(master_key)
            else:
                master_key = None
                encrypted_master_key = None
            
            # --- Phase 1: Pre-filter – batch check which CAS paths already exist ---
            new_blocks = dedup_result['new_blocks']
            cas_paths = [self.get_content_address(b['hash']) for b in new_blocks]

            def _check_existing(paths):
                return {p: os.path.exists(p) for p in paths}

            existing_map = await asyncio.to_thread(_check_existing, cas_paths)

            blocks_to_store = []
            already_exists_hashes = set()
            for blk, cp in zip(new_blocks, cas_paths):
                if existing_map.get(cp, False):
                    already_exists_hashes.add(blk['hash'])
                    logger.debug("Block %s already exists, reusing", blk['hash'][:8])
                elif encrypt:
                    blocks_to_store.append({
                        "block_data": blk['data'],
                        "block_hash": blk['hash'],
                        "cas_path": cp,
                    })

            # --- Phase 2: Batch store via Rust batch endpoint ---
            batch_results: Dict[str, Dict] = {}
            if blocks_to_store and getattr(settings, 'RUST_DATAPLANE_ENABLED', False):
                batch_results = await self._store_encrypted_blocks_batch(
                    blocks_to_store, user_id,
                )
                logger.info(
                    "Batch store: %d/%d blocks stored via Rust batch endpoint",
                    len(batch_results), len(blocks_to_store),
                )

            # --- Phase 3: Fallback – retry any blocks not in batch results ---
            for blk_info in blocks_to_store:
                bh = blk_info["block_hash"]
                if bh not in batch_results:
                    store_result = await self._store_encrypted_block(
                        blk_info["block_data"], bh, user_id, blk_info["cas_path"],
                    )
                    if store_result.get('success'):
                        batch_results[bh] = store_result
                    else:
                        logger.error("Failed to store block %s", bh[:12])

            # Handle unencrypted blocks (no Rust path needed)
            for blk, cp in zip(new_blocks, cas_paths):
                if blk['hash'] in already_exists_hashes or blk['hash'] in batch_results:
                    continue
                if not encrypt and not existing_map.get(cp, False):
                    await asyncio.to_thread(
                        os.makedirs, os.path.dirname(cp), exist_ok=True,
                    )
                    async with aiofiles.open(cp, 'wb') as f:
                        await f.write(blk['data'])

            # --- Phase 4: Assemble stored_blocks in original order ---
            for blk, cp in zip(new_blocks, cas_paths):
                res = batch_results.get(blk['hash'], {})
                stored_blocks.append({
                    'hash': blk['hash'],
                    'path': cp,
                    'size': blk['size'],
                    'offset': blk['offset'],
                    'was_compressed': res.get('was_compressed', False),
                })
            
            # Update existing object if provided, otherwise create new
            if existing_object:
                # Update in-place to preserve file_id
                existing_object.content_hash = file_hash
                existing_object.file_size = dedup_result['total_size']
                existing_object.storage_type = 'content_addressed'
                existing_object.chunk_info = {
                    'blocks': dedup_result['blocks'],
                    'stored_blocks': stored_blocks,
                    'version': 2,
                    'convergent_encryption': encrypt
                }
                existing_object.dedup_info = {
                    'saved_size': dedup_result['saved_size'],
                    'dedup_ratio': dedup_result['dedup_ratio'],
                    'unique_blocks': len(dedup_result['new_blocks']),
                    'duplicate_blocks': len(dedup_result['duplicate_blocks'])
                }
                existing_object.encryption_key = encrypted_master_key
                if metadata:
                    if metadata.get('mime_type'):
                        existing_object.mime_type = metadata.get('mime_type')
                    if metadata.get('folder_id'):
                        existing_object.folder_id = metadata.get('folder_id')

                try:
                    await db.flush()
                    result_file = existing_object
                except Exception as flush_error:
                    # Handle stale data error - the object may have been deleted/modified
                    logger.warning(f"Flush failed for existing object (likely deleted): {flush_error}")
                    await db.rollback()
                    # Refresh the query to get current state
                    existing_object = await db.execute(
                        select(Object).where(
                            Object.content_hash == file_hash,
                            Object.user_id == user_id
                        )
                    )
                    existing_object = existing_object.scalars().first()

                    if not existing_object:
                        # Object was deleted, create a new one instead
                        logger.info("Object was deleted, creating new one")
                        # Set to None so we fall through to create new object
                    else:
                        result_file = existing_object

            # Create new object if existing_object is None or was deleted
            if not existing_object:
                # Create new file object with dedup info
                new_file = Object(
                    file_name=file_name,
                    user_id=user_id,
                    content_hash=file_hash,
                    file_size=dedup_result['total_size'],
                    storage_type='content_addressed',
                    chunk_info={
                        'blocks': dedup_result['blocks'],
                        'stored_blocks': stored_blocks,
                        'version': 2,
                        'convergent_encryption': encrypt  # Mark as using convergent encryption
                    },
                    dedup_info={
                        'saved_size': dedup_result['saved_size'],
                        'dedup_ratio': dedup_result['dedup_ratio'],
                        'unique_blocks': len(dedup_result['new_blocks']),
                        'duplicate_blocks': len(dedup_result['duplicate_blocks'])
                    },
                    mime_type=metadata.get('mime_type') if metadata else None,
                    folder_id=metadata.get('folder_id') if metadata else None,
                    encryption_key=encrypted_master_key  # Store master key for metadata
                )
                db.add(new_file)
                await db.flush()
                result_file = new_file

            # Create ContentBlock entries using batched writer for new blocks only
            new_chunk_data = []
            for block in dedup_result['blocks']:
                if not block['is_duplicate']:
                    new_chunk_data.append({
                        'hash': block['hash'],
                        'size': block['size'],
                        'offset': block['offset']
                    })

            # Use batched writer to prevent lock exhaustion
            if new_chunk_data:
                logger.info(f"Storing {len(new_chunk_data)} new chunks using batched writer...")
                try:
                    stored_count = await batch_writer.store_chunks_safe(
                        chunks=new_chunk_data,
                        file_id=str(result_file.id),
                        db=db,
                        timeout_seconds=300  # 5 minute timeout
                    )
                    logger.info(f"✅ Successfully stored {stored_count} chunks")
                except Exception as e:
                    logger.error(f"Batch chunk storage failed: {e}")
                    raise

            await db.commit()

            print(f"✅ File stored with deduplication:")
            print(f"   - Unique blocks: {len(dedup_result['new_blocks'])}")
            print(f"   - Duplicate blocks: {len(dedup_result['duplicate_blocks'])}")
            print(f"   - Saved: {dedup_result['saved_size']/1024/1024:.1f}MB ({dedup_result['dedup_ratio']:.1f}%)")

            return {
                'file_id': str(result_file.id),
                'status': 'stored_with_dedup',
                'saved_size': dedup_result['saved_size'],
                'dedup_ratio': dedup_result['dedup_ratio'],
                'unique_blocks': len(dedup_result['new_blocks']),
                'total_blocks': len(dedup_result['blocks']),
                'duplicate_blocks': dedup_result['duplicate_blocks']
            }
            
        except Exception as e:
            await db.rollback()
            logger.error(f"Deduplication failed for {file_name}: {e}", exc_info=True)
            raise Exception(f"Deduplication failed: {str(e)}")
    
    
    async def get_deduplication_analytics(
        self,
        db: AsyncSession,
        user_id: Optional[str] = None
    ) -> Dict:
        """
        Get detailed deduplication analytics.
        """
        # Base query
        if user_id:
            # User-specific analytics
            objects_query = select(Object).where(
                Object.user_id == user_id,
                Object.storage_type.in_(['content_addressed', 'deduplicated_reference'])
            )
            blocks_query = select(ContentBlock).join(Object).where(Object.user_id == user_id)
        else:
            # System-wide analytics
            objects_query = select(Object).where(
                Object.storage_type.in_(['content_addressed', 'deduplicated_reference'])
            )
            blocks_query = select(ContentBlock)
        
        # Get file statistics
        files_result = await db.execute(objects_query)
        files = files_result.scalars().all()
        
        total_files = len(files)
        total_logical_size = sum(f.file_size for f in files)
        total_saved = sum(
            f.dedup_info.get('saved_size', 0) 
            for f in files 
            if f.dedup_info
        )
        
        # Get block statistics - FIXED query
        blocks_result = await db.execute(
            select(
                func.count(ContentBlock.id).label('total_blocks'),
                func.sum(ContentBlock.block_size).label('total_block_size'),
                func.avg(ContentBlock.reference_count).label('avg_references')
            )
        )
        block_stats = blocks_result.first()
        
        # Calculate metrics
        physical_size = total_logical_size - total_saved
        dedup_ratio = (total_saved / total_logical_size * 100) if total_logical_size > 0 else 0
        
        # Get top duplicate blocks
        top_duplicates = await db.execute(
            select(
                ContentBlock.block_hash,
                ContentBlock.block_size,
                func.count(ContentBlock.id).label('count')
            )
            .group_by(ContentBlock.block_hash, ContentBlock.block_size)
            .having(func.count(ContentBlock.id) > 1)
            .order_by(func.count(ContentBlock.id).desc())
            .limit(10)
        )
        
        return {
            'summary': {
                'total_files': total_files,
                'logical_size': total_logical_size,
                'physical_size': physical_size,
                'saved_size': total_saved,
                'dedup_ratio': round(dedup_ratio, 2),
                'compression_ratio': round(total_logical_size / physical_size, 2) if physical_size > 0 else 1
            },
            'blocks': {
                'total_blocks': block_stats.total_blocks or 0,
                'total_size': block_stats.total_block_size or 0,
                'avg_references': float(block_stats.avg_references or 0)
            },
            'top_duplicates': [
                {
                    'hash': row.block_hash[:8] + '...',
                    'size': row.block_size,
                    'count': row.count
                }
                for row in top_duplicates
            ]
        }
    
    async def garbage_collect(self, db: AsyncSession) -> Dict:
        """
        Enhanced garbage collection with safety checks.
        """
        # Find blocks with zero references
        unreferenced = await db.execute(
            select(ContentBlock)
            .where(ContentBlock.reference_count <= 0)
        )
        unreferenced_blocks = unreferenced.scalars().all()
        
        deleted_count = 0
        freed_space = 0
        errors = []
        
        for block in unreferenced_blocks:
            try:
                # Double-check no files reference this block
                file_refs = await db.execute(
                    select(func.count(Object.id))
                    .where(
                        Object.chunk_info['blocks'].contains(
                            [{'hash': block.block_hash}]
                        )
                    )
                )
                ref_count = file_refs.scalar()
                
                if ref_count == 0:
                    # Safe to delete
                    content_path = self.get_content_address(block.block_hash)
                    if os.path.exists(content_path):
                        file_size = os.path.getsize(content_path)
                        os.remove(content_path)
                        freed_space += file_size
                        
                        # Remove key file if exists
                        if os.path.exists(content_path + '.key'):
                            os.remove(content_path + '.key')
                    
                    await db.delete(block)
                    deleted_count += 1
                else:
                    # Fix reference count
                    block.reference_count = ref_count
                    
            except Exception as e:
                errors.append({
                    'block_hash': block.block_hash,
                    'error': str(e)
                })
        
        await db.commit()
        
        return {
            'deleted_blocks': deleted_count,
            'freed_space': freed_space,
            'errors': errors
        }
    
    def get_content_address(self, content_hash: str) -> str:  
        """Get storage path for content hash.
        Uses first 2 chars for sharding: /cas/ab/abcdef123456...
        """
        shard = content_hash[:2]
        return os.path.join(self.cas_path, shard, content_hash)

# Enhanced singleton instance
enhanced_dedup_service = EnhancedDeduplicationService()