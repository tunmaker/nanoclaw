/**
 * Unit tests for src/privacy.ts — covers all sensitive pattern types.
 * Ported 1:1 from tests/test_privacy.py.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { stringify } from 'yaml';

import { PrivacyFilter } from './privacy.js';

let tmpDir: string;
let pf: PrivacyFilter;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-privacy-test-'));
  pf = new PrivacyFilter(undefined, tmpDir);
});

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

describe('API key redaction', () => {
  it('redacts OpenAI-style key', () => {
    const text = 'use this key: sk-abcdefghijklmnopqrstuvwxyz123456789012345678';
    const [clean, names] = pf.sanitize(text);
    expect(clean).not.toContain('sk-');
    expect(names.some((n) => n.toLowerCase().includes('key') || n.toLowerCase().includes('openai'))).toBe(true);
  });

  it('redacts Anthropic key', () => {
    const text = 'my key is sk-ant-api03-supersecretanthropictoken1234567890abcdef';
    const [clean, names] = pf.sanitize(text);
    expect(clean).not.toContain('sk-ant');
    expect(names.some((n) => n.toLowerCase().includes('anthropic') || n.toLowerCase().includes('key'))).toBe(true);
  });

  it('redacts AWS access key', () => {
    const text = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
    const [clean, names] = pf.sanitize(text);
    expect(clean).not.toContain('AKIA');
    expect(names).toContain('aws_access_key');
  });

  it('redacts password assignment', () => {
    const text = 'password=hunter2secret';
    const [clean, names] = pf.sanitize(text);
    expect(clean).not.toContain('hunter2secret');
    expect(names).toContain('password_in_text');
  });
});

// ---------------------------------------------------------------------------
// Credit card numbers
// ---------------------------------------------------------------------------

describe('credit card redaction', () => {
  it('redacts Visa card number', () => {
    const text = 'charge card 4111111111111111 please';
    const [clean, names] = pf.sanitize(text);
    expect(clean).not.toContain('4111111111111111');
    expect(names).toContain('credit_card');
  });

  it('redacts Mastercard number', () => {
    const text = 'MC: 5500005555555559';
    const [clean, names] = pf.sanitize(text);
    expect(clean).not.toContain('5500005555555559');
    expect(names).toContain('credit_card');
  });
});

// ---------------------------------------------------------------------------
// SSH private keys
// ---------------------------------------------------------------------------

describe('SSH private key redaction', () => {
  it('redacts RSA private key', () => {
    const text = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA...',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const [clean, names] = pf.sanitize(text);
    expect(clean).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(names).toContain('ssh_private_key');
  });

  it('redacts OpenSSH private key', () => {
    const text = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAA...',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const [clean, names] = pf.sanitize(text);
    expect(clean).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(names).toContain('ssh_private_key');
  });
});

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

describe('phone number redaction', () => {
  it('redacts US phone number', () => {
    const text = 'call me at 555-867-5309 tomorrow';
    const [clean, names] = pf.sanitize(text);
    expect(clean).not.toContain('867-5309');
    expect(names).toContain('phone_number_us');
  });

  it('redacts US phone with country code', () => {
    const text = 'my number is +1 (800) 555-1234';
    const [clean] = pf.sanitize(text);
    expect(clean).not.toContain('555-1234');
  });
});

// ---------------------------------------------------------------------------
// SSN
// ---------------------------------------------------------------------------

describe('SSN redaction', () => {
  it('redacts Social Security Number', () => {
    const text = 'SSN: 123-45-6789';
    const [clean, names] = pf.sanitize(text);
    expect(clean).not.toContain('123-45-6789');
    expect(names).toContain('national_id_ssn');
  });
});

// ---------------------------------------------------------------------------
// JWT / Bearer tokens
// ---------------------------------------------------------------------------

describe('token redaction', () => {
  it('redacts JWT token', () => {
    const text =
      'Authorization: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const [clean, names] = pf.sanitize(text);
    expect(clean).not.toContain('eyJhbGci');
    expect(names).toContain('jwt_token');
  });

  it('redacts Bearer token', () => {
    const text = 'Authorization: Bearer myverysecretbearertoken123';
    const [clean, names] = pf.sanitize(text);
    expect(clean).not.toContain('myverysecretbearertoken123');
    expect(names).toContain('bearer_token');
  });
});

// ---------------------------------------------------------------------------
// Clean text passes through unchanged
// ---------------------------------------------------------------------------

describe('clean text passthrough', () => {
  it('leaves clean text unchanged', () => {
    const text = 'What is the capital of France?';
    const [clean, names] = pf.sanitize(text);
    expect(clean).toBe(text);
    expect(names).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Privacy mode blocks external calls
// ---------------------------------------------------------------------------

describe('privacy mode', () => {
  it('throws when privacy mode is enabled', () => {
    const configPath = path.join(tmpDir, 'privacy-strict.yaml');
    fs.writeFileSync(configPath, stringify({ privacy_mode: true, patterns: [] }));
    const strictPf = new PrivacyFilter(configPath, tmpDir);
    expect(() => strictPf.checkPrivacyMode()).toThrow(/Privacy mode/);
  });
});

// ---------------------------------------------------------------------------
// Outbound logging
// ---------------------------------------------------------------------------

describe('outbound logging', () => {
  it('creates log file and redacts sensitive content', () => {
    const secretContent = 'password=MySuperSecret123';
    pf.logOutbound(
      'claude',
      [{ role: 'user', content: `hello, ${secretContent}` }],
      'test-id',
    );

    const lines = fs.readFileSync(pf.logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.destination).toBe('claude');
    expect(record.message_id).toBe('test-id');
    // Sensitive content must be redacted in the log
    expect(JSON.stringify(record)).not.toContain('MySuperSecret123');
  });
});
