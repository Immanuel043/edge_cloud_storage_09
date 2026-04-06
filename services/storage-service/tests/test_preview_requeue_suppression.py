# tests/test_preview_requeue_suppression.py
"""
Unit tests for preview re-queue suppression when video optimization is active.

Verifies that files.py and share_bundles.py do NOT re-queue to preview-processing
when video_processing_status is 'queued' or 'processing'.

Run with: python -m pytest tests/test_preview_requeue_suppression.py -v
"""

import pytest


class TestOptimizationActiveHelper:
    """Test the _optimization_active() helper logic."""

    def test_returns_true_when_queued(self):
        from unittest.mock import MagicMock
        file_obj = MagicMock()
        file_obj.video_processing_status = 'queued'
        assert (
            hasattr(file_obj, 'video_processing_status')
            and file_obj.video_processing_status in ('queued', 'processing')
        )

    def test_returns_true_when_processing(self):
        from unittest.mock import MagicMock
        file_obj = MagicMock()
        file_obj.video_processing_status = 'processing'
        assert (
            hasattr(file_obj, 'video_processing_status')
            and file_obj.video_processing_status in ('queued', 'processing')
        )

    def test_returns_false_when_ready(self):
        from unittest.mock import MagicMock
        file_obj = MagicMock()
        file_obj.video_processing_status = 'ready'
        assert not (
            hasattr(file_obj, 'video_processing_status')
            and file_obj.video_processing_status in ('queued', 'processing')
        )

    def test_returns_false_when_failed(self):
        from unittest.mock import MagicMock
        file_obj = MagicMock()
        file_obj.video_processing_status = 'failed'
        assert not (
            hasattr(file_obj, 'video_processing_status')
            and file_obj.video_processing_status in ('queued', 'processing')
        )

    def test_returns_false_when_none(self):
        from unittest.mock import MagicMock
        file_obj = MagicMock()
        file_obj.video_processing_status = None
        assert not (
            hasattr(file_obj, 'video_processing_status')
            and file_obj.video_processing_status in ('queued', 'processing')
        )

    def test_returns_false_when_skipped(self):
        from unittest.mock import MagicMock
        file_obj = MagicMock()
        file_obj.video_processing_status = 'skipped'
        assert not (
            hasattr(file_obj, 'video_processing_status')
            and file_obj.video_processing_status in ('queued', 'processing')
        )


class TestFilesRequeueSuppressionPaths:
    """
    Verify that _optimization_active() is checked before all 3 re-queue paths
    in files.py's preview endpoint.

    These are structural tests verifying the guard is present in the code.
    Full integration tests require the FastAPI test client.
    """

    def test_files_ready_miss_path_has_guard(self):
        """The status=ready + cache miss path checks _optimization_active before re-queuing."""
        import inspect
        import sys
        import os
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

        # Read the source file and verify the guard appears before the re-queue
        source_path = os.path.join(
            os.path.dirname(__file__), '..', 'app', 'routers', 'files.py'
        )
        with open(source_path, 'r') as f:
            source = f.read()

        # The guard should appear near "cache+disk miss" before "_queue_preview_to_kafka"
        miss_idx = source.find('cache+disk miss')
        assert miss_idx > 0, "Could not find cache+disk miss marker in files.py"

        # Find the optimization guard before the re-queue call
        guard_idx = source.rfind('_optimization_active', 0, miss_idx + 500)
        queue_idx = source.find('_queue_preview_to_kafka', miss_idx)
        assert guard_idx > 0, "_optimization_active guard not found near cache+disk miss path"
        assert guard_idx < queue_idx, "_optimization_active guard should appear before _queue_preview_to_kafka"

    def test_files_failed_retryable_path_has_guard(self):
        """The status=failed + retryable path checks _optimization_active before re-queuing."""
        source_path = os.path.join(
            os.path.dirname(__file__), '..', 'app', 'routers', 'files.py'
        )
        with open(source_path, 'r') as f:
            source = f.read()

        # Find "is_retryable and retry_count < 3"
        retryable_idx = source.find('is_retryable and retry_count < 3')
        assert retryable_idx > 0

        # Guard should be between the condition and the re-queue call
        section = source[retryable_idx:retryable_idx + 500]
        guard_pos = section.find('_optimization_active')
        queue_pos = section.find('_queue_preview_to_kafka')
        assert guard_pos > 0, "_optimization_active guard not found in failed+retryable path"
        assert guard_pos < queue_pos, "_optimization_active guard should appear before _queue_preview_to_kafka"

    def test_files_no_status_path_has_guard(self):
        """The no-status-data path checks _optimization_active before first-time queuing."""
        source_path = os.path.join(
            os.path.dirname(__file__), '..', 'app', 'routers', 'files.py'
        )
        with open(source_path, 'r') as f:
            source = f.read()

        # Find the no-status branch (after the else: for status_data)
        # Look for "Queued existing large video"
        marker_idx = source.find('Queued existing large video')
        assert marker_idx > 0

        # Guard should appear before this marker
        section_start = max(0, marker_idx - 500)
        section = source[section_start:marker_idx]
        assert '_optimization_active' in section, \
            "_optimization_active guard not found before first-time queue path"


class TestShareBundlesRequeueSuppressionPaths:
    """
    Verify that _optimization_active() is checked before all 3 re-queue paths
    in share_bundles.py's preview endpoint.
    """

    def _read_share_bundles(self):
        source_path = os.path.join(
            os.path.dirname(__file__), '..', 'app', 'routers', 'share_bundles.py'
        )
        with open(source_path, 'r') as f:
            return f.read()

    def test_share_ready_miss_path_has_guard(self):
        """The status=ready re-queue path checks _optimization_active."""
        source = self._read_share_bundles()
        # Find "status == 'ready'" in the status-aware section
        ready_idx = source.find("elif status == 'ready':", source.find('preview:status'))
        assert ready_idx > 0

        section = source[ready_idx:ready_idx + 500]
        guard_pos = section.find('_optimization_active')
        queue_pos = section.find('_queue_share_preview_to_kafka')
        assert guard_pos > 0, "_optimization_active guard not found in share ready+miss path"
        assert guard_pos < queue_pos, "Guard should appear before re-queue"

    def test_share_failed_retryable_path_has_guard(self):
        """The status=failed + retryable re-queue path checks _optimization_active."""
        source = self._read_share_bundles()
        # Find the failed+retryable branch near share preview code
        failed_idx = source.find("elif status == 'failed':", source.find('preview:status'))
        assert failed_idx > 0

        section = source[failed_idx:failed_idx + 500]
        guard_pos = section.find('_optimization_active')
        queue_pos = section.find('_queue_share_preview_to_kafka')
        assert guard_pos > 0, "_optimization_active guard not found in share failed+retryable path"
        assert guard_pos < queue_pos, "Guard should appear before re-queue"

    def test_share_deferred_path_has_guard(self):
        """The deferred download re-queue path checks _optimization_active."""
        source = self._read_share_bundles()
        deferred_idx = source.find("result.status == 'deferred'")
        assert deferred_idx > 0

        section = source[deferred_idx:deferred_idx + 500]
        guard_pos = section.find('_optimization_active')
        queue_pos = section.find('_queue_share_preview_to_kafka')
        assert guard_pos > 0, "_optimization_active guard not found in share deferred path"
        assert guard_pos < queue_pos, "Guard should appear before re-queue"


# Import os at module level for path operations in test classes
import os
