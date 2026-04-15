#!/usr/bin/env bash
# ============================================
# PostgreSQL Point-in-Time Restore
# ============================================
# Recovers the main postgres cluster to a specific moment in time by:
#   1. Decrypting the most recent pg_dump base backup
#   2. Restoring it into a scratch data directory
#   3. Replaying WAL from postgres_wal_archive up to RECOVERY_TARGET_TIME
#   4. Promoting the recovered cluster
#
# This is a runbook-grade script — it's destructive and assumes you've
# already stopped application traffic (storage-service, workers) before
# running it. See docs/PITR_RUNBOOK.md for the surrounding procedure.
#
# Required environment variables:
#   RECOVERY_TARGET_TIME    e.g. '2026-04-14 14:31:00+00'
#   BACKUP_ENCRYPTION_KEY   matches what pg-backup.sh used
#   DB_PASSWORD             postgres superuser password
#
# Optional:
#   BACKUP_FILE             absolute path to the .dump.enc file in the
#                           postgres_backups volume (default: latest)
#   RESTORE_DATA_DIR        scratch dir (default: /var/lib/postgresql/pitr-restore)
# ============================================
set -euo pipefail

RECOVERY_TARGET_TIME="${RECOVERY_TARGET_TIME:?RECOVERY_TARGET_TIME is required (e.g. '2026-04-14 14:31:00+00')}"
BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required}"
DB_PASSWORD="${DB_PASSWORD:?DB_PASSWORD is required}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
WAL_ARCHIVE_DIR="${WAL_ARCHIVE_DIR:-/var/lib/postgresql/wal_archive}"
RESTORE_DATA_DIR="${RESTORE_DATA_DIR:-/var/lib/postgresql/pitr-restore}"

# Pick the most recent base backup unless caller overrides.
BACKUP_FILE="${BACKUP_FILE:-$(ls -1t "${BACKUP_DIR}"/postgres-*.dump.enc 2>/dev/null | head -n1 || true)}"
if [[ -z "${BACKUP_FILE}" || ! -f "${BACKUP_FILE}" ]]; then
    echo "[pitr-restore] ERROR: no base backup found in ${BACKUP_DIR}" >&2
    exit 1
fi

echo "[pitr-restore] Base backup:       ${BACKUP_FILE}"
echo "[pitr-restore] Recovery target:   ${RECOVERY_TARGET_TIME}"
echo "[pitr-restore] WAL archive:       ${WAL_ARCHIVE_DIR}"
echo "[pitr-restore] Restoring to:      ${RESTORE_DATA_DIR}"
echo

if [[ -e "${RESTORE_DATA_DIR}" ]]; then
    echo "[pitr-restore] ERROR: ${RESTORE_DATA_DIR} already exists — remove or set RESTORE_DATA_DIR" >&2
    exit 1
fi

# -----------------------------------------------------------------
# 1. Decrypt + restore the base dump into a scratch cluster.
# -----------------------------------------------------------------
TMPDUMP="$(mktemp -t pitr-XXXXXX.dump)"
trap 'rm -f "${TMPDUMP}"' EXIT

echo "[pitr-restore] Decrypting base backup..."
openssl enc -aes-256-cbc -pbkdf2 -d \
    -in "${BACKUP_FILE}" -out "${TMPDUMP}" \
    -pass "pass:${BACKUP_ENCRYPTION_KEY}"

echo "[pitr-restore] Initializing scratch cluster at ${RESTORE_DATA_DIR}..."
export PGPASSWORD="${DB_PASSWORD}"
mkdir -p "${RESTORE_DATA_DIR}"
chmod 0700 "${RESTORE_DATA_DIR}"
# Use the docker user's pg (postgres image exposes initdb at /usr/local/bin)
initdb -D "${RESTORE_DATA_DIR}" -U edge_admin --pwfile=<(echo "${DB_PASSWORD}")

# -----------------------------------------------------------------
# 2. Point the scratch cluster at the archived WAL and set the
#    recovery target. Postgres 12+ uses recovery.signal + postgresql.conf
#    directives (not recovery.conf).
# -----------------------------------------------------------------
echo "[pitr-restore] Configuring recovery..."
cat >> "${RESTORE_DATA_DIR}/postgresql.conf" <<EOF

# === PITR recovery settings (added by pg-pitr-restore.sh) ===
restore_command = 'cp ${WAL_ARCHIVE_DIR}/%f %p'
recovery_target_time = '${RECOVERY_TARGET_TIME}'
recovery_target_action = 'promote'
EOF
touch "${RESTORE_DATA_DIR}/recovery.signal"

# -----------------------------------------------------------------
# 3. Start postgres on the scratch cluster and restore the dump.
#    pg_restore needs the cluster up; recovery kicks in automatically
#    on start thanks to recovery.signal.
# -----------------------------------------------------------------
SCRATCH_PORT=5434
echo "[pitr-restore] Starting scratch postgres on port ${SCRATCH_PORT}..."
pg_ctl -D "${RESTORE_DATA_DIR}" -l "${RESTORE_DATA_DIR}/pg.log" \
       -o "-p ${SCRATCH_PORT}" start

# Wait for promotion (recovery_target_action=promote + target reached).
echo "[pitr-restore] Waiting for recovery to reach target time..."
for _ in $(seq 1 60); do
    if pg_isready -h 127.0.0.1 -p ${SCRATCH_PORT} -U edge_admin -d postgres \
       && ! psql -h 127.0.0.1 -p ${SCRATCH_PORT} -U edge_admin -d postgres \
              -tAc 'SELECT pg_is_in_recovery()' | grep -q '^t'; then
        echo "[pitr-restore] Recovery complete + cluster promoted."
        break
    fi
    sleep 2
done

echo "[pitr-restore] Restoring base dump into the recovered cluster..."
pg_restore --clean --if-exists --no-owner \
    -h 127.0.0.1 -p ${SCRATCH_PORT} -U edge_admin -d edge_cloud \
    "${TMPDUMP}"

echo
echo "[pitr-restore] DONE."
echo "[pitr-restore] Scratch cluster is running at ${RESTORE_DATA_DIR} on port ${SCRATCH_PORT}."
echo "[pitr-restore] Next steps:"
echo "  1. Verify: psql -h 127.0.0.1 -p ${SCRATCH_PORT} -U edge_admin -d edge_cloud"
echo "  2. Stop the live postgres container (docker compose stop postgres)."
echo "  3. Rename postgres_data volume to postgres_data_broken-$(date +%Y%m%d)."
echo "  4. Copy ${RESTORE_DATA_DIR} contents into a fresh postgres_data volume."
echo "  5. Restart postgres. Reconnect application."
echo "  6. Keep the broken volume for at least 7 days in case of rollback."
