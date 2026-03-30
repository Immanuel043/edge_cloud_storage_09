# tests/test_skip_path_optimization.py
"""
Unit tests for skip-path optimization: partial download for moov-at-front videos,
moov_at_end probe flag, disk space checks.

Run with: python -m pytest tests/test_skip_path_optimization.py -v
"""

import asyncio
import os
import sys
import types
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault('DATABASE_URL', 'postgresql+asyncpg://x:x@localhost:5432/test')
os.environ.setdefault('SECRET_KEY', 'test_secret_key_for_testing_only_32b')

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

with patch('os.makedirs'):
    from app.services.video_transcoder import video_transcoder, _check_disk_space_simple
    from app.services.video_ingestion_service import _check_disk_space


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _make_file_obj(**overrides):
    """Create a mock file object with sensible defaults."""
    obj = MagicMock()
    obj.id = overrides.get('id', 'file-123')
    obj.file_name = overrides.get('file_name', 'test.mp4')
    obj.file_size = overrides.get('file_size', 500 * 1024 * 1024)
    obj.mime_type = overrides.get('mime_type', 'video/mp4')
    obj.storage_type = overrides.get('storage_type', 'content_addressed')
    obj.content_hash = overrides.get('content_hash', 'abc123')
    obj.user_id = overrides.get('user_id', 'user-456')
    obj.encryption_key = overrides.get('encryption_key', b'enc_key')
    obj.object_path = overrides.get('object_path', None)
    obj.file_metadata = overrides.get('file_metadata', {})
    obj.chunk_info = overrides.get('chunk_info', {
        'blocks': [{'offset': 0, 'size': 64 * 1024 * 1024}],
        'stored_blocks': [{'hash': 'h1', 'path': '/tmp/b1'}],
    })
    return obj


# ---- moov_at_end flag tests ----

class TestMoovAtEndFlag:
    """Verify _probe_file_metadata sets moov_at_end correctly."""

    def test_probe_moov_flag_head(self):
        """Head probe succeeds → moov_at_end should be False."""
        file_obj = _make_file_obj()

        async def run():
            with patch.object(video_transcoder, '_run_ffprobe_async', new_callable=AsyncMock) as mock_probe:
                mock_probe.return_value = {'codec_name': 'h264', 'audio_codec': 'aac',
                                           'duration': 60, 'width': 1920, 'height': 1080, 'bitrate': 5000000}
                with patch('app.services.video_transcoder._fetch_from_cas', new_callable=AsyncMock) as mock_cas:
                    mock_cas.return_value = 1024 * 1024  # 1MB written
                    result = await video_transcoder._probe_file_metadata(file_obj, MagicMock())

            assert result is not None
            assert result['moov_at_end'] is False

        _run(run())

    def test_probe_moov_flag_tail(self):
        """Head probe fails, tail succeeds → moov_at_end should be True."""
        file_obj = _make_file_obj(file_name='test.mp4')

        call_count = [0]

        async def mock_ffprobe(path, name):
            call_count[0] += 1
            if call_count[0] == 1:
                return None  # head probe fails
            # tail probe succeeds
            return {'codec_name': 'hevc', 'audio_codec': 'aac',
                    'duration': 120, 'width': 3840, 'height': 2160, 'bitrate': 0}

        async def run():
            with patch.object(video_transcoder, '_run_ffprobe_async', side_effect=mock_ffprobe):
                with patch('app.services.video_transcoder._fetch_from_cas', new_callable=AsyncMock) as mock_cas:
                    # Head returns data but ffprobe fails on it; tail returns data with moov
                    mock_cas.return_value = 64 * 1024 * 1024
                    with patch('app.services.video_transcoder._find_moov_atom') as mock_find:
                        mock_find.return_value = (0, 1000)  # moov found at offset 0
                        with patch('aiofiles.open', create=True):
                            with patch('builtins.open', create=True):
                                with patch('asyncio.to_thread', new_callable=AsyncMock):
                                    with patch('os.path.exists', return_value=True):
                                        with patch('os.remove'):
                                            result = await video_transcoder._probe_file_metadata(
                                                file_obj, MagicMock()
                                            )

            assert result is not None
            assert result['moov_at_end'] is True

        _run(run())


# ---- _build_thumbnail_probe_file tests ----

