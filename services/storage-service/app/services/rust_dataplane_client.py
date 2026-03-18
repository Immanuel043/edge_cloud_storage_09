"""
Rust Data Plane Client for FastAPI Integration

This client communicates with the Rust data plane service over Unix Domain Socket
for high-performance chunk processing (encryption, compression, storage).
"""

import os
import time
import json
import socket
import asyncio
import base64
from typing import Optional, Dict, Any, AsyncGenerator
from urllib.parse import quote
import httpx
from httpx import AsyncClient, Timeout
import logging

logger = logging.getLogger(__name__)


class RustDataPlaneClient:
    """
    Client for communicating with the Rust data plane service.

    Features:
    - Unix Domain Socket communication for low latency
    - Non-ZK mode: Server-side encryption and compression
    - ZK mode: Hash-only processing (client-side encrypted)
    - Automatic connection pooling and retry
    """

    def __init__(
        self,
        socket_path: str = "/tmp/edge-storage-dataplane.sock",
        timeout: float = 30.0,
        max_retries: int = 3,
    ):
        """
        Initialize the Rust data plane client.

        Args:
            socket_path: Path to Unix domain socket
            timeout: Request timeout in seconds
            max_retries: Maximum number of retries on failure
        """
        self.socket_path = socket_path
        self.timeout = Timeout(timeout)
        self.max_retries = max_retries

        # Create transport for Unix socket
        self.transport = httpx.AsyncHTTPTransport(uds=socket_path)
        self.client = AsyncClient(
            transport=self.transport,
            timeout=self.timeout,
            base_url="http://localhost",  # Required but not used for UDS
        )

        # Cached health-check result (avoids per-request latency)
        self._health_ok: bool = False
        self._health_checked_at: float = 0.0
        self._health_cache_ttl: float = 5.0  # seconds

        logger.info(f"Initialized Rust data plane client: socket={socket_path}")

    async def __aenter__(self):
        """Async context manager entry."""
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit."""
        await self.close()

    async def close(self):
        """Close the client and cleanup resources."""
        await self.client.aclose()

    async def health_check(self) -> Dict[str, Any]:
        """
        Check if the Rust service is healthy.

        Returns:
            Health status response

        Raises:
            Exception: If service is unavailable
        """
        try:
            response = await self.client.get("/health")
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logger.error(f"Health check failed: {e}")
            raise

    async def process_non_zk_chunk(
        self,
        chunk_data: bytes,
        file_id: str,
        chunk_index: int,
        compress: bool = False,
        filename: Optional[str] = None,
        file_size: Optional[int] = None,
        key_fd: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Process a chunk in Non-ZK mode (server-side encryption).

        Args:
            chunk_data: Raw chunk data to process
            file_id: File identifier for storage path
            chunk_index: Index of this chunk
            compress: Whether to compress the chunk
            filename: Original filename (for format detection)
            file_size: Total file size (for format detection)
            key_fd: File descriptor for encryption key (via SCM_RIGHTS)

        Returns:
            Response containing:
            - success: Whether operation succeeded
            - hash: SHA-256 hash of original data
            - original_size: Size before processing
            - encrypted_size: Size after encryption
            - compressed: Whether compression was applied
            - compression_ratio: Compression ratio if compressed

        Raises:
            httpx.HTTPStatusError: On HTTP error
            Exception: On processing failure
        """
        headers = {
            "x-mode": "non-zk",
            "x-file-id": file_id,
            "x-chunk-index": str(chunk_index),
            "x-should-compress": str(compress).lower(),
        }

        if filename:
            headers["x-filename"] = filename

        if file_size is not None:
            headers["x-file-size"] = str(file_size)

        # TODO: In production, pass key_fd via SCM_RIGHTS ancillary data
        # For now, we pass it as a header (placeholder)
        if key_fd is not None:
            headers["x-file-key-fd"] = str(key_fd)

        try:
            response = await self.client.post(
                "/upload",
                content=chunk_data,
                headers=headers,
            )
            response.raise_for_status()
            result = response.json()

            logger.debug(
                f"Non-ZK chunk processed: file_id={file_id}, "
                f"chunk={chunk_index}, size={len(chunk_data)}, "
                f"compressed={result.get('compressed', False)}"
            )

            return result

        except httpx.HTTPStatusError as e:
            logger.error(
                f"Non-ZK chunk processing failed: {e.response.status_code} - {e.response.text}"
            )
            raise
        except Exception as e:
            logger.error(f"Non-ZK chunk processing error: {e}")
            raise

    async def process_hash_only(
        self,
        chunk_data: bytes,
        file_id: str,
        chunk_index: int,
    ) -> Dict[str, Any]:
        """
        Process a chunk in hash-only mode (hybrid Rust processing).

        Used in hybrid mode where Rust handles hashing and Python handles
        compression + encryption. Delegates to the ZK endpoint which
        performs hash-only processing without server-side encryption.

        Args:
            chunk_data: Raw chunk data to hash
            file_id: File identifier for storage path
            chunk_index: Index of this chunk

        Returns:
            Response containing:
            - success: Whether operation succeeded
            - hash: SHA-256 hash of chunk data

        Raises:
            httpx.HTTPStatusError: On HTTP error
            Exception: On processing failure
        """
        return await self.process_zk_chunk(
            chunk_data=chunk_data,
            file_id=file_id,
            chunk_index=chunk_index,
        )

    async def process_zk_chunk(
        self,
        chunk_data: bytes,
        file_id: str,
        chunk_index: int,
    ) -> Dict[str, Any]:
        """
        Process a chunk in ZK mode (hash-only, no server-side encryption).

        Args:
            chunk_data: Pre-encrypted chunk data
            file_id: File identifier for storage path
            chunk_index: Index of this chunk

        Returns:
            Response containing:
            - success: Whether operation succeeded
            - hash: SHA-256 hash of chunk data

        Raises:
            httpx.HTTPStatusError: On HTTP error (403 if key leaked)
            Exception: On processing failure
        """
        headers = {
            "x-mode": "zk",
            "x-file-id": file_id,
            "x-chunk-index": str(chunk_index),
        }

        try:
            response = await self.client.post(
                "/upload",
                content=chunk_data,
                headers=headers,
            )
            response.raise_for_status()
            result = response.json()

            logger.debug(
                f"ZK chunk processed: file_id={file_id}, "
                f"chunk={chunk_index}, size={len(chunk_data)}"
            )

            return result

        except httpx.HTTPStatusError as e:
            if e.response.status_code == 403:
                logger.error("ZK mode security violation: encryption key leaked")
            else:
                logger.error(
                    f"ZK chunk processing failed: {e.response.status_code} - {e.response.text}"
                )
            raise
        except Exception as e:
            logger.error(f"ZK chunk processing error: {e}")
            raise

    async def download_chunk(
        self,
        file_id: str,
        chunk_index: int,
        mode: str = "non-zk",
        was_compressed: bool = False,
        key_fd: Optional[int] = None,
    ) -> bytes:
        """
        Download and decrypt a chunk.

        Args:
            file_id: File identifier
            chunk_index: Index of chunk to download
            mode: Processing mode ("zk" or "non-zk")
            was_compressed: Whether chunk was compressed during upload
            key_fd: File descriptor for decryption key (non-zk mode)

        Returns:
            Decrypted chunk data

        Raises:
            httpx.HTTPStatusError: On HTTP error
            Exception: On download failure
        """
        headers = {
            "x-mode": mode,
            "x-file-id": file_id,
            "x-chunk-index": str(chunk_index),
            "x-was-compressed": str(was_compressed).lower(),
        }

        if key_fd is not None and mode == "non-zk":
            headers["x-file-key-fd"] = str(key_fd)

        try:
            response = await self.client.get(
                "/download",
                headers=headers,
            )
            response.raise_for_status()

            logger.debug(
                f"Chunk downloaded: file_id={file_id}, "
                f"chunk={chunk_index}, size={len(response.content)}"
            )

            return response.content

        except httpx.HTTPStatusError as e:
            logger.error(
                f"Chunk download failed: {e.response.status_code} - {e.response.text}"
            )
            raise
        except Exception as e:
            logger.error(f"Chunk download error: {e}")
            raise

    async def is_available(self) -> bool:
        """Check if the Rust data plane is reachable (cached for 5s)."""
        now = time.monotonic()
        if now - self._health_checked_at < self._health_cache_ttl:
            return self._health_ok
        try:
            await self.health_check()
            self._health_ok = True
        except Exception:
            self._health_ok = False
        self._health_checked_at = now
        return self._health_ok

    async def stream_download_chunks(
        self,
        chunks: list,
        file_key: bytes,
        was_compressed: bool,
        start_byte: int,
        end_byte: int,
        chunk_size: int,
    ) -> AsyncGenerator[bytes, None]:
        """Stream decrypted plaintext from the Rust /stream-download endpoint."""
        headers = {
            "x-file-key": base64.b64encode(file_key).decode("ascii"),
            "x-was-compressed": "true" if was_compressed else "false",
            "content-type": "application/json",
        }
        body = {
            "chunks": chunks,
            "start_byte": start_byte,
            "end_byte": end_byte,
            "chunk_size": chunk_size,
        }

        async with self.client.stream(
            "POST",
            "/stream-download",
            json=body,
            headers=headers,
            timeout=Timeout(120.0),
        ) as response:
            response.raise_for_status()
            async for chunk in response.aiter_bytes(chunk_size=1024 * 1024):
                yield chunk

    async def convergent_decrypt(
        self,
        encrypted_data: bytes,
        block_hash: str,
        user_id: str,
        was_compressed: bool = False,
    ) -> bytes:
        """Decrypt a CAS block via Rust data plane (PBKDF2 + AES-GCM)."""
        headers = {
            "x-block-hash": block_hash,
            "x-user-id": user_id,
            "x-was-compressed": "true" if was_compressed else "false",
        }

        try:
            response = await self.client.post(
                "/convergent-decrypt",
                content=encrypted_data,
                headers=headers,
            )
            response.raise_for_status()

            logger.debug(
                "Convergent decrypt via Rust: hash=%s plaintext_size=%s",
                block_hash[:12],
                response.headers.get("x-plaintext-size", "?"),
            )
            return response.content

        except httpx.HTTPStatusError as e:
            logger.error(
                "Convergent decrypt Rust call failed: %d - %s",
                e.response.status_code,
                e.response.text,
            )
            raise
        except Exception as e:
            logger.error("Convergent decrypt Rust call error: %s", e)
            raise

    async def dedup_chunk(
        self,
        block_data: bytes,
        block_hash: str,
        user_id: str,
        cas_path: str,
        should_compress: bool = True,
    ) -> Dict[str, Any]:
        """
        Process a dedup block via Rust convergent encryption.

        The Rust data plane derives the encryption key from the block content +
        user salt (PBKDF2), compresses, encrypts, and atomically writes to the
        CAS path.

        Args:
            block_data: Raw block bytes.
            block_hash: Hex SHA-256 of block_data (pre-verified by caller).
            user_id: User ID for salt derivation.
            cas_path: Absolute destination path in the CAS store.
            should_compress: Whether to attempt Zstd compression.

        Returns:
            Dict with ``success``, ``encrypted_size``, ``was_compressed``,
            ``compression_ratio``.
        """
        headers = {
            "x-block-hash": block_hash,
            "x-user-id": user_id,
            "x-cas-path": cas_path,
            "x-should-compress": "true" if should_compress else "false",
        }

        try:
            response = await self.client.post(
                "/dedup-chunk",
                content=block_data,
                headers=headers,
            )
            response.raise_for_status()
            result = response.json()

            logger.debug(
                "Dedup chunk processed via Rust: hash=%s enc_size=%d compressed=%s",
                block_hash[:12],
                result.get("encrypted_size", 0),
                result.get("was_compressed", False),
            )
            return result

        except httpx.HTTPStatusError as e:
            logger.error(
                "Dedup chunk Rust call failed: %d - %s",
                e.response.status_code,
                e.response.text,
            )
            raise
        except Exception as e:
            logger.error("Dedup chunk Rust call error: %s", e)
            raise

    async def dedup_chunk_batch(
        self,
        blocks: list,
        user_id: str,
        should_compress: bool = True,
    ) -> Dict[str, Any]:
        """
        Process multiple dedup blocks in a single request via Rust batch endpoint.

        Wire format: ``<json_manifest>\\n<concatenated_block_data>``

        Args:
            blocks: List of dicts, each with ``block_data`` (bytes),
                    ``block_hash`` (str), and ``cas_path`` (str).
            user_id: User ID for salt derivation.
            should_compress: Whether to attempt Zstd compression.

        Returns:
            Dict with ``success``, ``total``, ``succeeded``, ``failed``,
            and ``results`` (list of per-block outcomes).
        """
        # Build manifest and concatenate block data
        manifest_blocks = []
        data_parts = []
        offset = 0
        for blk in blocks:
            length = len(blk["block_data"])
            manifest_blocks.append({
                "block_hash": blk["block_hash"],
                "cas_path": blk["cas_path"],
                "offset": offset,
                "length": length,
            })
            data_parts.append(blk["block_data"])
            offset += length

        manifest = json.dumps({
            "user_id": user_id,
            "should_compress": should_compress,
            "blocks": manifest_blocks,
        }, separators=(",", ":"))

        body = manifest.encode("utf-8") + b"\n" + b"".join(data_parts)

        try:
            response = await self.client.post(
                "/dedup-chunk-batch",
                content=body,
                headers={"content-type": "application/octet-stream"},
                timeout=Timeout(120.0),
            )
            response.raise_for_status()
            result = response.json()

            logger.debug(
                "Batch dedup via Rust: total=%d succeeded=%d failed=%d",
                result.get("total", 0),
                result.get("succeeded", 0),
                result.get("failed", 0),
            )
            return result

        except httpx.HTTPStatusError as e:
            logger.error(
                "Batch dedup Rust call failed: %d - %s",
                e.response.status_code,
                e.response.text,
            )
            raise
        except Exception as e:
            logger.error("Batch dedup Rust call error: %s", e)
            raise


# Global client instance (singleton pattern)
_rust_client: Optional[RustDataPlaneClient] = None


def get_rust_client(
    socket_path: str = "/tmp/edge-storage-dataplane.sock",
) -> RustDataPlaneClient:
    """
    Get or create the global Rust data plane client instance.

    Args:
        socket_path: Path to Unix domain socket

    Returns:
        RustDataPlaneClient instance
    """
    global _rust_client

    if _rust_client is None:
        socket_path = os.getenv("RUST_DATAPLANE_SOCKET", socket_path)
        _rust_client = RustDataPlaneClient(socket_path=socket_path)

    return _rust_client


async def close_rust_client():
    """Close the global Rust client instance."""
    global _rust_client

    if _rust_client is not None:
        await _rust_client.close()
        _rust_client = None
