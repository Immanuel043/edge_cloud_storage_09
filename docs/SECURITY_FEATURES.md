# Security Features - Phase 1

## Overview

Your Edge Cloud Storage now includes enterprise-grade **Phase 1 security features** for production deployment:

- ✅ **ClamAV Virus Scanning** - Real-time malware detection on file uploads
- ✅ **DLP (Data Loss Prevention)** - Detects sensitive data (SSN, credit cards, API keys)
- ✅ **Comprehensive Audit Logging** - Track all user actions for compliance

---

## 1. ClamAV Virus Scanning

### What It Does
Automatically scans all uploaded files for viruses and malware using ClamAV, the industry-standard open-source antivirus engine.

### Features
- **Real-time Scanning**: Files scanned automatically on upload
- **1M+ Signatures**: Detects over 1 million malware signatures
- **Background Processing**: Doesn't block uploads
- **Daily Updates**: Virus definitions updated automatically
- **100% Free**: No licensing costs (GPL v2)

### How It Works
1. User uploads a file
2. File is saved and encrypted
3. **Background virus scan** runs automatically
4. Scan result logged to `virus_scan_logs` table
5. If virus detected:
   - File flagged as infected
   - Audit log created with risk level "critical"
   - Admin notified (can be extended)

### API Endpoints

#### Check Scanner Status
```bash
GET /api/v1/security/scanner/status
```

**Response:**
```json
{
  "available": true,
  "version": "ClamAV 1.0.3",
  "engine": "ClamAV"
}
```

#### Manually Scan a File
```bash
POST /api/v1/security/scan/file/{file_id}
```

**Response:**
```json
{
  "file_id": "123e4567-e89b-12d3-a456-426614174000",
  "scan_result": {
    "is_infected": false,
    "virus_name": null,
    "scan_time": 0.234,
    "scanned_at": "2025-10-05T16:00:00Z"
  },
  "action_taken": "allowed"
}
```

### Configuration
**Environment Variables:**
```bash
CLAMAV_HOST=clamav
CLAMAV_PORT=3310
```

**Docker Compose:**
```yaml
clamav:
  image: clamav/clamav:latest
  platform: linux/amd64
  ports:
    - "3310:3310"
  volumes:
    - clamav_data:/var/lib/clamav
```

---

## 2. DLP (Data Loss Prevention)

### What It Does
Scans uploaded files for sensitive data to prevent accidental exposure of:
- Social Security Numbers (SSN)
- Credit Card Numbers (Visa, MasterCard, Amex, Discover)
- API Keys & Secrets
- AWS Access/Secret Keys
- GitHub/GitLab Tokens
- Private Keys (RSA, DSA, EC, OpenSSH)
- Email Addresses
- Phone Numbers

### Features
- **Pattern Matching**: Uses regex for sensitive data detection
- **Luhn Validation**: Credit cards validated with Luhn algorithm
- **Risk Scoring**: 0-100 risk score based on matches
- **Automatic Blocking**: High-risk files (>80 score) flagged
- **Redacted Logging**: Sensitive values redacted in logs

### How It Works
1. File uploaded
2. DLP scans text-based files (PDF, TXT, JSON, XML, DOCX, etc.)
3. Detects sensitive patterns
4. Calculates risk score:
   - **Critical** (SSN, CC, AWS keys): 40 points each
   - **High** (API keys, tokens): 25 points each
   - **Medium** (emails, phone): 15 points each
5. If risk > 80: File flagged and blocked
6. Results logged to `dlp_scan_logs`

### API Endpoints

#### Scan File for Sensitive Data
```bash
POST /api/v1/security/dlp/scan/{file_id}
```

**Response:**
```json
{
  "file_id": "123e4567-e89b-12d3-a456-426614174000",
  "dlp_result": {
    "has_sensitive_data": true,
    "risk_score": 85.0,
    "total_matches": 3,
    "blocked": true,
    "matches": [
      {
        "type": "SSN",
        "value": "***-**-6789",
        "line_number": 12,
        "confidence": 0.9,
        "risk_level": "critical"
      },
      {
        "type": "CREDIT_CARD",
        "value": "****-****-****-9010",
        "line_number": 15,
        "confidence": 0.95,
        "risk_level": "critical"
      }
    ]
  }
}
```

### Detected Patterns

