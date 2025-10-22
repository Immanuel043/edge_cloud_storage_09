"""
Storage Analyzer Service

Analyzes user storage patterns to identify optimization opportunities:
- Tier distribution analysis
- Access pattern analysis
- Age-based analysis
- Duplicate detection
- Compression opportunities
"""

import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_, or_
from uuid import UUID
import time

from ..models.database import (
    User, Object, StorageAnalysis, FileVersion
)

logger = logging.getLogger(__name__)


class StorageAnalyzerService:
    """
    Analyzes storage usage patterns and identifies optimization opportunities
    """

    # Compressible MIME types (text-based files)
    COMPRESSIBLE_TYPES = {
        'text/', 'application/json', 'application/xml',
        'application/javascript', 'application/x-javascript',
        'application/ecmascript', 'text/css', 'text/csv',
        'text/html', 'text/plain', 'text/xml',
        'application/sql', 'application/x-sql'
    }

    # Typical compression ratios by type
    COMPRESSION_RATIOS = {
        'text/': 0.30,  # 70% compression
        'application/json': 0.25,
        'application/xml': 0.30,
        'application/javascript': 0.35,
        'default': 0.40  # 60% compression
    }

    # Age thresholds for analysis (in days)
    AGE_THRESHOLDS = {
        '30d': 30,
        '90d': 90,
        '180d': 180,
        '365d': 365
    }

    def __init__(self):
        pass

    async def analyze_user_storage(
        self,
        user_id: UUID,
        db: AsyncSession
    ) -> Optional[StorageAnalysis]:
        """
        Perform comprehensive storage analysis for a user

        Args:
            user_id: User to analyze
            db: Database session

        Returns:
            StorageAnalysis object with results
        """
        start_time = time.time()

        try:
            logger.info(f"Starting storage analysis for user {user_id}")

            # Get user
            user_result = await db.execute(
                select(User).where(User.id == user_id)
            )
            user = user_result.scalar_one_or_none()
            if not user:
                logger.error(f"User {user_id} not found")
                return None

            # Initialize analysis object
            analysis = StorageAnalysis(user_id=user_id)

            # Get all files for user
            files_result = await db.execute(
                select(Object).where(Object.user_id == user_id)
            )
            files = files_result.scalars().all()

            if not files:
                logger.info(f"No files found for user {user_id}")
                analysis.total_files = 0
                analysis.total_size = 0
                analysis.analysis_duration_ms = int((time.time() - start_time) * 1000)
                return analysis

            # Overall metrics
            analysis.total_files = len(files)
            analysis.total_size = sum(f.file_size or 0 for f in files)

            # Analyze tier distribution
            await self._analyze_tier_distribution(files, analysis)

            # Analyze access patterns
            await self._analyze_access_patterns(files, analysis)

            # Analyze file age
            await self._analyze_file_age(files, analysis)

            # Analyze compression opportunities
            await self._analyze_compression_opportunities(files, analysis)

            # Analyze tier migration opportunities
            await self._analyze_tier_migration_opportunities(files, analysis)

            # Analyze duplicates
            await self._analyze_duplicates(files, analysis, db)

            # Calculate total potential savings
            analysis.total_potential_savings = (
                (analysis.estimated_savings_compression or 0) +
                (analysis.estimated_savings_tiering or 0) +
                (analysis.duplicate_size or 0)
            )

            # Record duration
            analysis.analysis_duration_ms = int((time.time() - start_time) * 1000)

            logger.info(
                f"Completed storage analysis for user {user_id}: "
                f"{analysis.total_files} files, {analysis.total_size} bytes, "
                f"{analysis.total_potential_savings} bytes potential savings "
                f"({analysis.analysis_duration_ms}ms)"
            )

            return analysis

        except Exception as e:
            logger.error(f"Failed to analyze storage for user {user_id}: {e}", exc_info=True)
            return None

    async def _analyze_tier_distribution(
        self,
        files: List[Object],
        analysis: StorageAnalysis
    ):
        """Analyze distribution of files across storage tiers"""
        tier_counts = {'cache': 0, 'warm': 0, 'cold': 0}
        tier_sizes = {'cache': 0, 'warm': 0, 'cold': 0}

        for file in files:
            tier = file.storage_tier or 'warm'
            tier_counts[tier] = tier_counts.get(tier, 0) + 1
            tier_sizes[tier] = tier_sizes.get(tier, 0) + (file.file_size or 0)

        analysis.cache_files = tier_counts.get('cache', 0)
        analysis.cache_size = tier_sizes.get('cache', 0)
        analysis.warm_files = tier_counts.get('warm', 0)
        analysis.warm_size = tier_sizes.get('warm', 0)
        analysis.cold_files = tier_counts.get('cold', 0)
        analysis.cold_size = tier_sizes.get('cold', 0)

    async def _analyze_access_patterns(
        self,
        files: List[Object],
        analysis: StorageAnalysis
    ):
        """Analyze file access patterns"""
        total_accesses = 0
        never_accessed_files = 0
        never_accessed_size = 0
        accessed_once_files = 0
        accessed_once_size = 0

        for file in files:
            access_count = file.access_count or 0
            total_accesses += access_count

            if access_count == 0:
                never_accessed_files += 1
                never_accessed_size += file.file_size or 0
            elif access_count == 1:
                accessed_once_files += 1
                accessed_once_size += file.file_size or 0

        analysis.avg_access_frequency = total_accesses / len(files) if files else 0.0
        analysis.files_never_accessed = never_accessed_files
        analysis.size_never_accessed = never_accessed_size
        analysis.files_accessed_once = accessed_once_files
        analysis.size_accessed_once = accessed_once_size

    async def _analyze_file_age(
        self,
        files: List[Object],
        analysis: StorageAnalysis
    ):
        """Analyze file age distribution"""
        now = datetime.utcnow()

        files_30d = 0
        size_30d = 0
        files_90d = 0
        size_90d = 0
        files_180d = 0
        size_180d = 0

        for file in files:
            if not file.created_at:
                continue

            age_days = (now - file.created_at).days

            if age_days >= 180:
                files_180d += 1
                size_180d += file.file_size or 0
            if age_days >= 90:
                files_90d += 1
                size_90d += file.file_size or 0
            if age_days >= 30:
                files_30d += 1
                size_30d += file.file_size or 0

        analysis.files_older_30d = files_30d
        analysis.size_older_30d = size_30d
        analysis.files_older_90d = files_90d
        analysis.size_older_90d = size_90d
        analysis.files_older_180d = files_180d
        analysis.size_older_180d = size_180d

    async def _analyze_compression_opportunities(
        self,
        files: List[Object],
        analysis: StorageAnalysis
    ):
        """Identify files that could benefit from compression"""
        compressible_files = 0
        compressible_size = 0
        estimated_savings = 0

        for file in files:
            # Skip if already compressed
            if file.is_compressed:
                continue

            # Check if mime type is compressible
            mime_type = file.mime_type or ''
            is_compressible = any(
                mime_type.startswith(comp_type)
                for comp_type in self.COMPRESSIBLE_TYPES
            )

            if is_compressible:
                compressible_files += 1
                file_size = file.file_size or 0
                compressible_size += file_size

                # Estimate compression savings
                ratio = self._get_compression_ratio(mime_type)
                estimated_savings += int(file_size * (1 - ratio))

        analysis.compressible_files = compressible_files
        analysis.compressible_size = compressible_size
        analysis.estimated_savings_compression = estimated_savings

    def _get_compression_ratio(self, mime_type: str) -> float:
        """Get expected compression ratio for a mime type"""
        for type_prefix, ratio in self.COMPRESSION_RATIOS.items():
            if mime_type.startswith(type_prefix):
                return ratio
        return self.COMPRESSION_RATIOS['default']

    async def _analyze_tier_migration_opportunities(
        self,
        files: List[Object],
        analysis: StorageAnalysis
    ):
        """
        Identify files that should be moved to cold storage

        Criteria:
        - Not accessed in last 90 days
        - Currently in cache or warm tier
        - File size > 1MB
        """
        files_to_cold = 0
        size_to_cold = 0
        now = datetime.utcnow()
        threshold_date = now - timedelta(days=90)

        for file in files:
            # Skip if already in cold storage
            if file.storage_tier == 'cold':
                continue

            # Check if not accessed recently
            last_accessed = file.last_accessed_at or file.created_at
            if not last_accessed or last_accessed >= threshold_date:
                continue

            # Check access count
            if (file.access_count or 0) > 5:
                continue  # Frequently accessed, keep in warm/cache

            # Check size (only migrate larger files)
            if (file.file_size or 0) < 1024 * 1024:  # 1MB
                continue

            files_to_cold += 1
            size_to_cold += file.file_size or 0

        # Estimate savings (cold storage costs 70% less than warm)
        estimated_savings = int(size_to_cold * 0.70)

        analysis.files_to_cold = files_to_cold
        analysis.size_to_cold = size_to_cold
        analysis.estimated_savings_tiering = estimated_savings

    async def _analyze_duplicates(
        self,
        files: List[Object],
        analysis: StorageAnalysis,
        db: AsyncSession
    ):
        """
        Identify duplicate files based on hash

        Note: Assumes deduplication is not already enabled
        """
        # Group files by hash
        hash_groups = {}
        for file in files:
            if not file.file_hash:
                continue

            if file.file_hash not in hash_groups:
                hash_groups[file.file_hash] = []
            hash_groups[file.file_hash].append(file)

        # Count duplicates
        duplicate_files = 0
        duplicate_size = 0

        for file_hash, file_group in hash_groups.items():
            if len(file_group) > 1:
                # Keep one, count others as duplicates
                duplicate_count = len(file_group) - 1
                duplicate_files += duplicate_count

                # Calculate duplicate size
                file_size = file_group[0].file_size or 0
                duplicate_size += file_size * duplicate_count

        analysis.duplicate_files = duplicate_files
        analysis.duplicate_size = duplicate_size

    async def get_file_candidates_for_cold_storage(
        self,
        user_id: UUID,
        db: AsyncSession,
        limit: int = 100
    ) -> List[Object]:
        """
        Get specific files that should be moved to cold storage

        Returns list of file objects ready for migration
        """
        threshold_date = datetime.utcnow() - timedelta(days=90)

        result = await db.execute(
            select(Object)
            .where(
                and_(
                    Object.user_id == user_id,
                    Object.storage_tier.in_(['cache', 'warm']),
                    or_(
                        Object.last_accessed_at < threshold_date,
                        and_(
                            Object.last_accessed_at.is_(None),
                            Object.created_at < threshold_date
                        )
                    ),
                    Object.access_count <= 5,
                    Object.file_size >= 1024 * 1024  # 1MB
                )
            )
            .order_by(Object.file_size.desc())  # Largest files first
            .limit(limit)
        )

        return result.scalars().all()

    async def get_compressible_files(
        self,
        user_id: UUID,
        db: AsyncSession,
        limit: int = 100
    ) -> List[Object]:
        """Get files that could be compressed"""
        # Build MIME type filter
        mime_filters = [
            Object.mime_type.like(f'{comp_type}%')
            for comp_type in self.COMPRESSIBLE_TYPES
        ]

        result = await db.execute(
            select(Object)
            .where(
                and_(
                    Object.user_id == user_id,
                    Object.is_compressed == False,
                    or_(*mime_filters)
                )
            )
            .order_by(Object.file_size.desc())  # Largest files first
            .limit(limit)
        )

        return result.scalars().all()


# Singleton instance
storage_analyzer = StorageAnalyzerService()
