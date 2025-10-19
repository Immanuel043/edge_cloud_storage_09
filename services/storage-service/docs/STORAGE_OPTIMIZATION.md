## Storage Optimization - ML-Based Storage Analysis

Production-grade machine learning feature for analyzing storage patterns and generating intelligent optimization suggestions.

## Overview

The Storage Optimization system analyzes user storage patterns to identify cost savings opportunities and generate actionable recommendations. It helps users optimize their storage costs by:
- Identifying files that should move to cold storage
- Finding compression opportunities
- Detecting duplicate files
- Highlighting unused/old files for cleanup

## Features

### 1. **Comprehensive Storage Analysis**
- Tier distribution analysis (cache/warm/cold)
- Access pattern analysis (never accessed, accessed once, etc.)
- Age-based analysis (30d, 90d, 180d, 365d)
- Duplicate file detection
- Compression opportunity identification

### 2. **Intelligent Suggestions**
- **Tier Migration**: Move cold files to cheaper storage tier
- **Compression**: Compress text-based files
- **Deduplication**: Remove duplicate files
- **Cleanup**: Review unused or old files

### 3. **Priority-Based Recommendations**
- **Critical**: >30% potential savings
- **High**: >15% potential savings
- **Medium**: >5% potential savings
- **Low**: <5% potential savings

### 4. **Detailed Impact Analysis**
- Files affected count
- Storage size affected
- Estimated savings (bytes and percentage)
- Confidence scoring

### 5. **Production Infrastructure**
- Background worker runs daily
- Caching (24-hour analysis cache)
- Prometheus metrics
- CPU-optimized

---

## Architecture

### Components

```
┌───────────────────────────────────────────────────────────┐
│            Storage Optimization System                     │
├───────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐    ┌──────────────┐   ┌──────────────┐ │
│  │   Worker     │───▶│   Analyzer   │──▶│  Database    │ │
│  │   (Daily)    │    │   Service    │   │   Tables     │ │
│  └──────────────┘    └──────────────┘   └──────────────┘ │
│         │                    │                             │
│         │                    ▼                             │
│         │             ┌──────────────┐                     │
│         │             │  Optimizer   │                     │
│         │             │   Service    │                     │
│         │             └──────────────┘                     │
│         │                    │                             │
│         ▼                    ▼                             │
│  ┌──────────────┐    ┌──────────────┐                     │
│  │ Suggestions  │    │     API      │                     │
│  │  Generator   │    │  Endpoints   │                     │
│  └──────────────┘    └──────────────┘                     │
│                                                             │
└───────────────────────────────────────────────────────────┘
```

### Database Schema

#### storage_analysis
Comprehensive storage analysis results.

```sql
CREATE TABLE storage_analysis (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id),

    -- Overall metrics
    total_files INTEGER NOT NULL,
    total_size BIGINT NOT NULL,
    duplicate_files INTEGER DEFAULT 0,
    duplicate_size BIGINT DEFAULT 0,

    -- Tier distribution
    cache_files INTEGER, cache_size BIGINT,
    warm_files INTEGER, warm_size BIGINT,
    cold_files INTEGER, cold_size BIGINT,

    -- Access patterns
    avg_access_frequency FLOAT,
    files_never_accessed INTEGER,
    size_never_accessed BIGINT,
    files_accessed_once INTEGER,
    size_accessed_once BIGINT,

    -- Age analysis
    files_older_30d INTEGER, size_older_30d BIGINT,
    files_older_90d INTEGER, size_older_90d BIGINT,
    files_older_180d INTEGER, size_older_180d BIGINT,

    -- Opportunities
    compressible_files INTEGER,
    compressible_size BIGINT,
    estimated_savings_compression BIGINT,
    files_to_cold INTEGER,
    size_to_cold BIGINT,
    estimated_savings_tiering BIGINT,
    total_potential_savings BIGINT,

    -- Metadata
    analysis_date TIMESTAMP WITH TIME ZONE,
    analysis_duration_ms INTEGER
);
```

#### optimization_suggestions
Individual optimization recommendations.

```sql
CREATE TABLE optimization_suggestions (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    analysis_id UUID REFERENCES storage_analysis(id),

    -- Suggestion details
    suggestion_type VARCHAR(50),  -- tier_migration, compression, etc.
    priority VARCHAR(20),         -- low, medium, high, critical
    title VARCHAR(255),
    description TEXT,

    -- Impact
    files_affected INTEGER,
    size_affected BIGINT,
    estimated_savings BIGINT,
    estimated_savings_percent FLOAT,

    -- Action
    action_type VARCHAR(50),
    action_details JSON,
    is_auto_applicable BOOLEAN,

    -- Status
    status VARCHAR(20),      -- pending, accepted, rejected, completed
    is_dismissed BOOLEAN,

    created_at TIMESTAMP WITH TIME ZONE,
    applied_at TIMESTAMP WITH TIME ZONE,
    dismissed_at TIMESTAMP WITH TIME ZONE
);
```

