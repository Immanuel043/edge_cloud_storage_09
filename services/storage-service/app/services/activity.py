# services/storage-service/app/services/activity.py
"""Activity logging service"""
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import Request
from ..models.database import ActivityLog

class ActivityService:
    """Handles activity logging"""
    
    @staticmethod
    async def log_activity(
        db: AsyncSession,
        user_id: str,
        action: str,
        object_id: str = None,
        metadata: dict = None,
        request: Request = None,
    ):
        """Log user activity"""
        activity = ActivityLog(
            user_id=user_id,
            action=action,
            object_id=object_id,
            ip_address=request.client.host if request else None,
            user_agent=request.headers.get("user-agent") if request else None,
            meta_data=metadata,
        )
        db.add(activity)
        await db.commit()
        return activity

activity_service = ActivityService()