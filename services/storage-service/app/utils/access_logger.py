"""Fire-and-forget share access logging for audit trail + owner notifications."""

import logging
from typing import Optional
from uuid import UUID

from fastapi import Request
from slowapi.util import get_remote_address
from sqlalchemy import select

from ..database import AsyncSessionLocal, get_redis
from ..models.database import ShareAccessLog, ShareBundle, ShareLink, User

logger = logging.getLogger(__name__)

# Debounce window: max 1 notification per share per 15 minutes
NOTIFY_DEBOUNCE_SECONDS = 15 * 60


async def log_share_access(
    request: Request,
    access_type: str,
    share_link_id: Optional[UUID] = None,
    bundle_id: Optional[UUID] = None,
    file_id: Optional[UUID] = None,
):
    """
    Log a share access event and optionally notify the owner.

    Args:
        request: FastAPI request (for IP and User-Agent)
        access_type: Event type (view, download, download_file, download_zip, stream, thumbnail)
        share_link_id: FK to share_links (for file/folder shares)
        bundle_id: FK to share_bundles (for bundle shares)
        file_id: Optional specific file accessed
    """
    try:
        ip = get_remote_address(request)
        ua = request.headers.get("User-Agent", "")[:500]

        async with AsyncSessionLocal() as db:
            # Write audit log
            log_entry = ShareAccessLog(
                share_link_id=share_link_id,
                bundle_id=bundle_id,
                access_type=access_type,
                ip_address=ip,
                user_agent=ua,
                file_id=file_id,
            )
            db.add(log_entry)
            await db.commit()

            # Check if owner wants notifications
            await _maybe_notify_owner(db, access_type, ip, share_link_id, bundle_id)

    except Exception as e:
        # Never let audit logging break the main request
        logger.warning(f"Failed to log share access ({access_type}): {e}")


async def _maybe_notify_owner(
    db,
    access_type: str,
    ip: str,
    share_link_id: Optional[UUID],
    bundle_id: Optional[UUID],
):
    """Send debounced email notification to share owner if notify_on_access is enabled."""
    try:
        owner_email = None
        item_name = None
        debounce_key = None

        if share_link_id:
            result = await db.execute(
                select(ShareLink, User)
                .join(User, ShareLink.user_id == User.id)
                .filter(ShareLink.id == share_link_id)
            )
            row = result.first()
            if row:
                link, owner = row
                if link.notify_on_access:
                    owner_email = owner.email
                    item_name = "your shared link"
                    debounce_key = f"share_notify:{share_link_id}"

        elif bundle_id:
            result = await db.execute(
                select(ShareBundle, User)
                .join(User, ShareBundle.user_id == User.id)
                .filter(ShareBundle.id == bundle_id)
            )
            row = result.first()
            if row:
                bundle, owner = row
                if bundle.notify_on_access:
                    owner_email = owner.email
                    item_name = bundle.name
                    debounce_key = f"share_notify:{bundle_id}"

        if not owner_email or not debounce_key:
            return

        # Redis debounce — skip if already notified within window
        redis = await get_redis()
        if redis:
            already_sent = await redis.get(debounce_key)
            if already_sent:
                return
            await redis.setex(debounce_key, NOTIFY_DEBOUNCE_SECONDS, "1")

        # Send notification
        from ..services.email_service import email_service

        await email_service.send_email(
            to_email=owner_email,
            subject=f"Someone accessed {item_name}",
            html_content=(
                f"<p>Your shared content <b>{item_name}</b> was accessed.</p>"
                f"<p><b>Action:</b> {access_type}<br>"
                f"<b>IP:</b> {ip}</p>"
                f"<p><small>You're receiving this because you enabled access notifications. "
                f"Notifications are throttled to at most one every 15 minutes per share.</small></p>"
            ),
            text_content=(
                f"Your shared content '{item_name}' was accessed.\n"
                f"Action: {access_type}\nIP: {ip}\n\n"
                f"Notifications are throttled to at most one every 15 minutes per share."
            ),
        )
        logger.info(f"Access notification sent to {owner_email} for {debounce_key}")

    except Exception as e:
        logger.warning(f"Failed to send access notification: {e}")
