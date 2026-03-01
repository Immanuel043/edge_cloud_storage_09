"""
Rust Socket Client - Low-level Unix socket client with SCM_RIGHTS support

This client bypasses httpx to enable file descriptor passing via SCM_RIGHTS
for secure encryption key transfer to the Rust data plane service.
"""

import socket
import json
import asyncio
from typing import Dict, Any, Optional
import logging
import uuid

from ..utils.memfd_helper import MemfdHelper

logger = logging.getLogger(__name__)


class RustSocketClient:
    """
    Low-level Unix socket client with SCM_RIGHTS support for Non-ZK mode.

    This client provides secure key passing via memfd + SCM_RIGHTS, bypassing
    httpx which doesn't support ancillary data.
    """

    def __init__(
        self,
        socket_path: str = "/tmp/edge-storage-dataplane.sock",
        timeout: float = 30.0
    ):
        """
        Initialize Rust socket client.

        Args:
            socket_path: Path to Unix domain socket
            timeout: Socket timeout in seconds
        """
        self.socket_path = socket_path
        self.timeout = timeout

    async def process_non_zk_with_scm_rights(
        self,
        chunk_data: bytes,
        file_key: bytes,
        file_id: str,
        chunk_index: int,
        compress: bool,
        filename: Optional[str] = None,
        file_size: Optional[int] = None,
        target_path: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Process chunk in Non-ZK mode with secure key passing via SCM_RIGHTS.

        This method:
        1. Creates memfd with encryption key
        2. Opens Unix socket connection
        3. Sends HTTP request + FD via SCM_RIGHTS
        4. Sends chunk data
        5. Receives HTTP response
        6. Cleans up memfd

        Args:
            chunk_data: Raw chunk data to process
            file_key: Encryption key (32 bytes for AES-256)
            file_id: File identifier
            chunk_index: Index of this chunk
            compress: Whether to compress
            filename: Original filename (for compression detection)
            file_size: Total file size (for compression detection)
            target_path: If provided, Rust writes directly to this path (zero-copy)

        Returns:
            Response dict containing:
            - success: bool
            - hash: str (SHA-256 of original data)
            - original_size: int
            - encrypted_size: int
            - compressed: bool
            - encryption_chunk_path: str

        Raises:
            ConnectionError: If socket connection fails
            ValueError: If response is invalid
            Exception: If processing fails
        """
        # Validate inputs (lightweight, OK on event loop)
        if not isinstance(chunk_data, bytes):
            raise ValueError("chunk_data must be bytes")
        if not isinstance(file_key, bytes):
            raise ValueError("file_key must be bytes")
        if len(file_key) != 32:
            raise ValueError(f"file_key must be 32 bytes, got {len(file_key)}")

        # Offload all blocking socket I/O to a thread to keep the event loop free
        return await asyncio.to_thread(
            self._process_non_zk_sync,
            chunk_data, file_key, file_id, chunk_index,
            compress, filename, file_size, target_path,
        )

    def _process_non_zk_sync(
        self,
        chunk_data: bytes,
        file_key: bytes,
        file_id: str,
        chunk_index: int,
        compress: bool,
        filename: Optional[str],
        file_size: Optional[int],
        target_path: Optional[str],
    ) -> Dict[str, Any]:
        """Synchronous blocking implementation — runs in a worker thread."""
        key_fd = None
        sock = None

        try:
            # 1. Create memfd with key
            logger.debug(f"Creating memfd with key for chunk {chunk_index}")
            key_fd = MemfdHelper.create_memfd_with_key(file_key, name=f"key_{file_id}_{chunk_index}")

            # 2. Create Unix socket connection
            logger.debug(f"Connecting to {self.socket_path}")
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.settimeout(self.timeout)
            sock.connect(self.socket_path)

            # 3. Build HTTP request
            request_id = str(uuid.uuid4())
            headers = {
                "Host": "localhost",
                "Content-Type": "application/octet-stream",
                "Content-Length": str(len(chunk_data)),
                "X-Request-ID": request_id,
                "X-Mode": "non-zk",
                "X-File-ID": file_id,
                "X-Chunk-Index": str(chunk_index),
                "X-Should-Compress": str(compress).lower(),
            }

            if filename:
                headers["X-Filename"] = filename
            if file_size is not None:
                headers["X-File-Size"] = str(file_size)
            if target_path:
                headers["X-Target-Path"] = target_path

            # Build HTTP/1.1 request
            http_request = self._build_http_request("POST", "/upload", headers)

            # 4. Send HTTP request + FD via SCM_RIGHTS
            logger.debug(f"Sending HTTP request + FD {key_fd} via SCM_RIGHTS")
            MemfdHelper.send_fd_over_socket(sock, key_fd, http_request.encode('utf-8'))

            # 5. Send chunk data (regular socket send, not via SCM_RIGHTS)
            logger.debug(f"Sending chunk data: {len(chunk_data)} bytes")
            total_sent = 0
            while total_sent < len(chunk_data):
                sent = sock.send(chunk_data[total_sent:])
                if sent == 0:
                    raise ConnectionError("Socket connection broken during chunk data send")
                total_sent += sent
            logger.debug(f"Sent {total_sent} bytes of chunk data")

            # 6. Receive HTTP response
            logger.debug("Receiving HTTP response")
            response_data = self._read_http_response(sock)

            # 7. Parse JSON response
            try:
                result = json.loads(response_data)
            except json.JSONDecodeError as e:
                raise ValueError(f"Invalid JSON response: {e}\nResponse: {response_data[:200]}")

            # Validate response
            if not result.get("success", False):
                error_msg = result.get("message", "Unknown error")
                raise Exception(f"Rust processing failed: {error_msg}")

            logger.info(
                f"Chunk {chunk_index} processed via Rust Non-ZK mode: "
                f"hash={result.get('hash', 'N/A')[:20]}..., "
                f"encrypted_size={result.get('encrypted_size', 0)}"
            )

            return result

        except Exception as e:
            logger.error(f"Failed to process chunk {chunk_index} via Rust Non-ZK: {e}")
            raise

        finally:
            # Cleanup: close FD and socket
            if key_fd is not None:
                MemfdHelper.close_memfd(key_fd)
            if sock is not None:
                try:
                    sock.close()
                except Exception:
                    pass

    def _build_http_request(self, method: str, path: str, headers: Dict[str, str]) -> str:
        """
        Build HTTP/1.1 request string.

        Args:
            method: HTTP method (e.g., "POST")
            path: Request path (e.g., "/upload")
            headers: HTTP headers dict

        Returns:
            HTTP request string

        Example output:
            POST /upload HTTP/1.1\\r\\n
            Host: localhost\\r\\n
            Content-Length: 1024\\r\\n
            \\r\\n
        """
        lines = [f"{method} {path} HTTP/1.1"]

        for key, value in headers.items():
            lines.append(f"{key}: {value}")

        lines.append("")  # Empty line before body
        lines.append("")  # Will add \r\n\r\n

        return "\r\n".join(lines)

    def _read_http_response(self, sock: socket.socket) -> str:
        """
        Read HTTP response from socket.

        Args:
            sock: Connected socket

        Returns:
            Response body (JSON string)

        Raises:
            ValueError: If response is invalid
            ConnectionError: If socket closes unexpectedly
        """
        # Read until we find \r\n\r\n (end of headers)
        buffer = b""
        while b"\r\n\r\n" not in buffer:
            chunk = sock.recv(4096)
            if not chunk:
                raise ConnectionError("Socket closed before headers received")
            buffer += chunk

        # Split headers and body
        headers_end = buffer.find(b"\r\n\r\n")
        header_section = buffer[:headers_end].decode('utf-8')
        body_start = buffer[headers_end + 4:]

        # Parse status line
        lines = header_section.split("\r\n")
        status_line = lines[0]
        parts = status_line.split(" ", 2)
        if len(parts) < 3:
            raise ValueError(f"Invalid HTTP status line: {status_line}")

        status_code = int(parts[1])
        status_text = parts[2]

        # Parse headers
        headers = {}
        for line in lines[1:]:
            if ": " in line:
                key, value = line.split(": ", 1)
                headers[key.lower()] = value

        # Get Content-Length
        content_length = int(headers.get("content-length", 0))

        # Read remaining body
        body = body_start
        while len(body) < content_length:
            chunk = sock.recv(min(4096, content_length - len(body)))
            if not chunk:
                raise ConnectionError("Socket closed before body fully received")
            body += chunk

        # Decode body
        body_str = body.decode('utf-8')

        # Check status code
        if status_code != 200:
            raise ValueError(
                f"HTTP {status_code} {status_text}: {body_str}"
            )

        return body_str

    async def health_check(self) -> Dict[str, Any]:
        """
        Check if Rust service is healthy (using regular socket, no FD passing).

        Returns:
            Health status dict

        Raises:
            ConnectionError: If health check fails
        """
        return await asyncio.to_thread(self._health_check_sync)

    def _health_check_sync(self) -> Dict[str, Any]:
        """Synchronous blocking health check — runs in a worker thread."""
        sock = None
        try:
            # Create socket
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.settimeout(5.0)  # Shorter timeout for health check
            sock.connect(self.socket_path)

            # Build HTTP request
            headers = {
                "Host": "localhost",
                "Connection": "close",
            }
            request = self._build_http_request("GET", "/health", headers)

            # Send request
            sock.sendall(request.encode('utf-8'))

            # Read response
            response_body = self._read_http_response(sock)

            # Parse JSON
            result = json.loads(response_body)

            return result

        except Exception as e:
            logger.error(f"Rust health check failed: {e}")
            raise ConnectionError(f"Rust service unavailable: {e}")

        finally:
            if sock:
                try:
                    sock.close()
                except Exception:
                    pass


# Singleton instance (optional, for convenience)
_rust_socket_client: Optional[RustSocketClient] = None


def get_rust_socket_client(socket_path: str = "/tmp/edge-storage-dataplane.sock") -> RustSocketClient:
    """
    Get or create singleton Rust socket client.

    Args:
        socket_path: Path to Unix socket

    Returns:
        RustSocketClient instance
    """
    global _rust_socket_client

    if _rust_socket_client is None:
        _rust_socket_client = RustSocketClient(socket_path=socket_path)

    return _rust_socket_client
