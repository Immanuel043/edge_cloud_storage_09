# Elasticsearch Persistence Configuration

This document explains how to run the Edge Cloud Storage system with or without Elasticsearch data persistence.

## Overview

The system supports two modes:

### 🔧 Development Mode (Non-Persistent)
- **Default behavior**
- Elasticsearch data stored in container memory
- Data is **lost** when containers restart
- Faster for testing and development
- No disk space used for search index

### 🚀 Production Mode (Persistent)
- Elasticsearch data stored in Docker volume
- Data **persists** across container restarts
- Required for production deployments
- Uses disk space for search index

## Usage

### Starting in Development Mode (Non-Persistent)

```bash
cd infrastructure
./start-dev.sh
```

Or manually:
```bash
docker-compose -f docker-compose.yml up -d
```

### Starting in Production Mode (Persistent)

```bash
cd infrastructure
./start-prod.sh
```

Or manually:
```bash
docker-compose -f docker-compose.yml -f docker-compose.persistent.yml up -d
```

## How It Works

### Development Mode
- Uses base `docker-compose.yml`
- Elasticsearch has **no volume mount**
- Data stored in container filesystem (lost on restart)

### Production Mode
- Uses `docker-compose.yml` + `docker-compose.persistent.yml` overlay
- Elasticsearch mounts `elasticsearch_data` volume
- Data persists in named Docker volume

## Managing Persistent Data

### View Volumes
```bash
docker volume ls
```

### Inspect Elasticsearch Volume
```bash
docker volume inspect edge-cloud-network_elasticsearch_data
```

### Backup Elasticsearch Data
```bash
# Create backup
docker run --rm -v edge-cloud-network_elasticsearch_data:/data -v $(pwd):/backup alpine tar czf /backup/elasticsearch-backup.tar.gz -C /data .

# Restore backup
docker run --rm -v edge-cloud-network_elasticsearch_data:/data -v $(pwd):/backup alpine sh -c "cd /data && tar xzf /backup/elasticsearch-backup.tar.gz"
```

### Remove Elasticsearch Volume (Clear All Search Data)
```bash
# Stop services first
docker-compose down

# Remove volume
docker volume rm edge-cloud-network_elasticsearch_data

# Restart services
./start-prod.sh
```

## Environment Variables

In `.env` file:

```bash
# Set to false for development (no persistence)
ELASTICSEARCH_PERSISTENCE=false

# Set to true for production (with persistence)
ELASTICSEARCH_PERSISTENCE=true
```

**Note:** The environment variable is for documentation/reference. The actual persistence is controlled by which docker-compose files you use when starting services.

## Migrating Existing Files to Search Index

If you have existing files in the database that were uploaded before search was implemented, you need to index them:

```bash
# Run the migration script
docker exec edge-storage-service python -m app.scripts.index_existing_files
```

This will:
1. Connect to Elasticsearch
2. Index all existing files from database
3. Index all existing folders from database
4. Show progress and results

## Production Recommendations

For production deployments:

1. ✅ **Always use persistence** (`./start-prod.sh`)
2. ✅ **Regular backups** of the elasticsearch_data volume
3. ✅ **Monitor disk space** for the volume
4. ✅ **Run migration** to index existing files
5. ✅ **Set up monitoring** for Elasticsearch health

## Troubleshooting

### Search returns no results
- Check if Elasticsearch is running: `docker ps | grep elasticsearch`
- Check Elasticsearch health: `curl http://localhost:9200/_cluster/health`
- Verify indices exist: `curl http://localhost:9200/_cat/indices`
- Check if files are indexed: See "Migrating Existing Files" above

### Container restart loses all search data
- You're running in **development mode**
- Switch to **production mode** with `./start-prod.sh`

### Volume taking too much disk space
- Check volume size: `docker system df -v`
- Consider cleaning up old indices
- Implement index lifecycle management policies
