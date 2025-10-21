# Quick Start - Security Features

**Last Updated**: October 20, 2025
**Status**: Ready to Deploy

---

## 🚀 Quick Setup (5 Minutes)

### Step 1: Run Database Migrations

```bash
cd services/storage-service
source venv/bin/activate
alembic upgrade head
```

**Expected Output**:
```
INFO  [alembic.runtime.migration] Running upgrade favorites_001 -> oauth_accounts_001
```

### Step 2: Configure OAuth Providers

Add to `services/storage-service/.env`:

```bash
# Google OAuth
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret

# GitHub OAuth
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret

# Microsoft OAuth
MICROSOFT_CLIENT_ID=your-microsoft-client-id
MICROSOFT_CLIENT_SECRET=your-microsoft-client-secret

# Application URLs
API_BASE_URL=http://localhost:8000
FRONTEND_URL=http://localhost:3000
```

### Step 3: Restart Services

```bash
# If using Docker
docker-compose restart storage-service

# If running locally
cd services/storage-service
uvicorn app.main:app --reload
```

---

## 🔐 Get OAuth Credentials

### Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create new project
3. Enable "Google+ API"
4. Credentials → Create OAuth 2.0 Client ID
5. Authorized redirect URI: `http://localhost:8000/api/v1/auth/oauth/google/callback`
6. Copy Client ID and Secret

### GitHub OAuth

