# services/storage-service/app/services/preview_optimizer.py
"""
Preview Optimization Service

Optimizes preview generation for large files by:
1. Downloading only the first few MB (not entire file)
2. Using partial decryption for chunked files
3. Smart caching with compression

For a 400MB video, this reduces download from 400MB → 10-20MB
Preview generation: 176s → 3-5s (98% faster)
"""

import os
import asyncio
import tempfile
import aiofiles
import base64
import logging
import struct
from dataclasses import dataclass
from typing import Optional, Tuple
from .video_optimizer import video_optimizer

logger = logging.getLogger(__name__)

MB = 1024 * 1024
MAX_SYNC_FULL_VIDEO_DOWNLOAD_MB = 100  # Hard cap for blocking preview fetches (lowered to prevent OOM)
MAX_BG_ENCRYPTED_VIDEO_MB = 200   # Background: single-storage encrypted (full file in memory + decrypted copy)
MAX_BG_CAS_VIDEO_MB = 500         # Background: CAS/chunked (streamed to disk, no double-buffer)


@dataclass
class PreviewDownloadResult:
    """Explicit result from download_partial_for_preview."""
    status: str               # 'ok', 'deferred', 'failed'
    temp_file_path: Optional[str] = None
    is_complete: bool = False
    error: Optional[str] = None


TAIL_HEAVY_VIDEO_EXTS = {
    '.mov', '.qt', '.mp4', '.m4v', '.3gp', '.3g2', '.f4v', '.m4a'
}
TAIL_HEAVY_VIDEO_MIME_PREFIXES = {
    'video/quicktime',
    'video/mp4',
    'video/3gpp',
    'video/3gpp2'
}


def _needs_head_tail(file_obj, is_partial: bool) -> bool:
    """
    Determine if a file should use head+tail download strategy.

    Large MOV/MP4-style files often store the moov atom at the end, which
    requires fetching both the start and tail segments to generate previews.
    """
    if not is_partial:
        return False

    mime = (file_obj.mime_type or '').lower()
    if not mime.startswith('video/'):
        return False

    if file_obj.file_size <= 50 * 1024 * 1024:  # Only treat large videos specially
        return False

    ext = os.path.splitext(file_obj.file_name or '')[1].lower()
    if ext in TAIL_HEAVY_VIDEO_EXTS:
        return True

    return mime in TAIL_HEAVY_VIDEO_MIME_PREFIXES


def _has_moov(data: bytes) -> tuple[bool, Optional[int], Optional[int]]:
    """
    Scan for moov or moof atom in byte stream.

    MP4/MOV box format:
    - 4 bytes: box size (big-endian uint32)
    - 4 bytes: box type (ASCII, e.g., 'moov' or 'moof')
    - N bytes: box data

    For fragmented MP4 (fMP4), we accept 'moof' (movie fragment) as well as 'moov'.

    Returns: (found: bool, offset: Optional[int], box_size: Optional[int])
    """
    if len(data) < 8:
        return False, None, None

    # Search for 'moov' or 'moof' signatures
    for signature_name, signature in [('moov', b'moov'), ('moof', b'moof')]:
        offset = 0

        while offset < len(data) - 8:
            # Find next occurrence
            pos = data.find(signature, offset)
            if pos == -1:
                break

            # Check if this is actually a box header (signature should be at offset +4 after size)
            if pos >= 4:
                try:
                    # Read the 4 bytes before signature as box size
                    box_size_bytes = data[pos - 4:pos]
                    box_size = struct.unpack('>I', box_size_bytes)[0]  # big-endian uint32

                    # Validate box size is reasonable (not too small, not larger than remaining data)
                    if 8 <= box_size <= len(data) - (pos - 4):
                        logger.info(f"✓ {signature_name} atom found at offset {pos - 4}, size: {box_size} bytes")
                        return True, pos - 4, box_size
                except struct.error:
                    pass

            offset = pos + 1

    return False, None, None


def _is_fragmented_mp4(data: bytes) -> bool:
    """
    Detect fragmented MP4 files (fMP4).

    Fragmented MP4 uses 'moof' (movie fragment) and 'mfhd' (movie fragment header)
    boxes instead of a single 'moov' box. These cannot be previewed with partial downloads.

    Returns: True if fragmented, False otherwise
    """
    if len(data) < 8:
        return False

    # Check for fragment indicators
    return b'moof' in data or b'mfhd' in data


def _moov_has_mvex(data: bytes, start: int, end: int) -> bool:
    """Walk immediate child boxes of moov looking for 'mvex'.

    Uses the same box-header validation as the top-level walker.
    Only called when the full moov body is in the buffer.
    """
    pos = start
    while pos + 8 <= end:
        raw_size = struct.unpack('>I', data[pos:pos + 4])[0]
        child_type = data[pos + 4:pos + 8]

        if raw_size == 1:
            if pos + 16 > end:
                break
            child_size = struct.unpack('>Q', data[pos + 8:pos + 16])[0]
            if child_size < 16:
                break
        elif raw_size == 0:
            break
        else:
            child_size = raw_size
            if child_size < 8:
                break

        if child_type == b'mvex':
            return True

        pos += child_size

    return False


def _quick_probe_moov(
    data: bytes,
) -> tuple[bool, Optional[int], Optional[int], bool, bool]:
    """Walk top-level MP4 boxes from byte 0 to find moov.

    Unlike _has_moov (string search), this validates box structure by
    advancing cursor by box_size at each step.

    Returns: (found, offset, box_size, is_complete, is_fragmented)
    - is_complete: True only if the full moov body fits in *data*
    - is_fragmented: True if moov contains 'mvex' sub-box (only reliable when is_complete)
    """
    pos = 0
    while pos + 8 <= len(data):
        raw_size = struct.unpack('>I', data[pos:pos + 4])[0]
        box_type = data[pos + 4:pos + 8]

        if raw_size == 1:
            # 64-bit extended size — minimum valid box is 16 bytes
            if pos + 16 > len(data):
                break
            box_size = struct.unpack('>Q', data[pos + 8:pos + 16])[0]
            if box_size < 16:
                break  # Invalid extended-size box
        elif raw_size == 0:
            break  # Box extends to EOF — can't walk past it
        else:
            box_size = raw_size
            if box_size < 8:
                break  # Invalid box

        if box_type == b'moov':
            moov_end = pos + box_size
            is_complete = moov_end <= len(data)

            if is_complete:
                # Full moov in buffer — walk child boxes to find mvex
                has_mvex = _moov_has_mvex(data, pos + 8, moov_end)
            else:
                # Truncated — can't confirm progressive vs fragmented
                has_mvex = False

            return True, pos, box_size, is_complete, has_mvex

        # Advance to next top-level box
        pos += box_size

    return False, None, None, False, False


# Zstd magic bytes for detecting compressed CAS blocks
_ZSTD_MAGIC = bytes([0x28, 0xB5, 0x2F, 0xFD])


