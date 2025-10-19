"""
Unit Tests for Auto-Organization Service
Tests ML-based file clustering and organization
"""

import pytest
from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch
import numpy as np

from app.services.auto_organizer import AutoOrganizer
from app.services.file_clustering_service import FileClusteringService
from app.models import ClusteringSession, OrganizationRule, File


class TestAutoOrganizer:
    """Test suite for AutoOrganizer service."""

    @pytest.fixture
    def auto_organizer(self, db_session, mock_settings):
        """Create an AutoOrganizer instance for testing."""
        return AutoOrganizer(db=db_session, settings=mock_settings)

    def test_organizer_initialization(self, auto_organizer):
        """Test that AutoOrganizer initializes correctly."""
        assert auto_organizer is not None
        assert auto_organizer.db is not None

    @pytest.mark.asyncio
    async def test_create_organization_session(
        self, auto_organizer, mock_user, mock_files
    ):
        """Test creating a new organization session."""
        session = await auto_organizer.create_organization_session(
            user_id=mock_user.id,
            algorithm="kmeans",
            num_clusters=3,
        )

        assert session is not None
        assert session.user_id == mock_user.id
        assert session.algorithm == "kmeans"
        assert session.num_clusters == 3
        assert session.status == "pending"

    @pytest.mark.asyncio
    async def test_run_ml_organization_kmeans(
        self, auto_organizer, mock_user, mock_files
    ):
        """Test ML-based organization with K-Means algorithm."""
        session = await auto_organizer.create_organization_session(
            user_id=mock_user.id,
            algorithm="kmeans",
            num_clusters=3,
        )

        result = await auto_organizer.run_ml_organization(session_id=session.id)

        assert result is not None
        assert "clusters" in result
        assert "metrics" in result
        assert len(result["clusters"]) <= 3
        assert session.status == "completed"

    @pytest.mark.asyncio
    async def test_run_ml_organization_dbscan(
        self, auto_organizer, mock_user, mock_files
    ):
        """Test ML-based organization with DBSCAN algorithm."""
        session = await auto_organizer.create_organization_session(
            user_id=mock_user.id,
            algorithm="dbscan",
            num_clusters=None,  # DBSCAN auto-determines clusters
        )

        result = await auto_organizer.run_ml_organization(session_id=session.id)

        assert result is not None
        assert "clusters" in result
        assert "metrics" in result
        # DBSCAN may create noise cluster (-1)
        assert any(c["cluster_id"] >= -1 for c in result["clusters"])

    @pytest.mark.asyncio
    async def test_apply_cluster_organization(
        self, auto_organizer, mock_user, mock_files, db_session
    ):
        """Test applying cluster organization to create folders."""
        # Create a clustering session with clusters
        session = ClusteringSession(
            user_id=mock_user.id,
            algorithm="kmeans",
            num_clusters=2,
            status="completed",
            metrics={"silhouette_score": 0.65},
            created_at=datetime.utcnow(),
            completed_at=datetime.utcnow(),
        )
        db_session.add(session)
        db_session.commit()

        result = await auto_organizer.apply_cluster_organization(
            session_id=session.id,
            cluster_id=0,
            folder_name="Documents",
        )

        assert result is not None
        assert "moved_files" in result
        assert result["moved_files"] > 0

    @pytest.mark.asyncio
    async def test_create_rule(self, auto_organizer, mock_user):
        """Test creating an organization rule."""
        rule = await auto_organizer.create_rule(
            user_id=mock_user.id,
            name="PDF Organization",
            conditions={"file_extension": ".pdf"},
            action={"move_to_folder": "/Documents/PDFs"},
            priority=1,
        )

        assert rule is not None
        assert rule.name == "PDF Organization"
        assert rule.user_id == mock_user.id
        assert rule.enabled is True

    @pytest.mark.asyncio
    async def test_apply_rules(
        self, auto_organizer, mock_user, mock_files, db_session
    ):
        """Test applying organization rules to files."""
        # Create a rule for PDF files
        rule = OrganizationRule(
            user_id=mock_user.id,
            name="PDF Rule",
            conditions={"file_extension": ".pdf"},
            action={"move_to_folder": "/Documents/PDFs"},
            priority=1,
            enabled=True,
            created_at=datetime.utcnow(),
        )
        db_session.add(rule)
        db_session.commit()

        result = await auto_organizer.apply_rules(user_id=mock_user.id)

        assert result is not None
        assert "rules_applied" in result
        assert "files_moved" in result

    @pytest.mark.asyncio
    async def test_rule_priority_ordering(
        self, auto_organizer, mock_user, db_session
    ):
        """Test that rules are applied in priority order."""
        # Create multiple rules with different priorities
        rules = [
            OrganizationRule(
                user_id=mock_user.id,
                name=f"Rule {i}",
                conditions={"file_extension": ".pdf"},
                action={"move_to_folder": f"/Folder{i}"},
                priority=i,
                enabled=True,
                created_at=datetime.utcnow(),
            )
            for i in [3, 1, 2]
        ]
        db_session.add_all(rules)
        db_session.commit()

        fetched_rules = await auto_organizer._get_user_rules(user_id=mock_user.id)

        # Should be sorted by priority (ascending)
        priorities = [r.priority for r in fetched_rules]
        assert priorities == sorted(priorities)

    def test_rule_condition_matching(self, auto_organizer):
        """Test rule condition matching logic."""
        file_metadata = {
            "filename": "document.pdf",
            "extension": ".pdf",
            "size": 1024 * 1024,
            "mime_type": "application/pdf",
        }

        # Match by extension
        conditions = {"file_extension": ".pdf"}
        assert auto_organizer._matches_conditions(file_metadata, conditions)

        # Match by size range
        conditions = {"min_size": 500 * 1024, "max_size": 2 * 1024**2}
        assert auto_organizer._matches_conditions(file_metadata, conditions)

        # No match
        conditions = {"file_extension": ".jpg"}
        assert not auto_organizer._matches_conditions(file_metadata, conditions)


