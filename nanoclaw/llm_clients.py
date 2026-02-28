"""Thin async wrappers for the local LLM and Claude SDK."""
from __future__ import annotations

import os
from typing import Any

import httpx


LOCAL_BASE_URL = os.environ.get("LOCAL_LLM_URL", "http://localhost:8080/v1")
LOCAL_MODEL = "default"


async def local_llm(
    messages: list[dict[str, str]],
    max_tokens: int = 1024,
    **kwargs: Any,
) -> str:
    """Send messages to the local llama.cpp OpenAI-compatible API."""
    payload = {
        "model": LOCAL_MODEL,
        "messages": messages,
        "max_tokens": max_tokens,
        **kwargs,
    }
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            f"{LOCAL_BASE_URL}/chat/completions",
            json=payload,
        )
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]


async def claude(
    messages: list[dict[str, str]],
    model: str = "claude-sonnet-4-6",
    max_tokens: int = 1024,
    system: str | None = None,
    **kwargs: Any,
) -> str:
    """Send messages to the Anthropic Claude API."""
    import anthropic  # lazy import — not always needed

    client = anthropic.AsyncAnthropic()
    params: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": messages,
        **kwargs,
    }
    if system:
        params["system"] = system

    response = await client.messages.create(**params)
    return response.content[0].text
