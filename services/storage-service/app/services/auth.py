# services/storage-service/app/services/auth.py
import uuid
from datetime import datetime, timedelta
from typing import Optional

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import get_db
from ..models.database import User

# Password hashing
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
security = HTTPBearer()


class AuthService:
    """Handles authentication and authorization"""

    async def get_current_user_from_token(self, token: str, db: AsyncSession):
        """Verify token and return user for WebSocket authentication"""
        try:
            payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
            user_id = payload.get("sub")
            if not user_id:
                return None

            # Reject typed tokens (download, registration, password_reset)
            if payload.get("type") is not None:
                return None

            # Check blocklist
            jti = payload.get("jti")
            if jti and await self.is_token_blocklisted(jti):
                return None

            # Check password reset invalidation
            from ..database import redis_client

            if redis_client:
                try:
                    pwd_reset_at = await redis_client.get(f"pwd_reset_at:{user_id}")
                    if pwd_reset_at:
                        iat = payload.get("iat", 0)
                        if int(pwd_reset_at) > iat:
                            return None
                except Exception:
                    pass

            # Get user from database
            result = await db.execute(select(User).filter(User.id == user_id))
            return result.scalar_one_or_none()
        except JWTError:
            return None

    @staticmethod
    def verify_password(plain_password: str, hashed_password: str) -> bool:
        return pwd_context.verify(plain_password, hashed_password)

    @staticmethod
    async def async_verify_password(plain_password: str, hashed_password: str) -> bool:
        from ..utils.executors import run_in_heavy_pool

        return await run_in_heavy_pool(pwd_context.verify, plain_password, hashed_password)

    @staticmethod
    def get_password_hash(password: str) -> str:
        return pwd_context.hash(password)

    @staticmethod
    async def async_get_password_hash(password: str) -> str:
        from ..utils.executors import run_in_heavy_pool

        return await run_in_heavy_pool(pwd_context.hash, password)

    @staticmethod
    def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
        to_encode = data.copy()
        if expires_delta:
            expire = datetime.utcnow() + expires_delta
        else:
            expire = datetime.utcnow() + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)

        to_encode.update(
            {"exp": expire, "jti": str(uuid.uuid4()), "iat": int(datetime.utcnow().timestamp())}
        )
        encoded_jwt = jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
        return encoded_jwt

    @staticmethod
    async def blocklist_token(token: str):
        """Add a JWT to the blocklist in Redis. TTL = remaining token lifetime."""
        from ..database import redis_client

        if not redis_client:
            return
        try:
            payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
            jti = payload.get("jti")
            exp = payload.get("exp")
            if not jti or not exp:
                return
            ttl = int(exp - datetime.utcnow().timestamp())
            if ttl > 0:
                await redis_client.setex(f"blocklist:{jti}", ttl, "1")
        except JWTError:
            pass

    @staticmethod
    async def is_token_blocklisted(jti: str) -> bool:
        """Check if a token's jti is in the blocklist."""
        from ..database import redis_client

        if not redis_client:
            return False
        try:
            result = await redis_client.get(f"blocklist:{jti}")
            return result is not None
        except Exception:
            return False


auth_service = AuthService()
