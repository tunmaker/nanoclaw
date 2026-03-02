/**
 * HTTP client for mcp-memory-service.
 * Base URL: MCP_MEMORY_URL env var (default http://localhost:8052)
 *
 * On failure: logs the error and returns a safe value — never crashes the agent.
 */
import { MCP_MEMORY_URL, MCP_MEMORY_API_KEY } from '../core/config.js';
import { logger } from '../core/logger.js';

export interface Memory {
  id: string;
  content: string;
  content_hash: string;
  tags: string[];
  memory_type?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  relevanceScore?: number;
  similarity_score?: number;
}

export interface ConsolidationResult {
  status: string;
  processed: number;
  compressed: number;
  forgotten: number;
  duration: number;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface ConsolidationStatus {
  running: boolean;
  next_daily: string;
  next_weekly: string;
  jobs_executed: number;
  jobs_failed: number;
}

// Internal type for /api/search response
interface SearchResult {
  memory: {
    id?: string;
    content: string;
    content_hash: string;
    tags: string[];
    memory_type?: string;
    metadata?: Record<string, unknown>;
    created_at_iso?: string;
  };
  similarity_score: number;
}

interface SearchResponse {
  results: SearchResult[];
  total_found: number;
  query?: string;
}

function authHeader(): Record<string, string> {
  return MCP_MEMORY_API_KEY ? { 'X-API-Key': MCP_MEMORY_API_KEY } : {};
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function mapSearchResult(result: SearchResult): Memory {
  const m = result.memory;
  return {
    id: m.content_hash,
    content: m.content,
    content_hash: m.content_hash,
    tags: m.tags,
    memory_type: m.memory_type,
    metadata: m.metadata,
    createdAt: m.created_at_iso ?? '',
    relevanceScore: result.similarity_score,
    similarity_score: result.similarity_score,
  };
}

export async function storeMemory(
  content: string,
  tags: string[],
  memory_type?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    const body: Record<string, unknown> = { content, tags };
    if (memory_type !== undefined) body.memory_type = memory_type;
    if (metadata !== undefined) body.metadata = metadata;
    const res = await fetchWithTimeout(
      `${MCP_MEMORY_URL}/api/memories`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify(body),
      },
      5_000,
    );
    if (!res.ok) {
      logger.warn({ status: res.status }, 'storeMemory: non-OK response');
    }
  } catch (err) {
    logger.error({ err }, 'storeMemory: failed');
  }
}

export async function retrieveMemory(query: string, limit = 8): Promise<Memory[]> {
  try {
    const res = await fetchWithTimeout(
      `${MCP_MEMORY_URL}/api/search`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ query, n_results: limit }),
      },
      5_000,
    );
    if (!res.ok) {
      logger.warn({ status: res.status }, 'retrieveMemory: non-OK response');
      return [];
    }
    const data = (await res.json()) as SearchResponse;
    return (data.results ?? []).map(mapSearchResult);
  } catch (err) {
    logger.error({ err }, 'retrieveMemory: failed');
    return [];
  }
}

export async function searchMemory(query: string, limit = 8): Promise<Memory[]> {
  try {
    const res = await fetchWithTimeout(
      `${MCP_MEMORY_URL}/api/search`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ query, n_results: limit }),
      },
      5_000,
    );
    if (!res.ok) {
      logger.warn({ status: res.status }, 'searchMemory: non-OK response');
      return [];
    }
    const data = (await res.json()) as SearchResponse;
    return (data.results ?? []).map(mapSearchResult);
  } catch (err) {
    logger.error({ err }, 'searchMemory: failed');
    return [];
  }
}

export async function deleteMemory(contentHash: string): Promise<void> {
  try {
    const res = await fetchWithTimeout(
      `${MCP_MEMORY_URL}/api/memories/${encodeURIComponent(contentHash)}`,
      { method: 'DELETE', headers: authHeader() },
      5_000,
    );
    if (!res.ok) {
      logger.warn({ status: res.status, contentHash }, 'deleteMemory: non-OK response');
    }
  } catch (err) {
    logger.error({ err, contentHash }, 'deleteMemory: failed');
  }
}

