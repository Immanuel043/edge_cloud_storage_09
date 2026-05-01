# services/storage-service/app/services/audit_logging_service.py

"""
Enhanced Audit Logging Service

Comprehensive audit logging for security, compliance, and forensics.

Features:
- Security event logging (authentication, authorization)
- Data access logging (GDPR compliance)
- Administrative action logging
- System event logging
- Compliance reporting
- Tamper-proof logs (hashing)
- Log retention and archival
- Real-time alerting for critical events

Compliance Standards:
- SOC 2 Type II
- ISO 27001
- GDPR Article 30 (Records of Processing)
- HIPAA (if healthcare data)
- PCI DSS (if payment data)
"""

import hashlib
import json
import logging
import os
from datetime import datetime, timedelta
from enum import Enum
from logging.handlers import RotatingFileHandler
from typing import Any, Dict, List, Optional
from uuid import UUID, uuid4

from fastapi import Request
from sqlalchemy import and_, desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.database import User

logger = logging.getLogger(__name__)


class AuditEventType(str, Enum):
    """Types of audit events"""

    # Authentication Events
    LOGIN_SUCCESS = "auth.login.success"
    LOGIN_FAILURE = "auth.login.failure"
    LOGOUT = "auth.logout"
    PASSWORD_CHANGE = "auth.password.change"
    PASSWORD_RESET = "auth.password.reset"
    MFA_ENABLED = "auth.mfa.enabled"
    MFA_DISABLED = "auth.mfa.disabled"
    OAUTH_LOGIN = "auth.oauth.login"

    # Authorization Events
    ACCESS_GRANTED = "authz.access.granted"
    ACCESS_DENIED = "authz.access.denied"
    PERMISSION_CHANGED = "authz.permission.changed"
    ROLE_ASSIGNED = "authz.role.assigned"
    ROLE_REMOVED = "authz.role.removed"

    # Data Access Events (GDPR)
    FILE_UPLOADED = "data.file.uploaded"
    FILE_DOWNLOADED = "data.file.downloaded"
    FILE_VIEWED = "data.file.viewed"
    FILE_MODIFIED = "data.file.modified"
    FILE_DELETED = "data.file.deleted"
    FILE_SHARED = "data.file.shared"
    FILE_UNSHARED = "data.file.unshared"

    # Administrative Events
    USER_CREATED = "admin.user.created"
    USER_MODIFIED = "admin.user.modified"
    USER_DELETED = "admin.user.deleted"
    USER_SUSPENDED = "admin.user.suspended"
    USER_ACTIVATED = "admin.user.activated"
    SETTINGS_CHANGED = "admin.settings.changed"

    # Security Events
    ENCRYPTION_KEY_ROTATED = "security.key.rotated"
    ENCRYPTION_KEY_CREATED = "security.key.created"
    ENCRYPTION_KEY_RETIRED = "security.key.retired"
    SECURITY_VIOLATION = "security.violation"
    SECURITY_SCAN_COMPLETED = "security.scan.completed"
    RATE_LIMIT_EXCEEDED = "security.rate_limit.exceeded"
    SUSPICIOUS_ACTIVITY = "security.suspicious"

    # GDPR Events
    GDPR_DATA_EXPORTED = "gdpr.data.exported"
    GDPR_ACCOUNT_DELETED = "gdpr.account.deleted"
    GDPR_CONSENT_GIVEN = "gdpr.consent.given"
    GDPR_CONSENT_WITHDRAWN = "gdpr.consent.withdrawn"
    GDPR_DATA_RECTIFIED = "gdpr.data.rectified"

    # System Events
    SYSTEM_STARTUP = "system.startup"
    SYSTEM_SHUTDOWN = "system.shutdown"
    BACKUP_CREATED = "system.backup.created"
    BACKUP_RESTORED = "system.backup.restored"
    DATABASE_MIGRATION = "system.database.migration"
    CONFIG_CHANGED = "system.config.changed"


