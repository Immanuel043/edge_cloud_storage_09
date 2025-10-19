"""
Pytest Configuration and Shared Fixtures
Provides reusable test fixtures for database, API clients, and test data
"""

import asyncio
import os
import sys
from datetime import datetime, timedelta
from typing import AsyncGenerator, Generator
from unittest.mock import MagicMock, Mock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

# Add the app directory to the Python path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../services/storage-service"))

from app.config import Settings
from app.database import Base, get_db
from app.main import app
from app.models import (
    ClusteringSession,
    File,
    OptimizationSuggestion,
    OrganizationRule,
    QuotaAlert,
    QuotaPrediction,
    Recommendation,
    User,
    UsageHistory,
    UserInteraction,
)

# =============================================================================
# Test Database Configuration
# =============================================================================

# Use in-memory SQLite for fast tests
TEST_DATABASE_URL = "sqlite:///:memory:"
TEST_ASYNC_DATABASE_URL = "sqlite+aiosqlite:///:memory:"


@pytest.fixture(scope="session")
def event_loop():
    """Create an instance of the default event loop for the test session."""
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="function")
def db_engine():
    """Create a fresh database engine for each test."""
    engine = create_engine(
        TEST_DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    yield engine
    Base.metadata.drop_all(bind=engine)
    engine.dispose()


@pytest.fixture(scope="function")
def db_session(db_engine) -> Generator[Session, None, None]:
    """Create a fresh database session for each test."""
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=db_engine)
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture(scope="function")
async def async_db_session() -> AsyncGenerator[AsyncSession, None]:
    """Create an async database session for async tests."""
    engine = create_async_engine(
        TEST_ASYNC_DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with AsyncSessionLocal() as session:
        yield session

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)

    await engine.dispose()


# =============================================================================
# API Client Fixtures
# =============================================================================


@pytest.fixture(scope="function")
def api_client(db_session):
    """Create a FastAPI test client with database override."""

    def override_get_db():
        try:
            yield db_session
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    client = TestClient(app)
    yield client
    app.dependency_overrides.clear()


# =============================================================================
# Mock User Fixtures
# =============================================================================


