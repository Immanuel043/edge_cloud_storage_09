# Developer Onboarding Guide - Edge Cloud Storage

**Welcome to the Edge Cloud Storage team!** 🎉

This guide will help you get up and running with the codebase in < 1 hour.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Quick Start](#quick-start)
3. [Project Structure](#project-structure)
4. [Development Workflow](#development-workflow)
5. [Testing](#testing)
6. [Common Tasks](#common-tasks)
7. [Resources](#resources)

---

## Prerequisites

### Required Software

- **Python 3.11+** - [Download](https://www.python.org/downloads/)
- **Node.js 18+** - [Download](https://nodejs.org/)
- **Docker & Docker Compose** - [Download](https://www.docker.com/)
- **PostgreSQL 14+** - [Download](https://www.postgresql.org/)
- **Redis 7+** - [Download](https://redis.io/)
- **Git** - [Download](https://git-scm.com/)

### Optional Tools

- **pgAdmin** - PostgreSQL GUI
- **Redis Commander** - Redis GUI
- **Postman** - API testing
- **VS Code** - Recommended IDE with extensions:
  - Python
  - Pylance
  - Docker
  - GitLens

---

## Quick Start (5 Minutes)

### 1. Clone Repository

```bash
git clone https://github.com/your-org/edge-cloud-storage.git
cd edge-cloud-storage
```

### 2. Start Services with Docker

```bash
# Start all services (PostgreSQL, Redis, Elasticsearch)
docker-compose up -d

# Verify services are running
docker-compose ps
```

### 3. Setup Backend

```bash
cd services/storage-service

# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
pip install -r requirements-dev.txt  # Development dependencies

# Setup environment variables
cp .env.example .env
# Edit .env with your settings

# Run database migrations
alembic upgrade head

# Start development server
uvicorn app.main:app --reload --port 8001
```

### 4. Verify Setup

```bash
# In a new terminal, test the API
curl http://localhost:8001/api/v1/health | jq

# Should see:
# {
#   "status": "healthy",
#   "checks": { ... }
# }
```

🎉 **You're ready to start developing!**

---

## Project Structure

```
edge-cloud-storage/
├── services/
│   └── storage-service/        # Main FastAPI application
│       ├── app/
│       │   ├── main.py         # Application entry point
│       │   ├── config.py       # Configuration
│       │   ├── database.py     # Database setup
│       │   ├── dependencies.py # FastAPI dependencies
│       │   ├── models/         # Database models & schemas
│       │   │   ├── database.py # SQLAlchemy models
│       │   │   └── schemas.py  # Pydantic schemas
│       │   ├── routers/        # API endpoints (30+ files)
│       │   │   ├── auth.py     # Authentication
│       │   │   ├── files.py    # File operations
│       │   │   ├── upload.py   # File upload
│       │   │   └── ...
│       │   ├── services/       # Business logic
│       │   │   ├── storage.py
│       │   │   ├── encryption.py
│       │   │   ├── query_optimizer.py
│       │   │   └── ...
│       │   ├── workers/        # Background workers
│       │   │   ├── quota_prediction_worker.py
│       │   │   └── ...
│       │   ├── monitoring/     # Observability
│       │   │   ├── metrics.py
│       │   │   ├── tracing.py
│       │   │   └── sentry_integration.py
│       │   └── utils/          # Utilities
│       ├── alembic/            # Database migrations
│       ├── tests/              # Test suite
│       └── requirements.txt    # Python dependencies
├── frontend/                   # React/Next.js application
├── monitoring/                 # Grafana dashboards, Prometheus config
├── docs/                       # Documentation
├── load-tests/                 # K6 & Apache Bench tests
└── docker-compose.yml          # Local development setup
```

### Key Files to Know

| File | Purpose |
|------|---------|
| `app/main.py` | FastAPI app initialization, router registration |
| `app/routers/files.py` | File operations (list, download, delete) |
| `app/routers/upload.py` | File upload (chunked, resumable) |
| `app/services/storage.py` | Core storage service |
| `app/services/encryption.py` | File encryption/decryption |
| `app/models/database.py` | Database models (25+ tables) |
| `alembic/versions/` | Database migrations |

---

## Development Workflow

### 1. Create a Feature Branch

```bash
git checkout -b feature/your-feature-name
```

### 2. Make Changes

Edit code, add tests, update documentation.

### 3. Run Tests

```bash
# Unit tests
pytest tests/unit/ -v

# Integration tests
pytest tests/integration/ -v

# All tests with coverage
pytest --cov=app --cov-report=html
```

### 4. Format & Lint

```bash
# Format code
black app/
isort app/

# Lint
flake8 app/
pylint app/

# Type checking
mypy app/
```

### 5. Commit & Push

```bash
git add .
git commit -m "feat: add your feature description"
git push origin feature/your-feature-name
```

### 6. Create Pull Request

- Go to GitHub
- Create PR from your branch to `main`
- Request review from team
- Address feedback
- Merge after approval

---

## Testing

### Running Tests

```bash
# All tests
pytest

# Specific test file
pytest tests/test_upload.py -v

# Specific test
pytest tests/test_upload.py::test_upload_file -v

# With output
pytest -v -s

# With coverage
pytest --cov=app
```

### Writing Tests

**Example test:**

```python
# tests/test_files.py
import pytest
from httpx import AsyncClient

@pytest.mark.asyncio
async def test_list_files(client: AsyncClient, test_user, auth_headers):
    """Test file listing endpoint."""
    response = await client.get(
        "/api/v1/files",
        headers=auth_headers
    )

    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
```

### Test Fixtures

Common fixtures available in `conftest.py`:

- `client` - HTTP client
- `db_session` - Database session
- `test_user` - Test user account
- `auth_headers` - Auth headers with JWT token
- `test_file` - Test file object

---

## Common Tasks

### Add a New API Endpoint

**Step 1**: Create endpoint in router

```python
# app/routers/files.py
from fastapi import APIRouter, Depends
from ..dependencies import get_current_user

router = APIRouter(prefix="/api/v1/files", tags=["files"])

@router.get("/my-new-endpoint")
async def my_new_endpoint(
    current_user = Depends(get_current_user),
    db = Depends(get_db)
):
    """
    My new endpoint description.

    Returns:
        dict: Response data
    """
    # Your logic here
    return {"message": "Hello!"}
```

**Step 2**: Register router (if new file)

```python
# app/main.py
from .routers import files

app.include_router(files.router)
```

**Step 3**: Add tests

```python
# tests/test_files.py
async def test_my_new_endpoint(client, auth_headers):
    response = await client.get(
        "/api/v1/files/my-new-endpoint",
        headers=auth_headers
    )
    assert response.status_code == 200
```

### Add a Database Migration

```bash
# Create migration
alembic revision --autogenerate -m "add new column"

# Review generated migration
cat alembic/versions/xxx_add_new_column.py

# Apply migration
alembic upgrade head

# Rollback if needed
alembic downgrade -1
```

### Add a New Background Worker

```python
# app/workers/my_worker.py
import asyncio

class MyWorker:
    def __init__(self):
        self.is_running = False
        self.worker_task = None

    async def start(self):
        """Start the worker."""
        self.is_running = True
        self.worker_task = asyncio.create_task(self._run())

    async def stop(self):
        """Stop the worker."""
        self.is_running = False
        if self.worker_task:
            await self.worker_task

    async def _run(self):
        """Main worker loop."""
        while self.is_running:
            try:
                # Do work
                await self._process()
            except Exception as e:
                print(f"Worker error: {e}")

            await asyncio.sleep(3600)  # Run every hour

    async def _process(self):
        """Process logic."""
        pass

my_worker = MyWorker()
```

**Register in main.py:**

```python
# app/main.py
from .workers.my_worker import my_worker

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    await my_worker.start()
    yield
    # Shutdown
    await my_worker.stop()
```

---

## Debugging

### VS Code Launch Configuration

Create `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "FastAPI",
      "type": "python",
      "request": "launch",
      "module": "uvicorn",
      "args": [
        "app.main:app",
        "--reload",
        "--port",
        "8001"
      ],
      "jinja": true,
      "justMyCode": false
    }
  ]
}
```

### Logging

```python
import logging

logger = logging.getLogger(__name__)

logger.debug("Debug message")
logger.info("Info message")
logger.warning("Warning message")
logger.error("Error message")
```

### Interactive Debugging

```python
# Add breakpoint
import pdb; pdb.set_trace()

# Or use ipdb (install: pip install ipdb)
import ipdb; ipdb.set_trace()
```

---

## Code Style Guide

### Python

- Follow PEP 8
- Use type hints
- Docstrings for all public functions
- Max line length: 100 characters

**Example:**

```python
async def upload_file(
    file_id: str,
    data: bytes,
    user_id: UUID,
    db: AsyncSession
) -> Object:
    """
    Upload a file to storage.

    Args:
        file_id: Unique file identifier
        data: File content bytes
        user_id: Owner user ID
        db: Database session

    Returns:
        Object: Created file object

    Raises:
        HTTPException: If upload fails
    """
    # Implementation
    pass
```

### API Design

- RESTful endpoints
- Use plural nouns (`/files`, not `/file`)
- Consistent naming
- Proper HTTP methods (GET, POST, PUT, DELETE)
- Meaningful status codes

---

## Useful Commands

```bash
# Database
alembic current                  # Current migration
alembic history                  # Migration history
alembic upgrade head             # Apply migrations
alembic downgrade -1             # Rollback one migration
psql $DATABASE_URL               # Connect to database

# Testing
pytest -v                        # Verbose tests
pytest -k test_upload            # Run tests matching pattern
pytest --lf                      # Run last failed tests
pytest -x                        # Stop on first failure

# Code quality
black --check app/               # Check formatting
black app/                       # Format code
isort app/                       # Sort imports
flake8 app/                      # Lint code
mypy app/                        # Type checking

# Development
uvicorn app.main:app --reload    # Start dev server
pip install -e .                 # Install in editable mode
pip freeze > requirements.txt    # Update dependencies
```

---

## Resources

### Documentation

- [API Documentation](http://localhost:8001/docs) - Swagger UI
- [Architecture Diagrams](docs/architecture/ARCHITECTURE_DIAGRAMS.md)
- [Deployment Runbook](docs/operations/DEPLOYMENT_RUNBOOK.md)
- [Operations Playbook](docs/operations/OPERATIONS_PLAYBOOK.md)

### External Resources

- [FastAPI Docs](https://fastapi.tiangolo.com/)
- [SQLAlchemy Docs](https://docs.sqlalchemy.org/)
- [Alembic Docs](https://alembic.sqlalchemy.org/)
- [Pytest Docs](https://docs.pytest.org/)

### Team Communication

- **Slack**: #edge-storage-dev
- **GitHub**: https://github.com/your-org/edge-cloud-storage
- **Jira**: https://yourorg.atlassian.net/browse/ES
- **Wiki**: https://wiki.yourorg.com/edge-storage

---

## Getting Help

### Quick Questions

- Ask in Slack: #edge-storage-dev
- Check documentation first
- Search existing issues on GitHub

### Bugs & Issues

1. Check if issue exists in GitHub
2. Create new issue with:
   - Clear description
   - Steps to reproduce
   - Expected vs actual behavior
   - Error messages/logs
   - Environment details

### Code Reviews

- Request reviews from 2+ team members
- Address all feedback
- Keep PRs focused and small (<400 lines)
- Write descriptive commit messages

---

## Next Steps

1. ✅ Complete quick start setup
2. ✅ Explore codebase structure
3. ✅ Run tests successfully
4. 📖 Read architecture docs
5. 🐛 Fix a "good first issue"
6. 🚀 Implement your first feature
7. 👥 Join team standup

**Welcome aboard! Happy coding! 🚀**

---

*Developer Onboarding Guide - Version 1.0.0*
*Questions? Ask in #edge-storage-dev*
