"""
Recommendations Router

API endpoints for content-based recommendations:
- Get personalized recommendations
- Get similar files
- Track user interactions
- Submit feedback
- Get trending files
- Get recommendation summary
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc, and_
from typing import List, Optional
from datetime import datetime, timedelta
import logging
from uuid import UUID

from ..dependencies import get_db, get_current_user
from ..models.database import User, Object, Recommendation, UserInteraction
from ..utils.rate_limiter import user_limiter, RateLimitConfig
from ..models.schemas import (
    RecommendationResponse,
    SimilarFileResponse,
    UserInteractionRequest,
    UserInteractionResponse,
    RecommendationFeedbackRequest,
    RecommendationFeedbackResponse,
    TrendingFileResponse,
    PersonalizedRecommendationSummary,
    FileDetailResponse,
    BatchRecommendationRequest,
    BatchRecommendationResponse
)
from ..services.recommendation_engine import recommendation_engine
from ..services.content_similarity_service import content_similarity_service
from ..services.collaborative_filtering_service import collaborative_filtering_service
from ..monitoring.metrics import metrics_collector

router = APIRouter(prefix="/api/v1/recommendations", tags=["recommendations"])
logger = logging.getLogger(__name__)


@router.get("/", response_model=List[RecommendationResponse])
@user_limiter.limit(RateLimitConfig.ML_PREDICTION)
async def get_recommendations(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    file_id: Optional[str] = Query(None, description="Context file ID"),
    algorithm: str = Query("hybrid", description="Algorithm (hybrid, content, collaborative, trending)"),
    limit: int = Query(10, ge=1, le=50, description="Maximum recommendations"),
    min_score: float = Query(0.3, ge=0.0, le=1.0, description="Minimum score threshold"),
    force_refresh: bool = Query(False, description="Force new generation")
):
    """
    Get personalized recommendations for current user

    Returns recommendations based on specified algorithm or hybrid approach.

    Args:
        file_id: Optional file to base recommendations on
        algorithm: Algorithm to use (hybrid, content, collaborative, trending)
        limit: Maximum number of recommendations
        min_score: Minimum recommendation score (0-1)
        force_refresh: Force new generation instead of using cached

    Returns:
        List of RecommendationResponse with ranked recommendations
    """
    try:
        context_file_id = UUID(file_id) if file_id else None

        # Validate context file belongs to user if provided
        if context_file_id:
            result = await db.execute(
                select(Object).where(
                    and_(
                        Object.id == context_file_id,
                        Object.user_id == current_user.id
                    )
                )
            )
            context_file = result.scalar_one_or_none()
            if not context_file:
                raise HTTPException(
                    status_code=404,
                    detail=f"File {file_id} not found"
                )

        # Generate recommendations
        recommendations = await recommendation_engine.generate_recommendations(
            user_id=current_user.id,
            db=db,
            context_file_id=context_file_id,
            algorithm=algorithm,
            limit=limit,
            min_score=min_score,
            force_refresh=force_refresh
        )

        if not recommendations:
            logger.info(f"No recommendations found for user {current_user.id}")
            return []

        # Build response
        response = []
        for rec in recommendations:
            response.append(RecommendationResponse(
                id=str(rec.get('id', '')),  # May not have ID if not from DB
                user_id=str(current_user.id),
                recommended_file=FileDetailResponse(
                    id=str(rec['file_id']),
                    name=rec['file_name'],
                    size=rec['file_size'],
                    mime_type=rec.get('mime_type'),
                    storage_tier=rec['storage_tier'],
                    folder_path=None,  # TODO: Add folder path lookup
                    created_at=rec.get('created_at', datetime.utcnow()),
                    last_accessed=rec.get('last_accessed'),
                    access_count=0  # TODO: Add access count
                ),
                recommendation_type=rec['recommendation_type'],
                recommendation_score=rec['recommendation_score'],
                algorithm=rec['algorithm'],
                reason=rec['reason'],
                context_file_id=str(rec['context_file_id']) if rec.get('context_file_id') else None,
                is_accepted=None,
                is_dismissed=False,
                created_at=datetime.utcnow()
            ))

        logger.info(f"Returned {len(response)} recommendations for user {current_user.id}")
        return response

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get recommendations: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to get recommendations: {str(e)}")


@router.get("/similar/{file_id}", response_model=List[SimilarFileResponse])
async def get_similar_files(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(10, ge=1, le=50),
    min_score: float = Query(0.3, ge=0.0, le=1.0)
):
    """
    Get similar files to a specific file

    Uses content-based similarity (TF-IDF) to find similar files.

    Args:
        file_id: File ID to find similarities for
        limit: Maximum similar files
        min_score: Minimum similarity score

    Returns:
        List of SimilarFileResponse with similar files
    """
    try:
        # Validate file belongs to user
        result = await db.execute(
            select(Object).where(
                and_(
                    Object.id == UUID(file_id),
                    Object.user_id == current_user.id
                )
            )
        )
        file_obj = result.scalar_one_or_none()

        if not file_obj:
            raise HTTPException(status_code=404, detail=f"File {file_id} not found")

        # Get similar files
        similar_files = await content_similarity_service.get_similar_files_by_content(
            file_id=UUID(file_id),
            user_id=current_user.id,
            db=db,
            limit=limit,
            min_score=min_score
        )

        # Build response
        response = []
        for sim in similar_files:
            response.append(SimilarFileResponse(
                file=FileDetailResponse(
                    id=str(sim['file_id']),
                    name=sim['file_name'],
                    size=sim['file_size'],
                    mime_type=sim.get('mime_type'),
                    storage_tier=sim['storage_tier'],
                    folder_path=None,
                    created_at=sim.get('created_at', datetime.utcnow()),
                    last_accessed=sim.get('last_accessed'),
                    access_count=0
                ),
                similarity_score=sim['similarity_score'],
                similarity_type=sim['similarity_type'],
                reason=f"Content similarity: {sim['similarity_score']:.2%}",
                common_keywords=sim.get('common_keywords', [])
            ))

        logger.info(f"Found {len(response)} similar files for {file_id}")
        return response

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get similar files: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to get similar files: {str(e)}")


@router.get("/trending", response_model=List[TrendingFileResponse])
async def get_trending_files(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    time_period_days: int = Query(7, ge=1, le=90, description="Time period in days"),
    limit: int = Query(10, ge=1, le=50)
):
    """
    Get trending files based on recent interactions

    Returns files with highest interaction counts in the specified time period.

    Args:
        time_period_days: Time window for trending calculation (default 7 days)
        limit: Maximum trending files

    Returns:
        List of TrendingFileResponse with trending files
    """
    try:
        trending = await collaborative_filtering_service.get_trending_files(
            user_id=current_user.id,
            db=db,
            time_period_days=time_period_days,
            limit=limit
        )

        # Build response
        response = []
        for trend in trending:
            response.append(TrendingFileResponse(
                file=FileDetailResponse(
                    id=str(trend['file_id']),
                    name=trend['file_name'],
                    size=trend['file_size'],
                    mime_type=trend.get('mime_type'),
                    storage_tier=trend['storage_tier'],
                    folder_path=None,
                    created_at=trend.get('created_at', datetime.utcnow()),
                    last_accessed=trend.get('last_accessed'),
                    access_count=0
                ),
                trending_score=trend['trending_score'],
                interaction_count=trend['interaction_count'],
                unique_users=trend['unique_users'],
                time_period=trend['time_period']
            ))

        logger.info(f"Found {len(response)} trending files")
        return response

    except Exception as e:
        logger.error(f"Failed to get trending files: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to get trending files: {str(e)}")


@router.post("/interactions", response_model=UserInteractionResponse)
async def track_interaction(
    request: UserInteractionRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Track user interaction with a file

    Records interaction for collaborative filtering and trending detection.

    Supported interaction types:
    - view (weight: 1.0)
    - download (weight: 2.0)
    - share (weight: 3.0)
    - favorite (weight: 5.0)
    - tag (weight: 1.5)

    Args:
        request: UserInteractionRequest with file_id and interaction_type

    Returns:
        UserInteractionResponse with interaction details
    """
    try:
        # Validate file exists and belongs to user
        result = await db.execute(
            select(Object).where(
                and_(
                    Object.id == UUID(request.file_id),
                    Object.user_id == current_user.id
                )
            )
        )
        file_obj = result.scalar_one_or_none()

        if not file_obj:
            raise HTTPException(status_code=404, detail=f"File {request.file_id} not found")

        # Track interaction
        interaction = await collaborative_filtering_service.track_interaction(
            user_id=current_user.id,
            file_id=UUID(request.file_id),
            interaction_type=request.interaction_type,
            total_time_spent=request.total_time_spent,
            metadata=request.metadata,
            db=db
        )

        if not interaction:
            raise HTTPException(status_code=500, detail="Failed to track interaction")

        logger.info(
            f"Tracked {request.interaction_type} interaction for user {current_user.id} "
            f"on file {request.file_id}"
        )

        return UserInteractionResponse(**interaction)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to track interaction: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to track interaction: {str(e)}")


