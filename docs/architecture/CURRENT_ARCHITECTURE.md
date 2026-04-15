# Current Architecture

This repo is a multi-service architecture with one large core backend, `storage-service`, not a single-process monolith. This current-state snapshot is derived from `infrastructure/docker-compose.yml`, `infrastructure/nginx/nginx.conf`, the service entrypoints in `services/storage-service/app/main.py` and `services/zk-encryption-service/app/main.py`, the Node runtime in `services/web-service/src/app.ts`, and the frontend API wiring in `frontend-clean/src/services`.

If your Markdown viewer does not render Mermaid, open `docs/architecture/CURRENT_ARCHITECTURE.html` in a browser.

**Last updated:** 2026-04-15 — reflects the 2026-04 architecture review (all 13 P0 items + multi-replica #14). See `## 4. Scaling & Reliability (2026-04)` for what changed.

## 1. Runtime Topology

```mermaid
flowchart TD
    subgraph Edge_CDN["Edge / CDN"]
        browser["Browser / Frontend Client"]
        cdn["Cloudflare CDN<br/>(optional, previews + static)"]
    end

    subgraph Load_Balancer["Load Balancer"]
        nginx["nginx<br/>fastapi_upstream: round-robin<br/>ws_upstream: ip_hash"]
    end

    subgraph Core_Application_Services["Core application services"]
        web_service["web-service"]
        storage_service_1["storage-service #1<br/>(WORKER_MODE=api)"]
        storage_service_2["storage-service #2<br/>(WORKER_MODE=api)"]
        zk_service["zk-encryption-service"]
        rust_dataplane["rust-dataplane"]
    end

    subgraph Background_Workers["Background workers"]
        storage_worker["storage-worker<br/>(quota / optimization /<br/>orphan / video timers)"]
        billing_scheduler["billing-scheduler"]
        zk_billing_scheduler["zk-billing-scheduler"]
        chunk_processor["chunk-processor"]
        preview_processor["preview-processor"]
        es_indexer["es-indexer"]
        embedding_processor["embedding-processor"]
        file_analysis_processor["file-analysis-processor"]
    end

    subgraph Data_And_Infrastructure["Data and infrastructure"]
        pgbouncer["pgbouncer<br/>(transaction pool)"]
        postgres[(postgres<br/>primary, WAL archive on)]
        postgres_replica[(postgres-replica<br/>profile: replica)]
        postgres_wal[("postgres_wal_archive<br/>volume")]
        zk_postgres[(zk-postgres)]
        redis[(redis<br/>DB0 session / DB1 cache /<br/>DB2 ratelimit / DB3 pubsub)]
        kafka[(kafka<br/>topic + DLQ topics)]
        zookeeper[(zookeeper)]
        elasticsearch[(elasticsearch)]
        clickhouse[(clickhouse)]
        clamav["clamav"]
        storage_data[("storage_data<br/>cache / warm")]
        cold_storage_data[("cold_storage_data<br/>cold tier")]
    end

    browser -->|static, previews| cdn
    cdn --> nginx
    browser -->|API / WebSocket| nginx

    nginx --> web_service
    nginx --> storage_service_1
    nginx --> storage_service_2

    web_service --> storage_service_1
    web_service --> zk_service

    storage_service_1 --> pgbouncer
    storage_service_2 --> pgbouncer
    pgbouncer --> postgres
    postgres -.->|WAL stream| postgres_replica
    postgres -.->|archive_command| postgres_wal

    storage_service_1 --> redis
    storage_service_1 --> kafka
    storage_service_1 --> elasticsearch
    storage_service_1 --> rust_dataplane
    storage_service_1 --> clamav
    storage_service_1 --> storage_data
    storage_service_1 --> cold_storage_data
    storage_service_2 --> redis
    storage_service_2 --> kafka
    storage_service_2 --> elasticsearch
    storage_service_2 --> rust_dataplane
    storage_service_2 --> clamav
    storage_service_2 --> storage_data
    storage_service_2 --> cold_storage_data

    storage_worker --> pgbouncer
    storage_worker --> redis
    storage_worker --> kafka
    storage_worker --> storage_data
    storage_worker --> cold_storage_data

    zk_service --> zk_postgres
    zk_service --> redis
    zk_service --> storage_data

    rust_dataplane --> storage_data
    kafka --> zookeeper

    chunk_processor --> kafka
    preview_processor --> kafka
    es_indexer --> kafka
    embedding_processor --> kafka
    file_analysis_processor --> kafka

    preview_processor --> storage_data
    preview_processor --> cold_storage_data
    embedding_processor --> storage_data
    file_analysis_processor --> storage_data

    billing_scheduler -.->|Same stack| storage_service_1
    zk_billing_scheduler -.->|Same stack| zk_service
```

## 2. Service Interactions

```mermaid
flowchart LR
    browser["Browser / Frontend Client"]
    cdn["Cloudflare CDN"]
    nginx["nginx (reverse proxy, split upstreams)"]
    web_service["web-service"]
    storage_service["storage-service<br/>(N replicas)"]
    storage_worker["storage-worker<br/>(scale=1)"]
    zk_service["zk-encryption-service"]
    redis[(redis)]
    pgbouncer["pgbouncer"]
    postgres[(postgres primary)]
    postgres_replica[(postgres-replica)]
    zk_postgres[(zk-postgres)]
    kafka[(kafka)]
    elasticsearch[(elasticsearch)]
    rust_dataplane["rust-dataplane"]
    chunk_processor["chunk-processor"]
    preview_processor["preview-processor"]
    es_indexer["es-indexer"]
    embedding_processor["embedding-processor"]
    file_analysis_processor["file-analysis-processor"]

    browser -->|cacheable reads| cdn
    cdn -->|origin pulls| nginx
    browser -->|API / WebSocket| nginx

    nginx -->|HTTP/REST round-robin| web_service
    nginx -->|HTTP/REST round-robin<br/>fastapi_upstream| storage_service
    nginx -->|WebSocket ip_hash<br/>ws_upstream| storage_service
    nginx -.->|ZK routes, optional| zk_service

    web_service -->|HTTP/REST| storage_service
    web_service -->|HTTP/REST| zk_service

    storage_service -->|Internal API| zk_service
    zk_service -->|Internal API| storage_service

    storage_service -->|writes| pgbouncer
    storage_service -.->|reads via READ_DATABASE_URL,<br/>when set| pgbouncer
    pgbouncer --> postgres
    postgres -.->|async streaming| postgres_replica
    storage_service -->|pub/sub, cache, ratelimit| redis
    storage_service -->|events + DLQ| kafka
    storage_service -->|search / indexing| elasticsearch
    storage_service -->|UDS| rust_dataplane

    storage_worker -->|consumers + timers| kafka
    storage_worker --> pgbouncer
    storage_worker --> redis

    zk_service --> redis
    zk_service --> zk_postgres

    kafka -->|Kafka events| chunk_processor
    kafka -->|Kafka events| preview_processor
    kafka -->|Kafka events| es_indexer
    kafka -->|Kafka events| embedding_processor
    kafka -->|Kafka events| file_analysis_processor
```

## 3. Key Service Internals

```mermaid
flowchart TB
    subgraph Storage_Service["storage-service (WORKER_MODE=api)"]
        st_auth["Auth / Sessions"]
        st_files["Files / Uploads / Downloads"]
        st_sharing["Sharing / Share Bundles"]
        st_billing["Billing / Subscription UI"]
        st_plan_gate["Plan-feature gate<br/>(require_plan_feature)"]
        st_ws["WebSocket / Realtime<br/>(REPLICA_ID logged)"]
        st_internal["Internal API"]
        st_search["Search<br/>(semantic soft-degrade for free tier)"]
        st_jobs["Kafka producers"]
        st_redis["Redis (split DBs)"]
        st_postgres["Postgres via PgBouncer"]
        st_kafka["Kafka (topic + DLQ)"]
        st_rust["Rust dataplane (UDS)"]
    end

    subgraph Storage_Worker["storage-worker (WORKER_MODE=worker)"]
        sw_quota["quota_prediction timer"]
        sw_opt["storage_optimization timer"]
        sw_orphan["orphan_cleanup timer"]
        sw_video["video_processing timer"]
        sw_consumers["Kafka consumers<br/>(manual commits + DLQ)"]
    end

    subgraph ZK_Service["zk-encryption-service"]
        zk_auth["ZK Auth"]
        zk_recovery["Recovery / Keys"]
        zk_internal["Internal API"]
        zk_redis["Redis-backed session / rate limiting"]
        zk_postgres["ZK Postgres persistence"]
    end

    elasticsearch[(elasticsearch)]

    st_auth --> st_redis
    st_auth --> st_postgres
    st_files --> st_postgres
    st_files --> st_rust
    st_files --> st_jobs
    st_files --> st_ws
    st_files --> st_plan_gate
    st_sharing --> st_postgres
    st_billing --> st_postgres
    st_billing --> st_plan_gate
    st_internal --> st_postgres
    st_search --> st_plan_gate
    st_ws --> st_redis
    st_jobs --> st_kafka
    st_search --> st_kafka
    st_search --> elasticsearch

    sw_quota --> st_postgres
    sw_opt --> st_postgres
    sw_orphan --> st_postgres
    sw_video --> st_kafka
    sw_consumers --> st_kafka

    zk_auth --> zk_redis
    zk_auth --> zk_postgres
    zk_recovery --> zk_redis
    zk_recovery --> zk_postgres
    zk_internal --> zk_postgres

    st_internal -->|Internal API client| zk_internal
    zk_internal -->|Internal API client| st_internal
```

## 4. Scaling & Reliability (2026-04)

Shipped in the 2026-04 architecture review (P0 items 1–13 + #14). This diagram isolates the pieces that make the system horizontally scalable and recoverable.

```mermaid
flowchart TB
    subgraph Front["Front door"]
        cf["Cloudflare<br/>(previews cached 7d<br/>API bypass)"]
        nginx["nginx<br/>set_real_ip_from CF<br/>upstream split"]
    end

    subgraph API["API tier (horizontally scalable)"]
        s1["storage-service #1"]
        s2["storage-service #2"]
        sN["storage-service #N…"]
    end

    subgraph Workers["Worker tier (single replica)"]
        sw["storage-worker<br/>timers + Kafka consumers<br/>(manual commits, DLQ)"]
    end

    subgraph Storage["Storage tiers"]
        hot[("storage_data<br/>cache + warm<br/>NVMe/SSD")]
        cold[("cold_storage_data<br/>HDD / S3 FUSE / NFS<br/>optional zstd")]
    end

    subgraph DB["Database tier"]
        pgb["pgbouncer<br/>transaction pool"]
        pg[("postgres primary<br/>wal_level=replica<br/>archive_mode=on")]
        pgr[("postgres-replica<br/>--profile replica<br/>read-only")]
        wal[("postgres_wal_archive<br/>volume<br/>RPO < 5 min")]
    end

    subgraph Cache["Cache / queue tier"]
        rA["redis DB0<br/>sessions"]
        rB["redis DB1<br/>cache"]
        rC["redis DB2<br/>rate-limit"]
        rD["redis DB3<br/>pubsub (WS fan-out)"]
        kq["kafka<br/>topic + DLQ<br/>manual commits"]
    end

    subgraph Obs["Observability"]
        prom["prometheus"]
        graf["grafana"]
        jaeger["jaeger"]
    end

    cf --> nginx
    nginx -->|round-robin API| s1
    nginx -->|round-robin API| s2
    nginx -->|round-robin API| sN
    nginx -.->|ip_hash WebSocket| s1
    nginx -.->|ip_hash WebSocket| s2

    s1 --> pgb
    s2 --> pgb
    sN --> pgb
    sw --> pgb
    pgb --> pg
    pg -.->|streaming replication| pgr
    pg -.->|archive_command| wal

    s1 --> rA
    s1 --> rB
    s1 --> rC
    s1 --> rD
    s2 --> rD
    sN --> rD

    s1 --> kq
    s2 --> kq
    sw --> kq

    s1 --> hot
    s1 --> cold
    s2 --> hot
    s2 --> cold
    sw --> hot
    sw --> cold

    s1 --> prom
    prom --> graf
    s1 --> jaeger
```

### What changed and why

| Change | Gives us |
|---|---|
| Cloudflare CDN + nginx cache headers | 80%+ bandwidth offload; client IPs preserved via `CF-Connecting-IP` |
| nginx split upstreams (`fastapi_upstream` + `ws_upstream`) | Round-robin for API, `ip_hash` for WS so per-user state stays coherent |
| `storage-service` has no `container_name` / no host port | Can boot with `deploy.replicas: N` |
| `WORKER_MODE=api` on API + separate `storage-worker` | Timers can't double-fire across replicas |
| `pgbouncer` transaction pool | Single storage-service replica consumed 150/200 PG connections before; pool multiplexing now makes N replicas cheap |
| Redis split (DB 0/1/2/3) | Rate-limit traffic can't evict session data; pubsub channel isolated |
| Kafka DLQ + manual commits | Poison pills no longer block partitions; crashes no longer silently drop messages |
| `wal_level=replica` + `archive_command` | PITR with RPO < 5 min (was 24 h via daily `pg_dump`) |
| `postgres-replica` service (opt-in `--profile replica`) | Read-only offload target for analytics / dashboards |
| `READ_DATABASE_URL` + `get_read_db()` dependency | Dropin replacement for `get_db` on read-heavy routes; blank env var → falls back to primary |
| `cold_storage_data` separate volume | Operators can back cold with cheap HDD / NFS / S3 FUSE via `driver_opts` without code changes |
| Plan-feature gating (`require_plan_feature`) | AI endpoints no longer burn LLM/GPU budget on free-tier users |
| Semantic search soft-degrade | Free users fall back to keyword silently — no 402 on search |
| SOPS-encrypted secrets (`secrets.enc.env`) | No more plaintext `.env` in repo |
| ClamAV fail-closed | Scanner failure blocks upload instead of silently passing malware |

## Notes

- `storage-service` is the main backend for normal storage and a large portion of platform logic.
- `zk-encryption-service` is a separate service with its own database and auth domain.
- Redis is shared infrastructure used by multiple services, now split by DB number so tenants don't collide.
- Kafka-backed workers are separate runtime processes, not just in-process tasks. `storage-worker` runs the timers that used to live in `storage-service` lifespan.
- The repo is multi-service, but not a tiny-service microservices layout; it has one dominant core service plus supporting services and workers.
- `clickhouse` appears in compose as analytics infrastructure, but this current snapshot does not show an active app-layer request path to it.
- In **dev**, `docker-compose.dev.yml` pins `storage-service.deploy.replicas: 1` and overrides `WORKER_MODE=all` so a single container runs both API and timers (8 GB Mac constraint). Prod uses the base compose file → 2 replicas + separate worker.
- `postgres-replica` and `pgbouncer-replica` are **opt-in** (`--profile replica`). The primary's WAL archiving is always on.
- See `docs/PITR_RUNBOOK.md` for recovery procedure and `docs/CDN_SETUP.md` for Cloudflare activation.
