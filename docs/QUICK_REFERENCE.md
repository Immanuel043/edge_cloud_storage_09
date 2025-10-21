# Edge Cloud Storage - Quick Reference Card

**Version**: 1.0.0 | **Status**: Production Ready | **Date**: October 21, 2025

---

## 🚀 Quick Start

### Development (Local)

```bash
# 1. Start infrastructure
docker-compose up -d

# 2. Start backend
cd services/storage-service
uvicorn app.main:app --reload --port 8001

# 3. Start frontend
cd frontend-clean
npm run dev
```

### Production (Kubernetes)

```bash
# Deploy
kubectl apply -f k8s/

# Check status
kubectl get pods -n production

# Scale
kubectl scale deployment/edge-storage-api --replicas=5
```

---

## 🔗 Access URLs

| Service | URL | Credentials |
|---------|-----|-------------|
| Frontend | http://localhost:3000 | - |
| Backend API | http://localhost:8001 | - |
| API Docs | http://localhost:8001/docs | - |
| Prometheus | http://localhost:9090 | - |
| Grafana | http://localhost:3001 | admin/admin |
| Jaeger | http://localhost:16686 | - |

---

## 📊 Key Metrics

### Performance Targets

| Metric | Target | Command to Check |
|--------|--------|------------------|
| API P95 Latency | <100ms | Grafana → Performance Dashboard |
| Cache Hit Rate | >80% | Grafana → Main Dashboard |
| Error Rate | <1% | Grafana → Main Dashboard |
| Uptime SLA | 99.9% | Grafana → Main Dashboard |

### Resource Limits

| Resource | Limit | Alert Threshold |
|----------|-------|-----------------|
| CPU Usage | 80% | >80% for 5 min |
| Memory Usage | 7 GB | >7 GB for 5 min |
| Disk Space | 85% | <15% remaining |
| DB Connections | 50 | >45 active |

---

## 🚨 Alert Severity Levels

| Level | Response Time | Examples |
|-------|---------------|----------|
| **P0 - Critical** | Immediate | ServiceDown, SLAViolation |
| **P1 - High** | <1 hour | HighErrorRate, PoolExhausted |
| **P2 - Medium** | <4 hours | HighLatency, HighCPUUsage |
| **P3 - Low** | <24 hours | LowCacheHitRate |

---

## 🔧 Common Operations

### Health Check

```bash
curl http://localhost:8001/api/v1/health
```

Expected response:
```json
{
  "status": "healthy",
  "database": "connected",
  "redis": "connected",
  "storage": "mounted",
  "version": "1.0.0"
}
```

### View Logs

```bash
# Kubernetes
kubectl logs -f deployment/edge-storage-api --tail=100

# Docker Compose
docker-compose logs -f storage-api --tail=100
```

### Database Migration

```bash
cd services/storage-service

# Check current version
alembic current

# Upgrade to latest
alembic upgrade head

# Rollback one version
alembic downgrade -1
```

### Restart Services

```bash
# Kubernetes
kubectl rollout restart deployment/edge-storage-api

# Docker Compose
docker-compose restart storage-api
```

### Scale Horizontally

```bash
# Kubernetes
kubectl scale deployment/edge-storage-api --replicas=10

# Check pods
kubectl get pods -l app=edge-storage-api
```

---

## 🐛 Troubleshooting

### Issue: High Error Rate (429)

**Symptoms**: Spike in 429 errors

**Quick Fix**:
```bash
# Check rate-limited IPs
kubectl logs deployment/edge-storage-api | grep "429" | head -20

# Temporary increase (if legitimate traffic)
kubectl edit configmap rate-limit-config
kubectl rollout restart deployment/edge-storage-api
```

### Issue: Database Connection Pool Exhausted

**Symptoms**: "too many connections" errors

**Quick Fix**:
```bash
# Check active connections
psql $DATABASE_URL -c "SELECT count(*) FROM pg_stat_activity WHERE state = 'active'"

# Kill long-running queries
psql $DATABASE_URL -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'active' AND now() - query_start > interval '5 minutes'"

# Increase pool size (temporary)
kubectl set env deployment/edge-storage-api DATABASE_POOL_SIZE=100
```

