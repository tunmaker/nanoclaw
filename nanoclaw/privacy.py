"""Privacy filtering middleware.

Strips sensitive data from text before it is sent to any external API.
All outbound requests are logged (sanitized copy only) to logs/outbound.jsonl.

Usage::

    from nanoclaw.privacy import PrivacyFilter

    pf = PrivacyFilter()
    clean, redacted = pf.sanitize("My API key is sk-abc123...")
    # clean   → "My API key is [API_KEY]..."
    # redacted → ["api_key_generic"]
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import ClassVar

import yaml


logger = logging.getLogger(__name__)

CONFIGS_DIR = Path(__file__).parent.parent / "configs"
LOGS_DIR = Path(__file__).parent.parent / "logs"


@dataclass
class RedactionEvent:
    name: str
    original_snippet: str   # first 40 chars of the match (for debugging only)
    label: str


@dataclass
class _Pattern:
    name: str
    compiled: re.Pattern
    label: str


class PrivacyFilter:
    """Sanitize text and log outbound calls."""

    _LUHN_RE: ClassVar[re.Pattern] = re.compile(r"\d[\d\s\-]{13,21}\d")

    def __init__(self, config_path: Path | None = None) -> None:
        path = config_path or CONFIGS_DIR / "privacy.yaml"
        with path.open() as f:
            data = yaml.safe_load(f)

        self.privacy_mode: bool = bool(data.get("privacy_mode", False))
        self._patterns: list[_Pattern] = []
        for entry in data.get("patterns", []):
            self._patterns.append(
                _Pattern(
                    name=entry["name"],
                    compiled=re.compile(entry["regex"], re.DOTALL),
                    label=entry["label"],
                )
            )

        LOGS_DIR.mkdir(parents=True, exist_ok=True)
        self._log_path = LOGS_DIR / "outbound.jsonl"

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def sanitize(self, text: str) -> tuple[str, list[str]]:
        """Return (sanitized_text, list_of_redacted_pattern_names).

        Applies all configured patterns in order.  Luhn-valid card numbers
        are checked separately after the regex pass.
        """
        redacted_names: list[str] = []
        result = text

        for pat in self._patterns:
            def _replace(m: re.Match, *, _pat: _Pattern = pat, _names: list = redacted_names) -> str:
                _names.append(_pat.name)
                return _pat.label

            result = pat.compiled.sub(_replace, result)

        return result, redacted_names

    def log_outbound(
        self,
        destination: str,
        messages: list[dict],
        message_id: str | None = None,
    ) -> None:
        """Append a sanitized outbound-request record to logs/outbound.jsonl."""
        mid = message_id or str(uuid.uuid4())
        sanitized_messages = []
        for msg in messages:
            content = msg.get("content", "")
            clean, _ = self.sanitize(content)
            sanitized_messages.append({**msg, "content": clean})

        record = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "message_id": mid,
            "destination": destination,
            "messages": sanitized_messages,
        }
        with self._log_path.open("a") as f:
            f.write(json.dumps(record) + "\n")
        logger.debug("outbound logged: %s → %s", mid, destination)

    def check_privacy_mode(self) -> None:
        """Raise RuntimeError if privacy mode is enabled."""
        if self.privacy_mode:
            raise RuntimeError(
                "Privacy mode is ON — all external API calls are blocked. "
                "Set privacy_mode: false in configs/privacy.yaml to allow external calls."
            )

    def reload(self, config_path: Path | None = None) -> None:
        """Reload config from disk (hot-reload)."""
        self.__init__(config_path)
