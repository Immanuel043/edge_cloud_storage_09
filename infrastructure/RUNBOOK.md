# Operations Runbook

Operational reference for bringing up, switching between, and tearing down
the Edge Cloud Storage stack.

## Profiles

The repo ships **three** compose files that combine into different deployment
shapes. Pick the right combination for the host you're running on.

| File | Purpose |
|---|---|
| `docker-compose.yml` | Production: 2 storage-service replicas, all workers (preview, embedding, file-analysis, ClamAV), backups, snapshots. Targets ≥16 vCPU / ≥32 GB. |
| `docker-compose.dev.yml` | Dev override for an 8 GB Mac. Pins storage-service to 1 replica, mounts the Python source read-only into the container for hot-reload, disables heavy services via `profiles: production`. |
| `docker-compose-monitoring.yml` | Optional Prometheus + Grafana + Node Exporter + cAdvisor + Kafka Exporter. Joins the same `edge-cloud-network` so it can scrape services by DNS name. |

## Prod build

Use this on a properly-sized host (production server, dev VM ≥16 GB).

```bash
cd infrastructure

# Tear down whatever is running (preserves named volumes / data)
docker compose -f docker-compose.yml -f docker-compose.dev.yml down

# Build + bring up the full stack
docker compose -f docker-compose.yml up -d --build

# Optional: monitoring on top
docker compose -f docker-compose-monitoring.yml up -d
```

Skip `--build` if you trust the existing images:

```bash
docker compose -f docker-compose.yml up -d
docker compose -f docker-compose-monitoring.yml up -d
```

### What you get on prod

| Concern | Value |
|---|---|
| Containers | ~33 |
| storage-service replicas | 2 (`cpus=4.0` each, `mem=8g` each) |
| WORKER_MODE | `api` on storage-service replicas, `worker` on `edge-storage-worker` |
| Background workers running | preview-processor (×2), embedding-processor, file-analysis-processor, chunk-processor (×2), ClamAV, es-indexer, storage-worker |
| Backups | postgres-backup, zk-postgres-backup, es-snapshot-runner active |
| Source layout | Baked into image — code changes require a rebuild |

## Dev build (8 GB Mac)

This is the right home for laptops. Heavy services are profiled off; the
single storage-service replica picks up code changes from disk via a
read-only bind mount + uvicorn `--reload`.

```bash
cd infrastructure

# Always `down` first when switching profiles, otherwise prod-only services
# linger as orphans (compose only acts on services in the current selection).
docker compose -f docker-compose.yml -f docker-compose.dev.yml down

# Bring up the dev shape
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d

# Optional: monitoring still works the same way
docker compose -f docker-compose-monitoring.yml up -d
```

### What you get on dev

| Concern | Value |
|---|---|
| Containers | ~22 |
| storage-service | 1 replica, `cpus=2.0`, `mem=2g`, `WORKER_MODE=all` |
| Source | `services/storage-service/app:/app/app:ro` bind mount |
| `DEV_RELOAD` | `true` — saving a `.py` file restarts uvicorn in-place |
| Disabled (`profiles: production`) | ClamAV, preview-processor, embedding-processor, file-analysis-processor, postgres-backup, zk-postgres-backup, es-snapshot-runner, storage-worker |
| `MAX_CONCURRENT_PREVIEWS` / `MAX_CONCURRENT_TRANSCODES` / `PREVIEW_GENERATION_CONCURRENCY` | `1` (serializes any leftover heavy work that does run) |

### Caveats

- The bind mount is **read-only**, so `docker cp` into `/app/app/...` from
  inside the container will fail with `mounted volume is marked read-only`.
  Edit on the host instead.
- Tests inside the container need `pytest` + `pytest-asyncio` + `fakeredis`
  installed in the container's `site-packages`. This survives a restart but
  not a `down` / `up` cycle (the container is recreated). Reinstall:
  ```bash
  docker exec -u 0 infrastructure-storage-service-1 \
    pip install --quiet "pytest==7.4.3" "pytest-asyncio==0.21.1" "fakeredis[lua]==2.23.3"
  ```
- The other services that share the storage-service Dockerfile
  (`chunk-processor`, `es-indexer`, `billing-scheduler`, `zk-billing-scheduler`)
  do **not** get the bind mount — they run from the baked image. Rebuild
  them after code changes that affect their entry points:
  ```bash
  docker compose -f docker-compose.yml -f docker-compose.dev.yml \
    up -d --build chunk-processor es-indexer billing-scheduler zk-billing-scheduler
  ```

## Monitoring stack

Lives in `docker-compose-monitoring.yml` and joins the existing
`edge-cloud-network`, so it scrapes services by DNS name.