@pytest.fixture
def mock_user(db_session) -> User:
    """Create a mock user for testing."""
    user = User(
        id=1,
        username="testuser",
        email="test@example.com",
        quota_bytes=10 * 1024**3,  # 10 GB
        used_bytes=5 * 1024**3,  # 5 GB used
        created_at=datetime.utcnow(),
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


@pytest.fixture
def mock_users(db_session) -> list[User]:
    """Create multiple mock users for testing."""
    users = [
        User(
            id=i,
            username=f"user{i}",
            email=f"user{i}@example.com",
            quota_bytes=10 * 1024**3,
            used_bytes=(i * 1024**3),
            created_at=datetime.utcnow() - timedelta(days=30 * i),
        )
        for i in range(1, 6)
    ]
    db_session.add_all(users)
    db_session.commit()
    for user in users:
        db_session.refresh(user)
    return users


# =============================================================================
# File Fixtures
# =============================================================================


@pytest.fixture
def mock_file(db_session, mock_user) -> File:
    """Create a mock file for testing."""
    file = File(
        id=1,
        user_id=mock_user.id,
        filename="test_file.pdf",
        original_filename="test_file.pdf",
        file_path="/storage/test/test_file.pdf",
        size=1024 * 1024,  # 1 MB
        mime_type="application/pdf",
        tier="hot",
        created_at=datetime.utcnow(),
        last_accessed=datetime.utcnow(),
    )
    db_session.add(file)
    db_session.commit()
    db_session.refresh(file)
    return file


@pytest.fixture
def mock_files(db_session, mock_user) -> list[File]:
    """Create multiple mock files for testing."""
    files = [
        File(
            id=i,
            user_id=mock_user.id,
            filename=f"file_{i}.{ext}",
            original_filename=f"file_{i}.{ext}",
            file_path=f"/storage/test/file_{i}.{ext}",
            size=1024 * 1024 * i,
            mime_type=mime,
            tier=tier,
            created_at=datetime.utcnow() - timedelta(days=i),
            last_accessed=datetime.utcnow() - timedelta(days=i // 2),
        )
        for i, (ext, mime, tier) in enumerate(
            [
                ("pdf", "application/pdf", "hot"),
                ("jpg", "image/jpeg", "hot"),
                ("mp4", "video/mp4", "warm"),
                ("zip", "application/zip", "cold"),
                ("txt", "text/plain", "hot"),
            ],
            start=1,
        )
    ]
    db_session.add_all(files)
    db_session.commit()
    for file in files:
        db_session.refresh(file)
    return files


# =============================================================================
# ML Feature Fixtures
# =============================================================================


@pytest.fixture
def mock_usage_history(db_session, mock_user) -> list[UsageHistory]:
    """Create mock usage history for quota prediction testing."""
    history = [
        UsageHistory(
            user_id=mock_user.id,
            used_bytes=(5 * 1024**3) + (i * 100 * 1024**2),  # Growing usage
            quota_bytes=10 * 1024**3,
            file_count=100 + i * 10,
            recorded_at=datetime.utcnow() - timedelta(days=30 - i),
        )
        for i in range(30)
    ]
    db_session.add_all(history)
    db_session.commit()
    return history


@pytest.fixture
def mock_quota_prediction(db_session, mock_user) -> QuotaPrediction:
    """Create a mock quota prediction."""
    prediction = QuotaPrediction(
        user_id=mock_user.id,
        predicted_usage_bytes=9 * 1024**3,
        prediction_date=datetime.utcnow() + timedelta(days=7),
        confidence_score=0.85,
        algorithm_used="prophet",
        created_at=datetime.utcnow(),
    )
    db_session.add(prediction)
    db_session.commit()
    db_session.refresh(prediction)
    return prediction


@pytest.fixture
def mock_quota_alert(db_session, mock_user) -> QuotaAlert:
    """Create a mock quota alert."""
    alert = QuotaAlert(
        user_id=mock_user.id,
        alert_type="warning",
        severity="high",
        predicted_full_date=datetime.utcnow() + timedelta(days=14),
        current_usage_bytes=7 * 1024**3,
        predicted_usage_bytes=9.5 * 1024**3,
        message="Storage will reach 95% capacity in 14 days",
        created_at=datetime.utcnow(),
    )
    db_session.add(alert)
    db_session.commit()
    db_session.refresh(alert)
    return alert


@pytest.fixture
def mock_optimization_suggestion(db_session, mock_user) -> OptimizationSuggestion:
    """Create a mock storage optimization suggestion."""
    suggestion = OptimizationSuggestion(
        user_id=mock_user.id,
        suggestion_type="tier_migration",
        priority="high",
        estimated_savings_bytes=2 * 1024**3,
        title="Move old files to cold storage",
        description="10 files haven't been accessed in 60 days",
        action_data={"file_ids": [1, 2, 3], "target_tier": "cold"},
        created_at=datetime.utcnow(),
    )
    db_session.add(suggestion)
    db_session.commit()
    db_session.refresh(suggestion)
    return suggestion


@pytest.fixture
def mock_clustering_session(db_session, mock_user) -> ClusteringSession:
    """Create a mock clustering session for auto-organization."""
    session = ClusteringSession(
        user_id=mock_user.id,
        algorithm="kmeans",
        num_clusters=5,
        status="completed",
        metrics={"silhouette_score": 0.65, "num_files": 100},
        created_at=datetime.utcnow(),
        completed_at=datetime.utcnow(),
    )
    db_session.add(session)
    db_session.commit()
    db_session.refresh(session)
    return session


@pytest.fixture
def mock_recommendation(db_session, mock_user, mock_file) -> Recommendation:
    """Create a mock content recommendation."""
    recommendation = Recommendation(
        user_id=mock_user.id,
        file_id=mock_file.id,
        score=0.85,
        reason="Similar to recently accessed files",
        algorithm="content_based",
        created_at=datetime.utcnow(),
    )
    db_session.add(recommendation)
    db_session.commit()
    db_session.refresh(recommendation)
    return recommendation


@pytest.fixture
def mock_user_interaction(db_session, mock_user, mock_file) -> UserInteraction:
    """Create a mock user interaction for collaborative filtering."""
    interaction = UserInteraction(
        user_id=mock_user.id,
        file_id=mock_file.id,
        interaction_type="view",
        rating=4,
        created_at=datetime.utcnow(),
    )
    db_session.add(interaction)
    db_session.commit()
    db_session.refresh(interaction)
    return interaction


# =============================================================================
# Mock Service Fixtures
# =============================================================================


@pytest.fixture
def mock_redis():
    """Create a mock Redis client."""
    redis_mock = MagicMock()
    redis_mock.get.return_value = None
    redis_mock.set.return_value = True
    redis_mock.delete.return_value = True
    redis_mock.exists.return_value = False
    return redis_mock


@pytest.fixture
def mock_kafka_producer():
    """Create a mock Kafka producer."""
    producer_mock = MagicMock()
    producer_mock.send.return_value = Mock()
    return producer_mock


@pytest.fixture
def mock_settings():
    """Create mock settings for testing."""
    return Settings(
        DATABASE_URL=TEST_DATABASE_URL,
        REDIS_URL="redis://localhost:6379/1",
        KAFKA_BOOTSTRAP_SERVERS="localhost:9092",
        ML_QUOTA_PREDICTION_ENABLED=True,
        ML_STORAGE_OPTIMIZATION_ENABLED=True,
        ML_AUTO_ORGANIZATION_ENABLED=True,
        ML_CONTENT_RECOMMENDATIONS_ENABLED=True,
        TESTING=True,
    )


# =============================================================================
# Helper Functions
# =============================================================================


def assert_dict_contains(actual: dict, expected: dict):
    """Assert that actual dict contains all keys/values from expected dict."""
    for key, value in expected.items():
        assert key in actual, f"Key '{key}' not found in actual dict"
        assert actual[key] == value, f"Value mismatch for key '{key}': {actual[key]} != {value}"


def create_test_file_data(
    filename: str = "test.pdf",
    size: int = 1024 * 1024,
    mime_type: str = "application/pdf",
    tier: str = "hot",
) -> dict:
    """Create test file data dictionary."""
    return {
        "filename": filename,
        "size": size,
        "mime_type": mime_type,
        "tier": tier,
        "created_at": datetime.utcnow().isoformat(),
    }