| Type | Pattern Example | Risk Level |
|------|----------------|------------|
| SSN | 123-45-6789 | Critical |
| Credit Card | 4532-1234-5678-9010 | Critical |
| AWS Access Key | AKIA1234567890ABCDEF | Critical |
| AWS Secret Key | aws_secret_access_key=... | Critical |
| GitHub Token | ghp_... | High |
| API Key | api_key=sk_live_... | High |
| Private Key | -----BEGIN RSA PRIVATE KEY----- | Critical |
| Email | user@example.com | Low |
| Phone | 123-456-7890 | Low |

---

## 3. Comprehensive Audit Logging

### What It Does
Logs all user actions for security monitoring, compliance, and forensic analysis.

### Features
- **All Actions Tracked**: Login, file operations, security scans
- **Request Context**: IP address, user agent, HTTP method
- **Risk Flagging**: Suspicious activity automatically flagged
- **Queryable**: Filter by user, action, risk level, date range
- **Tamper-Evident**: Append-only log table

### Logged Actions
- `user.login` / `user.logout`
- `file.upload` / `file.download` / `file.delete`
- `security.virus_scan` / `security.virus_detected`
- `security.dlp_scan` / `security.sensitive_data_detected`
- `file.share` / `file.version_restore`

### Database Schema

#### audit_logs Table
```sql
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50),
    resource_id UUID,
    resource_name VARCHAR(500),
    ip_address VARCHAR(45),
    user_agent TEXT,
    request_method VARCHAR(10),
    request_path VARCHAR(500),
    status VARCHAR(20) NOT NULL,
    status_code INTEGER,
    error_message TEXT,
    context_data TEXT,  -- JSON
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    is_suspicious BOOLEAN DEFAULT FALSE,
    risk_level VARCHAR(20) DEFAULT 'low'
);
```

#### virus_scan_logs Table
```sql
CREATE TABLE virus_scan_logs (
    id UUID PRIMARY KEY,
    file_id UUID REFERENCES objects(id),
    user_id UUID REFERENCES users(id),
    is_infected BOOLEAN NOT NULL,
    virus_name VARCHAR(255),
    scan_engine VARCHAR(50) DEFAULT 'clamav',
    scan_time FLOAT,
    scanned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    file_size BIGINT,
    file_hash VARCHAR(64),
    error_message TEXT,
    action_taken VARCHAR(50) DEFAULT 'allowed'
);
```

#### dlp_scan_logs Table
```sql
CREATE TABLE dlp_scan_logs (
    id UUID PRIMARY KEY,
    file_id UUID REFERENCES objects(id),
    user_id UUID REFERENCES users(id),
    has_sensitive_data BOOLEAN NOT NULL,
    risk_score FLOAT,
    total_matches INTEGER,
    scan_time FLOAT,
    detected_types TEXT,  -- JSON array
    scanned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    file_size BIGINT,
    action_taken VARCHAR(50) DEFAULT 'allowed',
    blocked BOOLEAN DEFAULT FALSE
);
```

### API Endpoints

#### Get My Audit Logs
```bash
GET /api/v1/security/audit/me?limit=100&action=file.upload
```

#### Get Suspicious Activity (Admin)
```bash
GET /api/v1/security/audit/suspicious?risk_level=critical
```

#### Get Infected Files (Admin)
```bash
GET /api/v1/security/audit/infected-files
```

#### Get High-Risk Files (Admin)
```bash
GET /api/v1/security/audit/high-risk-files?min_risk_score=70
```

#### Security Dashboard
```bash
GET /api/v1/security/dashboard
```

**Response:**
```json
{
  "user_id": "123e4567-e89b-12d3-a456-426614174000",
  "security_stats": {
    "virus_scans": {
      "total": 150,
      "infected": 2,
      "clean": 148
    },
    "dlp_scans": {
      "total": 145,
      "high_risk": 5,
      "clean": 140
    },
    "suspicious_activity_7d": 0
  },
  "scanner_status": {
    "clamav_available": true
  }
}
```

---

## Upload Flow with Security

### Automatic Security Scanning

When a user uploads a file:

```
1. File Upload
   ↓
2. Save & Encrypt File
   ↓
3. Return Upload Success
   ↓
4. Background Security Scans (async):
   ├── Virus Scan (ClamAV)
   │   ├── If infected: Flag + Log
   │   └── If clean: Log
   │
   └── DLP Scan (text files only)
       ├── Extract sensitive data
       ├── Calculate risk score
       ├── If high risk: Flag + Log
       └── If clean: Log
   ↓
5. Index in Elasticsearch
```

