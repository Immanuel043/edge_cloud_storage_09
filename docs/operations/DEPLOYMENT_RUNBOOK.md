# Deployment Runbook - Edge Cloud Storage

**Version**: 1.0.0
**Last Updated**: October 21, 2025
**Maintainer**: DevOps Team

---

## Table of Contents

1. [Pre-Deployment Checklist](#pre-deployment-checklist)
2. [Environment Setup](#environment-setup)
3. [Database Migration](#database-migration)
4. [Application Deployment](#application-deployment)
5. [Post-Deployment Verification](#post-deployment-verification)
6. [Rollback Procedures](#rollback-procedures)
7. [Troubleshooting](#troubleshooting)

---

## Pre-Deployment Checklist

### 1. Code & Configuration

- [ ] All code merged to `main` branch
- [ ] CI/CD pipeline passing (all tests green)
- [ ] Security scan completed (no critical vulnerabilities)
- [ ] Performance tests passed
- [ ] Environment variables configured
- [ ] Database backup completed
- [ ] Release notes prepared

### 2. Infrastructure

- [ ] Server capacity verified (CPU, memory, disk)
- [ ] Database connection pool sized correctly
- [ ] Redis cache warmed up
- [ ] CDN configured
- [ ] SSL certificates valid
- [ ] Load balancer health checks configured
- [ ] Monitoring dashboards ready

### 3. Team Coordination

- [ ] Deployment window scheduled
- [ ] Team notified (eng, ops, support)
- [ ] On-call engineer assigned
- [ ] Rollback plan reviewed
- [ ] Communication channels ready (Slack)

---

## Environment Setup

### Production Environment Variables

Create `.env.production`:

```bash
# ======================
# GENERAL CONFIGURATION
# ======================
ENVIRONMENT=production
APP_NAME="Edge Cloud Storage"
VERSION=1.0.0
SECRET_KEY=<generate-secure-key>
DEBUG=false

# ======================
# DATABASE
# ======================
DATABASE_URL=postgresql+asyncpg://user:pass@db-primary.internal:5432/edge_storage
DATABASE_POOL_SIZE=50
DATABASE_MAX_OVERFLOW=100

# Read replica for read-heavy operations
DATABASE_REPLICA_URL=postgresql+asyncpg://user:pass@db-replica.internal:5432/edge_storage

# ======================
# REDIS
# ======================
REDIS_URL=redis://redis-master.internal:6379/0
REDIS_MAX_CONNECTIONS=100

# ======================
# STORAGE PATHS
# ======================
CACHE_PATH=/mnt/ssd/storage/cache
WARM_PATH=/mnt/hdd/storage/warm
COLD_PATH=/mnt/s3/storage/cold
TEMP_PATH=/tmp/edge-storage
BACKUP_PATH=/mnt/backup/storage

# ======================
# SECURITY
# ======================
ENABLE_HTTPS=true
CORS_ORIGINS=["https://app.yourdomain.com","https://www.yourdomain.com"]

# JWT
ACCESS_TOKEN_EXPIRE_MINUTES=30
REFRESH_TOKEN_EXPIRE_DAYS=7
ALGORITHM=HS256

# OAuth2
GOOGLE_CLIENT_ID=<your-google-client-id>
GOOGLE_CLIENT_SECRET=<your-google-client-secret>
GITHUB_CLIENT_ID=<your-github-client-id>
GITHUB_CLIENT_SECRET=<your-github-client-secret>
MICROSOFT_CLIENT_ID=<your-microsoft-client-id>
MICROSOFT_CLIENT_SECRET=<your-microsoft-client-secret>

# ======================
# ML FEATURES
# ======================
ML_FEATURES_ENABLED=true
QUOTA_PREDICTION_ENABLED=true
STORAGE_OPTIMIZATION_ENABLED=true
AUTO_ORGANIZATION_ENABLED=true
CONTENT_RECOMMENDATIONS_ENABLED=true

# ======================
# MONITORING
# ======================
# Prometheus
PROMETHEUS_PORT=9090

# Jaeger
TRACING_ENABLED=true
JAEGER_AGENT_HOST=jaeger.internal
JAEGER_AGENT_PORT=6831

# Sentry
SENTRY_ENABLED=true
SENTRY_DSN=<your-sentry-dsn>
SENTRY_TRACES_SAMPLE_RATE=0.1
SENTRY_PROFILES_SAMPLE_RATE=0.1

# ======================
# PERFORMANCE
# ======================
CACHE_TTL_DEFAULT=300
QUERY_TIMEOUT=30
MAX_UPLOAD_SIZE=10737418240  # 10GB
CHUNK_SIZE=5242880  # 5MB

# ======================
# WORKERS
# ======================
WORKER_CONCURRENCY=4
QUOTA_PREDICTION_INTERVAL=14400  # 4 hours
STORAGE_OPTIMIZATION_INTERVAL=86400  # 24 hours
TIERING_WORKER_INTERVAL=3600  # 1 hour
```

### Generate Secrets

```bash
# Generate secure SECRET_KEY
python -c "import secrets; print(secrets.token_urlsafe(64))"

# Generate database password
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

---

## Database Migration

### Step 1: Backup Database

```bash
# Create timestamped backup
BACKUP_FILE="backup_$(date +%Y%m%d_%H%M%S).sql"

pg_dump -h db-primary.internal \
        -U postgres \
        -d edge_storage \
        -F c \
        -f "/mnt/backup/${BACKUP_FILE}"

# Verify backup
pg_restore --list "/mnt/backup/${BACKUP_FILE}" | head -20

echo "✅ Backup created: ${BACKUP_FILE}"
```

### Step 2: Test Migration (Staging)

```bash
# Run migration on staging first
cd services/storage-service

# Check current version
alembic current

# Review pending migrations
alembic history

# Dry run (if supported)
alembic upgrade head --sql > migration.sql
cat migration.sql  # Review SQL

# Apply migration to staging
alembic upgrade head

echo "✅ Staging migration complete"
```

### Step 3: Production Migration

```bash
# Set maintenance mode (optional)
# Display maintenance page to users

# Run production migration
cd services/storage-service
export DATABASE_URL="postgresql+asyncpg://user:pass@db-primary.internal:5432/edge_storage"

# Apply migration
alembic upgrade head

# Verify migration
alembic current
# Should show: 20251021_0003 (latest)

# Test critical queries
psql $DATABASE_URL -c "\d+ objects"  # Check indexes
psql $DATABASE_URL -c "SELECT COUNT(*) FROM objects"  # Sanity check

echo "✅ Production migration complete"
```

---

## Application Deployment

### Option A: Docker Compose (Simple)

```bash
# Pull latest images
docker-compose pull

# Stop old containers
docker-compose down

# Start new containers
docker-compose up -d

# Verify containers
docker-compose ps

# Check logs
docker-compose logs -f storage-service
```

### Option B: Kubernetes (Recommended)

```bash
# Update image tag
kubectl set image deployment/edge-storage-api \
  api=edge-storage-api:v1.0.0

# Or apply new manifest
kubectl apply -f k8s/deployment.yaml

# Watch rollout
kubectl rollout status deployment/edge-storage-api

# Verify pods
kubectl get pods -l app=edge-storage-api

# Check logs
kubectl logs -f deployment/edge-storage-api
```

### Option C: Manual Deployment

```bash
# 1. Stop old service
sudo systemctl stop edge-storage-api

# 2. Update code
cd /opt/edge-storage
git pull origin main

# 3. Install dependencies
cd services/storage-service
pip install -r requirements.txt

# 4. Run migrations
alembic upgrade head

# 5. Restart service
sudo systemctl start edge-storage-api

# 6. Check status
sudo systemctl status edge-storage-api
```

---

## Post-Deployment Verification

### 1. Health Checks

```bash
# Check health endpoint
curl https://api.yourdomain.com/api/v1/health | jq

# Expected response:
# {
#   "status": "healthy",
#   "checks": {
#     "database": "healthy",
#     "redis": "healthy",
#     "background_dedup": "running",
#     ...
#   }
# }

# Check readiness
curl https://api.yourdomain.com/api/v1/ready | jq

# Check live
curl https://api.yourdomain.com/api/v1/live | jq
```

### 2. Smoke Tests

```bash
# Run automated smoke tests
cd tests/smoke
pytest test_smoke.py -v

# Manual smoke tests:

# 1. Login
TOKEN=$(curl -X POST https://api.yourdomain.com/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test123"}' \
  | jq -r '.access_token')

# 2. List files
curl https://api.yourdomain.com/api/v1/files \
  -H "Authorization: Bearer $TOKEN" | jq

# 3. Upload small file
curl -X POST https://api.yourdomain.com/api/v1/upload/init \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"file_name":"test.txt","file_size":100,"mime_type":"text/plain"}' \
  | jq

# 4. Search
curl -X POST https://api.yourdomain.com/api/v1/search \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"test","limit":10}' | jq

echo "✅ Smoke tests passed"
```

### 3. Performance Verification

```bash
# Check response times
curl -w "\nTime: %{time_total}s\n" \
  https://api.yourdomain.com/api/v1/files \
  -H "Authorization: Bearer $TOKEN"

# Should be < 100ms

# Check Grafana dashboards
open https://grafana.yourdomain.com/d/main-dashboard

# Verify metrics:
# - P95 latency < 150ms
# - Error rate < 1%
# - Cache hit rate > 80%
```

### 4. Monitoring Verification

```bash
# Check Prometheus targets
curl https://prometheus.yourdomain.com/api/v1/targets | jq

# Check Grafana
open https://grafana.yourdomain.com

# Check Sentry
open https://sentry.io/organizations/your-org/issues/

# Check Jaeger
open https://jaeger.yourdomain.com
```

---

## Rollback Procedures

### Immediate Rollback (< 1 hour)

```bash
# For Kubernetes
kubectl rollout undo deployment/edge-storage-api

# Verify rollback
kubectl rollout status deployment/edge-storage-api

# For Docker Compose
docker-compose down
docker-compose up -d --force-recreate
```

### Full Rollback (Database Migration)

```bash
# 1. Stop application
kubectl scale deployment/edge-storage-api --replicas=0

# 2. Restore database from backup
BACKUP_FILE="backup_20251021_120000.sql"  # Use pre-deployment backup

pg_restore -h db-primary.internal \
           -U postgres \
           -d edge_storage \
           -c \  # Clean (drop) existing objects
           "/mnt/backup/${BACKUP_FILE}"

# 3. Downgrade migration
cd services/storage-service
alembic downgrade -1  # Or specific version

# 4. Restart with previous version
kubectl set image deployment/edge-storage-api \
  api=edge-storage-api:v0.9.0

kubectl scale deployment/edge-storage-api --replicas=3

# 5. Verify
curl https://api.yourdomain.com/api/v1/health | jq
```

---

## Troubleshooting

### Issue: High Error Rate

```bash
# Check application logs
kubectl logs -f deployment/edge-storage-api --tail=100

# Check error metrics
curl https://prometheus.yourdomain.com/api/v1/query?query=storage_errors_total

# Check Sentry for details
open https://sentry.io/organizations/your-org/issues/?query=is:unresolved

# Common causes:
# - Database connection pool exhausted
# - Redis connection issues
# - Missing environment variables
# - Rate limiting too aggressive
```

### Issue: Slow Response Times

```bash
# Check performance dashboard
open https://grafana.yourdomain.com/d/performance-dashboard

# Check slow queries
curl https://api.yourdomain.com/api/v1/performance/queries/slow \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq

# Check database
psql $DATABASE_URL -c "SELECT * FROM pg_stat_activity WHERE state = 'active'"

# Check cache hit rate
curl https://api.yourdomain.com/api/v1/performance/cache/stats \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```

### Issue: Database Migration Failed

```bash
# Check migration status
alembic current

# Check error logs
tail -f /var/log/edge-storage/alembic.log

# Manual fix if needed
psql $DATABASE_URL

# Then:
# 1. Fix the issue manually
# 2. Mark migration as complete:
alembic stamp head

# Or rollback:
alembic downgrade -1
```

### Issue: Workers Not Running

```bash
# Check worker status
kubectl get pods -l component=worker

# Check logs
kubectl logs -f deployment/quota-prediction-worker

# Restart workers
kubectl rollout restart deployment/quota-prediction-worker
kubectl rollout restart deployment/storage-optimization-worker
```

---

## Emergency Contacts

- **On-Call Engineer**: [PagerDuty]
- **DevOps Lead**: devops@yourdomain.com
- **Engineering Manager**: eng@yourdomain.com
- **Slack Channel**: #edge-storage-alerts

---

## Deployment Schedule

### Recommended Windows

- **Production**: Tuesday/Wednesday 10:00-12:00 UTC
- **Staging**: Monday/Thursday anytime
- **Emergency**: Coordinate with on-call

### Deployment Frequency

- **Major Releases**: Monthly (1st Tuesday)
- **Minor Releases**: Bi-weekly
- **Hotfixes**: As needed
- **Security Patches**: Within 24 hours

---

*Deployment Runbook - Version 1.0.0*
*For questions or issues, contact DevOps team*
