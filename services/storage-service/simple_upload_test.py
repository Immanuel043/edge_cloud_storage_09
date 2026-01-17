#!/usr/bin/env python3
"""
Simple file upload test - bypasses FastAPI, tests Rust directly
Use this to verify Rust service is working before testing full stack
"""

import asyncio
import sys
import os

# Add app to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'app'))

from services.rust_dataplane_client import RustDataPlaneClient


async def test_file_upload():
    """Simulate uploading a file through Rust service"""

    print("=" * 60)
    print("Simple File Upload Test")
    print("=" * 60)
    print()

    # Create test file (1MB)
    test_file_size = 1 * 1024 * 1024  # 1MB
    test_data = b"Test data " * (test_file_size // 10)
    test_data = test_data[:test_file_size]

    print(f"📄 Test file size: {len(test_data) / 1024 / 1024:.1f} MB")
    print()

    # Connect to Rust service
    print("🔌 Connecting to Rust data plane...")
    async with RustDataPlaneClient() as client:
        print("✅ Connected!")
        print()

        # Simulate chunking (like FastAPI does)
        chunk_size = 32 * 1024 * 1024  # 32MB chunks
        file_id = "test-upload-123"

        chunks = []
        for i in range(0, len(test_data), chunk_size):
            chunk = test_data[i:i + chunk_size]
            chunks.append(chunk)

        print(f"📦 Split into {len(chunks)} chunk(s)")
        print()

        # Upload each chunk
        total_time = 0
        for idx, chunk in enumerate(chunks):
            print(f"⬆️  Uploading chunk {idx + 1}/{len(chunks)} ({len(chunk) / 1024 / 1024:.1f} MB)...")

            import time
            start = time.time()

            try:
                result = await client.process_non_zk_chunk(
                    chunk_data=chunk,
                    file_id=file_id,
                    chunk_index=idx,
                    compress=True,
                    filename="test-file.bin",
                    file_size=len(test_data),
                )

                duration = time.time() - start
                total_time += duration

                print(f"   ✅ Success!")
                print(f"   - Hash: {result['hash'][:20]}...")
                print(f"   - Size: {result['original_size']:,} bytes")
                print(f"   - Compressed: {result['compressed']}")
                print(f"   - Time: {duration:.2f}s")

                if result.get('compression_ratio'):
                    print(f"   - Compression ratio: {result['compression_ratio']:.2f}x")

                print()

            except Exception as e:
                print(f"   ❌ Failed: {e}")
                print()
                return False

        # Summary
        throughput = (len(test_data) / 1024 / 1024) / total_time
        print("=" * 60)
        print("📊 Summary")
        print("=" * 60)
        print(f"Total size:       {len(test_data) / 1024 / 1024:.1f} MB")
        print(f"Total time:       {total_time:.2f}s")
        print(f"Throughput:       {throughput:.1f} MB/s")
        print(f"Chunks processed: {len(chunks)}")
        print()
        print("🎉 All chunks uploaded successfully!")
        print()

        # Compare with expected performance
        if throughput > 100:
            print("✨ Excellent! Throughput > 100 MB/s (Rust is working great!)")
        elif throughput > 50:
            print("✅ Good! Throughput > 50 MB/s (Rust is working)")
        else:
            print("⚠️  Throughput < 50 MB/s (Might want to check - this is slow)")

        return True


async def main():
    """Run the test"""
    print()
    print("This test uploads a file directly to the Rust data plane")
    print("Make sure the Rust service is running:")
    print("  cd services/rust-data-plane")
    print("  ./start-dev.sh")
    print()
    input("Press Enter when ready...")
    print()

    try:
        success = await test_file_upload()

        if success:
            print()
            print("=" * 60)
            print("🎯 Next Steps:")
            print("=" * 60)
            print("1. ✅ Rust service is working!")
            print("2. 🔄 Now test with FastAPI:")
            print("      cd services/storage-service")
            print("      uvicorn app.main:app --reload")
            print("3. 🌐 Then test with frontend:")
            print("      cd frontend-clean")
            print("      npm run dev")
            print("4. 📤 Upload a file through the browser")
            print()
            return 0
        else:
            print()
            print("❌ Test failed. Check the errors above.")
            return 1

    except Exception as e:
        print()
        print(f"❌ Error: {e}")
        print()
        print("Make sure:")
        print("1. Rust service is running (./start-dev.sh)")
        print("2. Socket exists at /tmp/edge-storage-dataplane.sock")
        print("3. httpx is installed (pip install httpx)")
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
