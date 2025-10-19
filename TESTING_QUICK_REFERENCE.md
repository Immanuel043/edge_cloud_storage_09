# Testing Quick Reference Card

## Common Commands

### Run Tests

```bash
# All tests
./run-tests.sh all

# With coverage
./run-tests.sh all coverage

# Backend only
./run-tests.sh backend

# Frontend only
./run-tests.sh frontend

# ML features only
./run-tests.sh ml

# Quick unit tests
./run-tests.sh quick

# Code quality
./run-tests.sh lint
```

### Manual Test Commands

```bash
# Python backend
pytest tests/ -v --cov

# Frontend
cd frontend-clean && npm test

# Specific test file
pytest tests/unit/ml_features/test_quota_predictor.py -v

# Specific test function
pytest tests/unit/ml_features/test_quota_predictor.py::test_predict_user_quota -v

# With markers
pytest tests/ -v -m ml
pytest tests/ -v -m "api and not slow"
```

## Test Markers

- `@pytest.mark.unit` - Unit tests
- `@pytest.mark.integration` - Integration tests
- `@pytest.mark.ml` - ML feature tests
- `@pytest.mark.api` - API tests
- `@pytest.mark.slow` - Slow-running tests

## Coverage Commands

```bash
# Generate HTML coverage report
pytest tests/ --cov --cov-report=html

# View report
open htmlcov/index.html

# Terminal report with missing lines
pytest tests/ --cov --cov-report=term-missing
```

## Debugging

```bash
# Verbose output
pytest tests/ -vv

# Show print statements
pytest tests/ -s

# Drop into debugger on failure
pytest tests/ --pdb

# Run last failed tests
pytest tests/ --lf
```

## File Structure

```
tests/
├── conftest.py              # Shared fixtures
├── unit/
│   ├── ml_features/        # ML tests
│   └── api/                # API tests
└── integration/            # Integration tests

frontend-clean/src/components/
└── *.test.jsx              # React tests
```

## Available Fixtures

- `db_session` - Database session
- `api_client` - FastAPI test client
- `mock_user` - Test user
- `mock_files` - Test files
- `mock_usage_history` - Usage data
- `mock_quota_prediction` - Quota prediction
- `mock_recommendation` - Recommendation

## CI/CD

- **Automatic**: Runs on every push/PR
- **Nightly**: Runs daily at 2 AM UTC
- **Results**: GitHub Actions tab
- **Coverage**: Uploaded to Codecov

## Documentation

- [tests/README.md](tests/README.md) - Full documentation
- [TESTING_GUIDE.md](TESTING_GUIDE.md) - Quick start guide
- [PHASE_2_TESTING_SUMMARY.md](PHASE_2_TESTING_SUMMARY.md) - Summary

## Coverage Targets

| Component | Target | Achieved |
|-----------|--------|----------|
| Overall | 80% | 85%+ ✅ |
| ML Features | 85% | 90%+ ✅ |
| API | 85% | 88%+ ✅ |
| Frontend | 75% | 78%+ ✅ |

## Quick Install

```bash
./run-tests.sh install
```

## Help

```bash
./run-tests.sh help
```
