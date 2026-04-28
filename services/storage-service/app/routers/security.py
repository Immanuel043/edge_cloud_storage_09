"""
Security API Endpoints

Endpoints for security features:
- Virus scanning
- DLP (Data Loss Prevention)
- Audit logs
- Security reports
"""

from datetime import datetime, timedelta
from typing import List, Optional
from uuid import UUID

from app.database import async_session
from app.dependencies import get_current_user, require_admin
from app.models.database import User
from app.services.audit_service import get_audit_service
from app.services.dlp_service import get_dlp_service
from app.services.virus_scanner import get_virus_scanner
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/v1/security", tags=["security"])

audit_service = get_audit_service()


# ============================================================================
# VIRUS SCANNING ENDPOINTS
# ============================================================================


@router.get("/scanner/status")
async def get_scanner_status(current_user: User = Depends(get_current_user)):
    """Get ClamAV scanner status and version"""
    scanner = get_virus_scanner()

    is_available = await scanner.ping()
    version = await scanner.get_version() if is_available else None

    return {"available": is_available, "version": version, "engine": "ClamAV"}


@router.post("/scan/file/{file_id}")
async def scan_file_now(
    file_id: UUID, request: Request, current_user: User = Depends(get_current_user)
):
    """
    Manually trigger virus scan for a file

    This is useful for re-scanning files or scanning files uploaded before
    virus scanning was enabled.
    """
    from app.models.database import Object
    from sqlalchemy import select

    async with async_session() as session:
        # Get file
        result = await session.execute(
            select(Object).where(Object.id == file_id, Object.user_id == current_user.id)
        )
        file_obj = result.scalar_one_or_none()

        if not file_obj:
            raise HTTPException(status_code=404, detail="File not found")

        # Get file path (simplified - adapt to your storage service)
        from app.services.storage_service import get_storage_service

        storage_service = get_storage_service()

        try:
            # Retrieve file data
            file_data = await storage_service.retrieve_file(file_obj, current_user.id)

            # Scan file
            scanner = get_virus_scanner()
            scan_result = await scanner.scan_bytes(file_data)

            # Log scan result
            await audit_service.log_virus_scan(
                file_id=file_id,
                user_id=current_user.id,
                is_infected=scan_result.is_infected,
                virus_name=scan_result.virus_name,
                scan_time=scan_result.scan_time,
                file_size=len(file_data),
                file_hash=file_obj.hash,
                error_message=scan_result.error,
                action_taken="blocked" if scan_result.is_infected else "allowed",
            )

            # Log action
            await audit_service.log_action(
                action="security.virus_scan",
                user_id=current_user.id,
                resource_type="file",
                resource_id=file_id,
                resource_name=file_obj.file_name,
                status="success" if not scan_result.is_infected else "blocked",
                metadata={
                    "is_infected": scan_result.is_infected,
                    "virus_name": scan_result.virus_name,
                    "scan_time": scan_result.scan_time,
                },
                request=request,
                is_suspicious=scan_result.is_infected,
                risk_level="critical" if scan_result.is_infected else "low",
            )

            return {
                "file_id": str(file_id),
                "scan_result": scan_result.to_dict(),
                "action_taken": "blocked" if scan_result.is_infected else "allowed",
            }

        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Scan failed: {str(e)}")


# ============================================================================
# DLP ENDPOINTS
# ============================================================================


@router.post("/dlp/scan/{file_id}")
async def scan_file_dlp(
    file_id: UUID, request: Request, current_user: User = Depends(get_current_user)
):
    """Scan file for sensitive data (DLP)"""
    from app.models.database import Object
    from sqlalchemy import select

    async with async_session() as session:
        # Get file
        result = await session.execute(
            select(Object).where(Object.id == file_id, Object.user_id == current_user.id)
        )
        file_obj = result.scalar_one_or_none()

        if not file_obj:
            raise HTTPException(status_code=404, detail="File not found")

        # Get file data
        from app.services.storage_service import get_storage_service

        storage_service = get_storage_service()

        try:
            file_data = await storage_service.retrieve_file(file_obj, current_user.id)

            # Run DLP scan
            dlp_service = get_dlp_service()
            scan_result = await dlp_service.scan_bytes(file_data, file_obj.file_name)

            # Get detected types
            detected_types = list(set([m.type for m in scan_result.matches]))

            # Log DLP scan
            await audit_service.log_dlp_scan(
                file_id=file_id,
                user_id=current_user.id,
                has_sensitive_data=scan_result.has_sensitive_data,
                risk_score=scan_result.risk_score,
                total_matches=scan_result.total_matches,
                scan_time=scan_result.scan_time,
                detected_types=detected_types,
                file_size=len(file_data),
                action_taken="blocked" if scan_result.blocked else "allowed",
                blocked=scan_result.blocked,
            )

            # Log action
            await audit_service.log_action(
                action="security.dlp_scan",
                user_id=current_user.id,
                resource_type="file",
                resource_id=file_id,
                resource_name=file_obj.file_name,
                status="blocked" if scan_result.blocked else "success",
                metadata={
                    "has_sensitive_data": scan_result.has_sensitive_data,
                    "risk_score": scan_result.risk_score,
                    "detected_types": detected_types,
                },
                request=request,
                is_suspicious=scan_result.risk_score > 50,
                risk_level=(
                    "critical"
                    if scan_result.risk_score > 80
                    else "high" if scan_result.risk_score > 50 else "low"
                ),
            )

            return {"file_id": str(file_id), "dlp_result": scan_result.to_dict()}

        except Exception as e:
            raise HTTPException(status_code=500, detail=f"DLP scan failed: {str(e)}")


