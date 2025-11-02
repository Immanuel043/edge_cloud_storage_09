# Phase 5: Download Decryption Implementation Plan

**Status**: Planning
**Priority**: CRITICAL - Users can upload ZK files but cannot download them
**Estimated Time**: 2-3 hours

---

## Current State

✅ **What Works:**
- Users can upload ZK-encrypted files
- Files encrypted client-side before upload
- Server stores encrypted chunks + encrypted file key
- Database has ZK metadata (encrypted_file_key, file_key_iv, etc.)

❌ **What's Missing:**
- Users cannot download ZK files (get encrypted chunks)
- No client-side decryption logic
- No UI for decryption progress
- Download fails or returns gibberish data

---

## Architecture Overview

### Download Flow Comparison

**Standard (Non-ZK) Download:**
```
User clicks download
  → Frontend requests /download/{file_id}
  → Backend streams chunks (decrypts on-the-fly)
  → Frontend receives plaintext chunks
  → Browser downloads file
```

**ZK Download (To Implement):**
```
User clicks download
  → Frontend requests /download/{file_id}
  → Backend returns ZK metadata (encrypted_file_key, IV)
  → Frontend decrypts file key with master key
  → Frontend downloads encrypted chunks
  → Frontend decrypts each chunk with file key
  → Frontend assembles plaintext chunks
  → Browser downloads plaintext file
```

---

## Implementation Breakdown

### Phase 5B: Backend Changes (Minimal)

**File**: `services/storage-service/app/routers/download.py`

**Changes Needed:**

1. **Modify download initiation endpoint** to return ZK metadata:
   ```python
   @router.get("/{file_id}")
   async def download_file(...):
       # Existing code to get file object

       # Add ZK metadata to response
       if file_obj.is_encrypted:  # ZK file
           return {
               "file_id": str(file_id),
               "file_name": file_obj.file_name,
               "file_size": file_obj.file_size,
               "mime_type": file_obj.mime_type,
               "storage_type": file_obj.storage_type,
               "zk_encrypted": True,
               "encrypted_file_key": file_obj.encrypted_file_key,  # Base64
               "file_key_iv": file_obj.file_key_iv,  # Base64
               "encryption_algorithm": file_obj.encryption_algorithm,
               "total_chunks": ...
           }
       else:  # Standard file
           # Existing flow - stream file directly or return metadata
           return existing_response
   ```

2. **Chunk download endpoint** (likely no changes needed):
   - Already returns chunks as-is
   - For ZK files, returns encrypted chunks
   - Frontend will handle decryption

**Schema Changes:**

Add to `schemas.py`:
```python
class ZKDownloadMetadata(BaseModel):
    """Metadata for ZK-encrypted file download"""
    file_id: str
    file_name: str
    file_size: int
    mime_type: Optional[str]
    storage_type: str
    zk_encrypted: bool = True
    encrypted_file_key: str  # Base64-encoded encrypted file key
    file_key_iv: str  # Base64-encoded IV used to encrypt file key
    encryption_algorithm: str
    total_chunks: int
    chunk_size: int
```

---

### Phase 5C: Frontend Decryption Service

**File**: `frontend-clean/src/services/zkEncryptionService.js`

**New Functions to Add:**

#### 1. Decrypt File Key
```javascript
/**
 * Decrypt the file encryption key using the master key
 * @param {string} encryptedFileKeyBase64 - Base64-encoded encrypted file key
 * @param {string} fileKeyIVBase64 - Base64-encoded IV
 * @param {CryptoKey} masterKey - User's master encryption key (from session)
 * @returns {Promise<CryptoKey>} - Decrypted file key (CryptoKey)
 */
export async function decryptFileKey(encryptedFileKeyBase64, fileKeyIVBase64, masterKey) {
    try {
        // Decode base64
        const encryptedFileKey = base64ToArrayBuffer(encryptedFileKeyBase64);
        const fileKeyIV = base64ToArrayBuffer(fileKeyIVBase64);

        // Decrypt the wrapped file key
        const decryptedKeyBytes = await window.crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: fileKeyIV,
            },
            masterKey,
            encryptedFileKey
        );

        // Import the decrypted key as a CryptoKey
        const fileKey = await window.crypto.subtle.importKey(
            'raw',
            decryptedKeyBytes,
            { name: 'AES-GCM' },
            false,  // not extractable
            ['decrypt']
        );

        return fileKey;
    } catch (error) {
        console.error('[ZK] Failed to decrypt file key:', error);
        throw new Error('Failed to decrypt file key. Session may be locked or corrupted.');
    }
}
```

