#!/bin/sh
set -eu

# ============================================
# PostgreSQL Encrypted Backup Script
# ============================================
# Performs a compressed pg_dump, encrypts with openssl,
# and rotates old backups beyond the retention period.
#
# Required environment variables:
#   DB_HOST, DB_USER, DB_NAME, DB_PASSWORD,
#   BACKUP_DIR, BACKUP_ENCRYPTION_KEY, LABEL
# Optional:
#   DB_PORT (default: 5432), RETENTION_DAYS (default: 30)
# ============================================

DB_HOST="${DB_HOST:?DB_HOST is required}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:?DB_USER is required}"
DB_NAME="${DB_NAME:?DB_NAME is required}"
BACKUP_DIR="${BACKUP_DIR:?BACKUP_DIR is required}"
BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
LABEL="${LABEL:-db}"

export PGPASSWORD="${DB_PASSWORD:?DB_PASSWORD is required}"

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
DUMP_FILE="${BACKUP_DIR}/${LABEL}-${TIMESTAMP}.dump"
ENCRYPTED_FILE="${DUMP_FILE}.enc"

echo "[pg-backup] Starting backup: ${LABEL} @ ${TIMESTAMP}"

# Create compressed custom-format dump
pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    -Fc --compress=9 -f "$DUMP_FILE"

DUMP_SIZE=$(du -sh "$DUMP_FILE" | cut -f1)
echo "[pg-backup] Dump complete: ${DUMP_SIZE}"

# Encrypt with AES-256-CBC + PBKDF2 key derivation
openssl enc -aes-256-cbc -pbkdf2 -salt \
    -in "$DUMP_FILE" -out "$ENCRYPTED_FILE" \
    -pass "pass:${BACKUP_ENCRYPTION_KEY}"

# Remove unencrypted dump immediately
rm -f "$DUMP_FILE"

ENC_SIZE=$(du -sh "$ENCRYPTED_FILE" | cut -f1)
echo "[pg-backup] Encrypted backup: ${ENCRYPTED_FILE} (${ENC_SIZE})"

# Rotate old backups
echo "[pg-backup] Rotating backups older than ${RETENTION_DAYS} days..."
find "$BACKUP_DIR" -name "${LABEL}-*.dump.enc" -mtime "+${RETENTION_DAYS}" -delete

REMAINING=$(find "$BACKUP_DIR" -name "${LABEL}-*.dump.enc" | wc -l | tr -d ' ')
echo "[pg-backup] ${REMAINING} backup(s) retained"
echo "[pg-backup] Done"
