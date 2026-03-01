/**
 * HTTP client for mcp-memory-service.
 * Base URL: MCP_MEMORY_URL env var (default http://localhost:8052)
 *
 * On failure: logs the error and returns a safe value — never crashes the agent.
 */
import { MCP_MEMORY_URL } from '../core/config.js';
import { logger } from '../core/logger.js';

export interface Memory {
  id: string;
  content: string;
  tags: string[];
  createdAt: string;
  relevanceScore?: number;
}

export interface ConsolidationResult {
  merged: number;
  archived: number;
  dryRun: boolean;
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

export async function storeMemory(content: string, tags: string[]): Promise<void> {
  try {
    const res = await fetchWithTimeout(
      `${MCP_MEMORY_URL}/api/memories`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, tags }),
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
    const url = new URL(`${MCP_MEMORY_URL}/api/memories`);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(limit));
    const res = await fetchWithTimeout(url.toString(), {}, 5_000);
    if (!res.ok) {
      logger.warn({ status: res.status }, 'retrieveMemory: non-OK response');
      return [];
    }
    const data = (await res.json()) as { memories?: Memory[] };
    return data.memories ?? [];
  } catch (err) {
    logger.error({ err }, 'retrieveMemory: failed');
    return [];
  }
}

export async function searchMemory(query: string): Promise<Memory[]> {
  try {
    const url = new URL(`${MCP_MEMORY_URL}/api/memories/search`);
    url.searchParams.set('q', query);
    const res = await fetchWithTimeout(url.toString(), {}, 5_000);
    if (!res.ok) {
      logger.warn({ status: res.status }, 'searchMemory: non-OK response');
      return [];
    }
    const data = (await res.json()) as { memories?: Memory[] };
    return data.memories ?? [];
  } catch (err) {
    logger.error({ err }, 'searchMemory: failed');
    return [];
  }
}

export async function deleteMemory(id: string): Promise<void> {
  try {
    const res = await fetchWithTimeout(
      `${MCP_MEMORY_URL}/api/memories/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      5_000,
    );
    if (!res.ok) {
      logger.warn({ status: res.status, id }, 'deleteMemory: non-OK response');
    }
  } catch (err) {
    logger.error({ err, id }, 'deleteMemory: failed');
  }
}

export async function triggerConsolidation(dryRun = false): Promise<ConsolidationResult> {
  try {
    const res = await fetchWithTimeout(
      `${MCP_MEMORY_URL}/api/consolidate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy: 'dream', dry_run: dryRun }),
      },
      30_000,
    );
    if (!res.ok) {
      logger.warn({ status: res.status }, 'triggerConsolidation: non-OK response');
      return { merged: 0, archived: 0, dryRun };
    }
    const data = (await res.json()) as Partial<ConsolidationResult>;
    return { merged: data.merged ?? 0, archived: data.archived ?? 0, dryRun };
  } catch (err) {
    logger.error({ err }, 'triggerConsolidation: failed');
    return { merged: 0, archived: 0, dryRun };
  }
}

export async function getMemoryHealth(): Promise<{ ok: boolean; count?: number }> {
  try {
    const res = await fetchWithTimeout(`${MCP_MEMORY_URL}/health`, {}, 3_000);
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as { status?: string; count?: number };
    return { ok: data.status === 'ok', count: data.count };
  } catch {
    return { ok: false };
  }
}
