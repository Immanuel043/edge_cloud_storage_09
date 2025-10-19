"""
Unit Tests for Storage Optimization Service
Tests the storage optimization suggestion engine
"""

import pytest
from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch

from app.services.storage_optimizer import StorageOptimizer
from app.models import File, OptimizationSuggestion


class TestStorageOptimizer:
    """Test suite for StorageOptimizer service."""

    @pytest.fixture
    def storage_optimizer(self, db_session, mock_settings):
        """Create a StorageOptimizer instance for testing."""
        return StorageOptimizer(db=db_session, settings=mock_settings)

    def test_optimizer_initialization(self, storage_optimizer):
        """Test that StorageOptimizer initializes correctly."""
        assert storage_optimizer is not None
        assert storage_optimizer.db is not None

    @pytest.mark.asyncio
    async def test_generate_suggestions_all_types(
        self, storage_optimizer, mock_user, mock_files
    ):
        """Test generating all types of optimization suggestions."""
        suggestions = await storage_optimizer.generate_suggestions(
            user_id=mock_user.id
        )

        assert suggestions is not None
        assert isinstance(suggestions, list)
        assert len(suggestions) > 0

        # Check that suggestions have required fields
        for suggestion in suggestions:
            assert "suggestion_type" in suggestion
            assert "priority" in suggestion
            assert "estimated_savings_bytes" in suggestion
            assert "title" in suggestion
            assert "description" in suggestion

    @pytest.mark.asyncio
    async def test_tier_migration_suggestions(
        self, storage_optimizer, mock_user, db_session
    ):
        """Test tier migration suggestions for old files."""
        # Create files that should be migrated to cold storage
        old_files = [
            File(
                id=100 + i,
                user_id=mock_user.id,
                filename=f"old_file_{i}.pdf",
                original_filename=f"old_file_{i}.pdf",
                file_path=f"/storage/old/file_{i}.pdf",
                size=100 * 1024**2,  # 100 MB
                mime_type="application/pdf",
                tier="hot",
                created_at=datetime.utcnow() - timedelta(days=90),
                last_accessed=datetime.utcnow() - timedelta(days=90),
            )
            for i in range(5)
        ]
        db_session.add_all(old_files)
        db_session.commit()

        suggestions = await storage_optimizer._generate_tier_migration_suggestions(
            user_id=mock_user.id
        )

        assert len(suggestions) > 0
        tier_suggestions = [s for s in suggestions if s["suggestion_type"] == "tier_migration"]
        assert len(tier_suggestions) > 0
        assert tier_suggestions[0]["priority"] in ["high", "medium"]

    @pytest.mark.asyncio
    async def test_compression_suggestions(
        self, storage_optimizer, mock_user, db_session
    ):
        """Test compression suggestions for large uncompressed files."""
        # Create large uncompressed files
        large_files = [
            File(
                id=200 + i,
                user_id=mock_user.id,
                filename=f"large_{i}.txt",
                original_filename=f"large_{i}.txt",
                file_path=f"/storage/large/file_{i}.txt",
                size=500 * 1024**2,  # 500 MB text file (highly compressible)
                mime_type="text/plain",
                tier="hot",
                created_at=datetime.utcnow(),
                last_accessed=datetime.utcnow(),
            )
            for i in range(3)
        ]
        db_session.add_all(large_files)
        db_session.commit()

        suggestions = await storage_optimizer._generate_compression_suggestions(
            user_id=mock_user.id
        )

        assert len(suggestions) > 0
        comp_suggestions = [s for s in suggestions if s["suggestion_type"] == "compression"]
        assert len(comp_suggestions) > 0
        assert comp_suggestions[0]["estimated_savings_bytes"] > 0

    @pytest.mark.asyncio
    async def test_deduplication_suggestions(
        self, storage_optimizer, mock_user, db_session
    ):
        """Test deduplication suggestions for duplicate files."""
        # Create duplicate files (same hash)
        duplicate_hash = "abc123def456"
        duplicates = [
            File(
                id=300 + i,
                user_id=mock_user.id,
                filename=f"duplicate_{i}.jpg",
                original_filename=f"duplicate_{i}.jpg",
                file_path=f"/storage/dup/file_{i}.jpg",
                size=50 * 1024**2,  # 50 MB
                mime_type="image/jpeg",
                file_hash=duplicate_hash,
                tier="hot",
                created_at=datetime.utcnow(),
                last_accessed=datetime.utcnow(),
            )
            for i in range(4)
        ]
        db_session.add_all(duplicates)
        db_session.commit()

        suggestions = await storage_optimizer._generate_deduplication_suggestions(
            user_id=mock_user.id
        )

        assert len(suggestions) > 0
        dedup_suggestions = [s for s in suggestions if s["suggestion_type"] == "deduplication"]
        assert len(dedup_suggestions) > 0
        # Should save 3 copies (keep 1, remove 3)
        assert dedup_suggestions[0]["estimated_savings_bytes"] == 3 * 50 * 1024**2

    @pytest.mark.asyncio
    async def test_cleanup_suggestions(
        self, storage_optimizer, mock_user, db_session
    ):
        """Test cleanup suggestions for very old unused files."""
        # Create very old files never accessed
        old_unused = [
            File(
                id=400 + i,
                user_id=mock_user.id,
                filename=f"ancient_{i}.doc",
                original_filename=f"ancient_{i}.doc",
                file_path=f"/storage/ancient/file_{i}.doc",
                size=10 * 1024**2,  # 10 MB
                mime_type="application/msword",
                tier="cold",
                created_at=datetime.utcnow() - timedelta(days=400),
                last_accessed=datetime.utcnow() - timedelta(days=400),
            )
            for i in range(10)
        ]
        db_session.add_all(old_unused)
        db_session.commit()

        suggestions = await storage_optimizer._generate_cleanup_suggestions(
            user_id=mock_user.id
        )

        cleanup_suggestions = [s for s in suggestions if s["suggestion_type"] == "cleanup"]
        assert len(cleanup_suggestions) > 0
        assert cleanup_suggestions[0]["priority"] == "low"  # Cleanup is usually low priority

    def test_calculate_priority(self, storage_optimizer):
        """Test priority calculation for suggestions."""
        # Critical: > 80% quota used, large savings
        priority = storage_optimizer._calculate_priority(
            savings_bytes=5 * 1024**3,
            quota_used_percent=85,
        )
        assert priority == "critical"

        # High: > 70% quota, moderate savings
        priority = storage_optimizer._calculate_priority(
            savings_bytes=2 * 1024**3,
            quota_used_percent=75,
        )
        assert priority == "high"

        # Medium: moderate quota, moderate savings
        priority = storage_optimizer._calculate_priority(
            savings_bytes=1 * 1024**3,
            quota_used_percent=60,
        )
        assert priority == "medium"

        # Low: low quota, small savings
        priority = storage_optimizer._calculate_priority(
            savings_bytes=100 * 1024**2,
            quota_used_percent=40,
        )
        assert priority == "low"

    @pytest.mark.asyncio
    async def test_suggestion_deduplication(
        self, storage_optimizer, mock_user, db_session
    ):
        """Test that duplicate suggestions are not generated."""
        # Create the same optimization scenario twice
        suggestions1 = await storage_optimizer.generate_suggestions(user_id=mock_user.id)
        suggestions2 = await storage_optimizer.generate_suggestions(user_id=mock_user.id)

        # Should generate same suggestions (idempotent)
        assert len(suggestions1) == len(suggestions2)

    @pytest.mark.asyncio
    async def test_estimate_compression_savings(self, storage_optimizer):
        """Test compression savings estimation."""
        # Text files: ~70% compression
        savings = storage_optimizer._estimate_compression_savings(
            file_size=100 * 1024**2,
            mime_type="text/plain",
        )
        assert savings > 60 * 1024**2  # At least 60% saved

        # Images: ~10-20% compression
        savings = storage_optimizer._estimate_compression_savings(
            file_size=100 * 1024**2,
            mime_type="image/jpeg",
        )
        assert 10 * 1024**2 < savings < 30 * 1024**2

        # Videos: minimal compression (already compressed)
        savings = storage_optimizer._estimate_compression_savings(
            file_size=100 * 1024**2,
            mime_type="video/mp4",
        )
        assert savings < 10 * 1024**2

    @pytest.mark.asyncio
    async def test_no_suggestions_for_optimized_storage(
        self, storage_optimizer, mock_user, db_session
    ):
        """Test that no suggestions are generated for already optimized storage."""
        # Create perfectly optimized files
        optimal_files = [
            File(
                id=500 + i,
                user_id=mock_user.id,
                filename=f"optimal_{i}.pdf",
                original_filename=f"optimal_{i}.pdf",
                file_path=f"/storage/optimal/file_{i}.pdf",
                size=10 * 1024**2,
                mime_type="application/pdf",
                tier="hot" if i < 2 else "cold",  # Recent in hot, old in cold
                created_at=datetime.utcnow() - timedelta(days=i * 30),
                last_accessed=datetime.utcnow() if i < 2 else datetime.utcnow() - timedelta(days=100),
            )
            for i in range(5)
        ]
        db_session.add_all(optimal_files)
        db_session.commit()

        suggestions = await storage_optimizer.generate_suggestions(user_id=mock_user.id)

        # Should have few or no suggestions
        assert len(suggestions) < 3


@pytest.mark.unit
class TestOptimizationMetrics:
    """Test optimization metrics calculation."""

    def test_calculate_savings_percentage(self):
        """Test savings percentage calculation."""
        total_size = 10 * 1024**3  # 10 GB
        savings = 2 * 1024**3  # 2 GB

        percentage = (savings / total_size) * 100
        assert percentage == 20.0

    def test_tier_cost_calculation(self):
        """Test storage tier cost estimation."""
        # Hot storage: $0.023/GB/month
        # Warm storage: $0.012/GB/month
        # Cold storage: $0.004/GB/month

        hot_cost = (100 * 0.023)  # 100 GB
        warm_cost = (100 * 0.012)
        cold_cost = (100 * 0.004)

        assert hot_cost == 2.3
        assert warm_cost == 1.2
        assert cold_cost == 0.4

        # Moving 100GB from hot to cold saves $1.9/month
        savings = hot_cost - cold_cost
        assert savings == 1.9
