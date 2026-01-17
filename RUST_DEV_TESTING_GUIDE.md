# Rust Data Plane - Development Testing Guide

This guide shows you how to test the Rust data plane on your local dev environment **without needing the full CD infrastructure**.

## Quick Start (Standalone Testing)

### Option 1: Test Rust Service Only (Recommended First)

This tests just the Rust service independently.

#### Step 1: Start the Rust Service

```bash
# Terminal 1 - Start Rust service
cd services/rust-data-plane
./start-dev.sh
```

You should see:
```
🚀 Starting Rust Data Plane v0.1.0
Hardware AES-NI: ✅ Available
📊 Prometheus metrics registered
💾 Storage initialized
🛡️  Resilience components initialized
🔧 Server configuration loaded
🌐 Server initialized
🚀 Starting Unix Domain Socket server
```

#### Step 2: Test with Python Client

```bash
# Terminal 2 - Run tests
cd services/storage-service
python test_rust_client.py
```

Expected output:
```
============================================================
Rust Data Plane Client Test Suite
============================================================

🏥 Testing health check...
✅ Health check passed: {'status': 'healthy'}

📤 Testing Non-ZK upload...
✅ Non-ZK upload successful:
   - Success: True
   - Hash: sha256:abc123...
   - Original size: 24000 bytes
   - Encrypted size: 24128 bytes
   - Compressed: True

📤 Testing ZK upload...
✅ ZK upload successful:
   - Success: True
   - Hash: sha256:xyz789...

⚡ Testing performance...
✅ Performance test completed:
   - Chunk size: 32.0 MB
   - Duration: 0.15s
   - Throughput: 213.3 MB/s
   - Success: True

============================================================
Test Summary
============================================================
✅ PASS - Health Check
✅ PASS - Non-ZK Upload
✅ PASS - ZK Upload
✅ PASS - Performance

Total: 4/4 tests passed

🎉 All tests passed!
```

---

## Option 2: Test with FastAPI Integration

This tests the full integration with your existing FastAPI services.

### Prerequisites

1. Rust service running (see Option 1, Step 1)
2. PostgreSQL running
3. Redis running

### Step 1: Start Required Services

```bash
# Start PostgreSQL (if not running)
brew services start postgresql@14
# OR
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:14

# Start Redis (if not running)
brew services start redis
# OR
docker run -d -p 6379:6379 redis:7
```

### Step 2: Start FastAPI Storage Service

```bash
# Terminal 2 - Start FastAPI
cd services/storage-service

# Set environment variables
export DATABASE_URL="postgresql://user:pass@localhost:5432/storage"
export REDIS_URL="redis://localhost:6379"
export RUST_DATAPLANE_ENABLED=true
export RUST_DATAPLANE_ROLLOUT_PERCENTAGE=100  # 100% traffic to Rust

# Start FastAPI
uvicorn app.main:app --reload --port 8000
```

### Step 3: Test Upload Flow

```bash
# Terminal 3 - Test upload
curl -X POST http://localhost:8000/api/upload \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@/path/to/testfile.txt"
```

---

## Option 3: Minimal Docker Compose (No Full CD)

Create a minimal `docker-compose.dev.yml` for local testing:

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:14
    environment:
      POSTGRES_DB: storage
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7
    ports:
      - "6379:6379"

  rust-dataplane:
    build:
      context: ./services/rust-data-plane
      dockerfile: Dockerfile.dev
    environment:
      - SOCKET_PATH=/tmp/edge-storage-dataplane.sock
      - STORAGE_ROOT=/data/storage
      - RUST_LOG=info,edge_storage_dataplane=debug
    volumes:
      - ./services/rust-data-plane:/app
      - rust_storage:/data/storage
      - rust_socket:/tmp
    command: cargo run --release

volumes:
  postgres_data:
  rust_storage:
  rust_socket:
```

Start with:
```bash
docker-compose -f docker-compose.dev.yml up
```

---

## Troubleshooting

### 1. Service Won't Start

**Error: Socket already exists**
```bash
# Remove stale socket
rm -f /tmp/edge-storage-dataplane.sock

# Then restart
./start-dev.sh
```

**Error: Permission denied**
```bash
# Check socket permissions
ls -la /tmp/edge-storage-dataplane.sock

# Should be: srw------- (socket, owner only)
```

### 2. Python Tests Fail

**Error: Connection refused**
```bash
# Check if Rust service is running
ps aux | grep edge-storage-dataplane

# Check socket exists
ls -la /tmp/edge-storage-dataplane.sock

# Check Rust logs for errors
# (look in Terminal 1)
```

**Error: Module not found**
```bash
# Install Python dependencies
cd services/storage-service
pip install httpx
```

### 3. FastAPI Integration Issues

**Error: RUST_DATAPLANE_ENABLED not working**
```bash
# Verify environment variables
echo $RUST_DATAPLANE_ENABLED
echo $RUST_DATAPLANE_ROLLOUT_PERCENTAGE

