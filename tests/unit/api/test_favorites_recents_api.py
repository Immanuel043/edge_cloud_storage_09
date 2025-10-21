"""
Unit tests for Favorites and Recents API endpoints
Tests the /api/v1/files/recents and /api/v1/files/favorites endpoints
"""

import pytest
from datetime import datetime, timedelta
from uuid import uuid4
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from services.storage_service.app.models.database import User, Object, Favorite


@pytest.mark.asyncio
@pytest.mark.api
class TestRecentsAPI:
    """Test suite for recent files endpoint"""

    async def test_get_recents_returns_recent_files(
        self, async_client: AsyncClient, test_user: User, db_session: AsyncSession
    ):
        """Test that recents endpoint returns files accessed in last N days"""
        # Create test files with different access times
        now = datetime.utcnow()
        files = []

        for i in range(5):
            file_obj = Object(
                id=uuid4(),
                user_id=test_user.id,
                file_name=f"recent_file_{i}.txt",
                file_size=1024 * i,
                mime_type="text/plain",
                storage_tier="hot",
                storage_type="inline",
                storage_key="test_key",
                encryption_key=b"test_encryption_key",
                content_hash=f"hash_{i}",
                last_accessed=now - timedelta(days=i),
                created_at=now - timedelta(days=30),
            )
            db_session.add(file_obj)
            files.append(file_obj)

        await db_session.commit()

        # Request recent files from last 3 days
        response = await async_client.get(
            "/api/v1/files/recents?days=3",
            headers={"Authorization": f"Bearer {test_user.token}"},
        )

        assert response.status_code == 200
        data = response.json()

        # Should return 4 files (days 0, 1, 2, 3)
        assert len(data) == 4

        # Verify ordering (most recent first)
        assert data[0]["name"] == "recent_file_0.txt"
        assert data[1]["name"] == "recent_file_1.txt"

    async def test_get_recents_respects_limit_parameter(
        self, async_client: AsyncClient, test_user: User, db_session: AsyncSession
    ):
        """Test that limit parameter restricts number of returned files"""
        now = datetime.utcnow()

        # Create 20 recent files
        for i in range(20):
            file_obj = Object(
                id=uuid4(),
                user_id=test_user.id,
                file_name=f"file_{i}.txt",
                file_size=1024,
                mime_type="text/plain",
                storage_tier="hot",
                storage_type="inline",
                storage_key="test_key",
                encryption_key=b"test_encryption_key",
                content_hash=f"hash_{i}",
                last_accessed=now - timedelta(hours=i),
                created_at=now - timedelta(days=30),
            )
            db_session.add(file_obj)

        await db_session.commit()

        # Request with limit=10
        response = await async_client.get(
            "/api/v1/files/recents?days=30&limit=10",
            headers={"Authorization": f"Bearer {test_user.token}"},
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data) == 10

    async def test_get_recents_rejects_invalid_days_parameter(
        self, async_client: AsyncClient, test_user: User
    ):
        """Test that invalid days parameter is rejected"""
        # Test days > 365
        response = await async_client.get(
            "/api/v1/files/recents?days=400",
            headers={"Authorization": f"Bearer {test_user.token}"},
        )
        assert response.status_code == 400

        # Test days < 1
        response = await async_client.get(
            "/api/v1/files/recents?days=0",
            headers={"Authorization": f"Bearer {test_user.token}"},
        )
        assert response.status_code == 400

    async def test_get_recents_rejects_invalid_limit_parameter(
        self, async_client: AsyncClient, test_user: User
    ):
        """Test that invalid limit parameter is rejected"""
        # Test limit > 100
        response = await async_client.get(
            "/api/v1/files/recents?limit=150",
            headers={"Authorization": f"Bearer {test_user.token}"},
        )
        assert response.status_code == 400

        # Test limit < 1
        response = await async_client.get(
            "/api/v1/files/recents?limit=-5",
            headers={"Authorization": f"Bearer {test_user.token}"},
        )
        assert response.status_code == 400

    async def test_get_recents_only_returns_user_files(
        self, async_client: AsyncClient, test_user: User, db_session: AsyncSession
    ):
        """Test that recents only returns files belonging to the authenticated user"""
        now = datetime.utcnow()

        # Create another user
        other_user = User(
            id=uuid4(),
            username="other_user",
            email="other@example.com",
            password_hash="hashed_password",
            storage_quota=10 * 1024**3,
        )
        db_session.add(other_user)

        # Create file for other user
        other_file = Object(
            id=uuid4(),
            user_id=other_user.id,
            file_name="other_user_file.txt",
            file_size=1024,
            mime_type="text/plain",
            storage_tier="hot",
            storage_type="inline",
            storage_key="test_key",
            encryption_key=b"test_encryption_key",
            content_hash="other_hash",
            last_accessed=now,
            created_at=now,
        )
        db_session.add(other_file)

        # Create file for test user
        user_file = Object(
            id=uuid4(),
            user_id=test_user.id,
            file_name="test_user_file.txt",
            file_size=1024,
            mime_type="text/plain",
            storage_tier="hot",
            storage_type="inline",
            storage_key="test_key",
            encryption_key=b"test_encryption_key",
            content_hash="user_hash",
            last_accessed=now,
            created_at=now,
        )
        db_session.add(user_file)

        await db_session.commit()

        # Request recents
        response = await async_client.get(
            "/api/v1/files/recents?days=7",
            headers={"Authorization": f"Bearer {test_user.token}"},
        )

        assert response.status_code == 200
        data = response.json()

        # Should only return test user's file
        assert len(data) == 1
        assert data[0]["name"] == "test_user_file.txt"

    async def test_get_recents_empty_list_when_no_recent_files(
        self, async_client: AsyncClient, test_user: User, db_session: AsyncSession
    ):
        """Test that empty list is returned when no recent files exist"""
        # Create old file (90 days ago)
        old_file = Object(
            id=uuid4(),
            user_id=test_user.id,
            file_name="old_file.txt",
            file_size=1024,
            mime_type="text/plain",
            storage_tier="cold",
            storage_type="inline",
            storage_key="test_key",
            encryption_key=b"test_encryption_key",
            content_hash="old_hash",
            last_accessed=datetime.utcnow() - timedelta(days=90),
            created_at=datetime.utcnow() - timedelta(days=100),
        )
        db_session.add(old_file)
        await db_session.commit()

        # Request files from last 30 days
        response = await async_client.get(
            "/api/v1/files/recents?days=30",
            headers={"Authorization": f"Bearer {test_user.token}"},
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data) == 0


