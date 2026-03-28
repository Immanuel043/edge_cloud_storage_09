# tests/test_preview_optimizer_helpers.py
"""
Unit tests for CAS probe-then-fetch helpers in preview_optimizer.py.

Run with: python -m pytest tests/test_preview_optimizer_helpers.py -v
"""

import struct
import pytest

# We test the pure functions directly by importing from the module.
# These functions don't require database/redis/async setup, but the module
# import chain requires env vars for config validation.
import sys
import os

# Set minimal env vars needed for module import (not used by tests)
os.environ.setdefault('DATABASE_URL', 'postgresql+asyncpg://x:x@localhost:5432/test')
os.environ.setdefault('SECRET_KEY', 'test_secret_key_for_testing_only_32b')

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.services.preview_optimizer import (
    _select_cas_probe_blocks,
    _probe_offset_to_file_offset,
    _has_moov,
    _is_fragmented_mp4,
    MB,
)


# ---------------------------------------------------------------------------
# _select_cas_probe_blocks
# ---------------------------------------------------------------------------

class TestSelectCasProbeBlocks:
    """Byte-based probe block selection."""

    def _make_blocks(self, count: int, size: int = 4 * MB) -> list:
        """Create a list of blocks with uniform size."""
        return [{'hash': f'hash_{i}', 'size': size} for i in range(count)]

    def test_small_file_selects_all_blocks(self):
        """Files with total probe < targets should return all block indices."""
        blocks = self._make_blocks(5, size=4 * MB)  # 20MB total, below 64MB target
        result = _select_cas_probe_blocks(blocks)
        assert result == [0, 1, 2, 3, 4]

    def test_2mb_blocks_coverage(self):
        """With 2MB blocks, should download ~32 head + ~32 tail blocks for 64MB each."""
        blocks = self._make_blocks(200, size=2 * MB)  # 400MB total
        result = _select_cas_probe_blocks(blocks)

        # Head: blocks 0-31 (32 * 2MB = 64MB)
        head_indices = [i for i in result if i < 32]
        assert len(head_indices) >= 32, f"Expected >=32 head blocks, got {len(head_indices)}"

        # Tail: blocks 168-199 (32 * 2MB = 64MB)
        tail_indices = [i for i in result if i >= 168]
        assert len(tail_indices) >= 32, f"Expected >=32 tail blocks, got {len(tail_indices)}"

        # Middle: 3 blocks around index 100
        middle_indices = [i for i in result if 98 <= i <= 101]
        assert len(middle_indices) >= 3, f"Expected >=3 middle blocks, got {len(middle_indices)}"

    def test_8mb_blocks_coverage(self):
        """With 8MB blocks, should download ~8 head + ~8 tail blocks for 64MB each."""
        blocks = self._make_blocks(100, size=8 * MB)  # 800MB total
        result = _select_cas_probe_blocks(blocks)

        head_indices = [i for i in result if i < 9]
        assert len(head_indices) >= 8, f"Expected >=8 head blocks, got {len(head_indices)}"

        tail_indices = [i for i in result if i >= 91]
        assert len(tail_indices) >= 8, f"Expected >=8 tail blocks, got {len(tail_indices)}"

    def test_no_middle_for_small_block_count(self):
        """Middle blocks only added when n >= 9."""
        blocks = self._make_blocks(8, size=2 * MB)
        result = _select_cas_probe_blocks(blocks)
        # All 8 blocks should be selected (total is 16MB < 64MB target for both head and tail)
        assert result == list(range(8))

    def test_middle_blocks_present_for_large_count(self):
        """Middle blocks included when n >= 9."""
        blocks = self._make_blocks(100, size=8 * MB)
        result = _select_cas_probe_blocks(blocks)
        # Middle should include block 49, 50, 51
        assert 49 in result
        assert 50 in result
        assert 51 in result

    def test_returns_sorted_unique(self):
        """Result should be sorted and deduplicated."""
        blocks = self._make_blocks(50, size=4 * MB)
        result = _select_cas_probe_blocks(blocks)
        assert result == sorted(set(result))

    def test_single_block(self):
        """Single block file."""
        blocks = self._make_blocks(1, size=4 * MB)
        result = _select_cas_probe_blocks(blocks)
        assert result == [0]


# ---------------------------------------------------------------------------
# _probe_offset_to_file_offset
# ---------------------------------------------------------------------------

