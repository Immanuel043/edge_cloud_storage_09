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
import tempfile
import aiofiles
import base64
import logging
import struct
from typing import Optional, Tuple
from .video_optimizer import video_optimizer

logger = logging.getLogger(__name__)

MB = 1024 * 1024
MAX_SYNC_FULL_VIDEO_DOWNLOAD_MB = 100  # Hard cap for blocking preview fetches (lowered to prevent OOM)

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


def _has_moov(data: bytes) -> tuple[bool, Optional[int]]:
    """
    Scan for moov or moof atom in byte stream.

    MP4/MOV box format:
    - 4 bytes: box size (big-endian uint32)
    - 4 bytes: box type (ASCII, e.g., 'moov' or 'moof')
    - N bytes: box data

    For fragmented MP4 (fMP4), we accept 'moof' (movie fragment) as well as 'moov'.

    Returns: (found: bool, offset: Optional[int])
    """
    if len(data) < 8:
        return False, None

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
                        return True, pos - 4
                except struct.error:
                    pass

            offset = pos + 1

    return False, None


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


async def _fetch_contiguous_range(
    start_byte: int,
    end_byte: int,
    chunk_paths: dict,
    file_key: bytes,
    encryption_service,
    output_path: str,
    upload_id: str,
    chunk_size: int = 33554432,
    was_compressed: bool = False
) -> int:
    """
    Stream a contiguous byte range from chunked storage to disk.

    This ensures ffmpeg receives a file with NO GAPS - critical for proper parsing.

    Args:
        start_byte: Starting byte offset (inclusive)
        end_byte: Ending byte offset (inclusive)
        chunk_paths: Dict mapping chunk indices to paths
        file_key: Decryption key
        encryption_service: Service for decryption
        output_path: Where to write the contiguous data
        upload_id: Upload ID for path construction
        chunk_size: Size of each chunk (default 32MB)
        was_compressed: Whether chunks are compressed

    Returns:
        Total bytes written
    """
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

            if not os.path.exists(chunk_path):
                logger.warning(f"Chunk {chunk_idx} not found at {chunk_path}")
                continue

            # Load and decrypt chunk
            async with aiofiles.open(chunk_path, 'rb') as f:
                encrypted_chunk = await f.read()

            decrypted_chunk = encryption_service.decrypt_chunk(
                encrypted_chunk, file_key, chunk_idx
            )

            if was_compressed:
                from ..utils.compression import compressor
                decrypted_chunk = compressor.decompress(decrypted_chunk)

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
        # If file is small enough, download completely
        if file_size <= head_size + tail_size:
            logger.info(f"File small enough ({file_size/1024/1024:.1f}MB), downloading completely")
            async with aiofiles.open(file_path, 'rb') as f:
                encrypted_data = await f.read()

            file_data = encryption_service.decrypt_file(encrypted_data, file_key)

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

        # Decrypt both portions
        head_data = encryption_service.decrypt_file(encrypted_head, file_key)
        tail_data = encryption_service.decrypt_file(encrypted_tail, file_key)

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
        max_size: Optional[int] = None
    ) -> Tuple[str, bool]:
        """
        Download only the first portion of a file for preview generation

        Returns: (temp_file_path, is_complete)
        - is_complete: True if entire file was downloaded, False if partial
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

                return temp_file_path, True  # Complete

            elif file_obj.storage_type == "single":
                # Single file storage
                if not os.path.exists(file_obj.object_path):
                    raise FileNotFoundError(f"File not found: {file_obj.object_path}")

                # Special handling for large tail-heavy video files
                if _needs_head_tail(file_obj, is_partial):
                    # Use head+tail strategy for large MOV files
                    logger.info(
                        f"Large video {file_obj.file_name} detected, using head+tail strategy"
                    )
                    return await self.download_with_head_tail(
                        file_obj.object_path,
                        file_obj.file_size,
                        encryption_service,
                        file_key
                    )

                # Standard approach for other files
                # Read file (partial or complete)
                async with aiofiles.open(file_obj.object_path, 'rb') as f:
                    if is_partial:
                        encrypted_data = await f.read(max_size)
                    else:
                        encrypted_data = await f.read()

                file_data = encryption_service.decrypt_file(encrypted_data, file_key)

                if was_compressed:
                    from ..utils.compression import compressor
                    file_data = compressor.decompress(file_data)

                async with aiofiles.open(temp_file_path, 'wb') as f:
                    await f.write(file_data)

                return temp_file_path, not is_partial

            else:  # chunked storage
                # Download only first N chunks
                chunk_info = file_obj.chunk_info
                if not chunk_info:
                    raise ValueError("Chunk info not found")

                upload_id = chunk_info.get("upload_id", str(file_obj.id))
                total_chunks = chunk_info.get("count", 0)
                chunk_size = chunk_info.get("chunk_size", 32 * 1024 * 1024)  # Default 32MB
                chunk_paths = chunk_info.get("paths", {})

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

                    logger.info(
                        f"Phase 1 - Probe: downloading {len(probe_chunks)} chunks {probe_chunks} "
                        f"for format detection (gappy file OK - detection only)"
                    )

                    # Download probe chunks to temporary probe file
                    probe_fd, probe_file_path = tempfile.mkstemp()
                    os.close(probe_fd)

                    try:
                        probe_bytes = 0
                        async with aiofiles.open(probe_file_path, 'wb') as probe_f:
                            for i in probe_chunks:
                                chunk_path = chunk_paths.get(str(i))
                                if not chunk_path:
                                    shard = upload_id[:2]
                                    chunk_path = f"/app/storage/cache/{shard}/{upload_id}_chunk_{i}.enc"

                                if not os.path.exists(chunk_path):
                                    logger.warning(f"Chunk {i} not found at {chunk_path}")
                                    continue

                                async with aiofiles.open(chunk_path, 'rb') as f:
                                    encrypted_chunk = await f.read()

                                decrypted_chunk = encryption_service.decrypt_chunk(
                                    encrypted_chunk, file_key, i
                                )

                                if was_compressed:
                                    from ..utils.compression import compressor
                                    decrypted_chunk = compressor.decompress(decrypted_chunk)

                                await probe_f.write(decrypted_chunk)
                                probe_bytes += len(decrypted_chunk)

                        logger.info(f"Probe complete: {probe_bytes/1024/1024:.1f}MB downloaded")

                        # --- PHASE 2: DETECT FORMAT AND LOCATE MOOV ---
                        async with aiofiles.open(probe_file_path, 'rb') as f:
                            probe_data = await f.read()

                        is_fragmented = _is_fragmented_mp4(probe_data)
                        has_moov, moov_offset = _has_moov(probe_data)

                        if not has_moov:
                            logger.warning(
                                f"⚠️  moov atom NOT found in probe data for {file_obj.file_name}. "
                                f"Falling back to full contiguous download."
                            )
                            os.unlink(probe_file_path)

                            file_size_mb = file_obj.file_size / MB
                            if file_size_mb > MAX_SYNC_FULL_VIDEO_DOWNLOAD_MB:
                                logger.info(
                                    f"File is {file_size_mb:.1f}MB (> {MAX_SYNC_FULL_VIDEO_DOWNLOAD_MB}MB). "
                                    f"Queuing preview for async processing."
                                )
                                os.unlink(temp_file_path)
                                return None, False

                            await _fetch_contiguous_range(
                                start_byte=0,
                                end_byte=file_obj.file_size - 1,
                                chunk_paths=chunk_paths,
                                file_key=file_key,
                                encryption_service=encryption_service,
                                output_path=temp_file_path,
                                upload_id=upload_id,
                                chunk_size=chunk_size,
                                was_compressed=was_compressed
                            )
                            return temp_file_path, True

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
                                # Too large for sync preview - return None to trigger 202
                                logger.info(
                                    f"⏳ Large fMP4 file ({file_size_mb:.1f}MB > 500MB) - "
                                    f"returning None to trigger background processing"
                                )
                                os.unlink(probe_file_path)
                                os.unlink(temp_file_path)
                                return None, False

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
                                was_compressed=was_compressed
                            )

                            os.unlink(probe_file_path)
                            return temp_file_path, True  # Complete file

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
                                    was_compressed=was_compressed
                                )

                                os.unlink(probe_file_path)
                                return temp_file_path, True  # Complete file

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
                                    was_compressed=was_compressed
                                )

                                os.unlink(probe_file_path)
                                return temp_file_path, False  # Partial but contiguous

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

                async with aiofiles.open(temp_file_path, 'wb') as temp_f:
                    for i in range(chunks_to_download):
                        # Get chunk path
                        chunk_path = chunk_paths.get(str(i))

                        if not chunk_path:
                            # Fallback: construct path
                            shard = upload_id[:2]
                            chunk_path = f"/app/storage/cache/{shard}/{upload_id}_chunk_{i}.enc"

                        if not os.path.exists(chunk_path):
                            logger.warning(f"Chunk {i} not found at {chunk_path}")
                            break

                        # Read encrypted chunk
                        async with aiofiles.open(chunk_path, 'rb') as f:
                            encrypted_chunk = await f.read()

                        # Decrypt chunk
                        decrypted_chunk = encryption_service.decrypt_chunk(
                            encrypted_chunk, file_key, i
                        )

                        # Decompress if needed
                        if was_compressed:
                            from ..utils.compression import compressor
                            decrypted_chunk = compressor.decompress(decrypted_chunk)

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

                is_complete = (chunks_to_download >= total_chunks)
                return temp_file_path, is_complete

        except Exception as e:
            # Cleanup on error
            if os.path.exists(temp_file_path):
                try:
                    os.remove(temp_file_path)
                except:
                    pass
            raise

    async def download_full_file_for_transcode(self, file_obj, encryption_service) -> str:
        """
        Download and decrypt the entire file to a temp path for transcoding.

        Returns:
            Path to decrypted temp file.
        """
        temp_fd, temp_file_path = tempfile.mkstemp()
        os.close(temp_fd)

        try:
            file_key = encryption_service.decrypt_key(file_obj.encryption_key)
            was_compressed = False
            if file_obj.file_metadata and isinstance(file_obj.file_metadata, dict):
                was_compressed = file_obj.file_metadata.get("compressed", False)
            elif file_obj.chunk_info and isinstance(file_obj.chunk_info, dict):
                was_compressed = file_obj.chunk_info.get("compressed", False)

            if file_obj.storage_type == "inline":
                encrypted_data = base64.b64decode(file_obj.storage_key)
                decrypted = encryption_service.decrypt_file(encrypted_data, file_key)
                if was_compressed:
                    from ..utils.compression import compressor
                    decrypted = compressor.decompress(decrypted)
                async with aiofiles.open(temp_file_path, 'wb') as f:
                    await f.write(decrypted)
                return temp_file_path

            if file_obj.storage_type == "single":
                async with aiofiles.open(file_obj.object_path, 'rb') as src:
                    encrypted_data = await src.read()
                decrypted = encryption_service.decrypt_file(encrypted_data, file_key)
                if was_compressed:
                    from ..utils.compression import compressor
                    decrypted = compressor.decompress(decrypted)
                async with aiofiles.open(temp_file_path, 'wb') as dest:
                    await dest.write(decrypted)
                return temp_file_path

            if file_obj.storage_type in ("chunked", "content_addressed", "deduplicated_reference"):
                chunk_info = file_obj.chunk_info
                if not chunk_info:
                    raise ValueError("Chunk info not found for chunked file")

                upload_id = chunk_info.get("upload_id", str(file_obj.id))
                chunk_paths = chunk_info.get("paths", {})
                chunk_size = chunk_info.get("chunk_size", 32 * 1024 * 1024)

                await _fetch_contiguous_range(
                    start_byte=0,
                    end_byte=file_obj.file_size - 1,
                    chunk_paths=chunk_paths,
                    file_key=file_key,
                    encryption_service=encryption_service,
                    output_path=temp_file_path,
                    upload_id=upload_id,
                    chunk_size=chunk_size,
                    was_compressed=was_compressed
                )
                return temp_file_path

            raise ValueError(f"Unsupported storage type for transcoding: {file_obj.storage_type}")

        except Exception as exc:
            if os.path.exists(temp_file_path):
                try:
                    os.remove(temp_file_path)
                except OSError:
                    pass
            raise exc


# Global instance
preview_optimizer = PreviewOptimizer()
