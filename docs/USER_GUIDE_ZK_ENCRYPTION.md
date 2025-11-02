# User Guide: Zero-Knowledge Encryption

**Version**: 1.0
**Last Updated**: November 2, 2025

---

## Table of Contents

1. [What is Zero-Knowledge Encryption?](#what-is-zero-knowledge-encryption)
2. [Getting Started](#getting-started)
3. [Creating a ZK Account](#creating-a-zk-account)
4. [Uploading Encrypted Files](#uploading-encrypted-files)
5. [Downloading Encrypted Files](#downloading-encrypted-files)
6. [Session Management](#session-management)
7. [Recovery Phrase](#recovery-phrase)
8. [Troubleshooting](#troubleshooting)
9. [Security Best Practices](#security-best-practices)
10. [FAQ](#faq)

---

## What is Zero-Knowledge Encryption?

Zero-Knowledge (ZK) encryption means that **only you** can decrypt your files. The server stores your files in encrypted form but **never has access to your decryption keys**.

### Key Benefits

✅ **End-to-End Encryption**: Files are encrypted on your device before upload
✅ **Server Can't Decrypt**: We cannot access your files, even if we wanted to
✅ **Privacy Guaranteed**: Your data remains private from everyone, including us
✅ **Authentication**: Files are protected from tampering with cryptographic verification
✅ **Account Recovery**: 24-word recovery phrase ensures you never lose access

### How It Works

```
Your Device                    Our Server
-----------                    ----------

1. You upload a file
   ↓
2. File encrypted with AES-256-GCM ────→ Encrypted file stored
   (Your master key)                     (Server cannot decrypt)

3. You download a file
   ↓
4. Encrypted file retrieved ←──────────  Encrypted file sent
   ↓
5. File decrypted on your device
   (Using your master key)
   ↓
6. Original file available
```

**Important**: The server never sees your files in plaintext or your master encryption key.

---

## Getting Started

### Prerequisites

- Modern web browser (Chrome, Firefox, Safari, Edge)
- JavaScript enabled
- Secure connection (HTTPS)

### System Requirements

- **Browser**: Chrome 90+, Firefox 88+, Safari 14+, Edge 90+
- **Storage**: At least 2GB free space for large file operations
- **Connection**: Broadband internet recommended for large files

---

## Creating a ZK Account

### Step 1: Sign Up

1. Go to the registration page
2. Enter your email and choose a strong password
3. **Enable Zero-Knowledge Encryption** (check the box)
4. Click "Create Account"

### Step 2: Setup Recovery Phrase

After creating your account, you'll immediately see your **24-word recovery phrase**.

⚠️ **CRITICAL**: Write down these 24 words in order and store them securely!

**Why is this important?**
- If you forget your password, this is the ONLY way to recover your files
- Without these words, your encrypted files are permanently lost
- We cannot reset or recover these words for you

**Storage Options:**
- ✅ Write on paper and store in a safe
- ✅ Use a password manager
- ✅ Store in a fireproof lockbox
- ❌ Don't save in email or cloud storage
- ❌ Don't take a screenshot
- ❌ Don't share with anyone

### Step 3: Confirm Recovery Phrase

You'll be asked to confirm your recovery phrase by selecting words in the correct order. This ensures you've saved it correctly.

### Step 4: Start Using ZK Encryption

Once confirmed, you're ready to upload encrypted files!

---

## Uploading Encrypted Files

### Standard Upload Process

1. **Login** to your ZK account
2. **Unlock your session** (enter password if locked)
3. Click the **"Upload"** button
4. Select file(s) from your device
5. Watch the **encryption progress**:
   - Green lock badge: "Encrypting"
   - Progress bar shows upload status
   - Message: "Encrypting chunks with AES-256-GCM"

### What Happens During Upload

```
1. File selected (e.g., "document.pdf")
2. Random 256-bit encryption key generated
3. File split into 32MB chunks
4. Each chunk encrypted with AES-256-GCM
5. Encrypted chunks uploaded to server
6. File appears with green lock badge 🔒
```

### Upload Indicators

Look for these visual cues:

- **Green Lock Badge**: File is being encrypted
- **"Encrypting" Label**: Encryption in progress
- **Shield Icon**: AES-256-GCM encryption active
- **Progress Details**: Shows bytes uploaded and percentage

### Performance Notes

- **Small files (<50MB)**: ~2-5 seconds including encryption
- **Large files (>500MB)**: Uses parallel encryption for speed
- **Very large files (>1GB)**: Automatic batching prevents memory issues

---

## Downloading Encrypted Files

### Standard Download Process

1. **Find your encrypted file** (marked with 🔒 lock badge)
2. Click the **download button**
3. **Enter password** if session is locked
4. Watch the **decryption progress**:
   - "Downloading..." stage
   - "Decrypting..." stage (with progress bar)
   - For large files: "Parallel streaming decryption enabled"

### What Happens During Download

```
1. Download button clicked
2. Encrypted chunks downloaded from server
3. File key decrypted with your master key
4. Chunks decrypted on your device
   - Small files: Sequential decryption
   - Large files: Parallel decryption (up to 8 workers)
5. Decrypted file assembled
6. Browser triggers download
```

### Download Performance

| File Size | Method | Speed |
|-----------|--------|-------|
| <50 MB | Sequential | Standard |
| 50-500 MB | Streaming (3-5 workers) | 2-3x faster |
| >500 MB | Streaming (5-8 workers) | 3-5x faster |

### Decryption Indicators

- **Blue Progress Bar**: Downloading encrypted chunks
- **Green Progress Bar**: Decrypting chunks
- **Shield Icon**: AES-256-GCM decryption active
- **Worker Count**: "3 workers active" (for large files)
- **Streaming Badge**: Parallel decryption enabled

---

## Session Management

### Session Lock

Your encryption session automatically locks after:
- **30 minutes of inactivity**
- **Browser tab closed**
- **Manual lock** (click lock button)

### Unlocking Your Session

When locked, you'll see the **"Session Locked"** modal:

1. Enter your password
2. Click "Unlock Session"
3. Session unlocks (your master key is restored)
4. Continue downloading encrypted files

**Note**: You can still upload files with a locked session, but cannot download encrypted files until unlocked.

### Manual Lock

To manually lock your session:
1. Click your profile menu
2. Select "Lock Session"
3. Session immediately locks

**When to manually lock:**
- Stepping away from your computer
- Sharing your screen
- Using a public/shared computer

### Session Best Practices

✅ Lock session when away from computer
✅ Use strong, unique password
✅ Enable browser password manager
❌ Don't share your password
❌ Don't leave session unlocked in public

---

## Recovery Phrase

### What is a Recovery Phrase?

Your **24-word recovery phrase** is a backup of your encryption master key. It allows you to:

- Recover your account if you forget your password
- Access your encrypted files on a new device
- Restore your encryption keys after password reset

### How to Use Recovery Phrase

#### Scenario 1: Forgot Password

1. Click "Use recovery phrase" on login page
2. Enter all 24 words in correct order
3. Create a new password
4. Your encrypted files are now accessible

#### Scenario 2: New Device

1. Login to your account on new device
2. Use recovery phrase to unlock encryption
3. All your encrypted files are available

### Recovery Phrase Security

⚠️ **NEVER share your recovery phrase with anyone!**

**Who should have access:**
- ✅ Only you
- ❌ Not our support team
- ❌ Not your friends/family (unless trusted)
- ❌ Not anyone claiming to be from our company

**If compromised:**
1. Login immediately
2. Change your password
3. Re-encrypt all files (download + re-upload)
4. Contact support to rotate encryption keys

---

## Troubleshooting

### Common Issues

#### 1. "Session is locked" Error

**Problem**: Trying to download while session locked

**Solution**:
1. Enter your password to unlock
2. Retry download

---

#### 2. "File corruption detected" Error

**Problem**: File failed authentication check

**Possible Causes**:
- File was modified on server (tampering)
- Network error during upload
- Storage system corruption

**Solution**:
1. Try downloading again (may be temporary)
2. If persists: Re-upload the file
3. Contact support if issue continues

---

#### 3. Download Fails or Hangs

**Problem**: Large file download stuck or fails

**Solution**:
1. Check internet connection
2. Disable browser extensions (ad blockers)
3. Try different browser
4. Clear browser cache
5. Try smaller file first to test

---

#### 4. "Cannot decrypt file key" Error

**Problem**: Wrong password or corrupted encryption key

**Solution**:
1. Try password again (check caps lock)
2. Use recovery phrase if password forgotten
3. Contact support if neither works

---

#### 5. Browser Crashes During Download

**Problem**: Large file exhausts browser memory

**Solution**:
- Use latest browser version (automatic streaming for large files)
- Close other tabs
- Increase browser memory limit
- Download on desktop (not mobile)

---

### Getting Help

If you encounter issues:

1. **Check Console**: Press F12 → Console tab (share errors with support)
2. **Contact Support**: support@example.com
3. **Include Details**:
   - Browser and version
   - File size
   - Error message
   - Console logs (if available)

---

## Security Best Practices

### Password Security

✅ **Use strong password**: 12+ characters, mix of letters/numbers/symbols
✅ **Unique password**: Don't reuse from other sites
✅ **Password manager**: Use 1Password, Bitwarden, etc.
❌ **Don't share**: Never share with anyone
❌ **Don't write down**: Unless stored securely offline

### Recovery Phrase Security

✅ **Physical backup**: Write on paper, store in safe
✅ **Multiple copies**: 2-3 copies in different secure locations
✅ **Fireproof storage**: Consider fireproof/waterproof container
❌ **Digital storage**: Never in email, cloud, or plain text file
❌ **Photos**: Don't take screenshots or photos

### File Security

✅ **Verify downloads**: Check file opens correctly after download
✅ **Delete originals**: After upload, securely delete local copy if desired
✅ **Lock session**: When away from computer
❌ **Public computers**: Avoid using ZK encryption on shared devices

### Network Security

✅ **HTTPS only**: Always use secure connection (lock icon in browser)
✅ **VPN recommended**: For additional privacy
✅ **Private network**: Avoid public WiFi for sensitive files
❌ **HTTP**: Never use unencrypted connection

---

## FAQ

### General Questions

**Q: Can the server see my files?**
A: No. Files are encrypted on your device before upload. The server only stores encrypted data and cannot decrypt it.

**Q: What happens if the server is hacked?**
A: Attackers only get encrypted files. Without your master key (which only exists on your device), the files are useless.

**Q: Can I share encrypted files?**
A: Currently, encrypted files can only be decrypted by you. Sharing features for ZK files are planned for future release.

**Q: Do I need ZK encryption for all files?**
A: No. ZK encryption is optional. You can use standard uploads for non-sensitive files.

---

### Technical Questions

**Q: What encryption algorithm is used?**
A: AES-256-GCM (Advanced Encryption Standard with 256-bit keys in Galois/Counter Mode).

**Q: How is my master key generated?**
A: Your master key is derived from your password using PBKDF2 with 600,000 iterations.

**Q: Where is my master key stored?**
A: In browser memory during active session. Never sent to server or stored long-term.

**Q: Can I use ZK encryption on mobile?**
A: Yes, but performance may vary. Desktop recommended for files >100MB.

**Q: Does encryption slow down uploads/downloads?**
A: Minimal impact (<10% slower). Large files use parallel processing to minimize overhead.

---

### Account Management

**Q: Can I disable ZK encryption later?**
A: Yes, but existing encrypted files remain encrypted. Only new uploads will be unencrypted.

**Q: What if I lose my recovery phrase AND forget password?**
A: Your encrypted files are permanently inaccessible. This is the trade-off for true zero-knowledge security.

**Q: Can support reset my encryption keys?**
A: No. We cannot access or reset your keys. Only you have this ability via recovery phrase.

**Q: Can I change my recovery phrase?**
A: No. The recovery phrase is mathematically tied to your encryption keys. To change it, you must re-encrypt all files.

---

### Performance

**Q: Why is my first download slow?**
A: First download initializes encryption workers. Subsequent downloads are faster.

**Q: How many files can I encrypt?**
A: No limit. Storage quota is same as standard accounts.

**Q: Does ZK encryption use more storage space?**
A: Yes, ~0.1% overhead for encryption metadata (negligible for most files).

---

## Support

For additional help:

- **Email**: support@example.com
- **Documentation**: https://docs.example.com
- **Community Forum**: https://community.example.com
- **Status Page**: https://status.example.com

---

**Security Notice**: If you suspect your account has been compromised, immediately:
1. Change your password
2. Lock your session
3. Contact support
4. Review recent activity logs

---

*This guide covers the essential features of Zero-Knowledge encryption. For advanced topics, see the Developer Guide.*
