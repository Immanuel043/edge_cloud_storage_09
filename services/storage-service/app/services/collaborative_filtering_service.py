"""
Collaborative Filtering Service

Provides collaborative filtering recommendations based on user interactions:
- User-based collaborative filtering (users similar to you liked these files)
- Item-based collaborative filtering (users who liked X also liked Y)
- Interaction tracking and weighting

Features:
- CPU-optimized with 32-thread support
- Weighted interaction types (view=1, download=2, share=3, favorite=5)
- Configurable similarity thresholds
- Trending file detection
"""

import logging
import os
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple
from uuid import UUID

import numpy as np
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

# CPU optimization
os.environ["OMP_NUM_THREADS"] = "32"
os.environ["MKL_NUM_THREADS"] = "32"
os.environ["OPENBLAS_NUM_THREADS"] = "32"

import scipy.sparse as sp
from sklearn.metrics.pairwise import cosine_similarity

from ..models.database import FileSimilarity, Object, User, UserInteraction
from ..monitoring.metrics import metrics_collector

logger = logging.getLogger(__name__)


class CollaborativeFilteringService:
    """
    Service for collaborative filtering recommendations

    Implements user-based and item-based collaborative filtering using
    user interaction data (views, downloads, shares, favorites).

    Features:
    - Weighted interaction types
    - User similarity computation
    - Item similarity computation
    - Trending file detection
    """

    # Interaction weights
    INTERACTION_WEIGHTS = {"view": 1.0, "download": 2.0, "share": 3.0, "favorite": 5.0, "tag": 1.5}

    def __init__(self):
        self.min_similarity = 0.3
        self.min_interactions = 3  # Minimum interactions required

    async def track_interaction(
        self,
        user_id: UUID,
        file_id: UUID,
        interaction_type: str,
        db: AsyncSession,
        total_time_spent: Optional[int] = None,
        metadata: Optional[Dict] = None,
    ) -> Dict:
        """
        Track user interaction with a file

        Args:
            user_id: User ID
            file_id: File ID
            interaction_type: Type of interaction (view, download, share, favorite, tag)
            total_time_spent: Time spent in seconds
            metadata: Additional metadata
            db: Database session

        Returns:
            Interaction record
        """
        try:
            weight = self.INTERACTION_WEIGHTS.get(interaction_type.lower(), 1.0)

            # Adjust weight based on time spent
            if total_time_spent and total_time_spent > 0:
                # Increase weight for longer viewing times
                time_multiplier = min(1.0 + (total_time_spent / 300), 2.0)  # Cap at 2x
                weight *= time_multiplier

            interaction = UserInteraction(
                user_id=user_id,
                file_id=file_id,
                interaction_type=interaction_type.lower(),
                interaction_weight=weight,
                total_time_spent=total_time_spent,
                interaction_metadata=metadata,
            )

            db.add(interaction)
            await db.commit()
            await db.refresh(interaction)

            logger.info(
                f"Tracked {interaction_type} interaction for user {user_id} "
                f"on file {file_id} (weight={weight})"
            )

            metrics_collector.increment_counter(
                "user_interactions_tracked_total", labels={"interaction_type": interaction_type}
            )

            return {
                "id": str(interaction.id),
                "file_id": str(file_id),
                "interaction_type": interaction_type,
                "interaction_weight": weight,
                "created_at": interaction.created_at,
            }

        except Exception as e:
            logger.error(f"Failed to track interaction: {e}", exc_info=True)
            await db.rollback()
            metrics_collector.increment_counter("user_interaction_tracking_errors_total")
            return {}

    async def get_user_based_recommendations(
        self, user_id: UUID, db: AsyncSession, limit: int = 10, min_score: float = 0.3
    ) -> List[Dict]:
        """
        Get recommendations based on similar users

        Finds users with similar interaction patterns and recommends files
        they interacted with that the current user hasn't.

        Args:
            user_id: User ID
            db: Database session
            limit: Maximum recommendations
            min_score: Minimum similarity score

        Returns:
            List of recommended files
        """
        start_time = datetime.utcnow()

        try:
            # Get current user's interactions
            result = await db.execute(
                select(UserInteraction).where(UserInteraction.user_id == user_id)
            )
            user_interactions = result.scalars().all()

            if len(user_interactions) < self.min_interactions:
                logger.info(
                    f"User {user_id} has insufficient interactions "
                    f"({len(user_interactions)} < {self.min_interactions})"
                )
                return []

            # Build user interaction matrix
            user_file_scores = defaultdict(float)
            for interaction in user_interactions:
                user_file_scores[str(interaction.file_id)] += interaction.interaction_weight

            # Get all other users' interactions
            result = await db.execute(
                select(UserInteraction).where(UserInteraction.user_id != user_id)
            )
            all_interactions = result.scalars().all()

            # Group by user
            other_users = defaultdict(lambda: defaultdict(float))
            for interaction in all_interactions:
                other_users[str(interaction.user_id)][
                    str(interaction.file_id)
                ] += interaction.interaction_weight

            # Compute user similarity
            similar_users = []
            for other_user_id, other_scores in other_users.items():
                # Compute cosine similarity
                common_files = set(user_file_scores.keys()) & set(other_scores.keys())

                if len(common_files) < 2:  # Need at least 2 common files
                    continue

                # Build vectors
                user_vec = [user_file_scores[f] for f in common_files]
                other_vec = [other_scores[f] for f in common_files]

                # Compute similarity
                similarity = self._cosine_similarity_1d(user_vec, other_vec)

                if similarity >= min_score:
                    similar_users.append(
                        {"user_id": other_user_id, "similarity": similarity, "scores": other_scores}
                    )

            # Sort by similarity
            similar_users.sort(key=lambda x: x["similarity"], reverse=True)

            if not similar_users:
                logger.info(f"No similar users found for user {user_id}")
                return []

            logger.info(f"Found {len(similar_users)} similar users for user {user_id}")

            # Aggregate recommendations from similar users
            recommendations = defaultdict(float)
            for similar_user in similar_users[:10]:  # Top 10 similar users
                for file_id, score in similar_user["scores"].items():
                    # Skip files user already interacted with
                    if file_id in user_file_scores:
                        continue

                    # Weight by user similarity
                    recommendations[file_id] += score * similar_user["similarity"]

            # Get top recommendations
            top_recommendations = sorted(recommendations.items(), key=lambda x: x[1], reverse=True)[
                :limit
            ]

            # Build response
            results = []
            for file_id, score in top_recommendations:
                # Get file details
                result = await db.execute(select(Object).where(Object.id == UUID(file_id)))
                file_obj = result.scalar_one_or_none()

                if not file_obj:
                    continue

                # Normalize score to 0-1
                normalized_score = min(score / 10.0, 1.0)

                results.append(
                    {
                        "file_id": file_obj.id,
                        "file_name": file_obj.object_name,
                        "file_size": file_obj.file_size,
                        "mime_type": file_obj.mime_type,
                        "storage_tier": file_obj.storage_tier,
                        "recommendation_score": normalized_score,
                        "algorithm": "collaborative_user",
                        "reason": f"Users similar to you interacted with this file",
                        "created_at": file_obj.created_at,
                        "last_accessed": file_obj.last_accessed,
                    }
                )

            duration_ms = int((datetime.utcnow() - start_time).total_seconds() * 1000)

            logger.info(
                f"Generated {len(results)} user-based recommendations for user {user_id} "
                f"in {duration_ms}ms"
            )

            metrics_collector.increment_counter(
                "collaborative_user_recommendations_generated_total"
            )
            metrics_collector.observe_histogram("collaborative_filtering_duration_ms", duration_ms)

            return results

        except Exception as e:
            logger.error(f"Failed to generate user-based recommendations: {e}", exc_info=True)
            metrics_collector.increment_counter("collaborative_filtering_errors_total")
            return []

    async def get_item_based_recommendations(
        self,
        file_id: UUID,
        user_id: UUID,
        db: AsyncSession,
        limit: int = 10,
        min_score: float = 0.3,
    ) -> List[Dict]:
        """
        Get item-based recommendations

        Finds files that users who interacted with the given file also interacted with.

        Args:
            file_id: File ID to base recommendations on
            user_id: User ID (to exclude already interacted files)
            db: Database session
            limit: Maximum recommendations
            min_score: Minimum similarity score

        Returns:
            List of recommended files
        """
        start_time = datetime.utcnow()

        try:
            # Get users who interacted with this file
            result = await db.execute(
                select(UserInteraction).where(UserInteraction.file_id == file_id)
            )
            file_interactions = result.scalars().all()

            if not file_interactions:
                logger.info(f"No interactions found for file {file_id}")
                return []

            user_ids = [str(i.user_id) for i in file_interactions]

            # Get all interactions from these users
            result = await db.execute(
                select(UserInteraction).where(
                    and_(
                        UserInteraction.user_id.in_([UUID(uid) for uid in user_ids]),
                        UserInteraction.file_id != file_id,
                    )
                )
            )
            related_interactions = result.scalars().all()

            # Aggregate scores for each file
            file_scores = defaultdict(float)
            file_user_count = defaultdict(set)

            for interaction in related_interactions:
                file_scores[str(interaction.file_id)] += interaction.interaction_weight
                file_user_count[str(interaction.file_id)].add(str(interaction.user_id))

            # Get current user's interactions (to exclude)
            result = await db.execute(
                select(UserInteraction).where(UserInteraction.user_id == user_id)
            )
            user_interactions = result.scalars().all()
            user_file_ids = {str(i.file_id) for i in user_interactions}

            # Rank by score and user count
            recommendations = []
            for fid, score in file_scores.items():
                # Skip if user already interacted
                if fid in user_file_ids:
                    continue

                # Boost score by number of unique users
                unique_users = len(file_user_count[fid])
                boosted_score = score * (1.0 + np.log1p(unique_users) / 10.0)

                recommendations.append(
                    {"file_id": fid, "score": boosted_score, "unique_users": unique_users}
                )

            # Sort and limit
            recommendations.sort(key=lambda x: x["score"], reverse=True)
            recommendations = recommendations[:limit]

            # Build response
            results = []
            for rec in recommendations:
                # Get file details
                result = await db.execute(select(Object).where(Object.id == UUID(rec["file_id"])))
                file_obj = result.scalar_one_or_none()

                if not file_obj:
                    continue

                # Normalize score to 0-1
                normalized_score = min(rec["score"] / 20.0, 1.0)

                if normalized_score < min_score:
                    continue

                results.append(
                    {
                        "file_id": file_obj.id,
                        "file_name": file_obj.object_name,
                        "file_size": file_obj.file_size,
                        "mime_type": file_obj.mime_type,
                        "storage_tier": file_obj.storage_tier,
                        "recommendation_score": normalized_score,
                        "algorithm": "collaborative_item",
                        "reason": f'{rec["unique_users"]} users who viewed similar files also viewed this',
                        "created_at": file_obj.created_at,
                        "last_accessed": file_obj.last_accessed,
                    }
                )

            duration_ms = int((datetime.utcnow() - start_time).total_seconds() * 1000)

            logger.info(
                f"Generated {len(results)} item-based recommendations for file {file_id} "
                f"in {duration_ms}ms"
            )

            metrics_collector.increment_counter(
                "collaborative_item_recommendations_generated_total"
            )
            metrics_collector.observe_histogram("collaborative_filtering_duration_ms", duration_ms)

            return results

        except Exception as e:
            logger.error(f"Failed to generate item-based recommendations: {e}", exc_info=True)
            metrics_collector.increment_counter("collaborative_filtering_errors_total")
            return []

    async def get_trending_files(
        self, user_id: UUID, db: AsyncSession, time_period_days: int = 7, limit: int = 10
    ) -> List[Dict]:
        """
        Get trending files based on recent interactions

        Args:
            user_id: User ID (to ensure access control)
            db: Database session
            time_period_days: Time window for trending calculation
            limit: Maximum results

        Returns:
            List of trending files
        """
        start_time = datetime.utcnow()

        try:
            # Get interactions in time period
            since_date = datetime.utcnow() - timedelta(days=time_period_days)

            result = await db.execute(
                select(UserInteraction).where(UserInteraction.created_at >= since_date)
            )
            interactions = result.scalars().all()

            if not interactions:
                logger.info("No recent interactions for trending calculation")
                return []

            # Aggregate by file
            file_stats = defaultdict(
                lambda: {"total_weight": 0.0, "interaction_count": 0, "unique_users": set()}
            )

            for interaction in interactions:
                file_id = str(interaction.file_id)
                file_stats[file_id]["total_weight"] += interaction.interaction_weight
                file_stats[file_id]["interaction_count"] += 1
                file_stats[file_id]["unique_users"].add(str(interaction.user_id))

            # Calculate trending score
            trending = []
            for file_id, stats in file_stats.items():
                # Trending score = weighted interactions * unique users
                unique_user_count = len(stats["unique_users"])
                trending_score = stats["total_weight"] * np.log1p(unique_user_count)

                trending.append(
                    {
                        "file_id": file_id,
                        "trending_score": trending_score,
                        "interaction_count": stats["interaction_count"],
                        "unique_users": unique_user_count,
                    }
                )

            # Sort and limit
            trending.sort(key=lambda x: x["trending_score"], reverse=True)
            trending = trending[:limit]

            # Build response
            results = []
            for trend in trending:
                # Get file details
                result = await db.execute(select(Object).where(Object.id == UUID(trend["file_id"])))
                file_obj = result.scalar_one_or_none()

                if not file_obj:
                    continue

                # Normalize score
                normalized_score = min(trend["trending_score"] / 50.0, 1.0)

                results.append(
                    {
                        "file_id": file_obj.id,
                        "file_name": file_obj.object_name,
                        "file_size": file_obj.file_size,
                        "mime_type": file_obj.mime_type,
                        "storage_tier": file_obj.storage_tier,
                        "trending_score": normalized_score,
                        "interaction_count": trend["interaction_count"],
                        "unique_users": trend["unique_users"],
                        "time_period": f"{time_period_days} days",
                        "created_at": file_obj.created_at,
                        "last_accessed": file_obj.last_accessed,
                    }
                )

            duration_ms = int((datetime.utcnow() - start_time).total_seconds() * 1000)

            logger.info(f"Found {len(results)} trending files in {duration_ms}ms")

            metrics_collector.increment_counter("trending_files_computed_total")
            metrics_collector.observe_histogram("trending_computation_duration_ms", duration_ms)

            return results

        except Exception as e:
            logger.error(f"Failed to get trending files: {e}", exc_info=True)
            metrics_collector.increment_counter("trending_computation_errors_total")
            return []

    def _cosine_similarity_1d(self, vec1: List[float], vec2: List[float]) -> float:
        """
        Compute cosine similarity between two 1D vectors

        Args:
            vec1: First vector
            vec2: Second vector

        Returns:
            Cosine similarity (0-1)
        """
        if not vec1 or not vec2 or len(vec1) != len(vec2):
            return 0.0

        arr1 = np.array(vec1)
        arr2 = np.array(vec2)

        dot_product = np.dot(arr1, arr2)
        norm1 = np.linalg.norm(arr1)
        norm2 = np.linalg.norm(arr2)

        if norm1 == 0 or norm2 == 0:
            return 0.0

        return float(dot_product / (norm1 * norm2))

    async def get_user_interaction_summary(self, user_id: UUID, db: AsyncSession) -> Dict:
        """
        Get summary of user interactions

        Args:
            user_id: User ID
            db: Database session

        Returns:
            Interaction summary
        """
        try:
            result = await db.execute(
                select(UserInteraction).where(UserInteraction.user_id == user_id)
            )
            interactions = result.scalars().all()

            if not interactions:
                return {
                    "total_interactions": 0,
                    "by_type": {},
                    "unique_files": 0,
                    "total_time_spent": 0,
                }

            by_type = defaultdict(int)
            unique_files = set()
            total_time = 0

            for interaction in interactions:
                by_type[interaction.interaction_type] += 1
                unique_files.add(str(interaction.file_id))
                if interaction.total_time_spent:
                    total_time += interaction.total_time_spent

            return {
                "total_interactions": len(interactions),
                "by_type": dict(by_type),
                "unique_files": len(unique_files),
                "total_time_spent": total_time,
            }

        except Exception as e:
            logger.error(f"Failed to get interaction summary: {e}", exc_info=True)
            return {}


# Singleton instance
collaborative_filtering_service = CollaborativeFilteringService()
