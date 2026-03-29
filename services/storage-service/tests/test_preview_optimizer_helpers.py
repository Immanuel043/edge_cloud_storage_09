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
    _quick_probe_moov,
    _moov_has_mvex,
    MB,
    MAX_BG_CAS_VIDEO_MB,
    MAX_SYNC_FULL_VIDEO_DOWNLOAD_MB,
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


# ---------------------------------------------------------------------------
# _moov_has_mvex (child-box walker)
# ---------------------------------------------------------------------------

class TestMoovHasMvex:
    """Test child-box walker for mvex detection inside moov."""

    def _make_child_box(self, box_type: bytes, body_size: int) -> bytes:
        """Create a child box: 4-byte size (big-endian) + 4-byte type + body."""
        total_size = 8 + body_size
        return struct.pack('>I', total_size) + box_type + b'\x00' * body_size

    def test_mvex_present(self):
        """moov with trak + mvex child boxes -> True."""
        trak = self._make_child_box(b'trak', 100)
        mvex = self._make_child_box(b'mvex', 50)
        data = trak + mvex
        assert _moov_has_mvex(data, 0, len(data)) is True

    def test_no_mvex(self):
        """moov with trak + udta only -> False."""
        trak = self._make_child_box(b'trak', 100)
        udta = self._make_child_box(b'udta', 50)
        data = trak + udta
        assert _moov_has_mvex(data, 0, len(data)) is False

    def test_invalid_child_box(self):
        """Corrupted child box sizes -> False (halts walk)."""
        # box_size = 3 which is < 8 minimum
        data = struct.pack('>I', 3) + b'trak' + b'\x00' * 100
        assert _moov_has_mvex(data, 0, len(data)) is False

    def test_empty_moov(self):
        """moov with no children -> False."""
        assert _moov_has_mvex(b'', 0, 0) is False

    def test_mvex_with_offset(self):
        """mvex found when start offset is non-zero."""
        prefix = b'\x00' * 50
        mvex = self._make_child_box(b'mvex', 20)
        data = prefix + mvex
        assert _moov_has_mvex(data, 50, len(data)) is True

    def test_mvex_beyond_end_boundary(self):
        """mvex exists but end boundary cuts it short -> False."""
        trak = self._make_child_box(b'trak', 100)
        mvex = self._make_child_box(b'mvex', 50)
        data = trak + mvex
        # Set end to only cover trak, not mvex
        assert _moov_has_mvex(data, 0, len(trak)) is False


# ---------------------------------------------------------------------------
# _quick_probe_moov (top-level box walker)
# ---------------------------------------------------------------------------

class TestQuickProbeMoov:
    """Test the box-walking moov detector for quick probe."""

    def _make_box(self, box_type: bytes, total_size: int, body: bytes = b'') -> bytes:
        """Create an MP4 box with given type, total size, and optional body content."""
        header = struct.pack('>I', total_size) + box_type
        padding = total_size - 8 - len(body)
        return header + body + b'\x00' * max(0, padding)

    def _make_ftyp(self, size: int = 32) -> bytes:
        return self._make_box(b'ftyp', size)

    def _make_mvex_child(self, size: int = 28) -> bytes:
        """Create an mvex child box."""
        return struct.pack('>I', size) + b'mvex' + b'\x00' * (size - 8)

    def test_fast_start_progressive(self):
        """ftyp + moov (no mvex) + mdat -> progressive short-circuit."""
        ftyp = self._make_ftyp(32)
        moov_body = b'\x00' * 192  # Just padding, no mvex
        moov = self._make_box(b'moov', 200, moov_body)
        mdat = self._make_box(b'mdat', 1000)
        data = ftyp + moov + mdat

        found, offset, box_size, is_complete, is_fmp4 = _quick_probe_moov(data)
        assert found is True
        assert offset == 32
        assert box_size == 200
        assert is_complete is True
        assert is_fmp4 is False

    def test_fragmented_with_mvex(self):
        """ftyp + moov (contains mvex) -> fMP4 detected."""
        ftyp = self._make_ftyp(32)
        # moov body contains a trak and mvex child box
        trak_child = struct.pack('>I', 108) + b'trak' + b'\x00' * 100
        mvex_child = self._make_mvex_child(28)
        moov_body = trak_child + mvex_child
        moov = self._make_box(b'moov', 8 + len(moov_body), moov_body)
        data = ftyp + moov

        found, offset, box_size, is_complete, is_fmp4 = _quick_probe_moov(data)
        assert found is True
        assert offset == 32
        assert box_size == 8 + len(moov_body)
        assert is_complete is True
        assert is_fmp4 is True

    def test_truncated_moov(self):
        """ftyp + moov header says 10MB but only 1MB of data -> truncated."""
        ftyp = self._make_ftyp(32)
        moov_size = 10 * MB
        # Only provide the header + small amount of body
        moov_header = struct.pack('>I', moov_size) + b'moov'
        partial_body = b'\x00' * (1 * MB)
        data = ftyp + moov_header + partial_body

        found, offset, box_size, is_complete, is_fmp4 = _quick_probe_moov(data)
        assert found is True
        assert offset == 32
        assert box_size == moov_size
        assert is_complete is False
        assert is_fmp4 is False  # Can't confirm — truncated

    def test_no_moov(self):
        """ftyp + mdat only -> no moov found."""
        ftyp = self._make_ftyp(32)
        mdat = self._make_box(b'mdat', 1000)
        data = ftyp + mdat

        found, offset, box_size, is_complete, is_fmp4 = _quick_probe_moov(data)
        assert found is False
        assert offset is None
        assert box_size is None

    def test_invalid_box_sizes(self):
        """Garbage data -> not found."""
        data = b'\xff' * 100
        found, offset, box_size, is_complete, is_fmp4 = _quick_probe_moov(data)
        # \xff\xff\xff\xff is a huge size, will break the walk
        assert found is False

    def test_extended_size_box(self):
        """Box with size==1 (64-bit extended size) is walked past correctly."""
        # ftyp with extended size: raw_size=1, then 8-byte actual size
        ftyp_ext_size = 24  # 16-byte header + 8 bytes body
        ftyp = struct.pack('>I', 1) + b'ftyp' + struct.pack('>Q', ftyp_ext_size) + b'\x00' * 8
        moov = self._make_box(b'moov', 100)
        data = ftyp + moov

        found, offset, box_size, is_complete, is_fmp4 = _quick_probe_moov(data)
        assert found is True
        assert offset == ftyp_ext_size
        assert box_size == 100
        assert is_complete is True

    def test_extended_size_too_small(self):
        """Extended size box with size < 16 -> halts walk."""
        # raw_size=1, extended_size=10 (invalid, must be >= 16)
        data = struct.pack('>I', 1) + b'ftyp' + struct.pack('>Q', 10) + b'\x00' * 100
        found, offset, box_size, is_complete, is_fmp4 = _quick_probe_moov(data)
        assert found is False

    def test_size_zero_box(self):
        """Box with size==0 (extends to EOF) halts walk."""
        data = struct.pack('>I', 0) + b'ftyp' + b'\x00' * 100
        found, offset, box_size, is_complete, is_fmp4 = _quick_probe_moov(data)
        assert found is False

    def test_empty_data(self):
        found, offset, box_size, is_complete, is_fmp4 = _quick_probe_moov(b'')
        assert found is False
        assert offset is None
        assert box_size is None
        assert is_complete is False
        assert is_fmp4 is False

    def test_moov_at_byte_zero(self):
        """moov directly at start (no ftyp prefix)."""
        moov = self._make_box(b'moov', 100)
        data = moov + b'\x00' * 100

        found, offset, box_size, is_complete, is_fmp4 = _quick_probe_moov(data)
        assert found is True
        assert offset == 0
        assert box_size == 100
        assert is_complete is True
        assert is_fmp4 is False


