/**
 * Task-based routing engine.
 *
 * Decides whether each message goes to the local LLM or the Claude container.
 * Rules are loaded from configs/routing.yaml — no logic is hard-coded here.
 */
import fs from 'fs';
import { randomUUID } from 'crypto';

import { parse } from 'yaml';

import { ROUTING_CONFIG_PATH } from './config.js';
import { logger } from './logger.js';

export type RoutingTarget = 'local' | 'claude';

export interface RoutingDecision {
  messageId: string;
  routedTo: RoutingTarget;
  ruleName: string;
  reason: string;
  messagePreview: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compile a regex pattern that may start with Python-style inline flags
 * like `(?i)`, `(?is)`, etc.  Extracts them and adds the corresponding
 * JS flags so the pattern works correctly in JavaScript.
 */
function compileRegex(pattern: string, baseFlags: string): RegExp {
  const m = pattern.match(/^\(\?([imsx]+)\)/);
  let src = pattern;
  let flags = baseFlags;
  if (m) {
    src = pattern.slice(m[0].length);
    for (const f of m[1]) {
      // 'x' (verbose) has no JS equivalent — skip
      if (f !== 'x' && !flags.includes(f)) flags += f;
    }
  }
  return new RegExp(src, flags);
}

interface RuleData {
  name: string;
  priority: number;
  target: RoutingTarget;
  reason: string;
  patterns?: Array<{ type: string; values?: string[]; value?: string }>;
}

class Rule {
  name: string;
  priority: number;
  target: RoutingTarget;
  reason: string;
  keywordSets: string[][];
  regexPatterns: RegExp[];

  constructor(data: {
    name: string;
    priority: number;
    target: RoutingTarget;
    reason: string;
    keywordSets: string[][];
    regexPatterns: RegExp[];
  }) {
    this.name = data.name;
    this.priority = data.priority;
    this.target = data.target;
    this.reason = data.reason;
    this.keywordSets = data.keywordSets;
    this.regexPatterns = data.regexPatterns;
  }

  /**
   * Return true if any pattern in this rule matches the text.
   * Case-insensitive keyword substring check OR regex search.
   * Empty pattern list = catch-all (default rule).
   */
  matches(text: string): boolean {
    const lower = text.toLowerCase();
    for (const keywords of this.keywordSets) {
      if (keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
        return true;
      }
    }
    for (const pattern of this.regexPatterns) {
      if (pattern.test(text)) {
        return true;
      }
    }
    // Empty pattern list means catch-all
    if (this.keywordSets.length === 0 && this.regexPatterns.length === 0) {
      return true;
    }
    return false;
  }
}

function loadRules(configPath?: string): Rule[] {
  const filePath = configPath ?? ROUTING_CONFIG_PATH;
  const content = fs.readFileSync(filePath, 'utf-8');
  const data = parse(content) as { rules?: RuleData[] };

  const rules: Rule[] = [];
  for (const entry of data.rules ?? []) {
    const keywordSets: string[][] = [];
    const regexPatterns: RegExp[] = [];

    for (const pat of entry.patterns ?? []) {
      if (pat.type === 'keyword' && pat.values) {
        keywordSets.push(pat.values);
      } else if (pat.type === 'regex' && pat.value) {
        regexPatterns.push(compileRegex(pat.value, 's'));
      }
    }

    rules.push(
      new Rule({
        name: entry.name,
        priority: entry.priority,
        target: entry.target,
        reason: entry.reason,
        keywordSets,
        regexPatterns,
      }),
    );
  }

  return rules.sort((a, b) => a.priority - b.priority);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export class Router {
  private _rules: Rule[];

  constructor(configPath?: string) {
    this._rules = loadRules(configPath);
  }

  /** Hot-reload routing rules from disk. */
  reload(configPath?: string): void {
    this._rules = loadRules(configPath);
  }

  /**
   * Return a routing decision for `message`.
   * Synchronous — routing is pure CPU logic, no I/O needed at runtime.
   */
  route(message: string, messageId?: string): RoutingDecision {
    const mid = messageId ?? randomUUID();

    for (const rule of this._rules) {
      if (rule.matches(message)) {
        const decision: RoutingDecision = {
          messageId: mid,
          routedTo: rule.target,
          ruleName: rule.name,
          reason: rule.reason,
          messagePreview: message.slice(0, 80),
        };
        logger.info({ decision }, 'routing decision');
        return decision;
      }
    }

    // Should never reach here because the default rule always matches.
    const decision: RoutingDecision = {
      messageId: mid,
      routedTo: 'local',
      ruleName: 'fallback',
      reason: 'no rule matched — defaulting to local',
      messagePreview: message.slice(0, 80),
    };
    logger.warn({ decision }, 'routing fallback');
    return decision;
  }
}