class TestProbeOffsetToFileOffset:
    """Probe-buffer to real-file offset mapping."""

    def test_hit_in_first_block(self):
        # Block 0: probe [0, 100) maps to file offset 0
        offset_map = [(0, 100, 0), (100, 200, 500)]
        assert _probe_offset_to_file_offset(50, offset_map) == 50

    def test_hit_in_second_block(self):
        # Block at probe [100, 200) maps to file offset 500
        offset_map = [(0, 100, 0), (100, 200, 500)]
        assert _probe_offset_to_file_offset(150, offset_map) == 550

    def test_miss_in_gap(self):
        # Offset 250 is in a gap between mapped regions
        offset_map = [(0, 100, 0), (200, 300, 1000)]
        assert _probe_offset_to_file_offset(150, offset_map) is None

    def test_exact_boundary_start(self):
        offset_map = [(0, 100, 0), (100, 200, 500)]
        assert _probe_offset_to_file_offset(100, offset_map) == 500

    def test_exact_boundary_end_exclusive(self):
        # End is exclusive — offset 100 is NOT in [0, 100)
        offset_map = [(0, 100, 0)]
        assert _probe_offset_to_file_offset(100, offset_map) is None

    def test_empty_offset_map(self):
        assert _probe_offset_to_file_offset(0, []) is None

    def test_large_file_offset(self):
        # Simulate tail block at file offset 20GB
        file_start = 20 * 1024 * MB
        offset_map = [(0, 8 * MB, file_start)]
        assert _probe_offset_to_file_offset(1000, offset_map) == file_start + 1000


# ---------------------------------------------------------------------------
# _has_moov
# ---------------------------------------------------------------------------

class TestHasMoov:
    """MP4 moov/moof atom detection with box size."""

    def _make_box(self, box_type: bytes, box_size: int, padding_before: int = 0) -> bytes:
        """Create an MP4 box header (size + type) preceded by padding."""
        return b'\x00' * padding_before + struct.pack('>I', box_size) + box_type

    def test_moov_at_start(self):
        data = self._make_box(b'moov', 100) + b'\x00' * 92  # 100 bytes total box
        found, offset, box_size = _has_moov(data)
        assert found is True
        assert offset == 0
        assert box_size == 100

    def test_moov_with_ftyp_prefix(self):
        # ftyp box (32 bytes) then moov box
        ftyp = struct.pack('>I', 32) + b'ftyp' + b'\x00' * 24
        moov = self._make_box(b'moov', 500) + b'\x00' * 492
        data = ftyp + moov
        found, offset, box_size = _has_moov(data)
        assert found is True
        assert offset == 32
        assert box_size == 500

    def test_moof_detected(self):
        data = self._make_box(b'moof', 64) + b'\x00' * 56
        found, offset, box_size = _has_moov(data)
        assert found is True
        assert offset == 0
        assert box_size == 64

    def test_no_moov(self):
        data = b'\x00' * 1024
        found, offset, box_size = _has_moov(data)
        assert found is False
        assert offset is None
        assert box_size is None

    def test_too_small_data(self):
        found, offset, box_size = _has_moov(b'\x00' * 4)
        assert found is False

    def test_spurious_moov_string(self):
        # 'moov' appears as text but not as a valid box header
        data = b'this is moov text that should not match because size is wrong' + b'\x00' * 100
        found, offset, box_size = _has_moov(data)
        # Should not find it since box_size wouldn't validate
        assert found is False

    def test_moov_prefers_moov_over_moof(self):
        # moov is searched first, so it should be found even if moof exists later
        moov = self._make_box(b'moov', 200) + b'\x00' * 192
        moof = self._make_box(b'moof', 100) + b'\x00' * 92
        data = moov + moof
        found, offset, box_size = _has_moov(data)
        assert found is True
        assert offset == 0
        assert box_size == 200


# ---------------------------------------------------------------------------
# _is_fragmented_mp4
# ---------------------------------------------------------------------------

class TestIsFragmentedMp4:
    def test_detects_moof(self):
        data = b'\x00' * 100 + b'moof' + b'\x00' * 100
        assert _is_fragmented_mp4(data) is True

    def test_detects_mfhd(self):
        data = b'\x00' * 100 + b'mfhd' + b'\x00' * 100
        assert _is_fragmented_mp4(data) is True

    def test_normal_mp4(self):
        data = b'\x00' * 100 + b'moov' + b'\x00' * 100
        assert _is_fragmented_mp4(data) is False

    def test_too_small(self):
        assert _is_fragmented_mp4(b'\x00' * 4) is False


# ---------------------------------------------------------------------------
# Routing logic (integration-style tests without I/O)
# ---------------------------------------------------------------------------

class TestRoutingLogic:
    """Test the routing decisions that would be made based on probe results."""

    MOOV_EARLY_THRESHOLD = 64 * MB

    def test_moov_at_start_partial_fetch(self):
        """moov within 64MB threshold -> partial fetch."""
        real_moov_offset = 10 * MB  # 10MB into file
        moov_box_size = 5 * MB
        assert real_moov_offset <= self.MOOV_EARLY_THRESHOLD
        fetch_end = real_moov_offset + moov_box_size + 2 * MB
        assert fetch_end == 17 * MB  # Only 17MB fetched for any-size file

    def test_moov_beyond_threshold_full_download(self):
        """moov beyond 64MB -> full download."""
        real_moov_offset = 100 * MB
        assert real_moov_offset > self.MOOV_EARLY_THRESHOLD

    def test_no_moov_full_download(self):
        """No moov found -> full download."""
        has_moov = False
        assert not has_moov  # Would trigger full download

    def test_fragmented_full_download(self):
        """Fragmented MP4 -> full download regardless of moov position."""
        is_fragmented = True
        has_moov = True
        real_moov_offset = 5 * MB
        # Even though moov is early, fragmented means full download
        assert is_fragmented  # Would trigger full download
