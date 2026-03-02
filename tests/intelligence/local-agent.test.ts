import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

vi.mock('../../src/core/config.js', () => ({
  LOCAL_LLM_URL: 'http://localhost:8080/v1',
  WHISPER_SERVER_URL: 'http://localhost:8178',
  PERSONA_DIR: '/tmp/test-persona',
  MCP_MEMORY_URL: 'http://localhost:8052',
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/core/local-llm.js', () => ({
  callLocalLlm: vi.fn(),
}));

vi.mock('../../src/memory/memory-client.js', () => ({
  storeMemory: vi.fn().mockResolvedValue(undefined),
  retrieveMemory: vi.fn().mockResolvedValue([]),
  searchMemory: vi.fn().mockResolvedValue([]),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { callLocalLlm } from '../../src/core/local-llm.js';
import { storeMemory, retrieveMemory, searchMemory } from '../../src/memory/memory-client.js';
import fs from 'fs';
import { runLocalAgent } from '../../src/intelligence/local-agent.js';

const mockLlm = callLocalLlm as ReturnType<typeof vi.fn>;
const mockStore = storeMemory as ReturnType<typeof vi.fn>;
const mockRetrieve = retrieveMemory as ReturnType<typeof vi.fn>;
const mockSearch = searchMemory as ReturnType<typeof vi.fn>;
const mockFs = fs as unknown as Record<string, ReturnType<typeof vi.fn>>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal OpenAI-style stop response. */
function stopResponse(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: { role: 'assistant', content: text, tool_calls: undefined },
          finish_reason: 'stop',
        },
      ],
    }),
  };
}

