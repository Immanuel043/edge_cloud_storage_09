# services/storage-service/app/services/embedding_service.py
"""
Semantic Search Embedding Service

Provides AI-powered semantic search using sentence-transformers embeddings.
Features:
- Generates 384-dimensional embeddings using all-MiniLM-L6-v2
- Stores embeddings in PostgreSQL as binary (BYTEA)
- Caches embeddings in Redis with 7-day TTL
- Performs cosine similarity search for semantic matching
- Supports hybrid search combining keyword + semantic results
"""

import asyncio
import hashlib
import json
import logging
import struct
from datetime import datetime
from typing import List, Dict, Any, Optional, Tuple
from uuid import UUID

import numpy as np
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..models.database import Object, FileEmbedding

logger = logging.getLogger(__name__)

# Lazy load sentence-transformers to reduce startup time
_model = None
_model_lock = asyncio.Lock()


async def get_embedding_model():
    """Lazy-load the sentence-transformer model"""
    global _model

    if _model is not None:
        return _model

    async with _model_lock:
        if _model is not None:
            return _model

        if not settings.SEMANTIC_SEARCH_ENABLED:
            logger.warning("Semantic search is disabled")
            return None

        try:
            # Import here to avoid loading at startup
            from sentence_transformers import SentenceTransformer

            logger.info(f"Loading embedding model: {settings.SEMANTIC_MODEL_NAME}")
            _model = SentenceTransformer(settings.SEMANTIC_MODEL_NAME)
            logger.info(f"Embedding model loaded successfully (dim={settings.SEMANTIC_EMBEDDING_DIM})")
            return _model
        except Exception as e:
            logger.error(f"Failed to load embedding model: {e}")
            return None