#### optimization_actions
Tracking of applied optimizations.

```sql
CREATE TABLE optimization_actions (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    suggestion_id UUID REFERENCES optimization_suggestions(id),

    action_type VARCHAR(50),
    files_processed INTEGER,
    size_processed BIGINT,
    actual_savings BIGINT,

    status VARCHAR(20),  -- pending, in_progress, completed, failed
    error_message TEXT,

    created_at TIMESTAMP WITH TIME ZONE,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE
);
```

---

## API Endpoints

### Get Storage Analysis

**GET** `/api/v1/storage/optimization/analysis`

Get comprehensive storage analysis for the authenticated user.

**Query Parameters:**
- `force_refresh` (boolean): Force new analysis instead of using cached (default: false)

**Response:**
```json
{
  "id": "analysis-uuid",
  "user_id": "user-uuid",
  "total_files": 1250,
  "total_size": 107374182400,
  "duplicate_files": 45,
  "duplicate_size": 2147483648,
  "tier_distribution": {
    "cache": {"files": 100, "size": 10737418240},
    "warm": {"files": 950, "size": 85899345920},
    "cold": {"files": 200, "size": 10737418240}
  },
  "avg_access_frequency": 3.5,
  "never_accessed": {
    "files": 150,
    "size": 5368709120
  },
  "accessed_once": {
    "files": 200,
    "size": 8589934592
  },
  "age_breakdown": {
    "30d": {"files": 400, "size": 42949672960},
    "90d": {"files": 600, "size": 64424509440},
    "180d": {"files": 800, "size": 85899345920}
  },
  "compression_savings": {
    "files": 300,
    "size": 32212254720,
    "estimated_savings": 22548578304
  },
  "tiering_savings": {
    "files": 250,
    "size": 26843545600,
    "estimated_savings": 18790481920
  },
  "total_potential_savings": 43386912768,
  "total_potential_savings_percent": 40.4,
  "analysis_date": "2025-10-18T12:00:00Z",
  "analysis_duration_ms": 2150
}
```

**Caching:**
- Analysis cached for 24 hours
- Use `force_refresh=true` to generate new analysis

---

### Get Optimization Suggestions

**GET** `/api/v1/storage/optimization/suggestions`

Get optimization suggestions for the authenticated user.

**Query Parameters:**
- `include_dismissed` (boolean): Include dismissed suggestions (default: false)
- `suggestion_type` (string): Filter by type (tier_migration, compression, deduplication, cleanup)
- `priority` (string): Filter by priority (low, medium, high, critical)

**Response:**
```json
[
  {
    "id": "suggestion-uuid",
    "user_id": "user-uuid",
    "analysis_id": "analysis-uuid",
    "suggestion_type": "tier_migration",
    "priority": "high",
    "title": "Move 250 files to cold storage",
    "description": "Move 250 infrequently accessed files (25.0 GB) to cold storage tier. These files haven't been accessed in over 90 days and could save 17.5 GB in storage costs.",
    "files_affected": 250,
    "size_affected": 26843545600,
    "estimated_savings": 18790481920,
    "estimated_savings_percent": 17.5,
    "action_type": "move_to_cold",
    "is_auto_applicable": true,
    "status": "pending",
    "is_dismissed": false,
    "created_at": "2025-10-18T12:00:00Z",
    "applied_at": null
  },
  {
    "id": "suggestion-uuid-2",
    "user_id": "user-uuid",
    "analysis_id": "analysis-uuid",
    "suggestion_type": "compression",
    "priority": "medium",
    "title": "Compress 300 text-based files",
    "description": "Compress 300 text-based files (30.0 GB) to save space. Estimated savings: 21.0 GB (19.6% of total storage).",
    "files_affected": 300,
    "size_affected": 32212254720,
    "estimated_savings": 22548578304,
    "estimated_savings_percent": 21.0,
    "action_type": "compress",
    "is_auto_applicable": true,
    "status": "pending",
    "is_dismissed": false,
    "created_at": "2025-10-18T12:00:00Z",
    "applied_at": null
  }
]
```

**Suggestion Types:**
- `tier_migration`: Move files to cold storage
- `compression`: Compress text-based files
- `deduplication`: Remove duplicate files
- `cleanup`: Review/delete unused or old files

**Priorities:**
- `critical`: >30% potential savings
- `high`: >15% potential savings
- `medium`: >5% potential savings
- `low`: <5% potential savings

