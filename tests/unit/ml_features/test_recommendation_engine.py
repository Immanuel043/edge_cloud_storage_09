"""
Unit Tests for Content Recommendation Engine
Tests hybrid recommendation algorithms (content-based + collaborative filtering)
"""

import pytest
from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch
import numpy as np

from app.services.recommendation_engine import RecommendationEngine
from app.models import Recommendation, UserInteraction, File


class TestRecommendationEngine:
    """Test suite for RecommendationEngine service."""

    @pytest.fixture
    def rec_engine(self, db_session, mock_settings):
        """Create a RecommendationEngine instance for testing."""
        return RecommendationEngine(db=db_session, settings=mock_settings)

    def test_engine_initialization(self, rec_engine):
        """Test that RecommendationEngine initializes correctly."""
        assert rec_engine is not None
        assert rec_engine.db is not None

    @pytest.mark.asyncio
    async def test_generate_recommendations_hybrid(
        self, rec_engine, mock_user, mock_files, mock_user_interaction
    ):
        """Test hybrid recommendation generation."""
        recommendations = await rec_engine.generate_recommendations(
            user_id=mock_user.id, limit=5
        )

        assert recommendations is not None
        assert isinstance(recommendations, list)
        assert len(recommendations) <= 5

        for rec in recommendations:
            assert "file_id" in rec
            assert "score" in rec
            assert "reason" in rec
            assert "algorithm" in rec
            assert 0 <= rec["score"] <= 1

    @pytest.mark.asyncio
    async def test_content_based_recommendations(
        self, rec_engine, mock_user, mock_files, db_session
    ):
        """Test content-based filtering recommendations."""
        # User recently accessed a PDF file
        recent_interaction = UserInteraction(
            user_id=mock_user.id,
            file_id=mock_files[0].id,  # PDF file
            interaction_type="view",
            rating=5,
            created_at=datetime.utcnow(),
        )
        db_session.add(recent_interaction)
        db_session.commit()

        recommendations = await rec_engine._generate_content_based(
            user_id=mock_user.id, limit=3
        )

        assert recommendations is not None
        assert len(recommendations) > 0
        # Should recommend similar files (same type, similar name)

    @pytest.mark.asyncio
    async def test_collaborative_filtering_user_based(
        self, rec_engine, mock_users, mock_files, db_session
    ):
        """Test user-based collaborative filtering."""
        # Create interactions for multiple users
        # User 1 and User 2 have similar tastes
        interactions = [
            UserInteraction(
                user_id=mock_users[0].id,
                file_id=mock_files[i].id,
                interaction_type="view",
                rating=5,
                created_at=datetime.utcnow(),
            )
            for i in range(3)
        ] + [
            UserInteraction(
                user_id=mock_users[1].id,
                file_id=mock_files[i].id,
                interaction_type="view",
                rating=5,
                created_at=datetime.utcnow(),
            )
            for i in range(3)
        ]
        db_session.add_all(interactions)
        db_session.commit()

        recommendations = await rec_engine._generate_collaborative(
            user_id=mock_users[0].id, limit=5
        )

        assert recommendations is not None

    @pytest.mark.asyncio
    async def test_collaborative_filtering_item_based(
        self, rec_engine, mock_users, mock_files, db_session
    ):
        """Test item-based collaborative filtering."""
        # Multiple users viewed the same files
        interactions = []
        for user in mock_users[:3]:
            for file in mock_files[:2]:
                interactions.append(
                    UserInteraction(
                        user_id=user.id,
                        file_id=file.id,
                        interaction_type="view",
                        rating=4,
                        created_at=datetime.utcnow(),
                    )
                )
        db_session.add_all(interactions)
        db_session.commit()

        # Files viewed together should be recommended together
        similar_files = await rec_engine._find_similar_files_item_based(
            file_id=mock_files[0].id, limit=3
        )

        assert similar_files is not None

    @pytest.mark.asyncio
    async def test_trending_recommendations(
        self, rec_engine, mock_users, mock_files, db_session
    ):
        """Test trending files recommendations."""
        # Create many recent interactions for specific files
        trending_file = mock_files[0]
        interactions = [
            UserInteraction(
                user_id=mock_users[i % len(mock_users)].id,
                file_id=trending_file.id,
                interaction_type="view",
                rating=4,
                created_at=datetime.utcnow() - timedelta(hours=i),
            )
            for i in range(20)  # 20 views in last 20 hours
        ]
        db_session.add_all(interactions)
        db_session.commit()

        trending = await rec_engine._generate_trending(limit=5)

        assert trending is not None
        assert len(trending) > 0
        # Trending file should be in top results
        trending_ids = [t["file_id"] for t in trending]
        assert trending_file.id in trending_ids

    @pytest.mark.asyncio
    async def test_hybrid_algorithm_weighting(
        self, rec_engine, mock_user, mock_files
    ):
        """Test that hybrid algorithm properly weights different sources."""
        # Mock individual algorithm results
        content_based_recs = [
            {"file_id": 1, "score": 0.9, "algorithm": "content_based"}
        ]
        collaborative_recs = [
            {"file_id": 2, "score": 0.8, "algorithm": "collaborative"}
        ]
        trending_recs = [
            {"file_id": 3, "score": 0.7, "algorithm": "trending"}
        ]

        hybrid_recs = rec_engine._generate_hybrid(
            content_based=content_based_recs,
            collaborative=collaborative_recs,
            trending=trending_recs,
        )

        assert hybrid_recs is not None
        assert len(hybrid_recs) == 3
        # Scores should be weighted combination

    @pytest.mark.asyncio
    async def test_submit_feedback(
        self, rec_engine, mock_user, mock_file, mock_recommendation
    ):
        """Test submitting user feedback on recommendations."""
        result = await rec_engine.submit_feedback(
            user_id=mock_user.id,
            recommendation_id=mock_recommendation.id,
            feedback="positive",
            rating=5,
        )

        assert result is not None
        assert result["feedback"] == "positive"
        assert result["rating"] == 5

    @pytest.mark.asyncio
    async def test_recommendation_diversity(
        self, rec_engine, mock_user, mock_files
    ):
        """Test that recommendations include diverse content."""
        recommendations = await rec_engine.generate_recommendations(
            user_id=mock_user.id, limit=10, diversity=True
        )

        if len(recommendations) > 0:
            # Check that recommendations include different file types
            file_types = [r.get("file_type") for r in recommendations]
            unique_types = len(set(file_types))
            assert unique_types > 1  # Should have variety

    @pytest.mark.asyncio
    async def test_cold_start_problem_new_user(
        self, rec_engine, db_session
    ):
        """Test recommendations for new user with no history (cold start)."""
        from app.models import User

        new_user = User(
            id=999,
            username="newuser",
            email="new@example.com",
            quota_bytes=10 * 1024**3,
            used_bytes=0,
            created_at=datetime.utcnow(),
        )
        db_session.add(new_user)
        db_session.commit()

        recommendations = await rec_engine.generate_recommendations(
            user_id=new_user.id, limit=5
        )

        # Should fall back to trending/popular content
        assert recommendations is not None
        if len(recommendations) > 0:
            assert all(r["algorithm"] == "trending" for r in recommendations)

    @pytest.mark.asyncio
    async def test_cold_start_problem_new_item(
        self, rec_engine, mock_user, db_session
    ):
        """Test recommendations for new file with no interactions."""
        new_file = File(
            id=9999,
            user_id=mock_user.id,
            filename="brand_new.pdf",
            original_filename="brand_new.pdf",
            file_path="/storage/brand_new.pdf",
            size=1024 * 1024,
            mime_type="application/pdf",
            tier="hot",
            created_at=datetime.utcnow(),
            last_accessed=datetime.utcnow(),
        )
        db_session.add(new_file)
        db_session.commit()

        # Content-based should still work for new items
        similar = await rec_engine.find_similar_files(
            file_id=new_file.id, limit=5
        )

        assert similar is not None

    @pytest.mark.asyncio
    async def test_recommendation_filtering(
        self, rec_engine, mock_user, mock_files
    ):
        """Test filtering out already accessed files."""
        recommendations = await rec_engine.generate_recommendations(
            user_id=mock_user.id,
            limit=5,
            exclude_accessed=True,
        )

        # Should not recommend files user already accessed
        for rec in recommendations:
            assert rec["file_id"] not in [f.id for f in mock_files]

    def test_calculate_tfidf_similarity(self, rec_engine):
        """Test TF-IDF similarity calculation."""
        text1 = "machine learning data science"
        text2 = "machine learning artificial intelligence"
        text3 = "cooking recipes food"

        # Similar texts should have high similarity
        sim_12 = rec_engine._calculate_similarity(text1, text2)
        sim_13 = rec_engine._calculate_similarity(text1, text3)

        assert sim_12 > sim_13  # text1 and text2 are more similar

    def test_calculate_user_similarity(self, rec_engine):
        """Test user similarity calculation (cosine similarity)."""
        # User 1 ratings: [5, 4, 0, 0, 3]
        # User 2 ratings: [5, 5, 0, 0, 2]
        # User 3 ratings: [0, 0, 5, 4, 5]

        user1_vector = np.array([5, 4, 0, 0, 3])
        user2_vector = np.array([5, 5, 0, 0, 2])
        user3_vector = np.array([0, 0, 5, 4, 5])

        # User 1 and 2 should be very similar
        sim_12 = rec_engine._cosine_similarity(user1_vector, user2_vector)
        # User 1 and 3 should be dissimilar
        sim_13 = rec_engine._cosine_similarity(user1_vector, user3_vector)

        assert sim_12 > 0.8  # High similarity
        assert sim_13 < 0.3  # Low similarity


