# Rate Limits Quick Reference Card

**Last Updated**: October 21, 2025
**Status**: Production Ready ✅

---

## 🚀 Quick Start

### Prerequisites
```bash
# 1. Redis must be running
docker-compose up -d redis

# 2. Verify Redis
redis-cli ping  # Should return: PONG

# 3. Environment variable set
export REDIS_URL=redis://localhost:6379/0
```

### Test Rate Limiting
```bash
# Test login (should fail on 6th attempt)
for i in {1..6}; do
  curl -X POST http://localhost:8000/api/v1/auth/login \
    -d "email=test@test.com&password=wrong" \
    -w "\nHTTP %{http_code}\n"
done
```

---

## 📊 Rate Limits by Category

### 🔐 Authentication
| Endpoint | Limit | Notes |
|----------|-------|-------|
| `POST /api/v1/auth/register` | 3/hour, 10/day | Prevent spam |
| `POST /api/v1/auth/login` | 5/min, 20/hour | Brute force protection |
| `POST /api/v1/auth/refresh` | 10/min, 100/hour | Token refresh |
| `GET /api/v1/auth/oauth/{provider}/login` | 10/min, 50/hour | OAuth initiate |

### 📁 File Operations
| Endpoint | Limit | Notes |
|----------|-------|-------|
| `GET /api/v1/files` | 500/hour, 3000/day | List files |
| `GET /api/v1/files/{id}/download` | 200/hour, 2000/day | Downloads |
| `DELETE /api/v1/files/{id}` | 100/hour, 500/day | Deletions |
| `POST /api/v1/upload/init` | 50/hour, 500/day | Upload start |

### 🔍 Search
| Endpoint | Limit | Notes |
|----------|-------|-------|
| `POST /api/v1/search/` | 100/hour, 1000/day | Full search |
| `GET /api/v1/search/autocomplete` | 100/hour, 1000/day | Autocomplete |

### 🤖 ML Operations
| Endpoint | Limit | Notes |
|----------|-------|-------|
| `GET /api/v1/quota/prediction` | 100/hour, 500/day | Quota predictions |
| `GET /api/v1/recommendations/` | 100/hour, 500/day | Content recommendations |
| `GET /api/v1/storage/optimization/analysis` | 50/hour, 200/day | Storage analysis (expensive) |
| `POST /api/v1/organization/start` | 50/hour, 200/day | Auto-organize (expensive) |

### ⭐ Favorites & Recents
| Endpoint | Limit | Notes |
|----------|-------|-------|
| `GET /api/v1/files/recents` | 500/hour, 5000/day | Recent files |
| `GET /api/v1/files/favorites` | 500/hour, 5000/day | Favorite files |
| `POST /api/v1/files/{id}/favorite` | 100/hour, 1000/day | Toggle favorite |

---

## 🔧 Configuration

### Changing Rate Limits

**File**: `app/utils/rate_limiter.py`

```python
class RateLimitConfig:
    FILE_UPLOAD = "50/hour;500/day"  # Change this
    FILE_DOWNLOAD = "200/hour;2000/day"
    # ... etc
```

Then restart service:
```bash
docker-compose restart storage-service
```

### Multi-Window Limits

Format: `"X/timewindow;Y/timewindow"`

Examples:
- `"5/minute;20/hour"` - Max 5 per minute AND 20 per hour
- `"100/hour;1000/day"` - Max 100 per hour AND 1000 per day
- `"10/minute"` - Only minute limit

---

## 🧪 Testing Commands

### Check Rate Limit Headers
```bash
curl -I http://localhost:8000/api/v1/health
```

Look for:
```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1635172800
```

### Test Upload Limit (50/hour)
```bash
TOKEN="your_token_here"
for i in {1..55}; do
  curl -X POST "http://localhost:8000/api/v1/upload/init?file_name=test$i.txt&file_size=1024" \
    -H "Authorization: Bearer $TOKEN" \
    -w "\nHTTP %{http_code}\n"
done
# Should get 429 after 50 requests
```

