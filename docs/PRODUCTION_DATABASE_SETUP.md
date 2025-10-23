# Production Database Setup Guide

## Overview

For production deployments, we use **fresh database initialization** instead of Alembic migrations. This creates all tables from scratch directly from SQLAlchemy models, ensuring perfect schema alignment.

## Why Fresh Init Instead of Migrations?

### ❌ Problems with Migrations in Production
- **Schema drift**: Migrations may be out of sync with models
- **Migration history**: Complex chain of migrations can cause issues
- **Missing migrations**: Features added without corresponding migrations
- **Rollback complexity**: Difficult to undo failed migrations

### ✅ Benefits of Fresh Init
- **Perfect schema**: Tables match models exactly
- **Clean slate**: No migration history baggage
- **Simple**: One command creates everything
- **Verifiable**: Easy to audit final schema
- **Fast**: No sequential migration execution

---

## Quick Start

### Option 1: Fresh Production Deploy (Recommended)

```bash
# 1. Set environment variable
export USE_FRESH_DB_INIT=true

# 2. (Optional) Force recreate all tables
export FORCE_RECREATE=true  # ⚠️ Drops all existing data!

# 3. Start services
cd infrastructure
docker compose up -d

# Database will be initialized automatically on first start
```

### Option 2: Manual Database Init

```bash
# Run the init script manually
docker exec edge-storage-service python -m app.scripts.init_database

# With force recreate (drops all tables first)
docker exec edge-storage-service bash -c "FORCE_RECREATE=true python -m app.scripts.init_database"
```

---

## Environment Variables

### `USE_FRESH_DB_INIT`
**Default**: `false`
**Values**: `true` | `false`
**Description**: Enable fresh database initialization instead of Alembic migrations

```bash
USE_FRESH_DB_INIT=true
```

### `FORCE_RECREATE`
**Default**: `false`
**Values**: `true` | `false`
**Description**: Drop all existing tables before creating new ones

⚠️ **WARNING**: This will **DELETE ALL DATA**! Only use for clean production setups.

```bash
FORCE_RECREATE=true
```

### `SKIP_SEED`
**Default**: `false`
**Values**: `true` | `false`
**Description**: Skip creation of seed/initial data

```bash
SKIP_SEED=true
```

---

## Production Deployment Workflows

### First-Time Production Setup

```bash
# 1. Pull latest code
git pull origin main

# 2. Update docker-compose.yml with production settings
cd infrastructure
cp docker-compose.yml docker-compose.prod.yml

# 3. Edit .env file
cat > .env << EOF
USE_FRESH_DB_INIT=true
FORCE_RECREATE=false
DATABASE_URL=postgresql+asyncpg://edge_admin:STRONG_PASSWORD@postgres:5432/edge_cloud
REDIS_URL=redis://redis:6379
SECRET_KEY=<generate-strong-secret-key>
EOF

# 4. Start services
docker compose -f docker-compose.prod.yml up -d

# 5. Verify database
docker exec edge-postgres psql -U edge_admin -d edge_cloud -c "\dt"
```

### Migrating Existing Database to Fresh Schema

```bash
# ⚠️ WARNING: This will delete all data!

# 1. Backup existing data
docker exec edge-postgres pg_dump -U edge_admin edge_cloud > backup_$(date +%Y%m%d).sql

# 2. Stop services
docker compose down

# 3. Drop and recreate database
docker exec edge-postgres psql -U edge_admin -c "DROP DATABASE edge_cloud;"
docker exec edge-postgres psql -U edge_admin -c "CREATE DATABASE edge_cloud;"

# 4. Initialize with fresh schema
export USE_FRESH_DB_INIT=true
docker compose up -d

# 5. (Optional) Restore data if compatible
docker exec -i edge-postgres psql -U edge_admin edge_cloud < backup_$(date +%Y%m%d).sql
```

### Development to Production Migration

**Development** (uses migrations):
```bash
# .env
USE_FRESH_DB_INIT=false  # Use Alembic migrations
```

**Production** (fresh init):
```bash
# .env
USE_FRESH_DB_INIT=true   # Fresh schema creation
FORCE_RECREATE=false     # Don't drop existing tables
```

---

## What Gets Created?

The fresh init script creates **35+ tables** including:

### Core Tables
- `users` - User accounts and authentication
- `objects` - File storage metadata
- `folders` - Folder hierarchy
- `file_versions` - Version control

### Storage & Performance
- `content_blocks` - Deduplication blocks
- `file_hashes` - Content-addressed storage
- `storage_usage_history` - Usage tracking
- `storage_analysis` - Storage analytics

### Features
- `favorites` - User favorites
- `share_links` - File sharing
- `url_upload_jobs` - URL-based uploads
- `file_similarities` - Similarity detection
- `recommendations` - Content recommendations
- `user_interactions` - User activity tracking

### Organization & ML
- `organization_clusters` - Auto-organization
- `organization_rules` - Organization policies
- `file_cluster_assignments` - Cluster memberships
- `quota_predictions` - ML quota forecasting
- `quota_alerts` - Quota alerts

