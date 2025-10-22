# services/storage-service/app/routers/audit.py

"""
Audit Logging API Endpoints

Provides access to audit logs for security monitoring and compliance.

Features:
- Query audit logs with filters
- Generate compliance reports
- View security alerts
- Export audit data
- Real-time audit trail
"""

import logging
from typing import Optional, List
from datetime import datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, desc, func
from pydantic import BaseModel

from ..dependencies import get_db, get_current_user
from ..models.database import User, AuditLog, SecurityAlert, ComplianceReport
from ..services.audit_logging_service import audit_service, AuditEventType, AuditSeverity
from ..utils.rate_limiter_v2 import create_rate_limiter, RateLimitConfig
import io
import json
import csv

router = APIRouter(prefix="/api/v1/audit", tags=["audit"])
logger = logging.getLogger(__name__)


# ===== Request/Response Models =====

class AuditLogQuery(BaseModel):
    """Query parameters for audit log search"""
    user_id: Optional[str] = None
    resource_id: Optional[str] = None
    event_type: Optional[str] = None
    event_category: Optional[str] = None
    severity: Optional[str] = None
    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None
    limit: int = 100
    offset: int = 0


class AuditLogResponse(BaseModel):
    """Audit log entry response"""
    id: str
    event_type: str
    event_category: Optional[str]
    user_id: Optional[str]
    resource_type: Optional[str]
    resource_id: Optional[str]
    action: Optional[str]
    result: str
    severity: str
    ip_address: Optional[str]
    timestamp: str
    details: Optional[dict]


class ComplianceReportRequest(BaseModel):
    """Request for compliance report generation"""
    report_type: str  # gdpr, soc2, iso27001
    start_date: datetime
    end_date: datetime


# ===== Endpoints =====

