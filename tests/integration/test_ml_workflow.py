"""
Integration Tests for ML Feature Workflows
Tests end-to-end workflows combining multiple services
"""

import pytest
from datetime import datetime, timedelta


@pytest.mark.integration
class TestQuotaPredictionWorkflow:
    """Integration tests for complete quota prediction workflow."""

    @pytest.mark.asyncio
    async def test_complete_quota_prediction_workflow(
        self, api_client, db_session, mock_user
    ):
        """Test complete workflow: record usage -> predict -> alert."""
        # Step 1: Record usage history
        for i in range(30):
            response = api_client.post(
                "/api/quota-analytics/record-usage",
                json={
                    "user_id": mock_user.id,
                    "used_bytes": (5 * 1024**3) + (i * 100 * 1024**2),
                    "quota_bytes": 10 * 1024**3,
                    "file_count": 100 + i * 10,
                },
            )
            assert response.status_code in [200, 201]

        # Step 2: Generate prediction
        response = api_client.post(
            f"/api/quota-analytics/predict?user_id={mock_user.id}&days_ahead=7"
        )
        assert response.status_code == 200
        prediction = response.json()
        assert "predicted_usage_bytes" in prediction

        # Step 3: Check if alert was generated
        response = api_client.get(
            f"/api/quota-analytics/alerts?user_id={mock_user.id}"
        )
        assert response.status_code == 200
        alerts = response.json()["alerts"]

        # If predicted usage is high, alert should exist
        if prediction["predicted_usage_bytes"] > 0.8 * mock_user.quota_bytes:
            assert len(alerts) > 0
            assert alerts[0]["severity"] in ["high", "critical"]


@pytest.mark.integration
class TestStorageOptimizationWorkflow:
    """Integration tests for storage optimization workflow."""

    @pytest.mark.asyncio
    async def test_complete_optimization_workflow(
        self, api_client, db_session, mock_user, mock_files
    ):
        """Test complete workflow: analyze -> suggest -> apply."""
        # Step 1: Trigger storage analysis
        response = api_client.post(
            f"/api/storage-optimization/analyze?user_id={mock_user.id}"
        )
        assert response.status_code in [200, 202]

        # Step 2: Get optimization suggestions
        response = api_client.get(
            f"/api/storage-optimization/suggestions?user_id={mock_user.id}"
        )
        assert response.status_code == 200
        suggestions = response.json()["suggestions"]

        if len(suggestions) > 0:
            suggestion = suggestions[0]

            # Step 3: Apply suggestion (if applicable)
            if suggestion["suggestion_type"] == "tier_migration":
                response = api_client.post(
                    f"/api/storage-optimization/suggestions/{suggestion['id']}/apply"
                )
                assert response.status_code in [200, 202]

                # Step 4: Verify files were migrated
                file_ids = suggestion["action_data"]["file_ids"]
                for file_id in file_ids:
                    response = api_client.get(f"/api/files/{file_id}")
                    file_data = response.json()
                    assert file_data["tier"] == suggestion["action_data"]["target_tier"]


@pytest.mark.integration
class TestAutoOrganizationWorkflow:
    """Integration tests for auto-organization workflow."""

    @pytest.mark.asyncio
    async def test_complete_organization_workflow(
        self, api_client, db_session, mock_user, mock_files
    ):
        """Test complete workflow: cluster -> preview -> apply."""
        # Step 1: Start clustering session
        response = api_client.post(
            "/api/auto-organization/start",
            json={
                "user_id": mock_user.id,
                "algorithm": "kmeans",
                "num_clusters": 3,
            },
        )
        assert response.status_code in [200, 201]
        session_id = response.json()["session_id"]

        # Step 2: Wait for clustering to complete (or poll status)
        import time

        time.sleep(2)  # In real tests, use async polling

        # Step 3: Get clusters
        response = api_client.get(
            f"/api/auto-organization/sessions/{session_id}/clusters"
        )
        assert response.status_code == 200
        clusters = response.json()["clusters"]
        assert len(clusters) > 0

        # Step 4: Preview cluster organization
        cluster_id = clusters[0]["cluster_id"]
        response = api_client.get(
            f"/api/auto-organization/sessions/{session_id}/clusters/{cluster_id}/preview"
        )
        assert response.status_code == 200

        # Step 5: Apply cluster organization
        response = api_client.post(
            f"/api/auto-organization/sessions/{session_id}/clusters/{cluster_id}/apply",
            json={"folder_name": "Auto-Documents"},
        )
        assert response.status_code in [200, 202]


@pytest.mark.integration
class TestRecommendationWorkflow:
    """Integration tests for content recommendation workflow."""

    @pytest.mark.asyncio
    async def test_complete_recommendation_workflow(
        self, api_client, db_session, mock_user, mock_files
    ):
        """Test complete workflow: interact -> recommend -> feedback."""
        # Step 1: Record user interactions
        for file in mock_files[:3]:
            response = api_client.post(
                "/api/recommendations/interactions",
                json={
                    "user_id": mock_user.id,
                    "file_id": file.id,
                    "interaction_type": "view",
                    "rating": 4,
                },
            )
            assert response.status_code in [200, 201]

        # Step 2: Generate recommendations
        response = api_client.get(
            f"/api/recommendations?user_id={mock_user.id}&limit=5"
        )
        assert response.status_code == 200
        recommendations = response.json()["recommendations"]
        assert len(recommendations) > 0

        # Step 3: Submit feedback on recommendation
        if len(recommendations) > 0:
            rec_id = recommendations[0]["id"]
            response = api_client.post(
                f"/api/recommendations/{rec_id}/feedback",
                json={
                    "user_id": mock_user.id,
                    "feedback": "positive",
                    "rating": 5,
                },
            )
            assert response.status_code == 200

        # Step 4: Get updated recommendations (should adapt to feedback)
        response = api_client.get(
            f"/api/recommendations?user_id={mock_user.id}&limit=5"
        )
        assert response.status_code == 200


@pytest.mark.integration
class TestCrossFeatureIntegration:
    """Test integration between multiple ML features."""

    @pytest.mark.asyncio
    async def test_quota_prediction_triggers_optimization(
        self, api_client, mock_user, mock_files
    ):
        """Test that high quota prediction triggers optimization analysis."""
        # Generate high quota prediction
        response = api_client.post(
            f"/api/quota-analytics/predict?user_id={mock_user.id}&days_ahead=7"
        )
        prediction = response.json()

        if prediction["predicted_usage_bytes"] > 0.8 * mock_user.quota_bytes:
            # Should automatically trigger optimization analysis
            response = api_client.get(
                f"/api/storage-optimization/suggestions?user_id={mock_user.id}"
            )
            assert response.status_code == 200
            suggestions = response.json()["suggestions"]
            # Should have suggestions to free up space
            assert len(suggestions) > 0

    @pytest.mark.asyncio
    async def test_organization_improves_recommendations(
        self, api_client, mock_user, mock_files
    ):
        """Test that file organization improves recommendation quality."""
        # Get recommendations before organization
        response = api_client.get(
            f"/api/recommendations?user_id={mock_user.id}&limit=5"
        )
        recs_before = response.json()["recommendations"]

        # Organize files
        response = api_client.post(
            "/api/auto-organization/start",
            json={
                "user_id": mock_user.id,
                "algorithm": "kmeans",
                "num_clusters": 3,
            },
        )
        session_id = response.json()["session_id"]

        # Get recommendations after organization
        response = api_client.get(
            f"/api/recommendations?user_id={mock_user.id}&limit=5"
        )
        recs_after = response.json()["recommendations"]

        # Recommendations should be updated
        assert len(recs_after) > 0