def _decrypt_cas_block(encrypted_data: bytes, block_hash: str, user_id: str) -> bytes:
    """Synchronous helper: PBKDF2 key derivation + AES-GCM decryption + optional zstd decompression.

    Runs in HEAVY_TASK_EXECUTOR to avoid blocking the event loop.
    """
    import hashlib
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.backends import default_backend

    nonce = encrypted_data[:12]
    tag = encrypted_data[12:28]
    ciphertext = encrypted_data[28:]

    content_hash_bytes = bytes.fromhex(block_hash)
    salt = hashlib.sha256(f"dedup_user_{user_id}_salt".encode()).digest()
    block_key = hashlib.pbkdf2_hmac(
        'sha256', content_hash_bytes, salt, 100000, dklen=32
    )

    cipher = Cipher(
        algorithms.AES(block_key),
        modes.GCM(nonce, tag),
        backend=default_backend()
    )
    decryptor = cipher.decryptor()
    decrypted_block = decryptor.update(ciphertext) + decryptor.finalize()

    if len(decrypted_block) >= 4 and decrypted_block[:4] == _ZSTD_MAGIC:
        try:
            import zstandard
            dctx = zstandard.ZstdDecompressor()
            decrypted_block = dctx.decompress(decrypted_block, max_output_size=64 * 1024 * 1024)
        except Exception:
            pass

    return decrypted_block


async def _read_and_decrypt_cas_block(
    stored_block: dict,
    block_hash: str,
    user_id: str,
    is_convergent: bool,
) -> bytes:
    """Read and decrypt a single CAS block from disk.

    Shared by _fetch_from_cas and _fetch_cas_probe to avoid duplicate
    decrypt/decompress implementations.

    Returns decrypted (and decompressed if zstd) block bytes.
    Raises FileNotFoundError if block file is missing.
    """
    from ..utils.executors import run_in_heavy_pool

    block_path = stored_block['path']
    try:
        async with aiofiles.open(block_path, 'rb') as f:
            encrypted_data = await f.read()
    except FileNotFoundError:
        raise FileNotFoundError(f"Block file missing at {block_path}")

    if is_convergent:
        was_compressed = stored_block.get('was_compressed', False)
        # Try Rust data plane for fast PBKDF2 decryption
        try:
            from ..services.rust_dataplane_client import get_rust_client
            rust_client = get_rust_client()
            return await rust_client.convergent_decrypt(
                encrypted_data, block_hash, user_id,
                was_compressed=was_compressed,
            )
        except Exception:
            # Fallback: Python PBKDF2 (runs in heavy thread pool)
            return await run_in_heavy_pool(
                _decrypt_cas_block, encrypted_data, block_hash, user_id
            )
    else:
        raise ValueError("Non-convergent CAS blocks require encryption_service")


async def _fetch_from_cas(
    chunk_info: dict,
    file_obj,
    start_byte: int,
    end_byte: int,
    output_path: str,
) -> int:
    """
    Reconstruct a byte range from content-addressed storage (CAS) blocks.

    Reads blocks from CAS paths, performs convergent decryption (offloaded to
    thread pool), optional decompression, and writes the requested range to
    output_path.

    Returns:
        Total bytes written.
    """
    blocks = chunk_info['blocks']
    stored_blocks = chunk_info['stored_blocks']
    is_convergent = chunk_info.get('convergent_encryption', False)
    user_id = str(file_obj.user_id)

    block_map = {b['hash']: b for b in stored_blocks}
    current_pos = 0
    total_written = 0

    async with aiofiles.open(output_path, 'wb') as output_f:
        for block in blocks:
            block_hash = block['hash']
            block_size = block['size']
            block_end = current_pos + block_size - 1

            if block_end < start_byte:
                current_pos += block_size
                continue

            if current_pos > end_byte:
                break

            stored_block = block_map.get(block_hash)
            if not stored_block:
                raise ValueError(f"Block {block_hash[:8]} not found in stored_blocks")

            decrypted_block = await _read_and_decrypt_cas_block(
                stored_block, block_hash, user_id, is_convergent
            )

            slice_start = max(0, start_byte - current_pos)
            slice_end = min(block_size, end_byte - current_pos + 1)

            if slice_start < slice_end and slice_start < len(decrypted_block):
                to_write = decrypted_block[slice_start:slice_end]
                await output_f.write(to_write)
                total_written += len(to_write)

            current_pos += block_size

    logger.info(f"✓ CAS fetch complete: {total_written / 1024 / 1024:.1f}MB written")
    return total_written


# ---------------------------------------------------------------------------
# CAS probe-then-fetch helpers
# ---------------------------------------------------------------------------

def _select_cas_probe_blocks(
    blocks: list,
    head_bytes_target: int = 64 * MB,
    tail_bytes_target: int = 64 * MB,
) -> list:
    """Select sparse block indices for moov/fMP4 probing.

    Targets ~64MB head + ~12-24MB middle + ~64MB tail (matching
    video_transcoder.py:486,507 probe sizes).  Block counts are derived
    from cumulative byte sizes, so behaviour is stable across 2-8MB CAS
    blocks.
    """
    n = len(blocks)

    # Head: accumulate blocks until we reach head_bytes_target
    head_indices: list[int] = []
    head_total = 0
    for i in range(n):
        head_indices.append(i)
        head_total += blocks[i]['size']
        if head_total >= head_bytes_target:
            break

    # Middle: 3 blocks around centre (for fMP4 moof/mfhd detection)
    middle_indices: list[int] = []
    if n >= 9:
        mid = n // 2
        middle_indices = [max(0, mid - 1), mid, min(n - 1, mid + 1)]

    # Tail: accumulate blocks from end until we reach tail_bytes_target
    tail_indices: list[int] = []
    tail_total = 0
    for i in range(n - 1, -1, -1):
        tail_indices.append(i)
        tail_total += blocks[i]['size']
        if tail_total >= tail_bytes_target:
            break
    tail_indices.reverse()

    return sorted(set(head_indices + middle_indices + tail_indices))


async def _fetch_cas_probe(
    chunk_info: dict,
    file_obj,
    probe_indices: list,
) -> tuple:
    """Fetch specific CAS blocks for sparse moov probing.

    Returns:
        (probe_buffer, offset_map) where offset_map is a list of
        (probe_buf_start, probe_buf_end, real_file_offset) tuples that
        allow translating a byte offset found in the probe buffer back to
        the real file offset.

    Raises ValueError if any block's decrypted size does not match its
    declared size (offset map would be invalid).
    Raises FileNotFoundError if a block file is missing on disk.
    """
    blocks = chunk_info['blocks']
    stored_blocks = chunk_info['stored_blocks']
    is_convergent = chunk_info.get('convergent_encryption', False)
    user_id = str(file_obj.user_id)
    block_map = {b['hash']: b for b in stored_blocks}

    # Pre-compute cumulative file offsets for each block
    file_offsets: list[int] = []
    cum = 0
    for b in blocks:
        file_offsets.append(cum)
        cum += b['size']

    probe_parts: list[bytes] = []
    offset_map: list[tuple[int, int, int]] = []
    probe_pos = 0

    for idx in probe_indices:
        block = blocks[idx]
        stored = block_map.get(block['hash'])
        if not stored:
            logger.warning(f"CAS probe: block {idx} hash {block['hash'][:8]} not in stored_blocks, skipping")
            continue

        decrypted = await _read_and_decrypt_cas_block(
            stored, block['hash'], user_id, is_convergent
        )

        # Strict size validation — offset map depends on declared sizes
        if len(decrypted) != block['size']:
            raise ValueError(
                f"CAS block {idx} size mismatch: declared={block['size']}, "
                f"actual={len(decrypted)} — aborting probe (offset map invalid)"
            )

        probe_parts.append(decrypted)
        offset_map.append((probe_pos, probe_pos + len(decrypted), file_offsets[idx]))
        probe_pos += len(decrypted)
        await asyncio.sleep(0)  # Yield between blocks

    return b''.join(probe_parts), offset_map