export async function triggerConsolidation(): Promise<ConsolidationResult> {
  const fallback: ConsolidationResult = {
    status: 'error',
    processed: 0,
    compressed: 0,
    forgotten: 0,
    duration: 0,
  };
  try {
    const res = await fetchWithTimeout(
      `${MCP_MEMORY_URL}/api/consolidation/trigger`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ time_horizon: 'weekly' }),
      },
      30_000,
    );
    if (!res.ok) {
      logger.warn({ status: res.status }, 'triggerConsolidation: non-OK response');
      return fallback;
    }
    const data = (await res.json()) as Partial<ConsolidationResult>;
    return {
      status: data.status ?? 'ok',
      processed: data.processed ?? 0,
      compressed: data.compressed ?? 0,
      forgotten: data.forgotten ?? 0,
      duration: data.duration ?? 0,
    };
  } catch (err) {
    logger.error({ err }, 'triggerConsolidation: failed');
    return fallback;
  }
}

export async function getMemoryHealth(): Promise<{ ok: boolean; uptime?: number }> {
  try {
    const res = await fetchWithTimeout(`${MCP_MEMORY_URL}/api/health`, { headers: authHeader() }, 3_000);
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as { status?: string; uptime_seconds?: number };
    return { ok: data.status === 'ok', uptime: data.uptime_seconds };
  } catch {
    return { ok: false };
  }
}

export async function getConsolidationStatus(): Promise<ConsolidationStatus | null> {
  try {
    const res = await fetchWithTimeout(
      `${MCP_MEMORY_URL}/api/consolidation/status`,
      { headers: authHeader() },
      3_000,
    );
    if (!res.ok) {
      logger.warn({ status: res.status }, 'getConsolidationStatus: non-OK response');
      return null;
    }
    return (await res.json()) as ConsolidationStatus;
  } catch (err) {
    logger.error({ err }, 'getConsolidationStatus: failed');
    return null;
  }
}

export async function findSimilarMemories(contentHash: string, limit = 8): Promise<Memory[]> {
  try {
    const url = new URL(
      `${MCP_MEMORY_URL}/api/search/similar/${encodeURIComponent(contentHash)}`,
    );
    url.searchParams.set('n_results', String(limit));
    const res = await fetchWithTimeout(url.toString(), { headers: authHeader() }, 5_000);
    if (!res.ok) {
      logger.warn({ status: res.status }, 'findSimilarMemories: non-OK response');
      return [];
    }
    const data = (await res.json()) as SearchResponse;
    return (data.results ?? []).map(mapSearchResult);
  } catch (err) {
    logger.error({ err }, 'findSimilarMemories: failed');
    return [];
  }
}

export async function searchMemoriesByTag(tags: string[], matchAll = false): Promise<Memory[]> {
  try {
    const res = await fetchWithTimeout(
      `${MCP_MEMORY_URL}/api/search/by-tag`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ tags, match_all: matchAll }),
      },
      5_000,
    );
    if (!res.ok) {
      logger.warn({ status: res.status }, 'searchMemoriesByTag: non-OK response');
      return [];
    }
    const data = (await res.json()) as SearchResponse;
    return (data.results ?? []).map(mapSearchResult);
  } catch (err) {
    logger.error({ err }, 'searchMemoriesByTag: failed');
    return [];
  }
}

export async function listTags(): Promise<TagCount[]> {
  try {
    const res = await fetchWithTimeout(`${MCP_MEMORY_URL}/api/tags`, { headers: authHeader() }, 3_000);
    if (!res.ok) {
      logger.warn({ status: res.status }, 'listTags: non-OK response');
      return [];
    }
    return (await res.json()) as TagCount[];
  } catch (err) {
    logger.error({ err }, 'listTags: failed');
    return [];
  }
}
