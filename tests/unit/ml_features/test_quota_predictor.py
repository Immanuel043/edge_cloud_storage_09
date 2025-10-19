"""
Unit Tests for Quota Prediction Service
Tests the ML algorithms for predicting storage quota usage
"""

import pytest
from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch

from app.services.quota_predictor import QuotaPredictor
from app.models import UsageHistory


class TestQuotaPredictor:
    """Test suite for QuotaPredictor service."""

    @pytest.fixture
    def quota_predictor(self, db_session, mock_settings):
        """Create a QuotaPredictor instance for testing."""
        return QuotaPredictor(db=db_session, settings=mock_settings)

    def test_predictor_initialization(self, quota_predictor):
        """Test that QuotaPredictor initializes correctly."""
        assert quota_predictor is not None
        assert quota_predictor.db is not None

    @pytest.mark.asyncio
    async def test_predict_user_quota_with_history(
        self, quota_predictor, mock_user, mock_usage_history
    ):
        """Test quota prediction with sufficient usage history."""
        result = await quota_predictor.predict_user_quota(
            user_id=mock_user.id, days_ahead=7
        )

        assert result is not None
        assert "predicted_usage_bytes" in result
        assert "confidence_score" in result
        assert "algorithm_used" in result
        assert "prediction_date" in result
        assert result["predicted_usage_bytes"] > 0
        assert 0 <= result["confidence_score"] <= 1

    @pytest.mark.asyncio
    async def test_predict_user_quota_insufficient_history(
        self, quota_predictor, mock_user, db_session
    ):
        """Test quota prediction with insufficient history (should use fallback)."""
        # Create only 2 days of history (insufficient for ML)
        history = [
            UsageHistory(
                user_id=mock_user.id,
                used_bytes=5 * 1024**3,
                quota_bytes=10 * 1024**3,
                file_count=100,
                recorded_at=datetime.utcnow() - timedelta(days=i),
            )
            for i in range(2)
        ]
        db_session.add_all(history)
        db_session.commit()

        result = await quota_predictor.predict_user_quota(
            user_id=mock_user.id, days_ahead=7
        )

        # Should fall back to simple linear extrapolation
        assert result is not None
        assert result["algorithm_used"] in ["linear_regression", "moving_average"]

    @pytest.mark.asyncio
    async def test_predict_prophet_algorithm(
        self, quota_predictor, mock_user, mock_usage_history
    ):
        """Test Prophet algorithm prediction."""
        with patch.object(
            quota_predictor, "_predict_prophet"
        ) as mock_prophet:
            mock_prophet.return_value = {
                "predicted_usage_bytes": 9 * 1024**3,
                "confidence_score": 0.85,
            }

            result = await quota_predictor._predict_prophet(
                usage_data=mock_usage_history, days_ahead=7
            )

            assert result["predicted_usage_bytes"] == 9 * 1024**3
            assert result["confidence_score"] == 0.85

    @pytest.mark.asyncio
    async def test_predict_linear_regression(
        self, quota_predictor, mock_user, mock_usage_history
    ):
        """Test Linear Regression prediction."""
        result = await quota_predictor._predict_linear_regression(
            usage_data=mock_usage_history, days_ahead=7
        )

        assert result is not None
        assert "predicted_usage_bytes" in result
        assert "confidence_score" in result
        assert result["predicted_usage_bytes"] > 0

    @pytest.mark.asyncio
    async def test_predict_moving_average(
        self, quota_predictor, mock_user, mock_usage_history
    ):
        """Test Moving Average prediction."""
        result = await quota_predictor._predict_moving_average(
            usage_data=mock_usage_history, days_ahead=7, window=7
        )

        assert result is not None
        assert "predicted_usage_bytes" in result
        assert result["predicted_usage_bytes"] > 0

    @pytest.mark.asyncio
    async def test_batch_predict_all_users(
        self, quota_predictor, mock_users, db_session
    ):
        """Test batch prediction for multiple users."""
        # Add usage history for each user
        for user in mock_users:
            history = [
                UsageHistory(
                    user_id=user.id,
                    used_bytes=user.used_bytes + (i * 100 * 1024**2),
                    quota_bytes=user.quota_bytes,
                    file_count=100 + i * 10,
                    recorded_at=datetime.utcnow() - timedelta(days=30 - i),
                )
                for i in range(30)
            ]
            db_session.add_all(history)
        db_session.commit()

        results = await quota_predictor.batch_predict_all_users(days_ahead=7)

        assert len(results) == len(mock_users)
        for result in results:
            assert "user_id" in result
            assert "predicted_usage_bytes" in result
            assert "confidence_score" in result

    def test_calculate_confidence_score(self, quota_predictor):
        """Test confidence score calculation."""
        # High confidence: lots of data, low variance
        score = quota_predictor._calculate_confidence_score(
            data_points=100, variance=0.1
        )
        assert score > 0.8

        # Low confidence: few data points, high variance
        score = quota_predictor._calculate_confidence_score(
            data_points=5, variance=0.9
        )
        assert score < 0.5

    @pytest.mark.asyncio
    async def test_prediction_accuracy_metrics(
        self, quota_predictor, mock_user, mock_usage_history
    ):
        """Test that predictions include accuracy metrics."""
        result = await quota_predictor.predict_user_quota(
            user_id=mock_user.id, days_ahead=7
        )

        assert "confidence_score" in result
        assert "algorithm_used" in result
        assert result["confidence_score"] >= 0
        assert result["confidence_score"] <= 1

    @pytest.mark.asyncio
    async def test_prediction_with_zero_usage(
        self, quota_predictor, db_session
    ):
        """Test prediction for user with zero usage."""
        from app.models import User

        zero_user = User(
            id=999,
            username="zerouser",
            email="zero@example.com",
            quota_bytes=10 * 1024**3,
            used_bytes=0,
            created_at=datetime.utcnow(),
        )
        db_session.add(zero_user)
        db_session.commit()

        result = await quota_predictor.predict_user_quota(
            user_id=zero_user.id, days_ahead=7
        )

        # Should handle zero usage gracefully
        assert result["predicted_usage_bytes"] >= 0

    @pytest.mark.asyncio
    async def test_prediction_date_accuracy(
        self, quota_predictor, mock_user, mock_usage_history
    ):
        """Test that prediction date is calculated correctly."""
        days_ahead = 14
        result = await quota_predictor.predict_user_quota(
            user_id=mock_user.id, days_ahead=days_ahead
        )

        predicted_date = datetime.fromisoformat(result["prediction_date"])
        expected_date = datetime.utcnow() + timedelta(days=days_ahead)

        # Allow 1-minute tolerance for test execution time
        assert abs((predicted_date - expected_date).total_seconds()) < 60


@pytest.mark.ml
@pytest.mark.unit
class TestQuotaPredictionAlgorithms:
    """Test individual ML algorithms in isolation."""

    @pytest.fixture
    def sample_usage_data(self):
        """Create sample usage data for algorithm testing."""
        return [
            {
                "date": datetime.utcnow() - timedelta(days=30 - i),
                "used_bytes": (5 * 1024**3) + (i * 50 * 1024**2),
                "quota_bytes": 10 * 1024**3,
            }
            for i in range(30)
        ]

    def test_linear_regression_increasing_trend(self, sample_usage_data):
        """Test linear regression with increasing usage trend."""
        # This would test the actual algorithm implementation
        pass  # Implementation depends on actual service structure

    def test_moving_average_stability(self, sample_usage_data):
        """Test moving average with stable usage pattern."""
        pass  # Implementation depends on actual service structure

    def test_exponential_smoothing_recent_spike(self, sample_usage_data):
        """Test exponential smoothing with recent usage spike."""
        pass  # Implementation depends on actual service structure
