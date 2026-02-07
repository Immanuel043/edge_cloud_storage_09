//! FD lifecycle helpers - ensures FDs are closed on error paths to prevent leaks.

use nix::libc;
use std::os::unix::io::RawFd;

/// Close a key FD that was received but will not be passed to read_key_from_memfd.
/// Call this before returning errors when the FD would otherwise leak.
pub fn close_key_fd(fd: RawFd) {
    if fd >= 0 {
        unsafe {
            let _ = libc::close(fd);
        }
    }
}
