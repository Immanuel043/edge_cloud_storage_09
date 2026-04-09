# Current Architecture

This repo is a multi-service architecture with one large core backend, `storage-service`, not a single-process monolith. This current-state snapshot is derived from `infrastructure/docker-compose.yml`, the service entrypoints in `services/storage-service/app/main.py` and `services/zk-encryption-service/app/main.py`, the Node runtime in `services/web-service/src/app.ts`, and the frontend API wiring in `frontend-clean/src/services`.

If your Markdown viewer does not render Mermaid, open `docs/architecture/CURRENT_ARCHITECTURE.html` in a browser.

## 1. Runtime Topology

```mermaid
flowchart TD
    subgraph Edge_UI["Edge/UI"]
        browser["Browser / Frontend Client"]
        nginx["nginx"]
    end

    subgraph Core_Application_Services["Core application services"]
        web_service["web-service"]
        storage_service["storage-service"]
        zk_service["zk-encryption-service"]
        rust_dataplane["rust-dataplane"]
    end

    subgraph Background_Workers["Background workers"]
        billing_scheduler["billing-scheduler"]
        zk_billing_scheduler["zk-billing-scheduler"]
        chunk_processor["chunk-processor"]
        preview_processor["preview-processor"]
        es_indexer["es-indexer"]
        embedding_processor["embedding-processor"]
        file_analysis_processor["file-analysis-processor"]
    end

    subgraph Data_And_Infrastructure["Data and infrastructure"]
        postgres[(postgres)]
        zk_postgres[(zk-postgres)]
        redis[(redis)]
        kafka[(kafka)]
        zookeeper[(zookeeper)]
        elasticsearch[(elasticsearch)]
        clickhouse[(clickhouse)]
        clamav["clamav"]
        shared_storage[("storage_data volume / shared storage")]
    end

    browser --> nginx
    browser -->|Direct API / WebSocket| storage_service
    browser -.->|Direct ZK API when configured| zk_service

    nginx --> web_service
    nginx --> storage_service

    web_service --> storage_service
    web_service --> zk_service
    web_service --> postgres
    web_service --> redis
    web_service --> kafka

    storage_service --> postgres
    storage_service --> redis
    storage_service --> kafka
    storage_service --> elasticsearch
    storage_service --> rust_dataplane
    storage_service --> clamav
    storage_service --> shared_storage

    zk_service --> zk_postgres
    zk_service --> redis
    zk_service --> shared_storage

    rust_dataplane --> shared_storage

    kafka --> zookeeper

    chunk_processor --> kafka
    preview_processor --> kafka
    es_indexer --> kafka
    embedding_processor --> kafka
    file_analysis_processor --> kafka

    preview_processor --> shared_storage

    billing_scheduler -.->|Depends on / uses same stack| storage_service
    zk_billing_scheduler -.->|Depends on / uses same stack| zk_service
```

## 2. Service Interactions

```mermaid
flowchart LR
    browser["Browser / Frontend Client"]
    nginx["nginx"]
    web_service["web-service"]
    storage_service["storage-service"]
    zk_service["zk-encryption-service"]
    redis[(redis)]
    postgres[(postgres)]
    zk_postgres[(zk-postgres)]
    kafka[(kafka)]
    elasticsearch[(elasticsearch)]
    rust_dataplane["rust-dataplane"]
    chunk_processor["chunk-processor"]
    preview_processor["preview-processor"]
    es_indexer["es-indexer"]
    embedding_processor["embedding-processor"]
    file_analysis_processor["file-analysis-processor"]

    browser -->|Web app routes| nginx
    nginx -->|HTTP/REST| web_service

    browser -->|HTTP/REST + WebSocket: auth, files, sharing| storage_service
    browser -.->|HTTP/REST: ZK auth, recovery, keys| zk_service

    web_service -->|HTTP/REST| storage_service
    web_service -->|HTTP/REST| zk_service

    storage_service -->|Internal API| zk_service
    zk_service -->|Internal API| storage_service

    storage_service -->|Redis cache / session / pubsub| redis
    storage_service -->|DB queries| postgres
    storage_service -->|Kafka events| kafka
    storage_service -->|Search / indexing| elasticsearch
    storage_service -->|Data plane socket| rust_dataplane

    zk_service -->|Redis cache / session / rate limit| redis
    zk_service -->|DB queries| zk_postgres

    kafka -->|Kafka events| chunk_processor
    kafka -->|Kafka events| preview_processor
    kafka -->|Kafka events| es_indexer
    kafka -->|Kafka events| embedding_processor
    kafka -->|Kafka events| file_analysis_processor
```

## 3. Key Service Internals

```mermaid
flowchart TB
    subgraph Storage_Service["storage-service"]
        st_auth["Auth / Sessions"]
        st_files["Files / Uploads / Downloads"]
        st_sharing["Sharing / Share Bundles"]
        st_billing["Billing / Subscription UI"]
        st_ws["WebSocket / Realtime"]
        st_internal["Internal API"]
        st_search["Search / Index hooks"]
        st_jobs["Background job producers"]
        st_redis["Redis integration"]
        st_postgres["Postgres persistence"]
        st_kafka["Kafka producer path"]
        st_rust["Rust dataplane integration"]
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
    st_sharing --> st_postgres
    st_billing --> st_postgres
    st_internal --> st_postgres
    st_ws --> st_redis
    st_jobs --> st_kafka
    st_search --> st_kafka
    st_search --> elasticsearch

    zk_auth --> zk_redis
    zk_auth --> zk_postgres
    zk_recovery --> zk_redis
    zk_recovery --> zk_postgres
    zk_internal --> zk_postgres

    st_internal -->|Internal API client| zk_internal
    zk_internal -->|Internal API client| st_internal
```

## Notes

- `storage-service` is the main backend for normal storage and a large portion of platform logic.
- `zk-encryption-service` is a separate service with its own database and auth domain.
- Redis is shared infrastructure used by multiple services.
- Kafka-backed workers are separate runtime processes, not just in-process tasks.
- The repo is multi-service, but not a tiny-service microservices layout; it has one dominant core service plus supporting services and workers.
- `clickhouse` appears in compose as analytics infrastructure, but this current snapshot does not show an active app-layer request path to it.
- `storage-service` also starts some in-process background services from its FastAPI lifecycle, in addition to the separate worker containers shown above.
