# Phase 5: Security Hardening - Quick Start Guide

**Priority**: 🔴 CRITICAL
**Duration**: 2-3 weeks
**Team**: 2-3 developers + 1 security consultant

---

## Week 1: Authentication & Rate Limiting

### Day 1-2: OAuth2 Setup

#### Step 1: Install Dependencies

```bash
cd services/storage-service
source venv/bin/activate
pip install authlib python-jose[cryptography] python-multipart
pip freeze > requirements.txt
```

#### Step 2: Create OAuth Service

Create `services/storage-service/app/services/oauth_service.py`:

```python
"""OAuth2 authentication service"""
from authlib.integrations.starlette_client import OAuth
from authlib.integrations.starlette_client import OAuthError
from fastapi import HTTPException
from ..config import settings

# Initialize OAuth
oauth = OAuth()

# Register Google OAuth
oauth.register(
    name='google',
    client_id=settings.GOOGLE_CLIENT_ID,
    client_secret=settings.GOOGLE_CLIENT_SECRET,
    server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
    client_kwargs={
        'scope': 'openid email profile'
    }
)

# Register GitHub OAuth
oauth.register(
    name='github',
    client_id=settings.GITHUB_CLIENT_ID,
    client_secret=settings.GITHUB_CLIENT_SECRET,
    access_token_url='https://github.com/login/oauth/access_token',
    access_token_params=None,
    authorize_url='https://github.com/login/oauth/authorize',
    authorize_params=None,
    api_base_url='https://api.github.com/',
    client_kwargs={'scope': 'user:email'},
)

# Register Microsoft OAuth
oauth.register(
    name='microsoft',
    client_id=settings.MICROSOFT_CLIENT_ID,
    client_secret=settings.MICROSOFT_CLIENT_SECRET,
    server_metadata_url='https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration',
    client_kwargs={'scope': 'openid email profile'}
)

class OAuthService:
    """OAuth authentication service"""

    @staticmethod
    async def get_oauth_user(provider: str, token: dict):
        """Get user info from OAuth provider"""
        if provider == 'google':
            return await oauth.google.parse_id_token(token)
        elif provider == 'github':
            resp = await oauth.github.get('user', token=token)
            profile = resp.json()
            # GitHub doesn't provide email in profile by default
            emails_resp = await oauth.github.get('user/emails', token=token)
            emails = emails_resp.json()
            primary_email = next((e['email'] for e in emails if e['primary']), None)
            return {
                'sub': str(profile['id']),
                'name': profile['name'],
                'email': primary_email or profile.get('email'),
                'picture': profile['avatar_url']
            }
        elif provider == 'microsoft':
            return await oauth.microsoft.parse_id_token(token)
        else:
            raise HTTPException(status_code=400, detail="Unsupported OAuth provider")

    @staticmethod
    async def create_or_update_user(db, oauth_profile: dict, provider: str):
        """Create or update user from OAuth profile"""
        from ..models.database import User, OAuthAccount
        from sqlalchemy import select

        email = oauth_profile.get('email')
        oauth_sub = oauth_profile.get('sub')

        # Check if OAuth account exists
        result = await db.execute(
            select(OAuthAccount).filter(
                OAuthAccount.provider == provider,
                OAuthAccount.provider_user_id == oauth_sub
            )
        )
        oauth_account = result.scalar_one_or_none()

        if oauth_account:
            # Existing OAuth account, return associated user
            return oauth_account.user

        # Check if user with email exists
        result = await db.execute(
            select(User).filter(User.email == email)
        )
        user = result.scalar_one_or_none()

        if not user:
            # Create new user
            user = User(
                email=email,
                username=email.split('@')[0],
                full_name=oauth_profile.get('name'),
                is_active=True,
                is_verified=True,  # OAuth emails are verified
                storage_quota=10 * 1024**3,  # 10 GB default
            )
            db.add(user)
            await db.flush()

        # Link OAuth account to user
        oauth_account = OAuthAccount(
            user_id=user.id,
            provider=provider,
            provider_user_id=oauth_sub,
            access_token=oauth_profile.get('access_token'),
            refresh_token=oauth_profile.get('refresh_token'),
            profile_data=oauth_profile
        )
        db.add(oauth_account)
        await db.commit()
        await db.refresh(user)

        return user

oauth_service = OAuthService()
```

#### Step 3: Add OAuth Database Models

Add to `services/storage-service/app/models/database.py`:

