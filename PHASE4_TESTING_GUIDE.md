# Phase 4 Testing Guide - File Upload Encryption

**All Services Running** ✅
- Storage Service: http://localhost:8001
- ZK Service: http://localhost:8002
- Frontend: http://localhost:3000
- Database: PostgreSQL (healthy)

---

## Test 1: ZK File Upload (Zero-Knowledge Mode)

### Prerequisites
- You need a ZK-enabled account
- If you already have one from Phase 3 testing, great!
- If not, register a new one below

### Step 1: Create/Login ZK Account

**Option A: Use Existing ZK Account (from Phase 3)**
1. Open: http://localhost:3000/auth
2. Click **"Login"** tab
3. Enter credentials:
   - Email: `zktest3@example.com`
   - Password: `NewPass456!` (or `TestPass123!` if you didn't do recovery)
4. ✅ **Check "Zero-Knowledge Mode"** checkbox
5. Click **"Sign In"**

**Option B: Register New ZK Account**
1. Open: http://localhost:3000/auth
2. Click **"Sign Up"** tab
3. Enter details:
   - Email: `zktest4@example.com`
   - Username: `zktest4`
   - Password: `TestUpload123!`
   - Plan: Individual (default)
4. ✅ **Check "Enable Zero-Knowledge Encryption"**
5. Click **"Create Account"**
6. **IMPORTANT**: You'll see recovery phrase modal
   - Save the 24-word phrase (or skip for testing)
   - Complete verification

### Step 2: Open Browser Console

**Before uploading, open Developer Tools:**
1. Press **F12** (or Cmd+Option+I on Mac)
2. Click **Console** tab
3. Clear console (click 🚫 icon or type `clear()`)
4. Keep console open during upload

### Step 3: Upload a Test File

1. You should be on the Dashboard now
2. Click the **"Upload"** button (or drag & drop)
3. Select a small file (< 10MB for quick testing)
   - Example: Any document, image, or text file
4. **Watch the console** - you should see:

```
[Upload] ZK mode detected - generating file key
[Upload] Encrypted chunk 0: 5242880 → 5242896 bytes
```

5. Upload should complete within seconds
6. File should appear in your file list

### Step 4: Verify ZK Encryption in Console

**Expected Console Output:**
```javascript
[Upload] ZK mode detected - generating file key
// This confirms ZK mode is active

[Upload] Encrypted chunk 0: 33554432 → 33554448 bytes
// Shows original size → encrypted size (+16 bytes for GCM tag)

[Upload] Encrypted chunk 1: 33554432 → 33554448 bytes
// Multiple chunks for larger files
```

**What This Means:**
- File was encrypted **on your browser** before upload
- Each chunk is 16 bytes larger (AES-GCM authentication tag)
- Server never saw plaintext data ✅

### Step 5: Verify in Database

Open a new terminal and run:

```bash
docker exec -it edge-postgres psql -U postgres -d edge_cloud_storage -c "
SELECT
    file_name,
    file_size,
    is_encrypted,
    encrypted_file_key IS NOT NULL as has_encrypted_key,
    encryption_algorithm,
    storage_type
FROM objects
WHERE user_id = (SELECT id FROM users WHERE email = 'zktest4@example.com')
ORDER BY created_at DESC
LIMIT 1;
"
```

**Expected Output:**
```
 file_name        | file_size | is_encrypted | has_encrypted_key | encryption_algorithm | storage_type
------------------+-----------+--------------+-------------------+---------------------+-------------
 your-file.pdf    |   5242880 | t            | t                 | AES-256-GCM         | chunked
```

**Verify:**
- ✅ `is_encrypted` = `t` (true)
- ✅ `has_encrypted_key` = `t` (file key is stored encrypted)
- ✅ `encryption_algorithm` = `AES-256-GCM`

**If you see this, ZK upload is working! 🎉**

### Step 6: Verify ZK Metadata

Check the full ZK metadata:

```bash
docker exec -it edge-postgres psql -U postgres -d edge_cloud_storage -c "
SELECT
    file_name,
    is_encrypted,
    encrypted_file_key IS NOT NULL as has_key,
    file_key_iv IS NOT NULL as has_iv,
    encryption_key IS NULL as no_server_key,
    chunk_info->'zk_mode' as zk_chunk_flag
FROM objects
WHERE user_id = (SELECT id FROM users WHERE email = 'zktest4@example.com')
ORDER BY created_at DESC
LIMIT 1;
"
```

**Expected:**
```
 file_name     | is_encrypted | has_key | has_iv | no_server_key | zk_chunk_flag
---------------+--------------+---------+--------+---------------+--------------
 your-file.pdf | t            | t       | t      | t             | true
```

**Verify:**
- ✅ `has_key` = `t` (encrypted file key stored)
- ✅ `has_iv` = `t` (IV for file key encryption stored)
- ✅ `no_server_key` = `t` (server doesn't have decryption key)
- ✅ `zk_chunk_flag` = `true` (chunks marked as ZK)

---

## Test 2: Non-ZK Upload (Backward Compatibility)

This tests that **standard users are not affected** by ZK changes.

### Step 1: Logout from ZK Account

1. Click your username in top-right
2. Click **"Logout"**

### Step 2: Register Standard Account

1. Go to: http://localhost:3000/auth
2. Click **"Sign Up"** tab
3. Enter details:
   - Email: `standard@example.com`
   - Username: `standard`
   - Password: `Standard123!`
   - Plan: Individual
4. ❌ **DO NOT check "Enable Zero-Knowledge Encryption"**
5. Click **"Create Account"**
6. Should go directly to dashboard (no recovery phrase)

### Step 3: Upload a File

1. Open **Browser Console** (F12)
2. Clear console
3. Click **"Upload"** button
4. Select any file (same one as before is fine)

### Step 4: Verify NO ZK Encryption

**Console Should NOT Show:**
- ❌ No `[Upload] ZK mode detected` message
- ❌ No encryption logs
- File just uploads normally

**This confirms ZK mode is OFF for standard accounts ✅**

### Step 5: Verify Standard Encryption in Database

```bash
docker exec -it edge-postgres psql -U postgres -d edge_cloud_storage -c "
SELECT
    file_name,
    is_encrypted,
    encrypted_file_key IS NULL as no_client_key,
    encryption_key IS NOT NULL as has_server_key,
    storage_type
FROM objects
WHERE user_id = (SELECT id FROM users WHERE email = 'standard@example.com')
ORDER BY created_at DESC
LIMIT 1;
"
```

**Expected:**
```
 file_name     | is_encrypted | no_client_key | has_server_key | storage_type
---------------+--------------+---------------+----------------+-------------
 your-file.pdf | f            | t             | t              | chunked
```

**Verify:**
- ✅ `is_encrypted` = `f` (false - not client-side encrypted)
- ✅ `no_client_key` = `t` (no client-encrypted key)
- ✅ `has_server_key` = `t` (server has encryption key)

**This confirms backward compatibility! Standard mode works as before! 🎉**

---

## Test 3: Compare ZK vs Non-ZK

Let's compare the two uploads side-by-side:

```bash
docker exec -it edge-postgres psql -U postgres -d edge_cloud_storage -c "
SELECT
    u.email,
    o.file_name,
    o.is_encrypted as client_encrypted,
    o.encrypted_file_key IS NOT NULL as has_zk_key,
    o.encryption_key IS NOT NULL as has_server_key,
    o.encryption_algorithm
FROM objects o
JOIN users u ON o.user_id = u.id
WHERE u.email IN ('zktest4@example.com', 'standard@example.com')
ORDER BY o.created_at DESC;
"
```

**Expected:**
```
        email          | file_name     | client_encrypted | has_zk_key | has_server_key | encryption_algorithm
-----------------------+---------------+------------------+------------+----------------+---------------------
 standard@example.com  | file.pdf      | f                | f          | t              | null
 zktest4@example.com   | file.pdf      | t                | t          | f              | AES-256-GCM
```

**See the difference:**
- **ZK User**: Client encrypted, has ZK key, NO server key
- **Standard User**: NOT client encrypted, NO ZK key, HAS server key

**Same feature, two different encryption methods! ✅**

---

## Test 4: Network Inspection (Advanced)

Let's verify that encrypted data is actually sent to the server.

### Step 1: Open Network Tab

1. Login as **ZK user** (zktest4@example.com)
2. Open DevTools (F12)
3. Click **Network** tab
4. Clear network log (🚫 icon)

### Step 2: Upload File

1. Upload any small file
2. Watch Network tab

### Step 3: Inspect Chunk Upload

1. Find request: `chunk/[uuid]?chunk_index=0`
2. Click on it
3. Go to **"Payload"** or **"Request"** tab
4. You should see binary data (encrypted chunk)

**You CANNOT read the plaintext** because it's encrypted!

### Step 4: Compare with Standard User

1. Logout, login as **standard@example.com**
2. Repeat steps 1-3
3. Inspect chunk payload

**For standard uploads:**
- Payload is also binary (but will be encrypted ON SERVER)

The key difference is **WHEN** encryption happens:
- **ZK**: Encrypted **before** leaving browser
- **Standard**: Encrypted **after** arriving at server

---

## Test 5: File Size Verification

Verify encrypted chunks are slightly larger (GCM tag).

```bash
docker exec -it edge-postgres psql -U postgres -d edge_cloud_storage -c "
SELECT
    file_name,
    file_size as original_size,
    chunk_info->'count' as chunk_count,
    storage_type,
    is_encrypted
FROM objects
WHERE user_id = (SELECT id FROM users WHERE email = 'zktest4@example.com')
ORDER BY created_at DESC
LIMIT 1;
"
```

**Math Check:**
- Original file: X bytes
- Chunk size: 32 MB (33,554,432 bytes)
- Encrypted chunk: 33,554,448 bytes (+16 bytes per chunk)
- GCM tag overhead: 16 bytes per chunk

---

## Troubleshooting

### Problem: No ZK logs in console

**Possible causes:**
1. **ZK checkbox not checked during registration**
   - Solution: Register new account with ZK enabled

2. **ZK session locked**
   - Check: Click lock icon in header (should not be there)
   - Solution: Session should be unlocked after login

3. **Browser cache issue**
   - Solution: Hard refresh (Cmd+Shift+R or Ctrl+Shift+R)

### Problem: Upload fails with error

**Check console for error:**
- **"Session locked"** → Unlock session with password
- **"Quota exceeded"** → File too large for quota
- **"Encryption failed"** → Check zkEncryptionService is working

### Problem: Database shows is_encrypted = false

**This means:**
- Upload went through standard flow (not ZK)
- Check that you're logged in with ZK account
- Verify console shows `[Upload] ZK mode detected`

### Problem: File size is wrong

**Check:**
- `file_size` should be ORIGINAL size (before encryption)
- Encrypted chunks are stored on disk (slightly larger)
- Database `file_size` is for billing/quota (original size)

---

## Success Criteria

✅ **ZK Upload Works:**
- [ ] Console shows "ZK mode detected"
- [ ] Console shows "Encrypted chunk X"
- [ ] Database: `is_encrypted = true`
- [ ] Database: `has_encrypted_key = true`
- [ ] Database: `encryption_algorithm = AES-256-GCM`
- [ ] File appears in dashboard

✅ **Standard Upload Works:**
- [ ] Console does NOT show ZK logs
- [ ] Upload completes normally
- [ ] Database: `is_encrypted = false` (or NULL)
- [ ] Database: `has_server_key = true`
- [ ] File appears in dashboard

✅ **Backward Compatibility:**
- [ ] Both account types can upload
- [ ] Both see files in dashboard
- [ ] Database has correct metadata for each
- [ ] No errors or warnings

---

## Quick Verification Script

Run this to see all uploads at a glance:

```bash
docker exec -it edge-postgres psql -U postgres -d edge_cloud_storage -c "
SELECT
    u.email,
    u.zk_enabled,
    COUNT(o.id) as file_count,
    SUM(CASE WHEN o.is_encrypted THEN 1 ELSE 0 END) as zk_files,
    SUM(CASE WHEN o.encryption_key IS NOT NULL THEN 1 ELSE 0 END) as server_files
FROM users u
LEFT JOIN objects o ON u.id = o.user_id
WHERE u.email IN ('zktest4@example.com', 'standard@example.com')
GROUP BY u.email, u.zk_enabled;
"
```

**Expected:**
```
        email          | zk_enabled | file_count | zk_files | server_files
-----------------------+------------+------------+----------+-------------
 zktest4@example.com   | t          | 2          | 2        | 0
 standard@example.com  | f          | 1          | 0        | 1
```

- **ZK user**: Files are ZK-encrypted, NOT server-encrypted
- **Standard user**: Files are server-encrypted, NOT ZK-encrypted

---

## Next Steps After Testing

Once all tests pass:

1. **Phase 5: Download Decryption** (CRITICAL - needed next)
   - Users can upload ZK files ✅
   - But cannot download them yet ❌
   - Need to implement client-side decryption

2. **Phase 4C: UI Integration** (Optional)
   - Add "Encrypting..." progress indicator
   - Show ZK badge on encrypted files
   - Improve user feedback

3. **Production Deployment** (If satisfied)
   - Deploy to production environment
   - Set up monitoring
   - Create user documentation

---

## Getting Help

**If something doesn't work:**
1. Check browser console for errors
2. Check backend logs: `docker logs edge-storage-service`
3. Check ZK service logs: `docker logs edge-zk-service`
4. Verify database entries with SQL queries above
5. Try with a fresh account

**Common Issues:**
- Frontend not connecting to backend → Check ports (8001, 8002)
- Upload fails → Check storage quota
- No ZK encryption → Verify ZK checkbox was checked during registration

---

**Ready to test!** 🚀

Start with **Test 1** above and work through sequentially.
