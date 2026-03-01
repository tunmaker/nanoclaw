import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---

vi.mock('../../src/core/privacy.js', () => ({
  PrivacyFilter: class {
    privacyMode = false;
    sanitize(text: string): [string, string[]] {
      // Simulate matching a credential pattern when the text contains one
      if (text.includes('sk-ant-')) {
        return ['[ANTHROPIC_KEY]', ['anthropic_api_key']];
      }
      return [text, []];
    }
  },
}));

vi.mock('../../src/core/local-llm.js', () => ({
  callLocalLlm: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
    },
  };
});

vi.mock('../../src/core/config.js', () => ({
  LOGS_DIR: '/tmp/test-logs',
  PRIVACY_CONFIG_PATH: '/tmp/privacy.yaml',
  ROUTE_BYPASS_LOCAL: false,
}));

import { callLocalLlm } from '../../src/core/local-llm.js';
import { classifyAndRoute, _resetFilter } from '../../src/intelligence/privacy-router.js';

const mockLlm = callLocalLlm as ReturnType<typeof vi.fn>;

describe('classifyAndRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetFilter();
  });

  it('hard-blocked pattern → route local, LLM call skipped', async () => {
    const result = await classifyAndRoute('My key is sk-ant-abc123xyz456 please help');

    expect(result.route).toBe('local');
    expect(result.sensitivity).toBe('private');
    expect(result.sanitized).toBe(false);
    expect(result.detectedPatterns).toContain('anthropic_api_key');
    // LLM must NOT have been called
    expect(mockLlm).not.toHaveBeenCalled();
  });

  it('personal message → route local, no sanitization', async () => {
    // No YAML pattern match, LLM returns PRIVATE
    mockLlm.mockResolvedValueOnce('PRIVATE');

    const result = await classifyAndRoute('My wife and I had a fight today');

    expect(result.route).toBe('local');
    expect(result.sensitivity).toBe('private');
    expect(result.sanitized).toBe(false);
    expect(result.sanitizedMessage).toBeUndefined();
    // LLM called once for classification only
    expect(mockLlm).toHaveBeenCalledTimes(1);
  });

  it('technical message → route claude, no sanitization', async () => {
    mockLlm.mockResolvedValueOnce('TECHNICAL');

    const result = await classifyAndRoute(
      'How do I fix a TypeScript error: "Type string is not assignable to number"?',
    );

    expect(result.route).toBe('claude');
    expect(result.sensitivity).toBe('technical');
    expect(result.sanitized).toBe(false);
    expect(result.sanitizedMessage).toBeUndefined();
    // LLM called once for classification only
    expect(mockLlm).toHaveBeenCalledTimes(1);
  });

  it('mixed message → route claude, sanitized=true, real name absent from sanitizedMessage', async () => {
    mockLlm
      .mockResolvedValueOnce('MIXED') // classification
      .mockResolvedValueOnce(
        'Person1 is having trouble with the TypeScript error in their codebase',
      ); // sanitization

    const result = await classifyAndRoute(
      'John is having trouble with the TypeScript error in his codebase',
    );

    expect(result.route).toBe('claude');
    expect(result.sensitivity).toBe('mixed');
    expect(result.sanitized).toBe(true);
    expect(result.sanitizedMessage).toBeDefined();
    expect(result.sanitizedMessage).not.toContain('John');
    expect(result.sanitizedMessage).toContain('Person1');
    // LLM called twice: classification + sanitization
    expect(mockLlm).toHaveBeenCalledTimes(2);
  });

  it('LLM returns unexpected label → privacy-first fallback to local', async () => {
    mockLlm.mockResolvedValueOnce('UNKNOWN_LABEL');

    const result = await classifyAndRoute('Something unusual');

    // Unknown label must NOT escalate to Claude — route locally for safety
    expect(result.route).toBe('local');
    expect(result.sensitivity).toBe('private');
    expect(result.sanitized).toBe(false);
  });

  it('greeting with @mention (XML-formatted) → PRIVATE, route local', async () => {
    mockLlm.mockResolvedValueOnce('PRIVATE');

    const result = await classifyAndRoute(
      '<messages>\n<message sender="Person1" time="2026-03-01T15:55:53.000Z">@Person2 hello</message>\n</messages>',
    );

    expect(result.route).toBe('local');
    expect(result.sensitivity).toBe('private');
    expect(result.sanitized).toBe(false);
    expect(mockLlm).toHaveBeenCalledTimes(1);
  });

  it('social message with group address (XML-formatted) → PRIVATE, route local', async () => {
    mockLlm.mockResolvedValueOnce('PRIVATE');

    const result = await classifyAndRoute(
      '<messages>\n<message sender="Person1" time="2026-03-01T15:55:53.000Z">good morning everyone!</message>\n</messages>',
    );

    expect(result.route).toBe('local');
    expect(result.sensitivity).toBe('private');
    expect(result.sanitized).toBe(false);
    expect(mockLlm).toHaveBeenCalledTimes(1);
  });

  it('technical question in XML format → TECHNICAL, route claude', async () => {
    mockLlm.mockResolvedValueOnce('TECHNICAL');

    const result = await classifyAndRoute(
      '<messages>\n<message sender="Person1" time="2026-03-01T15:55:53.000Z">How do I write a React hook?</message>\n</messages>',
    );

    expect(result.route).toBe('claude');
    expect(result.sensitivity).toBe('technical');
    expect(result.sanitized).toBe(false);
    expect(mockLlm).toHaveBeenCalledTimes(1);
  });
});
