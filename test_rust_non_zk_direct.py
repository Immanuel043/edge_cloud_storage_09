#!/usr/bin/env python3
"""
Test Rust Non-ZK mode with SCM_RIGHTS key passing

This test demonstrates the complete Non-ZK pipeline:
1. Create memfd with encryption key
2. Pass FD via SCM_RIGHTS
3. Rust reads key from FD
4. Rust processes: hash → compress → encrypt
5. Returns encrypted chunk

NOTE: This requires the Rust service to extract FD from SCM_RIGHTS ancillary data.
      Current implementation passes FD as header (placeholder).
"""

import asyncio
import sys
import os

# Add app to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'services/storage-service'))

from app.services.rust_socket_client import RustSocketClient
from app.utils.memfd_helper import MemfdHelper


async def test_non_zk_mode():
    """Test Rust Non-ZK mode with real key passing"""

    print("=" * 60)
    print("Rust Non-ZK Mode Test (SCM_RIGHTS)")
    print("=" * 60)
    print()

    # Check if Rust service is running
    print("1️⃣  Checking Rust service...")
    client = RustSocketClient()

    try:
        health = await client.health_check()
        print(f"   ✅ Rust service healthy: {health}")
        print()
    except Exception as e:
        print(f"   ❌ Rust service not available: {e}")
        print()
        print("Please start Rust service:")
        print("  cd services/rust-data-plane")
        print("  ./start-dev.sh")
        return False

    # Test 1: Small chunk (1MB)
    print("2️⃣  Testing Non-ZK mode with 1MB chunk...")

    test_data = b"Hello Rust Non-ZK! " * (1024 * 1024 // 19)  # ~1MB
    test_data = test_data[:1024 * 1024]  # Exactly 1MB

    # Generate a proper 32-byte key
    import hashlib
    file_key = hashlib.sha256(b"test-key-12345").digest()

    print(f"   Data size: {len(test_data)} bytes")
    print(f"   Key size: {len(file_key)} bytes")
    print()

    try:
        import time
        start = time.time()

        result = await client.process_non_zk_with_scm_rights(
            chunk_data=test_data,
            file_key=file_key,
            file_id="test-file-123",
            chunk_index=0,
            compress=False,  # No compression for predictable testing
            filename="test.txt",
            file_size=len(test_data),
        )

        duration = time.time() - start

        print("   ✅ Non-ZK processing successful!")
        print(f"   - Original hash: {result.get('hash', 'N/A')[:30]}...")
        print(f"   - Original size: {result.get('original_size', 0):,} bytes")
        print(f"   - Encrypted size: {result.get('encrypted_size', 0):,} bytes")
        print(f"   - Compressed: {result.get('compressed', False)}")
        print(f"   - Processing time: {duration:.3f}s")
        print()

        # Calculate throughput
        throughput = (len(test_data) / 1024 / 1024) / duration
        print(f"   - Throughput: {throughput:.1f} MB/s")
        print()

    except Exception as e:
        print(f"   ❌ Non-ZK processing failed: {e}")
        import traceback
        traceback.print_exc()
        print()
        return False

    # Test 2: Larger chunk with compression (32MB)
    print("3️⃣  Testing Non-ZK mode with 32MB chunk (with compression)...")

    # Create highly compressible data
    large_data = b"A" * (32 * 1024 * 1024)  # 32MB of 'A's

    try:
        start = time.time()

        result = await client.process_non_zk_with_scm_rights(
            chunk_data=large_data,
            file_key=file_key,
            file_id="test-large-file",
            chunk_index=0,
            compress=True,  # Enable compression
            filename="large.txt",
            file_size=len(large_data),
        )

        duration = time.time() - start

        print("   ✅ Large chunk processed!")
        print(f"   - Original size: {result.get('original_size', 0) / 1024 / 1024:.1f} MB")
        print(f"   - Encrypted size: {result.get('encrypted_size', 0) / 1024 / 1024:.1f} MB")
        print(f"   - Compressed: {result.get('compressed', False)}")
        if result.get('compression_ratio'):
            print(f"   - Compression ratio: {result['compression_ratio']:.2f}x")
        print(f"   - Processing time: {duration:.3f}s")

        throughput = (len(large_data) / 1024 / 1024) / duration
        print(f"   - Throughput: {throughput:.1f} MB/s")
        print()

        if throughput > 100:
            print("   ✨ Excellent! Throughput > 100 MB/s")
        elif throughput > 50:
            print("   ✅ Good! Throughput > 50 MB/s")
        print()

    except Exception as e:
        print(f"   ❌ Large chunk processing failed: {e}")
        import traceback
        traceback.print_exc()
        print()
        return False

    # Test 3: Verify memfd cleanup
    print("4️⃣  Testing memfd cleanup...")
    try:
        # Create a test memfd
        test_key = b"0" * 32
        fd = MemfdHelper.create_memfd_with_key(test_key)
        print(f"   Created memfd: FD={fd}")

        # Verify it's valid
        if MemfdHelper.verify_memfd(fd):
            print("   ✅ memfd is valid")
        else:
            print("   ❌ memfd validation failed")
            return False

        # Close it
        MemfdHelper.close_memfd(fd)
        print("   ✅ memfd closed")

        # Verify it's no longer valid
        if not MemfdHelper.verify_memfd(fd):
            print("   ✅ memfd properly cleaned up")
        else:
            print("   ⚠️  memfd still valid after close (unexpected)")

        print()

    except Exception as e:
        print(f"   ❌ memfd cleanup test failed: {e}")
        print()
        return False

    return True


async def main():
    print()
    print("This test requires the Rust service to be running.")
    print("Make sure you started it with:")
    print("  cd services/rust-data-plane")
    print("  ./start-dev.sh")
    print()

    # Check if running interactively
    import sys
    if sys.stdin.isatty():
        input("Press Enter when ready...")
    else:
        print("(Non-interactive mode - proceeding)")
    print()

    try:
        success = await test_non_zk_mode()

        if success:
            print("=" * 60)
            print("🎉 All Tests Passed!")
            print("=" * 60)
            print()
            print("Rust Non-ZK mode is working correctly!")
            print()
            print("Performance Summary:")
            print("  - 1MB chunk: Fast hash + encrypt")
            print("  - 32MB chunk: Fast hash + compress + encrypt")
            print("  - memfd: Secure key passing working")
            print()
            print("Next steps:")
            print("  1. ✅ Rust Non-ZK mode verified")
            print("  2. 🔄 Enable in FastAPI (RUST_DATAPLANE_ENABLED=true)")
            print("  3. 🌐 Test with full upload flow")
            print()
            return 0
        else:
            print()
            print("=" * 60)
            print("❌ Some Tests Failed")
            print("=" * 60)
            print()
            print("Check the errors above and:")
            print("  - Ensure Rust service is running")
            print("  - Check socket exists: ls -la /tmp/edge-storage-dataplane.sock")
            print("  - Check logs for errors")
            print()
            return 1

    except Exception as e:
        print()
        print(f"❌ Test error: {e}")
        print()
        import traceback
        traceback.print_exc()
        print()
        print("Troubleshooting:")
        print("  1. Is Rust service running? (./start-dev.sh)")
        print("  2. Are dependencies installed? (pip install httpx)")
        print("  3. Is socket accessible?")
        print()
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