@router.post("/feedback", response_model=RecommendationFeedbackResponse)
async def submit_feedback(
    request: RecommendationFeedbackRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Submit feedback on a recommendation

    Helps improve future recommendations through learning.

    Feedback types:
    - positive: User found recommendation helpful
    - negative: User found recommendation unhelpful
    - irrelevant: Recommendation was not relevant

    Args:
        request: RecommendationFeedbackRequest with recommendation_id and feedback

    Returns:
        RecommendationFeedbackResponse with feedback details
    """
    try:
        feedback = await recommendation_engine.submit_feedback(
            recommendation_id=UUID(request.recommendation_id),
            user_id=current_user.id,
            feedback_type=request.feedback_type,
            feedback_score=request.feedback_score,
            feedback_text=request.feedback_text,
            db=db
        )

        if not feedback:
            raise HTTPException(status_code=404, detail="Recommendation not found")

        logger.info(
            f"Feedback submitted for recommendation {request.recommendation_id}: "
            f"{request.feedback_type}"
        )

        return RecommendationFeedbackResponse(**feedback)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to submit feedback: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to submit feedback: {str(e)}")


@router.get("/summary", response_model=PersonalizedRecommendationSummary)
async def get_recommendation_summary(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get recommendation summary for current user

    Returns statistics about recommendations and interactions.

    Returns:
        PersonalizedRecommendationSummary with counts and metrics
    """
    try:
        # Get recommendations
        result = await db.execute(
            select(Recommendation).where(Recommendation.user_id == current_user.id)
        )
        recommendations = result.scalars().all()

        # Count by type and algorithm
        by_type = {}
        by_algorithm = {}
        accepted_count = 0
        dismissed_count = 0
        total_score = 0.0

        for rec in recommendations:
            by_type[rec.recommendation_type] = by_type.get(rec.recommendation_type, 0) + 1
            by_algorithm[rec.algorithm] = by_algorithm.get(rec.algorithm, 0) + 1

            if rec.is_accepted:
                accepted_count += 1
            if rec.is_dismissed:
                dismissed_count += 1

            total_score += rec.recommendation_score

        avg_score = total_score / len(recommendations) if recommendations else 0.0

        # Get last updated
        last_updated = max(
            (r.created_at for r in recommendations),
            default=datetime.utcnow()
        ) if recommendations else datetime.utcnow()

        return PersonalizedRecommendationSummary(
            user_id=str(current_user.id),
            total_recommendations=len(recommendations),
            by_type=by_type,
            by_algorithm=by_algorithm,
            avg_score=avg_score,
            accepted_count=accepted_count,
            dismissed_count=dismissed_count,
            last_updated=last_updated
        )

    except Exception as e:
        logger.error(f"Failed to get recommendation summary: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to get summary: {str(e)}")


@router.post("/batch-generate", response_model=BatchRecommendationResponse)
async def batch_generate_recommendations(
    request: BatchRecommendationRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Batch generate recommendations for multiple files

    Pre-computes similarities and recommendations for specified files.
    Useful for warming cache or generating recommendations in advance.

    Args:
        request: BatchRecommendationRequest with file_ids and options

    Returns:
        BatchRecommendationResponse with job status
    """
    try:
        start_time = datetime.utcnow()

        # Get files to process
        file_ids = None
        if request.file_ids:
            file_ids = [UUID(fid) for fid in request.file_ids]

        # Batch compute content similarities
        similarities_count = await content_similarity_service.batch_compute_similarities(
            user_id=current_user.id,
            db=db,
            file_ids=file_ids
        )

        # Generate recommendations for user
        recommendations = await recommendation_engine.generate_recommendations(
            user_id=current_user.id,
            db=db,
            context_file_id=None,
            algorithm=request.algorithm,
            limit=50,
            min_score=request.min_score,
            force_refresh=request.regenerate
        )

        completed_at = datetime.utcnow()

        logger.info(
            f"Batch generated {similarities_count} similarities and "
            f"{len(recommendations)} recommendations for user {current_user.id}"
        )

        metrics_collector.increment_counter('batch_recommendation_jobs_completed_total')

        return BatchRecommendationResponse(
            job_id=str(current_user.id),  # Using user_id as job_id
            status='completed',
            total_files=len(file_ids) if file_ids else 0,
            processed_files=len(file_ids) if file_ids else 0,
            recommendations_generated=len(recommendations),
            started_at=start_time,
            completed_at=completed_at,
            error=None
        )

    except Exception as e:
        logger.error(f"Failed to batch generate recommendations: {e}", exc_info=True)
        metrics_collector.increment_counter('batch_recommendation_jobs_failed_total')

        return BatchRecommendationResponse(
            job_id=str(current_user.id),
            status='failed',
            total_files=0,
            processed_files=0,
            recommendations_generated=0,
            started_at=start_time,
            completed_at=None,
            error=str(e)
        )


@router.post("/dismiss/{recommendation_id}")
async def dismiss_recommendation(
    recommendation_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Dismiss a recommendation

    Marks recommendation as dismissed so it won't be shown again.

    Args:
        recommendation_id: Recommendation ID to dismiss

    Returns:
        Success message
    """
    try:
        result = await db.execute(
            select(Recommendation).where(
                and_(
                    Recommendation.id == UUID(recommendation_id),
                    Recommendation.user_id == current_user.id
                )
            )
        )
        recommendation = result.scalar_one_or_none()

        if not recommendation:
            raise HTTPException(status_code=404, detail="Recommendation not found")

        recommendation.is_dismissed = True
        recommendation.dismissed_at = datetime.utcnow()
        await db.commit()

        logger.info(f"Dismissed recommendation {recommendation_id} for user {current_user.id}")
        metrics_collector.increment_counter('recommendations_dismissed_total')

        return {"status": "success", "message": "Recommendation dismissed"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to dismiss recommendation: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to dismiss: {str(e)}")
