/**
 * Unit tests for src/routing.ts — all rule paths covered.
 * Ported 1:1 from tests/test_router.py.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { Router } from './routing.js';

let router: Router;

beforeEach(() => {
  router = new Router();
});

// ---------------------------------------------------------------------------
// Rule 1: sensitive content → local
// ---------------------------------------------------------------------------

describe('sensitive_content rule', () => {
  it('routes wife/family messages to local', () => {
    const d = router.route("what's my wife's name?");
    expect(d.routedTo).toBe('local');
    expect(d.ruleName).toBe('sensitive_content');
  });

  it('routes kids/school messages to local', () => {
    const d = router.route('remind me what school my kids go to');
    expect(d.routedTo).toBe('local');
    expect(d.ruleName).toBe('sensitive_content');
  });

  it('routes password keyword to local', () => {
    const d = router.route('my password is hunter2');
    expect(d.routedTo).toBe('local');
    expect(d.ruleName).toBe('sensitive_content');
  });

  it('routes api_key inline to local', () => {
    const d = router.route('here is my api_key=supersecretvalue123');
    expect(d.routedTo).toBe('local');
    expect(d.ruleName).toBe('sensitive_content');
  });
});

// ---------------------------------------------------------------------------
// Rule 2: coding tasks → claude
// ---------------------------------------------------------------------------

describe('coding_task rule', () => {
  it('routes "write a function" to claude', () => {
    const d = router.route('write a function to parse JSON in Python');
    expect(d.routedTo).toBe('claude');
    expect(d.ruleName).toBe('coding_task');
  });

  it('routes binary search to claude', () => {
    const d = router.route('write a binary search in Python');
    expect(d.routedTo).toBe('claude');
    expect(d.ruleName).toBe('coding_task');
  });

  it('routes debug request to claude', () => {
    const d = router.route('debug this TypeError in my script');
    expect(d.routedTo).toBe('claude');
    expect(d.ruleName).toBe('coding_task');
  });

  it('routes fenced code block to claude', () => {
    const d = router.route('can you review this:\n```python\ndef foo(): pass\n```');
    expect(d.routedTo).toBe('claude');
    expect(d.ruleName).toBe('coding_task');
  });
});

// ---------------------------------------------------------------------------
// Rule 3: real-time info → local
// ---------------------------------------------------------------------------

describe('realtime_info rule', () => {
  it('routes weather query to local', () => {
    const d = router.route("what's the weather today?");
    expect(d.routedTo).toBe('local');
    expect(d.ruleName).toBe('realtime_info');
  });

  it('routes latest news to local', () => {
    const d = router.route('show me the latest news');
    expect(d.routedTo).toBe('local');
    expect(d.ruleName).toBe('realtime_info');
  });
});

// ---------------------------------------------------------------------------
// Rule 4: default → local
// ---------------------------------------------------------------------------

describe('default rule', () => {
  it('routes generic message to local', () => {
    const d = router.route('hello, how are you?');
    expect(d.routedTo).toBe('local');
    expect(d.ruleName).toBe('default');
  });

  it('routes empty message to local', () => {
    const d = router.route('');
    expect(d.routedTo).toBe('local');
    expect(d.ruleName).toBe('default');
  });
});

// ---------------------------------------------------------------------------
// Priority: sensitive beats coding
// ---------------------------------------------------------------------------

describe('rule priority', () => {
  it('sensitive_content beats coding_task when both match', () => {
    // "my password" AND "write a function" — sensitive_content has lower priority number
    const d = router.route('write a function that checks if my password is strong');
    expect(d.routedTo).toBe('local');
    expect(d.ruleName).toBe('sensitive_content');
  });
});

// ---------------------------------------------------------------------------
// Decision structure
// ---------------------------------------------------------------------------

describe('RoutingDecision structure', () => {
  it('generates a message ID when none is provided', () => {
    const d = router.route('test');
    expect(d.messageId).toBeTruthy();
    expect(d.messageId.length).toBeGreaterThan(0);
  });

  it('uses provided message ID', () => {
    const d = router.route('test', 'my-id-123');
    expect(d.messageId).toBe('my-id-123');
  });

  it('decision has required fields', () => {
    const d = router.route('hello');
    expect(d).toHaveProperty('messageId');
    expect(d).toHaveProperty('routedTo');
    expect(d).toHaveProperty('ruleName');
    expect(d).toHaveProperty('reason');
    expect(d).toHaveProperty('messagePreview');
  });
});