```bash
# Up (works alongside either prod or dev)
docker compose -f docker-compose-monitoring.yml up -d

# Down (leaves the main stack running)
docker compose -f docker-compose-monitoring.yml down
```

Endpoints:

| | URL |
|---|---|
| Prometheus | http://localhost:9090 |
| Grafana | http://localhost:3030 (admin password from `GRAFANA_ADMIN_PASSWORD` in `.env`) |
| Node Exporter | http://localhost:9100/metrics |
| cAdvisor | http://localhost:8090 |
| Kafka Exporter | http://localhost:9308/metrics |

### Notable alerts shipped 2026-05-08

- `EventLoopLagHigh` (>100ms for 1m) — storage-service event-loop pressure.
- `EventLoopLagCritical` (>500ms for 30s) — same, severe.
- `HostMemoryAvailableLow` (<1 GiB for 2m) — host page-cache reclaim window.
- `StorageServiceCFSThrottled` — per-replica CPU cap being hit. **Only fires
  on real Linux hosts.** On Docker Desktop for Mac, cAdvisor cannot resolve
  the docker layerdb path inside the LinuxKit VM and falls back to
  root-cgroup-only metrics, so this alert stays silent. Documented as a
  comment in `docker-compose-monitoring.yml`.

### Dashboard panels added 2026-05-08

`infrastructure/monitoring/grafana/dashboards/app-health-dashboard.json` —
Event Loop Lag, Host MemAvailable, Storage-service CFS Throttling rate,
Web-service HTTP p95 latency by route.

## Switching profiles

When moving between dev and prod (in either direction), always `down` first:

```bash
# Stop everything from whichever profile is currently up
docker compose -f docker-compose.yml -f docker-compose.dev.yml down

# Then bring up the target profile
docker compose -f docker-compose.yml up -d --build       # prod
# OR
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d   # dev
```

Without `down`, services that exist in one profile but not the other
linger as orphan containers and can hold port bindings or volumes that
prevent the new profile from starting cleanly.

## Tear-down

```bash
# Stop everything, keep volumes (Postgres, Redis, ES, etc. data preserved)
docker compose -f docker-compose.yml -f docker-compose.dev.yml \
  -f docker-compose-monitoring.yml down

# Stop and DESTROY data volumes — wipes Postgres, Redis, Elasticsearch,
# stored chunks, snapshots, prometheus/grafana state. Use only when
# explicitly resetting the dev environment.
docker compose -f docker-compose.yml -f docker-compose.dev.yml \
  -f docker-compose-monitoring.yml down -v
```

## Health-check one-liners

```bash
# All containers running?
docker ps --filter "status=running" --format "table {{.Names}}\t{{.Status}}"

# All Prometheus alert rules loaded?
curl -s http://localhost:9090/api/v1/rules \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(sum(len(g['rules']) for g in d['data']['groups']),'rules loaded')"

# Storage-service event-loop lag right now?
curl -s 'http://localhost:9090/api/v1/query?query=storage_event_loop_lag_seconds' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(' ', r['metric'].get('instance','?'), r['value'][1]+'s') for r in d['data']['result']]"

# Host memory pressure right now?
curl -s 'http://localhost:9090/api/v1/query?query=node_memory_MemAvailable_bytes' \
  | python3 -c "import json,sys,functools; d=json.load(sys.stdin); v=float(d['data']['result'][0]['value'][1]); print(f'{v/1024/1024:.0f} MB available')"

# Currently firing alerts?
curl -s http://localhost:9090/api/v1/alerts \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(' ', a['labels']['alertname'], '->', a['state']) for a in d['data']['alerts']]"
```

## When to run prod on the 8 GB Mac (and when not to)

**Don't, for sustained work.** The empirical evidence captured 2026-05-08:

- Prod compose on this host: `MemAvailable 540 MB / 8 GB`, sustained
  loadavg ~6 of 8 cores. `HostMemoryAvailableLow` fires immediately.
- Two storage-service replicas at `cpus=4.0` reserve 8 vCPU before the
  rest of the stack — Kafka, Elasticsearch, Postgres, Redis, ClamAV,
  preview/embedding/file-analysis workers all compete for the leftover
  4 vCPU and ~3 GB of memory. The result is page-cache reclaim that
  stalls every container's I/O simultaneously, which surfaces as the
  ~1–2 second event-loop lag spikes the alerts catch.

**Do**, briefly, for:

- Smoke-testing a prod-shaped change before deploy.
- Reproducing an alert that only fires on prod compose.
- Verifying images that were rebuilt today actually run cleanly.

For sustained dev work on this hardware, stay on the dev override.
