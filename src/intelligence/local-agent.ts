/**
 * Local agent ReAct loop (Phase 3).
 *
 * Runs entirely on the local LLM (llama.cpp/Qwen3-VL via OpenAI-compatible API).
 * No external calls — all tools stay on-device or hit local services.
 *
 * Flow:
 *   1. Pre-process media (transcribe audio, encode image/video)
 *   2. Build system prompt from persona files + retrieved memories
 *   3. ReAct loop: LLM → tool calls → results → repeat (max 8 iterations)
 *   4. On stop: fire-and-forget memory storage, return response text
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { LOCAL_LLM_URL, PERSONA_DIR, WHISPER_SERVER_URL } from '../core/config.js';
import { callLocalLlm } from '../core/local-llm.js';
import { logger } from '../core/logger.js';
import { retrieveMemory, searchMemory, searchMemoriesByTag, storeMemory } from '../memory/memory-client.js';
import type { Memory } from '../memory/memory-client.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface AgentMessage {
  text: string;
  mediaPath?: string;
  mediaType?: 'image' | 'video' | 'audio';
  channelContext?: string;
}

/** Optional debug hook — pass to runLocalAgent to observe internal steps. */
export interface AgentDebugHook {
  onSystemPrompt?: (info: {
    soulLoaded: boolean;
    userLoaded: boolean;
    agentsLoaded: boolean;
    sessionMemories: Memory[];
    decisionMemories: Memory[];
  }) => void;
  onIteration?: (iteration: number) => void;
  onLlmResponse?: (
    finishReason: string,
    content: string | null,
    toolCalls?: ToolCall[],
  ) => void;
  onToolResult?: (name: string, args: Record<string, unknown>, result: string) => void;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'video_url'; video_url: { url: string } };

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface LlmResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
}

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI tools array)
// ---------------------------------------------------------------------------

