"""
Unit Tests for Quota Analytics API Endpoints
Tests REST API endpoints for quota prediction and alerts
"""

import pytest
from datetime import datetime, timedelta
from fastapi import status


class TestQuotaAnalyticsAPI:
    """Test suite for Quota Analytics API endpoints."""

    def test_get_quota_prediction(
        self, api_client, mock_user, mock_quota_prediction
    ):
        """Test GET /api/quota-analytics/prediction endpoint."""
        response = api_client.get(
            f"/api/quota-analytics/prediction?user_id={mock_user.id}"
        )

        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert "predicted_usage_bytes" in data
        assert "confidence_score" in data
        assert "prediction_date" in data
        assert data["predicted_usage_bytes"] > 0

    def test_get_quota_history(self, api_client, mock_user, mock_usage_history):
        """Test GET /api/quota-analytics/history endpoint."""
        response = api_client.get(
            f"/api/quota-analytics/history?user_id={mock_user.id}&days=30"
        )

        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert "history" in data
        assert len(data["history"]) > 0
        assert all("used_bytes" in h for h in data["history"])
        assert all("recorded_at" in h for h in data["history"])

    def test_get_quota_alerts(self, api_client, mock_user, mock_quota_alert):
        """Test GET /api/quota-analytics/alerts endpoint."""
        response = api_client.get(
            f"/api/quota-analytics/alerts?user_id={mock_user.id}"
        )

        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert "alerts" in data
        assert len(data["alerts"]) > 0
        for alert in data["alerts"]:
            assert "alert_type" in alert
            assert "severity" in alert
            assert "message" in alert

    def test_get_quota_stats(self, api_client, mock_user):
        """Test GET /api/quota-analytics/stats endpoint."""
        response = api_client.get(
            f"/api/quota-analytics/stats?user_id={mock_user.id}"
        )

        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert "current_usage_bytes" in data
        assert "quota_bytes" in data
        assert "usage_percentage" in data
        assert 0 <= data["usage_percentage"] <= 100

    def test_dismiss_alert(self, api_client, mock_user, mock_quota_alert):
        """Test POST /api/quota-analytics/alerts/{id}/dismiss endpoint."""
        response = api_client.post(
            f"/api/quota-analytics/alerts/{mock_quota_alert.id}/dismiss"
        )

        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["dismissed"] is True

    def test_prediction_with_invalid_user(self, api_client):
        """Test prediction endpoint with non-existent user."""
        response = api_client.get(
            "/api/quota-analytics/prediction?user_id=99999"
        )

        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_prediction_caching(self, api_client, mock_user, mock_quota_prediction):
        """Test that predictions are cached for performance."""
        # First request
        response1 = api_client.get(
            f"/api/quota-analytics/prediction?user_id={mock_user.id}"
        )
        # Second request (should be cached)
        response2 = api_client.get(
            f"/api/quota-analytics/prediction?user_id={mock_user.id}"
        )

        assert response1.status_code == status.HTTP_200_OK
        assert response2.status_code == status.HTTP_200_OK
        # Results should be identical (from cache)
        assert response1.json() == response2.json()