/** Build an OpenAI-style tool_calls response. */
function toolCallResponse(
  toolName: string,
  args: Record<string, unknown>,
  id = 'call_1',
) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id,
                type: 'function',
                function: { name: toolName, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();

  // Persona file reads: return placeholder strings so buildSystemPrompt doesn't fail
  mockFs['readFileSync'].mockImplementation((p: unknown) => {
    const filePath = String(p);
    if (filePath.endsWith('SOUL.md')) return '# SOUL';
    if (filePath.endsWith('USER.md')) return '# USER';
    if (filePath.endsWith('AGENTS.md')) return '# AGENTS';
    // Default: simulate binary file for media
    return Buffer.from('fakemediadata');
  });

  // Memory retrieval: empty by default
  mockRetrieve.mockResolvedValue([]);

  // LLM (callLocalLlm): used only by maybeStoreMemory — default to "nothing"
  mockLlm.mockResolvedValue('nothing');
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runLocalAgent', () => {
  it('plain text → calls LLM, returns response on stop', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(stopResponse('Hello! How can I help?')),
    );

    const result = await runLocalAgent({ text: 'Hi there' });

    expect(result).toBe('Hello! How can I help?');
    // fetch should have been called (LLM call)
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
    const [url] = (vi.mocked(fetch).mock.calls[0] as unknown[]) as [string];
    expect(url).toContain('/chat/completions');
  });

  it('includes tools array in LLM request body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stopResponse('ok')));

    await runLocalAgent({ text: 'test' });

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { tools: unknown[] };
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
  });

  it('includes retrieved memories in system prompt', async () => {
    mockRetrieve.mockResolvedValueOnce([
      { id: '1', content: 'user prefers dark mode', tags: ['preference'], createdAt: '' },
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stopResponse('ok')));

    await runLocalAgent({ text: 'test' });

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
    const systemMsg = body.messages.find((m) => m.role === 'system');
    expect(systemMsg?.content).toContain('user prefers dark mode');
  });

  it('tool_calls → execute tool → loop continues to stop', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(toolCallResponse('search_memory', { query: 'test' }))
      .mockResolvedValueOnce(stopResponse('Found it!'));
    vi.stubGlobal('fetch', fetchMock);
    mockSearch.mockResolvedValue([
      { id: '2', content: 'relevant info', tags: [], createdAt: '' },
    ]);

    const result = await runLocalAgent({ text: 'find something' });

    expect(result).toBe('Found it!');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockSearch).toHaveBeenCalledWith('test');
  });

  it('store_memory tool → calls storeMemory with content and tags', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse('store_memory', {
          content: 'user likes cats',
          tags: ['preference', 'fact'],
        }),
      )
      .mockResolvedValueOnce(stopResponse('Stored!'));
    vi.stubGlobal('fetch', fetchMock);

    await runLocalAgent({ text: 'remember that I like cats' });

    expect(mockStore).toHaveBeenCalledWith('user likes cats', ['preference', 'fact'], undefined);
  });

  it('search_memory tool → returns formatted memory list', async () => {
    mockSearch.mockResolvedValue([
      { id: '3', content: 'coffee preference', tags: ['preference'], createdAt: '' },
      { id: '4', content: 'morning routine', tags: ['fact'], createdAt: '' },
    ]);

    let capturedToolResult: string | undefined;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(toolCallResponse('search_memory', { query: 'habits' }))
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          messages: Array<{ role: string; content: string }>;
        };
        const toolMsg = body.messages.find((m) => m.role === 'tool');
        capturedToolResult = toolMsg?.content;
        return stopResponse('got it');
      });
    vi.stubGlobal('fetch', fetchMock);

    await runLocalAgent({ text: 'what are my habits?' });

    expect(capturedToolResult).toContain('coffee preference');
    expect(capturedToolResult).toContain('morning routine');
  });

  it('web_search tool → returns stub message', async () => {
    let capturedToolResult: string | undefined;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(toolCallResponse('web_search', { query: 'latest news' }))
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          messages: Array<{ role: string; content: string }>;
        };
        const toolMsg = body.messages.find((m) => m.role === 'tool');
        capturedToolResult = toolMsg?.content;
        return stopResponse('ok');
      });
    vi.stubGlobal('fetch', fetchMock);

    await runLocalAgent({ text: 'search the web' });

    expect(capturedToolResult).toContain('not available');
  });

  it('read_file tool → reads and returns file content', async () => {
    mockFs['readFileSync']
      .mockImplementation((p: unknown) => {
        const filePath = String(p);
        if (filePath.endsWith('SOUL.md')) return '# SOUL';
        if (filePath.endsWith('USER.md')) return '# USER';
        if (filePath.endsWith('AGENTS.md')) return '# AGENTS';
        if (filePath === '/tmp/notes.txt') return 'my notes content';
        return '';
      });

    let capturedToolResult: string | undefined;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse('read_file', { path: '/tmp/notes.txt' }),
      )
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          messages: Array<{ role: string; content: string }>;
        };
        const toolMsg = body.messages.find((m) => m.role === 'tool');
        capturedToolResult = toolMsg?.content;
        return stopResponse('ok');
      });
    vi.stubGlobal('fetch', fetchMock);

    // Mock HOME to allow the path
    const originalHome = process.env.HOME;
    process.env.HOME = '/tmp';
    try {
      await runLocalAgent({ text: 'read my notes' });
    } finally {
      process.env.HOME = originalHome;
    }

    expect(capturedToolResult).toBe('my notes content');
  });

  it('read_file with path traversal → returns error in tool result', async () => {
    let capturedToolResult: string | undefined;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse('read_file', { path: '/tmp/../../etc/passwd' }),
      )
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          messages: Array<{ role: string; content: string }>;
        };
        const toolMsg = body.messages.find((m) => m.role === 'tool');
        capturedToolResult = toolMsg?.content;
        return stopResponse('ok');
      });
    vi.stubGlobal('fetch', fetchMock);

    await runLocalAgent({ text: 'read secret file' });

    expect(capturedToolResult).toContain('Error:');
  });

  it('write_file tool → calls writeFileSync with correct args', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse('write_file', {
          path: '/tmp/output.txt',
          content: 'hello world',
        }),
      )
      .mockResolvedValueOnce(stopResponse('Written!'));
    vi.stubGlobal('fetch', fetchMock);

    const originalHome = process.env.HOME;
    process.env.HOME = '/tmp';
    try {
      await runLocalAgent({ text: 'write a file' });
    } finally {
      process.env.HOME = originalHome;
    }

    expect(mockFs['writeFileSync']).toHaveBeenCalledWith(
      '/tmp/output.txt',
      'hello world',
      'utf8',
    );
  });

  it('audio message → transcribes via whisper, prepends to text, deletes file', async () => {
    const whisperFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ text: 'this is the transcription' }),
    });
    const llmFetch = vi.fn().mockResolvedValue(stopResponse('Got it'));

    // First call = whisper, subsequent = LLM
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).includes('8178')) return whisperFetch(url, init);
        return llmFetch(url, init);
      }),
    );

    const result = await runLocalAgent({
      text: '',
      mediaPath: '/tmp/voice.ogg',
      mediaType: 'audio',
    });

    expect(result).toBe('Got it');
    // Whisper was called
    expect(whisperFetch).toHaveBeenCalledOnce();
    // File was deleted
    expect(mockFs['unlinkSync']).toHaveBeenCalledWith('/tmp/voice.ogg');

    // The transcription text was passed to the LLM as user message
    const llmBody = JSON.parse(
      String((llmFetch.mock.calls[0] as [string, RequestInit])[1]?.body),
    ) as { messages: Array<{ role: string; content: string }> };
    const userMsg = llmBody.messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('this is the transcription');
  });

  it('image message → first user message contains image_url content block, file deleted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stopResponse('Nice image!')));

    await runLocalAgent({
      text: 'what is this?',
      mediaPath: '/tmp/photo.jpg',
      mediaType: 'image',
    });

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const userMsg = body.messages.find((m) => m.role === 'user');
    expect(Array.isArray(userMsg?.content)).toBe(true);
    const contentArray = userMsg?.content as Array<{ type: string }>;
    expect(contentArray.some((b) => b.type === 'image_url')).toBe(true);

    expect(mockFs['unlinkSync']).toHaveBeenCalledWith('/tmp/photo.jpg');
  });

  it('max iterations exhausted → returns fallback message', async () => {
    // Always return tool_calls so the loop never stops naturally
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(toolCallResponse('web_search', { query: 'loop' })),
    );

    const result = await runLocalAgent({ text: 'keep going' });

    expect(result).toContain('maximum number of reasoning steps');
  });

  it('maybeStoreMemory fires after stop response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stopResponse('The answer is 42.')));
    mockLlm.mockResolvedValue('The answer to the question is 42.');

    await runLocalAgent({ text: "what's the answer?" });

    // Give the fire-and-forget a tick to execute
    await new Promise((r) => setImmediate(r));

    expect(mockLlm).toHaveBeenCalledOnce();
    expect(mockStore).toHaveBeenCalledWith('The answer to the question is 42.', [
      'auto',
      'conversation',
    ], 'auto');
  });
});
