"""
ClamAV Virus Scanning Service

Integrates with ClamAV daemon for real-time virus scanning of uploaded files.
Features: batched streaming, retry with backoff, circuit breaker for scale.
"""

import asyncio
import socket
import struct
import os
from typing import Dict, Optional, Tuple
from datetime import datetime
import logging

logger = logging.getLogger(__name__)


class VirusScanResult:
    """Result of a virus scan"""
    def __init__(self, is_infected: bool, virus_name: Optional[str] = None,
                 scan_time: float = 0.0, error: Optional[str] = None):
        self.is_infected = is_infected
        self.virus_name = virus_name
        self.scan_time = scan_time
        self.error = error
        self.scanned_at = datetime.utcnow()

    def to_dict(self) -> Dict:
        return {
            'is_infected': self.is_infected,
            'virus_name': self.virus_name,
            'scan_time': self.scan_time,
            'scanned_at': self.scanned_at.isoformat(),
            'error': self.error
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

    async def _scan_bytes_once(self, data: bytes) -> VirusScanResult:
        """Single attempt to scan byte data via ClamAV INSTREAM protocol"""
        start_time = asyncio.get_event_loop().time()

        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(self.host, self.port),
                timeout=10
            )

            # Use INSTREAM command to send data directly
            writer.write(b'INSTREAM\n')
            await writer.drain()

            # Send data in chunks with batched draining
            data_size = len(data)
            offset = 0
            bytes_since_drain = 0

            while offset < data_size:
                chunk = data[offset:offset + self.chunk_size]
                chunk_len = len(chunk)

                writer.write(struct.pack('!L', chunk_len))
                writer.write(chunk)
                bytes_since_drain += chunk_len + 4
                offset += chunk_len

                if bytes_since_drain >= self.drain_threshold:
                    await writer.drain()
                    bytes_since_drain = 0

            # Final drain for remaining buffered data
            if bytes_since_drain > 0:
                await writer.drain()

            # Send zero-length chunk to indicate end of data
            writer.write(struct.pack('!L', 0))
            await writer.drain()

            # Read response
            response = await asyncio.wait_for(reader.read(4096), timeout=self.timeout)
            writer.close()
            await writer.wait_closed()

            scan_time = asyncio.get_event_loop().time() - start_time
            response_str = response.decode('utf-8').strip()
            return self._parse_response(response_str, scan_time)

        except asyncio.TimeoutError:
            scan_time = asyncio.get_event_loop().time() - start_time
            logger.error(f"ClamAV scan timeout after {scan_time:.2f}s")
            return VirusScanResult(
                is_infected=False,
                error="Scan timeout",
                scan_time=scan_time
            )
        except Exception as e:
            scan_time = asyncio.get_event_loop().time() - start_time
            logger.error(f"ClamAV scan failed: {e}")
            return VirusScanResult(
                is_infected=False,
                error=str(e),
                scan_time=scan_time
            )

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
        start_time = asyncio.get_event_loop().time()

        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(self.host, self.port),
                timeout=10
            )

            writer.write(b'INSTREAM\n')
            await writer.drain()

            # Stream file in chunks with batched draining
            bytes_since_drain = 0
            with open(file_path, 'rb') as f:
                while True:
                    chunk = f.read(self.chunk_size)
                    if not chunk:
                        break

                    writer.write(struct.pack('!L', len(chunk)))
                    writer.write(chunk)
                    bytes_since_drain += len(chunk) + 4

                    if bytes_since_drain >= self.drain_threshold:
                        await writer.drain()
                        bytes_since_drain = 0

            # Final drain for remaining buffered data
            if bytes_since_drain > 0:
                await writer.drain()

            # Send zero-length chunk to indicate end
            writer.write(struct.pack('!L', 0))
            await writer.drain()

            # Read response
            response = await asyncio.wait_for(reader.read(4096), timeout=self.timeout)
            writer.close()
            await writer.wait_closed()

            scan_time = asyncio.get_event_loop().time() - start_time
            response_str = response.decode('utf-8').strip()
            return self._parse_response(response_str, scan_time)

        except Exception as e:
            scan_time = asyncio.get_event_loop().time() - start_time
            logger.error(f"Failed to scan large file: {e}")
            return VirusScanResult(
                is_infected=False,
                error=str(e),
                scan_time=scan_time
            )

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