**Key Points:**
- Security scans **don't block** upload response
- Scans run in background tasks
- Results stored in database
- Suspicious files automatically flagged

---

## Production Deployment

### Starting Services

**Development (No Persistence):**
```bash
cd infrastructure
./start-dev.sh
```

**Production (With Persistence):**
```bash
cd infrastructure
./start-prod.sh
```

### Resource Requirements

| Service | Memory | CPU | Storage |
|---------|--------|-----|---------|
| ClamAV | 2GB | 1 core | 2GB (virus DB) |
| Storage Service | 8GB | 4 cores | Variable |
| PostgreSQL | 1GB | 2 cores | Variable |
| Redis | 2.5GB | 1 core | 1GB |
| Elasticsearch | 1GB | 1 core | Variable |

### Health Checks

**Check All Services:**
```bash
curl http://localhost:8001/api/v1/health
```

**Check ClamAV:**
```bash
curl http://localhost:8001/api/v1/security/scanner/status
```

---

## Compliance & Standards

### GDPR Compliance
- ✅ Audit logs track all data access
- ✅ DLP prevents accidental PII exposure
- ✅ User actions fully traceable

### SOC 2 Compliance
- ✅ Comprehensive logging
- ✅ Malware protection
- ✅ Access controls
- ✅ Incident detection

### HIPAA Compliance
- ✅ Audit trails for PHI access
- ✅ Encryption at rest and in transit
- ✅ DLP for sensitive health data

---

---

## 4. ZK Mode and localStorage Security

### Overview

The Zero-Knowledge (ZK) encryption mode uses `zkEnabled` in localStorage as a **client-side routing hint** to direct API calls to either the Normal storage service or the ZK encryption service. This design is secure: the backend never trusts localStorage for authorization.

### Security Model

**Two conditions must be true for ZK mode to be active:**
1. `zkEnabled` from localStorage (routing hint)
2. `zkSessionUnlocked` from in-memory session (requires successful ZK login and password unlock)

Without both, the app routes to the Normal service. A normal user who manually sets `zkEnabled` to `true` in localStorage does not gain ZK access because:
- `zkSessionUnlocked` remains false (no ZK master key in memory)
- ZK service endpoints return 401 without valid ZK session cookies

### Backend Trust Boundary

- **Normal service** and **ZK service** use separate HTTP-only session cookies
- Each service validates its own cookies; localStorage is never consulted by the backend
- ZK login requires ZK credentials and creates ZK-specific cookies
- A normal user's cookies do not work with ZK endpoints

### Bootstrap Verification

On app load, `bootstrapVerification.ts` checks which service has an active session and corrects localStorage if there is a mismatch (e.g., user cleared localStorage but still has session cookies). This recovers from storage corruption without weakening security.

### Manual localStorage Tampering

| Scenario | Result |
|----------|--------|
| Normal user sets `zkEnabled` to `true` | UI may switch to ZK flow, but ZK API calls fail with 401; no ZK data accessible |
| Bootstrap verification runs | May reset `zkEnabled` based on actual session |
| ZK user sets `zkEnabled` to `false` | UI routes to Normal service; ZK cookies are not sent, so no unintended access |

**Conclusion:** Manually changing `zkEnabled` in localStorage does not grant ZK access, expose other users' data, or bypass encryption. localStorage is a client routing hint only; the server relies on session cookies and validates every request.

---

## Future Enhancements (Phase 2)

### Planned Features:
1. **Zero-Knowledge Encryption** - Client-side encryption keys (implemented)
2. **Ransomware Protection** - Immutable backups + snapshots
3. **Blockchain Audit Logs** - Tamper-proof logging
4. **ML-based Anomaly Detection** - Behavioral analytics
5. **VirusTotal Integration** - Multi-engine scanning (premium)

---

## Support

For issues or questions:
- Check logs: `docker logs edge-storage-service`
- ClamAV logs: `docker logs edge-clamav`
- API Documentation: `http://localhost:8001/docs`

---

**Built with:**
- ClamAV (Antivirus)
- Python/FastAPI (Backend)
- PostgreSQL (Database)
- Docker (Deployment)
