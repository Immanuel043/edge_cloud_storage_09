"""
Content Similarity Service

Computes content-based similarity between files using:
- TF-IDF vectorization on file names and metadata
- Cosine similarity for distance metric
- Pre-computation and caching for performance

Features:
- CPU-optimized with 32-thread support
- Batch processing for large file sets
- Smart feature extraction from file metadata
- Configurable similarity thresholds
"""

import os
import logging
import numpy as np
from typing import List, Dict, Optional, Tuple
from datetime import datetime, timedelta
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, or_
from uuid import UUID

# CPU optimization
os.environ['OMP_NUM_THREADS'] = '32'
os.environ['MKL_NUM_THREADS'] = '32'
os.environ['OPENBLAS_NUM_THREADS'] = '32'

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
import scipy.sparse as sp

from ..models.database import Object, FileSimilarity, User
from ..monitoring.metrics import metrics_collector

logger = logging.getLogger(__name__)


class ContentSimilarityService:
    """
    Service for computing content-based file similarity

    Uses TF-IDF vectorization and cosine similarity to find similar files
    based on file names, extensions, and metadata.

    Features:
    - Multi-feature extraction (names, extensions, sizes, dates)
    - Weighted feature combination
    - Batch processing for efficiency
    - Pre-computation and caching
    """

    def __init__(self):
        self.vectorizer = TfidfVectorizer(
            analyzer='char',
            ngram_range=(2, 4),
            max_features=1000,
            lowercase=True,
            strip_accents='unicode'
        )
        self.min_similarity = 0.3  # Minimum similarity to store
        self.batch_size = 1000

    async def compute_file_similarity(
        self,
        file_id: UUID,
        user_id: UUID,
        db: AsyncSession,
        top_k: int = 10,
        force_recompute: bool = False
    ) -> List[Dict]:
        """
        Compute similarity between a file and all other user files

        Args:
            file_id: File to find similarities for
            user_id: User ID (only compare within user's files)
            db: Database session
            top_k: Number of top similar files to return
            force_recompute: Force recomputation instead of using cached

        Returns:
            List of similar files with scores and metadata
        """
        start_time = datetime.utcnow()

        try:
            # Check for cached similarities
            if not force_recompute:
                cached = await self._get_cached_similarities(file_id, db, top_k)
                if cached:
                    logger.info(f"Returning {len(cached)} cached similarities for file {file_id}")
                    metrics_collector.increment_counter('content_similarity_cache_hits_total')
                    return cached

            metrics_collector.increment_counter('content_similarity_cache_misses_total')

            # Get target file
            result = await db.execute(
                select(Object).where(
                    Object.id == file_id,
                    Object.user_id == user_id
                )
            )
            target_file = result.scalar_one_or_none()

            if not target_file:
                logger.warning(f"File {file_id} not found")
                return []

            # Get all user files (excluding target)
            result = await db.execute(
                select(Object).where(
                    Object.user_id == user_id,
                    Object.id != file_id,
                    Object.object_type == 'file'
                )
            )
            all_files = result.scalars().all()

            if not all_files:
                logger.info(f"No other files found for user {user_id}")
                return []

            logger.info(f"Computing similarity for file {file_id} against {len(all_files)} files")

            # Prepare features for all files
            target_features = self._extract_features([target_file])
            candidate_features = self._extract_features(all_files)

            # Compute similarity
            similarities = cosine_similarity(target_features, candidate_features)[0]

            # Get top-k similar files
            top_indices = np.argsort(similarities)[-top_k:][::-1]

            similar_files = []
            for idx in top_indices:
                score = float(similarities[idx])

                # Only include if above threshold
                if score < self.min_similarity:
                    continue

                similar_file = all_files[idx]

                # Extract common keywords
                common_keywords = self._find_common_keywords(
                    target_file.object_name,
                    similar_file.object_name
                )

                similar_files.append({
                    'file_id': similar_file.id,
                    'file_name': similar_file.object_name,
                    'file_size': similar_file.file_size,
                    'mime_type': similar_file.mime_type,
                    'storage_tier': similar_file.storage_tier,
                    'similarity_score': score,
                    'similarity_type': 'content',
                    'common_keywords': common_keywords,
                    'created_at': similar_file.created_at,
                    'last_accessed': similar_file.last_accessed
                })

                # Save to database for caching
                await self._save_similarity(
                    file_id=file_id,
                    similar_file_id=similar_file.id,
                    score=score,
                    similarity_type='content',
                    common_keywords=common_keywords,
                    db=db
                )

            await db.commit()

            duration_ms = int((datetime.utcnow() - start_time).total_seconds() * 1000)

            logger.info(
                f"Found {len(similar_files)} similar files for {file_id} in {duration_ms}ms"
            )

            metrics_collector.increment_counter('content_similarity_computations_total')
            metrics_collector.observe_histogram('content_similarity_duration_ms', duration_ms)

            return similar_files

        except Exception as e:
            logger.error(f"Failed to compute file similarity: {e}", exc_info=True)
            metrics_collector.increment_counter('content_similarity_errors_total')
            return []

    async def batch_compute_similarities(
        self,
        user_id: UUID,
        db: AsyncSession,
        file_ids: Optional[List[UUID]] = None
    ) -> int:
        """
        Batch compute similarities for multiple files

        Args:
            user_id: User ID
            db: Database session
            file_ids: Specific files to compute (None = all user files)

        Returns:
            Number of similarity records created
        """
        start_time = datetime.utcnow()

        try:
            # Get files to process
            query = select(Object).where(
                Object.user_id == user_id,
                Object.object_type == 'file'
            )

            if file_ids:
                query = query.where(Object.id.in_(file_ids))

            result = await db.execute(query)
            files = result.scalars().all()

            if len(files) < 2:
                logger.info(f"Not enough files for batch similarity computation")
                return 0

            logger.info(f"Batch computing similarities for {len(files)} files")

            # Extract features for all files
            features = self._extract_features(files)

            # Compute pairwise similarities
            similarity_matrix = cosine_similarity(features)

            similarities_created = 0

            # Process similarity matrix
            for i in range(len(files)):
                for j in range(i + 1, len(files)):
                    score = float(similarity_matrix[i, j])

                    # Only save if above threshold
                    if score < self.min_similarity:
                        continue

                    # Extract common keywords
                    common_keywords = self._find_common_keywords(
                        files[i].object_name,
                        files[j].object_name
                    )

                    # Save both directions for easier querying
                    await self._save_similarity(
                        file_id=files[i].id,
                        similar_file_id=files[j].id,
                        score=score,
                        similarity_type='content',
                        common_keywords=common_keywords,
                        db=db
                    )

                    await self._save_similarity(
                        file_id=files[j].id,
                        similar_file_id=files[i].id,
                        score=score,
                        similarity_type='content',
                        common_keywords=common_keywords,
                        db=db
                    )

                    similarities_created += 2

                # Commit periodically
                if (i + 1) % 100 == 0:
                    await db.commit()
                    logger.info(f"Processed {i + 1}/{len(files)} files")

            await db.commit()

            duration_ms = int((datetime.utcnow() - start_time).total_seconds() * 1000)

            logger.info(
                f"Batch computed {similarities_created} similarities in {duration_ms}ms"
            )

            metrics_collector.increment_counter('content_similarity_batch_computations_total')
            metrics_collector.observe_histogram('content_similarity_batch_duration_ms', duration_ms)

            return similarities_created

        except Exception as e:
            logger.error(f"Failed to batch compute similarities: {e}", exc_info=True)
            await db.rollback()
            metrics_collector.increment_counter('content_similarity_batch_errors_total')
            return 0

    def _extract_features(self, files: List[Object]) -> sp.csr_matrix:
        """
        Extract features from files for similarity computation

        Args:
            files: List of file objects

        Returns:
            Sparse feature matrix
        """
        # Extract text features from filenames
        filenames = [f.object_name or '' for f in files]

        # TF-IDF on filenames
        tfidf_features = self.vectorizer.fit_transform(filenames)

        # Extension features (one-hot)
        extensions = []
        for f in files:
            ext = f.object_name.split('.')[-1].lower() if '.' in (f.object_name or '') else 'none'
            extensions.append(ext)

        unique_extensions = list(set(extensions))
        ext_features = np.zeros((len(files), len(unique_extensions)))
        for i, ext in enumerate(extensions):
            ext_features[i, unique_extensions.index(ext)] = 1.0

        # Size features (normalized)
        sizes = np.array([f.file_size or 0 for f in files]).reshape(-1, 1)
        sizes_normalized = (sizes - sizes.mean()) / (sizes.std() + 1e-10)

        # Combine features with weights
        # TF-IDF: 70%, Extension: 20%, Size: 10%
        feature_matrix = sp.hstack([
            tfidf_features * 0.70,
            sp.csr_matrix(ext_features) * 0.20,
            sp.csr_matrix(sizes_normalized) * 0.10
        ])

        return feature_matrix

    def _find_common_keywords(self, name1: str, name2: str) -> List[str]:
        """
        Find common keywords between two filenames

        Args:
            name1: First filename
            name2: Second filename

        Returns:
            List of common keywords
        """
        # Split on common separators
        import re

        words1 = set(re.split(r'[_\-\s\.]+', name1.lower()))
        words2 = set(re.split(r'[_\-\s\.]+', name2.lower()))

        # Filter out very short words and extensions
        words1 = {w for w in words1 if len(w) > 2 and not w.isdigit()}
        words2 = {w for w in words2 if len(w) > 2 and not w.isdigit()}

        common = words1.intersection(words2)

        return sorted(list(common))[:5]  # Return top 5

    async def _get_cached_similarities(
        self,
        file_id: UUID,
        db: AsyncSession,
        top_k: int
    ) -> Optional[List[Dict]]:
        """
        Get cached similarities for a file

        Args:
            file_id: File ID
            db: Database session
            top_k: Number of results to return

        Returns:
            List of cached similarities or None
        """
        # Check if we have recent cached similarities
        result = await db.execute(
            select(FileSimilarity)
            .where(FileSimilarity.file_id == file_id)
            .order_by(FileSimilarity.similarity_score.desc())
            .limit(top_k)
        )
        cached = result.scalars().all()

        if not cached:
            return None

        # Check if cache is recent (less than 7 days old)
        oldest_cache = min(s.computed_at for s in cached)
        cache_age = (datetime.utcnow() - oldest_cache).days

        if cache_age > 7:
            logger.info(f"Cache for file {file_id} is {cache_age} days old, recomputing")
            return None

        # Build response
        similar_files = []
        for sim in cached:
            # Get similar file details
            result = await db.execute(
                select(Object).where(Object.id == sim.similar_file_id)
            )
            similar_file = result.scalar_one_or_none()

            if not similar_file:
                continue

            similar_files.append({
                'file_id': similar_file.id,
                'file_name': similar_file.object_name,
                'file_size': similar_file.file_size,
                'mime_type': similar_file.mime_type,
                'storage_tier': similar_file.storage_tier,
                'similarity_score': sim.similarity_score,
                'similarity_type': sim.similarity_type,
                'common_keywords': sim.common_keywords or [],
                'created_at': similar_file.created_at,
                'last_accessed': similar_file.last_accessed
            })

        return similar_files

    async def _save_similarity(
        self,
        file_id: UUID,
        similar_file_id: UUID,
        score: float,
        similarity_type: str,
        common_keywords: List[str],
        db: AsyncSession
    ):
        """
        Save similarity to database

        Args:
            file_id: Source file ID
            similar_file_id: Similar file ID
            score: Similarity score
            similarity_type: Type of similarity
            common_keywords: Common keywords
            db: Database session
        """
        # Check if already exists
        result = await db.execute(
            select(FileSimilarity).where(
                and_(
                    FileSimilarity.file_id == file_id,
                    FileSimilarity.similar_file_id == similar_file_id
                )
            )
        )
        existing = result.scalar_one_or_none()

        if existing:
            # Update existing
            existing.similarity_score = score
            existing.similarity_type = similarity_type
            existing.common_keywords = common_keywords
            existing.computed_at = datetime.utcnow()
        else:
            # Create new
            similarity = FileSimilarity(
                file_id=file_id,
                similar_file_id=similar_file_id,
                similarity_score=score,
                similarity_type=similarity_type,
                common_keywords=common_keywords
            )
            db.add(similarity)

    async def get_similar_files_by_content(
        self,
        file_id: UUID,
        user_id: UUID,
        db: AsyncSession,
        limit: int = 10,
        min_score: float = 0.3
    ) -> List[Dict]:
        """
        Get similar files for a given file (public API)

        Args:
            file_id: File to find similarities for
            user_id: User ID
            db: Database session
            limit: Maximum number of results
            min_score: Minimum similarity score

        Returns:
            List of similar files
        """
        # Override min_similarity temporarily
        original_min = self.min_similarity
        self.min_similarity = min_score

        try:
            results = await self.compute_file_similarity(
                file_id=file_id,
                user_id=user_id,
                db=db,
                top_k=limit,
                force_recompute=False
            )
            return results
        finally:
            self.min_similarity = original_min


# Singleton instance
content_similarity_service = ContentSimilarityService()
