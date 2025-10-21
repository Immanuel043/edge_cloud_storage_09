# Edge Cloud Storage - Architecture Diagrams

**Date**: October 21, 2025
**Version**: 1.0.0

---

## 1. System Overview

```mermaid
graph TB
    subgraph "Client Layer"
        WebApp[Web Application<br/>React/Next.js]
        MobileApp[Mobile App]
        API_Client[API Clients]
    end

    subgraph "Load Balancer & CDN"
        LB[Load Balancer<br/>NGINX/CloudFlare]
        CDN[CDN<br/>Static Assets]
    end

    subgraph "API Gateway"
        Gateway[API Gateway<br/>FastAPI]
        RateLimit[Rate Limiter<br/>Redis]
        Auth[Authentication<br/>JWT + OAuth2]
    end

    subgraph "Application Layer"
        API[Storage API<br/>FastAPI]
        ML[ML Services<br/>Python/TensorFlow]
        Workers[Background Workers<br/>Async Tasks]
    end

    subgraph "Data Layer"
        DB[(PostgreSQL<br/>Primary Database)]
        Redis[(Redis<br/>Cache & Queues)]
        ES[(Elasticsearch<br/>Full-text Search)]
    end

    subgraph "Storage Layer"
        Cache[Cache Tier<br/>Hot Data]
        Warm[Warm Tier<br/>Active Data]
        Cold[Cold Tier<br/>Archive]
    end

    subgraph "Monitoring & Observability"
        Prom[Prometheus<br/>Metrics]
        Grafana[Grafana<br/>Dashboards]
        Jaeger[Jaeger<br/>Tracing]
        Sentry[Sentry<br/>Errors]
    end

    WebApp --> LB
    MobileApp --> LB
    API_Client --> LB

    LB --> Gateway
    Gateway --> RateLimit
    Gateway --> Auth
    Gateway --> API

    API --> DB
    API --> Redis
    API --> ES
    API --> ML
    API --> Workers

    Workers --> Cache
    Workers --> Warm
    Workers --> Cold

    API --> Prom
    API --> Jaeger
    API --> Sentry
    Prom --> Grafana
```

---

## 2. Request Flow

```mermaid
sequenceDiagram
    participant Client
    participant LB as Load Balancer
    participant API as FastAPI
    participant Auth as Auth Service
    participant RateLimit as Rate Limiter
    participant Cache as Redis Cache
    participant DB as PostgreSQL
    participant Storage as File Storage

    Client->>LB: HTTP Request
    LB->>API: Forward Request

    API->>RateLimit: Check Rate Limit
    alt Rate Limit Exceeded
        RateLimit-->>Client: 429 Too Many Requests
    end

    API->>Auth: Verify JWT Token
    alt Invalid Token
        Auth-->>Client: 401 Unauthorized
    end

    API->>Cache: Check Cache
    alt Cache Hit
        Cache-->>Client: Return Cached Data
    else Cache Miss
        API->>DB: Query Database
        DB-->>API: Return Data
        API->>Cache: Store in Cache
        API-->>Client: Return Data
    end
```

---

## 3. File Upload Flow

```mermaid
flowchart TD
    Start[Client Initiates Upload] --> Init[Initialize Upload<br/>POST /upload/init]
    Init --> GetID[Receive Upload ID<br/>& Chunk Size]
    GetID --> Split[Split File into Chunks]

    Split --> UploadChunk1[Upload Chunk 1<br/>POST /upload/chunk/{id}/0]
    Split --> UploadChunk2[Upload Chunk 2<br/>POST /upload/chunk/{id}/1]
    Split --> UploadChunkN[Upload Chunk N<br/>POST /upload/chunk/{id}/N]

    UploadChunk1 --> Encrypt1[Encrypt Chunk]
    UploadChunk2 --> Encrypt2[Encrypt Chunk]
    UploadChunkN --> EncryptN[Encrypt Chunk]

    Encrypt1 --> Store1[Store in Cache Tier]
    Encrypt2 --> Store2[Store in Cache Tier]
    EncryptN --> StoreN[Store in Cache Tier]

    Store1 --> AllDone{All Chunks<br/>Uploaded?}
    Store2 --> AllDone
    StoreN --> AllDone

    AllDone -->|Yes| Complete[Complete Upload<br/>POST /upload/complete/{id}]
    AllDone -->|No| WaitMore[Wait for More Chunks]

    Complete --> CreateRecord[Create Database Record]
    CreateRecord --> Dedup[Background Deduplication]
    CreateRecord --> UpdateQuota[Update User Quota]
    CreateRecord --> Success[Return File Metadata]

    Dedup --> Tiering[Storage Tiering Worker]
    Tiering --> Analysis[ML Analysis Workers]
```

