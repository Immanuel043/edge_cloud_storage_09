# tests/test_transcoder_preview_status.py
"""
Unit tests for preview status updates in _generate_thumbnails_for_transcoded().

Verifies that the video transcoder properly coordinates with the preview pipeline:
- All 3 sizes verified in cache before publishing ready
- Atomic single-notify via SET NX
- Skip-if-cached for already-generated sizes
- Partial success → failed+retryable (no WS push)
- Monotonic guard: never downgrade from ready

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


class _MockRedis:
    """Mock Redis that tracks setex'd keys so exists() returns True after cache writes."""

    def __init__(self, *, nx_returns=True, existing_status=None, pre_cached=None):
        self._cache = set(pre_cached or [])
        self._nx_returns = nx_returns
        self._existing_status = existing_status
        self.setex_calls = []
        self.publish_calls = []
        self.set_calls = []
        self.get_calls = []

    async def setex(self, key, ttl, value):
        self._cache.add(key)
        self.setex_calls.append((key, ttl, value))

    async def exists(self, key):
        return key in self._cache

    async def set(self, key, value, *, nx=False, ex=None):
        self.set_calls.append((key, value, nx, ex))
        if nx:
            return self._nx_returns
        return True

    async def get(self, key):
        self.get_calls.append(key)
        if key.startswith('preview:status:') and self._existing_status:
            return json.dumps(self._existing_status).encode()
        return None

    async def publish(self, channel, message):
        self.publish_calls.append((channel, message))


def _setup_lazy_import_mocks(mock_redis, mock_preview_gen, mock_should_persist, mock_save_disk, mock_cache_ttl):
    """
    Create patches for the lazy imports inside _generate_thumbnails_for_transcoded.
    """
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


def _make_preview_gen(success_count=3):
    """Create a mock preview generator that succeeds for the first N calls."""
    call_count = [0]

    async def mock_generate(file_path, mime_type, size, file_name):
        call_count[0] += 1
        if call_count[0] <= success_count:
            return (b'\xff\xd8\xff\xe0fake_jpeg_data', 'image/jpeg')
        raise Exception("Generation failed")

    gen = MagicMock()
    gen.generate_preview = mock_generate
    return gen


