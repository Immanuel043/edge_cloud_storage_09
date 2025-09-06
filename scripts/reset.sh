#!/bin/bash
set -e

DB_NAME="edge_cloud"
DB_USER="edge_admin"
DB_HOST="localhost"
DB_PORT="5432"

echo "⚠️  Resetting database: $DB_NAME"
read -p "Are you sure? This will DROP ALL DATA. Type 'yes' to continue: " confirm

if [ "$confirm" != "yes" ]; then
  echo "❌ Aborted."
  exit 1
fi

# Drop and recreate DB inside Postgres container
echo "🗑️  Dropping existing database (if any)..."
docker exec -i edge-postgres psql -U $DB_USER -d postgres -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE);"

echo "📦 Creating fresh database..."
docker exec -i edge-postgres psql -U $DB_USER -d postgres -c "CREATE DATABASE $DB_NAME;"

# Run Alembic migrations
echo "🚀 Running Alembic migrations..."
cd services/storage-service
alembic upgrade head
cd ../..

# Verify tables
echo "🔍 Checking new schema..."
docker exec -i edge-postgres psql -U $DB_USER -d $DB_NAME -c "\dt"

echo "✅ Database reset complete!"
