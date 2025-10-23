# ⚡ Quick Start Guide

## 🚀 Fresh Production Deploy (3 Minutes)

```bash
# 1. Navigate to project
cd /Users/immanraj/edge-cloud-storage-final-mvp/infrastructure

# 2. Create environment file
cp .env.production.example .env

# 3. Edit secrets (REQUIRED!)
nano .env
# Change: DB_PASSWORD, SECRET_KEY, SESSION_SECRET

# 4. Enable fresh database init
echo "USE_FRESH_DB_INIT=true" >> .env

# 5. Start everything
docker compose up -d

# 6. Verify
curl http://localhost:8001/api/v1/health
```

**Done!** Access at http://localhost:3000

---

## 🔑 Required Changes in .env

```bash
# Generate these (REQUIRED)
SECRET_KEY=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -hex 32)
DB_PASSWORD="YourStrongPassword123!"

# Update in .env
nano .env
```

---

## 📋 Essential Commands

### View Logs
```bash
docker compose logs -f storage-service
```

### Restart After Code Changes
```bash
docker compose build storage-service
docker compose restart storage-service
```

### Check Status
```bash
docker compose ps
```

### Backup Database
```bash
docker exec edge-postgres pg_dump -U edge_admin edge_cloud > backup.sql
```

---

## 🆘 Troubleshooting

### Service Won't Start
```bash
docker logs edge-storage-service
```

### Reset Database (⚠️ Deletes Data)
```bash
docker compose down
docker volume rm infrastructure_postgres_data
docker compose up -d
```

### Fix File Deletion Errors
```bash
# Both url_upload_jobs and file_similarities tables are now fixed!
# Just restart if you see schema errors
docker compose restart storage-service
```

---

## 📚 Full Documentation

- **Production Setup**: `docs/PRODUCTION_DATABASE_SETUP.md`
- **Deployment Guide**: `PRODUCTION_DEPLOYMENT.md`
- **Environment Variables**: `infrastructure/.env.production.example`

---

## ✅ What's Working Now

✅ **Database**: Fresh initialization (no migrations)
✅ **File Upload**: Multi-chunk, resumable uploads
✅ **File Download**: Range support, streaming
✅ **File Deletion**: Fixed schema issues
✅ **Deduplication**: Background content-addressed storage
✅ **Storage Tiers**: Hot (NVMe) → Cold (HDD) automatic tiering
✅ **Security**: Virus scanning, encryption, DLP
✅ **ML Features**: Quota prediction, optimization

---

**Your Production Environment is Ready!** 🎉

Hardware: AMD Ryzen 9 7950X | 128GB RAM | 59TB Total Storage
