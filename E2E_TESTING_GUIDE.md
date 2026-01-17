# End-to-End Testing Guide
## Frontend → FastAPI → Rust Data Plane

This guide shows you how to test file uploads from your React frontend all the way through to the Rust data plane.

---

## 🎯 Quick Test (3 Terminals)

### Terminal 1: Start Rust Data Plane
```bash
cd services/rust-data-plane
./start-dev.sh
```

**Wait for:** `🚀 Starting Unix Domain Socket server`

### Terminal 2: Start FastAPI Backend
```bash
cd services/storage-service

# Set environment variables
export DATABASE_URL="postgresql://edge_admin:secure_password@localhost:5432/edge_cloud"
export REDIS_URL="redis://localhost:6379"
export RUST_DATAPLANE_ENABLED=true
export RUST_DATAPLANE_SOCKET=/tmp/edge-storage-dataplane.sock
export RUST_DATAPLANE_ROLLOUT_PERCENTAGE=100  # 100% traffic to Rust

# Start FastAPI
uvicorn app.main:app --reload --port 8000
```

**Wait for:** `Uvicorn running on http://127.0.0.1:8000`

### Terminal 3: Start Frontend
```bash
cd frontend-clean
npm run dev
```

**Wait for:** `Local: http://localhost:5173/` (or your Vite port)

---

## 🧪 Test Upload Flow

### 1. Open Browser
```
http://localhost:5173
```

### 2. Login / Register
- Create account or login
- Navigate to upload page

### 3. Upload a File
- Select any file (try different sizes: 1MB, 10MB, 100MB)
- Click upload
- Watch the progress bar

### 4. Monitor in Real-Time

**Terminal 1 (Rust logs):**
```
📤 Testing Non-ZK upload...
✅ Non-ZK upload successful:
   - Hash: sha256:abc123...
   - Original size: 33554432 bytes
   - Encrypted size: 33554560 bytes
   - Compressed: true
```

**Terminal 2 (FastAPI logs):**
```
INFO: Processing chunk 0 via Rust data plane
INFO: Chunk 0 processed: hash=sha256:abc123...
```

---

## 🎚️ Testing Different Rollout Percentages

### Test with 0% (All Python - Baseline)
```bash
# Terminal 2
export RUST_DATAPLANE_ROLLOUT_PERCENTAGE=0
# Restart FastAPI (Ctrl+C and run uvicorn again)

# Upload file - will use Python processing
# Should take longer (baseline speed)
```

### Test with 50% (Half and Half)
```bash
export RUST_DATAPLANE_ROLLOUT_PERCENTAGE=50
# Restart FastAPI

# Upload multiple files - about 50% will use Rust
# Check logs to see which path each file takes
```

### Test with 100% (All Rust)
```bash
export RUST_DATAPLANE_ROLLOUT_PERCENTAGE=100
# Restart FastAPI

# Upload file - will use Rust processing
# Should be 3-4x faster
```

---

## 📊 Performance Comparison

### Baseline Test (Python - 0%)
```bash
# Upload 400MB file
# Terminal 2 logs will show:
# "Processing chunk X/Y" (Python path)
# Expected time: 40-50 seconds
```

### Rust Test (100%)
```bash
# Upload same 400MB file
# Terminal 1 logs will show Rust processing
# Terminal 2 logs will show "via Rust data plane"
# Expected time: 10-15 seconds (3-4x faster!)
```

---

## 🔍 What to Look For

### ✅ Success Indicators

**In Rust logs (Terminal 1):**
```
🚀 Starting Edge Storage Data Plane v0.1.0
Hardware AES-NI: ✅ Available
💾 Storage initialized
🚀 Starting Unix Domain Socket server
```

**In FastAPI logs (Terminal 2):**
```
INFO: Rust data plane client initialized
INFO: Processing chunk via Rust
DEBUG: Chunk processed by Rust: file_id=xxx, hash=sha256:...
```

**In Browser:**
- Upload progress bar moves smoothly
- File shows as "Complete" after upload
- File appears in file list
- Can download and verify file matches original

### ❌ Error Indicators

**Rust Service Not Running:**
```
FastAPI logs:
ERROR: Rust processing failed, falling back to Python: Connection refused
```
**Solution:** Start Rust service (Terminal 1)

**Socket Not Found:**
```
ERROR: [Errno 2] No such file or directory: '/tmp/edge-storage-dataplane.sock'
```
**Solution:** Check socket path matches in both services

**Import Error:**
```
ModuleNotFoundError: No module named 'httpx'
```
**Solution:** `pip install httpx`

---

## 🐛 Debugging Tips

### Check if Services are Connected

```bash
# Check if socket exists
ls -la /tmp/edge-storage-dataplane.sock

# Should show:
# srw-------  1 user  wheel  0 Jan 16 10:30 /tmp/edge-storage-dataplane.sock
```

