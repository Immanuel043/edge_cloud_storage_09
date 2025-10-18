#!/bin/bash

# Script to apply database optimizations
# Usage: ./apply-db-optimizations.sh

set -e  # Exit on error

echo "========================================"
echo "Database Optimization Script"
echo "========================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Database connection settings
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-edge_cloud}"
DB_USER="${DB_USER:-user}"

echo "Configuration:"
echo "  Database: $DB_NAME"
echo "  Host: $DB_HOST"
echo "  Port: $DB_PORT"
echo "  User: $DB_USER"
echo ""

# Check if PostgreSQL is accessible
echo -e "${YELLOW}Checking database connectivity...${NC}"
if PGPASSWORD=$DB_PASS psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Database connection successful${NC}"
else
    echo -e "${RED}✗ Cannot connect to database${NC}"
    echo "Please check your database credentials and ensure PostgreSQL is running."
    exit 1
fi

echo ""

# Backup current database
echo -e "${YELLOW}Creating database backup...${NC}"
BACKUP_FILE="backup_$(date +%Y%m%d_%H%M%S).sql"
PGPASSWORD=$DB_PASS pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -F p -f "$BACKUP_FILE" 2>/dev/null
echo -e "${GREEN}✓ Backup created: $BACKUP_FILE${NC}"
echo ""

# Apply the comprehensive indexes migration
echo -e "${YELLOW}Applying comprehensive indexes migration...${NC}"
MIGRATION_FILE="../services/storage-service/migrations/add_comprehensive_indexes.sql"

if [ ! -f "$MIGRATION_FILE" ]; then
    echo -e "${RED}✗ Migration file not found: $MIGRATION_FILE${NC}"
    exit 1
fi

echo "Executing migration..."
PGPASSWORD=$DB_PASS psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f "$MIGRATION_FILE"

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Migration applied successfully${NC}"
else
    echo -e "${RED}✗ Migration failed${NC}"
    echo "You can restore from backup: $BACKUP_FILE"
    exit 1
fi

echo ""

# Verify indexes were created
echo -e "${YELLOW}Verifying indexes...${NC}"
INDEX_COUNT=$(PGPASSWORD=$DB_PASS psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM pg_indexes WHERE schemaname = 'public';" | xargs)
echo -e "${GREEN}✓ Total indexes in database: $INDEX_COUNT${NC}"

# Show newly created indexes
echo ""
echo "Recently created indexes:"
PGPASSWORD=$DB_PASS psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "
SELECT
    tablename,
    indexname,
    pg_size_pretty(pg_relation_size(indexname::regclass)) as size
FROM pg_indexes
WHERE schemaname = 'public'
AND indexname LIKE 'idx_%'
ORDER BY pg_relation_size(indexname::regclass) DESC
LIMIT 20;
"

echo ""

# Run ANALYZE on all tables
echo -e "${YELLOW}Analyzing tables to update query planner statistics...${NC}"
PGPASSWORD=$DB_PASS psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "ANALYZE;"
echo -e "${GREEN}✓ ANALYZE completed${NC}"

echo ""

# Performance recommendations
echo -e "${YELLOW}========================================"
echo "Optimization Complete!"
echo "========================================${NC}"
echo ""
echo "Next steps:"
echo "1. Restart your application services to apply connection pool changes"
echo "2. Monitor query performance with the new /api/v1/health/db endpoint"
echo "3. Check slow queries at /api/v1/health/db/slow-queries"
echo "4. Review database stats at /api/v1/health/db/stats"
echo ""
echo "Restart commands:"
echo "  docker-compose restart web-service"
echo "  docker-compose restart storage-service"
echo ""
echo -e "${GREEN}Backup saved to: $BACKUP_FILE${NC}"
echo -e "${GREEN}Keep this backup for at least 7 days.${NC}"
echo ""
