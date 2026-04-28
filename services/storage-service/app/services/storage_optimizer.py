"""
Storage Optimizer Service

Generates intelligent optimization suggestions based on storage analysis:
- Tier migration recommendations
- Deduplication opportunities
- Compression suggestions
- Cleanup recommendations
"""

import logging
from datetime import datetime
from typing import Dict, List, Optional
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..models.database import OptimizationSuggestion, StorageAnalysis, User
from .storage_analyzer import storage_analyzer

logger = logging.getLogger(__name__)


class StorageOptimizerService:
    """
    Generates optimization suggestions based on storage analysis
    """

    # Minimum savings threshold (from config)
    MIN_SAVINGS_THRESHOLD = settings.STORAGE_OPT_MIN_SAVINGS_THRESHOLD

    # Priority thresholds
    PRIORITY_CRITICAL = 0.30  # >30% potential savings
    PRIORITY_HIGH = 0.15  # >15% potential savings
    PRIORITY_MEDIUM = 0.05  # >5% potential savings

    def __init__(self):
        pass

    async def generate_suggestions(
        self, analysis: StorageAnalysis, db: AsyncSession
    ) -> List[OptimizationSuggestion]:
        """
        Generate optimization suggestions based on analysis

        Args:
            analysis: StorageAnalysis object
            db: Database session

        Returns:
            List of OptimizationSuggestion objects
        """
        suggestions = []

        try:
            logger.info(f"Generating optimization suggestions for user {analysis.user_id}")

            # Generate tier migration suggestions
            tier_suggestions = await self._generate_tier_migration_suggestions(analysis, db)
            suggestions.extend(tier_suggestions)

            # Generate compression suggestions
            compression_suggestions = await self._generate_compression_suggestions(analysis, db)
            suggestions.extend(compression_suggestions)

            # Generate deduplication suggestions
            dedup_suggestions = await self._generate_deduplication_suggestions(analysis, db)
            suggestions.extend(dedup_suggestions)

            # Generate cleanup suggestions
            cleanup_suggestions = await self._generate_cleanup_suggestions(analysis, db)
            suggestions.extend(cleanup_suggestions)

            logger.info(
                f"Generated {len(suggestions)} optimization suggestions "
                f"for user {analysis.user_id}"
            )

            return suggestions

        except Exception as e:
            logger.error(
                f"Failed to generate suggestions for analysis {analysis.id}: {e}", exc_info=True
            )
            return []

    async def _generate_tier_migration_suggestions(
        self, analysis: StorageAnalysis, db: AsyncSession
    ) -> List[OptimizationSuggestion]:
        """Generate suggestions for moving files to cold storage"""
        suggestions = []

        if analysis.files_to_cold == 0 or analysis.size_to_cold == 0:
            return suggestions

        # Check if savings meet threshold
        if analysis.estimated_savings_tiering < self.MIN_SAVINGS_THRESHOLD:
            return suggestions

        # Calculate priority
        savings_percent = (
            (analysis.estimated_savings_tiering / analysis.total_size)
            if analysis.total_size > 0
            else 0
        )
        priority = self._calculate_priority(savings_percent)

        # Get specific file candidates (scored)
        scored_candidates = await storage_analyzer.get_file_candidates_for_cold_storage(
            user_id=analysis.user_id, db=db, limit=100
        )

        # Determine scoring method for description
        scoring_method = (
            scored_candidates[0]["scoring_method"] if scored_candidates else "age_based"
        )

        if scoring_method == "access_data" and scored_candidates:
            # Enhanced description with access data insights
            avg_days = sum(c.get("days_since_last_access", 90) for c in scored_candidates) / len(
                scored_candidates
            )
            avg_accesses = sum(c.get("access_count", 0) for c in scored_candidates) / len(
                scored_candidates
            )
            description = (
                f"Move {analysis.files_to_cold} files "
                f"({self._format_bytes(analysis.size_to_cold)}) to cold storage tier. "
                f"Predicted low access — last accessed {avg_days:.0f} days ago on average, "
                f"{avg_accesses:.1f} accesses in the past 30 days. "
                f"Estimated savings: {self._format_bytes(analysis.estimated_savings_tiering)}."
            )
        else:
            description = (
                f"Move {analysis.files_to_cold} infrequently accessed files "
                f"({self._format_bytes(analysis.size_to_cold)}) to cold storage tier. "
                f"Not accessed in over 90 days (age-based). "
                f"Estimated savings: {self._format_bytes(analysis.estimated_savings_tiering)}."
            )

        suggestion = OptimizationSuggestion(
            user_id=analysis.user_id,
            analysis_id=analysis.id,
            suggestion_type="tier_migration",
            priority=priority,
            title=f"Move {analysis.files_to_cold} files to cold storage",
            description=description,
            files_affected=analysis.files_to_cold,
            size_affected=analysis.size_to_cold,
            estimated_savings=analysis.estimated_savings_tiering,
            estimated_savings_percent=savings_percent * 100,
            action_type="move_to_cold",
            action_details={
                "file_ids": [str(c["file"].id) for c in scored_candidates[:100]],
                "target_tier": "cold",
                "reason": "infrequent_access",
                "scoring_method": scoring_method,
            },
            is_auto_applicable=True,  # Safe to auto-apply
        )

        suggestions.append(suggestion)
        return suggestions

    async def _generate_compression_suggestions(
        self, analysis: StorageAnalysis, db: AsyncSession
    ) -> List[OptimizationSuggestion]:
        """Generate suggestions for compressing files"""
        suggestions = []

        if analysis.compressible_files == 0 or analysis.compressible_size == 0:
            return suggestions

        # Check if savings meet threshold
        if analysis.estimated_savings_compression < self.MIN_SAVINGS_THRESHOLD:
            return suggestions

        # Calculate priority
        savings_percent = (
            (analysis.estimated_savings_compression / analysis.total_size)
            if analysis.total_size > 0
            else 0
        )
        priority = self._calculate_priority(savings_percent)

        # Get specific file candidates
        candidates = await storage_analyzer.get_compressible_files(
            user_id=analysis.user_id, db=db, limit=100
        )

        suggestion = OptimizationSuggestion(
            user_id=analysis.user_id,
            analysis_id=analysis.id,
            suggestion_type="compression",
            priority=priority,
            title=f"Compress {analysis.compressible_files} text-based files",
            description=(
                f"Compress {analysis.compressible_files} text-based files "
                f"({self._format_bytes(analysis.compressible_size)}) to save space. "
                f"Estimated savings: {self._format_bytes(analysis.estimated_savings_compression)} "
                f"({savings_percent*100:.1f}% of total storage)."
            ),
            files_affected=analysis.compressible_files,
            size_affected=analysis.compressible_size,
            estimated_savings=analysis.estimated_savings_compression,
            estimated_savings_percent=savings_percent * 100,
            action_type="compress",
            action_details={
                "file_ids": [str(f.id) for f in candidates[:100]],
                "compression_algorithm": "zstd",
                "compression_level": 3,
            },
            is_auto_applicable=True,  # Safe to auto-apply
        )

        suggestions.append(suggestion)
        return suggestions

    async def _generate_deduplication_suggestions(
        self, analysis: StorageAnalysis, db: AsyncSession
    ) -> List[OptimizationSuggestion]:
        """Generate suggestions for removing duplicate files"""
        suggestions = []

        if analysis.duplicate_files == 0 or analysis.duplicate_size == 0:
            return suggestions

        # Check if savings meet threshold
        if analysis.duplicate_size < self.MIN_SAVINGS_THRESHOLD:
            return suggestions

        # Calculate priority
        savings_percent = (
            (analysis.duplicate_size / analysis.total_size) if analysis.total_size > 0 else 0
        )
        priority = self._calculate_priority(savings_percent)

        suggestion = OptimizationSuggestion(
            user_id=analysis.user_id,
            analysis_id=analysis.id,
            suggestion_type="deduplication",
            priority=priority,
            title=f"Remove {analysis.duplicate_files} duplicate files",
            description=(
                f"You have {analysis.duplicate_files} duplicate files consuming "
                f"{self._format_bytes(analysis.duplicate_size)}. Enable deduplication "
                f"to automatically store only one copy of each unique file and save "
                f"{self._format_bytes(analysis.duplicate_size)} of storage."
            ),
            files_affected=analysis.duplicate_files,
            size_affected=analysis.duplicate_size,
            estimated_savings=analysis.duplicate_size,
            estimated_savings_percent=savings_percent * 100,
            action_type="enable_deduplication",
            action_details={"dedup_method": "hash_based", "preserve_metadata": True},
            is_auto_applicable=False,  # Requires user confirmation
        )

        suggestions.append(suggestion)
        return suggestions

    async def _generate_cleanup_suggestions(
        self, analysis: StorageAnalysis, db: AsyncSession
    ) -> List[OptimizationSuggestion]:
        """Generate suggestions for cleaning up old/unused files"""
        suggestions = []

        # Suggestion 1: Files never accessed
        if analysis.files_never_accessed > 0 and analysis.size_never_accessed > 0:
            if analysis.size_never_accessed >= self.MIN_SAVINGS_THRESHOLD:
                savings_percent = (
                    (analysis.size_never_accessed / analysis.total_size)
                    if analysis.total_size > 0
                    else 0
                )
                priority = self._calculate_priority(savings_percent)

                suggestion = OptimizationSuggestion(
                    user_id=analysis.user_id,
                    analysis_id=analysis.id,
                    suggestion_type="cleanup",
                    priority=priority,
                    title=f"Review {analysis.files_never_accessed} never-accessed files",
                    description=(
                        f"You have {analysis.files_never_accessed} files "
                        f"({self._format_bytes(analysis.size_never_accessed)}) that have "
                        f"never been accessed since upload. Consider reviewing and removing "
                        f"files you no longer need to free up storage space."
                    ),
                    files_affected=analysis.files_never_accessed,
                    size_affected=analysis.size_never_accessed,
                    estimated_savings=analysis.size_never_accessed,
                    estimated_savings_percent=savings_percent * 100,
                    action_type="review_unused",
                    action_details={"filter": "never_accessed", "min_age_days": 30},
                    is_auto_applicable=False,  # Requires user review
                )
                suggestions.append(suggestion)

        # Suggestion 2: Very old files (>180 days)
        if analysis.files_older_180d > 0 and analysis.size_older_180d > 0:
            # Only suggest if a significant portion (>20%) of storage is old
            old_files_percent = (
                (analysis.size_older_180d / analysis.total_size) if analysis.total_size > 0 else 0
            )

            if old_files_percent > 0.20 and analysis.size_older_180d >= self.MIN_SAVINGS_THRESHOLD:
                priority = "low"  # Always low priority for age-based cleanup

                suggestion = OptimizationSuggestion(
                    user_id=analysis.user_id,
                    analysis_id=analysis.id,
                    suggestion_type="cleanup",
                    priority=priority,
                    title=f"Review {analysis.files_older_180d} files older than 6 months",
                    description=(
                        f"You have {analysis.files_older_180d} files "
                        f"({self._format_bytes(analysis.size_older_180d)}) that are over "
                        f"6 months old. Review these files and consider archiving or "
                        f"removing ones you no longer need."
                    ),
                    files_affected=analysis.files_older_180d,
                    size_affected=analysis.size_older_180d,
                    estimated_savings=int(
                        analysis.size_older_180d * 0.5
                    ),  # Assume 50% could be removed
                    estimated_savings_percent=old_files_percent * 50,
                    action_type="review_old",
                    action_details={"filter": "older_than_180d", "age_threshold_days": 180},
                    is_auto_applicable=False,  # Requires user review
                )
                suggestions.append(suggestion)

        return suggestions

    def _calculate_priority(self, savings_percent: float) -> str:
        """Calculate suggestion priority based on savings percentage"""
        if savings_percent >= self.PRIORITY_CRITICAL:
            return "critical"
        elif savings_percent >= self.PRIORITY_HIGH:
            return "high"
        elif savings_percent >= self.PRIORITY_MEDIUM:
            return "medium"
        else:
            return "low"

    def _format_bytes(self, bytes_value: int) -> str:
        """Format bytes into human-readable string"""
        for unit in ["B", "KB", "MB", "GB", "TB"]:
            if bytes_value < 1024.0:
                return f"{bytes_value:.1f} {unit}"
            bytes_value /= 1024.0
        return f"{bytes_value:.1f} PB"

    async def get_suggestions_summary(self, user_id: UUID, db: AsyncSession) -> Dict:
        """
        Get summary of all optimization suggestions for a user

        Returns dictionary with suggestion counts and total savings
        """
        # Get latest analysis
        analysis_result = await db.execute(
            select(StorageAnalysis)
            .where(StorageAnalysis.user_id == user_id)
            .order_by(StorageAnalysis.analysis_date.desc())
            .limit(1)
        )
        analysis = analysis_result.scalar_one_or_none()

        if not analysis:
            return {"total_suggestions": 0, "total_savings": 0, "by_priority": {}, "by_type": {}}

        # Get all pending suggestions
        suggestions_result = await db.execute(
            select(OptimizationSuggestion).where(
                OptimizationSuggestion.user_id == user_id,
                OptimizationSuggestion.status == "pending",
                OptimizationSuggestion.is_dismissed == False,
            )
        )
        suggestions = suggestions_result.scalars().all()

        # Summarize
        total_savings = sum(s.estimated_savings for s in suggestions)
        by_priority = {}
        by_type = {}

        for suggestion in suggestions:
            # Count by priority
            by_priority[suggestion.priority] = by_priority.get(suggestion.priority, 0) + 1

            # Count by type
            by_type[suggestion.suggestion_type] = by_type.get(suggestion.suggestion_type, 0) + 1

        return {
            "total_suggestions": len(suggestions),
            "total_savings": total_savings,
            "by_priority": by_priority,
            "by_type": by_type,
            "last_analysis_date": analysis.analysis_date,
        }


# Singleton instance
storage_optimizer = StorageOptimizerService()