#### 2. Decrypt File Chunk
```javascript
/**
 * Decrypt a single file chunk
 * @param {Uint8Array} encryptedChunk - Encrypted chunk bytes
 * @param {CryptoKey} fileKey - File encryption key
 * @param {number} chunkIndex - Chunk index (used as part of IV derivation)
 * @returns {Uint8Array} - Decrypted chunk bytes
 */
export function decryptFileChunk(encryptedChunk, fileKey, chunkIndex) {
    try {
        // Derive IV from chunk index (must match encryption IV)
        const iv = deriveChunkIV(chunkIndex);

        // Decrypt chunk
        const decryptedBytes = await window.crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: iv,
            },
            fileKey,
            encryptedChunk
        );

        return new Uint8Array(decryptedBytes);
    } catch (error) {
        console.error(`[ZK] Failed to decrypt chunk ${chunkIndex}:`, error);
        throw new Error(`Chunk ${chunkIndex} decryption failed. File may be corrupted.`);
    }
}
```

#### 3. Helper: Assemble Chunks into File
```javascript
/**
 * Assemble decrypted chunks into a single Blob
 * @param {Uint8Array[]} chunks - Array of decrypted chunk bytes
 * @param {string} mimeType - File MIME type
 * @returns {Blob} - Assembled file as Blob
 */
export function assembleDecryptedChunks(chunks, mimeType) {
    // Concatenate all chunks
    const totalSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const assembled = new Uint8Array(totalSize);

    let offset = 0;
    for (const chunk of chunks) {
        assembled.set(chunk, offset);
        offset += chunk.length;
    }

    return new Blob([assembled], { type: mimeType });
}
```

---

### Phase 5D: Frontend Download Integration

**File**: `frontend-clean/src/services/downloadService.js` (or equivalent)

**Current State**: Need to check existing download implementation

**Changes Needed:**

1. **Detect ZK files** in download initiation
2. **Implement ZK download flow**:
   ```javascript
   async function downloadFile(fileId, fileName) {
       // 1. Get file metadata
       const response = await fetch(`${API_URL}/api/v1/download/${fileId}`, {
           credentials: 'include'
       });

       const fileMetadata = await response.json();

       // 2. Check if ZK encrypted
       if (fileMetadata.zk_encrypted) {
           await downloadZKFile(fileMetadata);
       } else {
           await downloadStandardFile(fileMetadata);  // Existing flow
       }
   }

   async function downloadZKFile(metadata) {
       const {
           file_id,
           file_name,
           encrypted_file_key,
           file_key_iv,
           total_chunks,
           chunk_size,
           mime_type
       } = metadata;

       // 1. Check if ZK session is unlocked
       if (!zkEncryptionService.isZKSessionUnlocked()) {
           throw new Error('ZK session is locked. Please unlock to download encrypted files.');
       }

       // 2. Get master key from session
       const masterKey = zkEncryptionService.getMasterKey();

       // 3. Decrypt file key
       console.log('[Download] Decrypting file key...');
       const fileKey = await zkEncryptionService.decryptFileKey(
           encrypted_file_key,
           file_key_iv,
           masterKey
       );

       // 4. Download and decrypt chunks
       console.log(`[Download] Downloading ${total_chunks} encrypted chunks...`);
       const decryptedChunks = [];

       for (let i = 0; i < total_chunks; i++) {
           // Download chunk
           const chunkResponse = await fetch(
               `${API_URL}/api/v1/download/chunk/${file_id}?chunk_index=${i}`,
               { credentials: 'include' }
           );

           const encryptedChunk = await chunkResponse.arrayBuffer();
           console.log(`[Download] Downloaded chunk ${i}: ${encryptedChunk.byteLength} bytes`);

           // Decrypt chunk
           const decryptedChunk = await zkEncryptionService.decryptFileChunk(
               new Uint8Array(encryptedChunk),
               fileKey,
               i
           );
           console.log(`[Download] Decrypted chunk ${i}: ${decryptedChunk.length} bytes`);

           decryptedChunks.push(decryptedChunk);

           // Update progress (download + decrypt)
           const progress = ((i + 1) / total_chunks) * 100;
           onProgress?.(progress);
       }

       // 5. Assemble chunks into file
       console.log('[Download] Assembling decrypted chunks...');
       const fileBlob = zkEncryptionService.assembleDecryptedChunks(
           decryptedChunks,
           mime_type
       );

       // 6. Trigger browser download
       const url = URL.createObjectURL(fileBlob);
       const a = document.createElement('a');
       a.href = url;
       a.download = file_name;
       document.body.appendChild(a);
       a.click();
       document.body.removeChild(a);
       URL.revokeObjectURL(url);

       console.log('[Download] ZK file downloaded and decrypted successfully!');
   }
   ```