---

### Get Optimization Summary

**GET** `/api/v1/storage/optimization/summary`

Get high-level optimization summary with breakdowns.

**Response:**
```json
{
  "user_id": "user-uuid",
  "total_size": 107374182400,
  "total_files": 1250,
  "breakdown_by_tier": [
    {"category": "cache", "files": 100, "size": 10737418240, "percent": 10.0},
    {"category": "warm", "files": 950, "size": 85899345920, "percent": 80.0},
    {"category": "cold", "files": 200, "size": 10737418240, "percent": 10.0}
  ],
  "breakdown_by_age": [
    {"category": "< 30 days", "files": 450, "size": 42949672960, "percent": 40.0},
    {"category": "30-90 days", "files": 200, "size": 21474836480, "percent": 20.0},
    {"category": "90-180 days", "files": 200, "size": 21474836480, "percent": 20.0},
    {"category": "> 180 days", "files": 400, "size": 42949672960, "percent": 40.0}
  ],
  "breakdown_by_access": [
    {"category": "Never accessed", "files": 150, "size": 5368709120, "percent": 5.0},
    {"category": "Accessed once", "files": 200, "size": 8589934592, "percent": 8.0},
    {"category": "Accessed multiple times", "files": 900, "size": 93415538688, "percent": 87.0}
  ],
  "total_potential_savings": 43386912768,
  "total_potential_savings_percent": 40.4,
  "suggestion_count": 4,
  "high_priority_count": 2,
  "last_analysis_date": "2025-10-18T12:00:00Z"
}
```

---

### Dismiss Suggestion

**POST** `/api/v1/storage/optimization/suggestions/{suggestion_id}/dismiss`

Dismiss a specific optimization suggestion.

**Response:**
```json
{
  "status": "success",
  "message": "Suggestion dismissed"
}
```

---

### Trigger Analysis

**POST** `/api/v1/storage/optimization/trigger-analysis`

Manually trigger storage analysis for current user.

**Response:**
```json
{
  "status": "success",
  "message": "Storage analysis completed",
  "analysis_id": "analysis-uuid",
  "suggestions_generated": 4
}
```

---

## Configuration

Environment variables for storage optimization:

```bash
# Enable/disable storage optimization
STORAGE_OPTIMIZATION_ENABLED=true

# Analysis interval (seconds, default 24 hours)
STORAGE_OPT_ANALYSIS_INTERVAL=86400

# Minimum savings threshold (bytes, default 10MB)
STORAGE_OPT_MIN_SAVINGS_THRESHOLD=10485760

# CPU optimization
ML_CPU_THREADS=32
ML_BATCH_SIZE=100
```

---

## Background Worker

The storage optimization worker runs automatically every 24 hours.

### What It Does

1. **Analyze Storage**: Scans all files for each user
2. **Calculate Metrics**: Tier distribution, access patterns, age analysis
3. **Identify Opportunities**: Compression, tiering, deduplication, cleanup
4. **Generate Suggestions**: Priority-based recommendations with impact estimates

### Manual Trigger

Admins can manually trigger the worker:

**POST** `/api/v1/storage/optimization/admin/trigger-worker`

```json
{
  "status": "success",
  "message": "Storage optimization worker executed successfully"
}
```

---

## Optimization Strategies

### 1. Tier Migration

**Goal**: Move cold files to cheaper storage tier

**Criteria**:
- Not accessed in last 90 days
- Currently in cache or warm tier
- File size > 1MB
- Access count ≤ 5

**Savings**: ~70% cost reduction for cold storage

**Example**:
```
Files: 250
Size: 25 GB
Savings: 17.5 GB worth of warm storage costs
```

### 2. Compression

**Goal**: Compress text-based files to save space

