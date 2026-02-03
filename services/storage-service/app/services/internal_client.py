"""
Internal Service Client for Cross-Service Communication

Provides authenticated HTTP client for service-to-service communication
between Storage Service and ZK Encryption Service.
"""
import httpx
import logging
from typing import Optional
from ..config import settings

logger = logging.getLogger(__name__)


class InternalServiceClient:
    """Client for authenticated internal service-to-service calls"""

    def __init__(self):
        """Initialize internal service client with API key and service URL"""
        self.internal_api_key = settings.INTERNAL_SERVICE_API_KEY
        self.zk_service_url = settings.ZK_SERVICE_INTERNAL_URL

    async def check_email_exists_on_zk_service(self, email: str) -> bool:
        """
        Check if email is registered on ZK service

        Args:
            email: Email address to check

        Returns:
            bool: True if email exists on ZK service, False otherwise

        Note:
            Fails open (returns False) on timeout or error to avoid blocking registration
        """
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(
                    f"{self.zk_service_url}/api/v1/zk/internal/check-email",
                    params={"email": email},
                    headers={"X-Internal-API-Key": self.internal_api_key}
                )
                if response.status_code == 200:
                    data = response.json()
                    return data.get("exists", False)
                elif response.status_code == 403:
                    logger.error(f"Invalid internal API key for ZK service check")
                    return False
                else:
                    logger.warning(f"Unexpected status code from ZK service: {response.status_code}")
                    return False
        except httpx.TimeoutException:
            logger.warning(f"Timeout checking email on ZK service: {email}")
            return False  # Fail open to not block registration
        except Exception as e:
            logger.error(f"Error checking email on ZK service: {e}")
            return False  # Fail open