---

## 4. Storage Tiering Architecture

```mermaid
graph LR
    subgraph "Upload Flow"
        Upload[New File Upload] --> Cache[Cache Tier<br/>SSD Storage<br/>Immediate Access]
    end

    subgraph "Tiering Rules"
        Cache -->|No access<br/>for 24h| Warm[Warm Tier<br/>Standard Storage<br/>Quick Access]
        Warm -->|No access<br/>for 30d| Cold[Cold Tier<br/>Archive Storage<br/>Slow Access]
    end

    subgraph "Access Patterns"
        UserAccess[User Accesses File] -->|Promote| Cache
        UserAccess -.->|Can access| Warm
        UserAccess -.->|Restore first| Cold
    end

    subgraph "Background Workers"
        TieringWorker[Tiering Worker<br/>Runs every hour]
        TieringWorker --> CheckCache[Check Cache Files]
        TieringWorker --> CheckWarm[Check Warm Files]
        CheckCache -->|Move old files| Warm
        CheckWarm -->|Move old files| Cold
    end

    style Cache fill:#ff6b6b
    style Warm fill:#ffd93d
    style Cold fill:#6bcf7f
```

---

## 5. ML Features Architecture

```mermaid
graph TB
    subgraph "Data Collection"
        UserActivity[User Activity] --> ActivityLog[(Activity Logs)]
        FileOps[File Operations] --> FileMetrics[(File Metrics)]
        StorageUsage[Storage Usage] --> UsageHistory[(Usage History)]
    end

    subgraph "ML Processing"
        ActivityLog --> QuotaPredictor[Quota Prediction<br/>Prophet/Linear Regression]
        FileMetrics --> StorageAnalyzer[Storage Analyzer<br/>Pattern Detection]
        FileMetrics --> AutoOrganizer[Auto-Organization<br/>K-Means/DBSCAN]
        ActivityLog --> RecommendationEngine[Recommendation Engine<br/>Collaborative Filtering]
    end

    subgraph "ML Outputs"
        QuotaPredictor --> QuotaAlerts[Quota Alerts<br/>Email/Dashboard]
        StorageAnalyzer --> OptimizationSuggestions[Optimization Suggestions<br/>Actionable Items]
        AutoOrganizer --> FolderStructure[Smart Folder Structure<br/>Auto-categorization]
        RecommendationEngine --> ContentRecs[Content Recommendations<br/>Personalized]
    end

    subgraph "Background Workers"
        QuotaWorker[Quota Prediction Worker<br/>Every 4 hours]
        OptimizationWorker[Storage Optimization Worker<br/>Daily]

        QuotaWorker --> UsageHistory
        OptimizationWorker --> FileMetrics
    end

    style QuotaPredictor fill:#4ecdc4
    style StorageAnalyzer fill:#4ecdc4
    style AutoOrganizer fill:#4ecdc4
    style RecommendationEngine fill:#4ecdc4
```

---

## 6. Security Architecture

```mermaid
graph TB
    subgraph "Authentication Layer"
        JWT[JWT Tokens<br/>HS256]
        OAuth[OAuth2 Providers<br/>Google/GitHub/Microsoft]
        Session[Session Management<br/>Redis]
    end

    subgraph "Authorization Layer"
        RBAC[Role-Based Access Control]
        ResourceOwnership[Resource Ownership Check]
        RateLimit[Rate Limiting<br/>Per User/IP]
    end

    subgraph "Encryption Layer"
        InTransit[TLS/HTTPS<br/>In-Transit Encryption]
        AtRest[AES-256-GCM<br/>At-Rest Encryption]
        KeyManagement[Key Rotation<br/>DEK/KEK]
    end

    subgraph "Audit & Compliance"
        AuditLog[Audit Logging<br/>48 Event Types]
        GDPR[GDPR Compliance<br/>5 Endpoints]
        TamperDetection[Tamper Detection<br/>SHA-256 Chaining]
    end

    subgraph "Monitoring"
        SecurityAlerts[Security Alerts<br/>Real-time]
        ComplianceReports[Compliance Reports<br/>SOC 2/ISO 27001]
    end

    Request[Incoming Request] --> JWT
    JWT --> OAuth
    OAuth --> Session
    Session --> RBAC
    RBAC --> ResourceOwnership
    ResourceOwnership --> RateLimit

    RateLimit --> InTransit
    InTransit --> AtRest
    AtRest --> KeyManagement

    ResourceOwnership --> AuditLog
    AuditLog --> GDPR
    GDPR --> TamperDetection

    AuditLog --> SecurityAlerts
    GDPR --> ComplianceReports
```