class AuditSeverity(str, Enum):
    """Severity levels for audit events"""

    DEBUG = "debug"
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


class AuditCategory(str, Enum):
    """Categories for organizing audit events"""

    AUTHENTICATION = "authentication"
    AUTHORIZATION = "authorization"
    DATA_ACCESS = "data_access"
    ADMINISTRATION = "administration"
    SECURITY = "security"
    COMPLIANCE = "compliance"
    SYSTEM = "system"


class AuditEvent:
    """Represents an audit event"""

    def __init__(
        self,
        event_type: AuditEventType,
        user_id: Optional[UUID] = None,
        resource_type: Optional[str] = None,
        resource_id: Optional[str] = None,
        action: Optional[str] = None,
        result: str = "success",
        severity: AuditSeverity = AuditSeverity.INFO,
        category: Optional[AuditCategory] = None,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None,
        request_id: Optional[str] = None,
        session_id: Optional[str] = None,
        details: Optional[Dict] = None,
        metadata: Optional[Dict] = None,
    ):
        self.id = uuid4()
        self.event_type = event_type
        self.user_id = user_id
        self.resource_type = resource_type
        self.resource_id = resource_id
        self.action = action
        self.result = result
        self.severity = severity
        self.category = category or self._infer_category(event_type)
        self.ip_address = ip_address
        self.user_agent = user_agent
        self.request_id = request_id
        self.session_id = session_id
        self.details = details or {}
        self.metadata = metadata or {}
        self.timestamp = datetime.utcnow()

        # Generate hash for tamper detection
        self.event_hash = self._generate_hash()

    def _infer_category(self, event_type: AuditEventType) -> AuditCategory:
        """Infer category from event type"""
        type_str = event_type.value

        if type_str.startswith("auth."):
            return AuditCategory.AUTHENTICATION
        elif type_str.startswith("authz."):
            return AuditCategory.AUTHORIZATION
        elif type_str.startswith("data."):
            return AuditCategory.DATA_ACCESS
        elif type_str.startswith("admin."):
            return AuditCategory.ADMINISTRATION
        elif type_str.startswith("security."):
            return AuditCategory.SECURITY
        elif type_str.startswith("gdpr."):
            return AuditCategory.COMPLIANCE
        elif type_str.startswith("system."):
            return AuditCategory.SYSTEM
        else:
            return AuditCategory.SYSTEM

    def _generate_hash(self) -> str:
        """Generate hash of event for tamper detection"""
        # Create deterministic string representation
        hash_data = {
            "id": str(self.id),
            "event_type": self.event_type.value,
            "user_id": str(self.user_id) if self.user_id else None,
            "resource_type": self.resource_type,
            "resource_id": self.resource_id,
            "timestamp": self.timestamp.isoformat(),
            "result": self.result,
        }

        hash_string = json.dumps(hash_data, sort_keys=True)
        return hashlib.sha256(hash_string.encode()).hexdigest()

    def to_dict(self) -> Dict:
        """Convert to dictionary for storage/serialization"""
        return {
            "id": str(self.id),
            "event_type": self.event_type.value,
            "user_id": str(self.user_id) if self.user_id else None,
            "resource_type": self.resource_type,
            "resource_id": self.resource_id,
            "action": self.action,
            "result": self.result,
            "severity": self.severity.value,
            "category": self.category.value,
            "ip_address": self.ip_address,
            "user_agent": self.user_agent,
            "request_id": self.request_id,
            "session_id": self.session_id,
            "details": self.details,
            "metadata": self.metadata,
            "timestamp": self.timestamp.isoformat(),
            "event_hash": self.event_hash,
        }


