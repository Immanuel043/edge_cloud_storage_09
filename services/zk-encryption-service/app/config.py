"""
Zero-Knowledge Encryption Service Configuration

Environment-based configuration for the ZK service.
"""
import os
from typing import Optional
from pydantic_settings import BaseSettings
from pydantic import Field


class Settings(BaseSettings):
    """ZK Service Settings"""

    # Service Info
    SERVICE_NAME: str = "zk-encryption-service"
    VERSION: str = "1.0.0"
    DEBUG: bool = Field(default=False, env="DEBUG")

    # API Settings
    API_PREFIX: str = "/api/v1/zk"
    ZK_SERVICE_PORT: int = Field(default=8002, env="ZK_SERVICE_PORT")

    # Database
    DATABASE_URL: str = Field(..., env="DATABASE_URL")
    DB_POOL_SIZE: int = Field(default=20, env="DB_POOL_SIZE")
    DB_MAX_OVERFLOW: int = Field(default=40, env="DB_MAX_OVERFLOW")

    # Redis
    REDIS_URL: str = Field(..., env="REDIS_URL")
    REDIS_SESSION_TTL: int = Field(default=3600, env="REDIS_SESSION_TTL")  # 1 hour

    # Storage Settings
    STORAGE_SERVICE_URL: str = Field(
        default="http://storage-service:8000",
        env="STORAGE_SERVICE_URL"
    )
    STORAGE_PATH: str = Field(
        default="/app/storage",
        env="STORAGE_PATH"
    )
    # ZK-specific storage path - isolated from normal storage
    ZK_STORAGE_PATH: str = Field(
        default="/app/storage/zk",
        env="ZK_STORAGE_PATH"
    )

    # JWT Settings (shared with storage service)
    SECRET_KEY: str = Field(..., env="SECRET_KEY")
    ALGORITHM: str = Field(default="HS256", env="ALGORITHM")
    ACCESS_TOKEN_EXPIRE_MINUTES: int = Field(
        default=120,
        env="ACCESS_TOKEN_EXPIRE_MINUTES"
    )

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

    class Config:
        env_file = ".env"
        case_sensitive = True


# Global settings instance
settings = Settings()
