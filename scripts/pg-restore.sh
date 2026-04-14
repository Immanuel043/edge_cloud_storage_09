#!/bin/sh
set -eu

# ============================================
# PostgreSQL Encrypted Backup Restore Script
# ============================================
# Decrypts and restores a backup created by pg-backup.sh.
#
# Usage: pg-restore.sh <encrypted-backup-file>
#
# Required environment variables:
#   DB_HOST, DB_USER, DB_NAME, DB_PASSWORD,
#   BACKUP_ENCRYPTION_KEY
# Optional:
#   DB_PORT (default: 5432)
# ============================================

ENCRYPTED_FILE="${1:?Usage: pg-restore.sh <encrypted-backup-file>}"

if [ ! -f "$ENCRYPTED_FILE" ]; then
    echo "[pg-restore] ERROR: File not found: $ENCRYPTED_FILE"
    exit 1
fi

DB_HOST="${DB_HOST:?DB_HOST is required}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:?DB_USER is required}"
DB_NAME="${DB_NAME:?DB_NAME is required}"
BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required}"

export PGPASSWORD="${DB_PASSWORD:?DB_PASSWORD is required}"

DUMP_FILE="${ENCRYPTED_FILE%.enc}"

echo "[pg-restore] Decrypting ${ENCRYPTED_FILE}..."
openssl enc -d -aes-256-cbc -pbkdf2 -salt \
    -in "$ENCRYPTED_FILE" -out "$DUMP_FILE" \
    -pass "pass:${BACKUP_ENCRYPTION_KEY}"

echo "[pg-restore] Restoring to ${DB_NAME} @ ${DB_HOST}:${DB_PORT}..."
pg_restore -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    --clean --if-exists --no-owner "$DUMP_FILE"

# Remove decrypted dump
rm -f "$DUMP_FILE"

echo "[pg-restore] Restore complete"