const LOCAL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'store_memory',
      description: 'Persist something worth remembering to the memory service.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The memory content to store.' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Category tags (e.g. "preference", "decision", "task", "fact").',
          },
          memory_type: {
            type: 'string',
            description:
              'Memory type: "preference", "decision", "task", "fact", "general" (default).',
          },
        },
        required: ['content', 'tags'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_memory',
      description: 'Search the memory service for relevant memories.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_by_tag',
      description: 'Look up memories by tag (e.g. all "preference" memories).',
      parameters: {
        type: 'object',
        properties: {
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags to filter by.',
          },
          match_all: {
            type: 'boolean',
            description: 'If true, memory must have all tags. Default false (any tag matches).',
          },
        },
        required: ['tags'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for information.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file (sandboxed to $HOME).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file (sandboxed to $HOME).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file.' },
          content: { type: 'string', description: 'Content to write.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'transcribe_audio',
      description: 'Transcribe an audio file using the local whisper server.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the audio file.' },
        },
        required: ['path'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Path sandboxing
// ---------------------------------------------------------------------------

function safePath(p: string): string {
  // Reject traversal attempts before resolving
  if (p.includes('..')) {
    throw new Error(`Path traversal rejected: ${p}`);
  }
  const home = process.env.HOME ?? os.homedir();
  const resolved = path.resolve(p);
  if (!resolved.startsWith(home)) {
    throw new Error(`Path outside $HOME is not allowed: ${p}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Media helpers
// ---------------------------------------------------------------------------

/** Convert any audio file to 16kHz mono WAV using ffmpeg (whisper.cpp requirement). */
function convertToWav(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', outputPath]);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
    proc.on('error', (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
  });
}

/** Transcribe audio via whisper server; converts to WAV first, deletes both files in finally. */
async function transcribeAudio(audioPath: string): Promise<string> {
  const wavPath = audioPath.replace(/\.[^.]+$/, '.wav');
  try {
    await convertToWav(audioPath, wavPath);

    const audioBuffer = fs.readFileSync(wavPath);
    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer]), path.basename(wavPath));
    formData.append('response_format', 'json');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);
    let response: Response;
    try {
      response = await fetch(`${WHISPER_SERVER_URL}/inference`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      return `Transcription failed: ${response.status} ${response.statusText}`;
    }
    const data = (await response.json()) as { text?: string };
    return data.text?.trim() ?? '';
  } catch (err) {
    return `Transcription error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    try { fs.unlinkSync(audioPath); } catch { /* original audio — may already be gone */ }
    try { fs.unlinkSync(wavPath); } catch { /* converted WAV */ }
  }
}

/** Analyse image or video with the multimodal LLM; deletes file in finally. */
async function analyseMedia(
  mediaPath: string,
  prompt: string,
  type: 'image' | 'video',
): Promise<string> {
  try {
    const base64 = fs.readFileSync(mediaPath).toString('base64');
    const mimeType = type === 'image' ? 'image/jpeg' : 'video/mp4';
    const contentType = type === 'image' ? 'image_url' : 'video_url';

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);
    let response: Response;
    try {
      response = await fetch(`${LOCAL_LLM_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'default',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: contentType,
                  [contentType]: { url: `data:${mimeType};base64,${base64}` },
                },
                { type: 'text', text: prompt },
              ],
            },
          ],
          max_tokens: 512,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      return `Media analysis failed: ${response.status} ${response.statusText}`;
    }
    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content ?? 'No response from model.';
  } catch (err) {
    return `Media analysis error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    try {
      fs.unlinkSync(mediaPath);
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

async function buildSystemPrompt(debug?: AgentDebugHook): Promise<string> {
  let soul = '';
  let user = '';
  let agents = '';
  let soulLoaded = false;
  let userLoaded = false;
  let agentsLoaded = false;

  try {
    soul = fs.readFileSync(path.join(PERSONA_DIR, 'SOUL.md'), 'utf8');
    soulLoaded = true;
  } catch {
    logger.warn({ path: PERSONA_DIR }, 'local-agent: SOUL.md not found');
  }
  try {
    user = fs.readFileSync(path.join(PERSONA_DIR, 'USER.md'), 'utf8');
    userLoaded = true;
  } catch {
    logger.warn({ path: PERSONA_DIR }, 'local-agent: USER.md not found');
  }
  try {
    agents = fs.readFileSync(path.join(PERSONA_DIR, 'AGENTS.md'), 'utf8');
    agentsLoaded = true;
  } catch {
    logger.warn({ path: PERSONA_DIR }, 'local-agent: AGENTS.md not found');
  }

  const [sessionMems, decisionMems] = await Promise.all([
    retrieveMemory('session context user preferences ongoing tasks'),
    retrieveMemory('recent decisions open items'),
  ]);

  debug?.onSystemPrompt?.({
    soulLoaded,
    userLoaded,
    agentsLoaded,
    sessionMemories: sessionMems,
    decisionMemories: decisionMems,
  });

  const formatMems = (mems: Memory[]) =>
    mems.length > 0 ? mems.map((m) => `- ${m.content}`).join('\n') : '(none)';

  return [
    soul,
    `## User Context\n${user}`,
    `## Agent Instructions\n${agents}`,
    `## Retrieved Memories\n\n### Session Context\n${formatMems(sessionMems)}\n\n### Recent Decisions\n${formatMems(decisionMems)}`,
  ].join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

async function dispatchTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'store_memory': {
      const content = String(args.content ?? '');
      const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
      const memory_type = args.memory_type !== undefined ? String(args.memory_type) : undefined;
      await storeMemory(content, tags, memory_type);
      return 'Memory stored.';
    }

    case 'search_memory': {
      const query = String(args.query ?? '');
      const mems = await searchMemory(query);
      if (mems.length === 0) return 'No memories found.';
      return mems.map((m) => `- ${m.content}`).join('\n');
    }

    case 'search_by_tag': {
      const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
      const matchAll = args.match_all === true;
      const mems = await searchMemoriesByTag(tags, matchAll);
      if (mems.length === 0) return 'No memories found for those tags.';
      return mems.map((m) => `- ${m.content}`).join('\n');
    }

    case 'web_search': {
      // TODO: implement real web search capability
      return 'Web search not available in this environment.';
    }

    case 'read_file': {
      const p = safePath(String(args.path ?? ''));
      return fs.readFileSync(p, 'utf8');
    }

    case 'write_file': {
      const p = safePath(String(args.path ?? ''));
      const content = String(args.content ?? '');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf8');
      return 'File written.';
    }

    case 'transcribe_audio': {
      return await transcribeAudio(String(args.path ?? ''));
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

async function executeTools(
  toolCalls: ToolCall[],
  debug?: AgentDebugHook,
): Promise<Array<{ tool_call_id: string; role: 'tool'; content: string }>> {
  return Promise.all(
    toolCalls.map(async (tc) => {
      let result: string;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        result = await dispatchTool(tc.function.name, args);
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      logger.debug({ tool: tc.function.name, result: result.slice(0, 80) }, 'local-agent: tool result');
      debug?.onToolResult?.(tc.function.name, args, result);
      return { tool_call_id: tc.id, role: 'tool' as const, content: result };
    }),
  );
}

// ---------------------------------------------------------------------------
// Memory auto-storage
// ---------------------------------------------------------------------------

async function maybeStoreMemory(originalText: string, response: string): Promise<void> {
  try {
    const prompt =
      `Given this conversation exchange, is there a single factual sentence worth storing in long-term memory?\n` +
      `If yes, write ONLY that sentence (no quotes, no explanation). If no, write exactly: nothing\n\n` +
      `User: ${originalText}\n` +
      `Assistant: ${response}\n\n` +
      `Memory sentence:`;

    const result = await callLocalLlm([{ role: 'user', content: prompt }], 64);
    const sentence = result.trim();
    if (!sentence || sentence.toLowerCase() === 'nothing') return;
    void storeMemory(sentence, ['auto', 'conversation'], 'auto');
  } catch (err) {
    logger.warn({ err }, 'maybeStoreMemory: failed');
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

const MAX_ITERATIONS = 8;

export async function runLocalAgent(message: AgentMessage, debug?: AgentDebugHook): Promise<string> {
  // --- Step 1: Media pre-processing ---
  let firstUserContent: string | ContentBlock[];
  let textForMemory = message.text;

  if (message.mediaType === 'audio' && message.mediaPath) {
    const transcript = await transcribeAudio(message.mediaPath);
    textForMemory = transcript ? `[Voice] ${transcript}` : message.text;
    firstUserContent = textForMemory;
  } else if (
    (message.mediaType === 'image' || message.mediaType === 'video') &&
    message.mediaPath
  ) {
    const mimeType = message.mediaType === 'image' ? 'image/jpeg' : 'video/mp4';
    const contentType = message.mediaType === 'image' ? 'image_url' : 'video_url';
    let base64 = '';
    try {
      base64 = fs.readFileSync(message.mediaPath).toString('base64');
    } catch (err) {
      logger.warn({ err }, 'local-agent: failed to read media file');
    } finally {
      try {
        fs.unlinkSync(message.mediaPath);
      } catch {
        // ignore
      }
    }
    firstUserContent = [
      {
        type: contentType,
        [contentType]: { url: `data:${mimeType};base64,${base64}` },
      } as ContentBlock,
      { type: 'text', text: message.text },
    ];
  } else {
    firstUserContent = message.text;
  }

  // --- Step 2: Build system prompt ---
  const systemPrompt = await buildSystemPrompt(debug);

  // --- Step 3: ReAct loop ---
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: firstUserContent },
  ];

  let lastText = '';
  // Vision requests: skip tools on the first call so the model describes the
  // image directly instead of trying to invoke analyse_image with a stale path.
  const hasVisionContent = Array.isArray(firstUserContent);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    debug?.onIteration?.(i + 1);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120_000);
    let llmResponse: LlmResponse;

    const skipTools = hasVisionContent && i === 0;

    try {
      const res = await fetch(`${LOCAL_LLM_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'default',
          messages,
          ...(skipTools ? {} : { tools: LOCAL_TOOLS }),
          max_tokens: 1024,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`LLM request failed: ${res.status} ${res.statusText}`);
      }
      llmResponse = (await res.json()) as LlmResponse;
    } finally {
      clearTimeout(timeoutId);
    }

    const choice = llmResponse.choices[0];
    if (!choice) throw new Error('No choices in LLM response');

    const { message: assistantMsg, finish_reason } = choice;

    debug?.onLlmResponse?.(finish_reason, assistantMsg.content ?? null, assistantMsg.tool_calls);

    messages.push({
      role: 'assistant',
      content: assistantMsg.content ?? '',
      tool_calls: assistantMsg.tool_calls,
    });

    if (finish_reason === 'tool_calls' && assistantMsg.tool_calls?.length) {
      logger.debug(
        { iteration: i + 1, tools: assistantMsg.tool_calls.map((t) => t.function.name) },
        'local-agent: tool calls',
      );
      const toolResults = await executeTools(assistantMsg.tool_calls, debug);
      for (const result of toolResults) {
        messages.push({
          role: result.role,
          content: result.content,
          tool_call_id: result.tool_call_id,
        });
      }
    } else {
      lastText = assistantMsg.content ?? '';
      void maybeStoreMemory(textForMemory, lastText);
      return lastText;
    }
  }

  // Max iterations exhausted — return best available text
  logger.warn({ iterations: MAX_ITERATIONS }, 'local-agent: max iterations reached');
  const fallback =
    lastText ||
    'I reached the maximum number of reasoning steps. Please try rephrasing your question.';
  void maybeStoreMemory(textForMemory, fallback);
  return fallback;
}
