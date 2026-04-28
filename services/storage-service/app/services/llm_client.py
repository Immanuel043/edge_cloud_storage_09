"""
OpenAI-compatible LLM client for document summarization and smart naming.

Uses existing httpx dependency — no new pip install required.
"""

import logging

import httpx
from app.config import settings

logger = logging.getLogger(__name__)

_TIMEOUT = httpx.Timeout(60.0, connect=10.0)


class LLMClient:
    """Async OpenAI-compatible chat completions client."""

    def __init__(
        self,
        api_key: str | None = None,
        api_url: str | None = None,
        model: str | None = None,
        max_tokens: int | None = None,
    ):
        self.api_key = api_key or settings.LLM_API_KEY
        self.api_url = (api_url or settings.LLM_API_URL).rstrip("/")
        self.model = model or settings.LLM_MODEL
        self.max_tokens = max_tokens or settings.LLM_MAX_TOKENS

    async def complete(
        self,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int | None = None,
    ) -> str:
        """Send a chat completion request and return the assistant message text."""
        url = f"{self.api_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "max_tokens": max_tokens or self.max_tokens,
            "temperature": 0.3,
        }

        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()

        return data["choices"][0]["message"]["content"].strip()

    async def is_available(self) -> bool:
        """Check if the LLM service is reachable and configured."""
        if not self.api_key or not settings.LLM_ENABLED:
            return False
        try:
            url = f"{self.api_url}/models"
            headers = {"Authorization": f"Bearer {self.api_key}"}
            async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
                resp = await client.get(url, headers=headers)
                return resp.status_code == 200
        except Exception:
            return False


# Module-level singleton
llm_client = LLMClient()