1. Go to [GitHub Settings](https://github.com/settings/developers)
2. New OAuth App
3. Authorization callback: `http://localhost:8000/api/v1/auth/oauth/github/callback`
4. Copy Client ID and Secret

### Microsoft OAuth

1. Go to [Azure Portal](https://portal.azure.com/)
2. Azure AD → App registrations → New
3. Redirect URI: `http://localhost:8000/api/v1/auth/oauth/microsoft/callback`
4. Certificates & secrets → New client secret
5. Copy Application ID and Secret

---

## 🧪 Test OAuth Login

### 1. Check Available Providers

```bash
curl http://localhost:8000/api/v1/auth/oauth/providers
```

**Expected Response**:
```json
{
  "providers": [
    {"name": "google", "display_name": "Google", "enabled": true},
    {"name": "github", "display_name": "Github", "enabled": true},
    {"name": "microsoft", "display_name": "Microsoft", "enabled": true}
  ],
  "count": 3
}
```

### 2. Test OAuth Flow

**In browser**:
```
http://localhost:8000/api/v1/auth/oauth/google/login
```

Should redirect to Google login, then back to your frontend with tokens.

---

## ⏱️ Test Rate Limiting

### Test Login Rate Limit (5/minute)

```bash
# This should succeed 5 times, then return 429
for i in {1..6}; do
  echo "Request $i:"
  curl -X POST http://localhost:8000/api/v1/auth/login \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "email=test@example.com&password=wrong" \
    -w "\nHTTP Status: %{http_code}\n\n"
done
```

**Expected**: First 5 succeed (401 invalid credentials), 6th returns 429.

### Test Registration Rate Limit (3/hour)

```bash
# Should succeed 3 times in an hour
for i in {1..4}; do
  curl -X POST http://localhost:8000/api/v1/auth/register \
    -d "email=test$i@example.com&username=test$i&password=pass123" \
    -w "\nHTTP Status: %{http_code}\n\n"
done
```

**Expected**: First 3 succeed, 4th returns 429.

---

## 🛡️ Check Security Headers

```bash
curl -I http://localhost:8000/api/v1/health
```

**Should See**:
```
HTTP/1.1 200 OK
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Referrer-Policy: strict-origin-when-cross-origin
Content-Security-Policy: default-src 'self'; ...
Permissions-Policy: accelerometer=(), camera=(), ...
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
```

### Test with Online Tools

1. **SecurityHeaders.com**
   ```
   https://securityheaders.com/?q=http://localhost:8000
   ```
   Target: A+ rating

2. **Mozilla Observatory**
   ```
   https://observatory.mozilla.org/
   ```
   Target: A+ score

---

## 📝 Common Issues & Solutions

### Issue: "OAuth provider not configured"

**Cause**: Missing OAuth credentials in `.env`

**Solution**:
```bash
# Check .env file has all required OAuth variables
grep -E "GOOGLE_CLIENT_ID|GITHUB_CLIENT_ID|MICROSOFT_CLIENT_ID" .env
```

### Issue: "Rate limit exceeded" immediately

**Cause**: Redis not running or connection failed

**Solution**:
```bash
# Check Redis is running
docker ps | grep redis

# Test Redis connection
redis-cli ping
# Should return: PONG

# Check Redis URL in .env
echo $REDIS_URL
```

### Issue: "Security headers not applied"

**Cause**: Middleware not registered

**Solution**:
```bash
# Check logs on startup
docker logs edge-storage-service | grep "Security headers"
# Should see: "Security headers middleware enabled"
```

### Issue: "Migration fails"

**Cause**: Database out of sync

**Solution**:
```bash
# Check current migration
alembic current

# If needed, downgrade and re-upgrade
alembic downgrade -1
alembic upgrade head
```

---

## 📊 Verify Everything Works

### Checklist

- [ ] Database migrations completed
- [ ] OAuth providers configured
- [ ] Services restarted
- [ ] `/api/v1/auth/oauth/providers` returns 3 providers
- [ ] Google OAuth login works
- [ ] GitHub OAuth login works
- [ ] Microsoft OAuth login works
- [ ] Rate limiting triggers at expected limits
- [ ] Security headers present on all responses
- [ ] No errors in application logs

---

## 🎯 Quick Tests

### Complete Test Script

```bash
#!/bin/bash

echo "🧪 Testing Edge Cloud Storage Security..."

# Test 1: Health check
echo "\n1️⃣ Testing health endpoint..."
curl -s http://localhost:8000/api/v1/health | jq

# Test 2: OAuth providers
echo "\n2️⃣ Testing OAuth providers..."
curl -s http://localhost:8000/api/v1/auth/oauth/providers | jq

# Test 3: Rate limiting
echo "\n3️⃣ Testing rate limiting..."
for i in {1..6}; do
  echo "Request $i:"
  curl -s -X POST http://localhost:8000/api/v1/auth/login \
    -d "email=test@example.com&password=wrong" \
    -w "\nStatus: %{http_code}\n"
done

# Test 4: Security headers
echo "\n4️⃣ Testing security headers..."
curl -I http://localhost:8000/api/v1/health | grep -E "Strict-Transport|X-Frame|Content-Security"

echo "\n✅ All tests completed!"
```

Save as `test-security.sh`, then:

```bash
chmod +x test-security.sh
./test-security.sh
```

---

## 📚 API Endpoints Reference

### OAuth Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/auth/oauth/providers` | List available providers |
| GET | `/api/v1/auth/oauth/{provider}/login` | Initiate OAuth flow |
| GET | `/api/v1/auth/oauth/{provider}/callback` | OAuth callback handler |
| POST | `/api/v1/auth/oauth/{provider}/link` | Link OAuth to account |
| DELETE | `/api/v1/auth/oauth/{provider}/unlink` | Unlink OAuth account |
| GET | `/api/v1/auth/oauth/linked-accounts` | Get linked accounts |

### Recents & Favorites

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/files/recents?days=30` | Get recent files |
| GET | `/api/v1/files/favorites` | Get favorites |
| POST | `/api/v1/files/{id}/favorite` | Toggle favorite |
| DELETE | `/api/v1/files/{id}/favorite` | Remove favorite |

---

## 🎨 Frontend Integration

### Add OAuth Buttons

```jsx
// src/components/auth/SocialLogin.jsx
import { Mail, Github } from 'lucide-react';

export default function SocialLogin() {
  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

  const handleOAuthLogin = (provider) => {
    window.location.href = `${API_URL}/api/v1/auth/oauth/${provider}/login`;
  };

  return (
    <div className="space-y-3">
      <button
        onClick={() => handleOAuthLogin('google')}
        className="w-full btn btn-outline"
      >
        <Mail className="w-5 h-5 mr-2" />
        Continue with Google
      </button>

      <button
        onClick={() => handleOAuthLogin('github')}
        className="w-full btn btn-outline"
      >
        <Github className="w-5 h-5 mr-2" />
        Continue with GitHub
      </button>
    </div>
  );
}
```

### Handle OAuth Callback

```jsx
// src/pages/auth/Callback.jsx
import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

export default function OAuthCallback() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    const accessToken = searchParams.get('access_token');
    const refreshToken = searchParams.get('refresh_token');

    if (accessToken) {
      localStorage.setItem('access_token', accessToken);
      localStorage.setItem('refresh_token', refreshToken);
      navigate('/dashboard');
    } else {
      navigate('/login?error=oauth_failed');
    }
  }, [searchParams, navigate]);

  return <div>Completing login...</div>;
}
```

---

## 🔗 Resources

- **API Documentation**: http://localhost:8000/docs
- **Full Implementation Guide**: [PHASE_5_SECURITY_QUICK_START.md](./PHASE_5_SECURITY_QUICK_START.md)
- **Roadmap**: [IMPROVEMENT_ROADMAP.md](./IMPROVEMENT_ROADMAP.md)
- **Session Summary**: [SESSION_SUMMARY_OCT_20.md](./SESSION_SUMMARY_OCT_20.md)

---

**Status**: ✅ Ready for Production Testing
**Next Steps**: Configure OAuth, test all flows, deploy to staging

---

*Last Updated: October 20, 2025*