class TestGenerateThumbnailsPreviewStatus:
    """Verify _generate_thumbnails_for_transcoded updates preview status correctly."""

    def test_publishes_ready_when_all_3_cached_and_nx_succeeds(self):
        """All 3 sizes cached + NX succeeds → ready status + WS publish."""
        mock_redis = _MockRedis(nx_returns=True)
        mock_gen = _make_preview_gen(3)
        mock_modules = _setup_lazy_import_mocks(
            mock_redis, mock_gen, AsyncMock(return_value=True), MagicMock(), MagicMock(return_value=86400)
        )

        async def run():
            with patch.dict('sys.modules', mock_modules):
                result = await video_transcoder._generate_thumbnails_for_transcoded(
                    file_id='test-file-123',
                    transcoded_path='/tmp/test.mp4',
                    source_hash='abc123',
                    user_id='user-456',
                )
                assert result == 3

                # preview:status set to ready
                status_calls = [c for c in mock_redis.setex_calls if c[0] == 'preview:status:test-file-123']
                assert len(status_calls) == 1
                assert json.loads(status_calls[0][2])['status'] == 'ready'

                # NX was called
                nx_calls = [c for c in mock_redis.set_calls if c[2]]  # nx=True
                assert len(nx_calls) == 1
                assert nx_calls[0][0] == 'preview:notified:test-file-123'

                # WS notification published
                assert len(mock_redis.publish_calls) == 1
                notif = json.loads(mock_redis.publish_calls[0][1])
                assert notif['status'] == 'ready'
                assert notif['file_id'] == 'test-file-123'

        _run(run())

    def test_ready_but_nx_fails_skips_ws_publish(self):
        """All 3 sizes cached + NX fails (already notified) → ready status, NO WS publish."""
        mock_redis = _MockRedis(nx_returns=False)
        mock_gen = _make_preview_gen(3)
        mock_modules = _setup_lazy_import_mocks(
            mock_redis, mock_gen, AsyncMock(return_value=True), MagicMock(), MagicMock(return_value=86400)
        )

        async def run():
            with patch.dict('sys.modules', mock_modules):
                result = await video_transcoder._generate_thumbnails_for_transcoded(
                    file_id='test-file-123',
                    transcoded_path='/tmp/test.mp4',
                    source_hash='abc123',
                    user_id='user-456',
                )
                assert result == 3

                # Status still set to ready
                status_calls = [c for c in mock_redis.setex_calls if c[0] == 'preview:status:test-file-123']
                assert len(status_calls) == 1
                assert json.loads(status_calls[0][2])['status'] == 'ready'

                # NO WS publish
                assert len(mock_redis.publish_calls) == 0

        _run(run())

    def test_partial_success_sets_failed_retryable(self):
        """2/3 sizes cached → failed+retryable status, NO WS publish."""
        mock_redis = _MockRedis()
        mock_gen = _make_preview_gen(2)  # Only 2 succeed
        mock_modules = _setup_lazy_import_mocks(
            mock_redis, mock_gen, AsyncMock(return_value=True), MagicMock(), MagicMock(return_value=86400)
        )

        async def run():
            with patch.dict('sys.modules', mock_modules):
                result = await video_transcoder._generate_thumbnails_for_transcoded(
                    file_id='test-file-123',
                    transcoded_path='/tmp/test.mp4',
                    source_hash='abc123',
                    user_id='user-456',
                )
                assert result == 2

                # Status should be failed+retryable
                status_calls = [c for c in mock_redis.setex_calls if c[0] == 'preview:status:test-file-123']
                assert len(status_calls) == 1
                status_data = json.loads(status_calls[0][2])
                assert status_data['status'] == 'failed'
                assert status_data['retryable'] is True

                # NO WS publish
                assert len(mock_redis.publish_calls) == 0

        _run(run())

    def test_skip_if_cached_does_not_generate(self):
        """When a size is already cached, generate_preview is not called for it."""
        pre_cached = {'preview:test-file-123:small', 'preview:test-file-123:medium'}
        mock_redis = _MockRedis(pre_cached=pre_cached)

        generate_calls = []

        async def mock_generate(file_path, mime_type, size, file_name):
            generate_calls.append(size)
            return (b'\xff\xd8\xff\xe0fake_jpeg_data', 'image/jpeg')

        mock_gen = MagicMock()
        mock_gen.generate_preview = mock_generate
        mock_modules = _setup_lazy_import_mocks(
            mock_redis, mock_gen, AsyncMock(return_value=True), MagicMock(), MagicMock(return_value=86400)
        )

        async def run():
            with patch.dict('sys.modules', mock_modules):
                result = await video_transcoder._generate_thumbnails_for_transcoded(
                    file_id='test-file-123',
                    transcoded_path='/tmp/test.mp4',
                    source_hash='abc123',
                    user_id='user-456',
                )
                assert result == 3  # 2 skipped + 1 generated

                # generate_preview only called for 'large' (small and medium were cached)
                assert generate_calls == ['large']

        _run(run())

    def test_no_downgrade_from_ready_on_partial(self):
        """If ready already set by another pipeline, partial path doesn't downgrade."""
        mock_redis = _MockRedis(existing_status={'status': 'ready'})
        mock_gen = _make_preview_gen(1)  # Only 1/3 succeeds
        mock_modules = _setup_lazy_import_mocks(
            mock_redis, mock_gen, AsyncMock(return_value=True), MagicMock(), MagicMock(return_value=86400)
        )

        async def run():
            with patch.dict('sys.modules', mock_modules):
                result = await video_transcoder._generate_thumbnails_for_transcoded(
                    file_id='test-file-123',
                    transcoded_path='/tmp/test.mp4',
                    source_hash='abc123',
                    user_id='user-456',
                )
                assert result == 1

                # Status should NOT be overwritten to failed
                status_calls = [c for c in mock_redis.setex_calls if c[0] == 'preview:status:test-file-123']
                assert len(status_calls) == 0  # No status write at all

                # No WS publish
                assert len(mock_redis.publish_calls) == 0

        _run(run())

    def test_skips_publish_when_no_sizes(self):
        """When no thumbnails are cached (all fail), should NOT update preview status."""
        mock_redis = _MockRedis()
        mock_gen = _make_preview_gen(0)
        mock_modules = _setup_lazy_import_mocks(
            mock_redis, mock_gen, AsyncMock(return_value=True), MagicMock(), MagicMock(return_value=86400)
        )

        async def run():
            with patch.dict('sys.modules', mock_modules):
                result = await video_transcoder._generate_thumbnails_for_transcoded(
                    file_id='test-file-123',
                    transcoded_path='/tmp/test.mp4',
                    source_hash='abc123',
                    user_id='user-456',
                )
                assert result == 0
                status_calls = [c for c in mock_redis.setex_calls if c[0] == 'preview:status:test-file-123']
                assert len(status_calls) == 0
                assert len(mock_redis.publish_calls) == 0

        _run(run())

    def test_skips_publish_when_no_user_id(self):
        """When user_id is None, should cache thumbnails but NOT update preview status."""
        mock_redis = _MockRedis()
        mock_gen = _make_preview_gen(3)
        mock_modules = _setup_lazy_import_mocks(
            mock_redis, mock_gen, AsyncMock(return_value=True), MagicMock(), MagicMock(return_value=86400)
        )

        async def run():
            with patch.dict('sys.modules', mock_modules):
                result = await video_transcoder._generate_thumbnails_for_transcoded(
                    file_id='test-file-123',
                    transcoded_path='/tmp/test.mp4',
                    source_hash='abc123',
                    user_id=None,
                )
                assert result == 3

                # Thumbnails cached
                thumb_calls = [c for c in mock_redis.setex_calls if c[0].startswith('preview:test-file-123:')]
                assert len(thumb_calls) == 3

                # No status update
                status_calls = [c for c in mock_redis.setex_calls if c[0] == 'preview:status:test-file-123']
                assert len(status_calls) == 0
                assert len(mock_redis.publish_calls) == 0

        _run(run())

    def test_returns_zero_on_complete_failure(self):
        """When the entire method fails (e.g., Redis unavailable), should return 0."""
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
        """The preview:status TTL should be 3600s (1 hour)."""
        mock_redis = _MockRedis(nx_returns=True)
        mock_gen = _make_preview_gen(3)
        mock_modules = _setup_lazy_import_mocks(
            mock_redis, mock_gen, AsyncMock(return_value=True), MagicMock(), MagicMock(return_value=86400)
        )

        async def run():
            with patch.dict('sys.modules', mock_modules):
                await video_transcoder._generate_thumbnails_for_transcoded(
                    file_id='test-file-123',
                    transcoded_path='/tmp/test.mp4',
                    source_hash='abc123',
                    user_id='user-456',
                )

                status_calls = [c for c in mock_redis.setex_calls if c[0] == 'preview:status:test-file-123']
                assert len(status_calls) == 1
                assert status_calls[0][1] == 3600

        _run(run())
