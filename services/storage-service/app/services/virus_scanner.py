"""
ClamAV Virus Scanning Service

Integrates with ClamAV daemon for real-time virus scanning of uploaded files.
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


class VirusScanner:
    """ClamAV virus scanner integration"""

    def __init__(self, host: str = 'clamav', port: int = 3310):
        self.host = host
        self.port = port
        self.chunk_size = 2048
        self.timeout = 120  # 2 minutes for large files

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

    async def scan_bytes(self, data: bytes) -> VirusScanResult:
        """
        Scan byte data for viruses

        Args:
            data: File data to scan

        Returns:
            VirusScanResult with scan outcome
        """
        start_time = asyncio.get_event_loop().time()

        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(self.host, self.port),
                timeout=10
            )

            # Use INSTREAM command to send data directly
            writer.write(b'INSTREAM\n')
            await writer.drain()

            # Send data in chunks with size prefix
            data_size = len(data)
            offset = 0

            while offset < data_size:
                chunk = data[offset:offset + self.chunk_size]
                chunk_size = len(chunk)

                # Send chunk size (4 bytes, network byte order)
                writer.write(struct.pack('!L', chunk_size))
                # Send chunk data
                writer.write(chunk)
                await writer.drain()

                offset += chunk_size

            # Send zero-length chunk to indicate end of data
            writer.write(struct.pack('!L', 0))
            await writer.drain()

            # Read response
            response = await asyncio.wait_for(reader.read(4096), timeout=self.timeout)
            writer.close()
            await writer.wait_closed()

            scan_time = asyncio.get_event_loop().time() - start_time

            # Parse response
            response_str = response.decode('utf-8').strip()

            if 'FOUND' in response_str:
                # Format: "stream: Eicar-Test-Signature FOUND"
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

    async def scan_file(self, file_path: str) -> VirusScanResult:
        """
        Scan a file for viruses

        Args:
            file_path: Path to file to scan

        Returns:
            VirusScanResult with scan outcome
        """
        try:
            # Read file in chunks to avoid memory issues with large files
            file_size = os.path.getsize(file_path)

            # For files larger than 100MB, read and scan in chunks
            if file_size > 100 * 1024 * 1024:
                logger.info(f"Large file ({file_size} bytes), scanning in chunks")
                return await self._scan_large_file(file_path)
            else:
                # For smaller files, read all at once
                with open(file_path, 'rb') as f:
                    data = f.read()
                return await self.scan_bytes(data)
        except Exception as e:
            logger.error(f"Failed to scan file {file_path}: {e}")
            return VirusScanResult(
                is_infected=False,
                error=f"Failed to read file: {e}"
            )

    async def _scan_large_file(self, file_path: str) -> VirusScanResult:
        """Scan large file by streaming chunks"""
        start_time = asyncio.get_event_loop().time()

        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(self.host, self.port),
                timeout=10
            )

            writer.write(b'INSTREAM\n')
            await writer.drain()

            # Stream file in chunks
            with open(file_path, 'rb') as f:
                while True:
                    chunk = f.read(self.chunk_size)
                    if not chunk:
                        break

                    # Send chunk size and data
                    writer.write(struct.pack('!L', len(chunk)))
                    writer.write(chunk)
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

            if 'FOUND' in response_str:
                virus_name = response_str.split(':')[1].replace('FOUND', '').strip()
                return VirusScanResult(
                    is_infected=True,
                    virus_name=virus_name,
                    scan_time=scan_time
                )
            elif 'OK' in response_str:
                return VirusScanResult(
                    is_infected=False,
                    scan_time=scan_time
                )
            else:
                error_msg = response_str if 'ERROR' in response_str else f"Unknown response: {response_str}"
                return VirusScanResult(
                    is_infected=False,
                    error=error_msg,
                    scan_time=scan_time
                )

        except Exception as e:
            scan_time = asyncio.get_event_loop().time() - start_time
            logger.error(f"Failed to scan large file: {e}")
            return VirusScanResult(
                is_infected=False,
                error=str(e),
                scan_time=scan_time
            )


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