---

### Phase 5E: UI Enhancements (Optional)

**File**: `frontend-clean/src/components/dashboard/Dashboard.jsx` (or download progress component)

**Improvements:**

1. **Dual Progress Indicator**:
   ```jsx
   {isDecrypting && (
       <div className="space-y-2">
           <div className="flex justify-between text-sm">
               <span>Downloading...</span>
               <span>{downloadProgress}%</span>
           </div>
           <ProgressBar value={downloadProgress} />

           <div className="flex justify-between text-sm">
               <span>Decrypting...</span>
               <span>{decryptProgress}%</span>
           </div>
           <ProgressBar value={decryptProgress} />
       </div>
   )}
   ```

2. **ZK Badge on Encrypted Files**:
   ```jsx
   {file.is_encrypted && (
       <span className="inline-flex items-center px-2 py-1 rounded text-xs bg-green-100 text-green-800">
           <Lock className="w-3 h-3 mr-1" />
           Zero-Knowledge
       </span>
   )}
   ```

3. **Error Handling**:
   ```jsx
   {decryptError && (
       <div className="bg-red-50 border border-red-200 rounded p-3">
           <p className="text-red-800 text-sm">
               Failed to decrypt file. Your session may be locked or the file is corrupted.
           </p>
           <button onClick={handleUnlockSession}>
               Unlock Session
           </button>
       </div>
   )}
   ```

---

## Security Considerations

### Critical Security Points

1. **File Key Never Stored in Plaintext**:
   - File key decrypted on-the-fly during download
   - Kept in memory only during download
   - Cleared after download completes

2. **Master Key Protection**:
   - Master key stored in sessionStorage (memory-only)
   - Never sent to server
   - Cleared on session lock/logout

3. **Chunk Integrity**:
   - GCM mode provides authenticated encryption
   - Tampering with chunks will fail decryption
   - Each chunk has 16-byte auth tag

4. **Session Locking**:
   - If session locked, download fails gracefully
   - User prompted to unlock with password
   - No decryption possible without master key

---

## Error Handling

### Error Scenarios

1. **Session Locked**:
   - Error: "ZK session is locked. Please unlock to download encrypted files."
   - Action: Show unlock modal

2. **Decryption Failed**:
   - Error: "Failed to decrypt file. File may be corrupted or session invalid."
   - Action: Suggest re-upload or contact support

3. **Chunk Download Failed**:
   - Error: "Failed to download chunk X. Please try again."
   - Action: Retry with exponential backoff

4. **Assembly Failed**:
   - Error: "Failed to assemble file. Not enough memory."
   - Action: Suggest downloading on desktop

---

## Testing Plan

### Test Cases

**Test 1: ZK Download (Happy Path)**
1. Login as ZK user
2. Upload ZK file (Phase 4)
3. Download the file
4. Verify console shows:
   - "Decrypting file key..."
   - "Downloaded chunk 0: X bytes"
   - "Decrypted chunk 0: Y bytes"
   - "ZK file downloaded and decrypted successfully!"
