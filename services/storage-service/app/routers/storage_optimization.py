"""
Storage Optimization Router

API endpoints for storage optimization:
- Get storage analysis
- View optimization suggestions
- Apply suggestions
- Get optimization summary
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc
from typing import List, Optional
from datetime import datetime
import logging

from ..dependencies import get_db, get_current_user
from ..models.database import (
    User, StorageAnalysis, OptimizationSuggestion, OptimizationAction)
from ..utils.rate_limiter_v2 import create_rate_limiter, RateLimitConfig
from ..models.schemas import (
    StorageAnalysisResponse,
    OptimizationSuggestionResponse,
    OptimizationActionRequest,
    OptimizationActionResponse,
    StorageBreakdown,
    OptimizationSummary
)
from ..services.storage_analyzer import storage_analyzer
from ..services.storage_optimizer import storage_optimizer
from ..workers.storage_optimization_worker import storage_optimization_worker
from ..monitoring.metrics import metrics_collector

router = APIRouter(prefix="/api/v1/storage/optimization", tags=["storage-optimization"])
logger = logging.getLogger(__name__)


@router.get("/analysis", response_model=StorageAnalysisResponse, dependencies=[Depends(create_rate_limiter(**RateLimitConfig.ML_ANALYSIS))])
async def get_storage_analysis(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    force_refresh: bool = Query(False, description="Force new analysis")
):
    """
    Get latest storage analysis for current user

    Returns detailed breakdown of storage usage patterns and opportunities.

    Args:
        force_refresh: If True, generate new analysis instead of using cached

    Returns:
        StorageAnalysisResponse with comprehensive metrics
    """
    try:
        # Check for existing analysis (less than 24 hours old)
        if not force_refresh:
            result = await db.execute(
                select(StorageAnalysis)
                .where(StorageAnalysis.user_id == current_user.id)
                .order_by(desc(StorageAnalysis.analysis_date))
                .limit(1)
            )
            existing_analysis = result.scalar_one_or_none()

            if existing_analysis:
                # Check if less than 24 hours old
                age_hours = (datetime.utcnow() - existing_analysis.analysis_date).total_seconds() / 3600
                if age_hours < 24:
                    logger.info(f"Returning cached analysis for user {current_user.id}")
                    metrics_collector.increment_counter('storage_analysis_cache_hits_total')

                    return await _build_analysis_response(existing_analysis)

        # Generate new analysis
        logger.info(f"Generating new storage analysis for user {current_user.id}")
        metrics_collector.increment_counter('storage_analysis_cache_misses_total')

        analysis = await storage_analyzer.analyze_user_storage(
            user_id=current_user.id,
            db=db
        )

        if not analysis:
            raise HTTPException(
                status_code=500,
                detail="Failed to analyze storage"
            )

        # Save analysis
        db.add(analysis)
        await db.commit()
        await db.refresh(analysis)

        # Generate suggestions (async, don't block response)
        suggestions = await storage_optimizer.generate_suggestions(analysis, db)
        for suggestion in suggestions:
            db.add(suggestion)
        await db.commit()

        logger.info(f"Generated storage analysis for user {current_user.id}")
        metrics_collector.increment_counter('storage_analyses_completed_total')

        return await _build_analysis_response(analysis)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get storage analysis: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")


async def _build_analysis_response(analysis: StorageAnalysis) -> StorageAnalysisResponse:
    """Build response object from analysis"""
    total_savings_percent = (
        (analysis.total_potential_savings / analysis.total_size * 100)
        if analysis.total_size > 0 else 0
    )

    return StorageAnalysisResponse(
        id=str(analysis.id),
        user_id=str(analysis.user_id),
        total_files=analysis.total_files,
        total_size=analysis.total_size,
        duplicate_files=analysis.duplicate_files,
        duplicate_size=analysis.duplicate_size,
        tier_distribution={
            'cache': {'files': analysis.cache_files, 'size': analysis.cache_size},
            'warm': {'files': analysis.warm_files, 'size': analysis.warm_size},
            'cold': {'files': analysis.cold_files, 'size': analysis.cold_size}
        },
        avg_access_frequency=analysis.avg_access_frequency,
        never_accessed={
            'files': analysis.files_never_accessed,
            'size': analysis.size_never_accessed
        },
        accessed_once={
            'files': analysis.files_accessed_once,
            'size': analysis.size_accessed_once
        },
        age_breakdown={
            '30d': {'files': analysis.files_older_30d, 'size': analysis.size_older_30d},
            '90d': {'files': analysis.files_older_90d, 'size': analysis.size_older_90d},
            '180d': {'files': analysis.files_older_180d, 'size': analysis.size_older_180d}
        },
        compression_savings={
            'files': analysis.compressible_files,
            'size': analysis.compressible_size,
            'estimated_savings': analysis.estimated_savings_compression
        },
        tiering_savings={
            'files': analysis.files_to_cold,
            'size': analysis.size_to_cold,
            'estimated_savings': analysis.estimated_savings_tiering
        },
        total_potential_savings=analysis.total_potential_savings,
        total_potential_savings_percent=total_savings_percent,
        analysis_date=analysis.analysis_date,
        analysis_duration_ms=analysis.analysis_duration_ms
    )


@router.get("/suggestions", response_model=List[OptimizationSuggestionResponse])
async def get_optimization_suggestions(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    include_dismissed: bool = Query(False, description="Include dismissed suggestions"),
    suggestion_type: Optional[str] = Query(None, description="Filter by type"),
    priority: Optional[str] = Query(None, description="Filter by priority")
):
    """
    Get optimization suggestions for current user

    Returns list of suggestions ordered by priority.

    Args:
        include_dismissed: Include previously dismissed suggestions
        suggestion_type: Filter by type (tier_migration, compression, etc.)
        priority: Filter by priority (low, medium, high, critical)

    Returns:
        List of OptimizationSuggestionResponse
    """
    try:
        query = select(OptimizationSuggestion).where(
            OptimizationSuggestion.user_id == current_user.id,
            OptimizationSuggestion.status == 'pending'
        )

        if not include_dismissed:
            query = query.where(OptimizationSuggestion.is_dismissed == False)

        if suggestion_type:
            query = query.where(OptimizationSuggestion.suggestion_type == suggestion_type)

        if priority:
            query = query.where(OptimizationSuggestion.priority == priority)

        # Order by priority
        priority_order = {'critical': 0, 'high': 1, 'medium': 2, 'low': 3}
        query = query.order_by(OptimizationSuggestion.created_at.desc())

        result = await db.execute(query)
        suggestions = result.scalars().all()

        # Sort by priority
        suggestions = sorted(suggestions, key=lambda s: priority_order.get(s.priority, 999))

        response = [
            OptimizationSuggestionResponse(
                id=str(s.id),
                user_id=str(s.user_id),
                analysis_id=str(s.analysis_id),
                suggestion_type=s.suggestion_type,
                priority=s.priority,
                title=s.title,
                description=s.description,
                files_affected=s.files_affected,
                size_affected=s.size_affected,
                estimated_savings=s.estimated_savings,
                estimated_savings_percent=s.estimated_savings_percent,
                action_type=s.action_type,
                is_auto_applicable=s.is_auto_applicable,
                status=s.status,
                is_dismissed=s.is_dismissed,
                created_at=s.created_at,
                applied_at=s.applied_at
            )
            for s in suggestions
        ]

        logger.info(f"Retrieved {len(response)} optimization suggestions for user {current_user.id}")
        return response

    except Exception as e:
        logger.error(f"Failed to get optimization suggestions: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to retrieve suggestions: {str(e)}")


@router.get("/summary", response_model=OptimizationSummary)
async def get_optimization_summary(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get optimization summary for current user

    Returns summary with breakdowns and total savings potential.

    Returns:
        OptimizationSummary with categorized breakdowns
    """
    try:
        # Get latest analysis
        analysis_result = await db.execute(
            select(StorageAnalysis)
            .where(StorageAnalysis.user_id == current_user.id)
            .order_by(desc(StorageAnalysis.analysis_date))
            .limit(1)
        )
        analysis = analysis_result.scalar_one_or_none()

        if not analysis:
            raise HTTPException(
                status_code=404,
                detail="No analysis found. Run analysis first."
            )

        # Get suggestions summary
        suggestions_summary = await storage_optimizer.get_suggestions_summary(
            user_id=current_user.id,
            db=db
        )

        # Build tier breakdown
        breakdown_by_tier = [
            StorageBreakdown(
                category='cache',
                files=analysis.cache_files,
                size=analysis.cache_size,
                percent=(analysis.cache_size / analysis.total_size * 100) if analysis.total_size > 0 else 0
            ),
            StorageBreakdown(
                category='warm',
                files=analysis.warm_files,
                size=analysis.warm_size,
                percent=(analysis.warm_size / analysis.total_size * 100) if analysis.total_size > 0 else 0
            ),
            StorageBreakdown(
                category='cold',
                files=analysis.cold_files,
                size=analysis.cold_size,
                percent=(analysis.cold_size / analysis.total_size * 100) if analysis.total_size > 0 else 0
            )
        ]

        # Build age breakdown
        breakdown_by_age = [
            StorageBreakdown(
                category='< 30 days',
                files=analysis.total_files - analysis.files_older_30d,
                size=analysis.total_size - analysis.size_older_30d,
                percent=((analysis.total_size - analysis.size_older_30d) / analysis.total_size * 100) if analysis.total_size > 0 else 0
            ),
            StorageBreakdown(
                category='30-90 days',
                files=analysis.files_older_30d - analysis.files_older_90d,
                size=analysis.size_older_30d - analysis.size_older_90d,
                percent=((analysis.size_older_30d - analysis.size_older_90d) / analysis.total_size * 100) if analysis.total_size > 0 else 0
            ),
            StorageBreakdown(
                category='90-180 days',
                files=analysis.files_older_90d - analysis.files_older_180d,
                size=analysis.size_older_90d - analysis.size_older_180d,
                percent=((analysis.size_older_90d - analysis.size_older_180d) / analysis.total_size * 100) if analysis.total_size > 0 else 0
            ),
            StorageBreakdown(
                category='> 180 days',
                files=analysis.files_older_180d,
                size=analysis.size_older_180d,
                percent=(analysis.size_older_180d / analysis.total_size * 100) if analysis.total_size > 0 else 0
            )
        ]

        # Build access breakdown
        breakdown_by_access = [
            StorageBreakdown(
                category='Never accessed',
                files=analysis.files_never_accessed,
                size=analysis.size_never_accessed,
                percent=(analysis.size_never_accessed / analysis.total_size * 100) if analysis.total_size > 0 else 0
            ),
            StorageBreakdown(
                category='Accessed once',
                files=analysis.files_accessed_once,
                size=analysis.size_accessed_once,
                percent=(analysis.size_accessed_once / analysis.total_size * 100) if analysis.total_size > 0 else 0
            ),
            StorageBreakdown(
                category='Accessed multiple times',
                files=analysis.total_files - analysis.files_never_accessed - analysis.files_accessed_once,
                size=analysis.total_size - analysis.size_never_accessed - analysis.size_accessed_once,
                percent=((analysis.total_size - analysis.size_never_accessed - analysis.size_accessed_once) / analysis.total_size * 100) if analysis.total_size > 0 else 0
            )
        ]

        total_savings_percent = (
            (analysis.total_potential_savings / analysis.total_size * 100)
            if analysis.total_size > 0 else 0
        )

        high_priority_count = suggestions_summary['by_priority'].get('high', 0) + suggestions_summary['by_priority'].get('critical', 0)

        return OptimizationSummary(
            user_id=str(current_user.id),
            total_size=analysis.total_size,
            total_files=analysis.total_files,
            breakdown_by_tier=breakdown_by_tier,
            breakdown_by_age=breakdown_by_age,
            breakdown_by_access=breakdown_by_access,
            total_potential_savings=analysis.total_potential_savings,
            total_potential_savings_percent=total_savings_percent,
            suggestion_count=suggestions_summary['total_suggestions'],
            high_priority_count=high_priority_count,
            last_analysis_date=analysis.analysis_date
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get optimization summary: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to retrieve summary: {str(e)}")


@router.post("/suggestions/{suggestion_id}/dismiss")
async def dismiss_suggestion(
    suggestion_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Dismiss an optimization suggestion

    Marks a suggestion as dismissed so it won't be shown again.

    Args:
        suggestion_id: Suggestion ID to dismiss

    Returns:
        Success message
    """
    try:
        result = await db.execute(
            select(OptimizationSuggestion).where(
                OptimizationSuggestion.id == suggestion_id,
                OptimizationSuggestion.user_id == current_user.id
            )
        )
        suggestion = result.scalar_one_or_none()

        if not suggestion:
            raise HTTPException(status_code=404, detail="Suggestion not found")

        suggestion.is_dismissed = True
        suggestion.dismissed_at = datetime.utcnow()
        await db.commit()

        logger.info(f"Dismissed suggestion {suggestion_id} for user {current_user.id}")
        metrics_collector.increment_counter('storage_optimization_suggestions_dismissed_total')

        return {"status": "success", "message": "Suggestion dismissed"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to dismiss suggestion: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to dismiss suggestion: {str(e)}")


@router.post("/trigger-analysis")
async def trigger_analysis(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Manually trigger storage analysis for current user

    Runs analysis immediately instead of waiting for scheduled run.

    Returns:
        Analysis results
    """
    try:
        logger.info(f"Manually triggering storage analysis for user {current_user.id}")

        analysis, suggestions = await storage_optimization_worker.analyze_user(
            user_id=current_user.id,
            db=db
        )

        if not analysis:
            raise HTTPException(status_code=500, detail="Analysis failed")

        metrics_collector.increment_counter('storage_optimization_manual_triggers_total')

        return {
            "status": "success",
            "message": "Storage analysis completed",
            "analysis_id": str(analysis.id),
            "suggestions_generated": len(suggestions)
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to trigger analysis: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")


# Admin endpoints

@router.post("/admin/trigger-worker", tags=["admin"])
async def trigger_optimization_worker(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Manually trigger storage optimization worker (admin only)

    Runs the optimization worker immediately for all users.

    Returns:
        Status message
    """
    # TODO: Add admin check
    # if current_user.user_type != 'admin':
    #     raise HTTPException(status_code=403, detail="Admin access required")

    try:
        logger.info(f"Manually triggering storage optimization worker by user {current_user.id}")

        await storage_optimization_worker.run_once()

        metrics_collector.increment_counter('storage_optimization_worker_manual_triggers_total')

        return {
            "status": "success",
            "message": "Storage optimization worker executed successfully"
        }

    except Exception as e:
        logger.error(f"Failed to trigger storage optimization worker: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Worker execution failed: {str(e)}")
