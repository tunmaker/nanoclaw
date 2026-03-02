import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config so tests don't depend on env
vi.mock('../../src/core/config.js', () => ({
  MCP_MEMORY_URL: 'http://localhost:8052',
  MCP_MEMORY_API_KEY: 'test-key',
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
  getConsolidationStatus,
  findSimilarMemories,
  searchMemoriesByTag,
  listTags,
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

/** Build a SearchResponse with one result for test assertions. */
function searchResponse(content: string, tags: string[], score = 0.9) {
  return {
    results: [
      {
        memory: {
          content,
          content_hash: 'abc123',
          tags,
          created_at_iso: '2026-01-01T00:00:00Z',
        },
        similarity_score: score,
      },
    ],
    total_found: 1,
    query: 'test',
  };
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

  it('includes memory_type when provided', async () => {
    const fetchMock = mockFetch({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await storeMemory('user prefers dark mode', ['preference'], 'preference');

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(opts.body as string)).toMatchObject({ memory_type: 'preference' });
  });

  it('includes metadata when provided', async () => {
    const fetchMock = mockFetch({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await storeMemory('note', ['auto'], 'auto', { source: 'conversation' });

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(opts.body as string)).toMatchObject({ metadata: { source: 'conversation' } });
  });

  it('does not throw when service is down', async () => {
    vi.stubGlobal('fetch', failFetch());
    await expect(storeMemory('test', ['tag'])).resolves.toBeUndefined();
  });
});

describe('retrieveMemory', () => {
  it('POSTs to /api/search with query in body', async () => {
    const fetchMock = mockFetch({
      json: async () => searchResponse('dark mode', ['preference']),
    });
    vi.stubGlobal('fetch', fetchMock);

    await retrieveMemory('preferences');

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/search');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toMatchObject({ query: 'preferences' });
  });

  it('returns mapped memories from search results', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ json: async () => searchResponse('dark mode', ['preference'], 0.92) }),
    );

    const result = await retrieveMemory('preferences');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      content: 'dark mode',
      content_hash: 'abc123',
      tags: ['preference'],
      relevanceScore: 0.92,
      similarity_score: 0.92,
    });
  });

  it('sends n_results from limit param', async () => {
    const fetchMock = mockFetch({ json: async () => ({ results: [], total_found: 0 }) });
    vi.stubGlobal('fetch', fetchMock);

    await retrieveMemory('test', 3);
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(opts.body as string).n_results).toBe(3);
  });

  it('returns empty array when service is down', async () => {
    vi.stubGlobal('fetch', failFetch());
    expect(await retrieveMemory('anything')).toEqual([]);
  });

  it('returns empty array on non-OK response', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: false, status: 503 }));
    expect(await retrieveMemory('anything')).toEqual([]);
  });
});

describe('searchMemory', () => {
  it('POSTs to /api/search with query in body', async () => {
    const fetchMock = mockFetch({
      json: async () => searchResponse('remembered thing', ['fact']),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await searchMemory('remembered');

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('remembered thing');

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/search');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toMatchObject({ query: 'remembered' });
  });

  it('returns empty array on failure', async () => {
    vi.stubGlobal('fetch', failFetch());
    expect(await searchMemory('query')).toEqual([]);
  });
});

describe('deleteMemory', () => {
  it('sends DELETE to /api/memories/:contentHash', async () => {
    const fetchMock = mockFetch({});
    vi.stubGlobal('fetch', fetchMock);

    await deleteMemory('abc-123');
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/memories/abc-123');
    expect(opts.method).toBe('DELETE');
  });

  it('does not throw on failure', async () => {
    vi.stubGlobal('fetch', failFetch());
    await expect(deleteMemory('hash')).resolves.toBeUndefined();
  });
});

describe('triggerConsolidation', () => {
  it('POSTs to /api/consolidation/trigger with time_horizon', async () => {
    const fetchMock = mockFetch({
      json: async () => ({
        status: 'ok',
        processed: 10,
        compressed: 3,
        forgotten: 1,
        duration: 0.42,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await triggerConsolidation();

    expect(result).toEqual({
      status: 'ok',
      processed: 10,
      compressed: 3,
      forgotten: 1,
      duration: 0.42,
    });

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/consolidation/trigger');
    expect(JSON.parse(opts.body as string)).toMatchObject({ time_horizon: 'weekly' });
  });

  it('returns zero counts on failure', async () => {
    vi.stubGlobal('fetch', failFetch());
    const result = await triggerConsolidation();
    expect(result).toEqual({
      status: 'error',
      processed: 0,
      compressed: 0,
      forgotten: 0,
      duration: 0,
    });
  });
});

describe('getMemoryHealth', () => {
  it('GETs /api/health and returns ok:true with uptime', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ json: async () => ({ status: 'ok', uptime_seconds: 3600 }) }),
    );
    const result = await getMemoryHealth();
    expect(result).toEqual({ ok: true, uptime: 3600 });
  });

  it('returns ok:false when service is down', async () => {
    vi.stubGlobal('fetch', failFetch());
    expect(await getMemoryHealth()).toEqual({ ok: false });
  });

  it('returns ok:false on non-OK HTTP response', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: false, status: 503 }));
    expect(await getMemoryHealth()).toEqual({ ok: false });
  });

  it('hits the /api/health endpoint', async () => {
    const fetchMock = mockFetch({ json: async () => ({ status: 'ok' }) });
    vi.stubGlobal('fetch', fetchMock);

    await getMemoryHealth();

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('/api/health');
    expect(url).not.toContain('/health/');
  });
});