### Security & Compliance
- `virus_scan_logs` - Antivirus scan results
- `dlp_scan_logs` - Data loss prevention
- `security_alerts` - Security incidents
- `audit_logs` - Audit trail
- `compliance_reports` - GDPR compliance
- `encryption_key_versions` - Key management
- `key_rotation_history` - Key rotation tracking
- `data_reencryption_queue` - Re-encryption jobs

### OAuth & Auth
- `oauth_accounts` - OAuth integrations
- `activity_logs` - User activity

### Analytics & Optimization
- `optimization_suggestions` - Storage optimization
- `optimization_actions` - Optimization history
- `file_metadata_extended` - Extended metadata
- `file_ocr` - OCR text extraction
- `file_tags` - Tagging system

---

## Verification

### Check Created Tables

```bash
# List all tables
docker exec edge-postgres psql -U edge_admin -d edge_cloud -c "\dt"

# Count tables
docker exec edge-postgres psql -U edge_admin -d edge_cloud -c "
  SELECT COUNT(*) as table_count
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
"
```

### Verify Schema Matches Models

```bash
# Run verification
docker exec edge-storage-service python -m app.scripts.init_database
# Check output for "Schema verified: ✅"
```

### Check Alembic Version

```bash
docker exec edge-postgres psql -U edge_admin -d edge_cloud -c "
  SELECT * FROM alembic_version
"
# Should show: fresh_install_v1
```

---

## Troubleshooting

### Tables Not Created

**Problem**: Script runs but no tables created

**Solution**:
```bash
# Check logs
docker logs edge-storage-service

# Manually run init
docker exec -it edge-storage-service python -m app.scripts.init_database
```

### Permission Denied

**Problem**: Cannot create tables

**Solution**:
```bash
# Grant permissions
docker exec edge-postgres psql -U postgres -c "
  GRANT ALL PRIVILEGES ON DATABASE edge_cloud TO edge_admin;
  GRANT ALL ON SCHEMA public TO edge_admin;
"
```

### Schema Mismatch

**Problem**: Model has columns that table doesn't

**Solution**:
```bash
# Force recreate (⚠️ deletes all data)
docker exec edge-storage-service bash -c "
  FORCE_RECREATE=true python -m app.scripts.init_database
"
```

---

## Hardware-Specific Storage Configuration

Based on your production hardware (AMD Ryzen 9 7950X, 128GB RAM, NVMe drives):

### Storage Volume Mapping

```yaml
volumes:
  # Boot Drive (1TB NVMe 990 PRO)
  - /mnt/boot/docker:/var/lib/docker

  # Database Drive (4TB NVMe 990 PRO)
  postgres_data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /mnt/database/postgres

  # Hot Storage Drive (4TB NVMe SN850X)
  storage_data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /mnt/hot-storage/edge-cloud

  # Cache Drive (2TB NVMe 980 PRO)
  redis_data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /mnt/cache/redis

  # Cold Storage (48TB RAID-6 HDD)
  cold_storage:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /mnt/cold-storage/edge-cloud
```

---

## Backup & Disaster Recovery

### Automated Backups

```bash
# Daily backup script
#!/bin/bash
BACKUP_DIR="/mnt/backup/postgres"
DATE=$(date +%Y%m%d_%H%M%S)

docker exec edge-postgres pg_dump -U edge_admin edge_cloud | \
  gzip > "$BACKUP_DIR/edge_cloud_$DATE.sql.gz"

# Rotate old backups (keep last 30 days)
find "$BACKUP_DIR" -name "*.sql.gz" -mtime +30 -delete
```

### Restore from Backup

```bash
# 1. Stop services
docker compose down storage-service

# 2. Restore database
gunzip < backup.sql.gz | \
  docker exec -i edge-postgres psql -U edge_admin edge_cloud

# 3. Restart services
docker compose up -d
```

---

## Best Practices

1. **Always backup before production deploy**
2. **Test fresh init in staging first**
3. **Use strong passwords and secrets**
4. **Monitor logs during initialization**
5. **Verify schema after deployment**
6. **Document any manual schema changes**
7. **Keep models and database in sync**

---

## Future Considerations

When you expand to Dev/QA environments:

### Development
- Use `USE_FRESH_DB_INIT=false` (migrations for rapid iteration)
- Smaller resource allocation
- Frequent schema changes expected

### QA
- Use `USE_FRESH_DB_INIT=true` (match production)
- Sanitized production data copies
- Full integration testing

### Production
- Always use `USE_FRESH_DB_INIT=true` (stable, verified schema)
- Full resource allocation
- Minimal schema changes

---

## Support

For issues or questions:
1. Check Docker logs: `docker logs edge-storage-service`
2. Verify database connectivity: `docker exec edge-postgres psql -U edge_admin -d edge_cloud -c "SELECT 1"`
3. Run manual init with verbose output: `docker exec -it edge-storage-service python -m app.scripts.init_database`

---

**Last Updated**: 2025-10-23
**Version**: 1.0 (Fresh Init System)