### Issue: Redis Memory Full

**Symptoms**: Cache misses increasing, OOM errors

**Quick Fix**:
```bash
# Check Redis memory
redis-cli -h redis-master.internal info memory

# Clear old cache entries
redis-cli -h redis-master.internal --scan --pattern "query_cache:*" | xargs redis-cli -h redis-master.internal del

# Set LRU eviction
redis-cli -h redis-master.internal config set maxmemory-policy allkeys-lru
```

### Issue: Slow File Uploads

**Symptoms**: Upload timeouts, slow chunks

**Quick Fix**:
```bash
# Check storage I/O
df -h /mnt/ssd/storage
iostat -x 1 5

# Increase chunk size
kubectl set env deployment/edge-storage-api CHUNK_SIZE=10485760  # 10MB

# Enable parallel processing
kubectl set env deployment/edge-storage-api PARALLEL_CHUNKS=true
```

---

## 🔄 Rollback Procedures

### Application Rollback (Kubernetes)

```bash
# Check rollout history
kubectl rollout history deployment/edge-storage-api

# Rollback to previous version
kubectl rollout undo deployment/edge-storage-api

# Rollback to specific revision
kubectl rollout undo deployment/edge-storage-api --to-revision=3

# Verify rollback
kubectl rollout status deployment/edge-storage-api
```

### Database Rollback

```bash
cd services/storage-service

# Check current version
alembic current

# Rollback one migration
alembic downgrade -1

# Rollback to specific version
alembic downgrade <revision_id>
```

---

## 📈 Monitoring Quick Access

### Grafana Dashboards

1. **Main Dashboard**: Overall system health
   - http://localhost:3001/d/main-dashboard

2. **ML Features Dashboard**: AI/ML performance
   - http://localhost:3001/d/ml-features-dashboard

3. **Performance Dashboard**: Deep performance analysis
   - http://localhost:3001/d/performance-dashboard

### Prometheus Queries

```promql
# Error rate (%)
(sum(rate(storage_errors_total[5m])) / sum(rate(http_requests_total[5m]))) * 100

# P95 latency (ms)
histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m])) * 1000

# Cache hit rate (%)
(rate(keyspace_hits[5m]) / (rate(keyspace_hits[5m]) + rate(keyspace_misses[5m]))) * 100

# Database connections
storage_db_connections_active
```

### Jaeger Tracing

Access: http://localhost:16686

**Search for slow traces**:
1. Select service: `edge-storage-api`
2. Set min duration: `100ms`
3. Click "Find Traces"
4. Identify bottlenecks in trace timeline

---

## 🔐 Security Quick Reference

### Generate Secret Key

```bash
openssl rand -base64 32
```

### Check Audit Logs

```bash
# Last 100 critical events
psql $DATABASE_URL -c "SELECT * FROM audit_logs WHERE severity = 'critical' ORDER BY timestamp DESC LIMIT 100"

# Failed login attempts
psql $DATABASE_URL -c "SELECT ip_address, COUNT(*) FROM audit_logs WHERE event_type LIKE '%login.fail%' AND timestamp > NOW() - INTERVAL '1 hour' GROUP BY ip_address ORDER BY COUNT(*) DESC LIMIT 20"
```

### Block Abusive IP

```bash
# Add to rate limit config
kubectl edit configmap rate-limit-config

# Or use firewall/WAF
cloudflare-cli block-ip 1.2.3.4
```

---

## 💾 Backup & Recovery

### Manual Backup

```bash
# Database backup
pg_dump -h db-primary.internal -U postgres -d edge_storage -F c -f backup_$(date +%Y%m%d).dump

# Storage backup (incremental)
rsync -av --delete /mnt/ssd/storage/ /mnt/backup/storage/

# Verify backup
pg_restore --list backup_$(date +%Y%m%d).dump
```

### Restore from Backup

