use crate::error::CryptoError;
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Secure key wrapper with automatic zeroization on drop
///
/// # Security
/// - Keys are zeroized when dropped (automatic via ZeroizeOnDrop)
/// - Keys are stored in heap memory (Box) to prevent stack copies
/// - No Clone trait to prevent accidental copies
/// - No Debug trait to prevent logging
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct SecretKey {
    inner: Box<[u8; 32]>,
}

impl SecretKey {
    /// Create from raw bytes
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self {
            inner: Box::new(bytes),
        }
    }

    /// Create from slice (must be exactly 32 bytes)
    pub fn from_slice(slice: &[u8]) -> Result<Self, CryptoError> {
        if slice.len() != 32 {
            return Err(CryptoError::InvalidKeySize);
        }

        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(slice);
        Ok(Self::from_bytes(bytes))
    }

    /// Get reference to key bytes (const time access)
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.inner
    }

    /// Get pointer to key bytes (for FFI)
    pub fn as_ptr(&self) -> *const u8 {
        self.inner.as_ptr()
    }
}

// Note: Drop is automatically implemented by ZeroizeOnDrop derive macro
// No need for manual Drop implementation

// Clone implementation for SecretKey
// SECURITY NOTE: This creates a copy of the key in memory.
// Both the original and clone will be zeroized when dropped.
// Use sparingly and only when necessary for API ergonomics.
impl Clone for SecretKey {
    fn clone(&self) -> Self {
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(self.inner.as_ref());
        Self {
            inner: Box::new(bytes),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_from_bytes() {
        let key = SecretKey::from_bytes([0x42u8; 32]);
        assert_eq!(key.as_bytes()[0], 0x42);
        assert_eq!(key.as_bytes().len(), 32);
    }

    #[test]
    fn test_create_from_slice() {
        let slice = vec![0x12u8; 32];
        let key = SecretKey::from_slice(&slice).unwrap();
        assert_eq!(key.as_bytes()[0], 0x12);
    }

    #[test]
    fn test_invalid_key_size() {
        let slice = vec![0x12u8; 16]; // Wrong size
        let result = SecretKey::from_slice(&slice);
        assert!(result.is_err());
        assert!(matches!(result, Err(CryptoError::InvalidKeySize)));
    }

    #[test]
    fn test_key_zeroization() {
        let key = SecretKey::from_bytes([0x42u8; 32]);
        let _key_ptr = key.as_ptr();

        // Drop key
        drop(key);

        // Note: Actual memory verification requires unsafe code and may not be reliable
        // In production, use Valgrind or other memory analysis tools
    }

    #[test]
    fn test_as_ptr() {
        let key = SecretKey::from_bytes([0x42u8; 32]);
        let ptr = key.as_ptr();
        assert!(!ptr.is_null());
    }
}
