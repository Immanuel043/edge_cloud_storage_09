#!/usr/bin/env bash
# Replication role seed (runs once, on first boot of the postgres container).
#
# Creates a minimally-privileged REPLICATION role used by pg_basebackup +
# streaming replication from the postgres-replica container. Idempotent and
# env-gated: if POSTGRES_REPLICATION_PASSWORD is unset or empty, this is a
# no-op, so the file is safe to ship even when no replica is ever started.
#
# Executed via /docker-entrypoint-initdb.d (postgres:15-alpine respects *.sh
# files there and runs them after the SQL scripts).
set -euo pipefail

if [[ -z "${POSTGRES_REPLICATION_PASSWORD:-}" ]]; then
    echo "[init-replication] POSTGRES_REPLICATION_PASSWORD unset — skipping replicator role"
    exit 0
fi

psql -v ON_ERROR_STOP=1 \
     --username "${POSTGRES_USER}" \
     --dbname "${POSTGRES_DB}" <<-SQL
    DO \$\$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'replicator') THEN
            EXECUTE format(
                'CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD %L',
                '${POSTGRES_REPLICATION_PASSWORD}'
            );
            RAISE NOTICE 'Created replication role: replicator';
        ELSE
            EXECUTE format(
                'ALTER ROLE replicator WITH PASSWORD %L',
                '${POSTGRES_REPLICATION_PASSWORD}'
            );
            RAISE NOTICE 'Updated password for existing replication role';
        END IF;
    END
    \$\$;
SQL

echo "[init-replication] replicator role ensured"
