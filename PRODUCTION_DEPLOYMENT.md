# 🚀 Production Deployment Quick Start

## For Your Hardware: AMD Ryzen 9 7950X | 128GB RAM | NVMe + HDD Storage

This guide is optimized for your single-server production setup.

---

## 🎯 Quick Deploy (Fresh Production Install)

```bash
# 1. Navigate to infrastructure directory
cd /Users/immanraj/edge-cloud-storage-final-mvp/infrastructure

# 2. Create production environment file
cp .env.production.example .env

# 3. Edit .env and set:
#    - Strong passwords (DB_PASSWORD, SECRET_KEY, SESSION_SECRET)
#    - Your domain (FRONTEND_URL, CORS_ORIGINS)
#    - Email settings (if using notifications)
nano .env

# 4. Enable fresh database initialization
echo "USE_FRESH_DB_INIT=true" >> .env

# 5. Build and start services
docker compose build
docker compose up -d

# 6. Verify deployment
docker logs edge-storage-service | grep "Database initialization completed"
```

**That's it!** Your production system is running with a fresh database.

---

## 📋 Pre-Flight Checklist

Before deploying to production:

- [ ] **Backup any existing data**
  ```bash
  docker exec edge-postgres pg_dump -U edge_admin edge_cloud > backup_$(date +%Y%m%d).sql
  ```

- [ ] **Generate strong secrets**
  ```bash
  # Generate SECRET_KEY
  openssl rand -hex 32

  # Generate SESSION_SECRET
  openssl rand -hex 32
  ```

- [ ] **Set strong database password**
  ```bash
  # Edit .env and change DB_PASSWORD
  nano .env
  ```

- [ ] **Configure storage paths** (for your NVMe drives)
  ```bash
  # Create mount points
  sudo mkdir -p /mnt/database
  sudo mkdir -p /mnt/hot-storage
  sudo mkdir -p /mnt/cache
  sudo mkdir -p /mnt/cold-storage
  ```

- [ ] **Set up RAID for cold storage** (6×8TB WD Red)
  ```bash
  # RAID-6 setup (42TB usable, 2-drive fault tolerance)
  sudo mdadm --create /dev/md0 --level=6 --raid-devices=6 \
    /dev/sda /dev/sdb /dev/sdc /dev/sdd /dev/sde /dev/sdf

  sudo mkfs.ext4 /dev/md0
  sudo mount /dev/md0 /mnt/cold-storage
  ```

---

## 🔧 Common Operations

### Check Service Status
```bash
docker compose ps
docker logs edge-storage-service --tail 50
```

### View Database Tables
```bash
docker exec edge-postgres psql -U edge_admin -d edge_cloud -c "\dt"
```

### Restart Service After Code Changes
```bash
docker compose build storage-service
docker compose restart storage-service
```

### View Real-time Logs
```bash
docker compose logs -f storage-service
```

### Check Disk Usage
```bash
# Hot storage (NVMe)
df -h /mnt/hot-storage

# Cold storage (RAID-6 HDD)
df -h /mnt/cold-storage

# Docker volumes
docker system df -v
```

---

## 🗄️ Database Management

### Fresh Database Creation (First Deploy)
```bash
# In .env file
USE_FRESH_DB_INIT=true
FORCE_RECREATE=false  # Don't drop if tables exist

# Restart to apply
docker compose restart storage-service
```

### Complete Database Reset (⚠️ Deletes All Data!)
```bash
# Backup first!
docker exec edge-postgres pg_dump -U edge_admin edge_cloud > backup.sql

# Reset
docker compose down
docker volume rm infrastructure_postgres_data
docker compose up -d

# Database will be created fresh automatically
```

### Manual Database Initialization
```bash
docker exec edge-storage-service python -m app.scripts.init_database
```

### Database Backup
```bash
# Create backup
docker exec edge-postgres pg_dump -U edge_admin edge_cloud | \
  gzip > backup_$(date +%Y%m%d_%H%M%S).sql.gz

# Restore backup
gunzip < backup_20251023_120000.sql.gz | \
  docker exec -i edge-postgres psql -U edge_admin edge_cloud
```

---

## 🔍 Troubleshooting

### Service Won't Start
```bash
# Check logs
docker logs edge-storage-service

# Check database connectivity
docker exec edge-storage-service nc -zv postgres 5432

# Check if ports are available
sudo lsof -i :80
sudo lsof -i :443
sudo lsof -i :8001
```

### Database Schema Errors
```bash
# Force fresh schema (⚠️ deletes data)
docker exec edge-storage-service bash -c \
  "FORCE_RECREATE=true python -m app.scripts.init_database"
```

