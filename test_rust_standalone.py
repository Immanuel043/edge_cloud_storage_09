#!/usr/bin/env python3
"""
Standalone Rust Data Plane Test
No dependencies on FastAPI app structure
"""

import asyncio
import httpx
import time


async def test_rust_service():
    """Test the Rust service directly"""

    print("=" * 60)
    print("Rust Data Plane - Standalone Test")
    print("=" * 60)
    print()

    socket_path = "/tmp/edge-storage-dataplane.sock"

    print(f"🔌 Connecting to: {socket_path}")
    print()

    # Create client with Unix socket transport
    transport = httpx.AsyncHTTPTransport(uds=socket_path)

    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://localhost",
        timeout=30.0
    ) as client:

        # Test 1: Health Check
        print("1️⃣  Testing health check...")
        try:
            response = await client.get("/health")
            response.raise_for_status()
            print(f"   ✅ Health check passed!")
            print(f"   Response: {response.text}")
            print()
        except Exception as e:
            print(f"   ❌ Health check failed: {e}")
            return False

        # Test 2: Upload a small chunk (ZK mode - doesn't need encryption key)
        print("2️⃣  Testing ZK chunk upload (1MB)...")

        # Create 1MB test data
        test_data = b"Hello Rust! " * (1024 * 1024 // 12)

        headers = {
            "x-mode": "zk",
            "x-file-id": "test-file-123",
            "x-chunk-index": "0",
        }

        start = time.time()

        try:
            response = await client.post(
                "/upload",
                content=test_data,
                headers=headers,
            )
            response.raise_for_status()

            duration = time.time() - start
            result = response.json()

            print(f"   ✅ Upload successful!")
            print(f"   - Hash: {result.get('hash', 'N/A')[:30]}...")
            print(f"   - Time: {duration:.3f}s")

            throughput = (len(test_data) / 1024 / 1024) / duration
            print(f"   - Throughput: {throughput:.1f} MB/s")
            print()

        except Exception as e:
            print(f"   ❌ Upload failed: {e}")
            if hasattr(e, 'response'):
                print(f"   Response: {e.response.text}")
            return False

        # Test 3: Larger chunk for performance test (ZK mode)
        print("3️⃣  Testing performance with 32MB chunk (ZK mode)...")

        large_data = b"X" * (32 * 1024 * 1024)  # 32MB

        headers = {
            "x-mode": "zk",
            "x-file-id": "test-large-file",
            "x-chunk-index": "0",
        }

        start = time.time()

        try:
            response = await client.post(
                "/upload",
                content=large_data,
                headers=headers,
            )
            response.raise_for_status()

            duration = time.time() - start
            result = response.json()

            throughput = (len(large_data) / 1024 / 1024) / duration

            print(f"   ✅ Large chunk uploaded!")
            print(f"   - Size: 32 MB")
            print(f"   - Time: {duration:.3f}s")
            print(f"   - Throughput: {throughput:.1f} MB/s")
            print()

            if throughput > 100:
                print(f"   ✨ Excellent! Throughput > 100 MB/s")
            elif throughput > 50:
                print(f"   ✅ Good! Throughput > 50 MB/s")

        except Exception as e:
            print(f"   ❌ Large upload failed: {e}")
            return False

        return True


async def main():
    print()
    print("Make sure the Rust service is running:")
    print("  cd services/rust-data-plane")
    print("  ./start-dev.sh")
    print()
    # Skip interactive prompt if stdin is not a TTY (for non-interactive testing)
    import sys
    if sys.stdin.isatty():
        input("Press Enter when ready...")
    else:
        print("(Non-interactive mode - skipping prompt)")
    print()

    try:
        success = await test_rust_service()

        if success:
            print("=" * 60)
            print("🎉 All Tests Passed!")
            print("=" * 60)
            print()
            print("Your Rust data plane is working correctly!")
            print()
            print("Next steps:")
            print("1. ✅ Rust service is verified")
            print("2. 🔄 Test with FastAPI backend")
            print("3. 🌐 Test with your frontend")
            print()
            return 0
        else:
            print()
            print("=" * 60)
            print("❌ Some Tests Failed")
            print("=" * 60)
            print()
            print("Check the errors above and:")
            print("- Ensure Rust service is running")
            print("- Check socket exists: ls -la /tmp/edge-storage-dataplane.sock")
            print()
            return 1

    except Exception as e:
        print()
        print(f"❌ Test error: {e}")
        print()
        print("Troubleshooting:")
        print("1. Is Rust service running? (./start-dev.sh)")
        print("2. Install httpx: pip install httpx")
        print()
        return 1


if __name__ == "__main__":
    import sys
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
