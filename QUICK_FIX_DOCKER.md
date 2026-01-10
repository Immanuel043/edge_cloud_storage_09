# Quick Fix: Rebuild Docker Container

## What Was Fixed

1. **Updated Dockerfile** to install `shared-billing` package
2. **Updated docker-compose.yml** to use correct build context

## Rebuild Commands

Run these commands to rebuild and restart the backend:

```bash
cd /Users/immanraj/edge-cloud-storage-final-mvp/infrastructure

# Stop the storage service
docker-compose stop storage-service

# Rebuild with no cache
docker-compose build --no-cache storage-service

# Start the service
docker-compose up -d storage-service

# Watch logs to verify it starts successfully
docker logs edge-storage-service --tail 50 -f
```

## Expected Output

You should see:
```
INFO:     Started server process
INFO:     Waiting for application startup.
INFO:     Application startup complete.
INFO:     Uvicorn running on http://0.0.0.0:8000
```

## Verify the Fix

Once the container is running, verify the module is installed:

```bash
docker exec -it edge-storage-service python -c "import shared_billing; print('✅ shared_billing module loaded successfully!')"
```

## Test the API

```bash
# Health check
curl http://localhost:8001/api/v1/health

# Should return: {"status":"healthy"}
```

## If You See Errors

### Error: "No such file or directory: 'services/shared-billing'"

This means the build context is wrong. Verify docker-compose.yml has:
```yaml
storage-service:
  build:
    context: ..
    dockerfile: services/storage-service/Dockerfile
```

### Error: "Cannot find setup.py"

Check that `/services/shared-billing/setup.py` exists:
```bash
ls -la /Users/immanraj/edge-cloud-storage-final-mvp/services/shared-billing/
```

## Alternative: Run Backend Locally (Faster for Testing)

If rebuilding Docker is too slow, run the backend locally:

```bash
# Terminal 1: Backend
cd /Users/immanraj/edge-cloud-storage-final-mvp/services/storage-service
source venv/bin/activate
uvicorn app.main:app --reload --port 8001

# Terminal 2: Frontend
cd /Users/immanraj/edge-cloud-storage-final-mvp/frontend-clean
npm run dev
```

This way you can test the subscription UI immediately without waiting for Docker rebuild.