@pytest.mark.ml
@pytest.mark.unit
class TestRecommendationAlgorithms:
    """Test individual recommendation algorithms in detail."""

    def test_content_based_tfidf_vectorization(self):
        """Test TF-IDF vectorization for content-based filtering."""
        documents = [
            "data science machine learning",
            "machine learning deep learning",
            "cooking recipes italian food",
        ]

        # Create TF-IDF vectors
        from sklearn.feature_extraction.text import TfidfVectorizer

        vectorizer = TfidfVectorizer()
        vectors = vectorizer.fit_transform(documents)

        assert vectors.shape[0] == 3
        assert vectors.shape[1] > 0  # Has vocabulary

    def test_collaborative_filtering_matrix_factorization(self):
        """Test matrix factorization for collaborative filtering."""
        # User-Item interaction matrix
        # Rows: users, Columns: items, Values: ratings
        R = np.array([
            [5, 4, 0, 0],
            [4, 0, 0, 1],
            [0, 1, 5, 4],
            [0, 0, 4, 5],
        ])

        # This would test SVD or NMF for matrix factorization
        # To predict missing ratings
        pass

    def test_recommendation_score_normalization(self):
        """Test score normalization across different algorithms."""
        scores = [0.95, 0.23, 0.67, 0.12, 0.89]

        # Min-max normalization to [0, 1]
        normalized = [
            (s - min(scores)) / (max(scores) - min(scores)) for s in scores
        ]

        assert min(normalized) == 0.0
        assert max(normalized) == 1.0
        assert all(0 <= s <= 1 for s in normalized)

    def test_popularity_bias_mitigation(self):
        """Test mitigation of popularity bias in recommendations."""
        # Popular items shouldn't dominate recommendations
        # Use diversity metrics or re-ranking
        pass
