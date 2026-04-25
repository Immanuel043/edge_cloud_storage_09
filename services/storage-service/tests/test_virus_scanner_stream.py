"""Unit tests for VirusScanner.scan_stream and the shared INSTREAM driver.

We mock asyncio.open_connection so no real ClamAV daemon is required. The
tests exercise:

  * Clean response  -> STATUS_CLEAN, retries circuit recorded as success.
  * Infected verdict (FOUND) parsed from the response, virus_name extracted.
  * Connection refused -> STATUS_BYPASSED with the connect error.
  * Oversize short-circuit: total_size > max_bytes never opens a connection.
  * Wire format: 4-byte big-endian length prefixes, terminating zero frame.

Run with:  python -m pytest services/storage-service/tests/test_virus_scanner_stream.py -v
"""

import asyncio
import os
import struct
import sys
from typing import AsyncIterator
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://x:x@localhost:5432/test")
os.environ.setdefault("SECRET_KEY", "test_secret_key_for_testing_only_32b")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.services.virus_scanner import VirusScanResult, VirusScanner  # noqa: E402


class _FakeWriter:
    """Minimal asyncio.StreamWriter stand-in that records bytes written."""

    def __init__(self) -> None:
        self.buffer = bytearray()
        self.closed = False

    def write(self, data: bytes) -> None:
        self.buffer.extend(data)

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        self.closed = True

    async def wait_closed(self) -> None:
        return None


class _FakeReader:
    def __init__(self, response: bytes) -> None:
        self._response = response

    async def read(self, n: int) -> bytes:
        return self._response


def _patch_open_connection(reader: _FakeReader, writer: _FakeWriter):
    """Returns a patch context that fakes asyncio.open_connection."""
    return patch(
        "app.services.virus_scanner.asyncio.open_connection",
        AsyncMock(return_value=(reader, writer)),
    )


async def _gen(*chunks: bytes) -> AsyncIterator[bytes]:
    for c in chunks:
        yield c


# ---------- _DrainState / wire format ----------

@pytest.mark.asyncio
async def test_scan_stream_writes_correct_wire_format():
    """Each yielded chunk becomes <4-byte len><payload>; stream terminates with len=0."""
    writer = _FakeWriter()
    reader = _FakeReader(b"stream: OK\n")
    scanner = VirusScanner(host="fake", port=3310)

    with _patch_open_connection(reader, writer):
        result = await scanner.scan_stream(
            _gen(b"hello", b"world!"), total_size=11, max_bytes=10**9
        )

    assert result.scan_status == VirusScanResult.STATUS_CLEAN
    # Wire bytes: nINSTREAM\n + len(5) + "hello" + len(6) + "world!" + len(0)
    expected = b"nINSTREAM\n"
    expected += struct.pack("!L", 5) + b"hello"
    expected += struct.pack("!L", 6) + b"world!"
    expected += struct.pack("!L", 0)
    assert bytes(writer.buffer) == expected
    assert writer.closed is True


# ---------- Verdict parsing ----------

@pytest.mark.asyncio
async def test_scan_stream_clean():
    scanner = VirusScanner(host="fake", port=3310)
    with _patch_open_connection(_FakeReader(b"stream: OK\n"), _FakeWriter()):
        result = await scanner.scan_stream(_gen(b"safe"), total_size=4, max_bytes=10**9)
    assert result.scan_status == VirusScanResult.STATUS_CLEAN
    assert result.is_infected is False
    assert result.error is None


@pytest.mark.asyncio
async def test_scan_stream_infected_extracts_virus_name():
    scanner = VirusScanner(host="fake", port=3310)
    response = b"stream: Test.Virus.NotReal FOUND\n"
    with _patch_open_connection(_FakeReader(response), _FakeWriter()):
        result = await scanner.scan_stream(
            _gen(b"payload"), total_size=7, max_bytes=10**9
        )
    assert result.scan_status == VirusScanResult.STATUS_INFECTED
    assert result.is_infected is True
    assert "Test.Virus.NotReal" in (result.virus_name or "")


# ---------- Failure modes ----------

@pytest.mark.asyncio
async def test_scan_stream_connection_refused_is_bypassed():
    scanner = VirusScanner(host="fake", port=3310)
    with patch(
        "app.services.virus_scanner.asyncio.open_connection",
        AsyncMock(side_effect=ConnectionRefusedError("nope")),
    ):
        result = await scanner.scan_stream(
            _gen(b"x"), total_size=1, max_bytes=10**9
        )
    assert result.scan_status == VirusScanResult.STATUS_BYPASSED
    assert result.bypassed is True
    assert "nope" in (result.error or "")


@pytest.mark.asyncio
async def test_scan_stream_oversize_short_circuits_without_connection():
    """Files above max_bytes must not even open a socket."""
    scanner = VirusScanner(host="fake", port=3310)
    open_mock = AsyncMock()
    with patch("app.services.virus_scanner.asyncio.open_connection", open_mock):
        result = await scanner.scan_stream(
            _gen(b"never-sent"),
            total_size=10 * 1024 * 1024,
            max_bytes=1024,
        )
    assert result.scan_status == VirusScanResult.STATUS_BYPASSED
    assert result.error == "file_too_large_for_instream"
    open_mock.assert_not_called()


# ---------- Refactor regression: scan_bytes still works through the shared driver ----------

@pytest.mark.asyncio
async def test_scan_bytes_clean_through_shared_driver():
    """scan_bytes was refactored onto _run_instream — verify it still parses OK."""
    scanner = VirusScanner(host="fake", port=3310)
    with _patch_open_connection(_FakeReader(b"stream: OK\n"), _FakeWriter()):
        result = await scanner.scan_bytes(b"hello world")
    assert result.scan_status == VirusScanResult.STATUS_CLEAN
