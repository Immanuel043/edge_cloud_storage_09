# services/storage-service/app/services/encryption_enhanced.py

"""
Enhanced Encryption Service with Envelope Encryption and Key Rotation

Features:
- Envelope encryption (data encrypted with DEK, DEK encrypted with KEK)
- Key rotation support with key versioning
- Multiple master keys support (for zero-downtime rotation)
- Hardware Security Module (HSM) ready architecture
- Comprehensive audit logging
- FIPS 140-2 compliant algorithms

Architecture:
1. Master Keys (KEK - Key Encryption Keys):
   - Stored in secure key management system
   - Versioned for rotation
   - Used only to wrap/unwrap DEKs

2. Data Encryption Keys (DEK):
   - Generated per file/object
   - Encrypted with current active KEK
   - Stored alongside encrypted data
   - Never stored in plaintext

3. Key Hierarchy:
   Root KEK (HSM/KMS)
     └─> KEK v1, v2, v3... (versioned master keys)
           └─> DEK 1, DEK 2, DEK 3... (per-file keys)
                 └─> Encrypted data
"""

import base64
import hashlib
import json
import logging
import os
from datetime import datetime, timedelta
from enum import Enum
from typing import Dict, Optional, Tuple, Union

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings

logger = logging.getLogger(__name__)

# Constants
NONCE_SIZE = 12  # AES-GCM recommended nonce size
KEY_SIZE = 32  # AES-256 key size
PBKDF2_ITERATIONS = 600_000  # OWASP recommendation (2023)


class KeyVersion(Enum):
    """Key version status"""

    ACTIVE = "active"  # Currently used for new encryptions
    DEPRECATED = "deprecated"  # Can decrypt but not encrypt
    RETIRED = "retired"  # Cannot be used (archived)


class EncryptedEnvelope:
    """
    Represents an encrypted data envelope
    Contains: encrypted_dek, dek_key_version, encrypted_data, metadata
    """

    def __init__(
        self,
        encrypted_data: bytes,
        encrypted_dek: bytes,
        dek_key_version: int,
        nonce: bytes,
        metadata: Optional[Dict] = None,
    ):
        self.encrypted_data = encrypted_data
        self.encrypted_dek = encrypted_dek
        self.dek_key_version = dek_key_version
        self.nonce = nonce
        self.metadata = metadata or {}
        self.created_at = datetime.utcnow()

    def to_bytes(self) -> bytes:
        """Serialize envelope to bytes for storage"""
        # Format: [version:1][key_version:2][nonce_len:2][nonce][dek_len:2][encrypted_dek][metadata_len:4][metadata][encrypted_data]
        envelope_version = b"\x01"  # Version 1 of envelope format
        key_version = self.dek_key_version.to_bytes(2, "big")

        nonce_len = len(self.nonce).to_bytes(2, "big")
        dek_len = len(self.encrypted_dek).to_bytes(2, "big")

        metadata_json = json.dumps(self.metadata).encode()
        metadata_len = len(metadata_json).to_bytes(4, "big")

        return (
            envelope_version
            + key_version
            + nonce_len
            + self.nonce
            + dek_len
            + self.encrypted_dek
            + metadata_len
            + metadata_json
            + self.encrypted_data
        )

    @classmethod
    def from_bytes(cls, data: bytes) -> "EncryptedEnvelope":
        """Deserialize envelope from bytes"""
        offset = 0

        # Parse version
        envelope_version = data[offset]
        offset += 1

        if envelope_version != 1:
            raise ValueError(f"Unsupported envelope version: {envelope_version}")

        # Parse key version
        key_version = int.from_bytes(data[offset : offset + 2], "big")
        offset += 2

        # Parse nonce
        nonce_len = int.from_bytes(data[offset : offset + 2], "big")
        offset += 2
        nonce = data[offset : offset + nonce_len]
        offset += nonce_len

        # Parse encrypted DEK
        dek_len = int.from_bytes(data[offset : offset + 2], "big")
        offset += 2
        encrypted_dek = data[offset : offset + dek_len]
        offset += dek_len

        # Parse metadata
        metadata_len = int.from_bytes(data[offset : offset + 4], "big")
        offset += 4
        metadata_json = data[offset : offset + metadata_len]
        offset += metadata_len
        metadata = json.loads(metadata_json.decode())

        # Rest is encrypted data
        encrypted_data = data[offset:]

        return cls(
            encrypted_data=encrypted_data,
            encrypted_dek=encrypted_dek,
            dek_key_version=key_version,
            nonce=nonce,
            metadata=metadata,
        )


