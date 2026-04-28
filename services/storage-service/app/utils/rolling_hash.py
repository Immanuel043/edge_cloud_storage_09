"""
ctypes wrapper for the native C rolling hash.

Falls back to ``None`` if the shared library is not available (e.g. local
dev without gcc).  The caller should check ``native_find_chunk_boundaries``
and use the Python fallback when it is ``None``.
"""

import ctypes
import logging
import os
from typing import Callable, List, Optional

logger = logging.getLogger(__name__)

_LIB: Optional[ctypes.CDLL] = None

_SO_PATHS = [
    os.path.join(os.path.dirname(__file__), "_cdc_native.so"),
    os.path.join(os.path.dirname(__file__), "_cdc_native.dylib"),
    os.path.join(os.path.dirname(__file__), "rolling_hash.dylib"),
]

for _path in _SO_PATHS:
    if os.path.isfile(_path):
        try:
            _LIB = ctypes.CDLL(_path)
            _LIB.find_chunk_boundaries_c.argtypes = [
                ctypes.POINTER(ctypes.c_uint8),  # data
                ctypes.c_int64,  # length
                ctypes.POINTER(ctypes.c_int64),  # out_boundaries
                ctypes.c_int64,  # max_boundaries
                ctypes.c_int64,  # min_block_size
                ctypes.c_int64,  # max_block_size
                ctypes.c_int64,  # window_size
                ctypes.c_uint64,  # prime
                ctypes.c_uint64,  # modulus_mask
            ]
            _LIB.find_chunk_boundaries_c.restype = ctypes.c_int64
            logger.info("Loaded native rolling hash from %s", _path)
            break
        except OSError as exc:
            logger.warning("Failed to load %s: %s", _path, exc)
            _LIB = None


def _native_impl(
    data: bytes,
    min_block_size: int,
    max_block_size: int,
    window_size: int,
    prime: int,
    modulus_mask: int,
) -> List[int]:
    """Call the C implementation and return a list of boundary positions."""
    length = len(data)
    max_boundaries = (length // min_block_size) + 2
    OutArray = ctypes.c_int64 * max_boundaries
    out = OutArray()

    buf = (ctypes.c_uint8 * length).from_buffer_copy(data)

    count = _LIB.find_chunk_boundaries_c(
        buf,
        ctypes.c_int64(length),
        out,
        ctypes.c_int64(max_boundaries),
        ctypes.c_int64(min_block_size),
        ctypes.c_int64(max_block_size),
        ctypes.c_int64(window_size),
        ctypes.c_uint64(prime),
        ctypes.c_uint64(modulus_mask),
    )
    return [out[i] for i in range(count)]


native_find_chunk_boundaries: Optional[Callable[..., List[int]]] = (
    _native_impl if _LIB is not None else None
)
