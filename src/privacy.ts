/**
 * Privacy filtering middleware.
 *
 * Strips sensitive data from text before it is sent to any external API.
 * All outbound requests are logged (sanitized copy only) to logs/outbound.jsonl.
 *
 * Usage:
 *   const pf = new PrivacyFilter();
 *   const [clean, redacted] = pf.sanitize("My API key is sk-abc123...");
 *   // clean    → "My API key is [API_KEY]..."
 *   // redacted → ["api_key_generic"]
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { parse } from 'yaml';

import { PRIVACY_CONFIG_PATH, LOGS_DIR } from './config.js';
import { logger } from './logger.js';

interface _Pattern {
  name: string;
  compiled: RegExp;
  label: string;
}

/**
 * Compile a regex pattern that may start with Python-style inline flags
 * like `(?i)`, `(?is)`, etc.
 */
function compileRegex(pattern: string, baseFlags: string): RegExp {
  const m = pattern.match(/^\(\?([imsx]+)\)/);
  let src = pattern;
  let flags = baseFlags;
  if (m) {
    src = pattern.slice(m[0].length);
    for (const f of m[1]) {
      if (f !== 'x' && !flags.includes(f)) flags += f;
    }
  }
  return new RegExp(src, flags);
}

export class PrivacyFilter {
  privacyMode: boolean;
  /** Path to the outbound log file. Public for testing. */
  logPath: string;
  private _patterns: _Pattern[];

  /**
   * @param configPath - Path to privacy.yaml. Defaults to configs/privacy.yaml.
   * @param logsDir    - Directory for outbound.jsonl. Defaults to logs/.
   */
  constructor(configPath?: string, logsDir?: string) {
    const filePath = configPath ?? PRIVACY_CONFIG_PATH;
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = parse(content) as {
      privacy_mode?: boolean;
      patterns?: Array<{ name: string; regex: string; label: string }>;
    };

    this.privacyMode = Boolean(data.privacy_mode);
    this._patterns = [];
    for (const entry of data.patterns ?? []) {
      this._patterns.push({
        name: entry.name,
        compiled: compileRegex(entry.regex, 's'),
        label: entry.label,
      });
    }

    const resolvedLogsDir = logsDir ?? LOGS_DIR;
    fs.mkdirSync(resolvedLogsDir, { recursive: true });
    this.logPath = path.join(resolvedLogsDir, 'outbound.jsonl');
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Return [sanitized_text, list_of_redacted_pattern_names].
   * Applies all configured patterns in order.
   */
  sanitize(text: string): [string, string[]] {
    const names: string[] = [];
    let result = text;

    for (const pat of this._patterns) {
      // Capture `pat` in a local const to avoid closure/loop-variable issues
      const _pat = pat;
      result = result.replace(_pat.compiled, () => {
        names.push(_pat.name);
        return _pat.label;
      });
    }

    return [result, names];
  }

  /**
   * Append a sanitized outbound-request record to logs/outbound.jsonl.
   */
  logOutbound(
    destination: string,
    messages: Array<{ role: string; content: string }>,
    messageId?: string,
  ): void {
    const mid = messageId ?? randomUUID();
    const sanitizedMessages = messages.map((msg) => {
      const [clean] = this.sanitize(msg.content);
      return { ...msg, content: clean };
    });

    const record = {
      ts: new Date().toISOString(),
      message_id: mid,
      destination,
      messages: sanitizedMessages,
    };

    fs.appendFileSync(this.logPath, JSON.stringify(record) + '\n');
    logger.debug({ mid, destination }, 'outbound logged');
  }

  /**
   * Throw an Error if privacy mode is enabled.
   * Call this before making any external API call.
   */
  checkPrivacyMode(): void {
    if (this.privacyMode) {
      throw new Error(
        'Privacy mode is ON — all external API calls are blocked. ' +
          'Set privacy_mode: false in configs/privacy.yaml to allow external calls.',
      );
    }
  }

  /** Reload config from disk (hot-reload). */
  reload(configPath?: string, logsDir?: string): void {
    const newFilter = new PrivacyFilter(configPath, logsDir);
    this.privacyMode = newFilter.privacyMode;
    this._patterns = (newFilter as unknown as { _patterns: _Pattern[] })._patterns;
    this.logPath = newFilter.logPath;
  }
}
