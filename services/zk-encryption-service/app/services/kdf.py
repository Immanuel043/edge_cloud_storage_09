"""
Key Derivation Functions (KDF) Service

Provides PBKDF2 and Argon2id implementations for deriving encryption keys
from user passwords. These functions are intentionally slow to resist
brute-force attacks.

Security Properties:
- PBKDF2-HMAC-SHA256: OWASP recommended 600,000 iterations
- Argon2id: Memory-hard function resistant to GPU/ASIC attacks
- Unique salt per user (prevents rainbow tables)
"""
import os
import hashlib
import hmac
from typing import Tuple, Literal
import struct


class KDFService:
    """
    Key Derivation Function service for zero-knowledge encryption.

    This service runs SERVER-SIDE but only for verification purposes.
    The actual key derivation happens CLIENT-SIDE, and the derived key
    NEVER leaves the client.

    Server only stores:
    - Salt (public, not secret)
    - Hash of the derived key (for login verification)
    - KDF parameters (algorithm, iterations, memory)
    """

    # OWASP 2023 recommendations
    PBKDF2_DEFAULT_ITERATIONS = 600_000
    PBKDF2_MIN_ITERATIONS = 100_000

    # Argon2id recommendations (OWASP)
    ARGON2_DEFAULT_MEMORY = 65536  # 64 MB
    ARGON2_DEFAULT_TIME = 3        # iterations
    ARGON2_DEFAULT_PARALLELISM = 4  # threads

    @staticmethod
    def generate_salt(length: int = 16) -> bytes:
        """
        Generate cryptographically secure random salt.

        Args:
            length: Salt length in bytes (default 16 = 128 bits)

        Returns:
            Random salt bytes
        """
        return os.urandom(length)

    @staticmethod
    def derive_key_pbkdf2(
        password: str,
        salt: bytes,
        iterations: int = PBKDF2_DEFAULT_ITERATIONS,
        key_length: int = 32
    ) -> bytes:
        """
        Derive key using PBKDF2-HMAC-SHA256.

        ⚠️  This should run CLIENT-SIDE. Server-side implementation is only
            for testing and validation purposes.

        Args:
            password: User's password (UTF-8 string)
            salt: Random salt (16+ bytes)
            iterations: Number of PBKDF2 iterations (default 600,000)
            key_length: Derived key length in bytes (default 32 = 256 bits)

        Returns:
            Derived key bytes

        Performance:
            ~500ms on modern CPU (intentionally slow for security)
        """
        if iterations < KDFService.PBKDF2_MIN_ITERATIONS:
            raise ValueError(f"Iterations must be >= {KDFService.PBKDF2_MIN_ITERATIONS}")

        password_bytes = password.encode('utf-8')

        return hashlib.pbkdf2_hmac(
            'sha256',
            password_bytes,
            salt,
            iterations,
            dklen=key_length
        )

    @staticmethod
    def derive_key_argon2id(
        password: str,
        salt: bytes,
        time_cost: int = ARGON2_DEFAULT_TIME,
        memory_cost: int = ARGON2_DEFAULT_MEMORY,
        parallelism: int = ARGON2_DEFAULT_PARALLELISM,
        key_length: int = 32
    ) -> bytes:
        """
        Derive key using Argon2id (memory-hard function).

        Argon2id is MORE SECURE than PBKDF2 as it's resistant to:
        - GPU attacks (requires large memory)
        - ASIC attacks (custom hardware)
        - Side-channel attacks (constant-time)

        ⚠️  Requires 'argon2-cffi' library. Install: pip install argon2-cffi

        Args:
            password: User's password
            salt: Random salt (16+ bytes)
            time_cost: Number of iterations (default 3)
            memory_cost: Memory in KB (default 65536 = 64MB)
            parallelism: Number of threads (default 4)
            key_length: Derived key length (default 32 bytes)

        Returns:
            Derived key bytes

        Performance:
            ~500-1000ms on modern CPU (more expensive than PBKDF2)
        """
        try:
            from argon2 import low_level
            from argon2 import Type
        except ImportError:
            raise ImportError(
                "argon2-cffi not installed. "
                "Install with: pip install argon2-cffi"
            )

        password_bytes = password.encode('utf-8')

        return low_level.hash_secret_raw(
            secret=password_bytes,
            salt=salt,
            time_cost=time_cost,
            memory_cost=memory_cost,
            parallelism=parallelism,
            hash_len=key_length,
            type=Type.ID  # Argon2id (hybrid of Argon2i and Argon2d)
        )

    @staticmethod
    def hash_derived_key(derived_key: bytes) -> str:
        """
        Hash the derived key for storage/verification.

        The server stores SHA-256(derived_key), NOT the derived key itself.
        This allows verification during login without knowing the actual key.

        Args:
            derived_key: Key derived from password

        Returns:
            Hex-encoded SHA-256 hash
        """
        return hashlib.sha256(derived_key).hexdigest()

    @staticmethod
    def verify_derived_key(derived_key: bytes, stored_hash: str) -> bool:
        """
        Verify a derived key matches the stored hash.

        Used during login to verify password without storing the password.

        Args:
            derived_key: Key derived from user's password
            stored_hash: Hash stored in database

        Returns:
            True if key matches, False otherwise
        """
        computed_hash = KDFService.hash_derived_key(derived_key)
        return hmac.compare_digest(computed_hash, stored_hash)

    @staticmethod
    def get_kdf_parameters(
        algorithm: Literal['pbkdf2', 'argon2id'],
        custom_iterations: int = None,
        custom_memory: int = None,
        custom_parallelism: int = None
    ) -> dict:
        """
        Get recommended KDF parameters for client-side implementation.

        Returns parameters that the client should use for key derivation.

        Args:
            algorithm: 'pbkdf2' or 'argon2id'
            custom_iterations: Override default iterations (PBKDF2 or Argon2)
            custom_memory: Override default memory (Argon2 only)
            custom_parallelism: Override default parallelism (Argon2 only)

        Returns:
            Dictionary with KDF parameters
        """
        if algorithm == 'pbkdf2':
            return {
                'algorithm': 'pbkdf2',
                'hash': 'sha256',
                'iterations': custom_iterations or KDFService.PBKDF2_DEFAULT_ITERATIONS,
                'key_length': 32
            }
        elif algorithm == 'argon2id':
            return {
                'algorithm': 'argon2id',
                'time_cost': custom_iterations or KDFService.ARGON2_DEFAULT_TIME,
                'memory_cost': custom_memory or KDFService.ARGON2_DEFAULT_MEMORY,
                'parallelism': custom_parallelism or KDFService.ARGON2_DEFAULT_PARALLELISM,
                'key_length': 32
            }
        else:
            raise ValueError(f"Unknown algorithm: {algorithm}")


