import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config so tests don't depend on env
vi.mock('../../src/core/config.js', () => ({
  MCP_MEMORY_URL: 'http://localhost:8052',
}));

// Mock logger to suppress output
vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  storeMemory,
  retrieveMemory,
  searchMemory,
  deleteMemory,
  triggerConsolidation,
  getMemoryHealth,
} from '../../src/memory/memory-client.js';

function mockFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
    ...response,
  });
}

function failFetch(error = new Error('connection refused')) {
  return vi.fn().mockRejectedValue(error);
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('storeMemory', () => {
  it('posts to /api/memories with content and tags', async () => {
    const fetchMock = mockFetch({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await storeMemory('user prefers dark mode', ['preference']);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/memories');
    expect(JSON.parse(opts.body as string)).toEqual({
      content: 'user prefers dark mode',
      tags: ['preference'],
    });
  });

  it('does not throw when service is down', async () => {
    vi.stubGlobal('fetch', failFetch());
    await expect(storeMemory('test', ['tag'])).resolves.toBeUndefined();
  });
});

describe('retrieveMemory', () => {
  it('returns memories from the response', async () => {
    const memories = [
      { id: '1', content: 'dark mode', tags: ['preference'], createdAt: '2026-01-01' },
    ];
    vi.stubGlobal('fetch', mockFetch({ json: async () => ({ memories }) }));

    const result = await retrieveMemory('preferences');
    expect(result).toEqual(memories);
  });

  it('returns empty array when service is down', async () => {
    vi.stubGlobal('fetch', failFetch());
    const result = await retrieveMemory('anything');
    expect(result).toEqual([]);
  });

  it('returns empty array on non-OK response', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: false, status: 503 }));
    const result = await retrieveMemory('anything');
    expect(result).toEqual([]);
  });

  it('includes limit in query params', async () => {
    const fetchMock = mockFetch({ json: async () => ({ memories: [] }) });
    vi.stubGlobal('fetch', fetchMock);

    await retrieveMemory('test', 3);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('limit=3');
  });
});

describe('searchMemory', () => {
  it('queries /api/memories/search and returns results', async () => {
    const memories = [{ id: '2', content: 'remembered thing', tags: ['fact'], createdAt: '2026-01-01' }];
    const fetchMock = mockFetch({ json: async () => ({ memories }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await searchMemory('remembered');
    expect(result).toEqual(memories);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('/api/memories/search');
  });

  it('returns empty array on failure', async () => {
    vi.stubGlobal('fetch', failFetch());
    expect(await searchMemory('query')).toEqual([]);
  });
});

describe('deleteMemory', () => {
  it('sends DELETE to /api/memories/:id', async () => {
    const fetchMock = mockFetch({});
    vi.stubGlobal('fetch', fetchMock);

    await deleteMemory('abc-123');
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/memories/abc-123');
    expect(opts.method).toBe('DELETE');
  });

  it('does not throw on failure', async () => {
    vi.stubGlobal('fetch', failFetch());
    await expect(deleteMemory('id')).resolves.toBeUndefined();
  });
});

describe('triggerConsolidation', () => {
  it('posts to /api/consolidate and returns result', async () => {
    const fetchMock = mockFetch({
      json: async () => ({ merged: 5, archived: 2, dryRun: false }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await triggerConsolidation(false);
    expect(result).toEqual({ merged: 5, archived: 2, dryRun: false });
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/consolidate');
    expect(JSON.parse(opts.body as string).dry_run).toBe(false);
  });

  it('returns zero counts on failure', async () => {
    vi.stubGlobal('fetch', failFetch());
    const result = await triggerConsolidation(true);
    expect(result).toEqual({ merged: 0, archived: 0, dryRun: true });
  });
});

describe('getMemoryHealth', () => {
  it('returns ok:true with count when service responds', async () => {
    vi.stubGlobal('fetch', mockFetch({ json: async () => ({ status: 'ok', count: 42 }) }));
    const result = await getMemoryHealth();
    expect(result).toEqual({ ok: true, count: 42 });
  });

  it('returns ok:false when service is down', async () => {
    vi.stubGlobal('fetch', failFetch());
    const result = await getMemoryHealth();
    expect(result).toEqual({ ok: false });
  });

  it('returns ok:false on non-OK HTTP response', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: false, status: 503 }));
    const result = await getMemoryHealth();
    expect(result).toEqual({ ok: false });
  });
});
