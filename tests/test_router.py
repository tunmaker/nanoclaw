"""Unit tests for nanoclaw.router — all rule paths covered."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Allow imports from the repo root
sys.path.insert(0, str(Path(__file__).parent.parent))

from nanoclaw.router import Router


@pytest.fixture()
def router() -> Router:
    return Router()


# ---------------------------------------------------------------------------
# Rule 1: sensitive content → local
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_sensitive_personal_family(router: Router) -> None:
    d = await router.route("what's my wife's name?")
    assert d.routed_to == "local"
    assert d.rule_name == "sensitive_content"


@pytest.mark.asyncio
async def test_sensitive_personal_kids(router: Router) -> None:
    d = await router.route("remind me what school my kids go to")
    assert d.routed_to == "local"
    assert d.rule_name == "sensitive_content"


@pytest.mark.asyncio
async def test_sensitive_password_keyword(router: Router) -> None:
    d = await router.route("my password is hunter2")
    assert d.routed_to == "local"
    assert d.rule_name == "sensitive_content"


@pytest.mark.asyncio
async def test_sensitive_api_key_inline(router: Router) -> None:
    d = await router.route("here is my api_key=supersecretvalue123")
    assert d.routed_to == "local"
    assert d.rule_name == "sensitive_content"


# ---------------------------------------------------------------------------
# Rule 2: coding tasks → claude
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_coding_write_function(router: Router) -> None:
    d = await router.route("write a function to parse JSON in Python")
    assert d.routed_to == "claude"
    assert d.rule_name == "coding_task"


@pytest.mark.asyncio
async def test_coding_binary_search(router: Router) -> None:
    d = await router.route("write a binary search in Python")
    assert d.routed_to == "claude"
    assert d.rule_name == "coding_task"


@pytest.mark.asyncio
async def test_coding_debug(router: Router) -> None:
    d = await router.route("debug this TypeError in my script")
    assert d.routed_to == "claude"
    assert d.rule_name == "coding_task"


@pytest.mark.asyncio
async def test_coding_fenced_block(router: Router) -> None:
    d = await router.route("can you review this:\n```python\ndef foo(): pass\n```")
    assert d.routed_to == "claude"
    assert d.rule_name == "coding_task"


# ---------------------------------------------------------------------------
# Rule 3: real-time info → local
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_realtime_weather(router: Router) -> None:
    d = await router.route("what's the weather today?")
    assert d.routed_to == "local"
    assert d.rule_name == "realtime_info"


@pytest.mark.asyncio
async def test_realtime_news(router: Router) -> None:
    d = await router.route("show me the latest news")
    assert d.routed_to == "local"
    assert d.rule_name == "realtime_info"


# ---------------------------------------------------------------------------
# Rule 4: default → local
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_default_generic_message(router: Router) -> None:
    d = await router.route("hello, how are you?")
    assert d.routed_to == "local"
    assert d.rule_name == "default"


@pytest.mark.asyncio
async def test_default_empty_message(router: Router) -> None:
    d = await router.route("")
    assert d.routed_to == "local"
    assert d.rule_name == "default"


# ---------------------------------------------------------------------------
# Priority: sensitive beats coding
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_priority_sensitive_beats_coding(router: Router) -> None:
    """A message mentioning 'my password' AND 'write a function' should still
    route to local (sensitive_content has higher priority)."""
    d = await router.route("write a function that checks if my password is strong")
    assert d.routed_to == "local"
    assert d.rule_name == "sensitive_content"


# ---------------------------------------------------------------------------
# Decision structure
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_decision_has_message_id(router: Router) -> None:
    d = await router.route("test")
    assert d.message_id
    assert len(d.message_id) > 0


@pytest.mark.asyncio
async def test_decision_custom_message_id(router: Router) -> None:
    d = await router.route("test", message_id="my-id-123")
    assert d.message_id == "my-id-123"


@pytest.mark.asyncio
async def test_decision_as_log(router: Router) -> None:
    d = await router.route("hello")
    log = d.as_log()
    assert "message_id" in log
    assert "routed_to" in log
    assert "reason" in log
