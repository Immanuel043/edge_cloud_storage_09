"""
Python ctypes wrapper for the Rust edge-byte-processor cdylib.

Provides:
  - native_find_chunk_boundaries: FastCDC gear-hash chunking (replaces Rabin)
  - native_batch_sha256: batch SHA-256 hashing (replaces Python hashlib loop)
  - NativeBloomFilter: opaque bloom filter (replaces pybloom_live)

Falls back to None / raises ImportError if the shared library is unavailable,
allowing callers to use Python fallbacks.
"""

import ctypes
import logging
import os
from typing import Callable, List, Optional

logger = logging.getLogger(__name__)

_LIB: Optional[ctypes.CDLL] = None

_SO_NAMES = [
    "libedge_byte_processor.so",
    "libedge_byte_processor.dylib",
]

for _name in _SO_NAMES:
    _path = os.path.join(os.path.dirname(__file__), _name)
    if os.path.isfile(_path):
        try:
            _LIB = ctypes.CDLL(_path)
            logger.info("Loaded Rust byte processor from %s", _path)
            break
        except OSError as exc:
            logger.warning("Failed to load %s: %s", _path, exc)
            _LIB = None

# ---------------------------------------------------------------------------
# CDC
# ---------------------------------------------------------------------------

if _LIB is not None:
    # FastCDC (primary -- gear hash, normalized chunking)
    _LIB.ebp_fastcdc.argtypes = [
        ctypes.POINTER(ctypes.c_uint8),  # data
        ctypes.c_int64,                   # length
        ctypes.POINTER(ctypes.c_int64),   # out_boundaries
        ctypes.c_int64,                   # max_boundaries
        ctypes.c_int64,                   # min_block_size
        ctypes.c_int64,                   # max_block_size
        ctypes.c_int64,                   # avg_block_size
    ]
    _LIB.ebp_fastcdc.restype = ctypes.c_int64

    # Legacy compat wrapper (same signature as old Rabin C extension)
    _LIB.ebp_find_chunk_boundaries.argtypes = [
        ctypes.POINTER(ctypes.c_uint8),  # data
        ctypes.c_int64,                   # length
        ctypes.POINTER(ctypes.c_int64),   # out_boundaries
        ctypes.c_int64,                   # max_boundaries
        ctypes.c_int64,                   # min_block_size
        ctypes.c_int64,                   # max_block_size
        ctypes.c_int64,                   # window_size (ignored)
        ctypes.c_uint64,                  # prime (ignored)
        ctypes.c_uint64,                  # modulus_mask (ignored)
    ]
    _LIB.ebp_find_chunk_boundaries.restype = ctypes.c_int64

    _LIB.ebp_batch_sha256.argtypes = [
        ctypes.POINTER(ctypes.c_uint8),   # data
        ctypes.POINTER(ctypes.c_int64),   # offsets
        ctypes.c_int64,                   # count
        ctypes.POINTER(ctypes.c_uint8),   # out_hashes
    ]
    _LIB.ebp_batch_sha256.restype = ctypes.c_int32

    _LIB.ebp_bloom_create.argtypes = [ctypes.c_uint64, ctypes.c_double]
    _LIB.ebp_bloom_create.restype = ctypes.c_void_p

    _LIB.ebp_bloom_add.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint8), ctypes.c_uint64]
    _LIB.ebp_bloom_add.restype = None

    _LIB.ebp_bloom_check.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint8), ctypes.c_uint64]
    _LIB.ebp_bloom_check.restype = ctypes.c_int32

    _LIB.ebp_bloom_destroy.argtypes = [ctypes.c_void_p]
    _LIB.ebp_bloom_destroy.restype = None


def _cdc_impl(
    data: bytes,
    min_block_size: int,
    max_block_size: int,
    window_size: int = 0,
    prime: int = 0,
    modulus_mask: int = 0,
) -> List[int]:
    """Call the Rust FastCDC implementation.

    The ``window_size``, ``prime``, and ``modulus_mask`` parameters exist for
    backward compatibility with the old Rabin-based callers but are ignored
    internally -- FastCDC uses a gear hash instead.
    """
    length = len(data)
    max_boundaries = (length // min_block_size) + 2
    OutArray = ctypes.c_int64 * max_boundaries
    out = OutArray()

    buf = (ctypes.c_uint8 * length).from_buffer_copy(data)

    avg_block_size = (min_block_size + max_block_size) // 2

    count = _LIB.ebp_fastcdc(
        buf,
        ctypes.c_int64(length),
        out,
        ctypes.c_int64(max_boundaries),
        ctypes.c_int64(min_block_size),
        ctypes.c_int64(max_block_size),
        ctypes.c_int64(avg_block_size),
    )
    return [out[i] for i in range(count)]


def _batch_sha256_impl(data: bytes, boundaries: List[int]) -> List[str]:
    """
    Compute SHA-256 for every chunk in one Rust call.

    ``boundaries`` are the end-offsets returned by CDC
    (e.g. [4194304, 8388608, 10000000]).
    Returns a list of hex-encoded SHA-256 strings.
    """
    count = len(boundaries)
    if count == 0:
        return []

    length = boundaries[-1]
    buf = (ctypes.c_uint8 * length).from_buffer_copy(data[:length])

    OffsetsArray = ctypes.c_int64 * count
    offsets = OffsetsArray(*boundaries)

    HashBuf = ctypes.c_uint8 * (count * 32)
    out_hashes = HashBuf()

    rc = _LIB.ebp_batch_sha256(buf, offsets, ctypes.c_int64(count), out_hashes)
    if rc != 0:
        raise RuntimeError("ebp_batch_sha256 returned error code %d" % rc)

    result = []
    for i in range(count):
        digest_bytes = bytes(out_hashes[i * 32 : (i + 1) * 32])
        result.append(digest_bytes.hex())
    return result


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

native_find_chunk_boundaries: Optional[Callable[..., List[int]]] = (
    _cdc_impl if _LIB is not None else None
)

native_batch_sha256: Optional[Callable[[bytes, List[int]], List[str]]] = (
    _batch_sha256_impl if _LIB is not None else None
)


class NativeBloomFilter:
    """Opaque bloom filter backed by the Rust cdylib."""

    def __init__(self, capacity: int = 1_000_000, error_rate: float = 0.001):
        if _LIB is None:
            raise RuntimeError("Rust byte processor library not loaded")
        self._ptr = _LIB.ebp_bloom_create(
            ctypes.c_uint64(capacity), ctypes.c_double(error_rate)
        )
        if not self._ptr:
            raise RuntimeError("ebp_bloom_create returned NULL")

    def add(self, key: str) -> None:
        key_bytes = key.encode("utf-8") if isinstance(key, str) else key
        buf = (ctypes.c_uint8 * len(key_bytes)).from_buffer_copy(key_bytes)
        _LIB.ebp_bloom_add(self._ptr, buf, ctypes.c_uint64(len(key_bytes)))

    def __contains__(self, key) -> bool:
        key_bytes = key.encode("utf-8") if isinstance(key, str) else key
        buf = (ctypes.c_uint8 * len(key_bytes)).from_buffer_copy(key_bytes)
        return _LIB.ebp_bloom_check(self._ptr, buf, ctypes.c_uint64(len(key_bytes))) != 0

    def close(self) -> None:
        if self._ptr:
            _LIB.ebp_bloom_destroy(self._ptr)
            self._ptr = None

    def __del__(self):
        self.close()