---

## 7. Database Schema Overview

```mermaid
erDiagram
    USERS ||--o{ OBJECTS : owns
    USERS ||--o{ FOLDERS : owns
    USERS ||--o{ OAUTH_ACCOUNTS : has
    USERS ||--o{ QUOTA_PREDICTIONS : has
    USERS ||--o{ STORAGE_ANALYSES : has

    FOLDERS ||--o{ OBJECTS : contains
    FOLDERS ||--o{ FOLDERS : parent

    OBJECTS ||--o{ CONTENT_BLOCKS : has
    OBJECTS ||--o{ SHARE_LINKS : has
    OBJECTS ||--o{ FAVORITES : has
    OBJECTS ||--o{ FILE_VERSIONS : has

    USERS ||--o{ ACTIVITY_LOGS : generates
    USERS ||--o{ AUDIT_LOGS : generates

    STORAGE_ANALYSES ||--o{ OPTIMIZATION_SUGGESTIONS : generates
    OPTIMIZATION_SUGGESTIONS ||--o{ OPTIMIZATION_ACTIONS : applied

    USERS {
        uuid id PK
        string email
        string hashed_password
        bigint storage_quota
        bigint storage_used
        boolean is_active
        datetime created_at
    }

    OBJECTS {
        uuid id PK
        uuid user_id FK
        uuid folder_id FK
        string file_name
        bigint file_size
        string mime_type
        string storage_tier
        bytea encryption_key
        string content_hash
        datetime created_at
    }

    FOLDERS {
        uuid id PK
        uuid owner_id FK
        uuid parent_id FK
        string name
        string path
        datetime created_at
    }

    AUDIT_LOGS {
        uuid id PK
        uuid user_id FK
        string event_type
        string event_hash
        datetime timestamp
        boolean is_compliance_relevant
    }
```

---

## 8. Performance Optimization Stack

```mermaid
graph TB
    subgraph "Application Level"
        QueryOptimizer[Query Optimizer<br/>N+1 Elimination]
        EagerLoading[Eager Loading<br/>SQLAlchemy]
        BatchOps[Batch Operations]
    end

    subgraph "Caching Layer"
        L1[L1 Cache<br/>30s-5min TTL<br/>Hot Data]
        L2[L2 Cache<br/>5-30min TTL<br/>Warm Data]
        L3[L3 Cache<br/>30min-2hr TTL<br/>Cold Data]
    end

    subgraph "Database Level"
        Indexes[40+ Strategic Indexes<br/>Composite/Partial/GIN]
        ConnectionPool[Connection Pooling<br/>50 + 100 overflow]
        QueryMonitor[Query Monitoring<br/>Slow Query Detection]
    end

    subgraph "Monitoring"
        PerformanceAPI[Performance API<br/>Real-time Metrics]
        Prometheus[Prometheus<br/>Time-series DB]
        Grafana[Grafana Dashboards]
    end

    Request[API Request] --> QueryOptimizer
    QueryOptimizer --> L1
    L1 -->|Cache Miss| L2
    L2 -->|Cache Miss| L3
    L3 -->|Cache Miss| Indexes
    Indexes --> ConnectionPool

    ConnectionPool --> QueryMonitor
    QueryMonitor --> PerformanceAPI
    PerformanceAPI --> Prometheus
    Prometheus --> Grafana
```

---

## 9. Monitoring & Observability Stack

