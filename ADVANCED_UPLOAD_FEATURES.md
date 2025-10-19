# Advanced Upload Features - Implementation Guide

## Overview

This document describes two new production-grade upload features implemented with comprehensive security controls:

1. **Upload from URL** - Server-side file downloads from URLs
2. **Folder Upload** - Recursive folder structure preservation with batch uploads

## Feature 1: Upload from URL

### Description
Allows users to provide a URL and the server downloads the file, encrypts it, and stores it in the user's storage.

### API Endpoints

#### `POST /api/v1/upload/from-url`
Initiate a URL download job.

**Request:**
```json
{
  "url": "https://example.com/file.pdf",
  "folder_id": "optional-folder-id",
  "filename": "optional-override-filename.pdf"
}
```

**Response:**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending",
  "url": "https://example.com/file.pdf",
  "message": "Download started in background..."
}
```

#### `GET /api/v1/upload/from-url/status/{job_id}`
Get status of URL upload job.

**Response:**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "downloading",
  "progress": 45,
  "total_size": 10485760,
  "downloaded_size": 4718592,
  "file_id": null,
  "filename": "file.pdf",
  "error": null,
  "created_at": "2025-01-15T10:30:00Z",
  "updated_at": "2025-01-15T10:30:45Z"
}
```

#### `GET /api/v1/upload/from-url/jobs`
List all URL upload jobs for the current user.

**Query Parameters:**
- `status` (optional): Filter by status (pending, downloading, completed, failed)
- `limit` (optional): Maximum number of jobs to return (default: 20)

#### `DELETE /api/v1/upload/from-url/{job_id}`
Cancel or delete a URL upload job.

### Security Features

#### SSRF Protection
- **Private IP Blocking**: Blocks RFC1918 private ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
- **Localhost Blocking**: Blocks 127.0.0.0/8 and ::1
- **Link-Local Blocking**: Blocks 169.254.0.0/16 (AWS metadata endpoint)
- **Cloud Metadata Protection**: Explicitly blocks metadata.google.internal, metadata, etc.
- **DNS Rebinding Protection**: Re-validates after following redirects
- **Scheme Validation**: Only http/https allowed

#### Resource Limits
- **Max File Size**: 5GB (configurable via `URL_UPLOAD_MAX_SIZE`)
- **Timeout**: 10 minutes (configurable via `URL_UPLOAD_TIMEOUT`)
- **Connection Timeout**: 30 seconds
- **Read Timeout**: 2 minutes
- **Max Redirects**: 5
- **Concurrent Uploads**: 5 per user (configurable via `URL_UPLOAD_CONCURRENT_LIMIT`)

#### Additional Security
- **URL Sanitization**: Removes embedded credentials
- **Virus Scanning**: Integrated with existing ClamAV scanner
- **Encryption**: All downloaded files encrypted with AES-256-GCM
- **Audit Logging**: All URL upload attempts logged

### Configuration

Add to `.env`:
```bash
# URL Upload Settings
URL_UPLOAD_ENABLED=true
URL_UPLOAD_MAX_SIZE=5368709120  # 5GB in bytes
URL_UPLOAD_TIMEOUT=600  # 10 minutes
URL_UPLOAD_CONCURRENT_LIMIT=5  # per user
```

### Usage Example

```python
import httpx

# Initiate URL download
response = httpx.post(
    "http://localhost:8001/api/v1/upload/from-url",
    json={
        "url": "https://files.example.com/document.pdf",
        "folder_id": "my-folder-id"
    },
    headers={"Authorization": f"Bearer {token}"}
)
job_data = response.json()
job_id = job_data["job_id"]

# Poll for status
import time
while True:
    status_response = httpx.get(
        f"http://localhost:8001/api/v1/upload/from-url/status/{job_id}",
        headers={"Authorization": f"Bearer {token}"}
    )
    status = status_response.json()

    if status["status"] == "completed":
        print(f"Download complete! File ID: {status['file_id']}")
        break
    elif status["status"] == "failed":
        print(f"Download failed: {status['error']}")
        break
    else:
        print(f"Progress: {status['progress']}%")
        time.sleep(2)
```

---

## Feature 2: Folder Upload

### Description
Allows users to upload multiple files while preserving their folder structure. The service automatically creates the necessary folder hierarchy.

### API Endpoints

#### `POST /api/v1/upload/folder/init`
Initialize a folder upload session.

**Request:**
```json
{
  "folder_name": "MyDocuments",
  "parent_id": "optional-parent-folder-id",
  "total_files": 50,
  "total_size": 104857600
}
```

**Response:**
```json
{
  "session_id": "660e8400-e29b-41d4-a716-446655440000",
  "root_folder_id": "770e8400-e29b-41d4-a716-446655440000",
  "folder_name": "MyDocuments",
  "message": "Folder upload session created. Upload 50 files."
}
```

#### `POST /api/v1/upload/folder/upload/{session_id}`
Upload a single file within the folder session.

**Form Data:**
- `relative_path`: Relative path of file (e.g., "docs/readme.txt")
- `file`: File data (multipart/form-data)

