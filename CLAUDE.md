# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Edge Cloud Storage is a production-grade, self-hosted file storage platform with AI/ML features, zero-knowledge encryption, and multi-tier storage. It uses a polyglot microservices architecture: Python (FastAPI), Node.js (Express), Rust (data plane), and React (frontend).

## Common Commands

### Infrastructure (Docker)

```bash
# Start all services (production)
cd infrastructure && docker compose up -d

# Start with dev resource limits (for 8GB Mac)
cd infrastructure && docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d

# Start with monitoring (Prometheus, Grafana, Jaeger)
cd infrastructure && docker compose -f docker-compose.yml -f docker-compose-monitoring.yml up -d
```

### Frontend (React/Vite) — `frontend-clean/`

```bash
cd frontend-clean
npm install
npm run dev              # Dev server on :3000, proxies /api to :3001
npm run build            # Production build (tsc + vite)
npm run type-check       # TypeScript only (no emit)
npm test                 # Vitest
npm run test:coverage    # Vitest with v8 coverage (80% threshold)
```

### Storage Service (FastAPI) — `services/storage-service/`

```bash
# Run the service
python -m uvicorn app.main:app --reload --port 8001

# Run all backend tests from repo root
pytest tests/ -v

# Run by marker
pytest tests/ -v -m unit
pytest tests/ -v -m integration
pytest tests/ -v -m ml
pytest tests/ -v -m "not slow"

# Run a single test file or test
pytest tests/unit/test_quota.py -v
pytest tests/unit/test_quota.py::test_predict_usage -v
```

### Web Service (Node.js/Express) — `services/web-service/`

```bash
cd services/web-service
npm install
npm run dev       # tsx watch on :3001
npm run build     # Compile TypeScript
npm test          # Jest
```

### Rust Data Plane — `services/rust-data-plane/`

```bash
cd services/rust-data-plane
cargo build --release
cargo test
cargo bench
RUSTFLAGS="-C target-cpu=native" cargo build --release   # Native CPU optimizations
```

### Linting & Formatting (Python)

```bash
black services/storage-service/app/ --line-length=100
isort services/storage-service/app/ --profile=black --line-length=100
flake8 services/storage-service/app/ --max-line-length=100 --ignore=E203,E266,E501,W503
mypy services/storage-service/app/ --ignore-missing-imports
bandit -r services/storage-service/app/ -ll
```

### Pre-commit Hooks

```bash
pre-commit install && pre-commit install --hook-type commit-msg
pre-commit run --all-files
```

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/) with `--strict` (e.g., `feat(storage): add chunk retry logic`).

## Architecture

### Service Communication

```
Frontend (:3000) ──proxy──> Web Service (:3001) ──REST──> Storage Service (:8001)
                                                    └──> ZK Encryption Service (:8002)
                                                    └──> Rust Data Plane (binary, subprocess)
```

- **Frontend** → Web Service: REST via Vite proxy (`/api` → `:3001`), WebSocket (`/ws`)
- **Web Service** → Storage Service: internal REST calls
- **Storage Service** → ZK Encryption Service: inter-service crypto ops
- **Storage Service** → Rust Data Plane: subprocess for high-perf upload/crypto (3-4x faster uploads, 10x crypto throughput)

### Data Stores

| Store | Purpose | Config |
|-------|---------|--------|
| PostgreSQL (`edge_cloud`) | Users, files, storage metadata | `edge_admin` user |
| PostgreSQL (`zk_db`) | Zero-knowledge encryption keys, recovery phrases | `zk_admin` user, **separate instance** for security isolation |
| Redis | Sessions, rate limiting, caching | 2GB limit, LRU eviction |
| Elasticsearch | Full-text file search | Single-node dev, cluster prod |
| ClickHouse | Analytics and event reporting | |
| Kafka | Event streaming between services | |

### Multi-Tier Storage

Files are stored on-disk in `storage/` with automatic tiering:
- `storage/cache/` — NVMe/SSD hot data (frequently accessed)
- `storage/warm/` — SSD active data
- `storage/cold/` — HDD archive (infrequently accessed)
- `storage/temp/` — In-progress uploads
- `storage/backup/` — Local backups

### Storage Service Internals (`services/storage-service/app/`)

The FastAPI app is the core backend. Key structural patterns:

- **Routers** (`app/routers/`): ~40 route modules — `auth`, `files`, `upload`, `billing_v2`, `deduplication`, `search`, `auto_organization`, `recommendations`, etc.
- **Services** (`app/services/`): Business logic singletons — `encryption.py`, `deduplication_enhanced.py`, `cold_storage_tiering.py`, `chunk_service.py`, `search_service.py`, `llm_client.py`, etc.
- **Workers** (`app/workers/`): Background tasks — `quota_prediction_worker`, `storage_optimization_worker`, `video_processing_worker`, `orphan_cleanup_worker`
- **Models** (`app/models/`): SQLAlchemy 2.0 async models
- **Config** (`app/config.py`): Central `Settings` class — chunk size (64MB), max file size (20GB), compression level (3), ML feature flags, billing config
- **Database** (`app/database.py`): Async engine (asyncpg), Redis init/teardown
- **Lifecycle**: `app/main.py` uses FastAPI `lifespan` to start/stop Redis, background workers, and services

Backend service singletons have specific export names that don't always match the module name — always verify the actual export name before importing.

### Frontend Internals (`frontend-clean/src/`)

- React 19 + TypeScript (strict) + Vite + Tailwind CSS
- Client-side encryption using `@noble/ciphers`, `@noble/hashes`, `argon2-browser` (WASM)
- Path alias: `@/*` → `src/*`
- Key contexts: `AuthContext`, `StorageContext`
- WASM + top-level await plugins required for crypto

### Zero-Knowledge Encryption Service (`services/zk-encryption-service/`)

Separate FastAPI service with its own PostgreSQL database. Handles FIDO2/WebAuthn, BIP39 recovery phrases, and key management. Intentionally isolated from the main storage service for security.

## Testing

- **Backend**: pytest with asyncio auto mode, in-memory SQLite, `tests/conftest.py` provides fixtures (`api_client`, `mock_user`, `mock_file`, `mock_redis`, etc.). Coverage target: 80%.
- **Frontend**: Vitest + jsdom + React Testing Library. Coverage target: 80% lines/statements, 75% branches.
- **Web Service**: Jest.
- **CI** (`.github/workflows/test.yml`): Runs all three test suites + linting (Black, isort, Flake8, Bandit) against PostgreSQL 15 and Redis 7.

## Configuration

- Copy `.env.example` to `infrastructure/.env` for Docker services
- `DEV_MODE=true` in storage service config bypasses payment verification (logged with warning)
- ML features are toggled via `ML_*_ENABLED` flags in `app/config.py`
- LLM integration (AI summarization, naming) requires setting `OPENAI_API_KEY` or configuring Ollama in `infrastructure/.env`

## Code Style

- **Python**: Black (100 chars), isort (black profile), flake8 (ignore E203/E266/E501/W503), mypy (Python 3.11)
- **TypeScript**: Strict mode, no unused locals/parameters
- **Rust**: Edition 2021