```python
class OAuthAccount(Base):
    """OAuth account linked to user"""
    __tablename__ = 'oauth_accounts'

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    provider = Column(String(50), nullable=False)  # 'google', 'github', 'microsoft'
    provider_user_id = Column(String(255), nullable=False)  # OAuth provider's user ID
    access_token = Column(Text)
    refresh_token = Column(Text)
    token_expires_at = Column(DateTime(timezone=True))
    profile_data = Column(JSON)  # Store OAuth profile
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    user = relationship('User', backref='oauth_accounts')

    __table_args__ = (
        Index('idx_oauth_provider_user', 'provider', 'provider_user_id'),
        UniqueConstraint('provider', 'provider_user_id', name='uq_oauth_provider_user'),
    )
```

#### Step 4: Create OAuth Router

Create `services/storage-service/app/routers/oauth.py`:

```python
"""OAuth authentication endpoints"""
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_db
from ..services.oauth_service import oauth, oauth_service
from ..services.auth import auth_service
from ..config import settings

router = APIRouter(prefix="/api/v1/auth/oauth", tags=["oauth"])


@router.get("/{provider}/login")
async def oauth_login(provider: str, request: Request):
    """Initiate OAuth login flow"""
    if provider not in ['google', 'github', 'microsoft']:
        raise HTTPException(status_code=400, detail="Unsupported OAuth provider")

    oauth_client = getattr(oauth, provider)
    redirect_uri = f"{settings.API_BASE_URL}/api/v1/auth/oauth/{provider}/callback"

    return await oauth_client.authorize_redirect(request, redirect_uri)


@router.get("/{provider}/callback")
async def oauth_callback(
    provider: str,
    request: Request,
    db: AsyncSession = Depends(get_db)
):
    """Handle OAuth callback"""
    try:
        oauth_client = getattr(oauth, provider)
        token = await oauth_client.authorize_access_token(request)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"OAuth authentication failed: {str(e)}")

    # Get user info from OAuth provider
    oauth_profile = await oauth_service.get_oauth_user(provider, token)

    # Create or update user
    user = await oauth_service.create_or_update_user(db, oauth_profile, provider)

    # Generate JWT token
    access_token = auth_service.create_access_token(data={"sub": str(user.id)})
    refresh_token = auth_service.create_refresh_token(data={"sub": str(user.id)})

    # Redirect to frontend with token
    frontend_url = settings.FRONTEND_URL
    return RedirectResponse(
        url=f"{frontend_url}/auth/callback?access_token={access_token}&refresh_token={refresh_token}"
    )


@router.post("/{provider}/link")
async def link_oauth_account(
    provider: str,
    request: Request,
    current_user = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Link OAuth account to existing user"""
    try:
        oauth_client = getattr(oauth, provider)
        token = await oauth_client.authorize_access_token(request)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"OAuth authentication failed: {str(e)}")

    oauth_profile = await oauth_service.get_oauth_user(provider, token)

    # Check if OAuth account already linked
    from ..models.database import OAuthAccount
    from sqlalchemy import select

    result = await db.execute(
        select(OAuthAccount).filter(
            OAuthAccount.provider == provider,
            OAuthAccount.provider_user_id == oauth_profile['sub']
        )
    )
    existing_account = result.scalar_one_or_none()

    if existing_account:
        raise HTTPException(status_code=400, detail="OAuth account already linked to another user")

    # Link OAuth account
    oauth_account = OAuthAccount(
        user_id=current_user.id,
        provider=provider,
        provider_user_id=oauth_profile['sub'],
        access_token=token.get('access_token'),
        refresh_token=token.get('refresh_token'),
        profile_data=oauth_profile
    )
    db.add(oauth_account)
    await db.commit()

    return {"message": f"{provider.capitalize()} account linked successfully"}
```

#### Step 5: Update Configuration

Add to `services/storage-service/app/config.py`:

```python
class Settings(BaseSettings):
    # ... existing settings ...

    # OAuth Settings
    GOOGLE_CLIENT_ID: str = ""
    GOOGLE_CLIENT_SECRET: str = ""
    GITHUB_CLIENT_ID: str = ""
    GITHUB_CLIENT_SECRET: str = ""
    MICROSOFT_CLIENT_ID: str = ""
    MICROSOFT_CLIENT_SECRET: str = ""

    API_BASE_URL: str = "http://localhost:8000"
    FRONTEND_URL: str = "http://localhost:3000"
```

Add to `.env`:

```bash
# OAuth Credentials
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
MICROSOFT_CLIENT_ID=your-microsoft-client-id
MICROSOFT_CLIENT_SECRET=your-microsoft-client-secret
```

