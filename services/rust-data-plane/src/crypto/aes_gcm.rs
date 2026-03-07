use crate::error::CryptoError;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::rand::{SecureRandom, SystemRandom};
use tracing::{debug, instrument};

/// AES-256-GCM cipher with hardware acceleration support
pub struct AesGcmCipher {
    rng: SystemRandom,
}

impl AesGcmCipher {
    pub fn new() -> Self {
        Self {
            rng: SystemRandom::new(),
        }
    }

    /// Encrypt chunk with AES-256-GCM
    ///
    /// Output format: nonce (12 bytes) || ciphertext || tag (16 bytes)
    ///
    /// # Arguments
    /// * `plaintext` - Data to encrypt
    /// * `key` - 32-byte encryption key
    /// * `chunk_index` - Chunk index for AAD (prevents chunk reordering attacks)
    ///
    /// # Security
    /// - Random nonce generated per encryption (never reused)
    /// - Chunk index in AAD prevents chunk reordering
    /// - Hardware AES-NI acceleration when available
    #[instrument(skip(self, plaintext, key), fields(plaintext_len = plaintext.len()))]
    pub fn encrypt_chunk(
        &self,
        plaintext: &[u8],
        key: &[u8; 32],
        chunk_index: u64,
    ) -> Result<Vec<u8>, CryptoError> {
        // Generate random nonce (12 bytes for AES-GCM)
        let mut nonce_bytes = [0u8; NONCE_LEN];
        self.rng
            .fill(&mut nonce_bytes)
            .map_err(|_| CryptoError::NonceGenerationFailed)?;

        debug!(
            chunk_index = chunk_index,
            nonce = ?&nonce_bytes[..4], // Log first 4 bytes only
            "Generated encryption nonce"
        );

        // AAD: chunk index for binding (prevents chunk reordering)
        let aad_bytes = chunk_index.to_le_bytes();

        // Create cipher
        let unbound_key = UnboundKey::new(&AES_256_GCM, key)?;
        let key = LessSafeKey::new(unbound_key);
        let nonce = Nonce::assume_unique_for_key(nonce_bytes);

        // Encrypt in-place (plaintext + space for tag)
        let mut in_out = Vec::with_capacity(plaintext.len() + AES_256_GCM.tag_len());
        in_out.extend_from_slice(plaintext);

        key.seal_in_place_append_tag(nonce, Aad::from(&aad_bytes), &mut in_out)?;

        // Construct output: nonce || ciphertext+tag
        let mut output = Vec::with_capacity(NONCE_LEN + in_out.len());
        output.extend_from_slice(&nonce_bytes);
        output.extend_from_slice(&in_out);

        debug!(
            output_len = output.len(),
            expected_len = NONCE_LEN + plaintext.len() + AES_256_GCM.tag_len(),
            "Encryption completed"
        );

        Ok(output)
    }

    /// Decrypt chunk with AES-256-GCM
    ///
    /// Input format: nonce (12 bytes) || ciphertext || tag (16 bytes)
    ///
    /// # Arguments
    /// * `ciphertext` - Encrypted data with nonce prepended
    /// * `key` - 32-byte decryption key
    /// * `chunk_index` - Chunk index for AAD verification
    #[instrument(skip(self, ciphertext, key), fields(ciphertext_len = ciphertext.len()))]
    pub fn decrypt_chunk(
        &self,
        ciphertext: &[u8],
        key: &[u8; 32],
        chunk_index: u64,
    ) -> Result<Vec<u8>, CryptoError> {
        // Minimum size: nonce (12) + tag (16) = 28 bytes
        if ciphertext.len() < NONCE_LEN + AES_256_GCM.tag_len() {
            return Err(CryptoError::InvalidCiphertext);
        }

        // Parse: nonce || ciphertext+tag
        let nonce_bytes = &ciphertext[..NONCE_LEN];
        let encrypted_data = &ciphertext[NONCE_LEN..];

        debug!(
            chunk_index = chunk_index,
            nonce = ?&nonce_bytes[..4], // Log first 4 bytes only
            encrypted_len = encrypted_data.len(),
            "Decrypting chunk"
        );

        // AAD: chunk index for verification
        let aad_bytes = chunk_index.to_le_bytes();

        // Create cipher
        let unbound_key = UnboundKey::new(&AES_256_GCM, key)?;
        let key = LessSafeKey::new(unbound_key);
        let nonce = Nonce::assume_unique_for_key(
            nonce_bytes
                .try_into()
                .map_err(|_| CryptoError::InvalidCiphertext)?,
        );

        // Decrypt in-place — return buffer directly to avoid redundant copy
        let mut in_out = encrypted_data.to_vec();
        let plaintext_len = key
            .open_in_place(nonce, Aad::from(&aad_bytes), &mut in_out)
            .map_err(|_| CryptoError::DecryptionFailed)?
            .len();

        debug!(plaintext_len = plaintext_len, "Decryption completed");

        in_out.truncate(plaintext_len);
        Ok(in_out)
    }

