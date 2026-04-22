# tests/test_rate_limiter_v2.py
"""
Unit tests for the rate-limiter identifier functions.

Covers:
  1. Valid access-token cookie → user:<sub> on authenticated identifier.
  2. Typed token (download/reset/register) → IP fallback, never user:.
  3. No token → IP fallback.
  4. IP-only identifier stays IP even when a valid cookie is present
     (protects /auth/login, /register, /forgot-password from per-user leakage).
  5. X-Real-IP is preferred over client.host.
  6. X-Forwarded-For is NOT trusted (spoof-resistance).

Run with:  python -m pytest tests/test_rate_limiter_v2.py -v
"""

import os
import sys

import pytest

os.environ.setdefault('DATABASE_URL', 'postgresql+asyncpg://x:x@localhost:5432/test')
os.environ.setdefault('SECRET_KEY', 'test_secret_key_for_testing_only_32b')

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from jose import jwt  # noqa: E402
from starlette.requests import Request  # noqa: E402

from app.config import settings  # noqa: E402
from app.utils.rate_limiter_v2 import (  # noqa: E402
    get_ip_identifier,
    get_user_or_ip_identifier,
)


def _make_request(
    *,
    cookies: dict | None = None,
    headers: dict | None = None,
    query_string: bytes = b"",
    client: tuple[str, int] | None = ("172.18.0.29", 54321),
) -> Request:
    """Build a minimal starlette Request with the fields the identifiers read."""
    raw_headers = []
    if cookies:
        cookie_str = "; ".join(f"{k}={v}" for k, v in cookies.items())
        raw_headers.append((b"cookie", cookie_str.encode()))
    if headers:
        for k, v in headers.items():
            raw_headers.append((k.lower().encode(), v.encode()))
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/",
        "headers": raw_headers,
        "query_string": query_string,
        "client": client,
    }
    return Request(scope)


def _valid_token(sub: str = "dd2fd8b2-f84b-432d-b4dc-a5abdafe34fe", token_type=None) -> str:
    payload = {"sub": sub}
    if token_type is not None:
        payload["type"] = token_type
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


@pytest.mark.asyncio
async def test_valid_cookie_returns_user_id():
    token = _valid_token("user-abc")
    req = _make_request(
        cookies={"access_token": token},
        headers={"x-real-ip": "8.8.8.8"},
    )
    assert await get_user_or_ip_identifier(req) == "user:user-abc"


@pytest.mark.asyncio
async def test_valid_bearer_returns_user_id():
    token = _valid_token("user-bearer")
    req = _make_request(
        headers={"authorization": f"Bearer {token}"},
    )
    assert await get_user_or_ip_identifier(req) == "user:user-bearer"


@pytest.mark.asyncio
async def test_typed_token_falls_back_to_ip():
    token = _valid_token("user-typed", token_type="download")
    req = _make_request(
        cookies={"access_token": token},
        headers={"x-real-ip": "8.8.8.8"},
    )
    result = await get_user_or_ip_identifier(req)
    assert result == "ip:8.8.8.8"
    assert not result.startswith("user:")


@pytest.mark.asyncio
async def test_no_token_returns_ip():
    req = _make_request(headers={"x-real-ip": "8.8.8.8"})
    assert await get_user_or_ip_identifier(req) == "ip:8.8.8.8"


@pytest.mark.asyncio
async def test_invalid_token_returns_ip():
    req = _make_request(
        cookies={"access_token": "not-a-real-jwt"},
        headers={"x-real-ip": "8.8.8.8"},
    )
    assert await get_user_or_ip_identifier(req) == "ip:8.8.8.8"


@pytest.mark.asyncio
async def test_ip_identifier_ignores_valid_cookie():
    """
    Auth routes (/auth/login, /register/*, /forgot-password*) use this
    identifier. Even if the browser already holds a valid access_token
    cookie, the bucket MUST remain IP-scoped so brute-force protection
    isn't defeated by one attacker rotating sessions.
    """
    token = _valid_token("user-xyz")
    req = _make_request(
        cookies={"access_token": token},
        headers={"x-real-ip": "8.8.8.8"},
    )
    result = await get_ip_identifier(req)
    assert result == "ip:8.8.8.8"
    assert "user:" not in result


@pytest.mark.asyncio
async def test_x_real_ip_preferred_over_client_host():
    req = _make_request(
        headers={"x-real-ip": "1.2.3.4"},
        client=("172.18.0.29", 54321),
    )
    assert await get_ip_identifier(req) == "ip:1.2.3.4"


@pytest.mark.asyncio
async def test_x_forwarded_for_is_not_trusted():
    """
    A client supplying X-Forwarded-For must NOT be able to pick its own
    bucket. We ignore XFF and fall back to the direct peer when X-Real-IP
    is absent. (In production, nginx always sets X-Real-IP, so this path
    is a local-dev fallback — but it must not read XFF.)
    """
    req = _make_request(
        headers={"x-forwarded-for": "9.9.9.9, 10.10.10.10"},
        client=("172.18.0.29", 54321),
    )
    result = await get_ip_identifier(req)
    assert result == "ip:172.18.0.29"
    assert "9.9.9.9" not in result