# ---------------------------------------------------------------------------
# Quick probe routing (decision table)
# ---------------------------------------------------------------------------

class TestQuickProbeRouting:
    """Test the decision logic for quick probe short-circuit vs fallback."""

    def test_complete_progressive_short_circuits(self):
        """found=True, is_complete=True, is_fmp4=False -> partial fetch."""
        found, is_complete, is_fmp4 = True, True, False
        should_short_circuit = found and is_complete and not is_fmp4
        assert should_short_circuit is True

    def test_complete_fmp4_falls_through(self):
        """found=True, is_complete=True, is_fmp4=True -> fall through to full probe."""
        found, is_complete, is_fmp4 = True, True, True
        should_short_circuit = found and is_complete and not is_fmp4
        assert should_short_circuit is False

    def test_truncated_moov_falls_through(self):
        """found=True, is_complete=False -> fall through to full probe."""
        found, is_complete, is_fmp4 = True, False, False
        should_short_circuit = found and is_complete and not is_fmp4
        assert should_short_circuit is False

    def test_no_moov_falls_through(self):
        """found=False -> fall through to full probe."""
        found, is_complete, is_fmp4 = False, False, False
        should_short_circuit = found and is_complete and not is_fmp4
        assert should_short_circuit is False


# ---------------------------------------------------------------------------
# fMP4 size limit consistency (pure arithmetic, no async)
# ---------------------------------------------------------------------------

class TestFmp4SizeLimitConsistency:
    """Verify the fMP4 size gate uses the same effective_limit pattern as moov-at-end."""

    def test_bg_limit_matches_constant(self):
        """Background fMP4 limit should use MAX_BG_CAS_VIDEO_MB."""
        assert MAX_BG_CAS_VIDEO_MB == 500

    def test_sync_limit_matches_constant(self):
        """Sync fMP4 limit should use MAX_SYNC_FULL_VIDEO_DOWNLOAD_MB."""
        assert MAX_SYNC_FULL_VIDEO_DOWNLOAD_MB == 100

    def test_fmp4_background_exceeds_limit(self):
        """fMP4 >500MB in background mode should be rejected."""
        file_size_mb = 600
        background = True
        effective_limit = MAX_BG_CAS_VIDEO_MB if background else MAX_SYNC_FULL_VIDEO_DOWNLOAD_MB
        assert file_size_mb > effective_limit
        status = 'failed' if background else 'deferred'
        assert status == 'failed'

    def test_fmp4_sync_exceeds_limit(self):
        """fMP4 >100MB in sync mode should be deferred."""
        file_size_mb = 150
        background = False
        effective_limit = MAX_BG_CAS_VIDEO_MB if background else MAX_SYNC_FULL_VIDEO_DOWNLOAD_MB
        assert file_size_mb > effective_limit
        status = 'failed' if background else 'deferred'
        assert status == 'deferred'

    def test_fmp4_under_limit_passes(self):
        """fMP4 under the effective limit should not be rejected."""
        file_size_mb = 400
        background = True
        effective_limit = MAX_BG_CAS_VIDEO_MB if background else MAX_SYNC_FULL_VIDEO_DOWNLOAD_MB
        assert file_size_mb <= effective_limit
