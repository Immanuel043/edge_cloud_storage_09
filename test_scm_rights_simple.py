#!/usr/bin/env python3
"""
Simple SCM_RIGHTS test - minimal dependencies

Tests the Rust Non-ZK mode with file descriptor passing.
"""

import asyncio
import socket
import struct
import os
import hashlib
import uuid
import json
import time

def create_temp_file_with_key(key: bytes) -> int:
    """Create a temporary file with encryption key (simpler than shm for testing)"""
    import tempfile

    # Create temp file in memory-backed tmpfs if available
    temp_fd, temp_path = tempfile.mkstemp(prefix="key_", suffix=".bin")

    try:
        # Write key
        written = os.write(temp_fd, key)
        if written != len(key):
            os.close(temp_fd)
            os.unlink(temp_path)
            raise OSError(f"Failed to write full key: wrote {written}/{len(key)} bytes")

        # Seek back to beginning for reading
        os.lseek(temp_fd, 0, os.SEEK_SET)

        # Delete file from filesystem (FD keeps it alive)
        os.unlink(temp_path)

        return temp_fd
    except Exception:
        os.close(temp_fd)
        if os.path.exists(temp_path):
            os.unlink(temp_path)
        raise


async def test_non_zk():
    """Test Non-ZK mode with SCM_RIGHTS"""

    print("=" * 60)
    print("SCM_RIGHTS Non-ZK Mode Test")
    print("=" * 60)
    print()

    # Test data
    test_data = b"Hello Rust Non-ZK! " * (1024 * 100)  # ~2KB
    file_key = hashlib.sha256(b"test-key-123").digest()  # 32 bytes

    print(f"1️⃣  Test data: {len(test_data)} bytes")
    print(f"2️⃣  Key size: {len(file_key)} bytes")
    print()

    # Create temp file with key (simpler for testing)
    print("3️⃣  Creating temporary file with encryption key...")
    key_fd = create_temp_file_with_key(file_key)
    print(f"   ✅ Created temp file: FD={key_fd}")
    print()

    try:
        # Connect to Rust service
        print("4️⃣  Connecting to Rust service...")
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.connect("/tmp/edge-storage-dataplane.sock")
        print("   ✅ Connected!")
        print()

        # Build HTTP request
        headers = {
            "Host": "localhost",
            "Content-Type": "application/octet-stream",
            "Content-Length": str(len(test_data)),
            "X-Request-ID": str(uuid.uuid4()),
            "X-Mode": "non-zk",
            "X-File-ID": "test-file-123",
            "X-Chunk-Index": "0",
            "X-Should-Compress": "false",
        }

        http_request = "POST /upload HTTP/1.1\r\n"
        for key, value in headers.items():
            http_request += f"{key}: {value}\r\n"
        http_request += "\r\n"

        # Send HTTP request + FD via SCM_RIGHTS
        print("5️⃣  Sending HTTP request + FD via SCM_RIGHTS...")
        ancillary = [(
            socket.SOL_SOCKET,
            socket.SCM_RIGHTS,
            struct.pack("i", key_fd)
        )]

        sent = sock.sendmsg([http_request.encode('utf-8')], ancillary)
        print(f"   ✅ Sent {sent} bytes + FD via SCM_RIGHTS")
        print()

        # Send chunk data
        print("6️⃣  Sending chunk data...")
        start_time = time.time()
        sock.sendall(test_data)
        print(f"   ✅ Sent {len(test_data)} bytes")
        print()

        # Receive response
        print("7️⃣  Receiving response...")
        response = b""
        while b"\r\n\r\n" not in response:
            chunk = sock.recv(4096)
            if not chunk:
                raise ConnectionError("Socket closed before headers received")
            response += chunk

        # Parse response
        headers_end = response.find(b"\r\n\r\n")
        header_section = response[:headers_end].decode('utf-8')
        body_start = response[headers_end + 4:]

        # Get status
        status_line = header_section.split("\r\n")[0]
        status_code = int(status_line.split(" ")[1])

        # Get Content-Length and read body
        content_length = 0
        for line in header_section.split("\r\n")[1:]:
            if line.lower().startswith("content-length:"):
                content_length = int(line.split(":", 1)[1].strip())
                break

        body = body_start
        while len(body) < content_length:
            chunk = sock.recv(content_length - len(body))
            if not chunk:
                break
            body += chunk

        duration = time.time() - start_time

        # Parse JSON response
        result = json.loads(body.decode('utf-8'))

        print(f"   ✅ Response received ({duration:.3f}s)")
        print(f"   Status: {status_code}")
        print(f"   Body: {body.decode('utf-8')[:200]}")
        print()

        if result.get("success"):
            print("=" * 60)
            print("🎉 TEST PASSED!")
            print("=" * 60)
            print()
            print(f"Results:")
            print(f"  - Original hash: {result.get('hash', 'N/A')[:30]}...")
            print(f"  - Original size: {result.get('original_size', 0):,} bytes")
            print(f"  - Encrypted size: {result.get('encrypted_size', 0):,} bytes")
            print(f"  - Compressed: {result.get('compressed', False)}")
            print(f"  - Processing time: {duration:.3f}s")

            throughput = (len(test_data) / 1024 / 1024) / duration
            print(f"  - Throughput: {throughput:.1f} MB/s")
            print()
            print("✨ Full Rust processing (hash + encrypt) is working!")
            print()
            return True
        else:
            print("❌ TEST FAILED!")
            print(f"Error: {result.get('message', 'Unknown error')}")
            return False

    finally:
        os.close(key_fd)
        sock.close()


if __name__ == "__main__":
    success = asyncio.run(test_non_zk())
    exit(0 if success else 1)
