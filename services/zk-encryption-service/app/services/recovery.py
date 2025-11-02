"""
Recovery Phrase Service (BIP39)

Implements BIP39 mnemonic code for generating and validating
24-word recovery phrases. These phrases can be used to recover
the user's master encryption key if they forget their password.

BIP39 Standard: https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki

Security Properties:
- 24 words = 256 bits of entropy
- Wordlist has 2048 words (11 bits per word)
- Built-in checksum (last word contains checksum)
- Language-specific wordlists (we use English)
"""
import os
import hashlib
import secrets
from typing import List, Tuple, Optional
from mnemonic import Mnemonic


class RecoveryPhraseService:
    """
    Service for generating and managing recovery phrases using BIP39.

    Recovery phrases provide a human-readable backup of the encryption key.
    Users write down 24 words and can use them to recover their account
    if they forget their password.

    Example:
        apple banana cherry dragon eagle falcon grape honey igloo jungle
        kite lemon mango nectar orange purple queen river snake tiger
        umbrella volcano yellow zebra
    """

    # Use English wordlist (2048 words)
    def __init__(self, language: str = "english"):
        """
        Initialize recovery phrase service.

        Args:
            language: BIP39 language (english, spanish, french, etc.)
        """
        self.mnemonic = Mnemonic(language)
        self.language = language

    def generate_recovery_phrase(self, strength: int = 256) -> str:
        """
        Generate a new BIP39 recovery phrase.

        Args:
            strength: Entropy strength in bits (128, 160, 192, 224, or 256)
                     256 bits = 24 words (recommended for maximum security)
                     128 bits = 12 words (acceptable for lower security needs)

        Returns:
            Space-separated mnemonic phrase (24 words for 256-bit strength)

        Example:
            >>> service = RecoveryPhraseService()
            >>> phrase = service.generate_recovery_phrase()
            >>> print(phrase)
            'apple banana cherry dragon eagle falcon grape honey igloo ...'
        """
        if strength not in [128, 160, 192, 224, 256]:
            raise ValueError("Strength must be 128, 160, 192, 224, or 256 bits")

        # Generate cryptographically secure random entropy
        entropy = secrets.token_bytes(strength // 8)

        # Convert to mnemonic phrase
        phrase = self.mnemonic.to_mnemonic(entropy)

        return phrase

    def validate_recovery_phrase(self, phrase: str) -> bool:
        """
        Validate a recovery phrase using BIP39 checksum.

        Args:
            phrase: Space-separated mnemonic phrase

        Returns:
            True if valid, False otherwise

        Example:
            >>> service.validate_recovery_phrase("apple banana ...")
            True
        """
        return self.mnemonic.check(phrase)

    def phrase_to_seed(self, phrase: str, passphrase: str = "") -> bytes:
        """
        Convert recovery phrase to a 512-bit seed using PBKDF2.

        The seed can be used to derive encryption keys. Optionally,
        a passphrase can be added for extra security (25th word).

        Args:
            phrase: Valid BIP39 mnemonic phrase
            passphrase: Optional extra passphrase (empty by default)

        Returns:
            64-byte (512-bit) seed

        Note:
            BIP39 uses PBKDF2-HMAC-SHA512 with 2048 iterations.
            The passphrase acts as a "25th word" for extra security.
        """
        if not self.validate_recovery_phrase(phrase):
            raise ValueError("Invalid recovery phrase (checksum failed)")

        # BIP39 standard: derive 512-bit seed
        seed = self.mnemonic.to_seed(phrase, passphrase)
        return seed

    def derive_key_from_phrase(
        self,
        phrase: str,
        passphrase: str = "",
        key_length: int = 32
    ) -> bytes:
        """
        Derive an encryption key from recovery phrase.

        This is the key that will be used to encrypt/decrypt the
        user's master encryption key.

        Args:
            phrase: Valid BIP39 mnemonic phrase
            passphrase: Optional extra passphrase
            key_length: Desired key length in bytes (default 32 = 256 bits)

        Returns:
            Derived encryption key

        Example:
            >>> phrase = "apple banana cherry ..."
            >>> key = service.derive_key_from_phrase(phrase)
            >>> # Use key to encrypt master key
        """
        seed = self.phrase_to_seed(phrase, passphrase)

        # Use first key_length bytes of seed
        # (seed is 64 bytes, we typically need 32 bytes for AES-256)
        return seed[:key_length]

    def hash_recovery_phrase(self, phrase: str) -> str:
        """
        Hash recovery phrase for verification purposes.

        The server stores SHA-256(phrase) to verify during recovery
        without storing the actual phrase.

        Args:
            phrase: Recovery phrase

        Returns:
            Hex-encoded SHA-256 hash

        Example:
            >>> phrase = "apple banana cherry ..."
            >>> hash_value = service.hash_recovery_phrase(phrase)
            >>> # Store hash in database, NOT the phrase
        """
        phrase_bytes = phrase.encode('utf-8')
        return hashlib.sha256(phrase_bytes).hexdigest()

    def verify_recovery_phrase_hash(
        self,
        phrase: str,
        stored_hash: str
    ) -> bool:
        """
        Verify a recovery phrase matches the stored hash.

        Used during account recovery to verify user has the correct phrase.

        Args:
            phrase: Recovery phrase provided by user
            stored_hash: Hash stored in database

        Returns:
            True if phrase matches, False otherwise
        """
        import hmac
        computed_hash = self.hash_recovery_phrase(phrase)
        return hmac.compare_digest(computed_hash, stored_hash)

    def split_phrase_into_words(self, phrase: str) -> List[str]:
        """
        Split phrase into individual words.

        Args:
            phrase: Space-separated phrase

        Returns:
            List of words

        Example:
            >>> words = service.split_phrase_into_words("apple banana cherry")
            >>> print(words)
            ['apple', 'banana', 'cherry']
        """
        return phrase.strip().split()

    def get_word_at_index(self, phrase: str, index: int) -> str:
        """
        Get a specific word from the phrase (1-indexed).

        Used for verification during setup (ask user to confirm
        random words to ensure they saved it correctly).

        Args:
            phrase: Recovery phrase
            index: Word position (1-24 for 24-word phrase)

        Returns:
            Word at that position

        Example:
            >>> phrase = "apple banana cherry ..."
            >>> word_7 = service.get_word_at_index(phrase, 7)
            >>> print(word_7)
            'grape'
        """
        words = self.split_phrase_into_words(phrase)
        if index < 1 or index > len(words):
            raise ValueError(f"Index must be between 1 and {len(words)}")

        return words[index - 1]  # Convert to 0-indexed

    def format_phrase_for_display(self, phrase: str) -> str:
        """
        Format recovery phrase for display (numbered list).

        Args:
            phrase: Recovery phrase

        Returns:
            Formatted string with numbered words

        Example:
            >>> formatted = service.format_phrase_for_display("apple banana cherry")
            >>> print(formatted)
            1. apple
            2. banana
            3. cherry
        """
        words = self.split_phrase_into_words(phrase)
        lines = [f"{i+1:2d}. {word}" for i, word in enumerate(words)]
        return "\n".join(lines)

    def get_wordlist_info(self) -> dict:
        """
        Get information about the BIP39 wordlist.

        Returns:
            Dictionary with wordlist information
        """
        return {
            "language": self.language,
            "word_count": 2048,
            "bits_per_word": 11,
            "entropy_bits": {
                "12_words": 128,
                "15_words": 160,
                "18_words": 192,
                "21_words": 224,
                "24_words": 256
            },
            "recommended": "24_words (256 bits)"
        }


# ========== CLIENT-SIDE REFERENCE IMPLEMENTATION (JavaScript) ==========

CLIENT_SIDE_IMPLEMENTATION = """
// Client-side recovery phrase implementation using bip39.js
// Install: npm install bip39

import * as bip39 from 'bip39';

class RecoveryPhraseClient {
    // Generate new recovery phrase
    static generateRecoveryPhrase(): string {
        // 256 bits = 24 words
        const mnemonic = bip39.generateMnemonic(256);
        return mnemonic;
    }

    // Validate recovery phrase
    static validateRecoveryPhrase(phrase: string): boolean {
        return bip39.validateMnemonic(phrase);
    }

    // Derive key from recovery phrase
    static async deriveKeyFromPhrase(
        phrase: string,
        passphrase: string = ""
    ): Promise<Uint8Array> {
        if (!this.validateRecoveryPhrase(phrase)) {
            throw new Error("Invalid recovery phrase");
        }

        // Derive 512-bit seed
        const seed = await bip39.mnemonicToSeed(phrase, passphrase);

        // Use first 32 bytes for AES-256 key
        return new Uint8Array(seed.slice(0, 32));
    }

    // Encrypt master key with recovery key
    static async encryptMasterKeyWithRecovery(
        masterKey: Uint8Array,
        recoveryPhrase: string
    ): Promise<string> {
        // Derive key from phrase
        const recoveryKey = await this.deriveKeyFromPhrase(recoveryPhrase);

        // Import as AES key
        const recoveryKeyCrypto = await crypto.subtle.importKey(
            "raw",
            recoveryKey,
            "AES-GCM",
            false,
            ["encrypt"]
        );

        // Encrypt master key
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: nonce },
            recoveryKeyCrypto,
            masterKey
        );

        // Combine nonce + ciphertext
        const combined = new Uint8Array(nonce.length + encrypted.byteLength);
        combined.set(nonce);
        combined.set(new Uint8Array(encrypted), nonce.length);

        return btoa(String.fromCharCode(...combined));
    }

    // Recover master key using recovery phrase
    static async recoverMasterKey(
        recoveryPhrase: string,
        encryptedMasterKey: string
    ): Promise<Uint8Array> {
        // Derive key from phrase
        const recoveryKey = await this.deriveKeyFromPhrase(recoveryPhrase);

        // Decode encrypted master key
        const encBytes = Uint8Array.from(
            atob(encryptedMasterKey),
            c => c.charCodeAt(0)
        );

        const nonce = encBytes.slice(0, 12);
        const ciphertext = encBytes.slice(12);

        // Import recovery key
        const recoveryKeyCrypto = await crypto.subtle.importKey(
            "raw",
            recoveryKey,
            "AES-GCM",
            false,
            ["decrypt"]
        );

        // Decrypt master key
        const masterKey = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: nonce },
            recoveryKeyCrypto,
            ciphertext
        );

        return new Uint8Array(masterKey);
    }

    // Format phrase for display
    static formatPhrase(phrase: string): string {
        const words = phrase.split(' ');
        let formatted = '';
        for (let i = 0; i < words.length; i += 6) {
            const row = words.slice(i, i + 6);
            for (let j = 0; j < row.length; j++) {
                formatted += `${(i + j + 1).toString().padStart(2, ' ')}. ${row[j].padEnd(12, ' ')}`;
            }
            formatted += '\\n';
        }
        return formatted;
    }

    // Hash phrase for server verification
    static async hashPhrase(phrase: string): Promise<string> {
        const phraseBytes = new TextEncoder().encode(phrase);
        const hashBuffer = await crypto.subtle.digest('SHA-256', phraseBytes);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }
}

// Example usage
async function setupRecoveryPhrase() {
    // 1. Generate phrase
    const phrase = RecoveryPhraseClient.generateRecoveryPhrase();
    console.log("Recovery Phrase (SAVE THIS!):");
    console.log(RecoveryPhraseClient.formatPhrase(phrase));

    // 2. Get master key (from session)
    const masterKeyB64 = sessionStorage.getItem('mk');
    const masterKey = Uint8Array.from(atob(masterKeyB64), c => c.charCodeAt(0));

    // 3. Encrypt master key with recovery phrase
    const recoveryEncryptedMK = await RecoveryPhraseClient.encryptMasterKeyWithRecovery(
        masterKey,
        phrase
    );

    // 4. Hash phrase for server verification
    const phraseHash = await RecoveryPhraseClient.hashPhrase(phrase);

    // 5. Send to server (NEVER send the actual phrase!)
    await fetch('/api/v1/zk/recovery/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            recovery_encrypted_master_key: recoveryEncryptedMK,
            recovery_phrase_hash: phraseHash
        })
    });

    alert("Recovery phrase enabled! Make sure you saved it.");
}

// Recovery flow
async function recoverAccount(email: string, recoveryPhrase: string) {
    // 1. Fetch encrypted master key
    const response = await fetch(`/api/v1/zk/recovery/info?email=${email}`)
        .then(r => r.json());

    // 2. Recover master key
    const masterKey = await RecoveryPhraseClient.recoverMasterKey(
        recoveryPhrase,
        response.recovery_encrypted_master_key
    );

    // 3. Store in session
    sessionStorage.setItem('mk', btoa(String.fromCharCode(...masterKey)));

    // 4. User can now set new password
    return true;
}
"""


if __name__ == "__main__":
    # Example usage
    service = RecoveryPhraseService()

    # Generate recovery phrase
    phrase = service.generate_recovery_phrase()
    print("Generated Recovery Phrase:")
    print(service.format_phrase_for_display(phrase))
    print()

    # Validate phrase
    is_valid = service.validate_recovery_phrase(phrase)
    print(f"Is valid: {is_valid}")
    print()

    # Derive key from phrase
    recovery_key = service.derive_key_from_phrase(phrase)
    print(f"Recovery key (hex): {recovery_key.hex()}")
    print()

    # Hash for storage
    phrase_hash = service.hash_recovery_phrase(phrase)
    print(f"Phrase hash (for database): {phrase_hash}")
    print()

    # Test verification
    word_7 = service.get_word_at_index(phrase, 7)
    print(f"Word #7: {word_7}")
    print()

    # Wordlist info
    print("Wordlist info:", service.get_wordlist_info())