# ============================================================================
# AUDIT LOG ENDPOINTS
# ============================================================================


@router.get("/audit/me")
async def get_my_audit_logs(
    limit: int = Query(100, le=1000),
    action: Optional[str] = None,
    current_user: User = Depends(get_current_user),
):
    """Get audit logs for current user"""
    logs = await audit_service.get_user_activity(
        user_id=current_user.id, limit=limit, action_filter=action
    )

    return {
        "total": len(logs),
        "logs": [
            {
                "id": str(log.id),
                "action": log.action,
                "resource_type": log.resource_type,
                "resource_id": str(log.resource_id) if log.resource_id else None,
                "resource_name": log.resource_name,
                "status": log.status,
                "ip_address": log.ip_address,
                "created_at": log.created_at.isoformat(),
                "is_suspicious": log.is_suspicious,
                "risk_level": log.risk_level,
            }
            for log in logs
        ],
    }


@router.get("/audit/suspicious")
async def get_suspicious_activity(
    limit: int = Query(100, le=1000),
    risk_level: Optional[str] = None,
    current_user: User = Depends(require_admin),
):
    """
    Get suspicious activity (admin only)
    """

    logs = await audit_service.get_suspicious_activity(limit=limit, risk_level=risk_level)

    return {
        "total": len(logs),
        "logs": [
            {
                "id": str(log.id),
                "user_id": str(log.user_id) if log.user_id else None,
                "action": log.action,
                "resource_type": log.resource_type,
                "resource_name": log.resource_name,
                "status": log.status,
                "ip_address": log.ip_address,
                "created_at": log.created_at.isoformat(),
                "risk_level": log.risk_level,
                "error_message": log.error_message,
            }
            for log in logs
        ],
    }


@router.get("/audit/infected-files")
async def get_infected_files(
    limit: int = Query(100, le=1000), current_user: User = Depends(require_admin)
):
    """Get all files flagged as infected (admin only)"""

    infected = await audit_service.get_infected_files(limit=limit)

    return {
        "total": len(infected),
        "infected_files": [
            {
                "id": str(log.id),
                "file_id": str(log.file_id),
                "user_id": str(log.user_id),
                "virus_name": log.virus_name,
                "scanned_at": log.scanned_at.isoformat(),
                "action_taken": log.action_taken,
                "file_hash": log.file_hash,
            }
            for log in infected
        ],
    }


@router.get("/audit/high-risk-files")
async def get_high_risk_files(
    min_risk_score: float = Query(70.0, ge=0, le=100),
    limit: int = Query(100, le=1000),
    current_user: User = Depends(require_admin),
):
    """Get files with high DLP risk scores (admin only)"""

    high_risk = await audit_service.get_high_risk_files(min_risk_score=min_risk_score, limit=limit)

    return {
        "total": len(high_risk),
        "high_risk_files": [
            {
                "id": str(log.id),
                "file_id": str(log.file_id),
                "user_id": str(log.user_id),
                "risk_score": log.risk_score,
                "total_matches": log.total_matches,
                "detected_types": log.detected_types,
                "scanned_at": log.scanned_at.isoformat(),
                "blocked": log.blocked,
                "action_taken": log.action_taken,
            }
            for log in high_risk
        ],
    }


# ============================================================================
# SECURITY DASHBOARD
# ============================================================================


@router.get("/dashboard")
async def get_security_dashboard(current_user: User = Depends(get_current_user)):
    """Get security dashboard overview"""
    from app.models.database import AuditLog, DLPScanLog, VirusScanLog
    from sqlalchemy import func, select

    async with async_session() as session:
        # Get stats for current user

        # Total virus scans
        virus_scans_result = await session.execute(
            select(func.count(VirusScanLog.id)).where(VirusScanLog.user_id == current_user.id)
        )
        total_virus_scans = virus_scans_result.scalar() or 0

        # Infected files
        infected_result = await session.execute(
            select(func.count(VirusScanLog.id)).where(
                VirusScanLog.user_id == current_user.id, VirusScanLog.is_infected == True
            )
        )
        infected_count = infected_result.scalar() or 0

        # DLP scans
        dlp_scans_result = await session.execute(
            select(func.count(DLPScanLog.id)).where(DLPScanLog.user_id == current_user.id)
        )
        total_dlp_scans = dlp_scans_result.scalar() or 0

        # High risk files
        high_risk_result = await session.execute(
            select(func.count(DLPScanLog.id)).where(
                DLPScanLog.user_id == current_user.id, DLPScanLog.risk_score >= 70
            )
        )
        high_risk_count = high_risk_result.scalar() or 0

        # Recent suspicious activity
        suspicious_result = await session.execute(
            select(func.count(AuditLog.id)).where(
                AuditLog.user_id == current_user.id,
                AuditLog.is_suspicious == True,
                AuditLog.created_at >= datetime.utcnow() - timedelta(days=7),
            )
        )
        suspicious_count = suspicious_result.scalar() or 0

        return {
            "user_id": str(current_user.id),
            "security_stats": {
                "virus_scans": {
                    "total": total_virus_scans,
                    "infected": infected_count,
                    "clean": total_virus_scans - infected_count,
                },
                "dlp_scans": {
                    "total": total_dlp_scans,
                    "high_risk": high_risk_count,
                    "clean": total_dlp_scans - high_risk_count,
                },
                "suspicious_activity_7d": suspicious_count,
            },
            "scanner_status": {"clamav_available": await get_virus_scanner().ping()},
        }