    /// Hash data with SHA-256
    ///
    /// Returns: "sha256:<hex>"
    pub fn hash_data(data: &[u8]) -> String {
        use ring::digest::{digest, SHA256};
        let hash = digest(&SHA256, data);
        format!("sha256:{}", hex::encode(hash.as_ref()))
    }
}

impl Default for AesGcmCipher {
    fn default() -> Self {
        Self::new()
    }
}

// Fast hex encoding via lookup table (single allocation)
mod hex {
    const HEX_TABLE: &[u8; 16] = b"0123456789abcdef";

    pub fn encode(bytes: &[u8]) -> String {
        let mut s = String::with_capacity(bytes.len() * 2);
        for &b in bytes {
            s.push(HEX_TABLE[(b >> 4) as usize] as char);
            s.push(HEX_TABLE[(b & 0x0f) as usize] as char);
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let cipher = AesGcmCipher::new();
        let key = [0x42u8; 32];
        let plaintext = b"Hello, world! This is a test message.";
        let chunk_index = 42;

        // Encrypt
        let encrypted = cipher
            .encrypt_chunk(plaintext, &key, chunk_index)
            .expect("Encryption failed");

        // Verify format
        assert!(encrypted.len() >= NONCE_LEN + plaintext.len() + AES_256_GCM.tag_len());

        // Decrypt
        let decrypted = cipher
            .decrypt_chunk(&encrypted, &key, chunk_index)
            .expect("Decryption failed");

        // Verify
        assert_eq!(plaintext, &decrypted[..]);
    }

    #[test]
    fn test_chunk_index_binding() {
        let cipher = AesGcmCipher::new();
        let key = [0x42u8; 32];
        let plaintext = b"Test data for AAD verification";

        // Encrypt with chunk index 1
        let encrypted = cipher
            .encrypt_chunk(plaintext, &key, 1)
            .expect("Encryption failed");

        // Try to decrypt with wrong chunk index (should fail due to AAD mismatch)
        let result = cipher.decrypt_chunk(&encrypted, &key, 2);
        assert!(result.is_err());

        // Decrypt with correct chunk index (should succeed)
        let decrypted = cipher
            .decrypt_chunk(&encrypted, &key, 1)
            .expect("Decryption with correct index failed");
        assert_eq!(plaintext, &decrypted[..]);
    }

    #[test]
    fn test_invalid_ciphertext() {
        let cipher = AesGcmCipher::new();
        let key = [0x42u8; 32];

        // Too short
        let short_ciphertext = vec![0u8; 20];
        assert!(cipher.decrypt_chunk(&short_ciphertext, &key, 0).is_err());

        // Corrupted data
        let mut corrupted = cipher
            .encrypt_chunk(b"test", &key, 0)
            .expect("Encryption failed");
        corrupted[NONCE_LEN] ^= 0xFF; // Flip bits in ciphertext
        assert!(cipher.decrypt_chunk(&corrupted, &key, 0).is_err());
    }

    #[test]
    fn test_different_keys() {
        let cipher = AesGcmCipher::new();
        let key1 = [0x42u8; 32];
        let key2 = [0x43u8; 32];
        let plaintext = b"Secret message";

        let encrypted = cipher
            .encrypt_chunk(plaintext, &key1, 0)
            .expect("Encryption failed");

        // Wrong key should fail
        assert!(cipher.decrypt_chunk(&encrypted, &key2, 0).is_err());
    }

    #[test]
    fn test_hash_data() {
        let data = b"test data";
        let hash = AesGcmCipher::hash_data(data);

        // Should start with sha256:
        assert!(hash.starts_with("sha256:"));

        // Should be consistent
        let hash2 = AesGcmCipher::hash_data(data);
        assert_eq!(hash, hash2);

        // Different data should have different hash
        let hash3 = AesGcmCipher::hash_data(b"different data");
        assert_ne!(hash, hash3);
    }
}
