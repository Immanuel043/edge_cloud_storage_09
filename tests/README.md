# Edge Cloud Storage - Testing Documentation

Comprehensive testing suite for all AI/ML features, API endpoints, and services.

## Table of Contents

- [Overview](#overview)
- [Test Structure](#test-structure)
- [Running Tests](#running-tests)
- [Test Coverage](#test-coverage)
- [Writing Tests](#writing-tests)
- [CI/CD Integration](#cicd-integration)
- [Troubleshooting](#troubleshooting)

---

## Overview

This test suite provides comprehensive coverage for:

- **4 AI/ML Features**: Predictive Quota Alerts, Storage Optimization, Auto-Organization, Content Recommendations
- **API Endpoints**: REST API tests for all features
- **Integration Tests**: End-to-end workflow testing
- **Frontend Tests**: React component and UI testing
- **Backend Services**: Python FastAPI and Node.js Express services

### Test Statistics

| Component | Test Files | Test Cases | Coverage Target |
|-----------|-----------|------------|-----------------|
| ML Features | 4 | ~150 | 80%+ |
| API Endpoints | 10+ | ~200 | 85%+ |
| Integration | 5 | ~50 | 70%+ |
| Frontend | 15+ | ~100 | 75%+ |
| **Total** | **30+** | **~500** | **80%+** |

---

## Test Structure

```
tests/
├── __init__.py                 # Test package initialization
├── conftest.py                 # Shared pytest fixtures
├── README.md                   # This file
│
├── unit/                       # Unit tests (isolated components)
│   ├── ml_features/           # AI/ML feature tests
│   │   ├── test_quota_predictor.py
│   │   ├── test_storage_optimizer.py
│   │   ├── test_auto_organizer.py
│   │   └── test_recommendation_engine.py
│   │
│   ├── api/                   # API endpoint tests
│   │   ├── test_quota_analytics_api.py
│   │   ├── test_storage_optimization_api.py
│   │   ├── test_auto_organization_api.py
│   │   └── test_recommendations_api.py
│   │
│   ├── services/              # Service layer tests
│   │   └── ...
│   │
│   └── workers/               # Background worker tests
│       └── ...
│
├── integration/               # Integration tests (workflows)
│   ├── test_ml_workflow.py
│   ├── test_file_upload_workflow.py
│   └── test_tier_migration_workflow.py
│
└── e2e/                       # End-to-end tests (optional)
    └── ...
```

### Frontend Tests

```
frontend-clean/
├── src/
│   ├── components/
│   │   ├── Dashboard.test.jsx
│   │   ├── StorageOptimization.test.jsx
│   │   └── ...
│   └── test/
│       └── setup.js
├── vitest.config.js
└── package.json
```

---

## Running Tests

### Backend (Python) Tests

#### Run all tests

```bash
pytest tests/ -v
```

#### Run specific test categories

```bash
# Unit tests only
pytest tests/unit/ -v

# Integration tests only
pytest tests/integration/ -v

# ML feature tests only
pytest tests/unit/ml_features/ -v -m ml

# API tests only
pytest tests/unit/api/ -v -m api
```

#### Run tests with coverage

```bash
# All tests with coverage
pytest tests/ -v --cov=services/storage-service/app --cov-report=html

# View coverage report
open htmlcov/index.html
```

#### Run specific test file or function

```bash
# Specific file
pytest tests/unit/ml_features/test_quota_predictor.py -v

# Specific test function
pytest tests/unit/ml_features/test_quota_predictor.py::TestQuotaPredictor::test_predict_user_quota -v
```

### Frontend (React) Tests

```bash
cd frontend-clean

# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run tests with UI
npm run test:ui
```

### Backend (Node.js) Tests

```bash
cd services/web-service

# Run all tests
npm test

# Run with coverage
npm test -- --coverage
```

---

## Test Coverage

### Coverage Goals

- **Overall**: 80%+ coverage
- **ML Features**: 85%+ coverage (critical business logic)
- **API Endpoints**: 85%+ coverage
- **Services**: 80%+ coverage
- **Frontend**: 75%+ coverage

### Checking Coverage

#### Python Backend

```bash
# Generate coverage report
pytest tests/ --cov=services/storage-service/app --cov-report=html --cov-report=term-missing

# View detailed report
open htmlcov/index.html
```

#### Frontend

```bash
cd frontend-clean
npm run test:coverage

# View report
open coverage/index.html
```

### Coverage Reports

Coverage reports are automatically generated and uploaded to Codecov in CI/CD.

---

## Writing Tests

### Python Test Example

```python
import pytest
from app.services.quota_predictor import QuotaPredictor

class TestQuotaPredictor:
    @pytest.fixture
    def quota_predictor(self, db_session, mock_settings):
        return QuotaPredictor(db=db_session, settings=mock_settings)

    @pytest.mark.asyncio
    async def test_predict_user_quota(self, quota_predictor, mock_user):
        result = await quota_predictor.predict_user_quota(
            user_id=mock_user.id,
            days_ahead=7
        )

        assert result is not None
        assert "predicted_usage_bytes" in result
        assert result["predicted_usage_bytes"] > 0
```

### React Test Example

```javascript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Dashboard from './Dashboard';

describe('Dashboard Component', () => {
  it('renders dashboard layout', () => {
    render(<Dashboard />);
    expect(screen.getByText(/dashboard/i)).toBeInTheDocument();
  });
});
```

### Test Markers (Python)

Use pytest markers to categorize tests:

```python
@pytest.mark.unit        # Unit tests
@pytest.mark.integration # Integration tests
@pytest.mark.ml          # ML feature tests
@pytest.mark.api         # API tests
@pytest.mark.slow        # Slow-running tests
```

Run specific markers:

```bash
pytest tests/ -v -m unit
pytest tests/ -v -m "ml and not slow"
```

---

## CI/CD Integration

### GitHub Actions Workflows

#### Main Test Workflow (`.github/workflows/test.yml`)

Runs on every push and pull request:

- Backend Python tests
- Frontend React tests
- Web service Node.js tests
- Linting and code quality checks

#### Nightly Test Workflow (`.github/workflows/nightly-tests.yml`)

Runs daily at 2 AM UTC:

- Comprehensive ML feature tests
- Performance tests
- Security scanning

### Triggering CI/CD

```bash
# Push to trigger tests
git push origin your-branch

# Create pull request (automatic)
gh pr create
```

### Viewing Test Results

1. Go to GitHub Actions tab
2. Click on the workflow run
3. View test results and coverage reports

---

## Test Fixtures

### Available Fixtures (Python)

Located in `tests/conftest.py`:

- `db_session`: Database session
- `api_client`: FastAPI test client
- `mock_user`: Test user
- `mock_users`: Multiple test users
- `mock_file`: Test file
- `mock_files`: Multiple test files
- `mock_usage_history`: Usage history data
- `mock_quota_prediction`: Quota prediction
- `mock_quota_alert`: Quota alert
- `mock_optimization_suggestion`: Optimization suggestion
- `mock_clustering_session`: Clustering session
- `mock_recommendation`: Content recommendation
- `mock_redis`: Mock Redis client
- `mock_kafka_producer`: Mock Kafka producer

### Using Fixtures

```python
def test_example(mock_user, db_session):
    # Use fixtures in your test
    assert mock_user.id is not None
```

---

## Troubleshooting

### Common Issues

#### Issue: Tests fail with database connection errors

**Solution:**
```bash
# Ensure test database is configured
export DATABASE_URL="sqlite:///:memory:"
export TESTING=true
pytest tests/
```

#### Issue: Import errors in tests

**Solution:**
```bash
# Add services to Python path
export PYTHONPATH="${PYTHONPATH}:${PWD}/services/storage-service"
pytest tests/
```

#### Issue: Frontend tests fail with "Cannot find module"

**Solution:**
```bash
cd frontend-clean
npm install
npm test
```

#### Issue: Slow test execution

**Solution:**
```bash
# Run tests in parallel
pytest tests/ -n auto

# Skip slow tests
pytest tests/ -v -m "not slow"
```

### Debugging Tests

#### Python

```bash
# Run with verbose output
pytest tests/ -vv

# Run with print statements visible
pytest tests/ -s

# Run with debugger
pytest tests/ --pdb
```

#### JavaScript

```bash
# Run in watch mode
npm run test:watch

# Run with UI for debugging
npm run test:ui
```

---

## Best Practices

### 1. Test Isolation

- Each test should be independent
- Use fixtures for setup/teardown
- Don't rely on test execution order

### 2. Test Naming

- Use descriptive names: `test_predict_user_quota_with_history`
- Follow convention: `test_<what>_<condition>_<expected>`

### 3. Assertions

- Use specific assertions
- Add assertion messages for clarity
- Test both happy path and edge cases

### 4. Mocking

- Mock external dependencies (Redis, Kafka, etc.)
- Don't mock the code you're testing
- Use fixtures for common mocks

### 5. Coverage

- Aim for 80%+ coverage
- Focus on critical paths
- Don't sacrifice quality for 100% coverage

---

## Test Metrics

### Running Test Metrics

```bash
# Python: Generate test report
pytest tests/ --junit-xml=test-results.xml

# Frontend: Generate test report
cd frontend-clean
npm run test:coverage -- --reporter=junit --outputFile=test-results.xml
```

### Analyzing Results

Test metrics are collected in CI/CD and displayed in GitHub Actions.

---

## Additional Resources

- [pytest Documentation](https://docs.pytest.org/)
- [Vitest Documentation](https://vitest.dev/)
- [Testing Library](https://testing-library.com/)
- [FastAPI Testing](https://fastapi.tiangolo.com/tutorial/testing/)

---

## Contact

For questions or issues with tests:

1. Check this documentation
2. Review existing test examples
3. Open an issue on GitHub
4. Contact the development team

---

**Last Updated**: October 2025
**Maintained By**: Edge Cloud Storage Team