**Compressible Types**:
- text/*
- application/json
- application/xml
- application/javascript
- text/html, text/css, text/csv

**Expected Ratios**:
- JSON: 75% compression (25% remaining)
- XML: 70% compression
- JavaScript: 65% compression
- Text: 70% compression

**Example**:
```
Files: 300
Size: 30 GB
Estimated after compression: 9 GB
Savings: 21 GB
```

### 3. Deduplication

**Goal**: Remove duplicate files

**Detection**: Hash-based (SHA-256)

**Strategy**: Keep one copy, remove duplicates

**Example**:
```
Files: 45 duplicates
Size: 2 GB
Savings: 2 GB (pure space saving)
```

### 4. Cleanup Suggestions

**Never Accessed Files**:
- Files uploaded but never downloaded
- Suggest review after 30+ days

**Old Files (>180 days)**:
- Files older than 6 months
- Low priority suggestions
- Assume 50% could be removed

---

## Monitoring

### Prometheus Metrics

All metrics exposed at `/metrics`:

#### Worker Metrics
- `storage_optimization_worker_cycles_total`: Total worker cycles
- `storage_optimization_worker_errors_total`: Worker errors
- `storage_optimization_worker_manual_triggers_total`: Manual triggers

#### Analysis Metrics
- `storage_analyses_completed_total`: Total analyses completed
- `storage_analysis_cache_hits_total`: Cache hits
- `storage_analysis_cache_misses_total`: Cache misses
- `storage_optimization_analysis_duration_ms`: Analysis duration histogram

#### Suggestion Metrics
- `storage_optimization_suggestions_generated_total`: Suggestions generated
- `storage_optimization_suggestions_dismissed_total`: Suggestions dismissed
- `storage_optimization_suggestions_applied_total`: Suggestions applied

#### Manual Triggers
- `storage_optimization_manual_triggers_total`: User-initiated analyses

#### Gauges
- `storage_potential_savings_bytes{user_id}`: Per-user potential savings

### Health Check

Check worker status:

**GET** `/api/v1/health`

```json
{
  "status": "healthy",
  "checks": {
    "storage_optimization": "running"
  },
  "features": {
    "storage_optimization": true
  }
}
```

---

## Performance

### CPU Optimization

Optimized for **AMD Ryzen 9 7950X** (16C/32T):
- Parallel file analysis
- Batch processing (100 users per batch)
- Efficient hash-based duplicate detection

### Analysis Performance

**Hardware:** AMD Ryzen 9 7950X, 128GB RAM

**Per-User Analysis:**
- 1,000 files: ~500-1000ms
- 10,000 files: ~2-5 seconds
- 100,000 files: ~20-50 seconds

**Batch Processing (1000 users):**
- Total time: ~10-30 minutes
- Parallel processing: Up to 32 concurrent
- Memory usage: ~4-8GB

---

## Installation

### 1. Run Database Migration

```bash
cd /app/services/storage-service
alembic upgrade head
```

Creates:
- `storage_analysis` table
- `optimization_suggestions` table
- `optimization_actions` table

### 2. Start the Service

Worker starts automatically if `STORAGE_OPTIMIZATION_ENABLED=true`.

---

## Testing

### Test Analysis API

```bash
# Get analysis
curl -X GET http://localhost:8001/api/v1/storage/optimization/analysis \
  -H "Authorization: Bearer $TOKEN"

# Force refresh
curl -X GET "http://localhost:8001/api/v1/storage/optimization/analysis?force_refresh=true" \
  -H "Authorization: Bearer $TOKEN"
```

### Test Suggestions API

```bash
# Get all suggestions
curl -X GET http://localhost:8001/api/v1/storage/optimization/suggestions \
  -H "Authorization: Bearer $TOKEN"

# Filter by type
curl -X GET "http://localhost:8001/api/v1/storage/optimization/suggestions?suggestion_type=tier_migration" \
  -H "Authorization: Bearer $TOKEN"

# Filter by priority
curl -X GET "http://localhost:8001/api/v1/storage/optimization/suggestions?priority=high" \
  -H "Authorization: Bearer $TOKEN"
```

### Test Summary API

```bash
curl -X GET http://localhost:8001/api/v1/storage/optimization/summary \
  -H "Authorization: Bearer $TOKEN"
```

### Dismiss Suggestion

```bash
curl -X POST http://localhost:8001/api/v1/storage/optimization/suggestions/{id}/dismiss \
  -H "Authorization: Bearer $TOKEN"
```

### Manual Trigger

```bash
# Trigger analysis for current user
curl -X POST http://localhost:8001/api/v1/storage/optimization/trigger-analysis \
  -H "Authorization: Bearer $TOKEN"

# Trigger worker for all users (admin)
curl -X POST http://localhost:8001/api/v1/storage/optimization/admin/trigger-worker \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## Troubleshooting

### Worker Not Running

**Check:**
1. `STORAGE_OPTIMIZATION_ENABLED=true`
2. No errors in logs
3. Database migration completed

### Low Savings Estimates

**Reasons:**
- Already optimized storage
- Few old/unused files
- No compressible files

### Analysis Takes Too Long

**Solutions:**
- Normal for 100K+ files
- Check CPU usage
- Consider increasing `ML_CPU_THREADS`

---

## Future Enhancements

1. **Automatic Application**: Auto-apply safe suggestions
2. **ML-Based Prediction**: Predict which files will become cold
3. **Cost Estimation**: Show dollar savings per tier
4. **Smart Compression**: Choose best algorithm per file type
5. **Archive Suggestions**: Suggest archiving to external storage

---

## License

Part of Edge Cloud Storage - Production-grade distributed storage system.
