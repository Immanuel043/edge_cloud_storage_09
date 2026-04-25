"""
ClamAV Virus Scanning Service

Integrates with ClamAV daemon for real-time virus scanning of uploaded files.
Features: batched streaming, retry with backoff, circuit breaker for scale.
"""

import asyncio
import socket
import struct
import os
from typing import AsyncIterator, Awaitable, Callable, Dict, Optional, Tuple
from datetime import datetime
import logging

logger = logging.getLogger(__name__)


class _DrainState:
    """Mutable counter passed to producers so _write_frame can drain on a boundary."""

    __slots__ = ("bytes_since_drain",)

    def __init__(self) -> None:
        self.bytes_since_drain = 0


class VirusScanResult:
    """Result of a virus scan.

    scan_status distinguishes three outcomes that callers need to treat
    differently:
      - "clean":    scanner ran to completion and returned OK.
      - "infected": scanner ran to completion and returned FOUND.
      - "bypassed": scanner never produced a definitive answer (circuit
                    breaker open, network error, timeout, daemon error).
                    The file has NOT been inspected. Callers must decide
                    whether to fail-open (free tier) or fail-closed
                    (paid tier → quarantine until rescanned).

    Backwards compat: is_infected remains a simple boolean and is always
    False for bypassed scans. Code that only checks is_infected still
    compiles, but such code is now buggy — check scan_status.
    """

    STATUS_CLEAN = "clean"
    STATUS_INFECTED = "infected"
    STATUS_BYPASSED = "bypassed"

    def __init__(
        self,
        is_infected: bool,
        virus_name: Optional[str] = None,
        scan_time: float = 0.0,
        error: Optional[str] = None,
        scan_status: Optional[str] = None,
    ):
        self.is_infected = is_infected
        self.virus_name = virus_name
        self.scan_time = scan_time
        self.error = error
        self.scanned_at = datetime.utcnow()
        # Derive scan_status from legacy args if the caller didn't supply one.
        if scan_status is not None:
            self.scan_status = scan_status
        elif is_infected:
            self.scan_status = self.STATUS_INFECTED
        elif error is not None:
            self.scan_status = self.STATUS_BYPASSED
        else:
            self.scan_status = self.STATUS_CLEAN

    @property
    def bypassed(self) -> bool:
        """True when the scanner did not produce a definitive verdict."""
        return self.scan_status == self.STATUS_BYPASSED

    def to_dict(self) -> Dict:
        return {
            'is_infected': self.is_infected,
            'scan_status': self.scan_status,
            'virus_name': self.virus_name,
            'scan_time': self.scan_time,
            'scanned_at': self.scanned_at.isoformat(),
            'error': self.error,
        }


class ScannerCircuitBreaker:
    """Failure-count circuit breaker for ClamAV connectivity"""

    def __init__(self, failure_threshold: int = 5, recovery_timeout: float = 60.0):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.failure_count = 0
        self.state = "CLOSED"
        self.last_failure_time: Optional[float] = None

    def record_success(self):
        self.failure_count = 0
        if self.state != "CLOSED":
            logger.info("ClamAV circuit breaker recovered -> CLOSED")
        self.state = "CLOSED"

    def record_failure(self):
        self.failure_count += 1
        if self.failure_count >= self.failure_threshold:
            self.state = "OPEN"
            self.last_failure_time = asyncio.get_event_loop().time()
            logger.warning(
                f"ClamAV circuit breaker OPEN after {self.failure_count} consecutive failures. "
                f"Skipping scans for {self.recovery_timeout}s"
            )

    def can_attempt(self) -> bool:
        if self.state == "CLOSED":
            return True
        if self.state == "OPEN":
            elapsed = asyncio.get_event_loop().time() - self.last_failure_time
            if elapsed >= self.recovery_timeout:
                self.state = "HALF_OPEN"
                logger.info("ClamAV circuit breaker HALF_OPEN, allowing test request")
                return True
            return False
        # HALF_OPEN: allow one attempt
        return True