describe('getConsolidationStatus', () => {
  it('GETs /api/consolidation/status', async () => {
    const statusData = {
      running: false,
      next_daily: '2026-03-03T02:00:00Z',
      next_weekly: '2026-03-07T02:00:00Z',
      jobs_executed: 14,
      jobs_failed: 0,
    };
    const fetchMock = mockFetch({ json: async () => statusData });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getConsolidationStatus();

    expect(result).toEqual(statusData);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('/api/consolidation/status');
  });

  it('returns null when service is down', async () => {
    vi.stubGlobal('fetch', failFetch());
    expect(await getConsolidationStatus()).toBeNull();
  });

  it('returns null on non-OK response', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: false, status: 503 }));
    expect(await getConsolidationStatus()).toBeNull();
  });
});

describe('findSimilarMemories', () => {
  it('GETs /api/search/similar/:hash with n_results param', async () => {
    const fetchMock = mockFetch({
      json: async () => searchResponse('similar thing', ['fact'], 0.87),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await findSimilarMemories('deadbeef', 5);

    expect(result).toHaveLength(1);
    expect(result[0].similarity_score).toBe(0.87);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('/api/search/similar/deadbeef');
    expect(url).toContain('n_results=5');
  });

  it('returns empty array when service is down', async () => {
    vi.stubGlobal('fetch', failFetch());
    expect(await findSimilarMemories('hash')).toEqual([]);
  });

  it('returns empty array on non-OK response', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: false, status: 404 }));
    expect(await findSimilarMemories('hash')).toEqual([]);
  });
});

describe('searchMemoriesByTag', () => {
  it('POSTs to /api/search/by-tag with tags and match_all', async () => {
    const fetchMock = mockFetch({
      json: async () => searchResponse('dark mode preference', ['preference'], 1.0),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await searchMemoriesByTag(['preference', 'ui'], true);

    expect(result).toHaveLength(1);
    expect(result[0].tags).toContain('preference');

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/search/by-tag');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string) as { tags: string[]; match_all: boolean };
    expect(body.tags).toEqual(['preference', 'ui']);
    expect(body.match_all).toBe(true);
  });

  it('defaults match_all to false', async () => {
    const fetchMock = mockFetch({ json: async () => ({ results: [], total_found: 0 }) });
    vi.stubGlobal('fetch', fetchMock);

    await searchMemoriesByTag(['fact']);

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(opts.body as string).match_all).toBe(false);
  });

  it('returns empty array on failure', async () => {
    vi.stubGlobal('fetch', failFetch());
    expect(await searchMemoriesByTag(['tag'])).toEqual([]);
  });
});

describe('listTags', () => {
  it('GETs /api/tags and returns tag counts', async () => {
    const tags = [
      { tag: 'preference', count: 12 },
      { tag: 'fact', count: 7 },
    ];
    const fetchMock = mockFetch({ json: async () => tags });
    vi.stubGlobal('fetch', fetchMock);

    const result = await listTags();

    expect(result).toEqual(tags);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('/api/tags');
  });

  it('returns empty array when service is down', async () => {
    vi.stubGlobal('fetch', failFetch());
    expect(await listTags()).toEqual([]);
  });

  it('returns empty array on non-OK response', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: false, status: 503 }));
    expect(await listTags()).toEqual([]);
  });
});
