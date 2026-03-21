# services/storage-service/app/config.py
import os
import secrets
import logging
import base64
from typing import Optional, List

logger = logging.getLogger(__name__)

class Settings:
    """Application configuration settings"""

    # App
    APP_NAME: str = "Edge Cloud Storage"
    VERSION: str = "1.0.0"
    
    # Security
    SECRET_KEY: str = os.getenv("SECRET_KEY", "")
    ENCRYPTION_MASTER_KEY: Optional[str] = os.getenv("ENCRYPTION_MASTER_KEY")  # Base64-encoded 32-byte key
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", 120))  # 2 hours (was 30 min)
    ENABLE_HTTPS: bool = os.getenv("ENABLE_HTTPS", "false").lower() == "true"

    # Internal Service Communication
    INTERNAL_SERVICE_API_KEY: str = os.getenv("INTERNAL_SERVICE_API_KEY", "")
    ZK_SERVICE_INTERNAL_URL: str = os.getenv("ZK_SERVICE_INTERNAL_URL", "http://localhost:8002")

    # Database
    DATABASE_URL: str = os.getenv("DATABASE_URL", "")
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
    
    # Bandwidth Throttle (token-bucket rate limiting only; stream-slot limits are always active)
    BANDWIDTH_THROTTLE_ENABLED: bool = os.getenv("BANDWIDTH_THROTTLE_ENABLED", "true").lower() == "true"

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

    # Plan Limits - DEPRECATED: Now using database-driven billing (subscription_plans table)
    # This is kept for backward compatibility during transition only
    # TODO: Remove after all references are migrated to shared_billing library

    # Payment Gateway Configuration
    # Razorpay
    RAZORPAY_KEY_ID: str = os.getenv("RAZORPAY_KEY_ID", "")
    RAZORPAY_KEY_SECRET: str = os.getenv("RAZORPAY_KEY_SECRET", "")
    RAZORPAY_WEBHOOK_SECRET: str = os.getenv("RAZORPAY_WEBHOOK_SECRET", "")
    RAZORPAY_ENABLED: bool = os.getenv("RAZORPAY_ENABLED", "true").lower() == "true"
    RAZORPAY_CURRENCY: str = os.getenv("RAZORPAY_CURRENCY", "INR")
    
    # Stripe Configuration
    STRIPE_SECRET_KEY: str = os.getenv("STRIPE_SECRET_KEY", "")
    STRIPE_PUBLISHABLE_KEY: str = os.getenv("STRIPE_PUBLISHABLE_KEY", "")
    STRIPE_WEBHOOK_SECRET: str = os.getenv("STRIPE_WEBHOOK_SECRET", "")
    STRIPE_ENABLED: bool = os.getenv("STRIPE_ENABLED", "true").lower() == "true"
    
    # Payment URLs
    PAYMENT_SUCCESS_URL: str = os.getenv("PAYMENT_SUCCESS_URL", "http://localhost:3000/billing/success")
    PAYMENT_FAILURE_URL: str = os.getenv("PAYMENT_FAILURE_URL", "http://localhost:3000/billing/failure")
    DEFAULT_PAYMENT_GATEWAY: str = os.getenv("DEFAULT_PAYMENT_GATEWAY", "razorpay")
    
    # Development Mode
    DEV_MODE: bool = os.getenv("DEV_MODE", "false").lower() == "true"
    DEV_MODE_CONFIRMATION_KEY: str = os.getenv("DEV_MODE_CONFIRMATION_KEY", "")

    # Company / Invoice Branding
    COMPANY_NAME: str = os.getenv("COMPANY_NAME", "Edge Cloud Storage")
    COMPANY_ADDRESS: str = os.getenv("COMPANY_ADDRESS", "")
    COMPANY_EMAIL: str = os.getenv("COMPANY_EMAIL", "")
    COMPANY_PHONE: str = os.getenv("COMPANY_PHONE", "")
    COMPANY_GST: str = os.getenv("COMPANY_GST", "")
    COMPANY_LOGO_URL: str = os.getenv("COMPANY_LOGO_URL", "")

    # Email Configuration (Mailgun API)
    MAILGUN_ENABLED: bool = os.getenv("MAILGUN_ENABLED", "true").lower() == "true"
    MAILGUN_API_KEY: str = os.getenv("MAILGUN_API_KEY", "")
    MAILGUN_DOMAIN: str = os.getenv("MAILGUN_DOMAIN", "")  # e.g., "mg.yourdomain.com"
    MAILGUN_API_URL: str = os.getenv("MAILGUN_API_URL", "https://api.mailgun.net/v3")
    MAILGUN_FROM_EMAIL: str = os.getenv("MAILGUN_FROM_EMAIL", "noreply@yourdomain.com")
    MAILGUN_FROM_NAME: str = os.getenv("MAILGUN_FROM_NAME", "Edge Cloud Storage")

    # Email Verification Settings
    VERIFICATION_CODE_LENGTH: int = 6
    VERIFICATION_CODE_EXPIRY_MINUTES: int = 30
    MAX_VERIFICATION_ATTEMPTS: int = 5
    RESEND_CODE_COOLDOWN_SECONDS: int = 60  # 1 minute between resends

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

    # Semantic Search Configuration
    SEMANTIC_SEARCH_ENABLED: bool = os.getenv("SEMANTIC_SEARCH_ENABLED", "true").lower() == "true"
    SEMANTIC_MODEL_NAME: str = os.getenv("SEMANTIC_MODEL_NAME", "all-MiniLM-L6-v2")
    SEMANTIC_EMBEDDING_DIM: int = int(os.getenv("SEMANTIC_EMBEDDING_DIM", 384))
    SEMANTIC_CACHE_TTL: int = int(os.getenv("SEMANTIC_CACHE_TTL", 604800))  # 7 days
    SEMANTIC_BATCH_SIZE: int = int(os.getenv("SEMANTIC_BATCH_SIZE", 100))
    SEMANTIC_SEARCH_TOP_K: int = int(os.getenv("SEMANTIC_SEARCH_TOP_K", 50))
    SEMANTIC_MIN_SCORE: float = float(os.getenv("SEMANTIC_MIN_SCORE", 0.3))

    # Hybrid Search Weights (keyword + semantic)
    HYBRID_KEYWORD_WEIGHT: float = float(os.getenv("HYBRID_KEYWORD_WEIGHT", 0.4))
    HYBRID_SEMANTIC_WEIGHT: float = float(os.getenv("HYBRID_SEMANTIC_WEIGHT", 0.6))

    # Elasticsearch Configuration
    ELASTICSEARCH_ENABLED: bool = os.getenv("ELASTICSEARCH_ENABLED", "true").lower() == "true"
    ELASTICSEARCH_URL: str = os.getenv("ELASTICSEARCH_URL", "http://localhost:9200")
    ELASTICSEARCH_INDEX_PREFIX: str = os.getenv("ELASTICSEARCH_INDEX_PREFIX", "edge_storage")
    ELASTICSEARCH_RETRY_ON_TIMEOUT: bool = os.getenv("ELASTICSEARCH_RETRY_ON_TIMEOUT", "true").lower() == "true"
    ELASTICSEARCH_MAX_RETRIES: int = int(os.getenv("ELASTICSEARCH_MAX_RETRIES", 3))
    ELASTICSEARCH_TIMEOUT: int = int(os.getenv("ELASTICSEARCH_TIMEOUT", 10))  # seconds

    # Kafka Configuration
    KAFKA_BROKERS: str = os.getenv("KAFKA_BROKERS", "localhost:9092")

    # OAuth Configuration
    GOOGLE_CLIENT_ID: str = os.getenv("GOOGLE_CLIENT_ID", "")
    GOOGLE_CLIENT_SECRET: str = os.getenv("GOOGLE_CLIENT_SECRET", "")
    GITHUB_CLIENT_ID: str = os.getenv("GITHUB_CLIENT_ID", "")
    GITHUB_CLIENT_SECRET: str = os.getenv("GITHUB_CLIENT_SECRET", "")
    MICROSOFT_CLIENT_ID: str = os.getenv("MICROSOFT_CLIENT_ID", "")
    MICROSOFT_CLIENT_SECRET: str = os.getenv("MICROSOFT_CLIENT_SECRET", "")

    # OAuth URLs
    API_BASE_URL: str = os.getenv("API_BASE_URL", "http://localhost:8000")
    FRONTEND_URL: str = os.getenv("FRONTEND_URL", "http://localhost:3001")

    # Security Services Configuration
    VIRUS_SCANNING_ENABLED: bool = os.getenv("VIRUS_SCANNING_ENABLED", "true").lower() == "true"
    DLP_SCANNING_ENABLED: bool = os.getenv("DLP_SCANNING_ENABLED", "true").lower() == "true"

    # Rust Data Plane Configuration (High-Performance Chunk Processing)
    # Provides 3-4x performance improvement for encryption/compression operations
    RUST_DATAPLANE_ENABLED: bool = os.getenv("RUST_DATAPLANE_ENABLED", "false").lower() == "true"
    RUST_DATAPLANE_SOCKET: str = os.getenv("RUST_DATAPLANE_SOCKET", "/tmp/edge-storage-dataplane.sock")
    RUST_DATAPLANE_TIMEOUT: int = int(os.getenv("RUST_DATAPLANE_TIMEOUT", 300))  # 5 minutes
    RUST_DATAPLANE_ROLLOUT_PERCENTAGE: int = int(os.getenv("RUST_DATAPLANE_ROLLOUT_PERCENTAGE", 100))
    RUST_DATAPLANE_FALLBACK_TO_PYTHON: bool = os.getenv("RUST_DATAPLANE_FALLBACK_TO_PYTHON", "true").lower() == "true"
    # fsync modes: none (fastest), session (balanced), per-chunk (most durable)
    RUST_DATAPLANE_FSYNC_MODE: str = os.getenv("RUST_DATAPLANE_FSYNC_MODE", "session")
    # Mode: "hybrid" (ZK hash + Python encrypt) or "full" (SCM_RIGHTS Non-ZK - requires Phase 2)
    RUST_DATAPLANE_MODE: str = os.getenv("RUST_DATAPLANE_MODE", "hybrid")  # hybrid | full

    @property
    def is_production(self) -> bool:
        """Check if running in production mode"""
        return os.getenv("ENVIRONMENT", "development").lower() == "production"

    def __init__(self):
        """Initialize settings with validation"""
        self._validate_database_url()
        self._validate_encryption_keys()
        self._validate_dev_mode()

    def _validate_database_url(self):
        """Validate DATABASE_URL is set"""
        if not self.DATABASE_URL:
            error_msg = (
                "CRITICAL: DATABASE_URL environment variable is not set. "
                "Set it to your PostgreSQL connection string, e.g.: "
                "postgresql+asyncpg://user:password@host:5432/dbname"
            )
            logger.error(error_msg)
            raise ValueError(error_msg)

    def _validate_encryption_keys(self):
        """Validate encryption keys are properly configured"""
        # Check if SECRET_KEY is set
        if not self.SECRET_KEY:
            error_msg = (
                "CRITICAL SECURITY ERROR: SECRET_KEY environment variable is not set. "
                "This key is required for JWT token signing and session management. "
                "Generate one with: openssl rand -base64 32"
            )
            logger.error(error_msg)
            raise ValueError(error_msg)

        # Warn if using default/weak SECRET_KEY
        if self.SECRET_KEY in ["your-secret-key-here", "your-secret-key-here-generate-with-openssl"]:
            error_msg = (
                "CRITICAL SECURITY ERROR: SECRET_KEY is set to a default placeholder value. "
                "You must generate a secure random key with: openssl rand -base64 32"
            )
            logger.error(error_msg)
            raise ValueError(error_msg)

        # Check encryption master key
        if not self.ENCRYPTION_MASTER_KEY:
            logger.warning("=" * 80)
            logger.warning("⚠️  ENCRYPTION_MASTER_KEY not set - deriving from SECRET_KEY")
            logger.warning("⚠️  For better security, set a dedicated ENCRYPTION_MASTER_KEY")
            logger.warning("⚠️  Generate with: openssl rand -base64 32")
            logger.warning("=" * 80)
        else:
            # Validate it's valid base64 and correct length
            try:
                mk = base64.b64decode(self.ENCRYPTION_MASTER_KEY)
                if len(mk) != 32:
                    raise ValueError("must be 32 bytes when decoded")
            except Exception as e:
                error_msg = (
                    f"CRITICAL SECURITY ERROR: ENCRYPTION_MASTER_KEY is invalid: {e}. "
                    f"Generate a valid one with: openssl rand -base64 32"
                )
                logger.error(error_msg)
                raise ValueError(error_msg)

            logger.info("✓ ENCRYPTION_MASTER_KEY validated successfully")

    def _validate_dev_mode(self):
        """Validate DEV_MODE configuration"""
        if self.DEV_MODE:
            environment = os.getenv("ENVIRONMENT", "development").lower()

            # CRITICAL: Only allow DEV_MODE on explicitly local environments
            if environment not in ("development", "local", "test"):
                error_msg = (
                    f"CRITICAL SECURITY ERROR: DEV_MODE cannot be enabled when "
                    f"ENVIRONMENT={environment}. DEV_MODE bypasses all payment "
                    f"verification and is only allowed for development/local/test."
                )
                logger.error(error_msg)
                raise ValueError(error_msg)

            # Require confirmation key to prevent accidental activation
            if not self.DEV_MODE_CONFIRMATION_KEY:
                error_msg = (
                    "SECURITY ERROR: DEV_MODE=true requires DEV_MODE_CONFIRMATION_KEY to be set. "
                    "This prevents accidental activation. Generate a random key and set it as "
                    "DEV_MODE_CONFIRMATION_KEY in your .env file."
                )
                logger.error(error_msg)
                raise ValueError(error_msg)

            logger.warning("=" * 80)
            logger.warning("DEV_MODE IS ENABLED - PAYMENT VERIFICATION BYPASSED!")
            logger.warning("This should NEVER be enabled in production.")
            logger.warning("ENVIRONMENT=%s", environment)
            logger.warning("=" * 80)

settings = Settings()