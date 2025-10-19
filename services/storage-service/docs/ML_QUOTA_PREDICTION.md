# ML-Based Quota Prediction

Production-grade machine learning feature for predicting storage quota usage and generating proactive alerts.

## Overview

The Quota Prediction system uses time-series forecasting to predict when users will run out of storage space and generates alerts before it happens. This allows users to take proactive action and prevents unexpected quota exhaustion.

## Features

### 1. **Multi-Algorithm Prediction**
- **Prophet** (Facebook's time-series library): Best for detecting seasonal patterns and trends
- **Linear Regression** (scikit-learn): Good for linear growth patterns
- **Moving Average**: Simple but reliable fallback that always works

The system automatically tries algorithms in order of sophistication and falls back to simpler methods if necessary.

### 2. **Automatic Usage Tracking**
- Daily snapshots of storage usage per user
- Tracks usage by tier (cache/warm/cold)
- File count tracking
- Minimum 7 days of history required for predictions

### 3. **Smart Alerting**
- **70% Threshold**: Early warning
- **85% Threshold**: Warning
- **95% Threshold**: Critical warning
- **Predicted Full**: ML-based prediction of quota depletion within 30 days

### 4. **Confidence Scoring**
- All predictions include confidence scores (0.0 to 1.0)
- Predictions for 7, 14, and 30 days ahead
- Confidence decreases for longer-term predictions

### 5. **Production-Grade Infrastructure**
- Background worker runs daily
- Caching to avoid redundant calculations
- Prometheus metrics for monitoring
- CPU-optimized for AMD Ryzen 9 7950X (32 threads)

---

## Architecture

### Components

```
┌─────────────────────────────────────────────────────────────┐
│                    Quota Prediction System                   │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌─────────────┐      ┌──────────────┐     ┌─────────────┐ │
│  │   Worker    │─────▶│  Predictor   │────▶│  Database   │ │
│  │  (Daily)    │      │   Service    │     │   Tables    │ │
│  └─────────────┘      └──────────────┘     └─────────────┘ │
│        │                     │                               │
│        │                     │                               │
│        ▼                     ▼                               │
│  ┌─────────────┐      ┌──────────────┐                      │
│  │   Alert     │      │     API      │                      │
│  │ Generator   │      │   Endpoints  │                      │
│  └─────────────┘      └──────────────┘                      │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### Database Schema

#### storage_usage_history
Daily storage usage snapshots for ML training.

```sql
CREATE TABLE storage_usage_history (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    date TIMESTAMP WITH TIME ZONE NOT NULL,
    storage_used BIGINT NOT NULL,
    cache_used BIGINT DEFAULT 0,
    warm_used BIGINT DEFAULT 0,
    cold_used BIGINT DEFAULT 0,
    file_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (user_id, date)
);
```

#### quota_predictions
ML-generated predictions.

```sql
CREATE TABLE quota_predictions (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    predicted_7d BIGINT,
    predicted_14d BIGINT,
    predicted_30d BIGINT,
    confidence_7d FLOAT,
    confidence_14d FLOAT,
    confidence_30d FLOAT,
    days_until_full INTEGER,
    model_type VARCHAR(50),  -- 'prophet', 'linear_regression', 'moving_average'
    prediction_date TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

#### quota_alerts
User quota alerts.

```sql
CREATE TABLE quota_alerts (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    alert_type VARCHAR(50),  -- '70_percent', '85_percent', '95_percent', 'predicted_full'
    current_usage_bytes BIGINT NOT NULL,
    quota_bytes BIGINT NOT NULL,
    usage_percent FLOAT NOT NULL,
    threshold_percent FLOAT,
    predicted_days_remaining INTEGER,
    is_dismissed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    dismissed_at TIMESTAMP WITH TIME ZONE
);
```

---

## API Endpoints

### Get Quota Prediction

**GET** `/api/v1/quota/prediction`

Get ML-based quota prediction for the authenticated user.

**Query Parameters:**
- `force_refresh` (boolean): Force regenerate prediction instead of using cached

**Response:**
```json
{
  "user_id": "123e4567-e89b-12d3-a456-426614174000",
  "current_usage_bytes": 53687091200,
  "quota_bytes": 107374182400,
  "usage_percent": 0.50,
  "predicted_7d": 56294400000,
  "predicted_14d": 58901708800,
  "predicted_30d": 64116326400,
  "confidence_7d": 0.92,
  "confidence_14d": 0.87,
  "confidence_30d": 0.78,
  "days_until_full": 45,
  "will_exceed_quota": false,
  "model_type": "prophet",
  "prediction_date": "2025-10-18T00:00:00Z"
}
```

**Caching:**
- Predictions are cached for 24 hours
- Use `force_refresh=true` to bypass cache

**Error Codes:**
- `400`: Insufficient usage history (need at least 7 days)
- `500`: Prediction generation failed

---

### Get Usage History

**GET** `/api/v1/quota/history`

Get historical storage usage data for trend analysis.

**Query Parameters:**
- `days` (integer, 7-365): Number of days of history to retrieve (default: 30)

**Response:**
```json
{
  "user_id": "123e4567-e89b-12d3-a456-426614174000",
  "start_date": "2025-09-18T00:00:00Z",
  "end_date": "2025-10-18T00:00:00Z",
  "total_points": 30,
  "data_points": [
    {
      "date": "2025-09-18T00:00:00Z",
      "storage_used": 48318382080,
      "file_count": 1250,
      "cache_used": 10737418240,
      "warm_used": 26843545600,
      "cold_used": 10737418240
    },
    ...
  ]
}
```

---

### Get Quota Alerts

**GET** `/api/v1/quota/alerts`

Get quota alerts for the authenticated user.

**Query Parameters:**
- `include_dismissed` (boolean): Include previously dismissed alerts (default: false)

**Response:**
```json
[
  {
    "id": "alert-uuid",
    "alert_type": "85_percent",
    "current_usage_bytes": 91268055040,
    "quota_bytes": 107374182400,
    "usage_percent": 0.85,
    "threshold_percent": 0.85,
    "predicted_days_remaining": null,
    "is_dismissed": false,
    "created_at": "2025-10-18T00:00:00Z",
    "message": "Your storage is 85% full. You're approaching your quota limit."
  },
  {
    "id": "alert-uuid-2",
    "alert_type": "predicted_full",
    "current_usage_bytes": 91268055040,
    "quota_bytes": 107374182400,
    "usage_percent": 0.85,
    "threshold_percent": null,
    "predicted_days_remaining": 15,
    "is_dismissed": false,
    "created_at": "2025-10-18T00:00:00Z",
    "message": "Your storage is predicted to be full in 15 days."
  }
]
```

**Alert Types:**
- `70_percent`: Usage exceeded 70% of quota
- `85_percent`: Usage exceeded 85% of quota
- `95_percent`: Usage exceeded 95% of quota (critical)
- `predicted_full`: Predicted to run out within 30 days

---

### Dismiss Alert

**POST** `/api/v1/quota/alerts/dismiss`

Dismiss a single alert.

**Request Body:**
```json
{
  "alert_id": "alert-uuid"
}
```

**Response:**
```json
{
  "status": "success",
  "message": "Alert dismissed"
}
```

---

### Dismiss All Alerts

**POST** `/api/v1/quota/alerts/dismiss-all`

Dismiss all active alerts.

**Response:**
```json
{
  "status": "success",
  "message": "Dismissed 3 alerts",
  "count": 3
}
```

---

### Get Quota Statistics

**GET** `/api/v1/quota/stats`

Get comprehensive quota statistics and insights.

**Response:**
```json
{
  "current_usage": {
    "bytes": 53687091200,
    "quota": 107374182400,
    "percent": 0.50,
    "available": 53687091200
  },
  "trends": {
    "growth_rate_30d": 12.5,
    "data_points": 30,
    "tracking_since": "2025-09-18T00:00:00Z"
  },
  "predictions": {
    "available": true,
    "days_until_full": 45,
    "model_used": "prophet",
    "last_updated": "2025-10-18T00:00:00Z"
  },
  "alerts": {
    "active_count": 2,
    "has_warnings": true
  },
  "recommendations": [
    "Your storage usage is growing rapidly. Monitor your uploads."
  ]
}
```

---

## Configuration

Add these environment variables to configure the quota prediction system:

```bash
# Enable/disable quota prediction
QUOTA_PREDICTION_ENABLED=true

# Minimum days of history required for predictions
QUOTA_PREDICTION_MIN_DATA_POINTS=7

# Worker interval (seconds, default 24 hours)
QUOTA_PREDICTION_WORKER_INTERVAL=86400

# Days to warn before predicted quota depletion
QUOTA_DEPLETION_WARNING_DAYS=30

# CPU optimization (for AMD Ryzen 9 7950X)
ML_CPU_THREADS=32
ML_BATCH_SIZE=100
```

---

## Background Worker

The quota prediction worker runs automatically every 24 hours.

### What It Does

1. **Record Usage History**: Snapshots storage usage for all active users
2. **Generate Predictions**: Runs ML models to predict future usage
3. **Generate Alerts**: Creates alerts based on thresholds and predictions

### Manual Trigger

Admins can manually trigger the worker:

**POST** `/api/v1/quota/admin/trigger-worker`

```json
{
  "status": "success",
  "message": "Quota prediction worker executed successfully"
}
```

---

## ML Models

### 1. Prophet (Preferred)

**Library:** `prophet` (Facebook)

**Best For:**
- Detecting seasonal patterns (weekly, monthly trends)
- Handling missing data
- Users with longer history (14+ days)

**Configuration:**
```python
Prophet(
    daily_seasonality=False,
    weekly_seasonality=True,  # if >= 14 days
    yearly_seasonality=False,
    interval_width=0.80  # 80% confidence intervals
)
```

**When Used:**
- Prophet library is installed
- At least 7 days of history available

### 2. Linear Regression (Fallback 1)

**Library:** `scikit-learn`

**Best For:**
- Linear growth patterns
- Users with consistent upload behavior

**Confidence Calculation:**
- Based on R² score
- Decreases for longer predictions (×0.95, ×0.85, ×0.75)

**When Used:**
- Prophet not available or fails
- sklearn is installed

### 3. Moving Average (Fallback 2)

**Library:** `numpy` (always available)

**Best For:**
- Simple, reliable predictions
- Users with limited history

**Algorithm:**
- Calculates daily growth from last 7 days (or all available)
- Projects linearly into the future
- Conservative confidence scores (0.3-0.8 range)

**When Used:**
- Other models not available or fail
- Always succeeds as final fallback

---

## Monitoring

### Prometheus Metrics

All metrics are exposed at `/metrics`:

#### Worker Metrics
- `storage_quota_prediction_worker_cycles_total`: Total worker cycles
- `storage_quota_prediction_worker_errors_total`: Worker errors
- `storage_quota_prediction_worker_manual_triggers_total`: Manual triggers

#### Prediction Metrics
- `storage_quota_predictions_generated_total`: Total predictions generated
- `storage_quota_prediction_cache_hits_total`: Cache hits
- `storage_quota_prediction_cache_misses_total`: Cache misses
- `storage_quota_predictions_api_generated_total`: API-generated predictions
- `storage_quota_prediction_model_usage_total{model_type}`: Usage by model type
- `storage_quota_prediction_confidence_score{prediction_period}`: Confidence distribution

#### Alert Metrics
- `storage_quota_alerts_generated_total`: Total alerts generated
- `storage_quota_alerts_dismissed_total`: Total alerts dismissed
- `storage_quota_days_until_full{user_id}`: Days until full per user

#### Data Metrics
- `storage_quota_usage_history_recorded_total`: History records created

### Health Check

Check worker status in health endpoint:

**GET** `/api/v1/health`

```json
{
  "status": "healthy",
  "checks": {
    "quota_prediction": "running"
  },
  "features": {
    "quota_prediction": true
  }
}
```

---

## Performance

### CPU Optimization

Optimized for **AMD Ryzen 9 7950X** (16C/32T):

```python
import os
os.environ['OMP_NUM_THREADS'] = '32'
os.environ['MKL_NUM_THREADS'] = '32'
```

### Batch Processing

Worker processes all users in batches:
- Batch size: 100 users (configurable via `ML_BATCH_SIZE`)
- Processes sequentially to avoid memory issues
- Error handling per user (failures don't stop batch)

### Caching

- Predictions cached for 24 hours
- Reduces redundant ML calculations
- Cache bypass with `force_refresh=true`

---

## Installation

### 1. Install ML Libraries

```bash
# Required (always needed)
pip install numpy pandas sqlalchemy

# Optional (for better predictions)
pip install prophet scikit-learn

# If prophet fails to install, predictions will still work with fallback models
```

### 2. Run Database Migration

```bash
cd /app/services/storage-service
alembic upgrade head
```

This creates:
- `storage_usage_history` table
- `quota_predictions` table
- `quota_alerts` table

### 3. Start the Service

The worker starts automatically when the service starts if `QUOTA_PREDICTION_ENABLED=true`.

---

## Testing

### Test Prediction API

```bash
# Get prediction (will fail if < 7 days of history)
curl -X GET http://localhost:8001/api/v1/quota/prediction \
  -H "Authorization: Bearer $TOKEN"

# Force refresh
curl -X GET "http://localhost:8001/api/v1/quota/prediction?force_refresh=true" \
  -H "Authorization: Bearer $TOKEN"
```

### Test Usage History

```bash
# Get 30 days of history
curl -X GET "http://localhost:8001/api/v1/quota/history?days=30" \
  -H "Authorization: Bearer $TOKEN"
```

### Test Alerts

```bash
# Get alerts
curl -X GET http://localhost:8001/api/v1/quota/alerts \
  -H "Authorization: Bearer $TOKEN"

# Dismiss alert
curl -X POST http://localhost:8001/api/v1/quota/alerts/dismiss \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"alert_id": "alert-uuid"}'
```

### Manual Worker Trigger

```bash
# Trigger worker manually (admin only)
curl -X POST http://localhost:8001/api/v1/quota/admin/trigger-worker \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## Troubleshooting

### "Insufficient usage history" Error

**Problem:** Not enough data for predictions (need 7+ days)

**Solution:**
- Wait for worker to collect more daily snapshots
- Or manually insert historical data for testing

### Prophet Installation Issues

**Problem:** Prophet fails to install or import

**Solution:**
- Predictions will automatically fall back to Linear Regression or Moving Average
- No action needed, system is designed to work without Prophet

### Worker Not Running

**Problem:** Worker status shows "stopped" in health check

**Check:**
1. `QUOTA_PREDICTION_ENABLED=true` in environment
2. No errors in logs during startup
3. Database migration completed

### Low Confidence Scores

**Problem:** Predictions have low confidence (<0.5)

**Reasons:**
- Not enough historical data
- Highly variable usage patterns
- Using Moving Average fallback model

**Solutions:**
- Wait for more history to accumulate
- Review usage patterns for anomalies

---

## Future Enhancements

1. **Email Notifications**: Send alerts via email
2. **Anomaly Detection**: Detect unusual usage spikes
3. **Multi-Tenant Predictions**: Predictions for team/organization level
4. **Custom Alert Thresholds**: User-configurable alert levels
5. **Storage Recommendations**: Suggest tier migrations or cleanup

---

## License

Part of Edge Cloud Storage - Production-grade distributed storage system.
