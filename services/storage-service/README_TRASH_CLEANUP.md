# Trash Cleanup Worker - Setup Guide

## Overview

The trash cleanup worker automatically deletes files that have been in the trash for more than 30 days. This ensures that deleted files don't consume storage indefinitely.

## Files

1. **Worker Script**: `app/workers/trash_cleanup.py`
   - Python script that queries the database for old trash files
   - Permanently deletes files and frees storage space
   - Logs all deletions for audit purposes

2. **Cron Configuration**: `cron/trash-cleanup-cron`
   - Cron schedule configuration
   - Default: Runs daily at 2:00 AM
   - Alternative: Hourly execution (commented out)

## Setup Methods

### Method 1: Cron Job (Recommended for Production)

1. **Install cron in the storage-service container** (if not already installed):
   ```bash
   docker exec edge-storage-service apt-get update
   docker exec edge-storage-service apt-get install -y cron
   ```

2. **Copy cron configuration**:
   ```bash
   docker cp services/storage-service/cron/trash-cleanup-cron edge-storage-service:/etc/cron.d/trash-cleanup
   ```

3. **Set proper permissions**:
   ```bash
   docker exec edge-storage-service chmod 0644 /etc/cron.d/trash-cleanup
   docker exec edge-storage-service crontab /etc/cron.d/trash-cleanup
   ```

4. **Start cron service**:
   ```bash
   docker exec edge-storage-service service cron start
   ```

5. **Verify cron is running**:
   ```bash
   docker exec edge-storage-service service cron status
   ```

### Method 2: Manual Execution (for Testing)

Run the worker manually to test:

```bash
docker exec edge-storage-service python3 -m app.workers.trash_cleanup
```

### Method 3: Systemd Timer (Alternative)

Create a systemd service and timer for more control:

1. Create service file: `/etc/systemd/system/trash-cleanup.service`
2. Create timer file: `/etc/systemd/system/trash-cleanup.timer`
3. Enable and start: `systemctl enable --now trash-cleanup.timer`

### Method 4: Kubernetes CronJob (for K8s deployments)

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: trash-cleanup
spec:
  schedule: "0 2 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: trash-cleanup
            image: edge-storage-service:latest
            command: ["python3", "-m", "app.workers.trash_cleanup"]
          restartPolicy: OnFailure
```

## Configuration

### Adjust Retention Period

To change from 30 days to a different period, edit `app/workers/trash_cleanup.py`:

```python
# Change this line:
cutoff_date = datetime.utcnow() - timedelta(days=30)

# To your desired retention (e.g., 7 days):
cutoff_date = datetime.utcnow() - timedelta(days=7)
```

### Adjust Schedule

Edit `cron/trash-cleanup-cron`:

```bash
# Daily at 2 AM (default)
0 2 * * * ...

# Every hour
0 * * * * ...

# Every 6 hours
0 */6 * * * ...

# Weekly (Sundays at 3 AM)
0 3 * * 0 ...
```

## Monitoring

### Check Logs

```bash
# View cleanup logs
docker exec edge-storage-service cat /var/log/trash_cleanup.log

# Follow logs in real-time
docker exec edge-storage-service tail -f /var/log/trash_cleanup.log
```

### Verify Activity Logs

Check the `activity_logs` table for cleanup activities:

```sql
SELECT * FROM activity_logs
WHERE action = 'trash_auto_cleanup'
ORDER BY created_at DESC
LIMIT 10;
```

### Monitor Database

Query files in trash and their age:

```sql
SELECT
    COUNT(*) as total_files,
    SUM(file_size) as total_size,
    MIN(deleted_at) as oldest_deletion,
    MAX(deleted_at) as newest_deletion
FROM objects
WHERE is_deleted = TRUE;

-- Files older than 30 days (ready for cleanup)
SELECT
    COUNT(*) as files_to_delete,
    SUM(file_size) as space_to_free
FROM objects
WHERE is_deleted = TRUE
AND deleted_at < NOW() - INTERVAL '30 days';
```

## Troubleshooting

### Cron Not Running

1. **Check cron service**:
   ```bash
   docker exec edge-storage-service service cron status
   ```

2. **Check cron logs**:
   ```bash
   docker exec edge-storage-service cat /var/log/cron.log
   ```

3. **Verify crontab**:
   ```bash
   docker exec edge-storage-service crontab -l
   ```

### Worker Errors

1. **Check Python dependencies**:
   ```bash
   docker exec edge-storage-service python3 -m app.workers.trash_cleanup
   ```

2. **Verify database connection**:
   - Check `DATABASE_URL` environment variable
   - Verify PostgreSQL is accessible

3. **Check permissions**:
   - Ensure worker has write access to `/var/log/trash_cleanup.log`
   - Verify file storage paths are writable

### No Files Being Deleted

1. **Check if files exist**:
   ```sql
   SELECT COUNT(*) FROM objects
   WHERE is_deleted = TRUE
   AND deleted_at < NOW() - INTERVAL '30 days';
   ```

2. **Verify worker is running**:
   - Check cron logs
   - Run worker manually to see output

3. **Check worker logic**:
   - Verify cutoff date calculation
   - Ensure database query is correct

## Performance Considerations

### Large Trash Collections

For databases with many files in trash:

1. **Add batch processing**:
   ```python
   # Process in batches of 100
   for i in range(0, len(files_to_delete), 100):
       batch = files_to_delete[i:i+100]
       # Process batch
   ```

2. **Add rate limiting**:
   ```python
   import time
   # Add delay between deletions
   await asyncio.sleep(0.1)  # 100ms delay
   ```

3. **Schedule during off-peak hours**:
   - Default 2 AM is usually low traffic
   - Adjust as needed for your timezone

### Storage I/O Impact

Deleting many large files can cause I/O spikes:

1. **Limit concurrent deletions**
2. **Spread deletions over time**
3. **Monitor disk I/O during cleanup**

## Security

### Access Control

- Worker runs with database credentials
- Ensure `DATABASE_URL` is properly secured
- Use read-only credentials if possible (though worker needs write access)

### Audit Trail

All deletions are logged in:
- `activity_logs` table (database audit)
- `/var/log/trash_cleanup.log` (file log)

### Data Recovery

**WARNING**: Files deleted by this worker cannot be recovered!

- Implement backup strategy before enabling
- Consider longer retention period initially (e.g., 90 days)
- Test on non-production environment first

## Production Checklist

- [ ] Test worker manually
- [ ] Verify cron schedule matches business requirements
- [ ] Set up log monitoring/alerting
- [ ] Configure backup strategy
- [ ] Document retention policy
- [ ] Train support team on trash recovery procedures
- [ ] Set up metrics/dashboards for cleanup stats
- [ ] Test rollback procedure

## Metrics to Track

1. **Files deleted per run**
2. **Storage freed per run**
3. **Worker execution time**
4. **Error rate**
5. **Average file age at deletion**

## Future Enhancements

- Email notifications for large deletions
- Slack/Discord webhooks for monitoring
- Configurable retention per user/folder
- Exemptions for specific file types
- Gradual deletion (throttling)
- Dry-run mode for testing
- Web UI for manual triggering
