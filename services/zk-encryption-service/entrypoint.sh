#!/bin/bash
set -e

echo "Waiting for database to be ready..."
while ! nc -z ${ZK_DB_HOST:-zk-postgres} ${ZK_DB_PORT:-5432}; do
  sleep 1
done
echo "Database is ready!"

echo "Running database migrations..."
alembic upgrade head

echo "Starting application..."
exec uvicorn app.main:app --host 0.0.0.0 --port 8002 --workers 4
