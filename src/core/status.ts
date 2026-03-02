/**
 * Service health check command.
 * Run with: npm run status
 *
 * Phase 1.5: LLM + Whisper
 * Phase 2:   + Memory service (with memory count)
 */
import { LOCAL_LLM_URL, MCP_MEMORY_URL, WHISPER_SERVER_URL } from './config.js';

interface ServiceStatus {
  name: string;
  url: string;
  ok: boolean;
  detail?: string;
}

async function checkService(name: string, url: string, timeoutMs = 3000): Promise<ServiceStatus> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    return { name, url, ok: true, detail: `HTTP ${response.status}` };
  } catch (err) {
    clearTimeout(timeoutId);
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = message.includes('abort') || message.includes('timeout');
    return { name, url, ok: false, detail: isTimeout ? 'timeout' : 'connection refused' };
  }
}

async function checkMemory(timeoutMs = 3000): Promise<ServiceStatus> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${MCP_MEMORY_URL}/api/health`;

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) {
      return { name: 'Memory', url, ok: false, detail: `HTTP ${response.status}` };
    }
    const data = (await response.json()) as { status?: string; uptime_seconds?: number };
    const detail =
      data.uptime_seconds !== undefined ? `up ${data.uptime_seconds}s` : 'responding';
    return { name: 'Memory', url, ok: true, detail };
  } catch (err) {
    clearTimeout(timeoutId);
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = message.includes('abort') || message.includes('timeout');
    return { name: 'Memory', url, ok: false, detail: isTimeout ? 'timeout' : 'connection refused' };
  }
}

async function main(): Promise<void> {
  const [llm, memory, whisper] = await Promise.all([
    checkService('Local LLM', `${LOCAL_LLM_URL}/models`),
    checkMemory(),
    checkService('Whisper', `${WHISPER_SERVER_URL}/`),
  ]);

  const services = [llm, memory, whisper];

  console.log('\n=== Abbes Status ===');
  for (const svc of services) {
    const icon = svc.ok ? '✓' : '✗';
    const label = svc.name.padEnd(16);
    const addr = new URL(svc.url).host;
    const detail = svc.ok ? `(${svc.detail})` : `(${svc.detail})`;
    console.log(`${icon} ${label} ${addr} ${detail}`);
  }
  console.log('');

  if (services.some((s) => !s.ok)) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Status check failed:', err);
  process.exit(1);
});
