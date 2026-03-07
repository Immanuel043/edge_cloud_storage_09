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
use parking_lot::Mutex;
use std::num::{NonZeroU32, NonZeroUsize};
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

// LRU cache for PBKDF2-derived keys: avoids re-running 100k iterations for
// the same (content_hash, salt) pair (the whole point of convergent/dedup).
lazy_static::lazy_static! {
    static ref PBKDF2_KEY_CACHE: Mutex<lru::LruCache<[u8; 64], [u8; KEY_LEN]>> =
        Mutex::new(lru::LruCache::new(NonZeroUsize::new(1024).unwrap()));
}

/// Derive convergent encryption key from content hash bytes + user salt.
/// Mirrors Python: `hashlib.pbkdf2_hmac('sha256', content_hash, salt, 100000, dklen=32)`
///
/// `content_hash_bytes` is the raw 32-byte SHA-256 digest of the block data.
/// Results are cached in an LRU cache keyed on `(content_hash, salt)`.
fn derive_key(content_hash_bytes: &[u8; 32], salt: &[u8; 32]) -> [u8; KEY_LEN] {
    let mut cache_key = [0u8; 64];
    cache_key[..32].copy_from_slice(content_hash_bytes);
    cache_key[32..].copy_from_slice(salt);

    let mut cache = PBKDF2_KEY_CACHE.lock();
    if let Some(cached) = cache.get(&cache_key) {
        return *cached;
    }

    let mut key = [0u8; KEY_LEN];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(PBKDF2_ITERATIONS).unwrap(),
        salt,
        content_hash_bytes,
        &mut key,
    );
    cache.put(cache_key, key);
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
/// plus the user_id for salt derivation.
///
/// **Important**: `block_hash_hex` MUST be the hex SHA-256 of the *original*
/// plaintext (before any compression).  The key is derived from this hash so
/// that `convergent_decrypt` — which also uses `block_hash_hex` — produces
/// the same key regardless of whether the input was compressed.
#[instrument(skip(block_data), fields(block_hash = %block_hash_hex, data_len = block_data.len()))]
pub fn convergent_encrypt(
    block_data: &[u8],
    block_hash_hex: &str,
    user_id: &str,
) -> Result<Vec<u8>, CryptoError> {
    // 1. Content hash as raw bytes — derived from block_hash_hex (original
    //    plaintext hash), NOT from block_data which may be compressed.
    let content_hash_bytes: [u8; 32] = hex_to_bytes32(block_hash_hex)
        .ok_or_else(|| CryptoError::RingError("Invalid block_hash_hex".into()))?;

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

/// Perform convergent decryption for a dedup block.
///
/// Input format: `nonce(12) || tag(16) || ciphertext` (as produced by `convergent_encrypt`).
///
/// `block_hash_hex` is the hex SHA-256 of the original plaintext, used for
/// key + IV derivation (same as during encryption).
#[instrument(skip(encrypted_data), fields(block_hash = %block_hash_hex, data_len = encrypted_data.len()))]
pub fn convergent_decrypt(
    encrypted_data: &[u8],
    block_hash_hex: &str,
    user_id: &str,
) -> Result<Vec<u8>, CryptoError> {
    // 1. Parse nonce(12), tag(16), ciphertext from input
    if encrypted_data.len() < NONCE_LEN + TAG_LEN {
        return Err(CryptoError::InvalidCiphertext);
    }

    let nonce_bytes: [u8; NONCE_LEN] = encrypted_data[..NONCE_LEN]
        .try_into()
        .map_err(|_| CryptoError::InvalidCiphertext)?;
    let tag_bytes = &encrypted_data[NONCE_LEN..NONCE_LEN + TAG_LEN];
    let ciphertext = &encrypted_data[NONCE_LEN + TAG_LEN..];

    // 2. Convert block_hash_hex to raw bytes for key derivation
    let content_hash_bytes: [u8; 32] = hex_to_bytes32(block_hash_hex)
        .ok_or_else(|| CryptoError::RingError("Invalid block_hash_hex".into()))?;

    // 3. Derive user salt
    let salt = derive_user_salt(user_id);

    // 4. Derive key via PBKDF2 (same as encryption)
    let key = derive_key(&content_hash_bytes, &salt);

    debug!("Convergent decrypt: PBKDF2 + AES-256-GCM");

    // 5. AES-256-GCM decrypt
    // ring's open_in_place expects: ciphertext || tag  (in a single buffer)
    let unbound_key = UnboundKey::new(&AES_256_GCM, &key)?;
    let opening_key = LessSafeKey::new(unbound_key);
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);

    let mut in_out = Vec::with_capacity(ciphertext.len() + TAG_LEN);
    in_out.extend_from_slice(ciphertext);
    in_out.extend_from_slice(tag_bytes);

    let plaintext_len = opening_key
        .open_in_place(nonce, Aad::empty(), &mut in_out)
        .map_err(|_| CryptoError::DecryptionFailed)?
        .len();

    in_out.truncate(plaintext_len);
    Ok(in_out)
}

/// Parse a 64-char hex string into a 32-byte array (fast lookup-table decoding).
fn hex_to_bytes32(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    let hex_bytes = hex.as_bytes();
    for i in 0..32 {
        let hi = hex_nibble(hex_bytes[i * 2])?;
        let lo = hex_nibble(hex_bytes[i * 2 + 1])?;
        out[i] = (hi << 4) | lo;
    }
    Some(out)
}

#[inline]
fn hex_nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
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

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let data = b"Hello, convergent decryption!";
        let hash_hex = {
            let d = digest(&SHA256, data);
            d.as_ref().iter().map(|b| format!("{:02x}", b)).collect::<String>()
        };

        let encrypted = convergent_encrypt(data, &hash_hex, "user-1").unwrap();
        let decrypted = convergent_decrypt(&encrypted, &hash_hex, "user-1").unwrap();

        assert_eq!(decrypted, data, "decrypt must recover original plaintext");
    }

    #[test]
    fn test_decrypt_wrong_user_fails() {
        let data = b"secret data";
        let hash_hex = {
            let d = digest(&SHA256, data);
            d.as_ref().iter().map(|b| format!("{:02x}", b)).collect::<String>()
        };

        let encrypted = convergent_encrypt(data, &hash_hex, "user-1").unwrap();
        let result = convergent_decrypt(&encrypted, &hash_hex, "user-2");

        assert!(result.is_err(), "decryption with wrong user must fail");
    }

    #[test]
    fn test_decrypt_invalid_ciphertext() {
        let result = convergent_decrypt(b"too short", "a".repeat(64).as_str(), "u");
        assert!(result.is_err(), "too-short input must fail");
    }

    #[test]
    fn test_decrypt_large_block() {
        // Simulate a realistic block size (1MB)
        let data: Vec<u8> = (0..1_048_576).map(|i| (i % 256) as u8).collect();
        let hash_hex = {
            let d = digest(&SHA256, &data);
            d.as_ref().iter().map(|b| format!("{:02x}", b)).collect::<String>()
        };

        let encrypted = convergent_encrypt(&data, &hash_hex, "user-test").unwrap();
        let decrypted = convergent_decrypt(&encrypted, &hash_hex, "user-test").unwrap();

        assert_eq!(decrypted, data);
    }
}
