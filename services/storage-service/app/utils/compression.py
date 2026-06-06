# services/storage-service/app/utils/compression.py

import zstandard as zstd

from ..config import settings


class ZstdCodec:
    """Unified zstd codec exposing both ``compress`` and ``decompress``.

    The ``zstandard`` library splits these operations across two classes
    (``ZstdCompressor`` / ``ZstdDecompressor``), but call sites throughout this
    codebase reference a single object for both directions — e.g. many use
    ``compressor.decompress(...)`` (read paths: preview, download, sharing,
    zip export, scan, dedup) while others use ``decompressor.decompress(...)``.
    Previously ``compressor`` was a bare ``ZstdCompressor``, so every
    ``compressor.decompress(...)`` raised ``AttributeError`` whenever a stored
    file had actually been zstd-compressed (large text files >1MB; see
    ``routers/upload.py:should_compress``), silently breaking those reads.

    Exposing both methods on one codec object makes every historical call site
    correct. Only whole-frame ``compress(bytes) -> bytes`` and
    ``decompress(bytes) -> bytes`` are used anywhere in the codebase, so this
    facade is fully behavior-preserving (it delegates to the same underlying
    zstandard engines). The bound methods are also safe to hand to the thread
    executors (``run_in_heavy_pool``, decrypt executors).
    """

    def __init__(self, level: int):
        self._compressor = zstd.ZstdCompressor(level=level)
        self._decompressor = zstd.ZstdDecompressor()

    def compress(self, data: bytes) -> bytes:
        return self._compressor.compress(data)

    def decompress(self, data: bytes) -> bytes:
        return self._decompressor.decompress(data)


# Backwards-compatible singletons. Both names point at the same codec so that
# ``compressor.compress``, ``compressor.decompress`` and
# ``decompressor.decompress`` (all of which appear in the codebase) are correct.
_codec = ZstdCodec(level=settings.COMPRESSION_LEVEL)
compressor = _codec
decompressor = _codec
