"""
Recommendation Engine

Hybrid recommendation system that combines:
- Content-based filtering (TF-IDF similarity)
- Collaborative filtering (user-based and item-based)
- Trending files
- Personalized recommendations

Features:
- Configurable algorithm weights
- Smart fallback strategies
- Feedback learning
- Batch processing for efficiency
"""

import logging
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Dict, List, Optional
from uuid import UUID, uuid4

import numpy as np
from sqlalchemy import and_, desc, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.database import Object, Recommendation, RecommendationFeedback, UserInteraction
from ..monitoring.metrics import metrics_collector
from .collaborative_filtering_service import collaborative_filtering_service
from .content_similarity_service import content_similarity_service

logger = logging.getLogger(__name__)


class RecommendationEngine:
    """
    Hybrid recommendation engine

    Combines multiple recommendation strategies:
    1. Content-based (TF-IDF similarity)
    2. Collaborative user-based
    3. Collaborative item-based
    4. Trending files

    Features:
    - Adaptive weighting based on data availability
    - Diversity promotion
    - Feedback learning
    """

    # Default algorithm weights
    DEFAULT_WEIGHTS = {
        "content": 0.35,
        "collaborative_user": 0.30,
        "collaborative_item": 0.25,
        "trending": 0.10,
    }

    def __init__(self):
        self.cache_ttl_hours = 24
        self.min_recommendations = 5

    async def generate_recommendations(
        self,
        user_id: UUID,
        db: AsyncSession,
        context_file_id: Optional[UUID] = None,
        algorithm: str = "hybrid",
        limit: int = 10,
        min_score: float = 0.3,
        force_refresh: bool = False,
    ) -> List[Dict]:
        """
        Generate personalized recommendations for a user

        Args:
            user_id: User ID
            db: Database session
            context_file_id: Optional file to base recommendations on
            algorithm: Algorithm to use (hybrid, content, collaborative, trending)
            limit: Maximum recommendations
            min_score: Minimum score threshold
            force_refresh: Force new generation instead of using cached

        Returns:
            List of recommendations
        """
        start_time = datetime.utcnow()

        try:
            # Check for cached recommendations
            if not force_refresh:
                cached = await self._get_cached_recommendations(user_id, db, context_file_id, limit)
                if cached:
                    logger.info(
                        f"Returning {len(cached)} cached recommendations for user {user_id}"
                    )
                    metrics_collector.increment_counter("recommendation_cache_hits_total")
                    return cached

            metrics_collector.increment_counter("recommendation_cache_misses_total")

            # Generate recommendations based on algorithm
            if algorithm == "content" and context_file_id:
                recommendations = await self._generate_content_based(
                    context_file_id, user_id, db, limit, min_score
                )
            elif algorithm == "collaborative":
                recommendations = await self._generate_collaborative(
                    user_id, db, context_file_id, limit, min_score
                )
            elif algorithm == "trending":
                recommendations = await self._generate_trending(user_id, db, limit)
            else:  # hybrid
                recommendations = await self._generate_hybrid(
                    user_id, db, context_file_id, limit, min_score
                )

            # Save recommendations to database
            saved_count = await self._save_recommendations(
                user_id, recommendations, context_file_id, db
            )

            duration_ms = int((datetime.utcnow() - start_time).total_seconds() * 1000)

            logger.info(
                f"Generated {len(recommendations)} recommendations for user {user_id} "
                f"using {algorithm} algorithm in {duration_ms}ms"
            )

            metrics_collector.increment_counter(
                "recommendations_generated_total", labels={"algorithm": algorithm}
            )
            metrics_collector.observe_histogram(
                "recommendation_generation_duration_ms", duration_ms
            )

            return recommendations

        except Exception as e:
            logger.error(f"Failed to generate recommendations: {e}", exc_info=True)
            metrics_collector.increment_counter("recommendation_generation_errors_total")
            return []

    async def _generate_content_based(
        self, file_id: UUID, user_id: UUID, db: AsyncSession, limit: int, min_score: float
    ) -> List[Dict]:
        """Generate content-based recommendations"""
        results = await content_similarity_service.get_similar_files_by_content(
            file_id=file_id, user_id=user_id, db=db, limit=limit, min_score=min_score
        )

        # Convert to recommendation format
        recommendations = []
        for result in results:
            recommendations.append(
                {
                    "file_id": result["file_id"],
                    "file_name": result["file_name"],
                    "file_size": result["file_size"],
                    "mime_type": result["mime_type"],
                    "storage_tier": result["storage_tier"],
                    "recommendation_type": "similar",
                    "recommendation_score": result["similarity_score"],
                    "algorithm": "tfidf",
                    "reason": f"Similar to your file based on content (score: {result['similarity_score']:.2f})",
                    "context_file_id": file_id,
                    "created_at": result.get("created_at"),
                    "last_accessed": result.get("last_accessed"),
                }
            )

        return recommendations

    async def _generate_collaborative(
        self,
        user_id: UUID,
        db: AsyncSession,
        context_file_id: Optional[UUID],
        limit: int,
        min_score: float,
    ) -> List[Dict]:
        """Generate collaborative filtering recommendations"""
        recommendations = []

        # User-based collaborative filtering
        user_based = await collaborative_filtering_service.get_user_based_recommendations(
            user_id=user_id, db=db, limit=limit // 2, min_score=min_score
        )

        recommendations.extend(
            [
                {**rec, "recommendation_type": "collaborative", "context_file_id": context_file_id}
                for rec in user_based
            ]
        )

        # Item-based if context file provided
        if context_file_id:
            item_based = await collaborative_filtering_service.get_item_based_recommendations(
                file_id=context_file_id,
                user_id=user_id,
                db=db,
                limit=limit // 2,
                min_score=min_score,
            )

            recommendations.extend(
                [
                    {
                        **rec,
                        "recommendation_type": "collaborative",
                        "context_file_id": context_file_id,
                    }
                    for rec in item_based
                ]
            )

        # Deduplicate and sort
        seen = set()
        unique_recommendations = []
        for rec in recommendations:
            file_id = str(rec["file_id"])
            if file_id not in seen:
                seen.add(file_id)
                unique_recommendations.append(rec)

        unique_recommendations.sort(key=lambda x: x["recommendation_score"], reverse=True)

        return unique_recommendations[:limit]

    async def _generate_trending(self, user_id: UUID, db: AsyncSession, limit: int) -> List[Dict]:
        """Generate trending file recommendations"""
        trending = await collaborative_filtering_service.get_trending_files(
            user_id=user_id, db=db, time_period_days=7, limit=limit
        )

        recommendations = []
        for trend in trending:
            recommendations.append(
                {
                    "file_id": trend["file_id"],
                    "file_name": trend["file_name"],
                    "file_size": trend["file_size"],
                    "mime_type": trend["mime_type"],
                    "storage_tier": trend["storage_tier"],
                    "recommendation_type": "trending",
                    "recommendation_score": trend["trending_score"],
                    "algorithm": "trending",
                    "reason": f"Trending: {trend['unique_users']} users, {trend['interaction_count']} interactions",
                    "context_file_id": None,
                    "created_at": trend.get("created_at"),
                    "last_accessed": trend.get("last_accessed"),
                }
            )

        return recommendations

    async def _generate_hybrid(
        self,
        user_id: UUID,
        db: AsyncSession,
        context_file_id: Optional[UUID],
        limit: int,
        min_score: float,
    ) -> List[Dict]:
        """
        Generate hybrid recommendations combining multiple algorithms

        Weights are adapted based on data availability.
        """
        all_recommendations = defaultdict(lambda: {"scores": {}, "data": None})

        weights = self.DEFAULT_WEIGHTS.copy()

        # Content-based (if context file provided)
        if context_file_id:
            content_recs = await self._generate_content_based(
                file_id=context_file_id,
                user_id=user_id,
                db=db,
                limit=limit * 2,
                min_score=min_score,
            )

            for rec in content_recs:
                file_id = str(rec["file_id"])
                all_recommendations[file_id]["scores"]["content"] = rec["recommendation_score"]
                all_recommendations[file_id]["data"] = rec

            logger.info(f"Content-based: {len(content_recs)} recommendations")
        else:
            # Reduce content weight if no context
            weights["content"] = 0.0
            # Redistribute to other algorithms
            weights["collaborative_user"] += 0.175
            weights["collaborative_item"] += 0.175

        # User-based collaborative filtering
        user_collab = await collaborative_filtering_service.get_user_based_recommendations(
            user_id=user_id, db=db, limit=limit * 2, min_score=min_score
        )

        for rec in user_collab:
            file_id = str(rec["file_id"])
            all_recommendations[file_id]["scores"]["collaborative_user"] = rec[
                "recommendation_score"
            ]
            if not all_recommendations[file_id]["data"]:
                all_recommendations[file_id]["data"] = {
                    **rec,
                    "recommendation_type": "personalized",
                }

        logger.info(f"User collaborative: {len(user_collab)} recommendations")

        # Item-based collaborative filtering (if context provided)
        if context_file_id:
            item_collab = await collaborative_filtering_service.get_item_based_recommendations(
                file_id=context_file_id,
                user_id=user_id,
                db=db,
                limit=limit * 2,
                min_score=min_score,
            )

            for rec in item_collab:
                file_id = str(rec["file_id"])
                all_recommendations[file_id]["scores"]["collaborative_item"] = rec[
                    "recommendation_score"
                ]
                if not all_recommendations[file_id]["data"]:
                    all_recommendations[file_id]["data"] = {
                        **rec,
                        "recommendation_type": "personalized",
                    }

            logger.info(f"Item collaborative: {len(item_collab)} recommendations")
        else:
            weights["collaborative_item"] = 0.0

        # Trending files
        trending = await self._generate_trending(user_id=user_id, db=db, limit=limit)

        for rec in trending:
            file_id = str(rec["file_id"])
            all_recommendations[file_id]["scores"]["trending"] = rec["recommendation_score"]
            if not all_recommendations[file_id]["data"]:
                all_recommendations[file_id]["data"] = rec

        logger.info(f"Trending: {len(trending)} recommendations")

        # Normalize weights
        total_weight = sum(weights.values())
        if total_weight > 0:
            weights = {k: v / total_weight for k, v in weights.items()}

        # Compute hybrid scores
        hybrid_recommendations = []
        for file_id, data in all_recommendations.items():
            # Compute weighted score
            hybrid_score = 0.0
            algorithm_contributions = []

            for algo, weight in weights.items():
                if algo in data["scores"]:
                    contribution = data["scores"][algo] * weight
                    hybrid_score += contribution
                    algorithm_contributions.append(f"{algo}: {contribution:.2f}")

            # Only include if above threshold
            if hybrid_score < min_score:
                continue

            rec_data = data["data"]
            rec_data["recommendation_score"] = hybrid_score
            rec_data["algorithm"] = "hybrid"
            rec_data["recommendation_type"] = "personalized"
            rec_data["reason"] = (
                f"Personalized recommendation (hybrid score: {hybrid_score:.2f}) - "
                f"{', '.join(algorithm_contributions[:2])}"
            )
            rec_data["context_file_id"] = context_file_id

            hybrid_recommendations.append(rec_data)

        # Sort by score and promote diversity
        hybrid_recommendations = self._promote_diversity(hybrid_recommendations)

        # Limit results
        final_recommendations = hybrid_recommendations[:limit]

        logger.info(
            f"Hybrid: Combined {len(all_recommendations)} candidates into "
            f"{len(final_recommendations)} final recommendations"
        )

        return final_recommendations

    def _promote_diversity(self, recommendations: List[Dict]) -> List[Dict]:
        """
        Promote diversity in recommendations

        Ensures variety in file types and prevents clustering of similar files.

        Args:
            recommendations: List of recommendations

        Returns:
            Diversified list
        """
        if not recommendations:
            return []

        # Sort by score first
        recommendations.sort(key=lambda x: x["recommendation_score"], reverse=True)

        # Promote diversity by file type
        diversified = []
        seen_types = defaultdict(int)
        max_per_type = max(3, len(recommendations) // 4)  # Max 25% per type

        # First pass: add highest scoring diverse items
        for rec in recommendations:
            file_type = rec.get("mime_type", "unknown").split("/")[0]

            if seen_types[file_type] < max_per_type:
                diversified.append(rec)
                seen_types[file_type] += 1

        # Second pass: add remaining items if we need more
        if len(diversified) < len(recommendations):
            for rec in recommendations:
                if rec not in diversified:
                    diversified.append(rec)

        return diversified

    async def _save_recommendations(
        self,
        user_id: UUID,
        recommendations: List[Dict],
        context_file_id: Optional[UUID],
        db: AsyncSession,
    ) -> int:
        """
        Save recommendations to database

        Args:
            user_id: User ID
            recommendations: List of recommendations
            context_file_id: Context file (if any)
            db: Database session

        Returns:
            Number of recommendations saved
        """
        saved_count = 0

        try:
            for rec in recommendations:
                recommendation = Recommendation(
                    user_id=user_id,
                    file_id=rec["file_id"],
                    context_file_id=context_file_id,
                    recommendation_type=rec["recommendation_type"],
                    recommendation_score=rec["recommendation_score"],
                    algorithm=rec["algorithm"],
                    reason=rec["reason"],
                )

                db.add(recommendation)
                saved_count += 1

            await db.commit()

            logger.info(f"Saved {saved_count} recommendations to database")

        except Exception as e:
            logger.error(f"Failed to save recommendations: {e}", exc_info=True)
            await db.rollback()

        return saved_count

    async def _get_cached_recommendations(
        self, user_id: UUID, db: AsyncSession, context_file_id: Optional[UUID], limit: int
    ) -> Optional[List[Dict]]:
        """
        Get cached recommendations

        Args:
            user_id: User ID
            db: Database session
            context_file_id: Context file
            limit: Number of results

        Returns:
            Cached recommendations or None
        """
        try:
            # Check for recent recommendations
            cutoff_time = datetime.utcnow() - timedelta(hours=self.cache_ttl_hours)

            query = select(Recommendation).where(
                and_(
                    Recommendation.user_id == user_id,
                    Recommendation.created_at >= cutoff_time,
                    Recommendation.is_dismissed == False,
                )
            )

            if context_file_id:
                query = query.where(Recommendation.context_file_id == context_file_id)

            query = query.order_by(desc(Recommendation.recommendation_score)).limit(limit)

            result = await db.execute(query)
            cached = result.scalars().all()

            if len(cached) < self.min_recommendations:
                return None

            # Build response
            recommendations = []
            for rec in cached:
                # Get file details
                result = await db.execute(select(Object).where(Object.id == rec.file_id))
                file_obj = result.scalar_one_or_none()

                if not file_obj:
                    continue

                recommendations.append(
                    {
                        "file_id": file_obj.id,
                        "file_name": file_obj.object_name,
                        "file_size": file_obj.file_size,
                        "mime_type": file_obj.mime_type,
                        "storage_tier": file_obj.storage_tier,
                        "recommendation_type": rec.recommendation_type,
                        "recommendation_score": rec.recommendation_score,
                        "algorithm": rec.algorithm,
                        "reason": rec.reason,
                        "context_file_id": rec.context_file_id,
                        "created_at": file_obj.created_at,
                        "last_accessed": file_obj.last_accessed,
                    }
                )

            return recommendations

        except Exception as e:
            logger.error(f"Failed to get cached recommendations: {e}", exc_info=True)
            return None

    async def submit_feedback(
        self,
        recommendation_id: UUID,
        user_id: UUID,
        feedback_type: str,
        feedback_score: Optional[int],
        feedback_text: Optional[str],
        db: AsyncSession,
    ) -> Dict:
        """
        Submit feedback on a recommendation

        Args:
            recommendation_id: Recommendation ID
            user_id: User ID
            feedback_type: Type (positive, negative, irrelevant)
            feedback_score: 1-5 rating
            feedback_text: Optional comment
            db: Database session

        Returns:
            Feedback record
        """
        try:
            # Verify recommendation belongs to user
            result = await db.execute(
                select(Recommendation).where(
                    and_(Recommendation.id == recommendation_id, Recommendation.user_id == user_id)
                )
            )
            recommendation = result.scalar_one_or_none()

            if not recommendation:
                logger.warning(f"Recommendation {recommendation_id} not found for user {user_id}")
                return {}

            # Update recommendation status
            if feedback_type == "positive":
                recommendation.is_accepted = True
            elif feedback_type == "negative":
                recommendation.is_dismissed = True

            # Create feedback
            feedback = RecommendationFeedback(
                recommendation_id=recommendation_id,
                user_id=user_id,
                feedback_type=feedback_type,
                feedback_score=feedback_score,
                feedback_text=feedback_text,
            )

            db.add(feedback)
            await db.commit()
            await db.refresh(feedback)

            logger.info(
                f"Feedback submitted for recommendation {recommendation_id}: {feedback_type}"
            )

            metrics_collector.increment_counter(
                "recommendation_feedback_submitted_total", labels={"feedback_type": feedback_type}
            )

            return {
                "id": str(feedback.id),
                "recommendation_id": str(recommendation_id),
                "feedback_type": feedback_type,
                "feedback_score": feedback_score,
                "created_at": feedback.created_at,
            }

        except Exception as e:
            logger.error(f"Failed to submit feedback: {e}", exc_info=True)
            await db.rollback()
            metrics_collector.increment_counter("recommendation_feedback_errors_total")
            return {}


# Singleton instance
recommendation_engine = RecommendationEngine()