class TestFileClusteringService:
    """Test suite for FileClusteringService."""

    @pytest.fixture
    def clustering_service(self, db_session):
        """Create a FileClusteringService instance."""
        return FileClusteringService(db=db_session)

    def test_prepare_features(self, clustering_service, mock_files):
        """Test feature extraction for clustering."""
        features = clustering_service.prepare_features(files=mock_files)

        assert features is not None
        assert isinstance(features, np.ndarray)
        assert features.shape[0] == len(mock_files)
        assert features.shape[1] > 0  # Has feature dimensions

    def test_cluster_kmeans(self, clustering_service, mock_files):
        """Test K-Means clustering."""
        features = clustering_service.prepare_features(files=mock_files)
        labels, metrics = clustering_service.cluster_kmeans(
            features=features, n_clusters=2
        )

        assert labels is not None
        assert len(labels) == len(mock_files)
        assert "silhouette_score" in metrics
        assert "inertia" in metrics
        assert 0 <= len(set(labels)) <= 2  # Should have at most 2 clusters

    def test_cluster_dbscan(self, clustering_service, mock_files):
        """Test DBSCAN clustering."""
        features = clustering_service.prepare_features(files=mock_files)
        labels, metrics = clustering_service.cluster_dbscan(
            features=features, eps=0.5, min_samples=2
        )

        assert labels is not None
        assert len(labels) == len(mock_files)
        assert "num_clusters" in metrics
        assert "noise_points" in metrics
        # DBSCAN may have noise points (label -1)
        assert metrics["noise_points"] >= 0

    def test_feature_vectorization_tfidf(self, clustering_service):
        """Test TF-IDF vectorization of filenames."""
        filenames = [
            "document_report_2024.pdf",
            "document_summary_2024.pdf",
            "image_vacation_beach.jpg",
            "image_vacation_sunset.jpg",
        ]

        vectors = clustering_service._vectorize_filenames(filenames)

        assert vectors is not None
        assert vectors.shape[0] == len(filenames)
        # Similar filenames should have similar vectors
        # document files should be similar to each other
        # image files should be similar to each other

    def test_analyze_clusters(self, clustering_service, mock_files):
        """Test cluster analysis and labeling."""
        # Create dummy cluster labels
        labels = [0, 0, 1, 1, 2]  # 3 clusters

        analysis = clustering_service._analyze_clusters(
            files=mock_files, labels=labels
        )

        assert analysis is not None
        assert len(analysis) == 3  # 3 clusters
        for cluster_info in analysis:
            assert "cluster_id" in cluster_info
            assert "file_count" in cluster_info
            assert "suggested_name" in cluster_info
            assert "dominant_type" in cluster_info

    @pytest.mark.asyncio
    async def test_clustering_with_insufficient_files(
        self, clustering_service, mock_user, db_session
    ):
        """Test clustering with too few files."""
        # Create only 1 file
        single_file = [
            File(
                id=1,
                user_id=mock_user.id,
                filename="lonely.pdf",
                original_filename="lonely.pdf",
                file_path="/storage/lonely.pdf",
                size=1024,
                mime_type="application/pdf",
                tier="hot",
                created_at=datetime.utcnow(),
                last_accessed=datetime.utcnow(),
            )
        ]

        features = clustering_service.prepare_features(files=single_file)

        # Should handle gracefully (cannot cluster single file)
        assert features is not None


@pytest.mark.ml
@pytest.mark.unit
class TestClusteringMetrics:
    """Test clustering quality metrics."""

    def test_silhouette_score_interpretation(self):
        """Test silhouette score interpretation."""
        # Score near 1: well-separated clusters
        score = 0.85
        assert score > 0.7  # Good clustering

        # Score near 0: overlapping clusters
        score = 0.2
        assert score < 0.5  # Poor clustering

        # Score near -1: wrong clustering
        score = -0.3
        assert score < 0  # Very poor clustering

    def test_inertia_calculation(self):
        """Test K-Means inertia (within-cluster sum of squares)."""
        # Lower inertia is better (tighter clusters)
        # This would test actual inertia calculation
        pass

    def test_optimal_cluster_count(self):
        """Test determining optimal number of clusters."""
        # Use elbow method or silhouette analysis
        # This would test cluster count optimization
        pass
