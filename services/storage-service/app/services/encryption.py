# services/storage-service/app/services/encryption.py

import os
import base64
import hashlib
from typing import Union

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from ..config import settings

# --- Helper: master key retrieval ---
def _get_master_key() -> bytes:
    mk_b64 = getattr(settings, "ENCRYPTION_MASTER_KEY", None)
    if mk_b64:
        try:
            mk = base64.b64decode(mk_b64)
            if len(mk) != 32:
                raise ValueError("ENCRYPTION_MASTER_KEY must decode to 32 bytes")
            return mk
        except Exception as e:
            raise RuntimeError(f"Invalid ENCRYPTION_MASTER_KEY: {e}")

    secret = getattr(settings, "SECRET_KEY", None)
    if not secret:
        raise RuntimeError("No ENCRYPTION_MASTER_KEY or SECRET_KEY found in settings")
    return hashlib.sha256(secret.encode()).digest()

MASTER_KEY = _get_master_key()
NONCE_SIZE = 12  # recommended nonce size for AES-GCM

class EncryptionService:
    """
    AES-256-GCM based encryption service with backward-compatible method names.

    Public API (compatible):
      - generate_file_key() -> bytes (32 bytes)
      - encrypt_key(file_key: bytes) -> str (base64)
      - decrypt_key(wrapped_b64: str) -> bytes (raw file key)
      - encrypt_file(data: bytes, file_key: bytes) -> bytes (nonce + ciphertext)
      - decrypt_file(enc: bytes, file_key: bytes) -> bytes
      - encrypt_chunk(chunk_data: bytes, file_key: bytes, chunk_index: int) -> bytes
      - decrypt_chunk(enc_chunk: bytes, file_key: bytes, chunk_index: int) -> bytes

    Backwards-compatibility:
      - encrypt_data / decrypt_data are aliases for encrypt_file / decrypt_file
    """

    def __init__(self):
        self._master = MASTER_KEY

    # ---- Key material ----
    def generate_file_key(self) -> bytes:
        """Return a new random 32-byte key for file/chunk encryption."""
        return os.urandom(32)

    def encrypt_key(self, file_key: Union[bytes, str]) -> str:
        """Wrap a file key using the master key. Returns base64(nonce + ct)."""
        if isinstance(file_key, str):
            file_key = file_key.encode()
        nonce = os.urandom(NONCE_SIZE)
        ct = AESGCM(self._master).encrypt(nonce, file_key, None)
        wrapped = nonce + ct
        return base64.b64encode(wrapped).decode()

    def decrypt_key(self, wrapped_b64: str) -> bytes:
        """Unwrap a base64(wrapped) file key and return raw file key bytes."""
        wrapped = base64.b64decode(wrapped_b64)
        nonce = wrapped[:NONCE_SIZE]
        ct = wrapped[NONCE_SIZE:]
        return AESGCM(self._master).decrypt(nonce, ct, None)

    # ---- Whole-file encryption ----
    def encrypt_file(self, data: bytes, file_key: Union[bytes, str]) -> bytes:
        """Encrypt whole-file bytes. Returns nonce + ciphertext bytes."""
        if isinstance(file_key, str):
            file_key = file_key.encode()
        if len(file_key) != 32:
            try:
                file_key = base64.b64decode(file_key)
            except Exception:
                pass
        nonce = os.urandom(NONCE_SIZE)
        ct = AESGCM(file_key).encrypt(nonce, data, None)
        return nonce + ct

    def decrypt_file(self, enc: bytes, file_key: Union[bytes, str]) -> bytes:
        """Decrypt bytes produced by encrypt_file (nonce + ciphertext)."""
        if isinstance(file_key, str):
            file_key = file_key.encode()
        if len(file_key) != 32:
            try:
                file_key = base64.b64decode(file_key)
            except Exception:
                pass
        nonce = enc[:NONCE_SIZE]
        ct = enc[NONCE_SIZE:]
        return AESGCM(file_key).decrypt(nonce, ct, None)

    # ---- Chunk-level encryption (uses AAD) ----
    def encrypt_chunk(self, chunk_data: bytes, file_key: Union[bytes, str], chunk_index: int) -> bytes:
        """Encrypt a chunk and bind its chunk_index as AAD. Returned: nonce + ciphertext."""
        if isinstance(file_key, str):
            file_key = file_key.encode()
        if len(file_key) != 32:
            try:
                file_key = base64.b64decode(file_key)
            except Exception:
                pass
        aad = str(chunk_index).encode()
        nonce = os.urandom(NONCE_SIZE)
        ct = AESGCM(file_key).encrypt(nonce, chunk_data, aad)
        return nonce + ct

    def decrypt_chunk(self, encrypted_chunk: bytes, file_key: Union[bytes, str], chunk_index: int) -> bytes:
        """Decrypt a chunk encrypted with encrypt_chunk. Verifies chunk_index via AAD."""
        if isinstance(file_key, str):
            file_key = file_key.encode()
        if len(file_key) != 32:
            try:
                file_key = base64.b64decode(file_key)
            except Exception:
                pass
        aad = str(chunk_index).encode()
        nonce = encrypted_chunk[:NONCE_SIZE]
        ct = encrypted_chunk[NONCE_SIZE:]
        return AESGCM(file_key).decrypt(nonce, ct, aad)

    # ---- Backwards-compatible aliases ----
    # Some older code expects `encrypt_data` / `decrypt_data` names (e.g. storage.retrieve_file).
    def encrypt_data(self, data: bytes, file_key: Union[bytes, str]) -> bytes:
        """Alias for encrypt_file (keeps older API)."""
        return self.encrypt_file(data, file_key)

    def decrypt_data(self, encrypted_data: bytes, file_key: Union[bytes, str]) -> bytes:
        """Alias for decrypt_file (keeps older API)."""
        return self.decrypt_file(encrypted_data, file_key)


# Singleton instance
encryption_service = EncryptionService()
