# Operations Playbook - Edge Cloud Storage

**Version**: 1.0.0
**Last Updated**: October 21, 2025
**Purpose**: Incident response and operational procedures

---

## Table of Contents

1. [Incident Response](#incident-response)
2. [Common Issues & Solutions](#common-issues--solutions)
3. [Performance Degradation](#performance-degradation)
4. [Database Issues](#database-issues)
5. [Security Incidents](#security-incidents)
6. [Scaling Procedures](#scaling-procedures)
7. [Backup & Recovery](#backup--recovery)

---

## Incident Response

### Severity Levels

| Severity | Description | Response Time | Examples |
|----------|-------------|---------------|----------|
| **P0 - Critical** | Total service outage | Immediate | Service down, data loss |
| **P1 - High** | Major functionality broken | < 1 hour | Auth broken, uploads failing |
| **P2 - Medium** | Degraded performance | < 4 hours | Slow API, high latency |
| **P3 - Low** | Minor issues | < 24 hours | UI bugs, logging issues |

### P0 - Critical Incident

**Trigger**: Service completely down or major data loss

#### Immediate Actions (0-5 minutes)

```bash
# 1. Acknowledge incident
# Post in #edge-storage-alerts: "P0 INCIDENT: Service down. Investigating."

# 2. Check service status
kubectl get pods -n production
kubectl get deployments -n production

# 3. Check health endpoints
curl https://api.yourdomain.com/api/v1/health
curl https://api.yourdomain.com/api/v1/ready

# 4. Check recent deployments
kubectl rollout history deployment/edge-storage-api

# 5. Immediate rollback if needed
kubectl rollout undo deployment/edge-storage-api
```

#### Investigation (5-15 minutes)

```bash
# Check application logs
kubectl logs -f deployment/edge-storage-api --tail=500

# Check database
psql $DATABASE_URL -c "SELECT 1"

# Check Redis
redis-cli -h redis-master.internal ping

# Check resource usage
kubectl top pods
kubectl top nodes

# Check Grafana
open https://grafana.yourdomain.com/d/main-dashboard
```

#### Resolution & Communication

```bash
# Once resolved:
# 1. Update Slack: "RESOLVED: Service restored. RCA to follow."
# 2. Monitor for 30 minutes
# 3. Write incident report within 24 hours
```

---

## Common Issues & Solutions

### Issue 1: High Error Rate (429 - Rate Limit)

**Symptoms:**
- Spike in 429 errors
- Users complaining about rate limits
- Alert: `RateLimitExceeded`

**Diagnosis:**

```bash
# Check rate limit metrics
curl https://prometheus.yourdomain.com/api/v1/query?query='rate(http_requests_total{status="429"}[5m])'

# Check top rate-limited IPs
kubectl logs deployment/edge-storage-api | grep "429" | awk '{print $1}' | sort | uniq -c | sort -rn | head -20
```

**Solution:**

```bash
# Option 1: Temporary increase (if legitimate traffic)
# Edit rate limit config
kubectl edit configmap rate-limit-config

# Restart to apply
kubectl rollout restart deployment/edge-storage-api

# Option 2: Block abusive IPs
# Add to firewall/WAF
cloudflare-cli block-ip 1.2.3.4

# Option 3: Implement exponential backoff on client
# Contact client to implement retry logic
```

### Issue 2: Database Connection Pool Exhausted

**Symptoms:**
- `PostgresError: too many connections`
- Slow queries
- Alert: `DatabaseConnectionPoolExhausted`

**Diagnosis:**

```bash
# Check active connections
psql $DATABASE_URL -c "SELECT count(*) FROM pg_stat_activity WHERE state = 'active'"

# Check pool size
kubectl logs deployment/edge-storage-api | grep "pool size"

# Find long-running queries
psql $DATABASE_URL -c "SELECT pid, now() - query_start as duration, query FROM pg_stat_activity WHERE state = 'active' ORDER BY duration DESC LIMIT 10"
```

**Solution:**

```bash
# Option 1: Kill long-running queries
psql $DATABASE_URL -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'active' AND now() - query_start > interval '5 minutes'"

# Option 2: Increase pool size (temporary)
kubectl set env deployment/edge-storage-api DATABASE_POOL_SIZE=100

# Option 3: Add read replica
# Route read queries to replica
kubectl set env deployment/edge-storage-api USE_READ_REPLICA=true

# Option 4: Scale horizontally
kubectl scale deployment/edge-storage-api --replicas=5
```

### Issue 3: Redis Memory Full

**Symptoms:**
- Cache misses increasing
- `Redis OOM` errors
- Alert: `RedisMemoryHigh`

**Diagnosis:**

```bash
# Check Redis memory
redis-cli -h redis-master.internal info memory

# Check eviction policy
redis-cli -h redis-master.internal config get maxmemory-policy

# Check key distribution
redis-cli -h redis-master.internal --bigkeys
```

**Solution:**

```bash
# Option 1: Clear old cache entries
redis-cli -h redis-master.internal --scan --pattern "query_cache:*" | xargs redis-cli -h redis-master.internal del

# Option 2: Increase Redis memory
# Edit Redis config and restart

# Option 3: Implement LRU eviction
redis-cli -h redis-master.internal config set maxmemory-policy allkeys-lru

# Option 4: Add Redis cluster node
```

### Issue 4: Slow File Uploads

**Symptoms:**
- Upload timeouts
- Slow chunk processing
- Alert: `SlowUploads`

**Diagnosis:**

```bash
# Check upload metrics
curl https://prometheus.yourdomain.com/api/v1/query?query='histogram_quantile(0.95, rate(storage_upload_duration_seconds_bucket[5m]))'

# Check storage I/O
df -h /mnt/ssd/storage
iostat -x 1 10

# Check network
iftop
```

**Solution:**

```bash
# Option 1: Increase chunk size
kubectl set env deployment/edge-storage-api CHUNK_SIZE=10485760  # 10MB

# Option 2: Add storage capacity
# Provision additional SSD volume

# Option 3: Optimize storage tier placement
# Move hot data to faster storage

# Option 4: Enable parallel chunk processing
kubectl set env deployment/edge-storage-api PARALLEL_CHUNKS=true
```

---

## Performance Degradation

### Runbook: High API Latency

**Alert**: `HighLatency` - P95 > 500ms

#### Step 1: Identify Slow Endpoints

```bash
# Check performance dashboard
open https://grafana.yourdomain.com/d/performance-dashboard

# Get slow queries
curl https://api.yourdomain.com/api/v1/performance/queries/slow \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq

# Check Jaeger for traces
open https://jaeger.yourdomain.com
```

#### Step 2: Quick Fixes

```bash
# Clear cache to force refresh
curl -X POST https://api.yourdomain.com/api/v1/performance/cache/clear \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pattern": "*"}'

# Restart workers
kubectl rollout restart deployment/quota-prediction-worker

# Scale up
kubectl scale deployment/edge-storage-api --replicas=6
```

#### Step 3: Long-term Solutions

```bash
# Add missing indexes
# Review index recommendations
curl https://api.yourdomain.com/api/v1/performance/indexes/recommendations \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq

# Apply indexes
curl -X POST https://api.yourdomain.com/api/v1/performance/indexes/create \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"execute": true}'

# Optimize queries
# Review slow queries and refactor
```

---

## Database Issues

### Runbook: Database Replication Lag

**Alert**: `DatabaseReplicationLag` - Lag > 30s

#### Diagnosis

```bash
# Check replication status
psql $DATABASE_URL -c "SELECT client_addr, state, sync_state, replay_lag FROM pg_stat_replication"

# Check WAL queue
psql $DATABASE_URL -c "SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) as lag_bytes FROM pg_stat_replication"
```

#### Solution

```bash
# Option 1: Increase WAL sender processes
psql $DATABASE_URL -c "ALTER SYSTEM SET max_wal_senders = 10"
psql $DATABASE_URL -c "SELECT pg_reload_conf()"

# Option 2: Reduce write load on primary
# Temporarily disable non-critical writes

# Option 3: Rebuild replica
# If lag is too high, rebuild replica from scratch
```

---

## Security Incidents

### Runbook: Suspicious Authentication Activity

**Alert**: `AuthenticationFailures` - 50+ failures in 5min

#### Investigation

```bash
# Get failed logins
curl https://api.yourdomain.com/api/v1/audit/security/alerts \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq

# Check IP addresses
psql $DATABASE_URL -c "SELECT ip_address, COUNT(*) FROM audit_logs WHERE event_type LIKE '%login.fail%' AND timestamp > NOW() - INTERVAL '1 hour' GROUP BY ip_address ORDER BY COUNT(*) DESC LIMIT 20"

# Check user accounts
psql $DATABASE_URL -c "SELECT user_id, COUNT(*) FROM audit_logs WHERE event_type LIKE '%login.fail%' AND timestamp > NOW() - INTERVAL '1 hour' GROUP BY user_id ORDER BY COUNT(*) DESC LIMIT 20"
```

#### Response

```bash
# Block abusive IPs
# Add to WAF/firewall
for ip in 1.2.3.4 5.6.7.8; do
  cloudflare-cli block-ip $ip
done

# Lock compromised accounts
psql $DATABASE_URL -c "UPDATE users SET is_active = false WHERE id IN ('user-id-1', 'user-id-2')"

# Force password reset
# Send email to affected users

# Enable 2FA enforcement
psql $DATABASE_URL -c "UPDATE users SET require_2fa = true WHERE is_admin = true"
```

---

## Scaling Procedures

### Horizontal Scaling

```bash
# Scale API servers
kubectl scale deployment/edge-storage-api --replicas=10

# Verify
kubectl get pods -l app=edge-storage-api

# Monitor performance
watch -n 1 'kubectl top pods -l app=edge-storage-api'
```

### Database Scaling

```bash
# Add read replica
# 1. Create replica server
# 2. Configure streaming replication
# 3. Update application config
kubectl set env deployment/edge-storage-api DATABASE_REPLICA_URL="postgresql://replica.internal:5432/edge_storage"

# Verify replica
psql $DATABASE_REPLICA_URL -c "SELECT pg_is_in_recovery()"  # Should be 't'
```

### Storage Scaling

```bash
# Add storage volume
# 1. Provision new volume
# 2. Mount to pod
# 3. Update storage paths

# Verify
df -h | grep storage
```

---

## Backup & Recovery

### Daily Backup

```bash
#!/bin/bash
# Run daily at 2 AM UTC

BACKUP_DIR="/mnt/backup"
DATE=$(date +%Y%m%d_%H%M%S)

# Database backup
pg_dump -h db-primary.internal \
        -U postgres \
        -d edge_storage \
        -F c \
        -f "${BACKUP_DIR}/db_${DATE}.dump"

# Storage backup (incremental)
rsync -av --delete /mnt/ssd/storage/ /mnt/backup/storage/

# Verify backup
pg_restore --list "${BACKUP_DIR}/db_${DATE}.dump" > /dev/null
if [ $? -eq 0 ]; then
  echo "✅ Backup successful: db_${DATE}.dump"
else
  echo "❌ Backup failed!"
  # Send alert
fi

# Cleanup old backups (keep last 30 days)
find ${BACKUP_DIR} -name "db_*.dump" -mtime +30 -delete
```

### Disaster Recovery

```bash
# Full system recovery

# 1. Restore database
pg_restore -h db-primary.internal \
           -U postgres \
           -d edge_storage \
           -c \
           /mnt/backup/db_20251021_020000.dump

# 2. Restore storage files
rsync -av /mnt/backup/storage/ /mnt/ssd/storage/

# 3. Restart services
kubectl rollout restart deployment/edge-storage-api
kubectl rollout restart deployment/quota-prediction-worker
kubectl rollout restart deployment/storage-optimization-worker

# 4. Verify
curl https://api.yourdomain.com/api/v1/health | jq
```

---

## Monitoring Checklist

### Daily

- [ ] Check Grafana dashboards
- [ ] Review error rates in Sentry
- [ ] Check backup completion
- [ ] Review security alerts

### Weekly

- [ ] Review slow query reports
- [ ] Check storage capacity
- [ ] Review scaling needs
- [ ] Update runbooks if needed

### Monthly

- [ ] Performance review
- [ ] Capacity planning
- [ ] Security audit
- [ ] Disaster recovery drill

---

## Emergency Contacts

| Role | Contact | Phone | Slack |
|------|---------|-------|-------|
| On-Call Engineer | PagerDuty | +1-XXX-XXX-XXXX | @oncall |
| DevOps Lead | Jane Doe | +1-XXX-XXX-XXXX | @jane |
| Security Lead | John Smith | +1-XXX-XXX-XXXX | @john |
| Engineering Manager | Alice Johnson | +1-XXX-XXX-XXXX | @alice |

### Escalation Path

1. **L1**: On-call engineer (PagerDuty)
2. **L2**: DevOps lead
3. **L3**: Engineering manager
4. **L4**: CTO

---

*Operations Playbook - Version 1.0.0*
*Keep this document updated with learnings from incidents*
