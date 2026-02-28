/**
 * Local LLM caller.
 *
 * Sends messages to a local llama.cpp OpenAI-compatible API.
 * Used for the "local" routing path — bypasses the container entirely.
 */
import { LOCAL_LLM_URL } from './config.js';

export async function callLocalLlm(
  messages: Array<{ role: string; content: string }>,
  maxTokens = 1024,
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120_000);

  try {
    const response = await fetch(`${LOCAL_LLM_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'default', messages, max_tokens: maxTokens }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Local LLM request failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0].message.content;
  } finally {
    clearTimeout(timeoutId);
  }
}