class TestBuildThumbnailProbeFile:
    """Verify _build_thumbnail_probe_file returns True/False correctly."""

    def test_moov_front_cas_builds_file(self):
        """moov-at-front + CAS storage → should build partial file and return True."""
        file_obj = _make_file_obj(storage_type='content_addressed')
        probe_data = {'moov_at_end': False, 'codec_name': 'h264'}

        async def run():
            with patch('app.services.video_transcoder._fetch_from_cas', new_callable=AsyncMock) as mock_cas:
                mock_cas.return_value = 64 * 1024 * 1024
                result = await video_transcoder._build_thumbnail_probe_file(
                    file_obj, MagicMock(), probe_data, '/tmp/test_probe.partial'
                )
            assert result is True
            mock_cas.assert_called_once()

        _run(run())

    def test_moov_end_returns_false(self):
        """moov-at-end → should return False (caller uses full download)."""
        file_obj = _make_file_obj()
        probe_data = {'moov_at_end': True}

        async def run():
            result = await video_transcoder._build_thumbnail_probe_file(
                file_obj, MagicMock(), probe_data, '/tmp/test.partial'
            )
            assert result is False

        _run(run())

    def test_single_storage_returns_false(self):
        """Single storage → should return False (AES-GCM needs full ciphertext)."""
        file_obj = _make_file_obj(storage_type='single')
        probe_data = {'moov_at_end': False}

        async def run():
            result = await video_transcoder._build_thumbnail_probe_file(
                file_obj, MagicMock(), probe_data, '/tmp/test.partial'
            )
            assert result is False

        _run(run())

    def test_moov_front_chunked_builds_file(self):
        """moov-at-front + traditional chunked storage → should build via Rust."""
        file_obj = _make_file_obj(
            storage_type='chunked',
            chunk_info={'paths': {'0': '/tmp/c0', '1': '/tmp/c1'}},
        )
        mock_enc = MagicMock()
        mock_enc.decrypt_key.return_value = b'decrypted_key'
        probe_data = {'moov_at_end': False}

        async def run():
            with patch.object(
                video_transcoder, '_build_probe_file_with_rust',
                new_callable=AsyncMock, return_value=64 * 1024 * 1024,
            ):
                result = await video_transcoder._build_thumbnail_probe_file(
                    file_obj, mock_enc, probe_data, '/tmp/test.partial'
                )
            assert result is True

        _run(run())

    def test_cas_fetch_failure_returns_false(self):
        """CAS fetch returning 0 bytes → should return False."""
        file_obj = _make_file_obj(storage_type='content_addressed')
        probe_data = {'moov_at_end': False}

        async def run():
            with patch('app.services.video_transcoder._fetch_from_cas', new_callable=AsyncMock) as mock_cas:
                mock_cas.return_value = 0
                result = await video_transcoder._build_thumbnail_probe_file(
                    file_obj, MagicMock(), probe_data, '/tmp/test.partial'
                )
            assert result is False

        _run(run())


# ---- Disk space check tests ----

class TestDiskSpaceChecks:
    """Verify disk space utilities."""

    def test_check_disk_space_simple_sufficient(self):
        """Should return True when plenty of space available."""
        with patch('shutil.disk_usage') as mock_usage:
            mock_usage.return_value = MagicMock(free=50 * 1024 * 1024 * 1024)  # 50GB free
            assert _check_disk_space_simple(10 * 1024 * 1024 * 1024) is True  # need 10GB

    def test_check_disk_space_simple_insufficient(self):
        """Should return False when not enough space."""
        with patch('shutil.disk_usage') as mock_usage:
            mock_usage.return_value = MagicMock(free=500 * 1024 * 1024)  # 500MB free
            assert _check_disk_space_simple(10 * 1024 * 1024 * 1024) is False

    def test_check_disk_space_simple_os_error(self):
        """Should return True (optimistic) when OS can't check."""
        with patch('shutil.disk_usage', side_effect=OSError("no such path")):
            assert _check_disk_space_simple(10 * 1024 * 1024 * 1024) is True

    def test_ingestion_check_disk_space_sufficient(self):
        """Ingestion service disk check — sufficient space."""
        with patch('shutil.disk_usage') as mock_usage:
            mock_usage.return_value = MagicMock(free=20 * 1024 * 1024 * 1024)
            assert _check_disk_space(5 * 1024 * 1024 * 1024) is True

    def test_ingestion_check_disk_space_insufficient(self):
        """Ingestion service disk check — insufficient space."""
        with patch('shutil.disk_usage') as mock_usage:
            mock_usage.return_value = MagicMock(free=500 * 1024 * 1024)
            assert _check_disk_space(5 * 1024 * 1024 * 1024) is False