# ========== CLIENT-SIDE REFERENCE IMPLEMENTATION (JavaScript/TypeScript) ==========

CLIENT_SIDE_IMPLEMENTATION = """
// This is how the client should implement key derivation
// ⚠️  CRITICAL: This must run in the browser, NEVER send password to server

// PBKDF2 Implementation (Web Crypto API)
async function deriveKeyPBKDF2(password, saltBase64, iterations = 600000) {
    // Import password as key material
    const enc = new TextEncoder();
    const passwordKey = await crypto.subtle.importKey(
        "raw",
        enc.encode(password),
        "PBKDF2",
        false,
        ["deriveBits", "deriveKey"]
    );

    // Decode salt from base64
    const salt = Uint8Array.from(atob(saltBase64), c => c.charCodeAt(0));

    // Derive key
    const derivedKey = await crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: salt,
            iterations: iterations,
            hash: "SHA-256"
        },
        passwordKey,
        { name: "AES-GCM", length: 256 },
        true,  // extractable
        ["encrypt", "decrypt"]
    );

    // Export as raw bytes
    const keyBytes = await crypto.subtle.exportKey("raw", derivedKey);
    return new Uint8Array(keyBytes);
}

// Hash for server verification
async function hashDerivedKey(derivedKey) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", derivedKey);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Complete registration flow
async function registerWithZK(email, username, password) {
    // 1. Generate salt
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const saltBase64 = btoa(String.fromCharCode(...salt));

    // 2. Derive key from password
    const derivedKey = await deriveKeyPBKDF2(password, saltBase64);

    // 3. Hash for server verification
    const derivedKeyHash = await hashDerivedKey(derivedKey);

    // 4. Generate master key
    const masterKey = crypto.getRandomValues(new Uint8Array(32));

    // 5. Encrypt master key with derived key
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const derivedKeyCrypto = await crypto.subtle.importKey(
        "raw", derivedKey, "AES-GCM", false, ["encrypt"]
    );
    const encryptedMasterKey = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce },
        derivedKeyCrypto,
        masterKey
    );

    // 6. Combine nonce + encrypted master key
    const combined = new Uint8Array(nonce.length + encryptedMasterKey.byteLength);
    combined.set(nonce);
    combined.set(new Uint8Array(encryptedMasterKey), nonce.length);
    const encryptedMasterKeyBase64 = btoa(String.fromCharCode(...combined));

    // 7. Send to server (NEVER send password or derivedKey!)
    await fetch('/api/v1/zk/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email: email,
            username: username,
            password_hash: derivedKeyHash,  // ← Hash only, NOT the key
            encrypted_master_key: encryptedMasterKeyBase64,
            kdf_salt: saltBase64,
            kdf_params: {
                algorithm: 'pbkdf2',
                iterations: 600000,
                hash: 'sha256'
            }
        })
    });

    // 8. Store master key in sessionStorage (cleared on logout)
    sessionStorage.setItem('mk', btoa(String.fromCharCode(...masterKey)));
}

// Complete login flow
async function loginWithZK(email, password) {
    // 1. Fetch KDF parameters
    const params = await fetch(`/api/v1/zk/auth/kdf-params?email=${email}`)
        .then(r => r.json());

    // 2. Derive key with same parameters
    const derivedKey = await deriveKeyPBKDF2(
        password,
        params.kdf_salt,
        params.kdf_iterations
    );

    // 3. Hash for authentication
    const derivedKeyHash = await hashDerivedKey(derivedKey);

    // 4. Login
    const response = await fetch('/api/v1/zk/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email: email,
            password_hash: derivedKeyHash  // ← Hash only
        })
    }).then(r => r.json());

    // 5. Decrypt master key
    const encMKBytes = Uint8Array.from(
        atob(response.encrypted_master_key), c => c.charCodeAt(0)
    );
    const nonce = encMKBytes.slice(0, 12);
    const ciphertext = encMKBytes.slice(12);

    const derivedKeyCrypto = await crypto.subtle.importKey(
        "raw", derivedKey, "AES-GCM", false, ["decrypt"]
    );
    const masterKey = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce },
        derivedKeyCrypto,
        ciphertext
    );

    // 6. Store master key in session
    sessionStorage.setItem('mk', btoa(String.fromCharCode(...new Uint8Array(masterKey))));

    return response.access_token;
}
"""


if __name__ == "__main__":
    # Example usage (server-side testing only)
    import base64

    kdf = KDFService()

    # Generate salt
    salt = kdf.generate_salt()
    print(f"Salt (base64): {base64.b64encode(salt).decode()}")

    # Simulate what client does
    password = "MySecurePassword123!"
    derived_key = kdf.derive_key_pbkdf2(password, salt)
    derived_key_hash = kdf.hash_derived_key(derived_key)

    print(f"Derived key (hex): {derived_key.hex()}")
    print(f"Derived key hash: {derived_key_hash}")

    # Verification (what server does during login)
    is_valid = kdf.verify_derived_key(derived_key, derived_key_hash)
    print(f"Verification: {is_valid}")

    # Get parameters for client
    params = kdf.get_kdf_parameters('pbkdf2')
    print(f"Client parameters: {params}")
