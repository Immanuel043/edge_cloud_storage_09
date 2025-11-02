# API Reference: Zero-Knowledge Encryption

**Version**: 1.0
**Last Updated**: November 2, 2025
**Base URL**: `https://api.example.com`

---

## Table of Contents

1. [Authentication](#authentication)
2. [ZK Account Management](#zk-account-management)
3. [File Upload (ZK)](#file-upload-zk)
4. [File Download (ZK)](#file-download-zk)
5. [Session Management](#session-management)
6. [Error Codes](#error-codes)
7. [Rate Limiting](#rate-limiting)
8. [Examples](#examples)

---

## Authentication

All API endpoints require authentication via session cookies.

### Login

```http
POST /api/v1/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "secure_password"
}

Response 200:
{
  "token": "session_token",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "zk_enabled": true
  },
  "zk_data": {
    "encrypted_master_key": "base64...",
    "master_key_iv": "base64...",
    "zk_salt": "base64..."
  }
}
```

### Logout

```http
POST /api/v1/auth/logout

Response 200:
{
  "message": "Logged out successfully"
}
```

---

## ZK Account Management

### Register ZK Account

```http
POST /api/v1/zk/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "secure_password",
  "encrypted_master_key": "base64_encoded_encrypted_key",
  "master_key_iv": "base64_encoded_iv",
  "zk_salt": "base64_encoded_salt",
  "recovery_phrase_hash": "sha256_hash_of_phrase"
}

Response 201:
{
  "user_id": "uuid",
  "email": "user@example.com",
  "zk_enabled": true,
  "created_at": "2025-11-02T10:00:00Z"
}
```

**Field Descriptions:**

| Field | Type | Description |
|-------|------|-------------|
| `email` | string | User email address |
| `password` | string | User password (hashed server-side) |
| `encrypted_master_key` | string | Master key encrypted with password-derived key (base64) |
| `master_key_iv` | string | IV used for master key encryption (base64) |
| `zk_salt` | string | Salt for PBKDF2 key derivation (base64) |
| `recovery_phrase_hash` | string | SHA-256 hash of recovery phrase for validation |

### Validate Recovery Phrase

```http
POST /api/v1/zk/validate-recovery
Content-Type: application/json

{
  "email": "user@example.com",
  "recovery_phrase_hash": "sha256_hash"
}

Response 200:
{
  "valid": true,
  "encrypted_master_key": "base64...",
  "master_key_iv": "base64...",
  "zk_salt": "base64..."
}

Response 401 (Invalid):
{
  "valid": false,
  "error": "Invalid recovery phrase"
}
```

### Get ZK Session Info

```http
GET /api/v1/zk/session

Response 200:
{
  "session_active": true,
  "unlocked_at": "2025-11-02T10:00:00Z",
  "expires_at": "2025-11-02T10:30:00Z"
}
```

---

## File Upload (ZK)

### Initialize ZK Upload

```http
POST /api/v1/upload/init/zk
Content-Type: application/json
Cookie: session_token=...

{
  "file_name": "document.pdf",
  "file_size": 5242880,
  "encrypted_file_key": "base64_encoded_encrypted_file_key",
  "file_key_iv": "base64_encoded_file_key_iv",
  "encryption_algorithm": "AES-256-GCM",
  "mime_type": "application/pdf",
  "folder_id": "uuid_or_null"
}

Response 200:
{
  "upload_id": "uuid",
  "chunk_size": 33554432,
  "total_chunks": 1,
  "expires_at": "2025-11-02T11:00:00Z"
}
```

**Field Descriptions:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file_name` | string | Yes | Original file name |
| `file_size` | integer | Yes | File size in bytes |
| `encrypted_file_key` | string | Yes | File encryption key encrypted with master key (base64) |
| `file_key_iv` | string | Yes | IV used for file key encryption (base64) |
| `encryption_algorithm` | string | Yes | Always "AES-256-GCM" |
| `mime_type` | string | No | MIME type of file |
| `folder_id` | string | No | Parent folder UUID or null for root |

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `upload_id` | string | Unique upload session ID |
| `chunk_size` | integer | Server's preferred chunk size (32MB) |
| `total_chunks` | integer | Calculated number of chunks |
| `expires_at` | string | Upload session expiration (1 hour) |

### Upload Encrypted Chunk

```http
POST /api/v1/upload/chunk/{upload_id}?chunk_index={index}
Content-Type: multipart/form-data
Cookie: session_token=...

FormData: {
  chunk: <Blob of encrypted data>
}

Response 200:
{
  "chunk_index": 0,
  "received_size": 5242880,
  "status": "success",
  "uploaded_chunks": 1,
  "total_chunks": 1
}
```

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `chunk_index` | integer | Yes | Zero-based chunk index |

**Notes:**
- Chunks must be uploaded in order (0, 1, 2, ...)
- Each chunk must be ≤33554432 bytes (32MB)
- Server does NOT decrypt chunks (ZK mode)

### Complete ZK Upload

```http
POST /api/v1/upload/complete/{upload_id}
Content-Type: application/json
Cookie: session_token=...

{}

Response 200:
{
  "file_id": "uuid",
  "file_name": "document.pdf",
  "file_size": 5242880,
  "is_encrypted": true,
  "encryption_algorithm": "AES-256-GCM",
  "created_at": "2025-11-02T10:05:00Z"
}
```

---

## File Download (ZK)

### Get File Metadata

```http
GET /api/v1/files/{file_id}
Cookie: session_token=...

Response 200:
{
  "id": "uuid",
  "name": "document.pdf",
  "size": 5242880,
  "mime_type": "application/pdf",
  "is_encrypted": true,
  "encrypted_file_key": "base64...",
  "file_key_iv": "base64...",
  "encryption_algorithm": "AES-256-GCM",
  "chunk_size": 33554432,
  "total_chunks": 1,
  "created_at": "2025-11-02T10:05:00Z"
}
```

**ZK-Specific Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `is_encrypted` | boolean | True if file is ZK-encrypted |
| `encrypted_file_key` | string | Encrypted file key (decrypt with master key) |
| `file_key_iv` | string | IV for file key encryption |
| `encryption_algorithm` | string | "AES-256-GCM" |

### Download Encrypted Chunk

```http
GET /api/v1/files/{file_id}/download/chunk/{chunk_index}
Cookie: session_token=...

Response 200:
Content-Type: application/octet-stream
Content-Length: 5242880
Body: <Encrypted chunk bytes (IV + ciphertext + tag)>
```

**Chunk Format:**
```
┌────────────┬──────────────────┬─────────┐
│ IV (12B)   │ Ciphertext (N)   │ Tag(16B)│
└────────────┴──────────────────┴─────────┘
```

**Notes:**
- Server returns encrypted chunk as-is
- Client must decrypt using file key
- IV is prepended to chunk data
- GCM tag is appended to chunk data

### Download Full File (Encrypted)

```http
GET /api/v1/files/{file_id}/download
Cookie: session_token=...

Response 200:
Content-Type: application/octet-stream
Content-Disposition: attachment; filename="document.pdf"
Body: <Encrypted file data>
```

**Note**: This endpoint returns the entire encrypted file. Not recommended for files >50MB. Use chunk-based download instead.

---

## Session Management

### Lock Session

```http
POST /api/v1/zk/session/lock
Cookie: session_token=...

Response 200:
{
  "session_locked": true,
  "locked_at": "2025-11-02T10:15:00Z"
}
```

**Effect**: Clears master key from server session (if stored). Client must also clear master key from memory.

### Unlock Session

```http
POST /api/v1/zk/session/unlock
Content-Type: application/json
Cookie: session_token=...

{
  "password": "user_password"
}

Response 200:
{
  "session_unlocked": true,
  "unlocked_at": "2025-11-02T10:20:00Z",
  "expires_at": "2025-11-02T10:50:00Z",
  "zk_data": {
    "encrypted_master_key": "base64...",
    "master_key_iv": "base64...",
    "zk_salt": "base64..."
  }
}

Response 401 (Wrong Password):
{
  "error": "Invalid password",
  "session_unlocked": false
}
```

---

## Error Codes

### HTTP Status Codes

| Code | Meaning | Description |
|------|---------|-------------|
| 200 | Success | Request succeeded |
| 201 | Created | Resource created successfully |
| 400 | Bad Request | Invalid request parameters |
| 401 | Unauthorized | Authentication required or failed |
| 403 | Forbidden | Insufficient permissions |
| 404 | Not Found | Resource not found |
| 409 | Conflict | Resource already exists |
| 413 | Payload Too Large | File/chunk exceeds size limit |
| 429 | Too Many Requests | Rate limit exceeded |
| 500 | Internal Server Error | Server-side error |

### ZK-Specific Error Codes

```json
{
  "error": {
    "code": "ZK_SESSION_LOCKED",
    "message": "ZK session is locked. Please unlock to continue.",
    "details": {
      "locked_at": "2025-11-02T10:15:00Z"
    }
  }
}
```

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `ZK_SESSION_LOCKED` | 403 | Session locked, unlock required |
| `ZK_INVALID_FILE_KEY` | 400 | Invalid encrypted file key format |
| `ZK_DECRYPTION_FAILED` | 500 | Server failed to decrypt master key |
| `ZK_RECOVERY_INVALID` | 401 | Invalid recovery phrase |
| `ZK_NOT_ENABLED` | 403 | ZK encryption not enabled for account |
| `ZK_CHUNK_CORRUPTED` | 400 | Uploaded chunk failed validation |
| `ZK_UPLOAD_EXPIRED` | 410 | Upload session expired |

---

## Rate Limiting

### Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| `/api/v1/upload/init/zk` | 100 | 1 hour |
| `/api/v1/upload/chunk/*` | 1000 | 1 hour |
| `/api/v1/files/*/download/chunk/*` | 1000 | 1 hour |
| `/api/v1/zk/session/unlock` | 10 | 15 min |

### Rate Limit Headers

```http
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1698825600
```

### Rate Limit Exceeded Response

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 3600

{
  "error": "Rate limit exceeded",
  "retry_after": 3600,
  "limit": 100,
  "window": "1 hour"
}
```

---

## Examples

### Complete Upload Flow

```javascript
// 1. Login
const loginRes = await fetch('/api/v1/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ email, password })
});
const { zk_data } = await loginRes.json();

// 2. Decrypt master key (client-side)
const masterKey = decryptMasterKey(
  zk_data.encrypted_master_key,
  password,
  zk_data.zk_salt,
  zk_data.master_key_iv
);

// 3. Generate file key (client-side)
const fileKey = crypto.getRandomValues(new Uint8Array(32));

// 4. Encrypt file key with master key (client-side)
const { encryptedFileKey, iv } = encryptFileKey(fileKey, masterKey);

// 5. Initialize upload
const initRes = await fetch('/api/v1/upload/init/zk', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    file_name: 'document.pdf',
    file_size: file.size,
    encrypted_file_key: encryptedFileKey,
    file_key_iv: iv,
    encryption_algorithm: 'AES-256-GCM',
    mime_type: file.type
  })
});
const { upload_id, chunk_size, total_chunks } = await initRes.json();

// 6. Upload chunks
for (let i = 0; i < total_chunks; i++) {
  const start = i * chunk_size;
  const end = Math.min(start + chunk_size, file.size);
  const chunkData = file.slice(start, end);

  // Encrypt chunk (client-side)
  const encryptedChunk = encryptChunk(
    await chunkData.arrayBuffer(),
    fileKey,
    i
  );

  // Upload encrypted chunk
  const formData = new FormData();
  formData.append('chunk', new Blob([encryptedChunk]));

  await fetch(`/api/v1/upload/chunk/${upload_id}?chunk_index=${i}`, {
    method: 'POST',
    credentials: 'include',
    body: formData
  });
}

// 7. Complete upload
const completeRes = await fetch(`/api/v1/upload/complete/${upload_id}`, {
  method: 'POST',
  credentials: 'include'
});
const { file_id } = await completeRes.json();

console.log('File uploaded:', file_id);
```

### Complete Download Flow

```javascript
// 1. Get file metadata
const metaRes = await fetch(`/api/v1/files/${file_id}`, {
  credentials: 'include'
});
const metadata = await metaRes.json();

// 2. Decrypt file key (client-side)
const fileKey = decryptFileKey(
  metadata.encrypted_file_key,
  masterKey,
  metadata.file_key_iv
);

// 3. Download and decrypt chunks
const decryptedChunks = [];

for (let i = 0; i < metadata.total_chunks; i++) {
  // Download encrypted chunk
  const chunkRes = await fetch(
    `/api/v1/files/${file_id}/download/chunk/${i}`,
    { credentials: 'include' }
  );
  const encryptedChunk = await chunkRes.arrayBuffer();

  // Decrypt chunk (client-side)
  const decryptedChunk = decryptChunk(
    new Uint8Array(encryptedChunk),
    fileKey,
    i
  );

  decryptedChunks.push(decryptedChunk);
}

// 4. Assemble file
const blob = new Blob(decryptedChunks, { type: metadata.mime_type });

// 5. Trigger download
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = metadata.name;
a.click();
```

---

## Versioning

This API uses URL-based versioning:

```
https://api.example.com/api/v1/...
```

**Current Version**: v1
**Deprecated Versions**: None
**Sunset Policy**: 12 months notice before version retirement

---

## Support

For API issues:

- **Email**: api-support@example.com
- **Status**: https://status.example.com/api
- **Changelog**: https://api.example.com/changelog

---

**Last Updated**: November 2, 2025
**Version**: 1.0.0