class EnhancedEncryptionService:
    """
    Enhanced encryption service with envelope encryption and key rotation

    This service provides:
    1. Envelope encryption (data key encrypted with master key)
    2. Key versioning and rotation
    3. Multiple master key support
    4. Audit logging
    5. HSM/KMS integration ready
    """

    def __init__(self):
        """Initialize encryption service with master keys"""
        self.master_keys: Dict[int, bytes] = {}
        self.active_key_version = 1
        self._load_master_keys()

        logger.info(
            f"Enhanced encryption service initialized with "
            f"{len(self.master_keys)} master key(s), "
            f"active version: {self.active_key_version}"
        )

    def _load_master_keys(self):
        """Load master keys from configuration/KMS"""
        # Load primary master key (current active)
        master_key_b64 = getattr(settings, "ENCRYPTION_MASTER_KEY", None)

        if master_key_b64:
            try:
                master_key = base64.b64decode(master_key_b64)
                if len(master_key) != KEY_SIZE:
                    raise ValueError("ENCRYPTION_MASTER_KEY must be 32 bytes")
                self.master_keys[1] = master_key
                self.active_key_version = 1
            except Exception as e:
                logger.error(f"Failed to load master key: {e}")
                raise RuntimeError(f"Invalid ENCRYPTION_MASTER_KEY: {e}")
        else:
            # Fallback: derive from SECRET_KEY (not recommended for production)
            secret = getattr(settings, "SECRET_KEY", None)
            if not secret:
                raise RuntimeError("No ENCRYPTION_MASTER_KEY or SECRET_KEY found")

            logger.warning(
                "Using SECRET_KEY to derive encryption key - "
                "Set ENCRYPTION_MASTER_KEY for production!"
            )
            master_key = hashlib.sha256(secret.encode()).digest()
            self.master_keys[1] = master_key
            self.active_key_version = 1

        # Load additional rotated keys (for backward compatibility)
        # In production, these would come from KMS/HSM
        for version in range(2, 6):  # Support up to 5 key versions
            key_env_var = f"ENCRYPTION_MASTER_KEY_V{version}"
            rotated_key_b64 = getattr(settings, key_env_var, None)

            if rotated_key_b64:
                try:
                    rotated_key = base64.b64decode(rotated_key_b64)
                    if len(rotated_key) == KEY_SIZE:
                        self.master_keys[version] = rotated_key
                        logger.info(f"Loaded master key version {version}")
                except Exception as e:
                    logger.warning(f"Failed to load key version {version}: {e}")

    def _get_master_key(self, version: int) -> bytes:
        """Get master key by version"""
        key = self.master_keys.get(version)
        if not key:
            raise ValueError(f"Master key version {version} not found")
        return key

    def _get_active_master_key(self) -> Tuple[bytes, int]:
        """Get currently active master key and its version"""
        return self._get_master_key(self.active_key_version), self.active_key_version

    # ====== Data Encryption Key (DEK) Management ======

    def generate_dek(self) -> bytes:
        """Generate a new random 256-bit data encryption key"""
        return os.urandom(KEY_SIZE)

    def wrap_dek(self, dek: bytes, kek_version: Optional[int] = None) -> Tuple[bytes, int]:
        """
        Wrap (encrypt) a DEK with the master KEK

        Args:
            dek: Data encryption key to wrap
            kek_version: KEK version to use (None = active)

        Returns:
            Tuple of (encrypted_dek, kek_version_used)
        """
        if kek_version is None:
            kek, kek_version = self._get_active_master_key()
        else:
            kek = self._get_master_key(kek_version)

        nonce = os.urandom(NONCE_SIZE)
        cipher = AESGCM(kek)

        # Additional authenticated data: key version (deterministic, no timestamp)
        aad = json.dumps({"version": kek_version}, sort_keys=True).encode()

        ciphertext = cipher.encrypt(nonce, dek, aad)
        wrapped = nonce + ciphertext

        return wrapped, kek_version

    def unwrap_dek(self, wrapped_dek: bytes, kek_version: int) -> bytes:
        """
        Unwrap (decrypt) a DEK using the specified KEK version

        Args:
            wrapped_dek: Encrypted DEK
            kek_version: KEK version used for wrapping

        Returns:
            Decrypted DEK
        """
        kek = self._get_master_key(kek_version)

        nonce = wrapped_dek[:NONCE_SIZE]
        ciphertext = wrapped_dek[NONCE_SIZE:]

        cipher = AESGCM(kek)

        # Try to decrypt with AAD first (new format)
        try:
            aad = json.dumps({"version": kek_version}, sort_keys=True).encode()
            dek = cipher.decrypt(nonce, ciphertext, aad)
        except Exception:
            # Fallback: try without AAD (old format compatibility)
            try:
                dek = cipher.decrypt(nonce, ciphertext, None)
            except Exception as e:
                logger.error(f"Failed to unwrap DEK with version {kek_version}: {e}")
                raise

        return dek

    # ====== Envelope Encryption ======

    def encrypt_with_envelope(
        self, data: bytes, metadata: Optional[Dict] = None
    ) -> EncryptedEnvelope:
        """
        Encrypt data using envelope encryption

        Process:
        1. Generate random DEK
        2. Encrypt data with DEK
        3. Wrap DEK with active KEK
        4. Return envelope with encrypted data + encrypted DEK

        Args:
            data: Data to encrypt
            metadata: Optional metadata to include in envelope

        Returns:
            EncryptedEnvelope object
        """
        # Generate DEK
        dek = self.generate_dek()

        # Encrypt data with DEK
        nonce = os.urandom(NONCE_SIZE)
        cipher = AESGCM(dek)
        encrypted_data = cipher.encrypt(nonce, data, None)

        # Wrap DEK with active KEK
        encrypted_dek, kek_version = self.wrap_dek(dek)

        # Add metadata
        if metadata is None:
            metadata = {}
        metadata.update(
            {
                "encrypted_at": datetime.utcnow().isoformat(),
                "data_size": len(data),
                "algorithm": "AES-256-GCM",
                "envelope_version": 1,
            }
        )

        envelope = EncryptedEnvelope(
            encrypted_data=encrypted_data,
            encrypted_dek=encrypted_dek,
            dek_key_version=kek_version,
            nonce=nonce,
            metadata=metadata,
        )

        logger.debug(f"Encrypted {len(data)} bytes with envelope " f"(KEK version {kek_version})")

        return envelope

    def decrypt_with_envelope(self, envelope: EncryptedEnvelope) -> bytes:
        """
        Decrypt data from an encrypted envelope

        Process:
        1. Unwrap DEK using specified KEK version
        2. Decrypt data with DEK
        3. Return plaintext data

        Args:
            envelope: EncryptedEnvelope object

        Returns:
            Decrypted data
        """
        # Unwrap DEK
        dek = self.unwrap_dek(envelope.encrypted_dek, envelope.dek_key_version)

        # Decrypt data with DEK
        cipher = AESGCM(dek)
        data = cipher.decrypt(envelope.nonce, envelope.encrypted_data, None)

        logger.debug(
            f"Decrypted {len(data)} bytes from envelope "
            f"(KEK version {envelope.dek_key_version})"
        )

        return data

    # ====== Convenience Methods (Base64 encoding) ======

    def encrypt_file_envelope(self, data: bytes, metadata: Optional[Dict] = None) -> str:
        """
        Encrypt file data and return base64-encoded envelope

        Args:
            data: File data to encrypt
            metadata: Optional metadata

        Returns:
            Base64-encoded envelope
        """
        envelope = self.encrypt_with_envelope(data, metadata)
        envelope_bytes = envelope.to_bytes()
        return base64.b64encode(envelope_bytes).decode()

    def decrypt_file_envelope(self, envelope_b64: str) -> bytes:
        """
        Decrypt file data from base64-encoded envelope

        Args:
            envelope_b64: Base64-encoded envelope

        Returns:
            Decrypted file data
        """
        envelope_bytes = base64.b64decode(envelope_b64)
        envelope = EncryptedEnvelope.from_bytes(envelope_bytes)
        return self.decrypt_with_envelope(envelope)

    # ====== Key Rotation ======

    def rotate_master_key(self, new_master_key: bytes) -> int:
        """
        Rotate to a new master key

        Args:
            new_master_key: New 32-byte master key

        Returns:
            New key version number
        """
        if len(new_master_key) != KEY_SIZE:
            raise ValueError("Master key must be 32 bytes")

        # Increment version
        new_version = max(self.master_keys.keys()) + 1

        # Add new key
        self.master_keys[new_version] = new_master_key
        self.active_key_version = new_version

        logger.warning(
            f"Master key rotated to version {new_version}. "
            f"Old keys still available for decryption."
        )

        return new_version

    async def re_encrypt_with_new_key(
        self, envelope_b64: str, db: Optional[AsyncSession] = None
    ) -> str:
        """
        Re-encrypt data with the current active key

        This is used during key rotation to update old encrypted data.

        Args:
            envelope_b64: Base64-encoded envelope encrypted with old key
            db: Database session (for audit logging)

        Returns:
            Base64-encoded envelope encrypted with new active key
        """
        # Decrypt with old key
        envelope_bytes = base64.b64decode(envelope_b64)
        old_envelope = EncryptedEnvelope.from_bytes(envelope_bytes)
        data = self.decrypt_with_envelope(old_envelope)

        # Re-encrypt with new key
        old_version = old_envelope.dek_key_version
        new_envelope = self.encrypt_with_envelope(data, old_envelope.metadata)
        new_envelope_b64 = base64.b64encode(new_envelope.to_bytes()).decode()

        logger.info(
            f"Re-encrypted data from key version {old_version} "
            f"to {new_envelope.dek_key_version}"
        )

        # TODO: Audit log the re-encryption
        # if db:
        #     await audit_log(db, "key_rotation", {...})

        return new_envelope_b64

    # ====== Backward Compatibility with Old Service ======

    def generate_file_key(self) -> bytes:
        """Generate file key (backward compatible)"""
        return self.generate_dek()

    def encrypt_key(self, file_key: Union[bytes, str]) -> str:
        """Encrypt file key (backward compatible)"""
        if isinstance(file_key, str):
            file_key = file_key.encode()

        wrapped_dek, version = self.wrap_dek(file_key)

        # Old format: base64(wrapped_dek)
        # New format includes version, but we store it separately in DB
        return base64.b64encode(wrapped_dek).decode()

    def decrypt_key(self, wrapped_b64: str, version: int = 1) -> bytes:
        """Decrypt file key (backward compatible)"""
        wrapped_dek = base64.b64decode(wrapped_b64)
        return self.unwrap_dek(wrapped_dek, version)

    def encrypt_file(self, data: bytes, file_key: Union[bytes, str]) -> bytes:
        """Encrypt file (backward compatible)"""
        if isinstance(file_key, str):
            file_key = file_key.encode()
        if len(file_key) != KEY_SIZE:
            file_key = base64.b64decode(file_key)

        nonce = os.urandom(NONCE_SIZE)
        cipher = AESGCM(file_key)
        ciphertext = cipher.encrypt(nonce, data, None)
        return nonce + ciphertext

    def decrypt_file(self, enc: bytes, file_key: Union[bytes, str]) -> bytes:
        """Decrypt file (backward compatible)"""
        if isinstance(file_key, str):
            file_key = file_key.encode()
        if len(file_key) != KEY_SIZE:
            file_key = base64.b64decode(file_key)

        nonce = enc[:NONCE_SIZE]
        ciphertext = enc[NONCE_SIZE:]
        cipher = AESGCM(file_key)
        return cipher.decrypt(nonce, ciphertext, None)


# Singleton instance
enhanced_encryption_service = EnhancedEncryptionService()