def _probe_offset_to_file_offset(
    probe_offset: int,
    offset_map: list,
) -> Optional[int]:
    """Map a probe-buffer byte offset to the real file byte offset.

    Returns the real file offset, or None if probe_offset falls in a gap
    between downloaded blocks.
    """
    for probe_start, probe_end, file_start in offset_map:
        if probe_start <= probe_offset < probe_end:
            return file_start + (probe_offset - probe_start)
    return None


async def _fetch_contiguous_range(
    start_byte: int,
    end_byte: int,
    chunk_paths: dict,
    file_key: bytes,
    encryption_service,
    output_path: str,
    upload_id: str,
    chunk_size: int = 33554432,
    was_compressed: bool = False,
    chunk_info: Optional[dict] = None,
    file_obj=None,
) -> int:
    """
    Stream a contiguous byte range from chunked or content-addressed storage to disk.

    This ensures ffmpeg receives a file with NO GAPS - critical for proper parsing.

    If chunk_info contains 'blocks' and 'stored_blocks' (CAS storage), delegates
    to _fetch_from_cas. Otherwise uses traditional chunk_paths.

    Args:
        start_byte: Starting byte offset (inclusive)
        end_byte: Ending byte offset (inclusive)
        chunk_paths: Dict mapping chunk indices to paths (ignored for CAS)
        file_key: Decryption key (ignored for CAS)
        encryption_service: Service for decryption (ignored for CAS)
        output_path: Where to write the contiguous data
        upload_id: Upload ID for path construction (ignored for CAS)
        chunk_size: Size of each chunk (default 32MB)
        was_compressed: Whether chunks are compressed
        chunk_info: Optional full chunk_info (for CAS detection)
        file_obj: Optional file object (required for CAS, for user_id)

    Returns:
        Total bytes written
    """
    if chunk_info and 'blocks' in chunk_info and 'stored_blocks' in chunk_info and file_obj:
        return await _fetch_from_cas(chunk_info, file_obj, start_byte, end_byte, output_path)

    # --- Try Rust streaming for traditional chunked storage ---
    use_rust = False
    try:
        from ..services.rust_dataplane_client import get_rust_client
        rust_client = get_rust_client()
        if await rust_client.is_available():
            use_rust = True
    except Exception:
        pass

    if use_rust:
        total_chunks = chunk_info.get("count", 0) if chunk_info else 0
        if total_chunks == 0:
            total_chunks = end_byte // chunk_size + 1

        first_chunk = start_byte // chunk_size
        last_chunk = min(end_byte // chunk_size, total_chunks - 1)
        chunks = []
        for idx in range(first_chunk, last_chunk + 1):
            path = chunk_paths.get(str(idx))
            if not path:
                shard = upload_id[:2]
                path = f"/app/storage/cache/{shard}/{upload_id}_chunk_{idx}.enc"
            chunks.append({"index": idx, "path": path})

        try:
            total_written = 0
            async with aiofiles.open(output_path, 'wb') as output_f:
                async for data in rust_client.stream_download_chunks(
                    chunks=chunks,
                    file_key=file_key,
                    was_compressed=was_compressed,
                    start_byte=start_byte,
                    end_byte=end_byte,
                    chunk_size=chunk_size,
                ):
                    await output_f.write(data)
                    total_written += len(data)

            logger.info(
                "✓ Contiguous fetch via Rust: %.1fMB written",
                total_written / 1024 / 1024,
            )
            return total_written
        except Exception as exc:
            logger.warning(
                "Rust stream_download_chunks failed, falling back to Python: %s", exc
            )
            # Fall through to Python path below

    # Traditional chunked storage
    # Calculate which chunks span [start_byte, end_byte]
    start_chunk = start_byte // chunk_size
    end_chunk = end_byte // chunk_size

    logger.info(
        f"Fetching contiguous range: bytes [{start_byte}, {end_byte}] "
        f"({(end_byte - start_byte + 1)/1024/1024:.1f}MB) "
        f"from chunks [{start_chunk}, {end_chunk}]"
    )

    total_written = 0

    async with aiofiles.open(output_path, 'wb') as output_f:
        for chunk_idx in range(start_chunk, end_chunk + 1):
            # Get chunk path
            chunk_path = chunk_paths.get(str(chunk_idx))
            if not chunk_path:
                shard = upload_id[:2]
                chunk_path = f"/app/storage/cache/{shard}/{upload_id}_chunk_{chunk_idx}.enc"

            # Load and decrypt chunk (offload CPU-heavy decrypt/decompress)
            try:
                async with aiofiles.open(chunk_path, 'rb') as f:
                    encrypted_chunk = await f.read()
            except FileNotFoundError:
                logger.warning(f"Chunk {chunk_idx} not found at {chunk_path}")
                continue

            from ..utils.executors import run_in_heavy_pool

            def _decrypt_decompress(enc, enc_svc, key, idx, compressed):
                dec = enc_svc.decrypt_chunk(enc, key, idx)
                if compressed:
                    from ..utils.compression import compressor
                    dec = compressor.decompress(dec)
                return dec

            decrypted_chunk = await run_in_heavy_pool(
                _decrypt_decompress,
                encrypted_chunk, encryption_service, file_key, chunk_idx, was_compressed
            )

            # Calculate which bytes from this chunk to write
            chunk_start_byte = chunk_idx * chunk_size
            chunk_end_byte = chunk_start_byte + len(decrypted_chunk) - 1

            # Trim to requested range
            if chunk_idx == start_chunk:
                # First chunk: skip bytes before start_byte
                offset_in_chunk = start_byte - chunk_start_byte
                decrypted_chunk = decrypted_chunk[offset_in_chunk:]

            if chunk_idx == end_chunk:
                # Last chunk: truncate bytes after end_byte
                bytes_to_keep = end_byte - max(start_byte, chunk_start_byte) + 1
                decrypted_chunk = decrypted_chunk[:bytes_to_keep]

            # Stream write to disk (no RAM buffering)
            await output_f.write(decrypted_chunk)
            total_written += len(decrypted_chunk)
            await asyncio.sleep(0)  # Yield between chunks

    logger.info(f"✓ Contiguous fetch complete: {total_written/1024/1024:.1f}MB written")
    return total_written


class PreviewOptimizer:
    """
    Optimizes preview generation by downloading only necessary data
    """

    # Maximum data to download for preview (10MB for videos, 5MB for documents)
    MAX_DOWNLOAD_VIDEO = 10 * 1024 * 1024  # 10MB
    MAX_DOWNLOAD_DOCUMENT = 5 * 1024 * 1024  # 5MB
    MAX_DOWNLOAD_IMAGE = 20 * 1024 * 1024  # 20MB (high-res images)

    def __init__(self):
        pass

    def get_max_download_size(self, mime_type: str, file_size: int) -> int:
        """Determine max download size based on file type"""

        # For small files, download everything
        if file_size < self.MAX_DOWNLOAD_DOCUMENT:
            return file_size

        if mime_type and mime_type.startswith('video/'):
            return min(self.MAX_DOWNLOAD_VIDEO, file_size)
        elif mime_type and mime_type.startswith('image/'):
            return min(self.MAX_DOWNLOAD_IMAGE, file_size)
        elif mime_type and 'pdf' in mime_type:
            return min(self.MAX_DOWNLOAD_DOCUMENT, file_size)
        else:
            return min(self.MAX_DOWNLOAD_DOCUMENT, file_size)

    async def download_with_head_tail(
        self,
        file_path: str,
        file_size: int,
        encryption_service,
        file_key: bytes,
        head_size: int = 10 * 1024 * 1024,  # 10MB
        tail_size: int = 2 * 1024 * 1024    # 2MB
    ) -> Tuple[str, bool]:
        """
        Download head + tail of file for video preview (MOV files with moov at end)

        This handles the case where video metadata (moov atom) is at the end of the file.
        We download the first 10MB and last 2MB, then reassemble them.

        Returns: (temp_file_path, is_complete)
        """
        from ..utils.executors import run_in_heavy_pool

        # If file is small enough, download completely
        if file_size <= head_size + tail_size:
            logger.info(f"File small enough ({file_size/1024/1024:.1f}MB), downloading completely")
            async with aiofiles.open(file_path, 'rb') as f:
                encrypted_data = await f.read()

            file_data = await run_in_heavy_pool(encryption_service.decrypt_file, encrypted_data, file_key)

            temp_fd, temp_file_path = tempfile.mkstemp()
            os.close(temp_fd)

            async with aiofiles.open(temp_file_path, 'wb') as f:
                await f.write(file_data)

            return temp_file_path, True

        logger.info(
            f"Using head+tail download strategy: "
            f"first {head_size/1024/1024:.1f}MB + last {tail_size/1024/1024:.1f}MB "
            f"(total: {file_size/1024/1024:.1f}MB)"
        )

        # Read head (first N MB)
        async with aiofiles.open(file_path, 'rb') as f:
            encrypted_head = await f.read(head_size)

        # Read tail (last N MB)
        async with aiofiles.open(file_path, 'rb') as f:
            # Seek to tail position
            tail_offset = file_size - tail_size
            await f.seek(tail_offset)
            encrypted_tail = await f.read()

        # Decrypt both portions (offloaded to thread pool)
        head_data = await run_in_heavy_pool(encryption_service.decrypt_file, encrypted_head, file_key)
        tail_data = await run_in_heavy_pool(encryption_service.decrypt_file, encrypted_tail, file_key)

        # Create temp file with head + tail
        temp_fd, temp_file_path = tempfile.mkstemp()
        os.close(temp_fd)

        async with aiofiles.open(temp_file_path, 'wb') as f:
            await f.write(head_data)
            await f.write(tail_data)

        logger.info(
            f"Head+tail download complete: "
            f"{len(head_data) + len(tail_data)} bytes written "
            f"({(len(head_data) + len(tail_data))/1024/1024:.1f}MB)"
        )

        return temp_file_path, False  # Not complete, but has head+tail

    async def download_partial_for_preview(
        self,
        file_obj,
        encryption_service,
        max_size: Optional[int] = None,
        background: bool = False,
    ) -> PreviewDownloadResult:
        """
        Download only the first portion of a file for preview generation.

        Returns PreviewDownloadResult with:
        - status='ok': temp_file_path set, ready for preview generation
        - status='deferred': too large for sync, caller should queue to Kafka
        - status='failed': too large even for background, deterministic failure
        """

        if max_size is None:
            max_size = self.get_max_download_size(
                file_obj.mime_type,
                file_obj.file_size
            )

        # Determine if we need partial download
        is_partial = file_obj.file_size > max_size

        logger.info(
            f"Preview download: {file_obj.file_name} "
            f"(total: {file_obj.file_size/1024/1024:.1f}MB, "
            f"downloading: {max_size/1024/1024:.1f}MB, "
            f"partial: {is_partial})"
        )

        # Create temp file
        temp_fd, temp_file_path = tempfile.mkstemp()
        os.close(temp_fd)

        try:
            # Get encryption key
            file_key = encryption_service.decrypt_key(file_obj.encryption_key)

            # Check if compressed
            was_compressed = False
            if file_obj.file_metadata and isinstance(file_obj.file_metadata, dict):
                was_compressed = file_obj.file_metadata.get("compressed", False)
            elif file_obj.chunk_info and isinstance(file_obj.chunk_info, dict):
                was_compressed = file_obj.chunk_info.get("compressed", False)

            # Handle different storage types
            if file_obj.storage_type == "inline":
                # Inline data - always complete
                encrypted_data = base64.b64decode(file_obj.storage_key)
                file_data = encryption_service.decrypt_file(encrypted_data, file_key)

                if was_compressed:
                    from ..utils.compression import compressor
                    file_data = compressor.decompress(file_data)

                async with aiofiles.open(temp_file_path, 'wb') as f:
                    await f.write(file_data)

                return PreviewDownloadResult(status='ok', temp_file_path=temp_file_path, is_complete=True)

            elif file_obj.storage_type == "single":
                # Single file storage
                if not await asyncio.to_thread(os.path.exists, file_obj.object_path):
                    raise FileNotFoundError(f"File not found: {file_obj.object_path}")

                # =================================================================
                # IMPORTANT: Head+tail strategy DOES NOT WORK for single encrypted files!
                # AES-GCM requires the FULL ciphertext to decrypt (nonce at start, MAC at end).
                # Partial decryption will always fail with an authentication error.
                # =================================================================

                # Check file size for OOM protection
                file_size_mb = file_obj.file_size / MB
                mime = (file_obj.mime_type or '').lower()
                is_video = mime.startswith('video/')

                # For large single-storage videos, guard based on caller context.
                # Encrypted single-storage loads full ciphertext + decrypted copy (2x memory).
                effective_limit = MAX_BG_ENCRYPTED_VIDEO_MB if background else MAX_SYNC_FULL_VIDEO_DOWNLOAD_MB
                if is_video and file_size_mb > effective_limit:
                    logger.info(
                        f"Large single-storage video: {file_obj.file_name} "
                        f"({file_size_mb:.1f}MB > {effective_limit}MB limit)"
                    )
                    os.unlink(temp_file_path)
                    status = 'failed' if background else 'deferred'
                    return PreviewDownloadResult(
                        status=status,
                        error=f"Video {file_size_mb:.0f}MB exceeds {effective_limit}MB limit",
                    )

                # Standard approach: decrypt FULL file
                # NOTE: For encrypted files, we must read the COMPLETE file for decryption
                # because GCM encryption requires the full ciphertext to verify the MAC.
                # After decryption, we can then use only a portion for preview generation.
                logger.info(f"Downloading full single-storage file for preview: {file_obj.file_name} ({file_size_mb:.1f}MB)")
                async with aiofiles.open(file_obj.object_path, 'rb') as f:
                    encrypted_data = await f.read()  # Always read complete encrypted file

                from ..utils.executors import run_in_heavy_pool

                file_data = await run_in_heavy_pool(encryption_service.decrypt_file, encrypted_data, file_key)

                if was_compressed:
                    from ..utils.compression import compressor
                    file_data = await run_in_heavy_pool(compressor.decompress, file_data)

                # Write file data for preview
                # For videos, always write full data since moov atom may be at the end
                # We've already decrypted the full file, so truncating wastes that work
                mime = (file_obj.mime_type or '').lower()
                is_video = mime.startswith('video/')
                is_pdf = mime == 'application/pdf' or (file_obj.file_name or '').lower().endswith('.pdf')

                async with aiofiles.open(temp_file_path, 'wb') as f:
                    if is_partial and not is_video and not is_pdf:
                        # Non-video, non-PDF: write only first portion
                        await f.write(file_data[:max_size])
                    else:
                        # Video/PDF or small file: write full decrypted data
                        # PDFs need the xref table at EOF; videos need the moov atom
                        await f.write(file_data)
                        if (is_video or is_pdf) and is_partial:
                            logger.info(
                                f"{'PDF' if is_pdf else 'Video'} preview: wrote full {len(file_data)/1024/1024:.1f}MB "
                                f"(not truncated to {max_size/1024/1024:.1f}MB to preserve {'xref table' if is_pdf else 'moov atom'})"
                            )

                return PreviewDownloadResult(status='ok', temp_file_path=temp_file_path, is_complete=True)

            else:  # chunked or content-addressed storage
                # Download only first N chunks (or full file for CAS)
                chunk_info = file_obj.chunk_info
                if not chunk_info:
                    raise ValueError("Chunk info not found")

                upload_id = chunk_info.get("upload_id", str(file_obj.id))
                total_chunks = chunk_info.get("count", 0)
                chunk_size = chunk_info.get("chunk_size", 32 * 1024 * 1024)  # Default 32MB
                chunk_paths = chunk_info.get("paths", {})

                # Content-addressed storage (from dedup): use CAS block reconstruction
                if "blocks" in chunk_info and "stored_blocks" in chunk_info:
                    blocks_list = chunk_info['blocks']

                    if _needs_head_tail(file_obj, is_partial):
                        # === CAS PROBE-THEN-FETCH (supports any file size) ===
                        file_size_mb = file_obj.file_size / MB

                        logger.info(
                            f"CAS probe-then-fetch: {file_obj.file_name} "
                            f"({file_size_mb:.1f}MB, {len(blocks_list)} blocks)"
                        )

                        MOOV_EARLY_THRESHOLD = 64 * MB

                        # --- Quick probe: block 0 only ---
                        try:
                            quick_data, quick_map = await _fetch_cas_probe(
                                chunk_info, file_obj, [0]
                            )
                            found, moov_off, moov_size, is_complete, is_fmp4 = _quick_probe_moov(quick_data)

                            if found and is_complete and not is_fmp4:
                                real_offset = _probe_offset_to_file_offset(moov_off, quick_map)
                                if real_offset is not None and real_offset <= MOOV_EARLY_THRESHOLD:
                                    moov_end = real_offset + moov_size
                                    fetch_end = min(moov_end + 2 * MB, file_obj.file_size - 1)
                                    logger.info(
                                        f"CAS quick probe: moov at file offset {real_offset} "
                                        f"({moov_size} bytes), progressive MP4 — "
                                        f"fetching [0...{fetch_end/MB:.1f}MB], skipped full sparse probe"
                                    )
                                    del quick_data
                                    await _fetch_from_cas(
                                        chunk_info, file_obj, 0, fetch_end, temp_file_path
                                    )
                                    return PreviewDownloadResult(
                                        status='ok',
                                        temp_file_path=temp_file_path,
                                        is_complete=False,
                                    )

                            if found and is_complete and is_fmp4:
                                logger.info("CAS quick probe: fMP4 detected (mvex in moov), using full probe path")
                            elif found and not is_complete:
                                logger.info(
                                    f"CAS quick probe: moov found at {moov_off} but truncated "
                                    f"(needs {moov_off + moov_size} bytes), using full probe path"
                                )
                            elif not found:
                                logger.info("CAS quick probe: moov not in block 0, using full probe path")

                            del quick_data
                        except (ValueError, FileNotFoundError) as exc:
                            logger.warning(f"CAS quick probe failed ({type(exc).__name__}): {exc}")
                        # All other cases: fall through to existing full sparse probe

                        # Phase 1: Sparse probe (~64MB head + middle + ~64MB tail)
                        probe_data = b''
                        offset_map = []
                        try:
                            probe_indices = _select_cas_probe_blocks(blocks_list)
                            probe_data, offset_map = await _fetch_cas_probe(
                                chunk_info, file_obj, probe_indices
                            )
                            logger.info(
                                f"CAS probe complete: {len(probe_data)/MB:.1f}MB "
                                f"from {len(probe_indices)} blocks"
                            )
                        except (ValueError, FileNotFoundError) as exc:
                            # Expected probe failures: block size mismatch or missing files
                            logger.warning(f"CAS probe failed ({type(exc).__name__}): {exc}")
                        # All other exceptions propagate up (coding bugs, etc.)

                        # Phase 2: Detect format and locate moov
                        is_fragmented = _is_fragmented_mp4(probe_data) if probe_data else False
                        has_moov, moov_probe_offset, moov_box_size = (
                            _has_moov(probe_data) if probe_data else (False, None, None)
                        )

                        # Phase 3: Route based on detection

                        if has_moov and not is_fragmented and moov_probe_offset is not None:
                            real_moov_offset = _probe_offset_to_file_offset(
                                moov_probe_offset, offset_map
                            )

                            if real_moov_offset is not None and real_moov_offset <= MOOV_EARLY_THRESHOLD:
                                # PARTIAL FETCH: moov at start — NO SIZE LIMIT
                                moov_end = real_moov_offset + (moov_box_size or 10 * MB)
                                guard = 2 * MB
                                fetch_end = min(moov_end + guard, file_obj.file_size - 1)

                                logger.info(
                                    f"CAS partial fetch: moov at {real_moov_offset/MB:.1f}MB, "
                                    f"box_size={moov_box_size}, "
                                    f"fetching [0...{fetch_end/MB:.1f}MB] of {file_size_mb:.1f}MB"
                                )

                                del probe_data
                                await _fetch_from_cas(
                                    chunk_info, file_obj, 0, fetch_end, temp_file_path
                                )
                                return PreviewDownloadResult(
                                    status='ok',
                                    temp_file_path=temp_file_path,
                                    is_complete=False,
                                )

                        # FULL DOWNLOAD FALLBACK
                        reason = (
                            "probe failed" if not offset_map
                            else "fragmented MP4" if is_fragmented
                            else "moov not found in probe" if not has_moov
                            else "moov beyond 64MB threshold"
                        )
                        del probe_data

                        # Sync path: defer to Kafka background worker
                        if not background and file_size_mb > MAX_SYNC_FULL_VIDEO_DOWNLOAD_MB:
                            os.unlink(temp_file_path)
                            return PreviewDownloadResult(
                                status='deferred',
                                error=f"CAS video {file_size_mb:.0f}MB ({reason}) — deferred to background",
                            )

                        # Background path: full download — NO SIZE LIMIT
                        # _fetch_from_cas streams block-by-block (~16-20MB peak memory)
                        # Temp file cleaned up at preview_worker.py:302-308
                        logger.info(
                            f"CAS full download ({reason}): streaming "
                            f"{file_size_mb:.1f}MB to disk"
                        )
                        await _fetch_from_cas(
                            chunk_info, file_obj, 0, file_obj.file_size - 1, temp_file_path
                        )
                        return PreviewDownloadResult(
                            status='ok',
                            temp_file_path=temp_file_path,
                            is_complete=True,
                        )

                    elif is_partial:
                        # Non-video or small video: partial download up to max_size
                        fetch_end = min(max_size - 1, file_obj.file_size - 1)
                        await _fetch_from_cas(
                            chunk_info, file_obj, 0, fetch_end, temp_file_path
                        )
                        is_complete = (fetch_end >= file_obj.file_size - 1)
                        return PreviewDownloadResult(
                            status='ok',
                            temp_file_path=temp_file_path,
                            is_complete=is_complete,
                        )

                    else:
                        # Full download requested
                        await _fetch_from_cas(
                            chunk_info, file_obj, 0, file_obj.file_size - 1, temp_file_path
                        )
                        return PreviewDownloadResult(
                            status='ok',
                            temp_file_path=temp_file_path,
                            is_complete=True,
                        )

                if _needs_head_tail(file_obj, is_partial):
                    # ==================================================================
                    # PROBE-THEN-FETCH PATTERN FOR FRAGMENTED MP4 (fMP4)
                    # ==================================================================
                    # Phase 1: Probe with sparse chunks to detect format (gappy OK)
                    # Phase 2: Based on detection, fetch contiguously (NO GAPS)
                    # Phase 3: Pass contiguous file to ffmpeg
                    # ==================================================================

                    logger.info(
                        f"Large video detected ({file_obj.file_name}, "
                        f"{file_obj.file_size/1024/1024:.1f}MB, {total_chunks} chunks) - "
                        f"using probe-then-fetch pattern"
                    )

                    # Shared helpers for Stage A quick probe and Stage B full probe
                    from ..utils.executors import run_in_heavy_pool as _run_heavy

                    def _probe_decrypt_decompress(enc, enc_svc, key, idx, compressed):
                        dec = enc_svc.decrypt_chunk(enc, key, idx)
                        if compressed:
                            from ..utils.compression import compressor
                            dec = compressor.decompress(dec)
                        return dec

                    # --- STAGE A: Quick probe (chunk 0 only) ---
                    # For fast-start MP4s (moov at front), we can skip the full
                    # 9-chunk sparse probe by checking just the first chunk.
                    # Short-circuit ONLY if full moov body is in the buffer.
                    chunk0_data = None
                    try:
                        c0_path = chunk_paths.get(str(0))
                        if not c0_path:
                            shard = upload_id[:2]
                            c0_path = f"/app/storage/cache/{shard}/{upload_id}_chunk_0.enc"

                        async with aiofiles.open(c0_path, 'rb') as f:
                            c0_enc = await f.read()
                        chunk0_data = await _run_heavy(
                            _probe_decrypt_decompress, c0_enc, encryption_service, file_key, 0, was_compressed
                        )
                        del c0_enc

                        found, moov_off, moov_size, is_complete, is_fmp4 = _quick_probe_moov(chunk0_data)

                        if found and is_complete and not is_fmp4:
                            # Progressive MP4, full moov in chunk 0 — short-circuit
                            fetch_end = min(moov_off + moov_size + 2 * MB, file_obj.file_size - 1)
                            fetch_end = max(fetch_end, min(10 * MB, file_obj.file_size - 1))  # 10MB floor

                            logger.info(
                                f"Quick probe: moov at offset {moov_off} ({moov_size} bytes), "
                                f"progressive MP4 — fetching [0...{fetch_end/MB:.1f}MB], "
                                f"skipped full sparse probe"
                            )

                            await _fetch_contiguous_range(
                                start_byte=0, end_byte=fetch_end,
                                chunk_paths=chunk_paths, file_key=file_key,
                                encryption_service=encryption_service,
                                output_path=temp_file_path, upload_id=upload_id,
                                chunk_size=chunk_size, was_compressed=was_compressed,
                                chunk_info=chunk_info, file_obj=file_obj,
                            )
                            return PreviewDownloadResult(
                                status='ok', temp_file_path=temp_file_path, is_complete=False
                            )

                        if found and is_complete and is_fmp4:
                            logger.info("Quick probe: fMP4 detected (mvex in moov), using full probe path")
                            # Fall through — existing path has 500MB limit + defer/background gating

                        if found and not is_complete:
                            logger.info(
                                f"Quick probe: moov found at offset {moov_off} but truncated "
                                f"(needs {moov_off + moov_size} bytes, buffer has {len(chunk0_data)}), "
                                f"using full probe path"
                            )

                        if not found:
                            logger.info("Quick probe: moov not in chunk 0, falling back to full sparse probe")

                    except (FileNotFoundError, OSError) as e:
                        logger.warning(f"Quick probe failed ({type(e).__name__}: {e}), falling back to full probe")
                        chunk0_data = None
                    except (ValueError, struct.error) as e:
                        logger.warning(f"Quick probe decrypt/parse error: {e}, falling back to full probe")
                        chunk0_data = None
                    # All other exceptions propagate — matching existing behavior at the outer try/except

                    # --- STAGE B: Full sparse probe (existing logic) ---
                    # --- PHASE 1: PROBE (Download sparse chunks for detection) ---
                    head_limit = min(3, total_chunks)
                    head_chunks_list = list(range(head_limit))

                    middle_chunks_list = []
                    if total_chunks >= 9:
                        middle_idx = total_chunks // 2
                        middle_chunks_list = [
                            max(0, middle_idx - 1),
                            middle_idx,
                            min(total_chunks - 1, middle_idx + 1)
                        ]

                    tail_start = max(0, total_chunks - 3)
                    tail_chunks_list = list(range(tail_start, total_chunks))

                    # Always include the very last chunk so we see metadata stored at the tail
                    if total_chunks > 0:
                        tail_chunks_list.append(total_chunks - 1)

                    # Combine and deduplicate
                    probe_chunks = sorted(set(head_chunks_list + middle_chunks_list + tail_chunks_list))

                    # If Stage A already downloaded chunk 0, reuse it
                    if chunk0_data is not None and 0 in probe_chunks:
                        probe_chunks = [c for c in probe_chunks if c != 0]

                    logger.info(
                        f"Phase 1 - Probe: downloading {len(probe_chunks)} chunks {probe_chunks} "
                        f"for format detection (gappy file OK - detection only)"
                        f"{' (chunk 0 reused from quick probe)' if chunk0_data is not None else ''}"
                    )

                    # Download probe chunks to temporary probe file
                    probe_fd, probe_file_path = tempfile.mkstemp()
                    os.close(probe_fd)

                    try:
                        probe_bytes = 0
                        async with aiofiles.open(probe_file_path, 'wb') as probe_f:
                            # Write chunk 0 first if reusing from quick probe
                            if chunk0_data is not None:
                                await probe_f.write(chunk0_data)
                                probe_bytes += len(chunk0_data)
                                chunk0_data = None  # Free memory

                            for i in probe_chunks:
                                chunk_path = chunk_paths.get(str(i))
                                if not chunk_path:
                                    shard = upload_id[:2]
                                    chunk_path = f"/app/storage/cache/{shard}/{upload_id}_chunk_{i}.enc"

                                try:
                                    async with aiofiles.open(chunk_path, 'rb') as f:
                                        encrypted_chunk = await f.read()
                                except FileNotFoundError:
                                    logger.warning(f"Chunk {i} not found at {chunk_path}")
                                    continue

                                decrypted_chunk = await _run_heavy(
                                    _probe_decrypt_decompress,
                                    encrypted_chunk, encryption_service, file_key, i, was_compressed
                                )

                                await probe_f.write(decrypted_chunk)
                                probe_bytes += len(decrypted_chunk)
                                await asyncio.sleep(0)  # Yield between chunks

                        logger.info(f"Probe complete: {probe_bytes/1024/1024:.1f}MB downloaded")

                        # --- PHASE 2: DETECT FORMAT AND LOCATE MOOV ---
                        async with aiofiles.open(probe_file_path, 'rb') as f:
                            probe_data = await f.read()

                        is_fragmented = _is_fragmented_mp4(probe_data)
                        has_moov, moov_offset, _moov_size = _has_moov(probe_data)

                        if not has_moov:
                            logger.warning(
                                f"⚠️  moov atom NOT found in probe data for {file_obj.file_name}. "
                                f"Falling back to full contiguous download."
                            )
                            os.unlink(probe_file_path)

                            file_size_mb = file_obj.file_size / MB
                            effective_limit = MAX_BG_CAS_VIDEO_MB if background else MAX_SYNC_FULL_VIDEO_DOWNLOAD_MB
                            if file_size_mb > effective_limit:
                                logger.info(
                                    f"File is {file_size_mb:.1f}MB (> {effective_limit}MB). "
                                    f"{'Failed' if background else 'Deferring to background'}."
                                )
                                os.unlink(temp_file_path)
                                status = 'failed' if background else 'deferred'
                                return PreviewDownloadResult(
                                    status=status,
                                    error=f"Video {file_size_mb:.0f}MB exceeds {effective_limit}MB (moov not found)",
                                )

                            await _fetch_contiguous_range(
                                start_byte=0,
                                end_byte=file_obj.file_size - 1,
                                chunk_paths=chunk_paths,
                                file_key=file_key,
                                encryption_service=encryption_service,
                                output_path=temp_file_path,
                                upload_id=upload_id,
                                chunk_size=chunk_size,
                                was_compressed=was_compressed,
                                chunk_info=chunk_info,
                                file_obj=file_obj,
                            )
                            return PreviewDownloadResult(status='ok', temp_file_path=temp_file_path, is_complete=True)

                        logger.info(
                            f"Phase 2 - Detection: "
                            f"{'Fragmented MP4 (fMP4)' if is_fragmented else 'Progressive MP4/MOV'}, "
                            f"moov at offset {moov_offset}"
                        )

                        # --- PHASE 3: ROUTE AND FETCH CONTIGUOUSLY ---
                        if is_fragmented:
                            # Fragmented MP4: Cannot use partial downloads
                            file_size_mb = file_obj.file_size / 1024 / 1024

                            if file_size_mb > 500:
                                logger.info(
                                    f"Large fMP4 file ({file_size_mb:.1f}MB > 500MB hard limit)"
                                )
                                os.unlink(probe_file_path)
                                os.unlink(temp_file_path)
                                return PreviewDownloadResult(
                                    status='failed',
                                    error=f"Fragmented MP4 {file_size_mb:.0f}MB exceeds 500MB hard limit",
                                )

                            # Download full file contiguously
                            logger.info(
                                f"Phase 3 - Fetch: Downloading FULL file contiguously "
                                f"({file_size_mb:.1f}MB, all {total_chunks} chunks)"
                            )

                            await _fetch_contiguous_range(
                                start_byte=0,
                                end_byte=file_obj.file_size - 1,
                                chunk_paths=chunk_paths,
                                file_key=file_key,
                                encryption_service=encryption_service,
                                output_path=temp_file_path,
                                upload_id=upload_id,
                                chunk_size=chunk_size,
                                was_compressed=was_compressed,
                                chunk_info=chunk_info,
                                file_obj=file_obj,
                            )

                            os.unlink(probe_file_path)
                            return PreviewDownloadResult(status='ok', temp_file_path=temp_file_path, is_complete=True)

                        else:
                            # Progressive MP4/MOV: Fetch [0...moov_end+guard] contiguously
                            #
                            # IMPORTANT: moov_offset is relative to the GAPPY probe buffer,
                            # not the actual file! If probe skipped chunks, the buffer offset
                            # doesn't match the file offset.
                            #
                            # If moov is found in the later portion of the probe buffer
                            # (>70% of probe_bytes), it's likely near the END of the actual file.
                            # In this case, we must download the ENTIRE file.

                            moov_near_end_of_probe = moov_offset > (probe_bytes * 0.7)

                            if moov_near_end_of_probe:
                                # moov is in the tail portion - must download entire file
                                # because gappy probe offset doesn't map to actual file offset
                                file_size_mb = file_obj.file_size / MB
                                effective_limit = MAX_BG_CAS_VIDEO_MB if background else MAX_SYNC_FULL_VIDEO_DOWNLOAD_MB
                                if file_size_mb > effective_limit:
                                    logger.info(
                                        f"moov-at-end: {file_obj.file_name} ({file_size_mb:.1f}MB > {effective_limit}MB)"
                                    )
                                    os.unlink(probe_file_path)
                                    os.unlink(temp_file_path)
                                    status = 'failed' if background else 'deferred'
                                    return PreviewDownloadResult(
                                        status=status,
                                        error=f"Video {file_size_mb:.0f}MB exceeds {effective_limit}MB (moov at end)",
                                    )

                                logger.info(
                                    f"Phase 3 - Fetch: moov found late in probe buffer "
                                    f"(offset {moov_offset/1024/1024:.1f}MB in {probe_bytes/1024/1024:.1f}MB probe), "
                                    f"downloading FULL file ({file_obj.file_size/1024/1024:.1f}MB)"
                                )

                                await _fetch_contiguous_range(
                                    start_byte=0,
                                    end_byte=file_obj.file_size - 1,
                                    chunk_paths=chunk_paths,
                                    file_key=file_key,
                                    encryption_service=encryption_service,
                                    output_path=temp_file_path,
                                    upload_id=upload_id,
                                    chunk_size=chunk_size,
                                    was_compressed=was_compressed,
                                    chunk_info=chunk_info,
                                    file_obj=file_obj,
                                )

                                os.unlink(probe_file_path)
                                return PreviewDownloadResult(status='ok', temp_file_path=temp_file_path, is_complete=True)

                            else:
                                # moov is early in the file - safe to use partial download
                                moov_guard = 64 * 1024  # 64KB guard after moov
                                fetch_end = min(moov_offset + 10 * 1024 * 1024, file_obj.file_size - 1)

                                logger.info(
                                    f"Phase 3 - Fetch: Downloading contiguous range "
                                    f"[0...{fetch_end}] ({fetch_end/1024/1024:.1f}MB) "
                                    f"including moov + guard"
                                )

                                await _fetch_contiguous_range(
                                    start_byte=0,
                                    end_byte=fetch_end,
                                    chunk_paths=chunk_paths,
                                    file_key=file_key,
                                    encryption_service=encryption_service,
                                    output_path=temp_file_path,
                                    upload_id=upload_id,
                                    chunk_size=chunk_size,
                                    was_compressed=was_compressed,
                                    chunk_info=chunk_info,
                                    file_obj=file_obj,
                                )

                                os.unlink(probe_file_path)
                                return PreviewDownloadResult(status='ok', temp_file_path=temp_file_path, is_complete=False)

                    except Exception as e:
                        # Cleanup on error
                        if os.path.exists(probe_file_path):
                            os.unlink(probe_file_path)
                        raise

                # Standard approach: download first N chunks only
                # Calculate how many chunks we need
                chunks_needed = max(1, (max_size + chunk_size - 1) // chunk_size)
                chunks_to_download = min(chunks_needed, total_chunks)

                logger.info(
                    f"Downloading {chunks_to_download}/{total_chunks} chunks "
                    f"({chunks_to_download * chunk_size / 1024 / 1024:.1f}MB)"
                )

                downloaded_bytes = 0

                from ..utils.executors import run_in_heavy_pool as _run_heavy_std

                def _std_decrypt_decompress(enc, enc_svc, key, idx, compressed):
                    dec = enc_svc.decrypt_chunk(enc, key, idx)
                    if compressed:
                        from ..utils.compression import compressor
                        dec = compressor.decompress(dec)
                    return dec

                async with aiofiles.open(temp_file_path, 'wb') as temp_f:
                    for i in range(chunks_to_download):
                        # Get chunk path
                        chunk_path = chunk_paths.get(str(i))

                        if not chunk_path:
                            # Fallback: construct path
                            shard = upload_id[:2]
                            chunk_path = f"/app/storage/cache/{shard}/{upload_id}_chunk_{i}.enc"

                        # Read encrypted chunk
                        try:
                            async with aiofiles.open(chunk_path, 'rb') as f:
                                encrypted_chunk = await f.read()
                        except FileNotFoundError:
                            logger.warning(f"Chunk {i} not found at {chunk_path}")
                            break

                        # Decrypt + decompress (offloaded to thread pool)
                        decrypted_chunk = await _run_heavy_std(
                            _std_decrypt_decompress,
                            encrypted_chunk, encryption_service, file_key, i, was_compressed
                        )

                        # Write chunk (but stop if we hit max_size)
                        bytes_to_write = len(decrypted_chunk)
                        if is_partial and downloaded_bytes + bytes_to_write > max_size:
                            # Write only what we need
                            bytes_remaining = max_size - downloaded_bytes
                            await temp_f.write(decrypted_chunk[:bytes_remaining])
                            downloaded_bytes += bytes_remaining
                            break
                        else:
                            await temp_f.write(decrypted_chunk)
                            downloaded_bytes += bytes_to_write
                        await asyncio.sleep(0)  # Yield between chunks

                is_complete = (chunks_to_download >= total_chunks)
                return PreviewDownloadResult(status='ok', temp_file_path=temp_file_path, is_complete=is_complete)

        except Exception as e:
            # Cleanup on error
            if os.path.exists(temp_file_path):
                try:
                    os.remove(temp_file_path)
                except:
                    pass
            raise

    async def download_full_file_for_transcode(
        self, file_obj, encryption_service, db=None
    ) -> str:
        """
        Download and decrypt the entire file to a temp path for transcoding.

        Returns:
            Path to decrypted temp file.
        """
        temp_fd, temp_file_path = tempfile.mkstemp()
        os.close(temp_fd)

        try:
            resolved_obj = file_obj

            file_key = encryption_service.decrypt_key(resolved_obj.encryption_key)
            was_compressed = False
            if resolved_obj.file_metadata and isinstance(resolved_obj.file_metadata, dict):
                was_compressed = resolved_obj.file_metadata.get("compressed", False)
            elif resolved_obj.chunk_info and isinstance(resolved_obj.chunk_info, dict):
                was_compressed = resolved_obj.chunk_info.get("compressed", False)

            if resolved_obj.storage_type == "inline":
                encrypted_data = base64.b64decode(resolved_obj.storage_key)
                decrypted = encryption_service.decrypt_file(encrypted_data, file_key)
                if was_compressed:
                    from ..utils.compression import compressor
                    decrypted = compressor.decompress(decrypted)
                async with aiofiles.open(temp_file_path, 'wb') as f:
                    await f.write(decrypted)
                return temp_file_path

            if resolved_obj.storage_type == "single":
                async with aiofiles.open(resolved_obj.object_path, 'rb') as src:
                    encrypted_data = await src.read()
                decrypted = encryption_service.decrypt_file(encrypted_data, file_key)
                if was_compressed:
                    from ..utils.compression import compressor
                    decrypted = compressor.decompress(decrypted)
                async with aiofiles.open(temp_file_path, 'wb') as dest:
                    await dest.write(decrypted)
                return temp_file_path

            if resolved_obj.storage_type in ("chunked", "content_addressed"):
                chunk_info = resolved_obj.chunk_info
                if not chunk_info:
                    raise ValueError("Chunk info not found for chunked file")

                upload_id = chunk_info.get("upload_id", str(resolved_obj.id))
                chunk_paths = chunk_info.get("paths", {})
                chunk_size = chunk_info.get("chunk_size", 32 * 1024 * 1024)

                await _fetch_contiguous_range(
                    start_byte=0,
                    end_byte=resolved_obj.file_size - 1,
                    chunk_paths=chunk_paths,
                    file_key=file_key,
                    encryption_service=encryption_service,
                    output_path=temp_file_path,
                    upload_id=upload_id,
                    chunk_size=chunk_size,
                    was_compressed=was_compressed,
                    chunk_info=chunk_info,
                    file_obj=resolved_obj,
                )
                return temp_file_path

            raise ValueError(f"Unsupported storage type for transcoding: {resolved_obj.storage_type}")

        except Exception as exc:
            if os.path.exists(temp_file_path):
                try:
                    os.remove(temp_file_path)
                except OSError:
                    pass
            raise exc


# Global instance
preview_optimizer = PreviewOptimizer()
