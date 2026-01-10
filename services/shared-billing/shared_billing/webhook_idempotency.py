"""
Webhook Idempotency and Replay Protection

Prevents duplicate webhook processing and replay attacks for both Stripe and Razorpay.

Features:
- Event deduplication using unique event IDs
- Timestamp validation (reject old webhooks)
- IP whitelisting for webhook sources
- Audit trail of all webhook events
"""

import logging
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
from uuid import UUID, uuid4

from sqlalchemy import Column, String, DateTime, Text, Index, func, select
from sqlalchemy.dialects.postgresql import UUID as PGUUID, JSONB
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Base

logger = logging.getLogger(__name__)


class WebhookEvent(Base):
    """
    Tracks webhook events for idempotency and audit.

    Ensures each webhook is processed exactly once, even if delivered multiple times.
    """
    __tablename__ = "webhook_events"

    id = Column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
    event_id = Column(String(255), unique=True, nullable=False, index=True)
    gateway = Column(String(20), nullable=False, index=True)  # 'stripe' or 'razorpay'
    event_type = Column(String(100), nullable=False, index=True)
    status = Column(String(20), nullable=False, default='processed')  # processed, failed
    payload = Column(JSONB, nullable=False)
    ip_address = Column(String(45))  # IPv4 or IPv6
    processed_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    error_message = Column(Text)

    __table_args__ = (
        Index('idx_webhook_gateway_event_type', 'gateway', 'event_type'),
        Index('idx_webhook_processed_at', 'processed_at'),
    )


# Webhook source IP whitelist
# Production IPs from Stripe and Razorpay documentation
WEBHOOK_IP_WHITELIST = {
    "stripe": [
        # Stripe webhook IPs (as of 2024)
        "3.18.12.63",
        "3.130.192.231",
        "13.235.14.237",
        "13.235.122.149",
        "18.211.135.69",
        "35.154.171.200",
        "52.15.183.38",
        "54.88.130.119",
        "54.88.130.237",
        "54.187.174.169",
        "54.187.205.235",
        "54.187.216.72",
    ],
    "razorpay": [
        # Razorpay webhook IPs (India region)
        "3.6.206.107",
        "3.7.126.66",
        "52.66.161.209",
        "52.66.178.233",
    ],
}


class WebhookIdempotencyService:
    """
    Service for webhook idempotency and replay protection.
    """

    def __init__(self, db: AsyncSession):
        self.db = db

    async def is_duplicate_event(self, event_id: str, gateway: str) -> bool:
        """
        Check if webhook event has already been processed.

        Args:
            event_id: Unique event identifier from payment gateway
            gateway: Payment gateway name ('stripe' or 'razorpay')

        Returns:
            True if event already processed, False otherwise
        """
        result = await self.db.execute(
            select(WebhookEvent).where(
                WebhookEvent.event_id == event_id,
                WebhookEvent.gateway == gateway
            )
        )
        existing = result.scalar_one_or_none()
        return existing is not None

    async def record_webhook_event(
        self,
        event_id: str,
        gateway: str,
        event_type: str,
        payload: Dict[str, Any],
        ip_address: Optional[str] = None,
        status: str = 'processed',
        error_message: Optional[str] = None
    ) -> WebhookEvent:
        """
        Record webhook event for idempotency tracking.

        Args:
            event_id: Unique event identifier
            gateway: Payment gateway ('stripe' or 'razorpay')
            event_type: Type of webhook event
            payload: Full webhook payload (for audit)
            ip_address: Source IP address
            status: Processing status ('processed' or 'failed')
            error_message: Error message if processing failed

        Returns:
            Created WebhookEvent record
        """
        webhook_event = WebhookEvent(
            event_id=event_id,
            gateway=gateway,
            event_type=event_type,
            payload=payload,
            ip_address=ip_address,
            status=status,
            error_message=error_message
        )

        self.db.add(webhook_event)
        await self.db.commit()
        await self.db.refresh(webhook_event)

        logger.info(
            f"Webhook event recorded",
            extra={
                "event_id": event_id,
                "gateway": gateway,
                "event_type": event_type,
                "status": status
            }
        )

        return webhook_event

    def validate_timestamp(
        self,
        event_timestamp: datetime,
        max_age_seconds: int = 300
    ) -> tuple[bool, Optional[str]]:
        """
        Validate webhook timestamp to prevent replay attacks.

        Args:
            event_timestamp: Timestamp from webhook event
            max_age_seconds: Maximum age for webhook (default 5 minutes)

        Returns:
            (is_valid, error_message)
        """
        now = datetime.utcnow()
        age_seconds = abs((now - event_timestamp).total_seconds())

        if age_seconds > max_age_seconds:
            error_msg = f"Webhook timestamp too old: {age_seconds}s (max: {max_age_seconds}s)"
            logger.warning(error_msg, extra={"event_timestamp": event_timestamp})
            return False, error_msg

        return True, None

    def validate_source_ip(
        self,
        ip_address: str,
        gateway: str,
        allow_local: bool = False
    ) -> tuple[bool, Optional[str]]:
        """
        Validate webhook source IP address.

        Args:
            ip_address: Source IP address
            gateway: Payment gateway ('stripe' or 'razorpay')
            allow_local: Allow localhost IPs (for development)

        Returns:
            (is_valid, error_message)
        """
        # Allow localhost in development
        if allow_local and ip_address in ["127.0.0.1", "localhost", "::1"]:
            return True, None

        # Check against whitelist
        allowed_ips = WEBHOOK_IP_WHITELIST.get(gateway, [])
        if ip_address not in allowed_ips:
            error_msg = f"Webhook from unauthorized IP: {ip_address}"
            logger.warning(
                error_msg,
                extra={"ip": ip_address, "gateway": gateway}
            )
            return False, error_msg

        return True, None

    async def get_webhook_history(
        self,
        gateway: Optional[str] = None,
        event_type: Optional[str] = None,
        limit: int = 100
    ) -> list[WebhookEvent]:
        """
        Get webhook event history for audit and debugging.

        Args:
            gateway: Filter by gateway
            event_type: Filter by event type
            limit: Maximum number of events to return

        Returns:
            List of webhook events
        """
        query = select(WebhookEvent).order_by(WebhookEvent.processed_at.desc())

        if gateway:
            query = query.where(WebhookEvent.gateway == gateway)
        if event_type:
            query = query.where(WebhookEvent.event_type == event_type)

        query = query.limit(limit)

        result = await self.db.execute(query)
        return result.scalars().all()

    async def cleanup_old_events(self, days_to_keep: int = 90):
        """
        Clean up old webhook events (for maintenance).

        Args:
            days_to_keep: Number of days to retain events
        """
        cutoff_date = datetime.utcnow() - timedelta(days=days_to_keep)

        result = await self.db.execute(
            select(func.count()).select_from(WebhookEvent).where(
                WebhookEvent.processed_at < cutoff_date
            )
        )
        count_to_delete = result.scalar()

        if count_to_delete > 0:
            await self.db.execute(
                WebhookEvent.__table__.delete().where(
                    WebhookEvent.processed_at < cutoff_date
                )
            )
            await self.db.commit()

            logger.info(
                f"Cleaned up {count_to_delete} old webhook events",
                extra={"cutoff_date": cutoff_date}
            )

        return count_to_delete