```mermaid
graph TB
    subgraph "Application Instrumentation"
        FastAPI[FastAPI App<br/>OpenTelemetry]
        CustomMetrics[Custom Metrics<br/>100+ Metrics]
        Breadcrumbs[Breadcrumbs<br/>Debug Context]
    end

    subgraph "Collection Layer"
        Prometheus[Prometheus<br/>Metrics Collection]
        Jaeger[Jaeger Agent<br/>Trace Collection]
        Sentry[Sentry<br/>Error Collection]
    end

    subgraph "Storage Layer"
        PrometheusDB[(Prometheus TSDB<br/>Time-series)]
        JaegerDB[(Jaeger Storage<br/>Traces)]
        SentryDB[(Sentry<br/>Errors & Events)]
    end

    subgraph "Visualization"
        GrafanaDash[Grafana Dashboards<br/>Main/ML/Performance]
        JaegerUI[Jaeger UI<br/>Trace Explorer]
        SentryUI[Sentry UI<br/>Error Tracking]
    end

    subgraph "Alerting"
        AlertManager[Alert Manager<br/>Prometheus Alerts]
        PagerDuty[PagerDuty<br/>On-call]
        Slack[Slack<br/>Notifications]
    end

    FastAPI --> Prometheus
    FastAPI --> Jaeger
    FastAPI --> Sentry
    CustomMetrics --> Prometheus

    Prometheus --> PrometheusDB
    Jaeger --> JaegerDB
    Sentry --> SentryDB

    PrometheusDB --> GrafanaDash
    JaegerDB --> JaegerUI
    SentryDB --> SentryUI

    PrometheusDB --> AlertManager
    AlertManager --> PagerDuty
    AlertManager --> Slack
```

---

## 10. Deployment Architecture

```mermaid
graph TB
    subgraph "Production Environment"
        subgraph "Compute"
            API1[API Server 1]
            API2[API Server 2]
            API3[API Server 3]
            Worker1[Worker 1<br/>Background Jobs]
            Worker2[Worker 2<br/>ML Processing]
        end

        subgraph "Data Services"
            PG_Primary[(PostgreSQL<br/>Primary)]
            PG_Replica[(PostgreSQL<br/>Read Replica)]
            Redis_Master[(Redis Master)]
            Redis_Replica[(Redis Replica)]
            ES_Cluster[(Elasticsearch<br/>Cluster)]
        end

        subgraph "Storage"
            S3_Cache[S3/MinIO<br/>Cache Tier]
            S3_Warm[S3/MinIO<br/>Warm Tier]
            S3_Cold[S3/Glacier<br/>Cold Tier]
        end

        subgraph "Monitoring"
            Prom[Prometheus]
            Grafana[Grafana]
            Jaeger[Jaeger]
        end
    end

    LB[Load Balancer] --> API1
    LB --> API2
    LB --> API3

    API1 --> PG_Primary
    API2 --> PG_Primary
    API3 --> PG_Replica

    API1 --> Redis_Master
    Worker1 --> Redis_Master
    Worker2 --> Redis_Replica

    Worker1 --> S3_Cache
    Worker1 --> S3_Warm
    Worker1 --> S3_Cold

    API1 --> Prom
    API2 --> Prom
    API3 --> Prom
```

---

## Architecture Principles

### 1. Scalability
- **Horizontal Scaling**: Stateless API servers behind load balancer
- **Database Scaling**: Read replicas for read-heavy operations
- **Cache Layer**: Redis for reduced database load
- **Storage Tiering**: Automatic data lifecycle management

### 2. Reliability
- **High Availability**: Multi-instance deployment
- **Data Durability**: Multi-tier backup strategy
- **Fault Tolerance**: Graceful degradation
- **Health Checks**: Automated monitoring and alerting

### 3. Security
- **Defense in Depth**: Multiple security layers
- **Encryption**: At-rest and in-transit
- **Zero Trust**: Every request verified
- **Audit Trail**: Complete compliance logging

### 4. Performance
- **Sub-50ms API responses**: Optimized queries and caching
- **85%+ cache hit rate**: Intelligent caching strategy
- **10x improvement**: Database indexes and query optimization
- **1000+ concurrent users**: Production-ready capacity

### 5. Observability
- **Metrics**: 100+ Prometheus metrics
- **Tracing**: Distributed tracing with Jaeger
- **Logging**: Structured logging with context
- **Alerting**: Proactive issue detection

---

*Architecture Documentation - Version 1.0.0*
*Last Updated: October 21, 2025*
