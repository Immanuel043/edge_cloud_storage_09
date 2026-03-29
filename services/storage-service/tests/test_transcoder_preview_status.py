# tests/test_transcoder_preview_status.py
"""
Unit tests for preview status updates in _generate_thumbnails_for_transcoded().

Verifies that the video transcoder properly coordinates with the preview pipeline
by updating preview:status in Redis and publishing websocket notifications.

Run with: python -m pytest tests/test_transcoder_preview_status.py -v
"""

import json
import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock
import sys
import os
import types

# Set minimal env vars needed for module import
os.environ.setdefault('DATABASE_URL', 'postgresql+asyncpg://x:x@localhost:5432/test')
os.environ.setdefault('SECRET_KEY', 'test_secret_key_for_testing_only_32b')

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

# Patch os.makedirs before importing video_transcoder to avoid /app filesystem access
with patch('os.makedirs'):
    from app.services.video_transcoder import video_transcoder


def _run(coro):
    """Helper to run async tests."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _setup_lazy_import_mocks(mock_redis, mock_preview_gen, mock_should_persist, mock_save_disk, mock_cache_ttl):
    """
    Create patches for the lazy imports inside _generate_thumbnails_for_transcoded.
    The method does:
        from .preview_generator import preview_generator
        from .preview_storage import save_preview_to_disk, should_persist_preview, preview_cache_ttl
        from ..database import get_redis
    We need to ensure these modules exist in sys.modules with the right attributes.
    """
    # Create mock modules
    mock_pg_module = types.ModuleType('app.services.preview_generator')
    mock_pg_module.preview_generator = mock_preview_gen

    mock_ps_module = types.ModuleType('app.services.preview_storage')
    mock_ps_module.save_preview_to_disk = mock_save_disk
    mock_ps_module.should_persist_preview = mock_should_persist
    mock_ps_module.preview_cache_ttl = mock_cache_ttl

    mock_db_module = types.ModuleType('app.database')
    mock_db_module.get_redis = AsyncMock(return_value=mock_redis)

    return {
        'app.services.preview_generator': mock_pg_module,
        'app.services.preview_storage': mock_ps_module,
        'app.database': mock_db_module,
    }


class TestGenerateThumbnailsPreviewStatus:
    """Verify _generate_thumbnails_for_transcoded updates preview status correctly."""

    def _make_mocks(self, generate_success_count=3):
        """Create mock redis, preview_generator, and preview_storage."""
        mock_redis = AsyncMock()
        mock_redis.setex = AsyncMock()
        mock_redis.publish = AsyncMock()

        call_count = [0]

        async def mock_generate_preview(file_path, mime_type, size, file_name):
            call_count[0] += 1
            if call_count[0] <= generate_success_count:
                return (b'\xff\xd8\xff\xe0fake_jpeg_data', 'image/jpeg')
            raise Exception("Generation failed")

        mock_preview_gen = MagicMock()
        mock_preview_gen.generate_preview = mock_generate_preview

        mock_should_persist = AsyncMock(return_value=True)
        mock_save_disk = MagicMock()
        mock_cache_ttl = MagicMock(return_value=86400)

        return mock_redis, mock_preview_gen, mock_should_persist, mock_save_disk, mock_cache_ttl

    def test_publishes_ready_when_cached_and_user_id(self):
        """When sizes_cached > 0 and user_id is provided, should update Redis status and publish notification."""
        mock_redis, mock_preview_gen, mock_should_persist, mock_save_disk, mock_cache_ttl = self._make_mocks(3)
        mock_modules = _setup_lazy_import_mocks(mock_redis, mock_preview_gen, mock_should_persist, mock_save_disk, mock_cache_ttl)

        async def run():
            with patch.dict('sys.modules', mock_modules):
                result = await video_transcoder._generate_thumbnails_for_transcoded(
                    file_id='test-file-123',
                    transcoded_path='/tmp/test.mp4',
                    source_hash='abc123',
                    user_id='user-456',
                )

                assert result == 3

                # Check preview:status was set
                status_calls = [
                    c for c in mock_redis.setex.call_args_list
                    if c[0][0] == 'preview:status:test-file-123'
                ]
                assert len(status_calls) == 1
                status_data = json.loads(status_calls[0][0][2])
                assert status_data['status'] == 'ready'
                assert 'updated_at' in status_data

                # Check notification was published
                publish_calls = mock_redis.publish.call_args_list
                assert len(publish_calls) == 1
                assert publish_calls[0][0][0] == 'preview_notifications'
                notif = json.loads(publish_calls[0][0][1])
                assert notif['file_id'] == 'test-file-123'
                assert notif['user_id'] == 'user-456'
                assert notif['status'] == 'ready'

        _run(run())

    def test_skips_publish_when_no_sizes(self):
        """When no thumbnails are cached (all fail), should NOT update preview status."""
        mock_redis, mock_preview_gen, mock_should_persist, mock_save_disk, mock_cache_ttl = self._make_mocks(0)
        mock_modules = _setup_lazy_import_mocks(mock_redis, mock_preview_gen, mock_should_persist, mock_save_disk, mock_cache_ttl)

        async def run():
            with patch.dict('sys.modules', mock_modules):
                result = await video_transcoder._generate_thumbnails_for_transcoded(
                    file_id='test-file-123',
                    transcoded_path='/tmp/test.mp4',
                    source_hash='abc123',
                    user_id='user-456',
                )

                assert result == 0

                # Should NOT have set preview:status
                status_calls = [
                    c for c in mock_redis.setex.call_args_list
                    if c[0][0] == 'preview:status:test-file-123'
                ]
                assert len(status_calls) == 0
                assert mock_redis.publish.call_count == 0

        _run(run())

    def test_skips_publish_when_no_user_id(self):
        """When user_id is None, should cache thumbnails but NOT update preview status."""
        mock_redis, mock_preview_gen, mock_should_persist, mock_save_disk, mock_cache_ttl = self._make_mocks(3)
        mock_modules = _setup_lazy_import_mocks(mock_redis, mock_preview_gen, mock_should_persist, mock_save_disk, mock_cache_ttl)

        async def run():
            with patch.dict('sys.modules', mock_modules):
                result = await video_transcoder._generate_thumbnails_for_transcoded(
                    file_id='test-file-123',
                    transcoded_path='/tmp/test.mp4',
                    source_hash='abc123',
                    user_id=None,
                )

                assert result == 3

                # Should have cached thumbnails (3 setex calls for preview:{id}:{size})
                thumbnail_calls = [
                    c for c in mock_redis.setex.call_args_list
                    if c[0][0].startswith('preview:test-file-123:')
                ]
                assert len(thumbnail_calls) == 3

                # But should NOT have set preview:status
                status_calls = [
                    c for c in mock_redis.setex.call_args_list
                    if c[0][0] == 'preview:status:test-file-123'
                ]
                assert len(status_calls) == 0
                assert mock_redis.publish.call_count == 0

        _run(run())

    def test_returns_zero_on_complete_failure(self):
        """When the entire method fails (e.g., Redis unavailable), should return 0."""
        # Mock get_redis to fail
        mock_db_module = types.ModuleType('app.database')
        mock_db_module.get_redis = AsyncMock(side_effect=Exception("Redis down"))

        async def run():
            with patch.dict('sys.modules', {'app.database': mock_db_module}):
                result = await video_transcoder._generate_thumbnails_for_transcoded(
                    file_id='test-file-123',
                    transcoded_path='/tmp/test.mp4',
                    user_id='user-456',
                )
                assert result == 0

        _run(run())

    def test_status_ttl_matches_preview_worker(self):
        """The preview:status TTL should be 3600s (1 hour), matching preview_worker."""
        mock_redis, mock_preview_gen, mock_should_persist, mock_save_disk, mock_cache_ttl = self._make_mocks(1)
        mock_modules = _setup_lazy_import_mocks(mock_redis, mock_preview_gen, mock_should_persist, mock_save_disk, mock_cache_ttl)

        async def run():
            with patch.dict('sys.modules', mock_modules):
                await video_transcoder._generate_thumbnails_for_transcoded(
                    file_id='test-file-123',
                    transcoded_path='/tmp/test.mp4',
                    source_hash='abc123',
                    user_id='user-456',
                )

                # Find the preview:status setex call and check TTL
                status_calls = [
                    c for c in mock_redis.setex.call_args_list
                    if c[0][0] == 'preview:status:test-file-123'
                ]
                assert len(status_calls) == 1
                ttl = status_calls[0][0][1]
                assert ttl == 3600

        _run(run())