### Check Redis Keys
```bash
redis-cli

# List rate limit keys
KEYS LIMITER:*

# Check specific key
GET "LIMITER:/api/v1/upload/init:user:USER_ID:hour"

# Check TTL (time to live)
TTL "LIMITER:/api/v1/upload/init:user:USER_ID:hour"
```

---

## ⚠️ Error Responses

### 429 Too Many Requests

**Response**:
```json
{
  "error": "rate_limit_exceeded",
  "message": "Too many requests. Please try again later.",
  "retry_after": 60,
  "limit": "50/hour",
  "window": "hour"
}
```

**Headers**:
```
HTTP/1.1 429 Too Many Requests
Retry-After: 60
X-RateLimit-Limit: 50
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1635172800
```

---

## 🐛 Troubleshooting

### Rate limits not working?

1. **Check Redis**:
   ```bash
   redis-cli ping  # Should return: PONG
   ```

2. **Check environment variable**:
   ```bash
   echo $REDIS_URL
   ```

3. **Check logs**:
   ```bash
   docker logs edge-storage-service | grep rate
   ```

### All requests return 429?

1. **Clear Redis**:
   ```bash
   redis-cli FLUSHDB
   ```

2. **Check rate limit config**:
   ```python
   # Too restrictive?
   FILE_UPLOAD = "1/day"  # Only 1 per day!
   ```

### Different limits per server?

1. **Ensure shared Redis**:
   ```bash
   # All instances must use SAME Redis
   REDIS_URL=redis://shared-redis-server:6379/0
   ```

---

## 📈 Monitoring

### View Current Usage
```bash
redis-cli

# See all active rate limits
KEYS LIMITER:*

# Check specific user's upload count
GET "LIMITER:/api/v1/upload/init:user:550e8400-e29b-41d4-a716-446655440000:hour"
```

### Log Monitoring
```bash
# Watch for rate limit violations
docker logs -f edge-storage-service | grep "Rate limit exceeded"
```

### Metrics (if Prometheus enabled)
```
rate_limit_exceeded_total{endpoint="/api/v1/auth/login",limit_type="minute"}
```

---

## 🔒 Security Notes

1. **User-based** - Limits tracked per user (from JWT), not just IP
2. **Redis-backed** - Works across multiple service instances
3. **Headers included** - Users see their limit status
4. **Graceful errors** - Clear messages with retry guidance

---

## 📚 Common Patterns

### Adding Rate Limit to New Endpoint

```python
from fastapi import Request
from ..utils.rate_limiter import user_limiter, RateLimitConfig

@router.post("/my-endpoint")
@user_limiter.limit(RateLimitConfig.API_WRITE)
async def my_endpoint(
    request: Request,  # Required!
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """My endpoint - Rate limited to 100/hour"""
    # ... your code
```

**Key Points**:
1. Import `Request` from fastapi
2. Import rate limiter and config
3. Add decorator with appropriate limit
4. Add `request: Request` parameter
5. Document the limit in docstring

---

## 🎯 Production Checklist

- [ ] Redis running and accessible
- [ ] `REDIS_URL` environment variable set
- [ ] All endpoints tested
- [ ] Rate limits reviewed and approved
- [ ] Monitoring/alerts configured
- [ ] Documentation shared with team
- [ ] Frontend updated to handle 429 errors

---

## 📞 Quick Links

- **Full Documentation**: [RATE_LIMITING_COMPLETE.md](RATE_LIMITING_COMPLETE.md)
- **Implementation Status**: [PHASE_4_5_IMPLEMENTATION_STATUS.md](PHASE_4_5_IMPLEMENTATION_STATUS.md)
- **Session Summary**: [SESSION_SUMMARY_OCT_21.md](SESSION_SUMMARY_OCT_21.md)
- **Code**: `app/utils/rate_limiter.py`

---

**Status**: ✅ Production Ready
**Coverage**: 26+ endpoints
**Last Tested**: October 21, 2025

