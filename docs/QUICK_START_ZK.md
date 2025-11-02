# Quick Start Guide: Zero-Knowledge Encryption

**Get started with Zero-Knowledge encryption in 5 minutes!**

---

## For Users

### Step 1: Create a ZK Account (2 minutes)

1. **Go to Registration Page**
   - Navigate to https://your-app.com/register

2. **Fill Out Form**
   ```
   Email: your@email.com
   Password: ************ (strong password!)
   ☑ Enable Zero-Knowledge Encryption
   ```

3. **Click "Create Account"**

4. **IMPORTANT: Save Your Recovery Phrase!**
   - You'll see 24 words
   - Write them down on paper
   - Store in a safe place
   - You'll need these if you forget your password

   Example:
   ```
   apple banner camel digital engine forest ...
   (24 words total)
   ```

5. **Confirm Recovery Phrase**
   - Select words in correct order to confirm

✅ **Done!** You now have a Zero-Knowledge encrypted account.

---

### Step 2: Upload Your First Encrypted File (1 minute)

1. **Login** with your email and password

2. **Click "Upload" Button**

3. **Select a file** from your computer

4. **Watch the magic happen:**
   - File encrypts on your device (you'll see a green lock 🔒)
   - Encrypted file uploads to server
   - Server CANNOT decrypt your file!

5. **File appears with lock badge** in your file list

✅ **Done!** Your file is now encrypted end-to-end.

---

### Step 3: Download Your Encrypted File (1 minute)

1. **Find your file** (look for the lock badge 🔒)

2. **Click download button**

3. **If prompted, enter your password** to unlock session

4. **Wait for decryption:**
   - File downloads encrypted from server
   - Decrypts on your device
   - Original file ready to use!

✅ **Done!** You've successfully encrypted and decrypted a file!

---

## For Developers

### Step 1: Install Dependencies

```bash
# Frontend
cd frontend-clean
npm install

# Backend (if developing locally)
cd services/zk-encryption-service
pip install -r requirements.txt
```

---

### Step 2: Configure Environment

```bash
# frontend-clean/.env
VITE_API_URL=http://localhost:8001
VITE_ZK_SERVICE_URL=http://localhost:8002
```

```bash
# services/zk-encryption-service/.env
DATABASE_URL=postgresql://user:pass@localhost:5432/edge_cloud
SECRET_KEY=your-secret-key-here
```

---

### Step 3: Start Services

```bash
# Terminal 1: Frontend
cd frontend-clean
npm run dev
# → http://localhost:3000

# Terminal 2: Storage Service
cd infrastructure
docker-compose up storage-service postgres redis
# → http://localhost:8001

# Terminal 3: ZK Encryption Service
cd services/zk-encryption-service
uvicorn app.main:app --reload --port 8002
# → http://localhost:8002
```

---

### Step 4: Test ZK Encryption

```javascript
// In browser console after creating ZK account:

// 1. Upload a file
const file = new File(['Hello ZK!'], 'test.txt');
await uploadService.initUpload(file);

// Check console for:
// "[Upload] ZK mode detected - generating file key"
// "[Upload] Encrypted chunk 0: 9 → 37 bytes"

// 2. Download the file
const fileId = 'your-file-id';
await downloadFile(fileId, 'test.txt');

// Check console for:
// "[Download] Starting ZK file download"
// "[Download] Decrypting file key..."
// "[Download] Decrypted chunk 0: 37 → 9 bytes"
```

---

### Step 5: Integrate into Your App

```javascript
// Import services
import * as zkAuthService from './services/zkAuthService';
import * as zkEncryptionService from './services/zkEncryptionService';

// Register ZK account
await zkAuthService.registerZKAccount(email, password);

// Login
await zkAuthService.loginZKAccount(email, password);

// Check if session unlocked
const unlocked = zkEncryptionService.isZKSessionUnlocked();

// Upload encrypted file
const result = await uploadService.initUpload(file);

// Download encrypted file
await storageService.downloadZKFile(fileId, fileName, metadata);
```

---

## Common Tasks

### Enable ZK for Existing Account

```javascript
// 1. Login normally
await login(email, password);

// 2. Enable ZK encryption
await zkAuthService.enableZKForAccount();

// 3. Save recovery phrase (shown in UI)
```

---

### Unlock Session After Lock

```javascript
// Session auto-locks after 30 minutes or browser close

// Method 1: Password
await zkAuthService.unlockSession(password);

// Method 2: Recovery Phrase
await zkAuthService.unlockWithRecoveryPhrase(recoveryPhrase);
```

---

### Check File Encryption Status

```javascript
// Get file metadata
const file = await getFileMetadata(fileId);

if (file.is_encrypted) {
  console.log('✅ File is ZK-encrypted');
  console.log('Algorithm:', file.encryption_algorithm); // "AES-256-GCM"
  console.log('Encrypted key:', file.encrypted_file_key);
} else {
  console.log('ℹ️ File is not encrypted');
}
```

---

### Handle Session Lock Error

```javascript
try {
  await downloadFile(fileId, fileName);
} catch (error) {
  if (error.message.includes('locked')) {
    // Show unlock modal
    setShowUnlockModal(true);

    // After unlock, retry
    await downloadFile(fileId, fileName);
  }
}
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Your Browser                          │
│                                                           │
│  Password ──> PBKDF2 ──> Derived Key                    │
│                              │                            │
│                              ▼                            │
│  Random Master Key <── Decrypt ◄── Encrypted Master Key │
│         │                              (from server)     │
│         │                                                 │
│         ├──> Encrypt File Key ──> Encrypted File Key    │
│         │                          (sent to server)      │
│         │                                                 │
│         └──> Decrypt File Key ◄── Encrypted File Key    │
│                     │              (from server)         │
│                     ▼                                     │
│  File ──> Encrypt Chunks ──> Upload ──> Server Storage │
│  File <── Decrypt Chunks <── Download <── Server       │
│                                                           │
└─────────────────────────────────────────────────────────┘

Server NEVER sees:
  ❌ Your password
  ❌ Your master key
  ❌ Your file keys
  ❌ Your plaintext files
```

---

## Testing Checklist

### Functional Tests

- [ ] Create ZK account
- [ ] Save recovery phrase
- [ ] Upload file (check lock badge appears)
- [ ] Download file (check decryption works)
- [ ] Lock session
- [ ] Unlock with password
- [ ] Unlock with recovery phrase
- [ ] Upload large file (>50MB, should use streaming)
- [ ] Check console logs (encryption/decryption messages)

### Security Tests

- [ ] Verify server cannot decrypt files
- [ ] Check encrypted_file_key in database is base64
- [ ] Verify GCM authentication tags
- [ ] Test file tampering detection
- [ ] Confirm master key cleared on logout
- [ ] Session auto-locks after 30 minutes

### Performance Tests

- [ ] Upload 100MB file (should complete in <30s)
- [ ] Download 100MB file (should use Web Workers)
- [ ] Check browser doesn't freeze during encryption
- [ ] Verify parallel decryption (check worker count in UI)

---

## Troubleshooting

### Problem: "Session is locked" error

**Solution:**
```javascript
// Check session status
console.log('Unlocked:', zkEncryptionService.isZKSessionUnlocked());

// Unlock session
await zkAuthService.unlockSession(password);
```

---

### Problem: File decryption fails

**Possible causes:**
1. Wrong master key (password incorrect)
2. File corrupted during storage
3. File was tampered with

**Debug:**
```javascript
// Enable debug logging
localStorage.setItem('zk_debug', 'true');

// Try download again and check console
```

---

### Problem: Web Workers not initializing

**Check:**
1. Browser supports Web Workers
2. Worker file accessible: `http://localhost:3000/zkDecryptWorker.js`
3. No Content Security Policy blocking workers

**Fix:**
```javascript
// Check worker support
if (!window.Worker) {
  console.error('Web Workers not supported');
}

// Test worker directly
const worker = new Worker('/zkDecryptWorker.js');
worker.postMessage({ type: 'PING' });
worker.onmessage = (e) => console.log('Worker response:', e.data);
```

---

### Problem: Large file upload fails

**Solution:**
```javascript
// Increase chunk size or add retry logic
const CHUNK_SIZE = 32 * 1024 * 1024; // 32MB

// Check upload progress
uploadFile(file, (progress) => {
  console.log(`Chunk ${progress.chunksUploaded}/${progress.totalChunks}`);
});
```

---

## Security Best Practices

### ✅ DO

- Use strong, unique passwords (12+ characters)
- Save recovery phrase in secure, offline location
- Enable two-factor authentication (if available)
- Lock session when leaving computer
- Use HTTPS only (never HTTP)

### ❌ DON'T

- Share your password or recovery phrase
- Save recovery phrase in cloud storage
- Take screenshots of recovery phrase
- Use ZK encryption on public/shared computers
- Ignore browser security warnings

---

## Getting Help

### Documentation

- **User Guide**: [USER_GUIDE_ZK_ENCRYPTION.md](./USER_GUIDE_ZK_ENCRYPTION.md)
- **Developer Guide**: [DEVELOPER_GUIDE_ZK_ENCRYPTION.md](./DEVELOPER_GUIDE_ZK_ENCRYPTION.md)
- **API Reference**: [API_REFERENCE_ZK.md](./API_REFERENCE_ZK.md)

### Support

- **Email**: support@example.com
- **Discord**: https://discord.gg/example
- **GitHub Issues**: https://github.com/example/issues

### Community

- **Forum**: https://forum.example.com
- **Stack Overflow**: Tag `zk-encryption`
- **Twitter**: @example_dev

---

## What's Next?

### For Users

1. **Explore Advanced Features**
   - Folder organization
   - File sharing (coming soon)
   - Mobile app

2. **Backup Your Data**
   - Download all encrypted files periodically
   - Store recovery phrase in multiple secure locations

3. **Share Feedback**
   - Report bugs
   - Suggest features
   - Join community discussions

### For Developers

1. **Read Full Documentation**
   - Architecture details in Developer Guide
   - API specs in API Reference

2. **Build on Top**
   - Integrate ZK encryption into your app
   - Extend with custom features
   - Contribute to open source

3. **Performance Tuning**
   - Profile encryption performance
   - Optimize for your use case
   - Consider Web Crypto API migration

---

## Quick Reference

### Key Commands

```javascript
// Register
await zkAuthService.registerZKAccount(email, password);

// Login
await zkAuthService.loginZKAccount(email, password);

// Unlock
await zkAuthService.unlockSession(password);

// Lock
zkAuthService.lockSession();

// Check status
zkEncryptionService.isZKSessionUnlocked();

// Upload
await uploadService.initUpload(file);

// Download
await storageService.downloadZKFile(fileId, fileName, metadata);
```

### Key Endpoints

```
POST /api/v1/zk/register           - Create ZK account
POST /api/v1/auth/login            - Login (get encrypted master key)
POST /api/v1/upload/init/zk        - Initialize encrypted upload
POST /api/v1/upload/chunk/:id      - Upload encrypted chunk
POST /api/v1/files/:id/download/chunk/:index - Download encrypted chunk
```

### Key Files

```
src/services/zkAuthService.js         - Authentication
src/services/zkEncryptionService.js   - Encryption/Decryption
src/utils/zkCrypto.js                 - Low-level crypto
src/services/zkDecryptWorkerPool.js   - Worker pool management
public/zkDecryptWorker.js             - Background decryption
```

---

**Congratulations!** You're now ready to use Zero-Knowledge encryption! 🎉

For detailed information, see the full documentation guides linked above.

---

**Version**: 1.0
**Last Updated**: November 2, 2025
