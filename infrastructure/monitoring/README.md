# Edge Cloud Storage – Monitoring Stack

Prometheus, Grafana, and Node Exporter for app health and metrics. Dashboards and alert rules are provisioned automatically.

## Prerequisites

- Docker and Docker Compose
- The Docker network `edge-cloud-network` must exist (it is created when you start the main app stack)

## Quick test (monitoring only)

If the network does not exist yet, create it:

```bash
docker network create edge-cloud-network
```

From the **infrastructure** directory:

```bash
cd infrastructure
docker compose -f docker-compose-monitoring.yml up -d
```

- **Grafana:** http://localhost:3030 (login: `admin` / `admin`)
- **Prometheus:** http://localhost:9090
- **Node Exporter:** http://localhost:9100/metrics

In Grafana, go to **Dashboards** and open:

- **Edge Cloud Storage - App Health** – service status, error rate, latency, resources, firing alerts
- **Edge Cloud Storage - Main Dashboard** – requests, uploads, storage, CPU/memory
- **Edge Cloud Storage - Performance Dashboard** – latency percentiles, DB/cache, upload duration
- **Edge Cloud Storage - ML Features Dashboard** – quota prediction, storage optimization, recommendations
- **Edge Storage Service** – uploads and errors
- **Node Exporter** – host metrics (if the dashboard is provisioned)

With only monitoring running, **Storage Service**, **Web Service**, and **ZK Encryption Service** will show as down (no targets). Node Exporter and Prometheus will be up and you’ll see host and Prometheus self-metrics.

## Full test (with app services)

To see real application metrics and a healthy App Health dashboard:

1. Start the main application stack (so `storage-service`, `web-service`, `zk-encryption-service`, etc. are on `edge-cloud-network`):

   ```bash
   cd infrastructure
   docker compose up -d
   ```

2. Start the monitoring stack:

   ```bash
   docker compose -f docker-compose-monitoring.yml up -d
   ```

3. Wait ~30 seconds for Prometheus to scrape, then open:
   - http://localhost:3030 → Grafana → **App Health** dashboard.  
   - You should see **Storage Service** and **Node Exporter** up; **Web Service** and **ZK Encryption Service** up if those containers expose `/metrics` and are reachable.

4. In Prometheus (http://localhost:9090):
   - **Status → Targets**: all scrape jobs and their state (up/down).
   - **Status → Rules**: alert rules from `alerts.yml` (e.g. `edge_storage_alerts`).
   - **Alerts**: list of firing/pending alerts once conditions are met.

## Verify alerts

- **Prometheus → Alerts**: rules are loaded; alerts fire when thresholds are exceeded (e.g. HighErrorRate, ServiceDown).
- **Grafana → App Health**: the “Firing Alerts” panel shows currently firing alerts (may be empty if nothing is in breach).

## Stop

```bash
cd infrastructure
docker compose -f docker-compose-monitoring.yml down
```

Data in Grafana and Prometheus is stored in Docker volumes and persists across restarts.