**Response:**
```json
{
  "status": "success",
  "file_id": "880e8400-e29b-41d4-a716-446655440000",
  "filename": "readme.txt",
  "file_size": 1024,
  "relative_path": "docs/readme.txt",
  "compressed": false,
  "encrypted": true
}
```

#### `POST /api/v1/upload/folder/complete`
Complete the folder upload session.

**Request:**
```json
{
  "session_id": "660e8400-e29b-41d4-a716-446655440000"
}
```

**Response:**
```json
{
  "session_id": "660e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "root_folder_id": "770e8400-e29b-41d4-a716-446655440000",
  "total_files": 50,
  "uploaded_files": 48,
  "failed_files": 2,
  "progress": 96.0,
  "errors": ["Path traversal attempt blocked", "File too large"]
}
```

#### `GET /api/v1/upload/folder/status/{session_id}`
Get status of folder upload session.

### Security Features

#### Path Traversal Protection
- **".." Blocking**: Rejects paths containing ".."
- **Absolute Path Blocking**: Rejects paths starting with "/" or "\\"
- **Windows Drive Letter Blocking**: Rejects paths with drive letters
- **Path Normalization**: Uses PurePosixPath for safe normalization
- **Null Byte Protection**: Blocks paths containing \x00

#### Resource Limits
- **Max Folder Depth**: 10 levels (configurable via `FOLDER_MAX_DEPTH`)
- **Max Files**: 1000 files per upload (configurable via `FOLDER_MAX_FILES`)
- **Max Path Length**: 255 characters
- **Max Filename Length**: 255 characters
- **Max Total Size**: 10GB per folder upload (configurable via `FOLDER_MAX_TOTAL_SIZE`)

#### Path Validation
- **Reserved Names**: Blocks Windows reserved names (CON, PRN, AUX, etc.)
- **Character Sanitization**: Removes/replaces dangerous characters
- **Duplicate Detection**: Tracks and prevents duplicate paths

### Configuration

Add to `.env`:
```bash
# Folder Upload Settings
FOLDER_UPLOAD_ENABLED=true
FOLDER_MAX_DEPTH=10
FOLDER_MAX_FILES=1000
FOLDER_MAX_TOTAL_SIZE=10737418240  # 10GB in bytes
```

### Usage Example

```python
import httpx

# Initialize folder upload
init_response = httpx.post(
    "http://localhost:8001/api/v1/upload/folder/init",
    json={
        "folder_name": "ProjectFiles",
        "total_files": 3,
        "total_size": 30720
    },
    headers={"Authorization": f"Bearer {token}"}
)
session_data = init_response.json()
session_id = session_data["session_id"]

# Upload files with their relative paths
files_to_upload = [
    ("README.md", "README.md"),
    ("src/main.py", "src/main.py"),
    ("docs/guide.txt", "docs/guide.txt")
]

for local_path, relative_path in files_to_upload:
    with open(local_path, 'rb') as f:
        response = httpx.post(
            f"http://localhost:8001/api/v1/upload/folder/upload/{session_id}",
            params={"relative_path": relative_path},
            files={"file": f},
            headers={"Authorization": f"Bearer {token}"}
        )
        print(f"Uploaded: {relative_path}")

# Complete the upload
complete_response = httpx.post(
    "http://localhost:8001/api/v1/upload/folder/complete",
    json={"session_id": session_id},
    headers={"Authorization": f"Bearer {token}"}
)
result = complete_response.json()
print(f"Upload completed: {result['uploaded_files']}/{result['total_files']} files")
```

---

## Database Migration

After implementing these features, run a database migration to create the new `url_upload_jobs` table:

```bash
# Create migration
alembic revision --autogenerate -m "Add URL upload job tracking table"

# Apply migration
alembic upgrade head
```

The migration will create:
- `url_upload_jobs` table with columns:
  - `id` (UUID, primary key)
  - `user_id` (UUID, foreign key to users)
  - `folder_id` (UUID, optional, foreign key to folders)
  - `file_id` (UUID, optional, foreign key to objects)
  - `source_url` (Text)
  - `filename` (String)
  - `mime_type` (String)
  - `status` (String: pending, downloading, completed, failed)
  - `progress` (Integer: 0-100)
  - `total_size` (BigInteger)
  - `downloaded_size` (BigInteger)
  - `error_message` (Text)
  - `retry_count` (Integer)
  - `created_at`, `started_at`, `completed_at`, `updated_at` (DateTime)

---

## Monitoring & Metrics

### Prometheus Metrics

#### URL Upload Metrics
- `storage_url_upload_initiated_total{user_type}` - Total URL uploads initiated
- `storage_url_upload_completed_total{user_type, status}` - Total completed
- `storage_url_upload_failed_total{user_type, failure_reason}` - Total failed
- `storage_url_upload_duration_seconds` - Duration histogram
- `storage_url_download_bytes_total{user_type}` - Total bytes downloaded
- `storage_url_upload_active` - Currently active URL uploads

