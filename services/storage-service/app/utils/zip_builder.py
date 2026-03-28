"""
Shared ZIP builder utility for bundle and folder downloads.

Strategy:
- total_size < MEMORY_THRESHOLD (500 MB): build ZIP in memory (fast, no disk I/O)
- total_size >= MEMORY_THRESHOLD: build ZIP to a temp file on disk, stream back

Both paths return a FastAPI Response with correct Content-Length.
"""

import io
import os
import base64
import zipfile
import tempfile
import logging
from typing import List, Tuple, Optional
from fastapi.responses import Response, FileResponse
from starlette.background import BackgroundTask

logger = logging.getLogger(__name__)

MEMORY_THRESHOLD = 500 * 1024 * 1024  # 500 MB


class ZipFileEntry:
    """Represents a single file to be added to the ZIP."""

    __slots__ = ("file_obj", "zip_path")

    def __init__(self, file_obj, zip_path: str):
        self.file_obj = file_obj
        self.zip_path = zip_path


async def _read_file_content(file_obj, encryption_service) -> Optional[bytes]:
    """Read, decrypt, and decompress a single file. Returns None on failure."""
    try:
        file_key = encryption_service.decrypt_key(file_obj.encryption_key)

        if file_obj.storage_type == "inline":
            encrypted_data = base64.b64decode(file_obj.storage_key)
            content = encryption_service.decrypt_file(encrypted_data, file_key)
        elif file_obj.storage_type == "single" and file_obj.object_path and os.path.exists(file_obj.object_path):
            with open(file_obj.object_path, "rb") as f:
                encrypted_data = f.read()
            content = encryption_service.decrypt_file(encrypted_data, file_key)
        elif file_obj.storage_type == "chunked":
            # For chunked files, reassemble from chunks
            content = await _read_chunked_file(file_obj, file_key, encryption_service)
            if content is None:
                return None
        else:
            logger.warning(f"Skipping file {file_obj.id} — unsupported storage type '{file_obj.storage_type}'")
            return None

        # Handle compression
        if file_obj.file_metadata and isinstance(file_obj.file_metadata, dict) and file_obj.file_metadata.get("compressed", False):
            from .compression import compressor
            content = compressor.decompress(content)

        return content
    except Exception as e:
        logger.error(f"Error reading file {file_obj.id}: {e}")
        return None


async def _read_chunked_file(file_obj, file_key, encryption_service) -> Optional[bytes]:
    """Reassemble a chunked (CAS) file into a single bytes buffer."""
    try:
        chunk_info = file_obj.chunk_info or {}
        blocks = chunk_info.get("blocks", [])
        stored_blocks = chunk_info.get("stored_blocks", {})

        if not blocks or not stored_blocks:
            logger.warning(f"Skipping chunked file {file_obj.id} — no block info")
            return None

        parts = []
        for block_hash in blocks:
            block_meta = stored_blocks.get(block_hash)
            if not block_meta:
                logger.warning(f"Missing block {block_hash} for file {file_obj.id}")
                return None

            block_path = block_meta.get("path")
            if not block_path or not os.path.exists(block_path):
                logger.warning(f"Block path missing/not found: {block_path} for file {file_obj.id}")
                return None

            with open(block_path, "rb") as bf:
                encrypted_block = bf.read()

            # Decrypt block
            decrypted = encryption_service.decrypt_file(encrypted_block, file_key)

            # Decompress block if needed
            if block_meta.get("compressed", False):
                from .compression import compressor
                decrypted = compressor.decompress(decrypted)

            parts.append(decrypted)

        return b"".join(parts)
    except Exception as e:
        logger.error(f"Error reassembling chunked file {file_obj.id}: {e}")
        return None


async def build_zip_response(
    entries: List[ZipFileEntry],
    encryption_service,
    zip_filename: str,
) -> Response:
    """
    Build a ZIP from the given file entries and return a FastAPI Response.

    Uses in-memory buffer for small total sizes, temp file for large ones.
    """
    # Estimate total size from file metadata
    total_size = sum(getattr(e.file_obj, "file_size", 0) or 0 for e in entries)

    if total_size < MEMORY_THRESHOLD:
        return await _build_zip_in_memory(entries, encryption_service, zip_filename)
    else:
        return await _build_zip_on_disk(entries, encryption_service, zip_filename)


async def _build_zip_in_memory(
    entries: List[ZipFileEntry],
    encryption_service,
    zip_filename: str,
) -> Response:
    """Build ZIP in an in-memory BytesIO buffer."""
    zip_buffer = io.BytesIO()
    files_added = 0

    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for entry in entries:
            content = await _read_file_content(entry.file_obj, encryption_service)
            if content is not None:
                zf.writestr(entry.zip_path, content)
                files_added += 1
                # Free content immediately
                del content

    zip_bytes = zip_buffer.getvalue()
    zip_buffer.close()

    if files_added == 0:
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail="Failed to create ZIP — no files could be processed")

    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{zip_filename}"',
            "Content-Length": str(len(zip_bytes)),
        },
    )


async def _build_zip_on_disk(
    entries: List[ZipFileEntry],
    encryption_service,
    zip_filename: str,
) -> Response:
    """Build ZIP to a temp file on disk, then stream it back."""
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".zip")
    files_added = 0

    try:
        with os.fdopen(tmp_fd, "wb") as tmp_file:
            with zipfile.ZipFile(tmp_file, "w", zipfile.ZIP_DEFLATED) as zf:
                for entry in entries:
                    content = await _read_file_content(entry.file_obj, encryption_service)
                    if content is not None:
                        zf.writestr(entry.zip_path, content)
                        files_added += 1
                        del content

        if files_added == 0:
            from fastapi import HTTPException
            raise HTTPException(status_code=500, detail="Failed to create ZIP — no files could be processed")

        zip_size = os.path.getsize(tmp_path)
        logger.info(f"Built ZIP on disk: {zip_filename} ({zip_size} bytes, {files_added} files)")

        return FileResponse(
            path=tmp_path,
            media_type="application/zip",
            filename=zip_filename,
            background=BackgroundTask(_cleanup_temp_file, tmp_path),
        )
    except Exception:
        # Clean up on error
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise


def _cleanup_temp_file(path: str):
    """Delete temp file after response is sent."""
    try:
        if os.path.exists(path):
            os.unlink(path)
            logger.debug(f"Cleaned up temp ZIP: {path}")
    except OSError as e:
        logger.warning(f"Failed to clean up temp ZIP {path}: {e}")
