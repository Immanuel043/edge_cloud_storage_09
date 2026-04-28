"""
Example integration of Rust data plane with FastAPI upload endpoint.

This demonstrates how to replace the existing Python ThreadPool processing
with the high-performance Rust service.
"""

import hashlib
import logging
import os
from typing import Optional

from .rust_dataplane_client import get_rust_client

logger = logging.getLogger(__name__)


# Feature flag for gradual rollout
RUST_DATAPLANE_ENABLED = os.getenv("RUST_DATAPLANE_ENABLED", "false").lower() == "true"
RUST_DATAPLANE_ROLLOUT_PERCENTAGE = int(os.getenv("RUST_DATAPLANE_ROLLOUT_PERCENTAGE", "0"))


def should_use_rust_dataplane(user_id: str) -> bool:
    """
    Determine if request should use Rust data plane based on rollout percentage.

    Uses hash-based deterministic routing for consistent user experience.

    Args:
        user_id: User identifier

    Returns:
        True if should use Rust, False for Python fallback
    """
    if not RUST_DATAPLANE_ENABLED:
        return False

    # Hash-based rollout (deterministic per user)
    user_hash = int(hashlib.md5(user_id.encode()).hexdigest()[:8], 16)
    return (user_hash % 100) < RUST_DATAPLANE_ROLLOUT_PERCENTAGE


async def process_chunk_rust(
    chunk_data: bytes,
    file_key: bytes,
    chunk_index: int,
    compress: bool,
    file_id: str,
    filename: Optional[str] = None,
    file_size: Optional[int] = None,
) -> tuple[bytes, str]:
    """
    Process chunk using Rust data plane (replacement for process_chunk_cpu_bound).

    This function can be used as a drop-in replacement for the existing
    Python ThreadPool processing in upload.py.

    Args:
        chunk_data: Raw chunk data
        file_key: Encryption key (32 bytes)
        chunk_index: Chunk index
        compress: Whether to compress
        file_id: File identifier
        filename: Original filename
        file_size: Total file size

    Returns:
        Tuple of (encrypted_chunk_data, original_hash)
    """
    client = get_rust_client()

    # TODO: In production, pass file_key via memfd + SCM_RIGHTS
    # For now, we'll use a placeholder key_fd
    # This would be: fd = create_memfd_with_key(file_key)
    key_fd = None  # Placeholder

    try:
        result = await client.process_non_zk_chunk(
            chunk_data=chunk_data,
            file_id=file_id,
            chunk_index=chunk_index,
            compress=compress,
            filename=filename,
            file_size=file_size,
            key_fd=key_fd,
        )

        # Extract original hash
        original_hash = result["hash"]

        # In production, encrypted chunk is stored by Rust service
        # For compatibility with existing code, we'd need to read it back
        # or modify the upload flow to not expect encrypted data returned
        # For now, return empty bytes as placeholder
        encrypted_chunk = b""  # Placeholder - chunk is stored by Rust

        logger.info(
            f"Chunk processed by Rust: file_id={file_id}, "
            f"chunk={chunk_index}, hash={original_hash}"
        )

        return encrypted_chunk, original_hash

    except Exception as e:
        logger.error(f"Rust processing failed, falling back to Python: {e}")
        # Re-raise to allow caller to handle fallback
        raise


async def process_chunk_zk_rust(
    chunk_data: bytes,
    chunk_index: int,
    file_id: str,
) -> str:
    """
    Process chunk in ZK mode using Rust data plane.

    Args:
        chunk_data: Pre-encrypted chunk data
        chunk_index: Chunk index
        file_id: File identifier

    Returns:
        Content hash of chunk
    """
    client = get_rust_client()

    try:
        result = await client.process_zk_chunk(
            chunk_data=chunk_data,
            file_id=file_id,
            chunk_index=chunk_index,
        )

        content_hash = result["hash"]

        logger.info(
            f"ZK chunk processed by Rust: file_id={file_id}, "
            f"chunk={chunk_index}, hash={content_hash}"
        )

        return content_hash

    except Exception as e:
        logger.error(f"Rust ZK processing failed: {e}")
        raise


# Example integration in upload.py would look like:
"""
# In upload.py around line 156-169

from .services.rust_integration_example import (
    should_use_rust_dataplane,
    process_chunk_rust,
)

# ... in upload_chunk handler ...

if should_use_rust_dataplane(str(current_user.id)):
    # Use Rust data plane
    try:
        encrypted_chunk, original_hash = await process_chunk_rust(
            chunk_data=chunk_data,
            file_key=file_key,
            chunk_index=chunk_index,
            compress=use_compression,
            file_id=upload_id,
            filename=session.get("filename"),
            file_size=session.get("file_size"),
        )
    except Exception as e:
        # Fallback to Python on error
        logger.warning(f"Falling back to Python processing: {e}")
        encrypted_chunk, original_hash = await loop.run_in_executor(
            executor,
            process_chunk_cpu_bound,
            chunk_data,
            file_key,
            chunk_index,
            use_compression,
        )
else:
    # Use existing Python ThreadPool
    encrypted_chunk, original_hash = await loop.run_in_executor(
        executor,
        process_chunk_cpu_bound,
        chunk_data,
        file_key,
        chunk_index,
        use_compression,
    )
"""
