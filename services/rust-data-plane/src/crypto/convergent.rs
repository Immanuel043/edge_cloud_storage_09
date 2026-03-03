//! Convergent encryption for content-addressed deduplication.
//!
//! Matches the Python implementation in `deduplication_enhanced.py`:
//!   1. PBKDF2-HMAC-SHA256 key derivation from content hash + user salt
//!   2. HMAC-SHA256 synthetic IV derivation (deterministic per block)
//!   3. AES-256-GCM encryption
//!
//! Output format: nonce(12) || tag(16) || ciphertext
//!   (matches Python: nonce + encryptor.tag + encrypted_data)

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::digest::{digest, SHA256};
use ring::hmac;
use ring::pbkdf2;
use std::num::NonZeroU32;
use tracing::{debug, instrument};

use crate::error::CryptoError;

const PBKDF2_ITERATIONS: u32 = 100_000;
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

/// Derive a user-specific salt from user_id.
/// Mirrors Python: `hashlib.sha256(f"dedup_user_{user_id}_salt".encode()).digest()`
fn derive_user_salt(user_id: &str) -> [u8; 32] {
    let input = format!("dedup_user_{}_salt", user_id);
    let d = digest(&SHA256, input.as_bytes());
    let mut salt = [0u8; 32];
    salt.copy_from_slice(d.as_ref());
    salt
}

/// Derive convergent encryption key from content hash bytes + user salt.
/// Mirrors Python: `hashlib.pbkdf2_hmac('sha256', content_hash, salt, 100000, dklen=32)`
///
/// `content_hash_bytes` is the raw 32-byte SHA-256 digest of the block data.
fn derive_key(content_hash_bytes: &[u8; 32], salt: &[u8; 32]) -> [u8; KEY_LEN] {
    let mut key = [0u8; KEY_LEN];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(PBKDF2_ITERATIONS).unwrap(),
        salt,
        content_hash_bytes,
        &mut key,
    );
    key
}

/// Derive a deterministic 12-byte IV from key + block_hash_hex.
/// Mirrors Python:
/// ```python
/// hmac.new(block_key, new_block['hash'].encode(), hashlib.sha256).digest()[:12]
/// ```
fn derive_synthetic_iv(key: &[u8; KEY_LEN], block_hash_hex: &str) -> [u8; NONCE_LEN] {
    let signing_key = hmac::Key::new(hmac::HMAC_SHA256, key);
    let tag = hmac::sign(&signing_key, block_hash_hex.as_bytes());
    let mut iv = [0u8; NONCE_LEN];
    iv.copy_from_slice(&tag.as_ref()[..NONCE_LEN]);
    iv
}

/// Perform convergent encryption for a dedup block.
///
/// Returns the encrypted blob: `nonce(12) || tag(16) || ciphertext`.
///
/// The caller supplies the block data and its hex-encoded SHA-256 hash
/// (already verified to match) plus the user_id for salt derivation.
#[instrument(skip(block_data), fields(block_hash = %block_hash_hex, data_len = block_data.len()))]
pub fn convergent_encrypt(
    block_data: &[u8],
    block_hash_hex: &str,
    user_id: &str,
) -> Result<Vec<u8>, CryptoError> {
    // 1. Content hash as raw bytes (SHA-256 of block data)
    let content_hash = digest(&SHA256, block_data);
    let content_hash_bytes: [u8; 32] = content_hash
        .as_ref()
        .try_into()
        .map_err(|_| CryptoError::RingError("SHA-256 digest size mismatch".into()))?;

    // 2. Derive user salt
    let salt = derive_user_salt(user_id);

    // 3. Derive key via PBKDF2
    let key = derive_key(&content_hash_bytes, &salt);

    // 4. Derive deterministic IV via HMAC
    let iv = derive_synthetic_iv(&key, block_hash_hex);

    debug!("Convergent encrypt: PBKDF2 + AES-256-GCM");

    // 5. AES-256-GCM encrypt
    let unbound_key = UnboundKey::new(&AES_256_GCM, &key)?;
    let sealing_key = LessSafeKey::new(unbound_key);
    let nonce = Nonce::assume_unique_for_key(iv);

    let mut in_out = Vec::with_capacity(block_data.len() + AES_256_GCM.tag_len());
    in_out.extend_from_slice(block_data);

    // Encrypt in place, appending tag
    sealing_key
        .seal_in_place_append_tag(nonce, Aad::empty(), &mut in_out)
        .map_err(|_| CryptoError::EncryptionFailed)?;

    // in_out = ciphertext || tag(16)
    // We need: nonce(12) || tag(16) || ciphertext  (to match Python format)
    let ct_len = in_out.len() - TAG_LEN;
    let tag_bytes: [u8; TAG_LEN] = in_out[ct_len..].try_into().unwrap();
    let ciphertext = &in_out[..ct_len];

    let mut output = Vec::with_capacity(NONCE_LEN + TAG_LEN + ct_len);
    output.extend_from_slice(&iv);
    output.extend_from_slice(&tag_bytes);
    output.extend_from_slice(ciphertext);

    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deterministic_encryption() {
        let data = b"Hello, dedup world!";
        let hash_hex = {
            let d = digest(&SHA256, data);
            d.as_ref().iter().map(|b| format!("{:02x}", b)).collect::<String>()
        };

        let enc1 = convergent_encrypt(data, &hash_hex, "user-1").unwrap();
        let enc2 = convergent_encrypt(data, &hash_hex, "user-1").unwrap();

        assert_eq!(enc1, enc2, "same data + user must produce identical ciphertext");
    }

    #[test]
    fn test_different_users_differ() {
        let data = b"Hello, dedup world!";
        let hash_hex = {
            let d = digest(&SHA256, data);
            d.as_ref().iter().map(|b| format!("{:02x}", b)).collect::<String>()
        };

        let enc1 = convergent_encrypt(data, &hash_hex, "user-1").unwrap();
        let enc2 = convergent_encrypt(data, &hash_hex, "user-2").unwrap();

        assert_ne!(enc1, enc2, "different users must produce different ciphertext");
    }

    #[test]
    fn test_output_format() {
        let data = b"test";
        let hash_hex = {
            let d = digest(&SHA256, data);
            d.as_ref().iter().map(|b| format!("{:02x}", b)).collect::<String>()
        };

        let enc = convergent_encrypt(data, &hash_hex, "u").unwrap();
        // nonce(12) + tag(16) + ciphertext(len(data))
        assert_eq!(enc.len(), NONCE_LEN + TAG_LEN + data.len());
    }
}
