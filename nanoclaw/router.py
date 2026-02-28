"""Task-based routing engine.

Decides whether each message goes to the local LLM or the Claude SDK.
Rules are loaded from configs/routing.yaml — no logic is hard-coded here.

CLI usage:
    python -m nanoclaw.router --test "your message here"
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import re
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import yaml


logger = logging.getLogger(__name__)

TARGET = Literal["local", "claude"]
CONFIGS_DIR = Path(__file__).parent.parent / "configs"


@dataclass
class RoutingDecision:
    message_id: str
    routed_to: TARGET
    rule_name: str
    reason: str
    message_preview: str = ""

    def as_log(self) -> dict:
        return {
            "message_id": self.message_id,
            "routed_to": self.routed_to,
            "rule_name": self.rule_name,
            "reason": self.reason,
        }


@dataclass
class Rule:
    name: str
    priority: int
    target: TARGET
    reason: str
    keyword_sets: list[list[str]] = field(default_factory=list)
    regex_patterns: list[re.Pattern] = field(default_factory=list)

    def matches(self, text: str) -> bool:
        """Return True if any pattern in this rule matches the text."""
        lower = text.lower()
        for keywords in self.keyword_sets:
            if any(kw.lower() in lower for kw in keywords):
                return True
        for pattern in self.regex_patterns:
            if pattern.search(text):
                return True
        # Empty pattern list means this is a catch-all (default rule)
        if not self.keyword_sets and not self.regex_patterns:
            return True
        return False


def _load_rules(config_path: Path | None = None) -> list[Rule]:
    path = config_path or CONFIGS_DIR / "routing.yaml"
    with path.open() as f:
        data = yaml.safe_load(f)

    rules: list[Rule] = []
    for entry in data.get("rules", []):
        keyword_sets: list[list[str]] = []
        regex_patterns: list[re.Pattern] = []

        for pat in entry.get("patterns", []):
            if pat["type"] == "keyword":
                keyword_sets.append(pat["values"])
            elif pat["type"] == "regex":
                regex_patterns.append(re.compile(pat["value"]))

        rules.append(
            Rule(
                name=entry["name"],
                priority=entry["priority"],
                target=entry["target"],
                reason=entry["reason"],
                keyword_sets=keyword_sets,
                regex_patterns=regex_patterns,
            )
        )

    return sorted(rules, key=lambda r: r.priority)


class Router:
    """Async message router.

    Usage::

        router = Router()
        decision = await router.route("write a binary search in Python")
        print(decision.routed_to)  # "claude"
    """

    def __init__(self, config_path: Path | None = None) -> None:
        self._rules = _load_rules(config_path)

    def reload(self, config_path: Path | None = None) -> None:
        """Hot-reload routing rules from disk."""
        self._rules = _load_rules(config_path)

    async def route(
        self,
        message: str,
        message_id: str | None = None,
    ) -> RoutingDecision:
        """Return a routing decision for *message*."""
        mid = message_id or str(uuid.uuid4())

        for rule in self._rules:
            if rule.matches(message):
                decision = RoutingDecision(
                    message_id=mid,
                    routed_to=rule.target,
                    rule_name=rule.name,
                    reason=rule.reason,
                    message_preview=message[:80],
                )
                logger.info("routing decision: %s", json.dumps(decision.as_log()))
                return decision

        # Should never reach here because the default rule always matches.
        decision = RoutingDecision(
            message_id=mid,
            routed_to="local",
            rule_name="fallback",
            reason="no rule matched — defaulting to local",
            message_preview=message[:80],
        )
        logger.warning("routing fallback: %s", json.dumps(decision.as_log()))
        return decision


# ---------------------------------------------------------------------------
# CLI entry-point
# ---------------------------------------------------------------------------

def _cli() -> None:
    parser = argparse.ArgumentParser(
        prog="python -m nanoclaw.router",
        description="Show the routing decision for a message.",
    )
    parser.add_argument("--test", metavar="MESSAGE", required=True, help="Message to route")
    parser.add_argument(
        "--config",
        metavar="PATH",
        default=None,
        help="Path to routing.yaml (default: configs/routing.yaml)",
    )
    args = parser.parse_args()

    router = Router(config_path=Path(args.config) if args.config else None)
    decision = asyncio.run(router.route(args.test))

    print(json.dumps(
        {
            "message": args.test,
            "routed_to": decision.routed_to,
            "rule": decision.rule_name,
            "reason": decision.reason,
        },
        indent=2,
    ))


if __name__ == "__main__":
    _cli()
