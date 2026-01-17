"""
memfd Helper - Cross-platform memfd creation and SCM_RIGHTS key passing

Provides secure file descriptor passing for encryption keys over Unix sockets.
Supports both Linux (memfd_create) and macOS (shm_open).
"""

import os
import sys
import ctypes
import socket
import struct
import logging
from typing import Optional

logger = logging.getLogger(__name__)


class MemfdHelper:
    """Cross-platform memfd creation and SCM_RIGHTS passing for secure key transfer"""

    # Platform detection
    IS_LINUX = sys.platform.startswith('linux')
    IS_MACOS = sys.platform == 'darwin'

    # Constants for memfd_create (Linux)
    MFD_CLOEXEC = 0x0001
    MFD_ALLOW_SEALING = 0x0002

    @classmethod
    def create_memfd_with_key(cls, key: bytes, name: str = "file_key") -> int:
        """
        Create a memory file descriptor and write encryption key.

        Args:
            key: Encryption key bytes (typically 32 bytes for AES-256)
            name: Name for the memfd (Linux) or shm object (macOS)

        Returns:
            File descriptor number

        Raises:
            OSError: If memfd creation or write fails
            ValueError: If key is invalid
        """
        if not isinstance(key, bytes):
            raise ValueError("Key must be bytes")

        if len(key) == 0:
            raise ValueError("Key cannot be empty")

        if cls.IS_LINUX:
            return cls._create_memfd_linux(key, name)
        elif cls.IS_MACOS:
            return cls._create_memfd_macos(key, name)
        else:
            raise OSError(f"Unsupported platform: {sys.platform}")

    @classmethod
    def _create_memfd_linux(cls, key: bytes, name: str) -> int:
        """Create memfd on Linux using memfd_create syscall, fallback to shm_open"""
        try:
            # Load libc
            libc = ctypes.CDLL("libc.so.6", use_errno=True)

            # memfd_create syscall number (319 on x86_64)
            SYS_memfd_create = 319

            # Call memfd_create via syscall
            name_bytes = name.encode('utf-8')
            fd = libc.syscall(
                SYS_memfd_create,
                name_bytes,
                cls.MFD_CLOEXEC | cls.MFD_ALLOW_SEALING
            )

            if fd < 0:
                errno = ctypes.get_errno()
                raise OSError(errno, f"memfd_create failed: {os.strerror(errno)}")

            # Write key to memfd
            written = os.write(fd, key)
            if written != len(key):
                os.close(fd)
                raise OSError(f"Failed to write full key: wrote {written}/{len(key)} bytes")

            # Seek back to beginning for reading
            os.lseek(fd, 0, os.SEEK_SET)

            logger.debug(f"Created Linux memfd: fd={fd}, key_size={len(key)}")
            return fd

        except OSError as e:
            # Fallback to shm_open if memfd_create is not supported (e.g., old Docker kernels)
            if e.errno in (38, 1):  # ENOSYS (not implemented) or EPERM
                logger.warning(f"memfd_create not supported (errno {e.errno}), falling back to shm_open")
                return cls._create_shm_linux(key, name)
            logger.error(f"Failed to create Linux memfd: {e}")
            raise
        except Exception as e:
            logger.error(f"Failed to create Linux memfd: {e}")
            raise

    @classmethod
    def _create_shm_linux(cls, key: bytes, name: str) -> int:
        """Fallback: Create shared memory on Linux using shm_open (POSIX)"""
        try:
            # Load libc
            libc = ctypes.CDLL("libc.so.6", use_errno=True)

            # shm_open flags
            O_RDWR = 0x0002
            O_CREAT = 0x0040
            O_EXCL = 0x0080
            O_CLOEXEC = 0o2000000  # Linux specific

            # Generate unique name
            import uuid
            shm_name = f"/{name}_{uuid.uuid4().hex}"

            # Call shm_open
            fd = libc.shm_open(
                shm_name.encode('utf-8'),
                O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC,
                0o600  # Owner read/write only
            )

            if fd < 0:
                errno = ctypes.get_errno()
                raise OSError(errno, f"shm_open failed: {os.strerror(errno)}")

            # Immediately unlink so it's cleaned up when closed
            libc.shm_unlink(shm_name.encode('utf-8'))

            # Set size (ftruncate returns None on success in Python)
            try:
                os.ftruncate(fd, len(key))
            except OSError as e:
                os.close(fd)
                raise OSError(f"Failed to set shm size: {e}")

            # Write key
            written = os.write(fd, key)
            if written != len(key):
                os.close(fd)
                raise OSError(f"Failed to write full key: wrote {written}/{len(key)} bytes")

            # Seek back to beginning
            os.lseek(fd, 0, os.SEEK_SET)

            logger.debug(f"Created Linux shm: fd={fd}, key_size={len(key)}")
            return fd

        except Exception as e:
            logger.error(f"Failed to create Linux shm: {e}")
            raise

    @classmethod
    def _create_memfd_macos(cls, key: bytes, name: str) -> int:
        """Create memfd on macOS using shm_open"""
        try:
            # Load libc
            libc = ctypes.CDLL("/usr/lib/libSystem.dylib", use_errno=True)

            # shm_open flags
            O_RDWR = 0x0002
            O_CREAT = 0x0200
            O_EXCL = 0x0800
            O_CLOEXEC = 0x1000000  # macOS specific

            # Generate unique name
            import uuid
            shm_name = f"/{name}_{uuid.uuid4().hex}"

            # Call shm_open
            fd = libc.shm_open(
                shm_name.encode('utf-8'),
                O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC,
                0o600  # Owner read/write only
            )

            if fd < 0:
                errno = ctypes.get_errno()
                raise OSError(errno, f"shm_open failed: {os.strerror(errno)}")

            try:
                # Unlink immediately (file descriptor keeps it alive)
                libc.shm_unlink(shm_name.encode('utf-8'))

                # Set size
                if libc.ftruncate(fd, len(key)) != 0:
                    raise OSError("ftruncate failed")

                # Write key
                written = os.write(fd, key)
                if written != len(key):
                    raise OSError(f"Failed to write full key: wrote {written}/{len(key)} bytes")

                # Seek back to beginning
                os.lseek(fd, 0, os.SEEK_SET)

                logger.debug(f"Created macOS shm: fd={fd}, key_size={len(key)}")
                return fd

            except Exception:
                os.close(fd)
                raise

        except Exception as e:
            logger.error(f"Failed to create macOS shm: {e}")
            raise

    @staticmethod
    def send_fd_over_socket(sock: socket.socket, fd: int, data: bytes):
        """
        Send file descriptor via SCM_RIGHTS ancillary data along with regular data.

        Args:
            sock: Connected Unix domain socket
            fd: File descriptor to send
            data: Regular data to send (e.g., HTTP request headers)

        Raises:
            OSError: If sendmsg fails
        """
        try:
            # Build ancillary data with SCM_RIGHTS control message
            # Format: (level, type, data)
            # level = SOL_SOCKET, type = SCM_RIGHTS, data = array of FDs
            ancillary = [(
                socket.SOL_SOCKET,
                socket.SCM_RIGHTS,
                struct.pack("i", fd)  # Pack FD as int
            )]

            # Send data + FD via sendmsg
            sent = sock.sendmsg([data], ancillary)

            if sent < len(data):
                raise OSError(f"Incomplete send: {sent}/{len(data)} bytes")

            logger.debug(f"Sent FD {fd} via SCM_RIGHTS along with {sent} bytes")

        except Exception as e:
            logger.error(f"Failed to send FD via SCM_RIGHTS: {e}")
            raise

    @staticmethod
    def recv_fd_from_socket(sock: socket.socket, max_data_size: int = 4096) -> tuple[bytes, Optional[int]]:
        """
        Receive file descriptor via SCM_RIGHTS ancillary data.

        Args:
            sock: Connected Unix domain socket
            max_data_size: Maximum regular data to receive

        Returns:
            Tuple of (data, fd) where fd may be None if no FD received

        Raises:
            OSError: If recvmsg fails
        """
        try:
            # Receive data + ancillary data
            data, ancdata, flags, addr = sock.recvmsg(
                max_data_size,
                socket.CMSG_SPACE(struct.calcsize("i"))  # Space for one FD
            )

            # Extract FD from ancillary data
            fd = None
            for cmsg_level, cmsg_type, cmsg_data in ancdata:
                if cmsg_level == socket.SOL_SOCKET and cmsg_type == socket.SCM_RIGHTS:
                    # Unpack FD from control message
                    fds = struct.unpack("i", cmsg_data[:struct.calcsize("i")])
                    fd = fds[0]
                    logger.debug(f"Received FD {fd} via SCM_RIGHTS")
                    break

            return data, fd

        except Exception as e:
            logger.error(f"Failed to receive FD via SCM_RIGHTS: {e}")
            raise

    @staticmethod
    def close_memfd(fd: int):
        """
        Close file descriptor.

        Args:
            fd: File descriptor to close

        Note: Key data in memfd is automatically cleaned up by kernel on close.
        """
        try:
            os.close(fd)
            logger.debug(f"Closed FD {fd}")
        except OSError as e:
            logger.warning(f"Failed to close FD {fd}: {e}")

    @staticmethod
    def verify_memfd(fd: int) -> bool:
        """
        Verify that a file descriptor is valid and readable.

        Args:
            fd: File descriptor to verify

        Returns:
            True if FD is valid and readable
        """
        try:
            # Try to fstat the FD
            os.fstat(fd)
            # Try to seek (will fail if FD is invalid)
            os.lseek(fd, 0, os.SEEK_CUR)
            return True
        except OSError:
            return False


