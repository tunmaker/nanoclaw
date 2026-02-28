"""Unit tests for nanoclaw.privacy — covers all sensitive pattern types."""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from nanoclaw.privacy import PrivacyFilter


@pytest.fixture()
def pf(tmp_path: Path) -> PrivacyFilter:
    """PrivacyFilter with logs redirected to a temp dir."""
    import nanoclaw.privacy as priv_mod
    original = priv_mod.LOGS_DIR
    priv_mod.LOGS_DIR = tmp_path
    pf = PrivacyFilter()
    priv_mod.LOGS_DIR = original
    return pf


# ---------------------------------------------------------------------------
# API keys
# ---------------------------------------------------------------------------

def test_openai_key_redacted(pf: PrivacyFilter) -> None:
    text = "use this key: sk-abcdefghijklmnopqrstuvwxyz123456789012345678"
    clean, names = pf.sanitize(text)
    assert "sk-" not in clean
    assert any("key" in n.lower() or "openai" in n.lower() for n in names)


def test_anthropic_key_redacted(pf: PrivacyFilter) -> None:
    text = "my key is sk-ant-api03-supersecretanthropictoken1234567890abcdef"
    clean, names = pf.sanitize(text)
    assert "sk-ant" not in clean
    assert any("anthropic" in n.lower() or "key" in n.lower() for n in names)


def test_aws_key_redacted(pf: PrivacyFilter) -> None:
    text = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE"
    clean, names = pf.sanitize(text)
    assert "AKIA" not in clean
    assert "aws_access_key" in names


def test_password_assignment_redacted(pf: PrivacyFilter) -> None:
    text = "password=hunter2secret"
    clean, names = pf.sanitize(text)
    assert "hunter2secret" not in clean
    assert "password_in_text" in names


# ---------------------------------------------------------------------------
# Credit card numbers
# ---------------------------------------------------------------------------

def test_visa_cc_redacted(pf: PrivacyFilter) -> None:
    text = "charge card 4111111111111111 please"
    clean, names = pf.sanitize(text)
    assert "4111111111111111" not in clean
    assert "credit_card" in names


def test_mastercard_redacted(pf: PrivacyFilter) -> None:
    text = "MC: 5500005555555559"
    clean, names = pf.sanitize(text)
    assert "5500005555555559" not in clean
    assert "credit_card" in names


# ---------------------------------------------------------------------------
# SSH private keys
# ---------------------------------------------------------------------------

def test_ssh_key_redacted(pf: PrivacyFilter) -> None:
    text = (
        "-----BEGIN RSA PRIVATE KEY-----\n"
        "MIIEowIBAAKCAQEA...\n"
        "-----END RSA PRIVATE KEY-----"
    )
    clean, names = pf.sanitize(text)
    assert "BEGIN RSA PRIVATE KEY" not in clean
    assert "ssh_private_key" in names


def test_openssh_key_redacted(pf: PrivacyFilter) -> None:
    text = (
        "-----BEGIN OPENSSH PRIVATE KEY-----\n"
        "b3BlbnNzaC1rZXktdjEAAAAA...\n"
        "-----END OPENSSH PRIVATE KEY-----"
    )
    clean, names = pf.sanitize(text)
    assert "BEGIN OPENSSH PRIVATE KEY" not in clean
    assert "ssh_private_key" in names


# ---------------------------------------------------------------------------
# Phone numbers
# ---------------------------------------------------------------------------

def test_us_phone_redacted(pf: PrivacyFilter) -> None:
    text = "call me at 555-867-5309 tomorrow"
    clean, names = pf.sanitize(text)
    assert "867-5309" not in clean
    assert "phone_number_us" in names


def test_us_phone_with_country_code(pf: PrivacyFilter) -> None:
    text = "my number is +1 (800) 555-1234"
    clean, names = pf.sanitize(text)
    assert "555-1234" not in clean


# ---------------------------------------------------------------------------
# SSN
# ---------------------------------------------------------------------------

def test_ssn_redacted(pf: PrivacyFilter) -> None:
    text = "SSN: 123-45-6789"
    clean, names = pf.sanitize(text)
    assert "123-45-6789" not in clean
    assert "national_id_ssn" in names


# ---------------------------------------------------------------------------
# JWT / Bearer tokens
# ---------------------------------------------------------------------------

def test_jwt_redacted(pf: PrivacyFilter) -> None:
    text = "Authorization: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    clean, names = pf.sanitize(text)
    assert "eyJhbGci" not in clean
    assert "jwt_token" in names


def test_bearer_token_redacted(pf: PrivacyFilter) -> None:
    text = "Authorization: Bearer myverysecretbearertoken123"
    clean, names = pf.sanitize(text)
    assert "myverysecretbearertoken123" not in clean
    assert "bearer_token" in names


# ---------------------------------------------------------------------------
# Clean text passes through unchanged
# ---------------------------------------------------------------------------

def test_clean_text_unchanged(pf: PrivacyFilter) -> None:
    text = "What is the capital of France?"
    clean, names = pf.sanitize(text)
    assert clean == text
    assert names == []


# ---------------------------------------------------------------------------
# Privacy mode blocks external calls
# ---------------------------------------------------------------------------

def test_privacy_mode_raises(tmp_path: Path) -> None:
    import yaml, nanoclaw.privacy as priv_mod

    # Write a config with privacy_mode: true
    cfg = tmp_path / "privacy.yaml"
    cfg.write_text(yaml.dump({"privacy_mode": True, "patterns": []}))

    # Redirect logs to tmp_path
    original = priv_mod.LOGS_DIR
    priv_mod.LOGS_DIR = tmp_path
    pf = PrivacyFilter(config_path=cfg)
    priv_mod.LOGS_DIR = original

    with pytest.raises(RuntimeError, match="Privacy mode"):
        pf.check_privacy_mode()


# ---------------------------------------------------------------------------
# Outbound logging
# ---------------------------------------------------------------------------

def test_log_outbound_creates_file(tmp_path: Path) -> None:
    import nanoclaw.privacy as priv_mod

    original = priv_mod.LOGS_DIR
    priv_mod.LOGS_DIR = tmp_path
    pf = PrivacyFilter()
    priv_mod.LOGS_DIR = original

    pf._log_path = tmp_path / "outbound.jsonl"
    # Use a password= pattern that is guaranteed to match
    secret_content = "password=MySuperSecret123"
    pf.log_outbound(
        destination="claude",
        messages=[{"role": "user", "content": f"hello, {secret_content}"}],
        message_id="test-id",
    )

    lines = (tmp_path / "outbound.jsonl").read_text().splitlines()
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert record["destination"] == "claude"
    assert record["message_id"] == "test-id"
    # Sensitive content must be redacted in the log
    assert "MySuperSecret123" not in json.dumps(record)