class EmbeddingService:
    """
    Service for generating and searching semantic embeddings.

    Embeddings are stored as binary (bytes) in PostgreSQL and cached in Redis.
    Uses cosine similarity for semantic matching.
    """

    def __init__(self, redis_client=None):
        self.redis = redis_client
        self.cache_ttl = settings.SEMANTIC_CACHE_TTL  # 7 days default

    def set_redis(self, redis_client):
        """Set Redis client for caching"""
        self.redis = redis_client

    # ========================================================================
    # Embedding Generation
    # ========================================================================

    async def generate_embedding(self, text: str) -> Optional[np.ndarray]:
        """
        Generate embedding vector for text.

        Args:
            text: Text to embed (filename, tags, description)

        Returns:
            numpy array of shape (384,) or None if failed
        """
        if not text or not text.strip():
            return None

        model = await get_embedding_model()
        if model is None:
            return None

        try:
            # Run in thread pool to avoid blocking
            loop = asyncio.get_event_loop()
            embedding = await loop.run_in_executor(
                None,
                lambda: model.encode(text, normalize_embeddings=True)
            )
            return embedding
        except Exception as e:
            logger.error(f"Failed to generate embedding: {e}")
            return None

    async def generate_embeddings_batch(self, texts: List[str]) -> List[Optional[np.ndarray]]:
        """
        Generate embeddings for multiple texts in batch (more efficient).

        Args:
            texts: List of texts to embed

        Returns:
            List of embeddings (None for failed items)
        """
        if not texts:
            return []

        model = await get_embedding_model()
        if model is None:
            return [None] * len(texts)

        try:
            # Filter out empty texts and track indices
            valid_texts = []
            valid_indices = []
            for i, text in enumerate(texts):
                if text and text.strip():
                    valid_texts.append(text)
                    valid_indices.append(i)

            if not valid_texts:
                return [None] * len(texts)

            # Generate embeddings in batch
            loop = asyncio.get_event_loop()
            embeddings = await loop.run_in_executor(
                None,
                lambda: model.encode(valid_texts, normalize_embeddings=True, batch_size=32)
            )

            # Map back to original indices
            result = [None] * len(texts)
            for idx, embedding in zip(valid_indices, embeddings):
                result[idx] = embedding

            return result
        except Exception as e:
            logger.error(f"Failed to generate batch embeddings: {e}")
            return [None] * len(texts)

    # ========================================================================
    # Embedding Storage (Binary format)
    # ========================================================================

    @staticmethod
    def embedding_to_bytes(embedding: np.ndarray) -> bytes:
        """Convert numpy array to binary format for storage"""
        return embedding.astype(np.float32).tobytes()

    @staticmethod
    def bytes_to_embedding(data: bytes) -> np.ndarray:
        """Convert binary data back to numpy array"""
        return np.frombuffer(data, dtype=np.float32)

    @staticmethod
    def compute_text_hash(text: str) -> str:
        """Compute SHA256 hash of text for change detection"""
        return hashlib.sha256(text.encode('utf-8')).hexdigest()

    # ========================================================================
    # Database Operations
    # ========================================================================

    async def store_embedding(
        self,
        db: AsyncSession,
        file_id: UUID,
        user_id: UUID,
        embedding: np.ndarray,
        source_text: str,
        source_type: str = 'filename'
    ) -> Optional[FileEmbedding]:
        """
        Store embedding in PostgreSQL and cache in Redis.

        Args:
            db: Database session
            file_id: File UUID
            user_id: User UUID
            embedding: Embedding vector
            source_text: Original text that was embedded
            source_type: Type of source ('filename', 'tags', 'content', 'combined')

        Returns:
            FileEmbedding record or None
        """
        try:
            embedding_bytes = self.embedding_to_bytes(embedding)
            text_hash = self.compute_text_hash(source_text)

            # Check if embedding already exists
            result = await db.execute(
                select(FileEmbedding).filter(
                    FileEmbedding.file_id == file_id,
                    FileEmbedding.source_type == source_type
                )
            )
            existing = result.scalar_one_or_none()

            if existing:
                # Update existing embedding
                existing.embedding = embedding_bytes
                existing.source_text_hash = text_hash
                existing.model_name = settings.SEMANTIC_MODEL_NAME
                existing.status = 'completed'
                existing.computed_at = datetime.utcnow()
                existing.error_message = None
                await db.commit()
                file_embedding = existing
            else:
                # Create new embedding
                file_embedding = FileEmbedding(
                    file_id=file_id,
                    user_id=user_id,
                    embedding=embedding_bytes,
                    embedding_dim=len(embedding),
                    model_name=settings.SEMANTIC_MODEL_NAME,
                    model_version='1.0',
                    source_text_hash=text_hash,
                    source_type=source_type,
                    status='completed',
                    computed_at=datetime.utcnow()
                )
                db.add(file_embedding)
                await db.commit()

            # Cache in Redis
            await self._cache_embedding(file_id, source_type, embedding)

            logger.debug(f"Stored embedding for file {file_id} (source: {source_type})")
            return file_embedding

        except Exception as e:
            logger.error(f"Failed to store embedding for file {file_id}: {e}")
            await db.rollback()
            return None

    async def get_embedding(
        self,
        db: AsyncSession,
        file_id: UUID,
        source_type: str = 'filename'
    ) -> Optional[np.ndarray]:
        """
        Get embedding from cache or database.

        Args:
            db: Database session
            file_id: File UUID
            source_type: Type of embedding source

        Returns:
            Embedding vector or None
        """
        # Try cache first
        cached = await self._get_cached_embedding(file_id, source_type)
        if cached is not None:
            return cached

        # Fetch from database
        try:
            result = await db.execute(
                select(FileEmbedding).filter(
                    FileEmbedding.file_id == file_id,
                    FileEmbedding.source_type == source_type,
                    FileEmbedding.status == 'completed'
                )
            )
            record = result.scalar_one_or_none()

            if record and record.embedding:
                embedding = self.bytes_to_embedding(record.embedding)
                # Cache for next time
                await self._cache_embedding(file_id, source_type, embedding)
                return embedding

            return None
        except Exception as e:
            logger.error(f"Failed to get embedding for file {file_id}: {e}")
            return None

    async def get_user_embeddings(
        self,
        db: AsyncSession,
        user_id: UUID,
        source_type: str = 'filename',
        limit: int = None
    ) -> List[Tuple[UUID, np.ndarray]]:
        """
        Get all embeddings for a user.

        Returns:
            List of (file_id, embedding) tuples
        """
        try:
            query = select(FileEmbedding.file_id, FileEmbedding.embedding).filter(
                FileEmbedding.user_id == user_id,
                FileEmbedding.source_type == source_type,
                FileEmbedding.status == 'completed'
            )

            if limit:
                query = query.limit(limit)

            result = await db.execute(query)
            rows = result.fetchall()

            embeddings = []
            for file_id, embedding_bytes in rows:
                if embedding_bytes:
                    embedding = self.bytes_to_embedding(embedding_bytes)
                    embeddings.append((file_id, embedding))

            return embeddings
        except Exception as e:
            logger.error(f"Failed to get user embeddings: {e}")
            return []

    # ========================================================================
    # Redis Caching
    # ========================================================================

    async def _cache_embedding(self, file_id: UUID, source_type: str, embedding: np.ndarray):
        """Cache embedding in Redis"""
        if not self.redis:
            return

        try:
            cache_key = f"embedding:{file_id}:{source_type}"
            embedding_bytes = self.embedding_to_bytes(embedding)
            await self.redis.setex(cache_key, self.cache_ttl, embedding_bytes)
        except Exception as e:
            logger.warning(f"Failed to cache embedding: {e}")

    async def _get_cached_embedding(self, file_id: UUID, source_type: str) -> Optional[np.ndarray]:
        """Get embedding from Redis cache"""
        if not self.redis:
            return None

        try:
            cache_key = f"embedding:{file_id}:{source_type}"
            data = await self.redis.get(cache_key)
            if data:
                return self.bytes_to_embedding(data)
            return None
        except Exception as e:
            logger.warning(f"Failed to get cached embedding: {e}")
            return None

    async def invalidate_cache(self, file_id: UUID):
        """Invalidate all cached embeddings for a file"""
        if not self.redis:
            return

        try:
            for source_type in ['filename', 'tags', 'content', 'combined']:
                cache_key = f"embedding:{file_id}:{source_type}"
                await self.redis.delete(cache_key)
        except Exception as e:
            logger.warning(f"Failed to invalidate cache: {e}")

    # ========================================================================
    # Semantic Search
    # ========================================================================

    @staticmethod
    def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
        """
        Compute cosine similarity between two vectors.
        Since embeddings are normalized, this is just the dot product.
        """
        return float(np.dot(a, b))

    @staticmethod
    def cosine_similarity_batch(query: np.ndarray, embeddings: np.ndarray) -> np.ndarray:
        """
        Compute cosine similarity between query and multiple embeddings.

        Args:
            query: Query embedding (384,)
            embeddings: Matrix of embeddings (N, 384)

        Returns:
            Array of similarity scores (N,)
        """
        return np.dot(embeddings, query)

    async def semantic_search(
        self,
        db: AsyncSession,
        query: str,
        user_id: UUID,
        top_k: int = None,
        min_score: float = None,
        source_type: str = 'filename'
    ) -> List[Dict[str, Any]]:
        """
        Perform semantic search across user's files.

        Args:
            db: Database session
            query: Search query text
            user_id: User UUID
            top_k: Number of results to return
            min_score: Minimum similarity score threshold
            source_type: Type of embedding to search

        Returns:
            List of {file_id, score, file_name} sorted by relevance
        """
        top_k = top_k or settings.SEMANTIC_SEARCH_TOP_K
        min_score = min_score or settings.SEMANTIC_MIN_SCORE

        # Generate query embedding
        query_embedding = await self.generate_embedding(query)
        if query_embedding is None:
            logger.warning("Failed to generate query embedding")
            return []

        # Get all user embeddings
        user_embeddings = await self.get_user_embeddings(
            db, user_id, source_type, limit=5000  # Reasonable limit
        )

        if not user_embeddings:
            return []

        # Extract file IDs and embedding matrix
        file_ids = [fe[0] for fe in user_embeddings]
        embeddings_matrix = np.array([fe[1] for fe in user_embeddings])

        # Compute similarities
        scores = self.cosine_similarity_batch(query_embedding, embeddings_matrix)

        # Filter by minimum score and get top-k
        results = []
        for file_id, score in zip(file_ids, scores):
            if score >= min_score:
                results.append({
                    'file_id': file_id,
                    'semantic_score': float(score)
                })

        # Sort by score descending
        results.sort(key=lambda x: x['semantic_score'], reverse=True)

        # Return top-k
        return results[:top_k]

    async def hybrid_search(
        self,
        db: AsyncSession,
        keyword_results: List[Dict[str, Any]],
        query: str,
        user_id: UUID,
        top_k: int = 20
    ) -> List[Dict[str, Any]]:
        """
        Combine keyword search results with semantic search for hybrid ranking.

        Args:
            db: Database session
            keyword_results: Results from Elasticsearch keyword search
            query: Original search query
            user_id: User UUID
            top_k: Number of results to return

        Returns:
            Re-ranked results with combined scores
        """
        keyword_weight = settings.HYBRID_KEYWORD_WEIGHT  # 0.4 default
        semantic_weight = settings.HYBRID_SEMANTIC_WEIGHT  # 0.6 default

        # Get semantic results
        semantic_results = await self.semantic_search(
            db, query, user_id, top_k=settings.SEMANTIC_SEARCH_TOP_K
        )

        # Build lookup maps
        semantic_scores = {
            str(r['file_id']): r['semantic_score']
            for r in semantic_results
        }

        keyword_scores = {}
        max_keyword_score = 1.0
        for r in keyword_results:
            file_id = r.get('id') or str(r.get('file_id', ''))
            score = r.get('score', 0)
            keyword_scores[file_id] = score
            max_keyword_score = max(max_keyword_score, score)

        # Normalize keyword scores to 0-1
        for file_id in keyword_scores:
            keyword_scores[file_id] /= max_keyword_score

        # Combine all unique file IDs
        all_file_ids = set(semantic_scores.keys()) | set(keyword_scores.keys())

        # Calculate hybrid scores
        hybrid_results = []
        for file_id in all_file_ids:
            kw_score = keyword_scores.get(file_id, 0)
            sem_score = semantic_scores.get(file_id, 0)

            hybrid_score = (keyword_weight * kw_score) + (semantic_weight * sem_score)

            # Find original result data
            original = next(
                (r for r in keyword_results if (r.get('id') or str(r.get('file_id', ''))) == file_id),
                None
            )

            result = {
                'id': file_id,
                'hybrid_score': hybrid_score,
                'keyword_score': kw_score,
                'semantic_score': sem_score,
            }

            # Merge with original result data if available
            if original:
                result.update({
                    k: v for k, v in original.items()
                    if k not in ['score', 'hybrid_score', 'keyword_score', 'semantic_score']
                })

            hybrid_results.append(result)

        # Sort by hybrid score
        hybrid_results.sort(key=lambda x: x['hybrid_score'], reverse=True)

        return hybrid_results[:top_k]

    # ========================================================================
    # File Text Extraction
    # ========================================================================

    def build_searchable_text(
        self,
        file_name: str,
        tags: List[str] = None,
        description: str = None,
        ocr_text: str = None,
        ai_tags: List[str] = None
    ) -> str:
        """
        Build combined searchable text for embedding generation.

        Args:
            file_name: File name (required)
            tags: User-assigned tags
            description: File description
            ocr_text: Extracted text from OCR
            ai_tags: AI-generated tags

        Returns:
            Combined text for embedding
        """
        parts = []

        # File name (most important)
        if file_name:
            # Remove extension and clean
            name_clean = file_name.rsplit('.', 1)[0].replace('_', ' ').replace('-', ' ')
            parts.append(name_clean)

        # Tags
        if tags:
            parts.extend(tags)

        # AI tags
        if ai_tags:
            parts.extend(ai_tags)

        # Description
        if description:
            parts.append(description)

        # OCR text (truncate if too long)
        if ocr_text:
            ocr_truncated = ocr_text[:1000]  # Limit to first 1000 chars
            parts.append(ocr_truncated)

        return ' '.join(parts)


# Global instance
embedding_service = EmbeddingService()