class VirusScanner:
    """ClamAV virus scanner integration with retry and circuit breaker"""

    def __init__(self, host: str = 'clamav', port: int = 3310):
        self.host = host
        self.port = port
        self.chunk_size = 65536  # 64KB chunks for efficient streaming
        self.drain_threshold = 524288  # Drain every 512KB
        self.timeout = 300  # 5 minutes for large files
        self.max_retries = 3
        self.circuit_breaker = ScannerCircuitBreaker(failure_threshold=5, recovery_timeout=60.0)

    async def ping(self) -> bool:
        """Check if ClamAV daemon is available"""
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(self.host, self.port),
                timeout=5
            )

            writer.write(b'PING\n')
            await writer.drain()

            response = await asyncio.wait_for(reader.read(100), timeout=5)
            writer.close()
            await writer.wait_closed()

            return response.strip() == b'PONG'
        except Exception as e:
            logger.warning(f"ClamAV ping failed: {e}")
            return False

    async def get_version(self) -> Optional[str]:
        """Get ClamAV version"""
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(self.host, self.port),
                timeout=5
            )

            writer.write(b'VERSION\n')
            await writer.drain()

            response = await asyncio.wait_for(reader.read(200), timeout=5)
            writer.close()
            await writer.wait_closed()

            return response.decode('utf-8').strip()
        except Exception as e:
            logger.error(f"Failed to get ClamAV version: {e}")
            return None

    def _parse_response(self, response_str: str, scan_time: float) -> VirusScanResult:
        """Parse ClamAV response into a VirusScanResult"""
        if 'FOUND' in response_str:
            virus_name = response_str.split(':')[1].replace('FOUND', '').strip()
            logger.warning(f"Virus detected: {virus_name}")
            return VirusScanResult(
                is_infected=True,
                virus_name=virus_name,
                scan_time=scan_time
            )
        elif 'OK' in response_str:
            logger.info(f"File clean (scanned in {scan_time:.2f}s)")
            return VirusScanResult(
                is_infected=False,
                scan_time=scan_time
            )
        elif 'ERROR' in response_str:
            error_msg = response_str.split(':')[1].strip() if ':' in response_str else response_str
            logger.error(f"ClamAV scan error: {error_msg}")
            return VirusScanResult(
                is_infected=False,
                error=error_msg,
                scan_time=scan_time
            )
        else:
            logger.error(f"Unknown ClamAV response: {response_str}")
            return VirusScanResult(
                is_infected=False,
                error=f"Unknown response: {response_str}",
                scan_time=scan_time
            )

    async def _run_instream(
        self,
        produce_chunks: Callable[[asyncio.StreamWriter, "_DrainState"], Awaitable[None]],
    ) -> VirusScanResult:
        """Shared INSTREAM driver for all scan_* paths.

        Opens one connection, sends `nINSTREAM\\n`, lets the producer write
        chunk frames (4-byte big-endian length + payload), then writes the
        zero-length terminator and reads the verdict. The producer owns
        chunk sourcing (memory bytes / file reads / async generator); this
        method owns the wire format and timing.
        """
        start_time = asyncio.get_event_loop().time()

        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(self.host, self.port),
                timeout=10,
            )

            # nCMD prefix: tells ClamAV to use newline-terminated command mode.
            # Plain "INSTREAM\n" returns "UNKNOWN COMMAND" on modern clamd builds.
            writer.write(b'nINSTREAM\n')
            await writer.drain()

            drain_state = _DrainState()
            await produce_chunks(writer, drain_state)

            if drain_state.bytes_since_drain > 0:
                await writer.drain()

            # Zero-length chunk terminates the stream.
            writer.write(struct.pack('!L', 0))
            await writer.drain()

            response = await asyncio.wait_for(reader.read(4096), timeout=self.timeout)
            writer.close()
            await writer.wait_closed()

            scan_time = asyncio.get_event_loop().time() - start_time
            return self._parse_response(response.decode('utf-8').strip(), scan_time)

        except asyncio.TimeoutError:
            scan_time = asyncio.get_event_loop().time() - start_time
            logger.error(f"ClamAV scan timeout after {scan_time:.2f}s")
            return VirusScanResult(
                is_infected=False,
                error="Scan timeout",
                scan_time=scan_time,
            )
        except Exception as e:
            scan_time = asyncio.get_event_loop().time() - start_time
            logger.error(f"ClamAV scan failed: {e}")
            return VirusScanResult(
                is_infected=False,
                error=str(e),
                scan_time=scan_time,
            )

    async def _write_frame(
        self,
        writer: asyncio.StreamWriter,
        drain_state: "_DrainState",
        payload: bytes,
    ) -> None:
        """Write one INSTREAM frame and drain on the configured boundary."""
        writer.write(struct.pack('!L', len(payload)))
        writer.write(payload)
        drain_state.bytes_since_drain += len(payload) + 4
        if drain_state.bytes_since_drain >= self.drain_threshold:
            await writer.drain()
            drain_state.bytes_since_drain = 0

    async def _scan_bytes_once(self, data: bytes) -> VirusScanResult:
        """Single attempt to scan byte data via ClamAV INSTREAM protocol"""

        async def produce(writer: asyncio.StreamWriter, drain_state: "_DrainState") -> None:
            offset = 0
            data_size = len(data)
            while offset < data_size:
                chunk = data[offset:offset + self.chunk_size]
                await self._write_frame(writer, drain_state, chunk)
                offset += len(chunk)

        return await self._run_instream(produce)

    async def scan_bytes(self, data: bytes) -> VirusScanResult:
        """
        Scan byte data for viruses with retry and circuit breaker.

        Args:
            data: File data to scan

        Returns:
            VirusScanResult with scan outcome
        """
        # Circuit breaker check
        if not self.circuit_breaker.can_attempt():
            logger.warning("ClamAV circuit breaker OPEN, skipping scan")
            return VirusScanResult(
                is_infected=False,
                error="Circuit breaker open: ClamAV temporarily unavailable"
            )

        last_result = None
        for attempt in range(self.max_retries):
            result = await self._scan_bytes_once(data)

            # Definitive result (clean or infected) — no retry needed
            if result.error is None:
                self.circuit_breaker.record_success()
                return result

            last_result = result

            # Retry on transient errors
            if attempt < self.max_retries - 1:
                wait = 2 ** attempt  # 1s, 2s, 4s
                logger.warning(
                    f"ClamAV scan attempt {attempt + 1}/{self.max_retries} failed: {result.error}, "
                    f"retrying in {wait}s"
                )
                await asyncio.sleep(wait)

        # All retries exhausted
        self.circuit_breaker.record_failure()
        logger.error(f"ClamAV scan failed after {self.max_retries} attempts: {last_result.error}")
        return last_result

    async def scan_file(self, file_path: str) -> VirusScanResult:
        """
        Scan a file for viruses

        Args:
            file_path: Path to file to scan

        Returns:
            VirusScanResult with scan outcome
        """
        try:
            file_size = os.path.getsize(file_path)

            # For files larger than 100MB, stream directly from disk
            if file_size > 100 * 1024 * 1024:
                logger.info(f"Large file ({file_size} bytes), scanning in chunks")
                return await self._scan_large_file(file_path)
            else:
                with open(file_path, 'rb') as f:
                    data = f.read()
                return await self.scan_bytes(data)
        except Exception as e:
            logger.error(f"Failed to scan file {file_path}: {e}")
            return VirusScanResult(
                is_infected=False,
                error=f"Failed to read file: {e}"
            )

    async def _scan_large_file_once(self, file_path: str) -> VirusScanResult:
        """Single attempt to scan a large file by streaming chunks"""

        async def produce(writer: asyncio.StreamWriter, drain_state: "_DrainState") -> None:
            with open(file_path, 'rb') as f:
                while True:
                    chunk = f.read(self.chunk_size)
                    if not chunk:
                        break
                    await self._write_frame(writer, drain_state, chunk)

        return await self._run_instream(produce)

    async def _scan_stream_once(
        self, chunks: AsyncIterator[bytes]
    ) -> VirusScanResult:
        """Single attempt to scan an async iterator of plaintext chunks.

        Each yielded chunk is sent as one INSTREAM frame as-is — clamd accepts
        variable frame sizes within StreamMaxLength. Caller is responsible for
        ensuring the iterator yields finite total bytes <= MAX_INSTREAM_BYTES;
        scan_stream() short-circuits before reaching this method when oversize.
        """

        async def produce(writer: asyncio.StreamWriter, drain_state: "_DrainState") -> None:
            async for chunk in chunks:
                if not chunk:
                    continue
                await self._write_frame(writer, drain_state, chunk)

        return await self._run_instream(produce)

    async def scan_stream(
        self,
        chunks: AsyncIterator[bytes],
        total_size: int,
        max_bytes: Optional[int] = None,
    ) -> VirusScanResult:
        """Scan an async iterator of plaintext chunks via INSTREAM.

        Use for chunked uploads: stream decrypted chunks straight into clamd
        without writing a plaintext temp file. Honors retry + circuit breaker
        identically to scan_bytes / scan_file.

        If total_size > max_bytes (defaults to settings.MAX_INSTREAM_BYTES),
        short-circuits to STATUS_BYPASSED with error="file_too_large_for_instream"
        WITHOUT opening a connection. The caller (paid tier) will fail-closed
        and quarantine with a size-specific reason.

        The iterator is consumed once. If retries are needed, they re-attempt
        the connection layer only — chunk replay is the caller's problem (and
        is not currently needed since the failure modes that retry are network
        errors before any frames are sent).
        """
        # Lazy import: avoid pulling settings into module import time so unit
        # tests that construct VirusScanner directly don't need the env loaded.
        if max_bytes is None:
            from ..config import settings
            max_bytes = settings.MAX_INSTREAM_BYTES

        if total_size > max_bytes:
            logger.info(
                f"scan_stream: file_size={total_size} exceeds max_bytes={max_bytes}; "
                f"emitting STATUS_BYPASSED (file_too_large_for_instream) without opening a connection"
            )
            return VirusScanResult(
                is_infected=False,
                error="file_too_large_for_instream",
                scan_status=VirusScanResult.STATUS_BYPASSED,
            )

        if not self.circuit_breaker.can_attempt():
            logger.warning("ClamAV circuit breaker OPEN, skipping stream scan")
            return VirusScanResult(
                is_infected=False,
                error="Circuit breaker open: ClamAV temporarily unavailable",
            )

        # Stream scans cannot retry mid-iteration: an async generator over
        # disk chunks can be re-created by the caller, but we only see one
        # iterator. Single attempt, then surface the result.
        result = await self._scan_stream_once(chunks)
        if result.error is None:
            self.circuit_breaker.record_success()
        else:
            self.circuit_breaker.record_failure()
            logger.error(f"ClamAV stream scan failed: {result.error}")
        return result

    async def _scan_large_file(self, file_path: str) -> VirusScanResult:
        """Scan large file with retry and circuit breaker"""
        if not self.circuit_breaker.can_attempt():
            logger.warning("ClamAV circuit breaker OPEN, skipping large file scan")
            return VirusScanResult(
                is_infected=False,
                error="Circuit breaker open: ClamAV temporarily unavailable"
            )

        last_result = None
        for attempt in range(self.max_retries):
            result = await self._scan_large_file_once(file_path)

            if result.error is None:
                self.circuit_breaker.record_success()
                return result

            last_result = result

            if attempt < self.max_retries - 1:
                wait = 2 ** attempt
                logger.warning(
                    f"ClamAV large file scan attempt {attempt + 1}/{self.max_retries} failed: {result.error}, "
                    f"retrying in {wait}s"
                )
                await asyncio.sleep(wait)

        self.circuit_breaker.record_failure()
        logger.error(f"ClamAV large file scan failed after {self.max_retries} attempts: {last_result.error}")
        return last_result


# Singleton instance
_scanner = None

def get_virus_scanner() -> VirusScanner:
    """Get or create virus scanner singleton"""
    global _scanner
    if _scanner is None:
        host = os.getenv('CLAMAV_HOST', 'clamav')
        port = int(os.getenv('CLAMAV_PORT', '3310'))
        _scanner = VirusScanner(host=host, port=port)
    return _scanner
