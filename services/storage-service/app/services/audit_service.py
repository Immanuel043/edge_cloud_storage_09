"""
Audit Logging Service

Comprehensive logging of all user actions for security, compliance, and forensics.
"""

import json
import logging
from typing import Optional, Dict, Any
from datetime import datetime
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import Request

from app.models.database import AuditLog, VirusScanLog, DLPScanLog
from app.database import async_session

logger = logging.getLogger(__name__)


class AuditService:
    """Service for audit logging"""

    @staticmethod
    async def log_action(
        action: str,
        user_id: Optional[UUID] = None,
        resource_type: Optional[str] = None,
        resource_id: Optional[UUID] = None,
        resource_name: Optional[str] = None,
        status: str = 'success',
        status_code: Optional[int] = None,
        error_message: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        request: Optional[Request] = None,
        is_suspicious: bool = False,
        risk_level: str = 'low'
    ):
        """
        Log an action to the audit trail

        Args:
            action: Action performed (e.g., 'file.upload', 'user.login')
            user_id: ID of user performing action
            resource_type: Type of resource affected
            resource_id: ID of resource affected
            resource_name: Name of resource for easy reference
            status: 'success', 'failure', 'blocked'
            status_code: HTTP status code
            error_message: Error message if failed
            metadata: Additional context as dict
            request: FastAPI Request object for context
            is_suspicious: Flag suspicious activity
            risk_level: 'low', 'medium', 'high', 'critical'
        """
        try:
            # Extract request context
            ip_address = None
            user_agent = None
            request_method = None
            request_path = None

            if request:
                ip_address = request.client.host if request.client else None
                user_agent = request.headers.get('user-agent')
                request_method = request.method
                request_path = str(request.url.path)

            # Convert metadata to JSON
            metadata_json = None
            if metadata:
                try:
                    metadata_json = json.dumps(metadata)
                except Exception as e:
                    logger.warning(f"Failed to serialize metadata: {e}")
                    metadata_json = json.dumps({'error': 'Failed to serialize'})

            async with async_session() as session:
                audit_entry = AuditLog(
                    user_id=user_id,
                    action=action,
                    resource_type=resource_type,
                    resource_id=resource_id,
                    resource_name=resource_name,
                    ip_address=ip_address,
                    user_agent=user_agent,
                    request_method=request_method,
                    request_path=request_path,
                    status=status,
                    status_code=status_code,
                    error_message=error_message,
                    context_data=metadata_json,
                    is_suspicious=is_suspicious,
                    risk_level=risk_level
                )

                session.add(audit_entry)
                await session.commit()

                logger.info(f"Audit log: {action} by user {user_id} - {status}")

        except Exception as e:
            # Never let audit logging crash the application
            logger.error(f"Failed to write audit log: {e}", exc_info=True)

    @staticmethod
    async def log_virus_scan(
        file_id: UUID,
        user_id: UUID,
        is_infected: bool,
        virus_name: Optional[str] = None,
        scan_engine: str = 'clamav',
        scan_time: float = 0.0,
        file_size: Optional[int] = None,
        file_hash: Optional[str] = None,
        error_message: Optional[str] = None,
        action_taken: str = 'allowed'
    ):
        """Log virus scan result"""
        try:
            async with async_session() as session:
                scan_log = VirusScanLog(
                    file_id=file_id,
                    user_id=user_id,
                    is_infected=is_infected,
                    virus_name=virus_name,
                    scan_engine=scan_engine,
                    scan_time=scan_time,
                    file_size=file_size,
                    file_hash=file_hash,
                    error_message=error_message,
                    action_taken=action_taken
                )

                session.add(scan_log)
                await session.commit()

                if is_infected:
                    logger.warning(f"VIRUS DETECTED: {virus_name} in file {file_id}")
                else:
                    logger.info(f"Virus scan clean for file {file_id}")

        except Exception as e:
            logger.error(f"Failed to log virus scan: {e}", exc_info=True)

    @staticmethod
    async def log_dlp_scan(
        file_id: UUID,
        user_id: UUID,
        has_sensitive_data: bool,
        risk_score: float,
        total_matches: int,
        scan_time: float,
        detected_types: Optional[list] = None,
        file_size: Optional[int] = None,
        action_taken: str = 'allowed',
        blocked: bool = False
    ):
        """Log DLP scan result"""
        try:
            # Convert detected types to JSON
            detected_types_json = None
            if detected_types:
                detected_types_json = json.dumps(detected_types)

            async with async_session() as session:
                dlp_log = DLPScanLog(
                    file_id=file_id,
                    user_id=user_id,
                    has_sensitive_data=has_sensitive_data,
                    risk_score=risk_score,
                    total_matches=total_matches,
                    scan_time=scan_time,
                    detected_types=detected_types_json,
                    file_size=file_size,
                    action_taken=action_taken,
                    blocked=blocked
                )

                session.add(dlp_log)
                await session.commit()

                if has_sensitive_data:
                    logger.warning(
                        f"DLP: Sensitive data detected in file {file_id} "
                        f"(risk: {risk_score:.1f}, types: {detected_types})"
                    )
                else:
                    logger.info(f"DLP scan clean for file {file_id}")

        except Exception as e:
            logger.error(f"Failed to log DLP scan: {e}", exc_info=True)

    @staticmethod
    async def get_user_activity(
        user_id: UUID,
        limit: int = 100,
        action_filter: Optional[str] = None,
        session: Optional[AsyncSession] = None
    ) -> list:
        """
        Get audit trail for a user

        Args:
            user_id: User ID
            limit: Maximum number of entries
            action_filter: Filter by action (e.g., 'file.upload')
            session: Optional database session

        Returns:
            List of audit log entries
        """
        from sqlalchemy import select, desc

        async def _query(db_session):
            query = select(AuditLog).where(AuditLog.user_id == user_id)

            if action_filter:
                query = query.where(AuditLog.action.like(f'{action_filter}%'))

            query = query.order_by(desc(AuditLog.created_at)).limit(limit)

            result = await db_session.execute(query)
            return result.scalars().all()

        if session:
            return await _query(session)
        else:
            async with async_session() as db_session:
                return await _query(db_session)

    @staticmethod
    async def get_suspicious_activity(
        limit: int = 100,
        risk_level: Optional[str] = None,
        session: Optional[AsyncSession] = None
    ) -> list:
        """
        Get suspicious activity across all users

        Args:
            limit: Maximum number of entries
            risk_level: Filter by risk level
            session: Optional database session

        Returns:
            List of suspicious audit log entries
        """
        from sqlalchemy import select, desc

        async def _query(db_session):
            query = select(AuditLog).where(AuditLog.is_suspicious == True)

            if risk_level:
                query = query.where(AuditLog.risk_level == risk_level)

            query = query.order_by(desc(AuditLog.created_at)).limit(limit)

            result = await db_session.execute(query)
            return result.scalars().all()

        if session:
            return await _query(session)
        else:
            async with async_session() as db_session:
                return await _query(db_session)

    @staticmethod
    async def get_infected_files(
        limit: int = 100,
        session: Optional[AsyncSession] = None
    ) -> list:
        """Get all files that were flagged as infected"""
        from sqlalchemy import select, desc

        async def _query(db_session):
            query = select(VirusScanLog).where(
                VirusScanLog.is_infected == True
            ).order_by(desc(VirusScanLog.scanned_at)).limit(limit)

            result = await db_session.execute(query)
            return result.scalars().all()

        if session:
            return await _query(session)
        else:
            async with async_session() as db_session:
                return await _query(db_session)

    @staticmethod
    async def get_high_risk_files(
        min_risk_score: float = 70.0,
        limit: int = 100,
        session: Optional[AsyncSession] = None
    ) -> list:
        """Get files with high DLP risk scores"""
        from sqlalchemy import select, desc

        async def _query(db_session):
            query = select(DLPScanLog).where(
                DLPScanLog.risk_score >= min_risk_score
            ).order_by(desc(DLPScanLog.risk_score)).limit(limit)

            result = await db_session.execute(query)
            return result.scalars().all()

        if session:
            return await _query(session)
        else:
            async with async_session() as db_session:
                return await _query(db_session)


# Singleton instance
_audit_service = None


def get_audit_service() -> AuditService:
    """Get or create audit service singleton"""
    global _audit_service
    if _audit_service is None:
        _audit_service = AuditService()
    return _audit_service
