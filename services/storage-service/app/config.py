# services/storage-service/app/config.py
import os
import secrets
from typing import Optional, List

class Settings:
    """Application configuration settings"""
    
    # App
    APP_NAME: str = "Edge Cloud Storage"
    VERSION: str = "1.0.0"
    
    # Security
    SECRET_KEY: str = os.getenv("SECRET_KEY") or secrets.token_urlsafe(32)
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", 120))  # 2 hours (was 30 min)
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

    # URL Upload Configuration
    URL_UPLOAD_ENABLED: bool = os.getenv("URL_UPLOAD_ENABLED", "true").lower() == "true"
    URL_UPLOAD_MAX_SIZE: int = int(os.getenv("URL_UPLOAD_MAX_SIZE", 5 * 1024**3))  # 5GB
    URL_UPLOAD_TIMEOUT: int = int(os.getenv("URL_UPLOAD_TIMEOUT", 600))  # 10 minutes
    URL_UPLOAD_CONCURRENT_LIMIT: int = int(os.getenv("URL_UPLOAD_CONCURRENT_LIMIT", 5))  # per user
    URL_UPLOAD_WHITELIST: List[str] = []  # Optional domain whitelist
    URL_UPLOAD_BLACKLIST: List[str] = []  # Optional domain blacklist

    # Folder Upload Configuration
    FOLDER_UPLOAD_ENABLED: bool = os.getenv("FOLDER_UPLOAD_ENABLED", "true").lower() == "true"
    FOLDER_MAX_DEPTH: int = int(os.getenv("FOLDER_MAX_DEPTH", 10))
    FOLDER_MAX_FILES: int = int(os.getenv("FOLDER_MAX_FILES", 1000))
    FOLDER_MAX_TOTAL_SIZE: int = int(os.getenv("FOLDER_MAX_TOTAL_SIZE", 10 * 1024**3))  # 10GB

    # ML Features Configuration
    ML_FEATURES_ENABLED: bool = os.getenv("ML_FEATURES_ENABLED", "true").lower() == "true"

    # Quota Prediction Configuration
    QUOTA_PREDICTION_ENABLED: bool = os.getenv("QUOTA_PREDICTION_ENABLED", "true").lower() == "true"
    QUOTA_PREDICTION_MIN_DATA_POINTS: int = int(os.getenv("QUOTA_PREDICTION_MIN_DATA_POINTS", 7))  # days
    QUOTA_PREDICTION_WORKER_INTERVAL: int = int(os.getenv("QUOTA_PREDICTION_WORKER_INTERVAL", 86400))  # 24 hours
    QUOTA_ALERT_THRESHOLDS: List[float] = [0.70, 0.85, 0.95]  # 70%, 85%, 95%
    QUOTA_DEPLETION_WARNING_DAYS: int = int(os.getenv("QUOTA_DEPLETION_WARNING_DAYS", 30))

    # Auto-Organization Configuration
    AUTO_ORGANIZATION_ENABLED: bool = os.getenv("AUTO_ORGANIZATION_ENABLED", "true").lower() == "true"
    AUTO_ORG_MIN_FILES: int = int(os.getenv("AUTO_ORG_MIN_FILES", 10))  # Minimum files to trigger
    AUTO_ORG_CLUSTERING_ALGORITHM: str = os.getenv("AUTO_ORG_CLUSTERING_ALGORITHM", "kmeans")  # kmeans, dbscan
    AUTO_ORG_MAX_CLUSTERS: int = int(os.getenv("AUTO_ORG_MAX_CLUSTERS", 10))

    # Storage Optimization Configuration
    STORAGE_OPTIMIZATION_ENABLED: bool = os.getenv("STORAGE_OPTIMIZATION_ENABLED", "true").lower() == "true"
    STORAGE_OPT_ANALYSIS_INTERVAL: int = int(os.getenv("STORAGE_OPT_ANALYSIS_INTERVAL", 86400))  # 24 hours
    STORAGE_OPT_MIN_SAVINGS_THRESHOLD: int = int(os.getenv("STORAGE_OPT_MIN_SAVINGS_THRESHOLD", 10 * 1024**2))  # 10MB

    # Content Recommendations Configuration
    CONTENT_RECOMMENDATIONS_ENABLED: bool = os.getenv("CONTENT_RECOMMENDATIONS_ENABLED", "true").lower() == "true"
    RECOMMENDATIONS_MAX_RESULTS: int = int(os.getenv("RECOMMENDATIONS_MAX_RESULTS", 10))
    RECOMMENDATIONS_MIN_SIMILARITY: float = float(os.getenv("RECOMMENDATIONS_MIN_SIMILARITY", 0.5))  # 0.0-1.0
    RECOMMENDATIONS_USE_COLLABORATIVE: bool = os.getenv("RECOMMENDATIONS_USE_COLLABORATIVE", "true").lower() == "true"

    # CPU Optimization (for AMD Ryzen 9 7950X)
    ML_CPU_THREADS: int = int(os.getenv("ML_CPU_THREADS", 32))  # 16C/32T
    ML_BATCH_SIZE: int = int(os.getenv("ML_BATCH_SIZE", 100))  # Batch processing size

    # OAuth Configuration
    GOOGLE_CLIENT_ID: str = os.getenv("GOOGLE_CLIENT_ID", "")
    GOOGLE_CLIENT_SECRET: str = os.getenv("GOOGLE_CLIENT_SECRET", "")
    GITHUB_CLIENT_ID: str = os.getenv("GITHUB_CLIENT_ID", "")
    GITHUB_CLIENT_SECRET: str = os.getenv("GITHUB_CLIENT_SECRET", "")
    MICROSOFT_CLIENT_ID: str = os.getenv("MICROSOFT_CLIENT_ID", "")
    MICROSOFT_CLIENT_SECRET: str = os.getenv("MICROSOFT_CLIENT_SECRET", "")

    # OAuth URLs
    API_BASE_URL: str = os.getenv("API_BASE_URL", "http://localhost:8000")
    FRONTEND_URL: str = os.getenv("FRONTEND_URL", "http://localhost:3000")

    # Security Services Configuration
    VIRUS_SCANNING_ENABLED: bool = os.getenv("VIRUS_SCANNING_ENABLED", "true").lower() == "true"
    DLP_SCANNING_ENABLED: bool = os.getenv("DLP_SCANNING_ENABLED", "true").lower() == "true"

    @property
    def is_production(self) -> bool:
        """Check if running in production mode"""
        return os.getenv("ENVIRONMENT", "development").lower() == "production"

settings = Settings()