# Make sure to export them
export RUST_DATAPLANE_ENABLED=true
```

**Error: Import errors in FastAPI**
```bash
# The integration code is in rust_integration_example.py
# You need to modify upload.py to use it (see instructions below)
```

---

## Step-by-Step Integration into Existing FastAPI

If you want to integrate with your existing upload endpoint:

### 1. Locate the Upload Handler

```bash
# Find the current upload processing
grep -n "process_chunk_cpu_bound" services/storage-service/app/routers/upload.py
```

### 2. Add Import

Add to the top of `upload.py`:
```python
from ..services.rust_dataplane_client import get_rust_client
from ..services.rust_integration_example import should_use_rust_dataplane
import os
```

### 3. Modify Upload Logic

Find the section around line 156-169 where chunks are processed:

**Before:**
```python
encrypted_chunk, original_hash = await loop.run_in_executor(
    executor,
    process_chunk_cpu_bound,
    chunk_data,
    file_key,
    chunk_index,
    use_compression,
)
```

**After:**
```python
# Check if we should use Rust data plane
use_rust = should_use_rust_dataplane(str(current_user.id))

if use_rust:
    try:
        client = get_rust_client()
        result = await client.process_non_zk_chunk(
            chunk_data=chunk_data,
            file_id=upload_id,
            chunk_index=chunk_index,
            compress=use_compression,
            filename=session.get("filename"),
            file_size=session.get("file_size"),
        )

        # Extract hash
        original_hash = result["hash"]

        # Note: Chunk is already stored by Rust service
        # You may need to adjust the flow to not expect encrypted_chunk
        encrypted_chunk = b""  # Placeholder

    except Exception as e:
        logger.warning(f"Rust processing failed, falling back to Python: {e}")
        # Fallback to Python
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
```

### 4. Enable Feature Flag

```bash
# Start with 1% rollout
export RUST_DATAPLANE_ENABLED=true
export RUST_DATAPLANE_ROLLOUT_PERCENTAGE=1

# Gradually increase
export RUST_DATAPLANE_ROLLOUT_PERCENTAGE=10   # 10%
export RUST_DATAPLANE_ROLLOUT_PERCENTAGE=50   # 50%
export RUST_DATAPLANE_ROLLOUT_PERCENTAGE=100  # 100%
```

---

## Testing Checklist

- [ ] Rust service starts without errors
- [ ] Socket file created at `/tmp/edge-storage-dataplane.sock`
- [ ] Storage directory created at `/tmp/edge-storage`
- [ ] Python health check passes
- [ ] Non-ZK upload test passes
- [ ] ZK upload test passes
- [ ] Performance test shows throughput > 100 MB/s
- [ ] FastAPI service starts (if testing integration)
- [ ] File upload works through FastAPI (if testing integration)
- [ ] Logs show "Rust processing" messages (if feature flag enabled)

---

## Performance Verification

After integration, verify performance improvements:

### 1. Benchmark Upload Speed

```bash
# Upload a 400MB file
time curl -X POST http://localhost:8000/api/upload \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@large-file-400mb.bin"

# Expected:
# Python baseline: 40-50 seconds
# Rust target: 10-15 seconds
```

### 2. Monitor Memory Usage

```bash
# While uploading, check memory
ps aux | grep -E "(uvicorn|edge-storage-dataplane)"

# Expected:
# Python baseline: ~4GB for 100 concurrent uploads
# Rust target: ~1.3GB for 100 concurrent uploads
```

### 3. Check Metrics (Future)

Once metrics endpoint is added:
```bash
curl http://localhost:9090/metrics | grep chunk_processing
```

---

## Development Workflow

### Daily Development

```bash
# Terminal 1: Rust service (auto-reload on code changes)
cd services/rust-data-plane
cargo watch -x 'run --release'

# Terminal 2: FastAPI service
cd services/storage-service
uvicorn app.main:app --reload

# Terminal 3: Run tests
python test_rust_client.py
```

### Making Changes

1. Edit Rust code in `services/rust-data-plane/src/`
2. Tests run automatically (if using `cargo watch`)
3. Or manually: `cargo test && cargo build --release`
4. Service auto-restarts
5. Test with Python client

### Debugging

```bash
# Enable debug logging
export RUST_LOG=debug,edge_storage_dataplane=trace

# Or for specific modules
export RUST_LOG=edge_storage_dataplane::server=trace

# View logs in real-time
./start-dev.sh | tee rust-service.log
```

---

## What You DON'T Need for Dev Testing

❌ Kubernetes cluster
❌ Full CD pipeline
❌ Docker registry
❌ Load balancers
❌ Production databases

## What You DO Need

✅ Rust installed (you have this)
✅ Python 3.11+ (you have this)
✅ Local PostgreSQL (optional, only for FastAPI integration)
✅ Local Redis (optional, only for FastAPI integration)

---

## Summary

**Easiest path for testing RIGHT NOW:**

```bash
# Terminal 1
cd services/rust-data-plane
./start-dev.sh

# Terminal 2 (wait for Rust service to start)
cd services/storage-service
python test_rust_client.py
```

That's it! No Docker, no Kubernetes, no CD infrastructure needed for basic testing.

Once you're happy with standalone testing, you can integrate with FastAPI and test the full upload flow.
