// Linux-specific memfd implementation
use crate::crypto::key_manager::SecretKey;
use crate::error::SecurityError;
use nix::libc;
use std::os::unix::io::RawFd;
use tracing::{debug, instrument};

/// Read encryption key from memfd file descriptor
///
/// # Security
/// - FD passed via SCM_RIGHTS from FastAPI
/// - Key never touches HTTP layer
/// - FD closed immediately after read
/// - Key zeroized on drop (SecretKey)
///
/// # Arguments
/// * `fd` - File descriptor from SCM_RIGHTS
///
/// # Returns
/// SecretKey with automatic zeroization
#[instrument(skip(fd), fields(fd = fd))]
pub fn read_key_from_memfd(fd: RawFd) -> Result<SecretKey, SecurityError> {
    debug!("Reading key from memfd FD: {}", fd);

    // Read exactly 32 bytes from memfd
    let mut key_bytes = [0u8; 32];

    let bytes_read = unsafe {
        libc::read(
            fd,
            key_bytes.as_mut_ptr() as *mut libc::c_void,
            32,
        )
    };

    if bytes_read < 0 {
        let err = std::io::Error::last_os_error();
        return Err(SecurityError::KeyReadFailed(format!(
            "Failed to read from memfd: {}",
            err
        )));
    }

    if bytes_read != 32 {
        // Zeroize partial read
        key_bytes.iter_mut().for_each(|b| *b = 0);
        return Err(SecurityError::KeyReadFailed(format!(
            "Expected 32 bytes, got {}",
            bytes_read
        )));
    }

    debug!("Successfully read 32-byte key from memfd");

    // Close FD immediately (secure cleanup)
    unsafe {
        libc::close(fd);
    }

    debug!("Closed memfd FD: {}", fd);

    // Create SecretKey (will be zeroized on drop)
    Ok(SecretKey::from_bytes(key_bytes))
}

/// Verify memfd FD is valid before reading
pub fn verify_memfd(fd: RawFd) -> Result<(), SecurityError> {
    if fd < 0 {
        return Err(SecurityError::MissingKeyFd);
    }

    // Check if FD is valid (fcntl will fail if invalid)
    let result = unsafe { libc::fcntl(fd, libc::F_GETFD) };

    if result < 0 {
        return Err(SecurityError::KeyReadFailed(format!(
            "Invalid memfd FD: {}",
            fd
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::io::AsRawFd;

    #[test]
    fn test_verify_memfd_invalid_fd() {
        let result = verify_memfd(-1);
        assert!(result.is_err());
    }

    #[test]
    fn test_read_key_from_memfd_with_pipe() {
        // Create a pipe to simulate memfd
        let mut pipe_fds = [0i32; 2];
        let result = unsafe { libc::pipe(pipe_fds.as_mut_ptr()) };
        assert_eq!(result, 0);

        let (read_fd, write_fd) = (pipe_fds[0], pipe_fds[1]);

        // Write test key to pipe
        let test_key = [0x42u8; 32];
        let bytes_written = unsafe {
            libc::write(
                write_fd,
                test_key.as_ptr() as *const libc::c_void,
                32,
            )
        };
        assert_eq!(bytes_written, 32);

        // Close write end
        unsafe { libc::close(write_fd) };

        // Read key from read end
        let key = read_key_from_memfd(read_fd).unwrap();
        assert_eq!(key.as_bytes()[0], 0x42);

        // Note: read_key_from_memfd closes the FD
    }

    #[test]
    fn test_read_key_invalid_size() {
        // Create a pipe
        let mut pipe_fds = [0i32; 2];
        unsafe { libc::pipe(pipe_fds.as_mut_ptr()) };

        let (read_fd, write_fd) = (pipe_fds[0], pipe_fds[1]);

        // Write only 16 bytes (wrong size)
        let test_key = [0x42u8; 16];
        unsafe {
            libc::write(
                write_fd,
                test_key.as_ptr() as *const libc::c_void,
                16,
            )
        };

        unsafe { libc::close(write_fd) };

        // Should fail with wrong size
        let result = read_key_from_memfd(read_fd);
        assert!(result.is_err());
    }
}
