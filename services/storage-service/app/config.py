# services/storage-service/app/config.py
import os
import secrets
from typing import Optional

class Settings:
    """Application configuration settings"""
    
    # App
    APP_NAME: str = "Edge Cloud Storage"
    VERSION: str = "1.0.0"
    
    # Security
    SECRET_KEY: str = os.getenv("SECRET_KEY") or secrets.token_urlsafe(32)
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    ENABLE_HTTPS: bool = os.getenv("ENABLE_HTTPS", "false").lower() == "true"
    
    # Database
    DATABASE_URL: str = os.getenv(
        "DATABASE_URL", 
        "postgresql+asyncpg://edge_admin:secure_password@localhost:5432/edge_cloud"
    )
    REDIS_URL: str = os.getenv("REDIS_URL", "redis://localhost:6379")
    
    # Storage Paths
    STORAGE_ROOT: str = "./storage"
    CACHE_PATH: str = "./storage/cache"
    WARM_PATH: str = "./storage/warm"
    COLD_PATH: str = "./storage/cold"
    TEMP_PATH: str = "./storage/temp"
    BACKUP_PATH: str = "./storage/backup"
    
    # Storage Configuration
    CHUNK_SIZE: int = int(os.getenv("CHUNK_SIZE", 67108864))  # Default 64MB
    MAX_FILE_SIZE: int = int(os.getenv("MAX_FILE_SIZE", 21474836480))  # Default 20GB
    COMPRESSION_LEVEL: int = int(os.getenv("COMPRESSION_LEVEL", 3))
    
    # Storage Thresholds
    INLINE_THRESHOLD: int = 1 * 1024 * 1024  # 1MB - store in Redis
    SINGLE_OBJECT_THRESHOLD: int = 100 * 1024 * 1024  # 100MB - store as single file
    
    # Backup Configuration
    BACKUP_ENABLED: bool = os.getenv("BACKUP_ENABLED", "true").lower() == "true"
    BACKUP_S3_BUCKET: str = os.getenv("BACKUP_S3_BUCKET", "edge-cloud-backup")
    BACKUP_NODE_URL: str = os.getenv("BACKUP_NODE_URL", "")
    AWS_ACCESS_KEY: Optional[str] = os.getenv("AWS_ACCESS_KEY")
    AWS_SECRET_KEY: Optional[str] = os.getenv("AWS_SECRET_KEY")
    
    #versioning
    VERSION_RETENTION_DAYS = int(os.getenv("VERSION_RETENTION_DAYS", 90))
    MAX_VERSIONS_PER_FILE = int(os.getenv("MAX_VERSIONS_PER_FILE", 50))
    AUTO_VERSION_ON_UPDATE = os.getenv("AUTO_VERSION_ON_UPDATE", "true").lower() == "true"
    
    # User Storage Quotas
    QUOTAS = {
        "individual": 100 * 1024**3,  # 100GB
        "business": 1024**4,          # 1TB
        "enterprise": 10 * 1024**4,   # 10TB
    }

    
    @property
    def is_production(self) -> bool:
        """Check if running in production mode"""
        return os.getenv("ENVIRONMENT", "development").lower() == "production"

settings = Settings()