#### Step 6: Create Database Migration

```bash
cd services/storage-service
alembic revision -m "add_oauth_accounts_table"
```

Edit the migration file:

```python
"""add_oauth_accounts_table

Revision ID: xxx
Create Date: 2025-10-20
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

def upgrade():
    op.create_table(
        'oauth_accounts',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('provider', sa.String(50), nullable=False),
        sa.Column('provider_user_id', sa.String(255), nullable=False),
        sa.Column('access_token', sa.Text()),
        sa.Column('refresh_token', sa.Text()),
        sa.Column('token_expires_at', sa.DateTime(timezone=True)),
        sa.Column('profile_data', postgresql.JSON),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), onupdate=sa.func.now()),
    )

    op.create_index('idx_oauth_provider_user', 'oauth_accounts', ['provider', 'provider_user_id'])
    op.create_unique_constraint('uq_oauth_provider_user', 'oauth_accounts', ['provider', 'provider_user_id'])

def downgrade():
    op.drop_table('oauth_accounts')
```

#### Step 7: Register Router

Add to `services/storage-service/app/main.py`:

```python
from .routers import oauth

app.include_router(oauth.router)
```

#### Step 8: Frontend Integration

Create `frontend-clean/src/components/auth/SocialLogin.jsx`:

```jsx
import { Github, Mail } from 'lucide-react';

export default function SocialLogin() {
  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

  const handleSocialLogin = (provider) => {
    window.location.href = `${API_URL}/api/v1/auth/oauth/${provider}/login`;
  };

  return (
    <div className="space-y-3">
      <button
        onClick={() => handleSocialLogin('google')}
        className="w-full flex items-center justify-center gap-3 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
      >
        <Mail className="w-5 h-5" />
        <span>Continue with Google</span>
      </button>

      <button
        onClick={() => handleSocialLogin('github')}
        className="w-full flex items-center justify-center gap-3 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
      >
        <Github className="w-5 h-5" />
        <span>Continue with GitHub</span>
      </button>

      <button
        onClick={() => handleSocialLogin('microsoft')}
        className="w-full flex items-center justify-center gap-3 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
      >
        <svg className="w-5 h-5" viewBox="0 0 23 23">
          <path fill="#f3f3f3" d="M0 0h23v23H0z"/>
          <path fill="#f35325" d="M1 1h10v10H1z"/>
          <path fill="#81bc06" d="M12 1h10v10H12z"/>
          <path fill="#05a6f0" d="M1 12h10v10H1z"/>
          <path fill="#ffba08" d="M12 12h10v10H12z"/>
        </svg>
        <span>Continue with Microsoft</span>
      </button>
    </div>
  );
}
```

---

### Day 3-5: Rate Limiting

#### Step 1: Install SlowAPI

```bash
pip install slowapi
```

#### Step 2: Create Rate Limiter Utility

Create `services/storage-service/app/utils/rate_limiter.py`:

```python
"""Advanced rate limiting with Redis backend"""
from slowapi import Limiter
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from fastapi import Request, Response
from typing import Callable
import redis.asyncio as redis
from ..config import settings

# Initialize rate limiter with Redis storage
limiter = Limiter(
    key_func=get_remote_address,
    storage_uri=settings.REDIS_URL,
    default_limits=["1000/day", "100/hour"],
    headers_enabled=True
)

async def get_user_id_from_request(request: Request) -> str:
    """Extract user ID from JWT token for user-based rate limiting"""
    try:
        from ..dependencies import get_current_user_optional
        user = await get_current_user_optional(request)
        if user:
            return str(user.id)
    except:
        pass
    return get_remote_address(request)

# User-based limiter (for authenticated requests)
user_limiter = Limiter(
    key_func=get_user_id_from_request,
    storage_uri=settings.REDIS_URL,
    headers_enabled=True
)

class RateLimitConfig:
    """Rate limit configurations for different endpoint types"""

    # Public endpoints (stricter limits)
    PUBLIC = "20/minute"

    # Authentication endpoints
    AUTH_LOGIN = "5/minute"
    AUTH_REGISTER = "3/hour"
    AUTH_PASSWORD_RESET = "3/hour"

    # File operations
    FILE_UPLOAD = "50/hour;1000/day"
    FILE_DOWNLOAD = "200/hour;5000/day"
    FILE_DELETE = "100/hour"
    FILE_LIST = "500/hour"

    # Search operations
    SEARCH = "100/hour;1000/day"

    # API endpoints
    API_READ = "500/hour;5000/day"
    API_WRITE = "100/hour;1000/day"

    # Admin endpoints
    ADMIN = "1000/hour;10000/day"

# Custom rate limit exceeded handler
async def rate_limit_exceeded_handler(request: Request, exc: RateLimitExceeded):
    """Custom handler for rate limit exceeded errors"""
    return Response(
        content={
            "error": "Rate limit exceeded",
            "message": f"Too many requests. Please try again later.",
            "retry_after": exc.retry_after
        },
        status_code=429,
        headers={
            "Retry-After": str(exc.retry_after),
            "X-RateLimit-Limit": str(exc.limit),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": str(exc.reset)
        }
    )
```