@pytest.mark.asyncio
@pytest.mark.api
class TestFavoritesAPI:
    """Test suite for favorites endpoints"""

    async def test_get_favorites_returns_favorited_files(
        self, async_client: AsyncClient, test_user: User, db_session: AsyncSession
    ):
        """Test that favorites endpoint returns all favorited files"""
        now = datetime.utcnow()

        # Create test files
        files = []
        for i in range(3):
            file_obj = Object(
                id=uuid4(),
                user_id=test_user.id,
                file_name=f"favorite_{i}.txt",
                file_size=1024 * i,
                mime_type="text/plain",
                storage_tier="hot",
                storage_type="inline",
                storage_key="test_key",
                encryption_key=b"test_encryption_key",
                content_hash=f"hash_{i}",
                created_at=now - timedelta(days=i),
            )
            db_session.add(file_obj)
            files.append(file_obj)

        await db_session.commit()

        # Favorite 2 out of 3 files
        for i in range(2):
            favorite = Favorite(
                id=uuid4(),
                user_id=test_user.id,
                file_id=files[i].id,
                created_at=now - timedelta(hours=i),
            )
            db_session.add(favorite)

        await db_session.commit()

        # Request favorites
        response = await async_client.get(
            "/api/v1/files/favorites",
            headers={"Authorization": f"Bearer {test_user.token}"},
        )

        assert response.status_code == 200
        data = response.json()

        # Should return 2 favorited files
        assert len(data) == 2

        # All should have is_favorite=True
        for file_data in data:
            assert file_data["is_favorite"] is True
            assert "favorited_at" in file_data

    async def test_toggle_favorite_adds_to_favorites(
        self, async_client: AsyncClient, test_user: User, db_session: AsyncSession
    ):
        """Test that toggle favorite adds file to favorites"""
        # Create test file
        file_obj = Object(
            id=uuid4(),
            user_id=test_user.id,
            file_name="test_file.txt",
            file_size=1024,
            mime_type="text/plain",
            storage_tier="hot",
            storage_type="inline",
            storage_key="test_key",
            encryption_key=b"test_encryption_key",
            content_hash="test_hash",
            created_at=datetime.utcnow(),
        )
        db_session.add(file_obj)
        await db_session.commit()

        # Toggle favorite (should add)
        response = await async_client.post(
            f"/api/v1/files/{file_obj.id}/favorite",
            headers={"Authorization": f"Bearer {test_user.token}"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["favorited"] is True
        assert "added to favorites" in data["message"].lower()

    async def test_toggle_favorite_removes_from_favorites(
        self, async_client: AsyncClient, test_user: User, db_session: AsyncSession
    ):
        """Test that toggle favorite removes file from favorites"""
        # Create test file
        file_obj = Object(
            id=uuid4(),
            user_id=test_user.id,
            file_name="test_file.txt",
            file_size=1024,
            mime_type="text/plain",
            storage_tier="hot",
            storage_type="inline",
            storage_key="test_key",
            encryption_key=b"test_encryption_key",
            content_hash="test_hash",
            created_at=datetime.utcnow(),
        )
        db_session.add(file_obj)

        # Add to favorites
        favorite = Favorite(
            id=uuid4(), user_id=test_user.id, file_id=file_obj.id
        )
        db_session.add(favorite)
        await db_session.commit()

        # Toggle favorite (should remove)
        response = await async_client.post(
            f"/api/v1/files/{file_obj.id}/favorite",
            headers={"Authorization": f"Bearer {test_user.token}"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["favorited"] is False
        assert "removed from favorites" in data["message"].lower()

    async def test_toggle_favorite_prevents_duplicate_favorites(
        self, async_client: AsyncClient, test_user: User, db_session: AsyncSession
    ):
        """Test that unique constraint prevents duplicate favorites"""
        # Create test file
        file_obj = Object(
            id=uuid4(),
            user_id=test_user.id,
            file_name="test_file.txt",
            file_size=1024,
            mime_type="text/plain",
            storage_tier="hot",
            storage_type="inline",
            storage_key="test_key",
            encryption_key=b"test_encryption_key",
            content_hash="test_hash",
            created_at=datetime.utcnow(),
        )
        db_session.add(file_obj)
        await db_session.commit()

        # Toggle favorite twice
        response1 = await async_client.post(
            f"/api/v1/files/{file_obj.id}/favorite",
            headers={"Authorization": f"Bearer {test_user.token}"},
        )
        response2 = await async_client.post(
            f"/api/v1/files/{file_obj.id}/favorite",
            headers={"Authorization": f"Bearer {test_user.token}"},
        )

        assert response1.status_code == 200
        assert response2.status_code == 200

        # First should add, second should remove
        assert response1.json()["favorited"] is True
        assert response2.json()["favorited"] is False

    async def test_toggle_favorite_rejects_nonexistent_file(
        self, async_client: AsyncClient, test_user: User
    ):
        """Test that favoriting non-existent file returns 404"""
        fake_file_id = uuid4()

        response = await async_client.post(
            f"/api/v1/files/{fake_file_id}/favorite",
            headers={"Authorization": f"Bearer {test_user.token}"},
        )

        assert response.status_code == 404

    async def test_toggle_favorite_rejects_other_users_file(
        self, async_client: AsyncClient, test_user: User, db_session: AsyncSession
    ):
        """Test that users cannot favorite other users' files"""
        # Create another user
        other_user = User(
            id=uuid4(),
            username="other_user",
            email="other@example.com",
            password_hash="hashed_password",
            storage_quota=10 * 1024**3,
        )
        db_session.add(other_user)

        # Create file for other user
        other_file = Object(
            id=uuid4(),
            user_id=other_user.id,
            file_name="other_user_file.txt",
            file_size=1024,
            mime_type="text/plain",
            storage_tier="hot",
            storage_type="inline",
            storage_key="test_key",
            encryption_key=b"test_encryption_key",
            content_hash="other_hash",
            created_at=datetime.utcnow(),
        )
        db_session.add(other_file)
        await db_session.commit()

        # Try to favorite other user's file
        response = await async_client.post(
            f"/api/v1/files/{other_file.id}/favorite",
            headers={"Authorization": f"Bearer {test_user.token}"},
        )

        assert response.status_code == 404  # File not found (for security)

    async def test_remove_favorite_explicit_delete(
        self, async_client: AsyncClient, test_user: User, db_session: AsyncSession
    ):
        """Test explicit DELETE endpoint for removing favorites"""
        # Create test file
        file_obj = Object(
            id=uuid4(),
            user_id=test_user.id,
            file_name="test_file.txt",
            file_size=1024,
            mime_type="text/plain",
            storage_tier="hot",
            storage_type="inline",
            storage_key="test_key",
            encryption_key=b"test_encryption_key",
            content_hash="test_hash",
            created_at=datetime.utcnow(),
        )
        db_session.add(file_obj)

        # Add to favorites
        favorite = Favorite(
            id=uuid4(), user_id=test_user.id, file_id=file_obj.id
        )
        db_session.add(favorite)
        await db_session.commit()

        # Remove using DELETE endpoint
        response = await async_client.delete(
            f"/api/v1/files/{file_obj.id}/favorite",
            headers={"Authorization": f"Bearer {test_user.token}"},
        )

        assert response.status_code == 200
        assert "removed from favorites" in response.json()["message"].lower()

    async def test_remove_favorite_nonexistent_returns_404(
        self, async_client: AsyncClient, test_user: User, db_session: AsyncSession
    ):
        """Test that removing non-favorited file returns 404"""
        # Create test file (not favorited)
        file_obj = Object(
            id=uuid4(),
            user_id=test_user.id,
            file_name="test_file.txt",
            file_size=1024,
            mime_type="text/plain",
            storage_tier="hot",
            storage_type="inline",
            storage_key="test_key",
            encryption_key=b"test_encryption_key",
            content_hash="test_hash",
            created_at=datetime.utcnow(),
        )
        db_session.add(file_obj)
        await db_session.commit()

        # Try to remove from favorites
        response = await async_client.delete(
            f"/api/v1/files/{file_obj.id}/favorite",
            headers={"Authorization": f"Bearer {test_user.token}"},
        )

        assert response.status_code == 404

    async def test_favorites_persist_across_sessions(
        self, async_client: AsyncClient, test_user: User, db_session: AsyncSession
    ):
        """Test that favorites persist and can be retrieved multiple times"""
        # Create and favorite a file
        file_obj = Object(
            id=uuid4(),
            user_id=test_user.id,
            file_name="persistent_favorite.txt",
            file_size=1024,
            mime_type="text/plain",
            storage_tier="hot",
            storage_type="inline",
            storage_key="test_key",
            encryption_key=b"test_encryption_key",
            content_hash="test_hash",
            created_at=datetime.utcnow(),
        )
        db_session.add(file_obj)
        await db_session.commit()

        # Add to favorites
        await async_client.post(
            f"/api/v1/files/{file_obj.id}/favorite",
            headers={"Authorization": f"Bearer {test_user.token}"},
        )

        # Retrieve favorites multiple times
        for _ in range(3):
            response = await async_client.get(
                "/api/v1/files/favorites",
                headers={"Authorization": f"Bearer {test_user.token}"},
            )

            assert response.status_code == 200
            data = response.json()
            assert len(data) == 1
            assert data[0]["name"] == "persistent_favorite.txt"
            assert data[0]["is_favorite"] is True


@pytest.mark.asyncio
@pytest.mark.api
class TestFavoritesRecentsIntegration:
    """Integration tests for favorites and recents working together"""

    async def test_favorited_file_appears_in_both_lists(
        self, async_client: AsyncClient, test_user: User, db_session: AsyncSession
    ):
        """Test that a favorited recent file appears in both endpoints"""
        now = datetime.utcnow()

        # Create recent file
        file_obj = Object(
            id=uuid4(),
            user_id=test_user.id,
            file_name="recent_favorite.txt",
            file_size=1024,
            mime_type="text/plain",
            storage_tier="hot",
            storage_type="inline",
            storage_key="test_key",
            encryption_key=b"test_encryption_key",
            content_hash="test_hash",
            last_accessed=now,
            created_at=now,
        )
        db_session.add(file_obj)
        await db_session.commit()

        # Favorite the file
        await async_client.post(
            f"/api/v1/files/{file_obj.id}/favorite",
            headers={"Authorization": f"Bearer {test_user.token}"},
        )

        # Check both endpoints
        recents_response = await async_client.get(
            "/api/v1/files/recents?days=7",
            headers={"Authorization": f"Bearer {test_user.token}"},
        )
        favorites_response = await async_client.get(
            "/api/v1/files/favorites",
            headers={"Authorization": f"Bearer {test_user.token}"},
        )

        assert recents_response.status_code == 200
        assert favorites_response.status_code == 200

        recents_data = recents_response.json()
        favorites_data = favorites_response.json()

        # File should appear in both lists
        assert len(recents_data) == 1
        assert len(favorites_data) == 1
        assert recents_data[0]["name"] == "recent_favorite.txt"
        assert favorites_data[0]["name"] == "recent_favorite.txt"

        # File in recents should be marked as favorite
        assert recents_data[0]["is_favorite"] is True