5. Verify downloaded file is identical to original

**Test 2: Standard Download (Backward Compatibility)**
1. Login as standard user
2. Upload standard file
3. Download the file
4. Verify NO decryption logs
5. Verify download works as before

**Test 3: Session Locked**
1. Login as ZK user
2. Upload ZK file
3. Lock session
4. Try to download
5. Verify error: "ZK session is locked"

**Test 4: File Integrity**
1. Upload ZK file
2. Manually corrupt a chunk on server
3. Try to download
4. Verify decryption fails with integrity error

**Test 5: Large File**
1. Upload 100MB ZK file
2. Download and decrypt
3. Verify progress updates
4. Verify file integrity (checksum match)

---

## Database Verification

**Check file is ZK-encrypted:**
```sql
SELECT
    file_name,
    is_encrypted,
    encrypted_file_key IS NOT NULL as has_encrypted_key,
    file_key_iv IS NOT NULL as has_iv,
    encryption_algorithm
FROM objects
WHERE id = 'YOUR_FILE_ID';
```

**Expected for ZK file:**
```
is_encrypted = true
has_encrypted_key = true
has_iv = true
encryption_algorithm = AES-256-GCM
```

---

## Implementation Checklist

### Backend (Phase 5B)
- [ ] Add ZKDownloadMetadata schema to schemas.py
- [ ] Modify /download/{file_id} to return ZK metadata
- [ ] Test download endpoint returns correct metadata
- [ ] Verify chunk download returns encrypted chunks

### Frontend Service (Phase 5C)
- [ ] Add decryptFileKey() to zkEncryptionService.js
- [ ] Add decryptFileChunk() to zkEncryptionService.js
- [ ] Add assembleDecryptedChunks() helper
- [ ] Add deriveChunkIV() helper (must match upload)
- [ ] Test crypto functions with mock data

### Frontend Integration (Phase 5D)
- [ ] Find/create downloadService.js
- [ ] Add ZK detection in download flow
- [ ] Implement downloadZKFile() function
- [ ] Add progress tracking
- [ ] Add error handling
- [ ] Test full download flow

### UI (Phase 5E - Optional)
- [ ] Add decryption progress indicator
- [ ] Add ZK badge on encrypted files
- [ ] Add session locked error modal
- [ ] Add decryption error handling

### Testing
- [ ] Test ZK download (happy path)
- [ ] Test standard download (backward compatibility)
- [ ] Test session locked scenario
- [ ] Test file integrity
- [ ] Test large files
- [ ] Verify downloaded file matches original

---

## Success Criteria

✅ **Phase 5 Complete When:**
- [ ] ZK users can download encrypted files
- [ ] Downloaded files decrypt correctly
- [ ] File content matches original (byte-for-byte)
- [ ] Standard users unaffected (backward compatibility)
- [ ] Session lock prevents unauthorized decryption
- [ ] Console shows decryption logs
- [ ] No errors or warnings

---

## Performance Expectations

**Decryption Performance:**
- Chunk decryption: ~10-15ms per 32MB chunk
- Total overhead: <1% of download time
- 1GB file: ~30 chunks × 15ms = 450ms decryption time
- Bottleneck: Network (download), not crypto

**Memory Usage:**
- Chunks processed sequentially (32MB at a time)
- Peak memory: ~64MB (2 chunks in memory)
- Large files (>1GB) may need streaming approach

---

## Next Steps After Phase 5

Once download decryption works:

1. **Phase 6: Sharing & Access Control** (Optional)
   - How to share ZK files with other users?
   - Re-encrypt file key with recipient's public key?

2. **Phase 7: File Preview** (Optional)
   - Decrypt and preview files in-browser
   - Image thumbnails, PDF viewer, etc.

3. **Phase 8: Production Deployment**
   - Deploy to production
   - Performance monitoring
   - User documentation

---

**Ready to implement Phase 5!** 🚀

Let's start with Phase 5B (Backend) → Phase 5C (Crypto) → Phase 5D (Integration) → Phase 5E (Testing).
