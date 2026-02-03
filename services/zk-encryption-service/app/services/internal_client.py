"""
Internal Service Client for ZK Service

Provides authenticated HTTP client for service-to-service communication
between ZK Encryption Service and Storage Service.
"""
import httpx
import structlog
from app.config import settings

logger = structlog.get_logger()


class InternalServiceClient:
    """Client for internal service-to-service communication"""

    def __init__(self):
        """Initialize internal service client with API key and service URL"""
        self.internal_api_key = settings.INTERNAL_SERVICE_API_KEY
        self.storage_service_url = settings.STORAGE_SERVICE_INTERNAL_URL

    async def check_email_exists_on_normal_service(self, email: str) -> bool:
        """
        Check if email is registered on Normal storage service

        Args:
            email: Email address to check

        Returns:
            bool: True if email exists on Normal service, False otherwise

        Note:
            Fails open (returns False) on timeout or error to avoid blocking registration
        """
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(
                    f"{self.storage_service_url}/api/v1/auth/internal/check-email",
                    params={"email": email},
                    headers={"X-Internal-API-Key": self.internal_api_key}
                )
                if response.status_code == 200:
                    return response.json().get("exists", False)
                elif response.status_code == 403:
                    logger.error("invalid_internal_api_key", service="normal")
                    return False
                else:
                    logger.warning("unexpected_status_from_normal_service", status=response.status_code)
                    return False
        except httpx.TimeoutException:
            logger.warning("timeout_checking_normal_service", email=email)
            return False  # Fail open
        except Exception as e:
            logger.error("error_checking_normal_service", error=str(e))
            return False  # Fail open