#### Step 3: Apply Rate Limits to Endpoints

Update `services/storage-service/app/routers/auth.py`:

```python
from ..utils.rate_limiter import limiter, RateLimitConfig

@router.post("/login")
@limiter.limit(RateLimitConfig.AUTH_LOGIN)
async def login(request: Request, ...):
    """Login with rate limiting"""
    pass

@router.post("/register")
@limiter.limit(RateLimitConfig.AUTH_REGISTER)
async def register(request: Request, ...):
    """Registration with rate limiting"""
    pass
```

Update file upload endpoint:

```python
@router.post("/upload")
@user_limiter.limit(RateLimitConfig.FILE_UPLOAD)
async def upload_file(request: Request, ...):
    """Upload with user-based rate limiting"""
    pass
```

#### Step 4: Add Rate Limit Middleware

Add to `services/storage-service/app/main.py`:

```python
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from .utils.rate_limiter import limiter, rate_limit_exceeded_handler

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)
```

#### Step 5: Test Rate Limiting

```bash
# Test login rate limit (should allow 5 requests/minute)
for i in {1..6}; do
  curl -X POST http://localhost:8000/api/v1/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"test@example.com","password":"wrong"}'
  echo ""
done

# The 6th request should return 429 Too Many Requests
```

---

## Week 2: Security Headers & Encryption

### Day 1-2: Security Headers Middleware

Create `services/storage-service/app/middleware/security_headers.py`:

```python
"""Security headers middleware"""
from starlette.middleware.base import BaseHTTPMiddleware
from fastapi import Request, Response
from ..config import settings

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Add comprehensive security headers to all responses"""

    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)

        # HSTS: Force HTTPS
        if settings.ENABLE_HTTPS:
            response.headers["Strict-Transport-Security"] = (
                "max-age=31536000; includeSubDomains; preload"
            )

        # Prevent MIME type sniffing
        response.headers["X-Content-Type-Options"] = "nosniff"

        # Prevent clickjacking
        response.headers["X-Frame-Options"] = "DENY"

        # XSS Protection (legacy browsers)
        response.headers["X-XSS-Protection"] = "1; mode=block"

        # Referrer Policy
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"

        # Content Security Policy
        csp_directives = [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "img-src 'self' data: https: blob:",
            "font-src 'self' data: https://fonts.gstatic.com",
            "connect-src 'self' https://api.edgecloud.com wss://api.edgecloud.com",
            "media-src 'self' blob:",
            "object-src 'none'",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "upgrade-insecure-requests"
        ]
        response.headers["Content-Security-Policy"] = "; ".join(csp_directives)

        # Permissions Policy (formerly Feature Policy)
        permissions = [
            "accelerometer=()",
            "camera=()",
            "geolocation=()",
            "gyroscope=()",
            "magnetometer=()",
            "microphone=()",
            "payment=()",
            "usb=()"
        ]
        response.headers["Permissions-Policy"] = ", ".join(permissions)

        # Remove server header
        response.headers.pop("Server", None)

        return response
```

Register middleware in `main.py`:

```python
from .middleware.security_headers import SecurityHeadersMiddleware

app.add_middleware(SecurityHeadersMiddleware)
```

---

### Day 3-5: Enhanced Encryption

Create `services/storage-service/app/services/encryption_v2.py`:

```python
"""Enhanced encryption service with key rotation"""
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2
import os
import base64
from datetime import datetime
from typing import Tuple

class EnhancedEncryptionService:
    """Advanced encryption with key rotation and envelope encryption"""

    def __init__(self, master_key: bytes):
        self.master_key = master_key
        self.backend = default_backend()

    def generate_data_key(self) -> Tuple[bytes, bytes]:
        """Generate new data encryption key (DEK) using envelope encryption"""
        # Generate random 256-bit DEK
        dek = os.urandom(32)

        # Encrypt DEK with master key (envelope encryption)
        encrypted_dek = self.encrypt_key(dek)

        return dek, encrypted_dek

    def encrypt_file(self, data: bytes, use_envelope: bool = True) -> dict:
        """
        Encrypt file with optional envelope encryption

        Returns:
            dict with encrypted_data, encrypted_key, iv, salt
        """
        if use_envelope:
            # Generate new DEK for this file
            dek, encrypted_dek = self.generate_data_key()
            key = dek
        else:
            key = self.master_key
            encrypted_dek = None

        # Generate random IV
        iv = os.urandom(16)

        # Encrypt data
        cipher = Cipher(
            algorithms.AES(key),
            modes.GCM(iv),
            backend=self.backend
        )
        encryptor = cipher.encryptor()
        encrypted_data = encryptor.update(data) + encryptor.finalize()

        return {
            'encrypted_data': encrypted_data,
            'encrypted_key': encrypted_dek,  # None if not using envelope encryption
            'iv': iv,
            'tag': encryptor.tag,
            'algorithm': 'AES-256-GCM',
            'created_at': datetime.utcnow()
        }

    def decrypt_file(self, encrypted_data: bytes, encrypted_key: bytes, iv: bytes, tag: bytes) -> bytes:
        """Decrypt file using envelope encryption"""
        # Decrypt DEK if envelope encryption was used
        if encrypted_key:
            key = self.decrypt_key(encrypted_key)
        else:
            key = self.master_key

        # Decrypt data
        cipher = Cipher(
            algorithms.AES(key),
            modes.GCM(iv, tag),
            backend=self.backend
        )
        decryptor = cipher.decryptor()
        return decryptor.update(encrypted_data) + decryptor.finalize()

    def rotate_key(self, old_encrypted_data: bytes, old_iv: bytes, old_tag: bytes,
                   old_encrypted_key: bytes = None) -> dict:
        """Rotate encryption key for existing data"""
        # Decrypt with old key
        decrypted_data = self.decrypt_file(old_encrypted_data, old_encrypted_key, old_iv, old_tag)

        # Re-encrypt with new key
        return self.encrypt_file(decrypted_data, use_envelope=True)

# Initialize service
encryption_service_v2 = EnhancedEncryptionService(master_key=settings.MASTER_KEY.encode())
```

---

## Week 3: GDPR & Audit Logging

### GDPR Compliance Endpoints

Create `services/storage-service/app/routers/gdpr.py`:

```python
"""GDPR compliance endpoints"""
from fastapi import APIRouter, Depends, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
import zipfile
import io

router = APIRouter(prefix="/api/v1/gdpr", tags=["gdpr"])

@router.post("/export-data")
async def export_user_data(
    current_user = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    background_tasks: BackgroundTasks = BackgroundTasks()
):
    """Export all user data (Right to Data Portability - GDPR Article 20)"""
    # Queue background job to generate export
    background_tasks.add_task(generate_data_export, current_user.id)

    return {
        "message": "Data export initiated. You will receive an email when it's ready.",
        "estimated_time": "15-30 minutes"
    }

@router.delete("/delete-account")
async def delete_user_account(
    confirmation: str,
    current_user = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Delete user account and all associated data (Right to be Forgotten - GDPR Article 17)"""
    if confirmation != "DELETE":
        raise HTTPException(status_code=400, detail="Invalid confirmation")

    # Soft delete user (mark as deleted, actual deletion happens after 30 days)
    current_user.is_deleted = True
    current_user.deletion_scheduled_at = datetime.utcnow() + timedelta(days=30)
    await db.commit()

    return {
        "message": "Account scheduled for deletion in 30 days. You can cancel within this period."
    }
```

---

## Testing Checklist

- [ ] OAuth login works for Google, GitHub, Microsoft
- [ ] Rate limiting enforces limits correctly
- [ ] Security headers present in all responses
- [ ] Encryption/decryption works with new service
- [ ] GDPR export generates correct data
- [ ] Account deletion works as expected
- [ ] All tests pass
- [ ] Security scan shows no critical vulnerabilities

---

## Next Steps

After completing Week 1-3:
1. Move to Phase 3 (Deployment & Infrastructure)
2. Set up production Kubernetes cluster
3. Configure monitoring and alerting
4. Implement performance optimizations

For detailed implementation of remaining weeks, refer to the main `IMPROVEMENT_ROADMAP.md`.