```bash
# Database restore
pg_restore -h db-primary.internal -U postgres -d edge_storage -c backup_20251021.dump

# Storage restore
rsync -av /mnt/backup/storage/ /mnt/ssd/storage/

# Restart services
kubectl rollout restart deployment/edge-storage-api
```

---

## 🧪 Testing

### API Health Test

```bash
curl http://localhost:8001/api/v1/health | jq
```

### Performance Test

```bash
# Install Apache Bench
apt-get install apache2-utils

# Test API endpoint (1000 requests, 10 concurrent)
ab -n 1000 -c 10 http://localhost:8001/api/v1/files/
```

### Load Test

```bash
# Install Locust
pip install locust

# Run load test
locust -f tests/load_test.py --host http://localhost:8001
```

---

## 📞 Escalation Path

| Level | Contact | Response Time |
|-------|---------|---------------|
| **L1** | On-call engineer (PagerDuty) | Immediate |
| **L2** | DevOps lead | <30 min |
| **L3** | Engineering manager | <1 hour |
| **L4** | CTO | <2 hours |

---

## 📚 Documentation Links

| Document | Purpose | Link |
|----------|---------|------|
| Deployment Runbook | Step-by-step deployment | [docs/operations/DEPLOYMENT_RUNBOOK.md](operations/DEPLOYMENT_RUNBOOK.md) |
| Operations Playbook | Incident response | [docs/operations/OPERATIONS_PLAYBOOK.md](operations/OPERATIONS_PLAYBOOK.md) |
| Developer Onboarding | Dev quick start | [docs/DEVELOPER_ONBOARDING.md](DEVELOPER_ONBOARDING.md) |
| Architecture Diagrams | System architecture | [docs/architecture/ARCHITECTURE_DIAGRAMS.md](architecture/ARCHITECTURE_DIAGRAMS.md) |
| Production Readiness | Launch checklist | [PRODUCTION_READY_VERIFICATION.md](../PRODUCTION_READY_VERIFICATION.md) |

---

## 🔑 Environment Variables (Critical)

```bash
# Database
DATABASE_URL=postgresql+asyncpg://user:pass@localhost:5432/edge_cloud
DATABASE_POOL_SIZE=50

# Redis
REDIS_URL=redis://localhost:6379

# Storage
CHUNK_SIZE=67108864  # 64MB
MAX_FILE_SIZE=21474836480  # 20GB

# ML Features
ML_FEATURES_ENABLED=true
ML_CPU_THREADS=32  # For Ryzen 9 7950X

# Security
SECRET_KEY=<generate with: openssl rand -base64 32>
ENABLE_HTTPS=true

# Monitoring
JAEGER_ENABLED=true
SENTRY_DSN=<your-sentry-dsn>
```

---

## 🎯 Performance Optimization Tips

1. **Database**:
   - Use read replicas for heavy read loads
   - Enable connection pooling (50 connections)
   - Create indexes for common queries

2. **Cache**:
   - Set Redis maxmemory-policy to `allkeys-lru`
   - Monitor cache hit rate (target >80%)
   - Use appropriate TTLs (query cache: 5min)

3. **Storage**:
   - Place hot data in cache tier (SSD)
   - Use automatic tiering (7 days → warm, 30 days → cold)
   - Enable compression (Zstandard level 3)

4. **API**:
   - Enable response compression
   - Use batch operations for bulk requests
   - Implement pagination for large lists

---

## 🏁 Quick Commands Reference

```bash
# Start everything
docker-compose up -d && cd services/storage-service && uvicorn app.main:app --reload

# Stop everything
docker-compose down

# View all logs
docker-compose logs -f

# Restart API
kubectl rollout restart deployment/edge-storage-api

# Scale API
kubectl scale deployment/edge-storage-api --replicas=5

# Database migration
alembic upgrade head

# Check health
curl http://localhost:8001/api/v1/health

# View metrics
curl http://localhost:8001/metrics

# Backup database
pg_dump -F c -f backup.dump edge_cloud

# Clear Redis cache
redis-cli FLUSHDB

# Check Prometheus targets
curl http://localhost:9090/api/v1/targets
```

---

*Quick Reference - Version 1.0.0*
*Keep this card handy for daily operations*
