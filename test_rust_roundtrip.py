#!/usr/bin/env python3
"""
Test full roundtrip: upload → encrypt → decrypt → verify

This test verifies that:
1. Rust encrypts the chunk correctly
2. The encrypted chunk can be decrypted
3. Decrypted data matches original
"""

import asyncio
import socket
import struct
import os
import hashlib
import uuid
import json
import tempfile

def create_temp_file_with_key(key: bytes) -> int:
    """Create a temporary file with encryption key"""
    temp_fd, temp_path = tempfile.mkstemp(prefix="key_", suffix=".bin")

    try:
        written = os.write(temp_fd, key)
        if written != len(key):
            os.close(temp_fd)
            os.unlink(temp_path)
            raise OSError(f"Failed to write full key: wrote {written}/{len(key)} bytes")

        os.lseek(temp_fd, 0, os.SEEK_SET)
        os.unlink(temp_path)

        return temp_fd
    except Exception:
        os.close(temp_fd)
        if os.path.exists(temp_path):
            os.unlink(temp_path)
        raise


async def test_upload_download_roundtrip():
    """Test full upload → download cycle"""

    print("=" * 70)
    print("Rust Data Plane Roundtrip Test")
    print("=" * 70)
    print()

    # Test data
    test_data = b"The quick brown fox jumps over the lazy dog! " * 100
    file_key = hashlib.sha256(b"test-roundtrip-key").digest()
    file_id = f"test-{uuid.uuid4()}"

    print(f"📝 Test data: {len(test_data)} bytes")
    print(f"🔑 File ID: {file_id}")
    print(f"🔑 Key size: {len(file_key)} bytes")
    original_hash = hashlib.sha256(test_data).hexdigest()
    print(f"🔐 Original hash: sha256:{original_hash[:30]}...")
    print()

    # Step 1: Upload (encrypt)
    print("=" * 70)
    print("Step 1: Upload & Encrypt")
    print("=" * 70)

    key_fd = create_temp_file_with_key(file_key)

    try:
        # Connect
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.connect("/tmp/edge-storage-dataplane.sock")

        # Build upload request
        headers = {
            "Host": "localhost",
            "Content-Type": "application/octet-stream",
            "Content-Length": str(len(test_data)),
            "X-Request-ID": str(uuid.uuid4()),
            "X-Mode": "non-zk",
            "X-File-ID": file_id,
            "X-Chunk-Index": "0",
            "X-Should-Compress": "false",
        }

        http_request = "POST /upload HTTP/1.1\r\n"
        for key, value in headers.items():
            http_request += f"{key}: {value}\r\n"
        http_request += "\r\n"

        # Send request + FD
        ancillary = [(
            socket.SOL_SOCKET,
            socket.SCM_RIGHTS,
            struct.pack("i", key_fd)
        )]

        sock.sendmsg([http_request.encode('utf-8')], ancillary)
        sock.sendall(test_data)

        # Read upload response
        response = b""
        while b"\r\n\r\n" not in response:
            chunk = sock.recv(4096)
            if not chunk:
                raise ConnectionError("Socket closed")
            response += chunk

        headers_end = response.find(b"\r\n\r\n")
        header_section = response[:headers_end].decode('utf-8')
        body_start = response[headers_end + 4:]

        status_line = header_section.split("\r\n")[0]
        status_code = int(status_line.split(" ")[1])

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

        upload_result = json.loads(body.decode('utf-8'))
        sock.close()

        if not upload_result.get("success"):
            print(f"❌ Upload failed: {upload_result.get('message', 'Unknown error')}")
            return False

        print(f"✅ Upload successful!")
        print(f"   Hash: {upload_result['hash'][:40]}...")
        print(f"   Original size: {upload_result['original_size']:,} bytes")
        print(f"   Encrypted size: {upload_result['encrypted_size']:,} bytes")
        print()

    finally:
        os.close(key_fd)

    # Step 2: Download (decrypt)
    print("=" * 70)
    print("Step 2: Download & Decrypt")
    print("=" * 70)

    key_fd = create_temp_file_with_key(file_key)

    try:
        # Connect
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.connect("/tmp/edge-storage-dataplane.sock")

        # Build download request
        headers = {
            "Host": "localhost",
            "X-Request-ID": str(uuid.uuid4()),
            "X-Mode": "non-zk",
            "X-File-ID": file_id,
            "X-Chunk-Index": "0",
            "X-Was-Compressed": "false",
        }

        http_request = "GET /download HTTP/1.1\r\n"
        for key, value in headers.items():
            http_request += f"{key}: {value}\r\n"
        http_request += "\r\n"

        # Send request + FD
        ancillary = [(
            socket.SOL_SOCKET,
            socket.SCM_RIGHTS,
            struct.pack("i", key_fd)
        )]

        sock.sendmsg([http_request.encode('utf-8')], ancillary)

        # Read download response
        response = b""
        while b"\r\n\r\n" not in response:
            chunk = sock.recv(4096)
            if not chunk:
                raise ConnectionError("Socket closed")
            response += chunk

        headers_end = response.find(b"\r\n\r\n")
        header_section = response[:headers_end].decode('utf-8')
        body_start = response[headers_end + 4:]

        status_line = header_section.split("\r\n")[0]
        status_code = int(status_line.split(" ")[1])

        if status_code != 200:
            print(f"❌ Download failed with status {status_code}")
            print(f"   Response: {header_section}")
            return False

        content_length = 0
        for line in header_section.split("\r\n")[1:]:
            if line.lower().startswith("content-length:"):
                content_length = int(line.split(":", 1)[1].strip())
                break

        decrypted_data = body_start
        while len(decrypted_data) < content_length:
            chunk = sock.recv(content_length - len(decrypted_data))
            if not chunk:
                break
            decrypted_data += chunk

        sock.close()

        print(f"✅ Download successful!")
        print(f"   Received: {len(decrypted_data):,} bytes")
        print()

    finally:
        os.close(key_fd)

    # Step 3: Verify
    print("=" * 70)
    print("Step 3: Verification")
    print("=" * 70)

    decrypted_hash = hashlib.sha256(decrypted_data).hexdigest()

    print(f"Original hash:   sha256:{original_hash[:30]}...")
    print(f"Decrypted hash:  sha256:{decrypted_hash[:30]}...")
    print()

    if decrypted_data == test_data:
        print("=" * 70)
        print("🎉 ROUNDTRIP TEST PASSED!")
        print("=" * 70)
        print()
        print("✅ Data encrypted correctly")
        print("✅ Data decrypted correctly")
        print("✅ Decrypted data matches original")
        print()
        print("🔒 Full Rust encryption/decryption is working perfectly!")
        print()
        return True
    else:
        print("❌ ROUNDTRIP TEST FAILED!")
        print(f"   Expected {len(test_data)} bytes, got {len(decrypted_data)} bytes")
        if len(test_data) == len(decrypted_data):
            # Find first difference
            for i, (a, b) in enumerate(zip(test_data, decrypted_data)):
                if a != b:
                    print(f"   First difference at byte {i}: {a:02x} != {b:02x}")
                    break
        return False


if __name__ == "__main__":
    success = asyncio.run(test_upload_download_roundtrip())
    exit(0 if success else 1)
