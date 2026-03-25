"""
Test bootstrap for ES sync tests.
Sets required env vars BEFORE importing any storage-service module.
"""
import os
import sys

# config.py:228-285 validates DATABASE_URL, SECRET_KEY, and ENCRYPTION_MASTER_KEY at import time
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost:5432/test")
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only-32b")
# ENCRYPTION_MASTER_KEY must be valid base64 decoding to exactly 32 bytes (config.py:276-278)
os.environ.setdefault("ENCRYPTION_MASTER_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
os.environ.setdefault("ELASTICSEARCH_ENABLED", "true")

# Add storage-service to path so `from app.*` imports resolve
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "storage-service"))
