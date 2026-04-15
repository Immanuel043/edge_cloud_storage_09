# PostgreSQL PITR + Read Replica Runbook

This document covers two related capabilities shipped in the 2026-04
architecture review (item #7):

1. **Point-in-Time Recovery (PITR)** — continuous WAL archiving drops RPO
   from ~24h (daily `pg_dump`) to <5min.
2. **Read replica** — optional hot-standby for offloading read-only traffic.

Both are **always-on for WAL archiving**, and **opt-in for the replica**
(via `profiles: [replica]`).

---

## 1. What's running automatically

After `docker compose up -d postgres`, the primary postgres:

- Writes each closed WAL segment to the `postgres_wal_archive` docker volume
  (via `archive_command=cp %p /var/lib/postgresql/wal_archive/%f`).
- Has `wal_level=replica`, `max_wal_senders=5`, `hot_standby=on` set — the
  knobs that make a standby possible.

**Verify WAL archiving:**

```bash
docker exec edge-postgres ls -lh /var/lib/postgresql/wal_archive | tail -5
# Expect to see 00000001000000xx000000yy files accumulating over time.
# Each segment is 16 MiB. On an idle dev cluster a segment rotates ~hourly;
# on a busy prod cluster it can be every few minutes.
```

**Rotation**: The archive volume grows forever until you prune. Minimum
safe retention is "last successful base backup + all WAL since". The
existing `postgres-backup` sidecar takes a daily `pg_dump` — pair that with
a weekly WAL prune cron.

---

## 2. Enabling the read replica (one-time)

The replica is gated behind `profiles: [replica]` so `docker compose up`
never starts it accidentally.

### 2a. Generate the replication password

```bash
cd infrastructure
openssl rand -base64 32 > /tmp/replpass.txt
cat /tmp/replpass.txt   # copy this into secrets.env below
```

### 2b. Add the secret

```bash
# Decrypt secrets
sops -d infrastructure/secrets.enc.env > infrastructure/secrets.env

# Append the replication password
echo "POSTGRES_REPLICATION_PASSWORD=<paste from /tmp/replpass.txt>" \
    >> infrastructure/secrets.env

# Re-encrypt
cd infrastructure
sops -e secrets.env > secrets.enc.env

# Regenerate decrypted .env for compose
../scripts/decrypt-secrets.sh
```

### 2c. Create the `replicator` role (FRESH installs only)

If `postgres_data` is **empty** (fresh install), the role is created
automatically by `scripts/init-replication.sh`, which runs via the
postgres `docker-entrypoint-initdb.d` hook. No manual step needed.

**If `postgres_data` already has data**, the init script has already run
and won't run again. Create the role manually:

```bash
docker exec -it edge-postgres psql -U edge_admin -d edge_cloud <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'replicator') THEN
    EXECUTE format(
      'CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD %L',
      current_setting('mydb.replpass')
    );
  END IF;
END$$;
SQL

# Then append the replication pg_hba line (if not already present):
docker exec edge-postgres bash -c "
  grep -q 'host replication' /var/lib/postgresql/data/pg_hba.conf || \
  echo 'host replication replicator 0.0.0.0/0 scram-sha-256' >> /var/lib/postgresql/data/pg_hba.conf
"
docker exec edge-postgres pg_ctl reload -D /var/lib/postgresql/data
```

### 2d. Bring up the replica

```bash
cd infrastructure
docker compose --profile replica up -d postgres-replica

# Watch the basebackup + catch-up
docker compose logs -f postgres-replica

# Once it settles (look for "database system is ready to accept read-only connections"):
docker exec edge-postgres-replica psql -U edge_admin -d edge_cloud \
    -c "SELECT pg_is_in_recovery();"
# Expect: t
```

### 2e. Wire the app to it (optional, after replica is healthy)

Edit `infrastructure/secrets.env`:

```ini
READ_DATABASE_URL=postgresql+asyncpg://edge_admin:<POSTGRES_PASSWORD>@postgres-replica:5432/edge_cloud
```

Re-encrypt, regenerate `.env`, restart storage-service. Read-only routes
that `Depends(get_read_db)` will now hit the replica. Any route using
`Depends(get_db)` continues to hit the primary.

---

## 3. PITR — restoring to a point in time

**Scenario**: At 14:32 UTC someone ran `DELETE FROM users` on prod.
Current time is 14:45. We want the cluster back at its state as of 14:31.

### 3a. Stop writes

```bash
# Hard stop — don't flush WAL after the bad transaction.
docker compose stop storage-service storage-worker web-service
# Keep postgres up so we can read WAL.
```

### 3b. Identify the target

```bash
export RECOVERY_TARGET_TIME='2026-04-14 14:31:00+00'
# Pick a moment before the bad event, with some safety margin.
```

### 3c. Run the restore script

```bash
./scripts/pg-pitr-restore.sh
```

This will:
1. Decrypt the most recent daily pg_dump from `postgres_backups` volume.
2. Bring up a scratch postgres in recovery mode pointed at
   `postgres_wal_archive`.
3. Replay WAL up to `recovery_target_time`.
4. Promote the restored cluster.
5. Switch the `postgres` service to use the restored data dir.

### 3d. Verify + resume

```bash
docker exec edge-postgres psql -U edge_admin -d edge_cloud \
    -c "SELECT count(*) FROM users;"
# Compare to pre-incident snapshot.

docker compose start storage-service storage-worker web-service
```

---

## 4. Monitoring

Key metrics to graph (Prometheus + Grafana):

| Metric                              | Source                    | Alert threshold              |
| ----------------------------------- | ------------------------- | ---------------------------- |
| `pg_stat_archiver.archived_count`   | postgres_exporter         | Flat for > 15 min → alarm    |
| `pg_stat_archiver.failed_count`     | postgres_exporter         | Any increase → page          |
| `pg_stat_replication.lag_bytes`     | postgres_exporter         | > 100 MiB → warn             |
| Disk usage on `postgres_wal_archive`| node_exporter             | > 80% → prune older WAL      |

---

## 5. Pruning old WAL

Safe retention = **most recent base backup** + **all WAL since that backup**.

The simplest pruning rule (run daily from a cron sidecar):

```bash
# Keep 7 days of WAL. Adjust with your RPO/backup cadence.
docker exec edge-postgres find /var/lib/postgresql/wal_archive \
    -type f -mtime +7 -delete
```

Do NOT prune WAL younger than your oldest untested backup — it's your only
way back.

---

## 6. Rolling back this feature

If WAL archiving is causing disk pressure and you need to disable it
immediately, edit `infrastructure/docker-compose.yml` and remove these flags
from the `postgres.command`:

```
-c wal_level=replica
-c archive_mode=on
-c archive_command='...'
-c max_wal_senders=5
-c wal_keep_size=1GB
-c hot_standby=on
```

Then `docker compose up -d postgres`. You lose PITR but nothing else breaks.
