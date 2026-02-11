#!/bin/bash
set -e

echo "Waiting for database to be ready..."
while ! nc -z ${DB_HOST:-postgres} ${DB_PORT:-5432}; do
  sleep 1
done
echo "Database is ready!"

# Check if we should use fresh DB init or migrations
if [ "${USE_FRESH_DB_INIT:-false}" = "true" ]; then
  echo "Initializing database from scratch (fresh install)..."
  python -m app.scripts.init_database
else
  echo "Running database migrations..."
  alembic upgrade head
fi

echo "Starting application..."
exec uvicorn app.main:app --host 0.0.0.0 --port 8000
