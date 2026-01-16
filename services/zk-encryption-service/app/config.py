"""
Zero-Knowledge Encryption Service Configuration

Environment-based configuration for the ZK service.
"""
import os
from typing import Optional
from pydantic_settings import BaseSettings
from pydantic import Field


class Settings(BaseSettings):
    """ZK Service Settings - Fully Independent from Storage Service"""

    # Service Info
    SERVICE_NAME: str = "zk-encryption-service"
    VERSION: str = "2.0.0"  # Major version bump for separation
    DEBUG: bool = Field(default=False, env="DEBUG")

    # API Settings
    API_PREFIX: str = "/api/v1/zk"
    ZK_SERVICE_PORT: int = Field(default=8002, env="ZK_SERVICE_PORT")

    # Database - SEPARATE from Storage Service
    # Uses its own PostgreSQL instance/database
    # NOTE: Use ZK_DATABASE_URL to avoid conflict with storage service's DATABASE_URL
    ZK_DATABASE_URL: str = Field(
        default="postgresql+asyncpg://zk_admin:secure_password@zk-postgres:5432/zk_db",
        env="ZK_DATABASE_URL"
    )
    
    @property
    def DATABASE_URL(self) -> str:
        """Alias for backward compatibility"""
        return self.ZK_DATABASE_URL
    DB_POOL_SIZE: int = Field(default=20, env="DB_POOL_SIZE")
    DB_MAX_OVERFLOW: int = Field(default=40, env="DB_MAX_OVERFLOW")

    # Redis (can be shared or separate)
    # NOTE: Use ZK_REDIS_URL to avoid conflict with storage service's REDIS_URL
    ZK_REDIS_URL: str = Field(
        default="redis://redis:6379/1",  # Different DB number for isolation
        env="ZK_REDIS_URL"
    )
    
    @property
    def REDIS_URL(self) -> str:
        """Alias for backward compatibility"""
        return self.ZK_REDIS_URL
    REDIS_SESSION_TTL: int = Field(default=3600, env="REDIS_SESSION_TTL")  # 1 hour

    # Storage Settings - Completely isolated
    ZK_STORAGE_PATH: str = Field(
        default="/app/storage/zk",
        env="ZK_STORAGE_PATH"
    )

    # JWT Settings (own auth, separate from storage service)
    SECRET_KEY: str = Field(
        default="zk-secret-key-change-in-production",
        env="ZK_SECRET_KEY"
    )
    ALGORITHM: str = Field(default="HS256", env="ALGORITHM")
    ACCESS_TOKEN_EXPIRE_MINUTES: int = Field(
        default=120,
        env="ACCESS_TOKEN_EXPIRE_MINUTES"
    )

    # Payment Gateway Configuration
    # Razorpay
    RAZORPAY_KEY_ID: str = Field(default="", env="RAZORPAY_KEY_ID")
    RAZORPAY_KEY_SECRET: str = Field(default="", env="RAZORPAY_KEY_SECRET")
    RAZORPAY_WEBHOOK_SECRET: str = Field(default="", env="RAZORPAY_WEBHOOK_SECRET")
    RAZORPAY_ENABLED: bool = Field(default=True, env="RAZORPAY_ENABLED")
    RAZORPAY_CURRENCY: str = Field(default="INR", env="RAZORPAY_CURRENCY")
    
    # Stripe Integration (separate from storage service)
    STRIPE_SECRET_KEY: str = Field(default="", env="ZK_STRIPE_SECRET_KEY")
    STRIPE_PUBLISHABLE_KEY: str = Field(default="", env="ZK_STRIPE_PUBLISHABLE_KEY")
    STRIPE_WEBHOOK_SECRET: str = Field(default="", env="ZK_STRIPE_WEBHOOK_SECRET")
    STRIPE_ENABLED: bool = Field(default=True, env="STRIPE_ENABLED")
    
    # Payment URLs
    PAYMENT_SUCCESS_URL: str = Field(
        default="http://localhost:3000/billing/success",
        env="PAYMENT_SUCCESS_URL"
    )
    PAYMENT_FAILURE_URL: str = Field(
        default="http://localhost:3000/billing/failure",
        env="PAYMENT_FAILURE_URL"
    )
    DEFAULT_PAYMENT_GATEWAY: str = Field(
        default="razorpay",
        env="DEFAULT_PAYMENT_GATEWAY"
    )

    # ZK Plan Limits - Independent pricing/quotas with bandwidth controls
    PLAN_LIMITS: dict = {
        "free": {
            "name": "Free",
            "storage_bytes": 1 * 1024**3,        # 1 GB
            "bandwidth_mbps": 5,
            "burst_mbps": 10,
            "max_streams": 2,
            "stripe_price_id": None,
        },
        "personal": {
            "name": "Personal",
            "storage_bytes": 50 * 1024**3,       # 50 GB
            "bandwidth_mbps": 25,
            "burst_mbps": 50,
            "max_streams": 5,
            "stripe_price_id": "price_zk_personal",
        },
        "professional": {
            "name": "Professional",
            "storage_bytes": 200 * 1024**3,      # 200 GB
            "bandwidth_mbps": 100,
            "burst_mbps": 200,
            "max_streams": 10,
            "stripe_price_id": "price_zk_professional",
        },
        "enterprise": {
            "name": "Enterprise",
            "storage_bytes": 1 * 1024**4,        # 1 TB
            "bandwidth_mbps": 500,
            "burst_mbps": 1000,
            "max_streams": 25,
            "stripe_price_id": "price_zk_enterprise",
        },
    }

    # ZK Encryption Settings
    DEFAULT_KDF_ALGORITHM: str = Field(default="pbkdf2", env="DEFAULT_KDF_ALGORITHM")
    PBKDF2_ITERATIONS: int = Field(default=600000, env="PBKDF2_ITERATIONS")
    ARGON2_TIME_COST: int = Field(default=3, env="ARGON2_TIME_COST")
    ARGON2_MEMORY_COST: int = Field(default=65536, env="ARGON2_MEMORY_COST")  # 64MB
    ARGON2_PARALLELISM: int = Field(default=4, env="ARGON2_PARALLELISM")

    # Recovery Settings
    RECOVERY_PHRASE_STRENGTH: int = Field(default=256, env="RECOVERY_PHRASE_STRENGTH")  # 24 words
    MAX_RECOVERY_ATTEMPTS: int = Field(default=5, env="MAX_RECOVERY_ATTEMPTS")
    RECOVERY_ATTEMPT_WINDOW_MINUTES: int = Field(default=15, env="RECOVERY_ATTEMPT_WINDOW_MINUTES")

    # Hardware Key Settings (FIDO2/WebAuthn)
    RP_ID: str = Field(default="localhost", env="RP_ID")  # Relying Party ID
    RP_NAME: str = Field(default="EdgeCloud Storage", env="RP_NAME")
    RP_ORIGIN: str = Field(default="https://localhost", env="RP_ORIGIN")
    MAX_HARDWARE_KEYS_PER_USER: int = Field(default=5, env="MAX_HARDWARE_KEYS_PER_USER")

    # Social Recovery Settings
    SOCIAL_RECOVERY_THRESHOLD: int = Field(default=3, env="SOCIAL_RECOVERY_THRESHOLD")  # Need 3 of 5
    SOCIAL_RECOVERY_TOTAL_SHARES: int = Field(default=5, env="SOCIAL_RECOVERY_TOTAL_SHARES")
    SOCIAL_RECOVERY_VERIFICATION_TTL: int = Field(default=86400, env="SOCIAL_RECOVERY_VERIFICATION_TTL")  # 24 hours

    # Rate Limiting
    RATE_LIMIT_ENABLED: bool = Field(default=True, env="RATE_LIMIT_ENABLED")
    RATE_LIMIT_REQUESTS_PER_MINUTE: int = Field(default=60, env="RATE_LIMIT_REQUESTS_PER_MINUTE")
    RATE_LIMIT_RECOVERY_ATTEMPTS: int = Field(default=3, env="RATE_LIMIT_RECOVERY_ATTEMPTS")

    # Email Configuration (Mailgun)
    MAILGUN_ENABLED: bool = Field(default=True, env="MAILGUN_ENABLED")
    MAILGUN_API_KEY: str = Field(default="", env="MAILGUN_API_KEY")
    MAILGUN_DOMAIN: str = Field(default="", env="MAILGUN_DOMAIN")
    MAILGUN_API_URL: str = Field(default="https://api.mailgun.net/v3", env="MAILGUN_API_URL")
    MAILGUN_FROM_EMAIL: str = Field(default="noreply@yourdomain.com", env="MAILGUN_FROM_EMAIL")
    MAILGUN_FROM_NAME: str = Field(default="Edge Cloud ZK Storage", env="MAILGUN_FROM_NAME")

    # Email Verification Settings
    VERIFICATION_CODE_LENGTH: int = 6
    VERIFICATION_CODE_EXPIRY_MINUTES: int = 30
    MAX_VERIFICATION_ATTEMPTS: int = 5
    RESEND_CODE_COOLDOWN_SECONDS: int = 60

    # CORS Settings
    CORS_ORIGINS: list[str] = Field(
        default=["http://localhost:3000", "http://localhost:3001"],
        env="CORS_ORIGINS"
    )

    # Monitoring & Logging
    LOG_LEVEL: str = Field(default="INFO", env="LOG_LEVEL")
    ENABLE_METRICS: bool = Field(default=True, env="ENABLE_METRICS")

    # Security
    ENABLE_AUDIT_LOGGING: bool = Field(default=True, env="ENABLE_AUDIT_LOGGING")
    MAX_FAILED_LOGIN_ATTEMPTS: int = Field(default=5, env="MAX_FAILED_LOGIN_ATTEMPTS")
    LOGIN_LOCKOUT_DURATION_MINUTES: int = Field(default=15, env="LOGIN_LOCKOUT_DURATION_MINUTES")
    
    # Development Mode
    DEV_MODE: bool = Field(default=False, env="DEV_MODE")

    class Config:
        env_file = ".env"
        case_sensitive = True


# Global settings instance
settings = Settings()
