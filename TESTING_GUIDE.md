# Testing Guide - Performance Optimizations

## Quick Start Testing

### 1. Rebuild and Deploy

```bash
# From project root
cd edge-cloud-storage-final-mvp

# Rebuild storage service with new dependencies
docker-compose build storage-service

# Restart all services
docker-compose up -d

# Check logs for hardware AES-NI detection
docker logs edge-storage-service | grep "Encryption initialized"
```

**Expected Output:**
```
✅ Hardware AES-NI acceleration enabled (pycryptodome)
🔐 Encryption initialized: pycryptodome (AES-NI) (Platform: Linux, Expected performance: 10-20x faster)
```

---

### 2. Test Hardware AES-NI Detection

#### Check Current Platform
```bash
# macOS
sysctl -a | grep -i aes

# Linux
cat /proc/cpuinfo | grep -i aes

# Docker (Linux container)
docker exec edge-storage-service cat /proc/cpuinfo | grep -i aes
```

---

### 3. Performance Testing - Single File Download

#### Test Download Speed (400MB file should be ~3 seconds)
```bash
# Time the download
time curl -o downloaded.bin \
  "http://localhost:8001/api/v1/files/$FILE_ID/download" \
  -H "Authorization: Bearer $TOKEN"

# Expected result:
# real    0m3.2s   (vs 12s before optimization)
```

---

## Expected Performance Metrics

### Download Speed (400MB file)
- **Before**: 12 seconds
- **After**: 3 seconds
- **Improvement**: 75% faster ✅

### Concurrent Users
- **Before**: 25 users
- **After**: 100 users
- **Improvement**: 4x more ✅

### Memory per Download
- **Before**: 300MB
- **After**: 100MB
- **Improvement**: 67% less ✅

---

**Last Updated**: 2025-10-25
**Status**: Ready for testing
**Version**: v1.0 (Hardware AES-NI + Prefetching)

