# Docker Rebuild Instructions

## Issue
The backend Docker container doesn't have the `shared_billing` module installed, causing this error:
```
ModuleNotFoundError: No module named 'shared_billing'
```

## Fix Applied
Updated `/services/storage-service/Dockerfile` to install the shared-billing package during the build process.

## Steps to Rebuild and Restart

### Option 1: Rebuild and Restart (Recommended)
```bash
cd infrastructure

# Stop the current container
docker-compose stop storage-service

# Rebuild the container with the updated Dockerfile
docker-compose build --no-cache storage-service

# Start the container
docker-compose up -d storage-service

# Check logs to verify it's working
docker logs edge-storage-service --tail 100 -f
```

### Option 2: Rebuild All Services (If you want a clean state)
```bash
cd infrastructure

# Stop all services
docker-compose down

# Rebuild storage-service
docker-compose build --no-cache storage-service

# Start all services
docker-compose up -d

# Check status
docker-compose ps
```

### Option 3: Quick Development Fix (Without Docker Rebuild)
If you want to test without rebuilding Docker, you can run the backend locally:

```bash
# Terminal 1: Start backend locally
cd services/storage-service
source venv/bin/activate
uvicorn app.main:app --reload --port 8001

# Terminal 2: Start frontend
cd frontend-clean
npm run dev
```

## Verification

After rebuilding, verify the module is installed:

```bash
# Enter the container
docker exec -it edge-storage-service bash

# Check if shared_billing is installed
python -c "import shared_billing; print('Success!')"

# Exit
exit
```

## Expected Output

If successful, you should see:
- No `ModuleNotFoundError`
- Backend starts successfully on port 8001
- Health check passes: `curl http://localhost:8001/api/v1/health`

## Troubleshooting

### If rebuild fails with "no such file or directory":
The Dockerfile uses `COPY ../shared-billing` which requires the build context to include the parent directory.

**Fix:** Update docker-compose.yml to use the parent directory as build context:

```yaml
storage-service:
  build:
    context: ..  # Changed from ../services/storage-service
    dockerfile: services/storage-service/Dockerfile
```

Then rebuild:
```bash
cd infrastructure
docker-compose build --no-cache storage-service
docker-compose up -d storage-service
```

### If you see "shared-billing" errors during pip install:
Make sure `/services/shared-billing/setup.py` exists and is properly configured.

## Alternative: Install in Running Container (Temporary)

For quick testing without rebuild:

```bash
# Copy shared-billing into container
docker cp ../services/shared-billing edge-storage-service:/tmp/

# Install inside container
docker exec -it edge-storage-service bash
cd /tmp/shared-billing
pip install -e .
exit

# Restart container
docker-compose restart storage-service
```

**Note:** This is temporary and will be lost when container is recreated.