@router.post("/logs/query", dependencies=[Depends(create_rate_limiter(**RateLimitConfig.API_READ))])
async def query_audit_logs(
    request: Request,
    query: AuditLogQuery,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Query audit logs with filters

    Returns paginated list of audit events matching the query.
    Restricted to user's own logs unless admin.
    """
    # Build query
    conditions = []

    # Non-admin users can only see their own logs
    if not getattr(current_user, 'is_admin', False):
        conditions.append(AuditLog.user_id == current_user.id)
    elif query.user_id:
        conditions.append(AuditLog.user_id == UUID(query.user_id))

    if query.resource_id:
        conditions.append(AuditLog.resource_id == query.resource_id)

    if query.event_type:
        conditions.append(AuditLog.event_type == query.event_type)

    if query.event_category:
        conditions.append(AuditLog.event_category == query.event_category)

    if query.severity:
        conditions.append(AuditLog.severity == query.severity)

    if query.start_date:
        conditions.append(AuditLog.timestamp >= query.start_date)

    if query.end_date:
        conditions.append(AuditLog.timestamp <= query.end_date)

    # Execute query
    stmt = select(AuditLog)
    if conditions:
        stmt = stmt.filter(and_(*conditions))

    stmt = stmt.order_by(desc(AuditLog.timestamp))
    stmt = stmt.limit(query.limit).offset(query.offset)

    result = await db.execute(stmt)
    logs = result.scalars().all()

    # Count total matching
    count_stmt = select(func.count(AuditLog.id))
    if conditions:
        count_stmt = count_stmt.filter(and_(*conditions))
    count_result = await db.execute(count_stmt)
    total = count_result.scalar() or 0

    return {
        "total": total,
        "limit": query.limit,
        "offset": query.offset,
        "results": [
            {
                "id": str(log.id),
                "event_type": log.event_type,
                "event_category": log.event_category,
                "user_id": str(log.user_id) if log.user_id else None,
                "resource_type": log.resource_type,
                "resource_id": log.resource_id,
                "action": log.action,
                "result": log.result,
                "severity": log.severity,
                "ip_address": log.ip_address,
                "timestamp": log.timestamp.isoformat() if log.timestamp else None,
                "details": log.details
            }
            for log in logs
        ]
    }


@router.get("/logs/recent", dependencies=[Depends(create_rate_limiter(**RateLimitConfig.API_READ))])
async def get_recent_audit_logs(
    request: Request,
    limit: int = Query(50, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get recent audit logs for current user

    Returns the most recent audit events.
    """
    result = await db.execute(
        select(AuditLog)
        .filter(AuditLog.user_id == current_user.id)
        .order_by(desc(AuditLog.timestamp))
        .limit(limit)
    )
    logs = result.scalars().all()

    return {
        "count": len(logs),
        "logs": [
            {
                "id": str(log.id),
                "event_type": log.event_type,
                "resource_type": log.resource_type,
                "resource_id": log.resource_id,
                "result": log.result,
                "severity": log.severity,
                "timestamp": log.timestamp.isoformat() if log.timestamp else None
            }
            for log in logs
        ]
    }


@router.get("/logs/stats", dependencies=[Depends(create_rate_limiter(**RateLimitConfig.API_READ))])
async def get_audit_statistics(
    request: Request,
    days: int = Query(30, ge=1, le=365),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get audit log statistics for current user

    Returns summary statistics for the specified time period.
    """
    start_date = datetime.utcnow() - timedelta(days=days)

    # Count events by type
    result = await db.execute(
        select(
            AuditLog.event_category,
            func.count(AuditLog.id).label('count')
        )
        .filter(
            and_(
                AuditLog.user_id == current_user.id,
                AuditLog.timestamp >= start_date
            )
        )
        .group_by(AuditLog.event_category)
    )
    category_counts = {row.event_category: row.count for row in result.fetchall()}

    # Count by severity
    result = await db.execute(
        select(
            AuditLog.severity,
            func.count(AuditLog.id).label('count')
        )
        .filter(
            and_(
                AuditLog.user_id == current_user.id,
                AuditLog.timestamp >= start_date
            )
        )
        .group_by(AuditLog.severity)
    )
    severity_counts = {row.severity: row.count for row in result.fetchall()}

    # Total count
    result = await db.execute(
        select(func.count(AuditLog.id))
        .filter(
            and_(
                AuditLog.user_id == current_user.id,
                AuditLog.timestamp >= start_date
            )
        )
    )
    total_events = result.scalar() or 0

    return {
        "period_days": days,
        "total_events": total_events,
        "by_category": category_counts,
        "by_severity": severity_counts,
        "start_date": start_date.isoformat(),
        "end_date": datetime.utcnow().isoformat()
    }


@router.post("/logs/export", dependencies=[Depends(create_rate_limiter(**RateLimitConfig.API_HEAVY))])
async def export_audit_logs(
    request: Request,
    query: AuditLogQuery,
    format: str = Query("json", regex="^(json|csv)$"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Export audit logs to JSON or CSV

    Downloads audit logs matching the query in the specified format.
    """
    # Build query (same as query_audit_logs)
    conditions = []

    if not getattr(current_user, 'is_admin', False):
        conditions.append(AuditLog.user_id == current_user.id)
    elif query.user_id:
        conditions.append(AuditLog.user_id == UUID(query.user_id))

    if query.resource_id:
        conditions.append(AuditLog.resource_id == query.resource_id)

    if query.event_type:
        conditions.append(AuditLog.event_type == query.event_type)

    if query.start_date:
        conditions.append(AuditLog.timestamp >= query.start_date)

    if query.end_date:
        conditions.append(AuditLog.timestamp <= query.end_date)

    # Execute query (no limit for export)
    stmt = select(AuditLog)
    if conditions:
        stmt = stmt.filter(and_(*conditions))
    stmt = stmt.order_by(desc(AuditLog.timestamp))

    result = await db.execute(stmt)
    logs = result.scalars().all()

    # Export based on format
    if format == "json":
        # JSON export
        data = [
            {
                "id": str(log.id),
                "event_type": log.event_type,
                "event_category": log.event_category,
                "user_id": str(log.user_id) if log.user_id else None,
                "resource_type": log.resource_type,
                "resource_id": log.resource_id,
                "action": log.action,
                "result": log.result,
                "severity": log.severity,
                "ip_address": log.ip_address,
                "user_agent": log.user_agent,
                "timestamp": log.timestamp.isoformat() if log.timestamp else None,
                "details": log.details
            }
            for log in logs
        ]

        buffer = io.BytesIO()
        buffer.write(json.dumps(data, indent=2).encode())
        buffer.seek(0)

        return StreamingResponse(
            buffer,
            media_type="application/json",
            headers={
                "Content-Disposition": f"attachment; filename=audit_logs_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.json"
            }
        )

    else:  # CSV
        buffer = io.StringIO()
        writer = csv.DictWriter(buffer, fieldnames=[
            'id', 'timestamp', 'event_type', 'event_category', 'user_id',
            'resource_type', 'resource_id', 'action', 'result', 'severity',
            'ip_address'
        ])

        writer.writeheader()
        for log in logs:
            writer.writerow({
                'id': str(log.id),
                'timestamp': log.timestamp.isoformat() if log.timestamp else '',
                'event_type': log.event_type,
                'event_category': log.event_category or '',
                'user_id': str(log.user_id) if log.user_id else '',
                'resource_type': log.resource_type or '',
                'resource_id': log.resource_id or '',
                'action': log.action or '',
                'result': log.result,
                'severity': log.severity,
                'ip_address': log.ip_address or ''
            })

        csv_buffer = io.BytesIO(buffer.getvalue().encode())
        csv_buffer.seek(0)

        return StreamingResponse(
            csv_buffer,
            media_type="text/csv",
            headers={
                "Content-Disposition": f"attachment; filename=audit_logs_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.csv"
            }
        )


@router.get("/security/alerts", dependencies=[Depends(create_rate_limiter(**RateLimitConfig.API_READ))])
async def get_security_alerts(
    request: Request,
    status: Optional[str] = Query(None, regex="^(open|investigating|resolved|false_positive)$"),
    severity: Optional[str] = Query(None, regex="^(low|medium|high|critical)$"),
    limit: int = Query(50, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get security alerts

    Returns list of security alerts. Admin users see all, regular users see their own.
    """
    conditions = []

    # Non-admin users only see their own alerts
    if not getattr(current_user, 'is_admin', False):
        conditions.append(SecurityAlert.user_id == current_user.id)

    if status:
        conditions.append(SecurityAlert.status == status)

    if severity:
        conditions.append(SecurityAlert.severity == severity)

    stmt = select(SecurityAlert)
    if conditions:
        stmt = stmt.filter(and_(*conditions))

    stmt = stmt.order_by(desc(SecurityAlert.detected_at)).limit(limit)

    result = await db.execute(stmt)
    alerts = result.scalars().all()

    return {
        "count": len(alerts),
        "alerts": [
            {
                "id": str(alert.id),
                "alert_type": alert.alert_type,
                "severity": alert.severity,
                "status": alert.status,
                "title": alert.title,
                "risk_score": alert.risk_score,
                "detected_at": alert.detected_at.isoformat() if alert.detected_at else None,
                "resolved_at": alert.resolved_at.isoformat() if alert.resolved_at else None
            }
            for alert in alerts
        ]
    }


@router.post("/compliance/report", dependencies=[Depends(create_rate_limiter(**RateLimitConfig.API_HEAVY))])
async def generate_compliance_report(
    request: Request,
    report_request: ComplianceReportRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Generate compliance report

    Creates a compliance report for the specified period.
    Only admins can generate compliance reports.
    """
    # Check admin permission
    if not getattr(current_user, 'is_admin', False):
        raise HTTPException(
            status_code=403,
            detail="Only administrators can generate compliance reports"
        )

    # Generate report using audit service
    report_data = await audit_service.generate_compliance_report(
        db=db,
        start_date=report_request.start_date,
        end_date=report_request.end_date,
        report_type=report_request.report_type
    )

    # Store report in database
    compliance_report = ComplianceReport(
        id=uuid4(),
        report_type=report_request.report_type,
        report_period_start=report_request.start_date,
        report_period_end=report_request.end_date,
        generated_by_user_id=current_user.id,
        status="finalized",
        summary=report_data.get("summary"),
        event_count=report_data.get("summary", {}).get("total_events", 0),
        compliance_score=95.0,  # Calculate based on findings
        metadata=report_data
    )

    db.add(compliance_report)
    await db.commit()
    await db.refresh(compliance_report)

    return {
        "report_id": str(compliance_report.id),
        "report_type": compliance_report.report_type,
        "period": {
            "start": compliance_report.report_period_start.isoformat(),
            "end": compliance_report.report_period_end.isoformat()
        },
        "summary": compliance_report.summary,
        "compliance_score": compliance_report.compliance_score,
        "generated_at": compliance_report.generated_at.isoformat() if compliance_report.generated_at else None
    }


@router.get("/compliance/reports", dependencies=[Depends(create_rate_limiter(**RateLimitConfig.API_READ))])
async def list_compliance_reports(
    request: Request,
    limit: int = Query(20, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    List compliance reports

    Returns list of previously generated compliance reports.
    Only admins can view compliance reports.
    """
    # Check admin permission
    if not getattr(current_user, 'is_admin', False):
        raise HTTPException(
            status_code=403,
            detail="Only administrators can view compliance reports"
        )

    result = await db.execute(
        select(ComplianceReport)
        .order_by(desc(ComplianceReport.generated_at))
        .limit(limit)
    )
    reports = result.scalars().all()

    return {
        "count": len(reports),
        "reports": [
            {
                "id": str(report.id),
                "report_type": report.report_type,
                "period_start": report.report_period_start.isoformat() if report.report_period_start else None,
                "period_end": report.report_period_end.isoformat() if report.report_period_end else None,
                "event_count": report.event_count,
                "compliance_score": report.compliance_score,
                "generated_at": report.generated_at.isoformat() if report.generated_at else None,
                "status": report.status
            }
            for report in reports
        ]
    }