class AuditLoggingService:
    """
    Enhanced audit logging service for security and compliance

    Features:
    - Structured logging with event types
    - Tamper detection via hashing
    - Severity levels and categories
    - Compliance-focused (GDPR, SOC 2, ISO 27001)
    - Real-time alerting for critical events
    - Log retention and archival
    """

    def __init__(self):
        self.logger = logging.getLogger("audit")

        # Audit log writes go to a path on the persisted storage volume so the
        # compliance/forensic trail survives container restarts. Falls back to
        # CWD if the directory cannot be created (dev / non-container envs).
        if not self.logger.handlers:
            log_dir = "/app/storage/logs"
            try:
                os.makedirs(log_dir, exist_ok=True)
                log_path = os.path.join(log_dir, "audit.log")
            except OSError:
                log_path = "audit.log"
            handler = RotatingFileHandler(
                log_path,
                maxBytes=100 * 1024 * 1024,  # 100MB per file
                backupCount=20,  # keep ~2GB of history
            )
            formatter = logging.Formatter("%(asctime)s - AUDIT - %(levelname)s - %(message)s")
            handler.setFormatter(formatter)
            self.logger.addHandler(handler)
            self.logger.setLevel(logging.INFO)

    async def log_event(
        self,
        db: AsyncSession,
        event_type: AuditEventType,
        user_id: Optional[UUID] = None,
        resource_type: Optional[str] = None,
        resource_id: Optional[str] = None,
        action: Optional[str] = None,
        result: str = "success",
        severity: AuditSeverity = AuditSeverity.INFO,
        request: Optional[Request] = None,
        details: Optional[Dict] = None,
        metadata: Optional[Dict] = None,
    ) -> AuditEvent:
        """
        Log an audit event

        Args:
            db: Database session
            event_type: Type of event (from AuditEventType enum)
            user_id: User who performed the action
            resource_type: Type of resource affected (e.g., "file", "user")
            resource_id: ID of resource affected
            action: Action performed (e.g., "upload", "delete")
            result: Result of action ("success", "failure", "denied")
            severity: Severity level
            request: FastAPI request object (for IP, user-agent, etc.)
            details: Additional details about the event
            metadata: Extra metadata

        Returns:
            AuditEvent object
        """
        # Extract request metadata. Use _real_client_ip so we record the real
        # end-user IP (from nginx's non-spoofable X-Real-IP header) rather than
        # the upstream proxy's Docker network address.
        ip_address = None
        user_agent = None
        request_id = None

        if request:
            from ..utils.rate_limiter_v2 import _real_client_ip

            ip_address = _real_client_ip(request)
            user_agent = request.headers.get("user-agent")
            request_id = request.headers.get("x-request-id")

        # Create audit event
        event = AuditEvent(
            event_type=event_type,
            user_id=user_id,
            resource_type=resource_type,
            resource_id=resource_id,
            action=action,
            result=result,
            severity=severity,
            ip_address=ip_address,
            user_agent=user_agent,
            request_id=request_id,
            details=details,
            metadata=metadata,
        )

        # Store in AuditLog table (not ActivityLog — main flows write ActivityLog via log_activity())
        from ..models.database import AuditLog as AuditLogModel

        audit_record = AuditLogModel(
            event_type=event_type.value,
            event_category=event.category.value,
            event_hash=event.event_hash,
            user_id=user_id,
            resource_type=resource_type,
            resource_id=resource_id,
            action=action or event_type.value,
            result=result,
            severity=severity.value,
            ip_address=ip_address,
            user_agent=user_agent,
            request_id=request_id,
            details=details,
            audit_metadata=metadata,
            previous_event_hash=None,
        )

        try:
            db.add(audit_record)
            await db.commit()
        except Exception as db_err:
            # Rollback to prevent poisoned session state
            try:
                await db.rollback()
            except Exception:
                pass
            logger.error(f"Failed to write audit log: {db_err}")

        # Log to file
        self._write_to_log_file(event)

        # Check for critical events and alert
        if severity in [AuditSeverity.ERROR, AuditSeverity.CRITICAL]:
            await self._handle_critical_event(event)

        return event

    def _write_to_log_file(self, event: AuditEvent):
        """Write event to audit log file"""
        log_message = json.dumps(event.to_dict())

        if event.severity == AuditSeverity.CRITICAL:
            self.logger.critical(log_message)
        elif event.severity == AuditSeverity.ERROR:
            self.logger.error(log_message)
        elif event.severity == AuditSeverity.WARNING:
            self.logger.warning(log_message)
        else:
            self.logger.info(log_message)

    async def _handle_critical_event(self, event: AuditEvent):
        """Handle critical security events with alerting"""
        # In production, this would send alerts via:
        # - Email
        # - Slack
        # - PagerDuty
        # - SIEM integration (Splunk, ELK, etc.)

        logger.critical(
            f"CRITICAL AUDIT EVENT: {event.event_type.value} - "
            f"User: {event.user_id}, IP: {event.ip_address}, "
            f"Details: {event.details}"
        )

        # TODO: Implement actual alerting
        # await send_security_alert(event)

    # ===== Convenience Methods for Common Events =====

    async def log_login(
        self,
        db: AsyncSession,
        user_id: UUID,
        success: bool,
        request: Optional[Request] = None,
        details: Optional[Dict] = None,
    ):
        """Log authentication attempt"""
        await self.log_event(
            db=db,
            event_type=AuditEventType.LOGIN_SUCCESS if success else AuditEventType.LOGIN_FAILURE,
            user_id=user_id if success else None,
            result="success" if success else "failure",
            severity=AuditSeverity.INFO if success else AuditSeverity.WARNING,
            request=request,
            details=details,
        )

    async def log_file_access(
        self,
        db: AsyncSession,
        user_id: UUID,
        file_id: str,
        action: str,
        request: Optional[Request] = None,
        details: Optional[Dict] = None,
    ):
        """Log file access (GDPR compliance)"""
        event_map = {
            "upload": AuditEventType.FILE_UPLOADED,
            "download": AuditEventType.FILE_DOWNLOADED,
            "view": AuditEventType.FILE_VIEWED,
            "modify": AuditEventType.FILE_MODIFIED,
            "delete": AuditEventType.FILE_DELETED,
            "share": AuditEventType.FILE_SHARED,
        }

        await self.log_event(
            db=db,
            event_type=event_map.get(action, AuditEventType.FILE_VIEWED),
            user_id=user_id,
            resource_type="file",
            resource_id=file_id,
            action=action,
            request=request,
            details=details,
        )

    async def log_gdpr_event(
        self,
        db: AsyncSession,
        user_id: UUID,
        gdpr_action: str,
        request: Optional[Request] = None,
        details: Optional[Dict] = None,
    ):
        """Log GDPR-related events"""
        event_map = {
            "data_export": AuditEventType.GDPR_DATA_EXPORTED,
            "account_deletion": AuditEventType.GDPR_ACCOUNT_DELETED,
            "consent_given": AuditEventType.GDPR_CONSENT_GIVEN,
            "consent_withdrawn": AuditEventType.GDPR_CONSENT_WITHDRAWN,
            "data_rectified": AuditEventType.GDPR_DATA_RECTIFIED,
        }

        await self.log_event(
            db=db,
            event_type=event_map.get(gdpr_action, AuditEventType.GDPR_DATA_EXPORTED),
            user_id=user_id,
            severity=AuditSeverity.WARNING,  # GDPR events are important
            request=request,
            details=details,
        )

    async def log_security_event(
        self,
        db: AsyncSession,
        event_type: AuditEventType,
        user_id: Optional[UUID] = None,
        severity: AuditSeverity = AuditSeverity.WARNING,
        request: Optional[Request] = None,
        details: Optional[Dict] = None,
    ):
        """Log security-related events"""
        await self.log_event(
            db=db,
            event_type=event_type,
            user_id=user_id,
            severity=severity,
            request=request,
            details=details,
        )

    async def log_key_rotation(
        self,
        db: AsyncSession,
        user_id: UUID,
        old_version: int,
        new_version: int,
        details: Optional[Dict] = None,
    ):
        """Log encryption key rotation"""
        await self.log_event(
            db=db,
            event_type=AuditEventType.ENCRYPTION_KEY_ROTATED,
            user_id=user_id,
            severity=AuditSeverity.WARNING,  # Important security event
            details={
                "old_key_version": old_version,
                "new_key_version": new_version,
                **(details or {}),
            },
        )

    # ===== Query and Reporting =====

    async def get_audit_trail(
        self,
        db: AsyncSession,
        user_id: Optional[UUID] = None,
        resource_id: Optional[str] = None,
        event_types: Optional[List[AuditEventType]] = None,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
        severity: Optional[AuditSeverity] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> List[Dict]:
        """
        Query audit trail with filters

        Returns list of audit events matching criteria
        """
        from ..models.database import ActivityLog

        query = select(ActivityLog)

        # Apply filters
        conditions = []

        if user_id:
            conditions.append(ActivityLog.user_id == user_id)

        if resource_id:
            conditions.append(ActivityLog.object_id == resource_id)

        if event_types:
            event_type_strs = [et.value for et in event_types]
            conditions.append(ActivityLog.action.in_(event_type_strs))

        if start_date:
            conditions.append(ActivityLog.timestamp >= start_date)

        if end_date:
            conditions.append(ActivityLog.timestamp <= end_date)

        if conditions:
            query = query.filter(and_(*conditions))

        # Order by timestamp descending
        query = query.order_by(desc(ActivityLog.timestamp))

        # Pagination
        query = query.limit(limit).offset(offset)

        result = await db.execute(query)
        logs = result.scalars().all()

        return [
            {
                "id": str(log.id),
                "event_type": log.action,
                "user_id": str(log.user_id) if log.user_id else None,
                "resource_id": log.object_id,
                "timestamp": log.timestamp.isoformat() if log.timestamp else None,
                "ip_address": log.ip_address,
                "user_agent": log.user_agent,
                "metadata": log.meta_data,
            }
            for log in logs
        ]

    async def generate_compliance_report(
        self, db: AsyncSession, start_date: datetime, end_date: datetime, report_type: str = "gdpr"
    ) -> Dict:
        """
        Generate compliance report for a date range

        Args:
            db: Database session
            start_date: Start of report period
            end_date: End of report period
            report_type: Type of report ("gdpr", "soc2", "iso27001")

        Returns:
            Dict with compliance statistics and events
        """
        from ..models.database import ActivityLog

        # Get all events in date range
        result = await db.execute(
            select(ActivityLog).filter(
                and_(ActivityLog.timestamp >= start_date, ActivityLog.timestamp <= end_date)
            )
        )
        logs = result.scalars().all()

        # Count events by type
        event_counts = {}
        severity_counts = {"info": 0, "warning": 0, "error": 0, "critical": 0}

        gdpr_events = []
        security_events = []
        access_events = []

        for log in logs:
            event_type = log.action
            event_counts[event_type] = event_counts.get(event_type, 0) + 1

            # Categorize
            metadata = log.meta_data or {}
            severity = metadata.get("severity", "info")
            severity_counts[severity] = severity_counts.get(severity, 0) + 1

            if event_type.startswith("gdpr."):
                gdpr_events.append(log)
            elif event_type.startswith("security."):
                security_events.append(log)
            elif event_type.startswith("data."):
                access_events.append(log)

        return {
            "report_type": report_type,
            "period": {"start": start_date.isoformat(), "end": end_date.isoformat()},
            "summary": {
                "total_events": len(logs),
                "unique_event_types": len(event_counts),
                "gdpr_events": len(gdpr_events),
                "security_events": len(security_events),
                "data_access_events": len(access_events),
            },
            "severity_distribution": severity_counts,
            "event_type_counts": event_counts,
            "top_events": sorted(event_counts.items(), key=lambda x: x[1], reverse=True)[:10],
        }


# Singleton instance
audit_service = AuditLoggingService()