#### Folder Upload Metrics
- `storage_folder_upload_initiated_total{user_type}` - Total folder uploads initiated
- `storage_folder_upload_completed_total{user_type, status}` - Total completed
- `storage_folder_files_uploaded_total{user_type}` - Total files uploaded
- `storage_folder_upload_active` - Currently active folder sessions

### Audit Logs

All operations are logged with detailed context:
- `url_upload_initiated` - When URL download is requested
- `url_upload.completed` - When download succeeds
- `url_upload.failed` - When download fails
- `url_upload.blocked_ssrf` - When SSRF protection blocks a URL
- `folder_upload_initiated` - When folder session starts
- `folder_upload_completed` - When folder upload finishes

---

## Security Testing

### Testing SSRF Protection

```bash
# Test 1: Private IP (should fail)
curl -X POST http://localhost:8001/api/v1/upload/from-url \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "http://192.168.1.1/file.txt"}'

# Test 2: Localhost (should fail)
curl -X POST http://localhost:8001/api/v1/upload/from-url \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "http://localhost:8080/file.txt"}'

# Test 3: AWS Metadata (should fail)
curl -X POST http://localhost:8001/api/v1/upload/from-url \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "http://169.254.169.254/latest/meta-data/"}'

# Test 4: Valid public URL (should succeed)
curl -X POST http://localhost:8001/api/v1/upload/from-url \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://httpbin.org/image/png"}'
```

### Testing Path Traversal Protection

```bash
# Test 1: Path traversal with .. (should fail)
curl -X POST "http://localhost:8001/api/v1/upload/folder/upload/$SESSION_ID?relative_path=../../../etc/passwd" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@test.txt"

# Test 2: Absolute path (should fail)
curl -X POST "http://localhost:8001/api/v1/upload/folder/upload/$SESSION_ID?relative_path=/etc/passwd" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@test.txt"

# Test 3: Windows drive letter (should fail)
curl -X POST "http://localhost:8001/api/v1/upload/folder/upload/$SESSION_ID?relative_path=C:/Windows/System32/config" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@test.txt"

# Test 4: Valid relative path (should succeed)
curl -X POST "http://localhost:8001/api/v1/upload/folder/upload/$SESSION_ID?relative_path=docs/readme.txt" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@test.txt"
```

---

## Performance Considerations

### URL Upload
- Uses streaming downloads (memory efficient)
- Processes files in 8MB chunks
- Parallel encryption using thread pool
- Background task processing (non-blocking)
- Redis-based progress tracking

### Folder Upload
- Batch processing support
- Reuses existing upload pipeline
- Automatic folder hierarchy creation
- Transaction-based (atomic operations)
- Session-based tracking (24-hour TTL)

---

## Troubleshooting

### URL Upload Issues

**Problem**: URL upload stuck in "downloading" state
- Check Redis connection
- Verify URL is accessible from server
- Check firewall/network settings
- Review logs for timeout errors

**Problem**: SSRF blocking legitimate URLs
- Add domain to whitelist in config
- Verify DNS resolution
- Check if URL redirects to private IP

### Folder Upload Issues

**Problem**: Folder structure not created correctly
- Verify paths use forward slashes (/)
- Check for path traversal attempts in logs
- Ensure parent folder exists

**Problem**: Some files failing to upload
- Check individual file error messages in status response
- Verify file sizes within limits
- Review path validation errors

---

## Future Enhancements

### URL Upload
- [ ] Support for authenticated URLs (Basic Auth, OAuth)
- [ ] Webhook notifications on completion
- [ ] Retry logic with exponential backoff
- [ ] Support for FTP/SFTP protocols
- [ ] Scheduled URL imports

### Folder Upload
- [ ] Zip file extraction
- [ ] Drag-and-drop web interface
- [ ] Resume interrupted folder uploads
- [ ] Parallel file upload support
- [ ] Folder templates

---

## Files Created/Modified

### New Files
1. `services/storage-service/app/services/url_validator.py` - URL validation & SSRF protection
2. `services/storage-service/app/services/url_upload_service.py` - URL download service
3. `services/storage-service/app/services/folder_upload_service.py` - Folder upload service
4. `services/storage-service/app/routers/url_upload.py` - URL upload API endpoints
5. `services/storage-service/app/routers/folder_upload.py` - Folder upload API endpoints

### Modified Files
1. `services/storage-service/app/models/database.py` - Added URLUploadJob model
2. `services/storage-service/app/models/schemas.py` - Added schemas for new features
3. `services/storage-service/app/config.py` - Added configuration settings
4. `services/storage-service/app/main.py` - Registered new routers
5. `services/storage-service/app/monitoring/metrics.py` - Added Prometheus metrics

---

## Support

For issues or questions:
1. Check logs in `/app/logs/`
2. Review Prometheus metrics at `/metrics`
3. Check health endpoint at `/api/v1/health`
4. Review audit logs in database

---

**Last Updated**: January 2025
**Version**: 1.0.0
**Author**: Edge Cloud Storage Team