### Test Socket Manually

```bash
# From Python
python3 << EOF
import socket
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect('/tmp/edge-storage-dataplane.sock')
print('✅ Connected!')
EOF
```

### Enable Debug Logging

**Rust (Terminal 1):**
```bash
export RUST_LOG=debug,edge_storage_dataplane=trace
./start-dev.sh
```

**FastAPI (Terminal 2):**
```bash
export LOG_LEVEL=DEBUG
uvicorn app.main:app --reload --port 8000 --log-level debug
```

### Monitor in Real-Time

**Watch Rust logs:**
```bash
# In a 4th terminal
tail -f /tmp/edge-storage.log  # if you redirect logs
```

**Watch Network Traffic:**
```bash
# Monitor Unix socket
sudo dtrace -n 'syscall::connect*:entry /arg0 == 1/ { printf("%s", copyinstr(arg1)); }'
```

---

## 📈 Verify Performance Improvement

### 1. Upload Small File (10MB)
```
Python:  ~2-3 seconds
Rust:    ~0.5-1 second
Speedup: 2-3x
```

### 2. Upload Medium File (100MB)
```
Python:  ~15-20 seconds
Rust:    ~3-5 seconds
Speedup: 3-4x
```

### 3. Upload Large File (1GB)
```
Python:  ~3-5 minutes
Rust:    ~45-60 seconds
Speedup: 3-5x
```

### 4. Check Memory Usage

```bash
# While uploading large file

# Python baseline
ps aux | grep uvicorn
# Memory: ~500MB - 2GB

# With Rust
ps aux | grep -E "uvicorn|edge-storage-dataplane"
# FastAPI: ~200-400MB (reduced!)
# Rust: ~100-300MB
# Total: Less than Python alone
```

---

## 🎬 Complete Test Scenario

### Scenario: Upload a 100MB File

**Step 1:** Ensure all 3 services are running
```bash
# Check Rust
curl --unix-socket /tmp/edge-storage-dataplane.sock http://localhost/health

# Check FastAPI
curl http://localhost:8000/health

# Check Frontend
curl http://localhost:5173
```

**Step 2:** Open browser and upload
```
1. Go to http://localhost:5173
2. Login
3. Click "Upload File"
4. Select 100MB file
5. Click "Upload"
```

**Step 3:** Watch the terminals
```
Terminal 1 (Rust):   Shows chunk processing in real-time
Terminal 2 (FastAPI): Shows "Processing chunk X via Rust data plane"
Terminal 3 (Frontend): Shows Vite server logs
```

**Step 4:** Verify upload
```
1. Browser shows "Upload complete"
2. File appears in file list
3. Download the file
4. Verify hash matches original
```

**Step 5:** Check performance
```bash
# Upload took ~3-5 seconds (vs 15-20 with Python)
# Memory stayed under 500MB total
# CPU spiked briefly but returned to normal
```

---

## 🔄 Testing ZK Mode (Optional)

If you want to test Zero-Knowledge mode:

**Frontend:** Enable ZK mode in upload settings
**Expected:**
- Frontend encrypts file before sending
- Rust service only hashes (doesn't encrypt)
- Terminal 1 logs: "ZK chunk processed"

---

## ✅ Success Checklist

- [ ] Rust service starts without errors
- [ ] FastAPI connects to Rust socket
- [ ] Frontend connects to FastAPI
- [ ] Can upload small file (1MB)
- [ ] Can upload medium file (100MB)
- [ ] Can upload large file (1GB)
- [ ] Upload is 3-4x faster with Rust
- [ ] Memory usage is lower with Rust
- [ ] Can download and verify files
- [ ] Logs show "via Rust data plane"
- [ ] No errors in any terminal
- [ ] Browser shows no errors

---

## 🚀 Next Steps After Testing

Once everything works:

1. **Benchmark:** Upload the same file with 0% and 100% rollout, compare times
2. **Load Test:** Upload multiple files simultaneously
3. **Monitor:** Check memory and CPU usage
4. **Gradual Rollout:** Start with 1%, then 10%, 50%, 100%
5. **Production:** Deploy with Docker Compose

---

## 💡 Quick Commands Reference

```bash
# Start all services
tmux new-session \; \
  send-keys 'cd services/rust-data-plane && ./start-dev.sh' C-m \; \
  split-window -v \; \
  send-keys 'cd services/storage-service && uvicorn app.main:app --reload' C-m \; \
  split-window -v \; \
  send-keys 'cd frontend-clean && npm run dev' C-m

# Stop all services
pkill -f edge-storage-dataplane
pkill -f uvicorn
pkill -f vite
```

---

**Ready to test!** Start with the 3-terminal setup at the top and upload a file through your frontend.
