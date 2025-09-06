# services/storage-service/app/utils/compression.py

import zstandard as zstd
from ..config import settings

# Initialize compression/decompression objects
compressor = zstd.ZstdCompressor(level=settings.COMPRESSION_LEVEL)
decompressor = zstd.ZstdDecompressor()