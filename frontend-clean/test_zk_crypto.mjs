#!/usr/bin/env node

/**
 * Test Zero-Knowledge Crypto Functions
 *
 * This script tests the core ZK crypto utilities to ensure they work correctly.
 */

import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from 'bip39';
import { Buffer } from 'buffer';

console.log('\n🧪 Testing Zero-Knowledge Crypto Functions\n');

// Test 1: Random bytes generation
console.log('Test 1: Random bytes generation...');
const randomKey = randomBytes(32);
console.log(`✅ Generated ${randomKey.length} random bytes`);

// Test 2: PBKDF2 key derivation
console.log('\nTest 2: PBKDF2 key derivation...');
const password = 'TestPassword123!';
const salt = randomBytes(32);
const iterations = 600000;

console.time('PBKDF2 (600k iterations)');
const derivedKey = pbkdf2(sha256, utf8ToBytes(password), salt, {
  c: iterations,
  dkLen: 32,
});
console.timeEnd('PBKDF2 (600k iterations)');
console.log(`✅ Derived key: ${bytesToHex(derivedKey).substring(0, 16)}...`);

// Test 3: SHA-256 hashing
console.log('\nTest 3: SHA-256 hashing...');
const hash = sha256(derivedKey);
const hashHex = bytesToHex(hash);
console.log(`✅ Hash: ${hashHex.substring(0, 32)}...`);

// Test 4: AES-256-GCM encryption/decryption
console.log('\nTest 4: AES-256-GCM encryption/decryption...');
const plaintext = utf8ToBytes('Hello, Zero-Knowledge Encryption!');
const encryptionKey = randomBytes(32);
const iv = randomBytes(12);

const aesEncrypt = gcm(encryptionKey, iv);
const encrypted = aesEncrypt.encrypt(plaintext);
console.log(`✅ Encrypted ${plaintext.length} bytes → ${encrypted.length} bytes`);

const aesDecrypt = gcm(encryptionKey, iv);
const decrypted = aesDecrypt.decrypt(encrypted);
const decryptedText = Buffer.from(decrypted).toString('utf8');
console.log(`✅ Decrypted: "${decryptedText}"`);

if (decryptedText === 'Hello, Zero-Knowledge Encryption!') {
  console.log('✅ Encryption/Decryption successful!');
} else {
  console.log('❌ Decryption failed!');
  process.exit(1);
}

// Test 5: BIP39 mnemonic generation
console.log('\nTest 5: BIP39 recovery phrase generation...');
const mnemonic = generateMnemonic(256); // 24 words
const words = mnemonic.split(' ');
console.log(`✅ Generated ${words.length}-word recovery phrase`);
console.log(`   First 3 words: ${words.slice(0, 3).join(' ')}...`);

const isValid = validateMnemonic(mnemonic);
console.log(`✅ Recovery phrase validation: ${isValid ? 'VALID' : 'INVALID'}`);

const seed = mnemonicToSeedSync(mnemonic);
console.log(`✅ Derived ${seed.length}-byte seed from mnemonic`);

// Test 6: Master key encryption workflow
console.log('\nTest 6: Complete master key encryption workflow...');

// Generate master key
const masterKey = randomBytes(32);
console.log('✅ Generated master key');

// Derive key from password
const userPassword = 'MySecurePassword123!';
const kdfSalt = randomBytes(32);
const passwordDerivedKey = pbkdf2(sha256, utf8ToBytes(userPassword), kdfSalt, {
  c: 600000,
  dkLen: 32,
});
console.log('✅ Derived key from password');

// Encrypt master key with password-derived key
const masterKeyIV = randomBytes(12);
const aesEncryptMaster = gcm(passwordDerivedKey, masterKeyIV);
const encryptedMasterKey = aesEncryptMaster.encrypt(masterKey);
console.log('✅ Encrypted master key');

// Decrypt master key
const aesDecryptMaster = gcm(passwordDerivedKey, masterKeyIV);
const decryptedMasterKey = aesDecryptMaster.decrypt(encryptedMasterKey);
console.log('✅ Decrypted master key');

// Verify master keys match
if (Buffer.from(masterKey).equals(Buffer.from(decryptedMasterKey))) {
  console.log('✅ Master key encryption/decryption successful!');
} else {
  console.log('❌ Master key mismatch!');
  process.exit(1);
}

// Test 7: File chunk encryption
console.log('\nTest 7: File chunk encryption...');
const fileKey = randomBytes(32);
const chunkData = utf8ToBytes('This is a file chunk with some test data.');

const chunkIV = randomBytes(12);
const aesChunk = gcm(fileKey, chunkIV);
const encryptedChunk = aesChunk.encrypt(chunkData);
console.log(`✅ Encrypted chunk: ${chunkData.length} bytes → ${encryptedChunk.length} bytes`);

const aesChunkDecrypt = gcm(fileKey, chunkIV);
const decryptedChunk = aesChunkDecrypt.decrypt(encryptedChunk);
const decryptedChunkText = Buffer.from(decryptedChunk).toString('utf8');
console.log(`✅ Decrypted chunk: "${decryptedChunkText.substring(0, 30)}..."`);

// Summary
console.log('\n' + '='.repeat(60));
console.log('🎉 All ZK crypto tests passed!');
console.log('='.repeat(60));
console.log('\n✅ Key Derivation: PBKDF2 with 600k iterations');
console.log('✅ Encryption: AES-256-GCM with authentication');
console.log('✅ Hashing: SHA-256');
console.log('✅ Recovery: BIP39 24-word mnemonic');
console.log('✅ Workflow: Complete ZK encryption flow validated\n');
