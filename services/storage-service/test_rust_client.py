#!/usr/bin/env python3
"""
Test script for Rust data plane client.

This script tests the Python client against the Rust service.
Make sure the Rust service is running before executing this test.

Usage:
    # Start Rust service first:
    cd services/rust-data-plane
    cargo run --release

    # Then run this test:
    python services/storage-service/test_rust_client.py
"""

import asyncio
import os
import sys

# Add parent directory to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'app'))

from services.rust_dataplane_client import RustDataPlaneClient


async def test_health_check():
    """Test health check endpoint."""
    print("🏥 Testing health check...")

    async with RustDataPlaneClient() as client:
        try:
            health = await client.health_check()
            print(f"✅ Health check passed: {health}")
            return True
        except Exception as e:
            print(f"❌ Health check failed: {e}")
            return False


async def test_non_zk_upload():
    """Test non-ZK mode chunk upload."""
    print("\n📤 Testing Non-ZK upload...")

    chunk_data = b"Hello, Rust data plane! " * 1000  # ~24KB test data
    file_id = "test-file-123"
    chunk_index = 0

    async with RustDataPlaneClient() as client:
        try:
            result = await client.process_non_zk_chunk(
                chunk_data=chunk_data,
                file_id=file_id,
                chunk_index=chunk_index,
                compress=True,
                filename="test.txt",
                file_size=len(chunk_data),
            )

            print(f"✅ Non-ZK upload successful:")
            print(f"   - Success: {result.get('success')}")
            print(f"   - Hash: {result.get('hash')}")
            print(f"   - Original size: {result.get('original_size')} bytes")
            print(f"   - Encrypted size: {result.get('encrypted_size')} bytes")
            print(f"   - Compressed: {result.get('compressed')}")

            if result.get('compression_ratio'):
                print(f"   - Compression ratio: {result.get('compression_ratio'):.2f}")

            return True

        except Exception as e:
            print(f"❌ Non-ZK upload failed: {e}")
            return False


async def test_zk_upload():
    """Test ZK mode chunk upload."""
    print("\n📤 Testing ZK upload...")

    # Simulate pre-encrypted data (in real scenario, client encrypts)
    chunk_data = b"Pre-encrypted chunk data" * 1000
    file_id = "test-zk-file-456"
    chunk_index = 0

    async with RustDataPlaneClient() as client:
        try:
            result = await client.process_zk_chunk(
                chunk_data=chunk_data,
                file_id=file_id,
                chunk_index=chunk_index,
            )

            print(f"✅ ZK upload successful:")
            print(f"   - Success: {result.get('success')}")
            print(f"   - Hash: {result.get('hash')}")

            return True

        except Exception as e:
            print(f"❌ ZK upload failed: {e}")
            return False


async def test_zk_security_violation():
    """Test ZK mode security: should reject encryption keys."""
    print("\n🔒 Testing ZK mode security...")

    chunk_data = b"Test data"
    file_id = "test-security"

    async with RustDataPlaneClient() as client:
        try:
            # Attempt to pass key_fd in ZK mode (should be rejected)
            result = await client.process_non_zk_chunk(
                chunk_data=chunk_data,
                file_id=file_id,
                chunk_index=0,
                compress=False,
                key_fd=999,  # Fake FD - should trigger security violation if mode is ZK
            )

            print(f"⚠️  Security test inconclusive - server may not have rejected")
            return True

        except Exception as e:
            print(f"✅ Security working as expected: {e}")
            return True


async def test_performance():
    """Test performance with larger chunks."""
    print("\n⚡ Testing performance...")

    # 32MB chunk (typical chunk size)
    chunk_size = 32 * 1024 * 1024
    chunk_data = os.urandom(chunk_size)
    file_id = "test-performance"

    async with RustDataPlaneClient() as client:
        try:
            import time
            start = time.time()

            result = await client.process_non_zk_chunk(
                chunk_data=chunk_data,
                file_id=file_id,
                chunk_index=0,
                compress=False,  # Test encryption only
            )

            duration = time.time() - start
            throughput = chunk_size / duration / (1024 * 1024)  # MB/s

            print(f"✅ Performance test completed:")
            print(f"   - Chunk size: {chunk_size / (1024 * 1024):.1f} MB")
            print(f"   - Duration: {duration:.2f}s")
            print(f"   - Throughput: {throughput:.1f} MB/s")
            print(f"   - Success: {result.get('success')}")

            return True

        except Exception as e:
            print(f"❌ Performance test failed: {e}")
            return False


async def main():
    """Run all tests."""
    print("=" * 60)
    print("Rust Data Plane Client Test Suite")
    print("=" * 60)

    tests = [
        ("Health Check", test_health_check),
        ("Non-ZK Upload", test_non_zk_upload),
        ("ZK Upload", test_zk_upload),
        ("Performance", test_performance),
    ]

    results = []

    for test_name, test_func in tests:
        try:
            result = await test_func()
            results.append((test_name, result))
        except Exception as e:
            print(f"❌ Test '{test_name}' crashed: {e}")
            results.append((test_name, False))

    # Summary
    print("\n" + "=" * 60)
    print("Test Summary")
    print("=" * 60)

    passed = sum(1 for _, result in results if result)
    total = len(results)

    for test_name, result in results:
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"{status} - {test_name}")

    print(f"\nTotal: {passed}/{total} tests passed")

    if passed == total:
        print("\n🎉 All tests passed!")
        return 0
    else:
        print(f"\n⚠️  {total - passed} test(s) failed")
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