### Out of Memory
```bash
# Check memory usage
docker stats

# Reduce workers if needed (in .env)
WORKER_PROCESSES=4  # Instead of 8
```

### Disk Full
```bash
# Check disk usage
docker system df

# Clean up unused images/containers
docker system prune -a

# Check cold storage tiering
docker logs edge-storage-service | grep "Tiering"
```

---

## 📊 Monitoring

### System Resources
```bash
# Real-time monitoring
docker stats

# Specific service
docker stats edge-storage-service
```

### Application Health
```bash
# Health check endpoint
curl http://localhost:8001/api/v1/health

# Storage stats
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:8001/api/v1/storage/stats
```

### Database Performance
```bash
docker exec edge-postgres psql -U edge_admin -d edge_cloud -c "
  SELECT schemaname, tablename,
         pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
  FROM pg_tables
  WHERE schemaname = 'public'
  ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
  LIMIT 10;
"
```

---

## 🔒 Security Hardening

### Change Default Passwords
```bash
# PostgreSQL
docker exec edge-postgres psql -U edge_admin -c \
  "ALTER USER edge_admin WITH PASSWORD 'new_strong_password';"

# Update .env file
nano .env  # Change DB_PASSWORD
docker compose restart storage-service
```

### Enable SSL/TLS
```bash
# Generate self-signed cert (for testing)
mkdir -p infrastructure/ssl
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout infrastructure/ssl/nginx.key \
  -out infrastructure/ssl/nginx.crt

# Or use Let's Encrypt (production)
docker compose --profile production up certbot
```

### Firewall Configuration
```bash
# Allow only necessary ports
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable
```

---

## 📈 Performance Optimization

### For Your Hardware (128GB RAM, 16 Cores)

**Recommended Settings in .env:**
```bash
# Database
DB_POOL_SIZE=50
DB_MAX_OVERFLOW=100

# Redis
REDIS_MAX_CONNECTIONS=100

# Workers
WORKER_PROCESSES=8  # Half of CPU cores

# Memory
# Let Docker use up to 80GB for storage-service
# (Set in docker-compose.yml: mem_limit: 80g)

# Chunk processing
CHUNK_SIZE=33554432  # 32MB chunks
```

### Storage Tier Strategy
```
Hot (NVMe 4TB):  Recently uploaded, frequently accessed
Warm (NVMe 4TB): Accessed in last 30 days
Cold (HDD 48TB): Archived, rarely accessed
```

---

## 🔄 Updates & Maintenance

### Update Application Code
```bash
# 1. Pull latest changes
git pull origin main

# 2. Rebuild container
docker compose build storage-service

# 3. Restart service
docker compose up -d storage-service

# 4. Verify
docker logs edge-storage-service --tail 50
```

### Update Dependencies
```bash
# Rebuild with --no-cache
docker compose build --no-cache storage-service
docker compose up -d storage-service
```

### Database Maintenance
```bash
# Vacuum database
docker exec edge-postgres psql -U edge_admin -d edge_cloud -c "VACUUM ANALYZE;"

# Reindex
docker exec edge-postgres psql -U edge_admin -d edge_cloud -c "REINDEX DATABASE edge_cloud;"
```

---

## 📞 Support

### Logs Location
- Application: `docker logs edge-storage-service`
- Database: `docker logs edge-postgres`
- Nginx: `infrastructure/logs/nginx/`

### Common Log Commands
```bash
# All services
docker compose logs -f

# Specific service, last 100 lines
docker logs edge-storage-service --tail 100 -f

# Search logs
docker logs edge-storage-service 2>&1 | grep ERROR

# Export logs
docker logs edge-storage-service > debug.log 2>&1
```

---

## ✅ Production Checklist

Before going live:

- [ ] Fresh database initialized with `USE_FRESH_DB_INIT=true`
- [ ] Strong passwords set for all services
- [ ] SSL/TLS certificates configured
- [ ] Backups configured and tested
- [ ] Monitoring set up
- [ ] Disk space sufficient (check all drives)
- [ ] RAID configured for cold storage
- [ ] Firewall rules applied
- [ ] Health check endpoint responding
- [ ] Test file upload/download
- [ ] Test file deletion
- [ ] Test deduplication (upload same file twice)
- [ ] Verify cold storage tiering

---

**Your hardware is ready for production!** 🎉

With 128GB RAM and 16 cores, your server can easily handle:
- 100+ concurrent users
- 20GB file uploads
- Real-time deduplication
- ML-powered features
- 48TB+ total storage capacity

**Questions?** Check `docs/PRODUCTION_DATABASE_SETUP.md` for detailed documentation.