# Module-level convenience functions

def create_key_fd(key: bytes) -> int:
    """
    Convenience function to create memfd with encryption key.

    Args:
        key: Encryption key bytes

    Returns:
        File descriptor

    Example:
        >>> key = b"0" * 32
        >>> fd = create_key_fd(key)
        >>> # ... use fd ...
        >>> os.close(fd)
    """
    return MemfdHelper.create_memfd_with_key(key)


def send_with_fd(sock: socket.socket, data: bytes, fd: int):
    """
    Convenience function to send data with file descriptor.

    Args:
        sock: Unix socket
        data: Data to send
        fd: File descriptor to send via SCM_RIGHTS

    Example:
        >>> sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        >>> sock.connect("/tmp/server.sock")
        >>> fd = create_key_fd(key)
        >>> send_with_fd(sock, b"HTTP request", fd)
    """
    MemfdHelper.send_fd_over_socket(sock, fd, data)


def recv_with_fd(sock: socket.socket, max_size: int = 4096) -> tuple[bytes, Optional[int]]:
    """
    Convenience function to receive data with file descriptor.

    Args:
        sock: Unix socket
        max_size: Maximum data to receive

    Returns:
        Tuple of (data, fd)

    Example:
        >>> sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        >>> sock.bind("/tmp/server.sock")
        >>> sock.listen()
        >>> conn, _ = sock.accept()
        >>> data, fd = recv_with_fd(conn)
    """
    return MemfdHelper.recv_fd_from_socket(sock, max_size)
