/**
 * LLM-based privacy router.
 *
 * Phase 1 upgrade to the YAML rule engine:
 * - Fast YAML pre-check for hard-blocked patterns (credentials, keys, etc.)
 * - Local LLM classification: PRIVATE / TECHNICAL / MIXED
 * - LLM-based sanitization for MIXED messages
 * - Audit log: logs/routing-audit.jsonl (metadata only — no message content)
 */
import fs from 'fs';
import path from 'path';

import { LOGS_DIR, PRIVACY_CONFIG_PATH } from '../core/config.js';
import { PrivacyFilter } from '../core/privacy.js';
import { callLocalLlm } from '../core/local-llm.js';

export type Sensitivity = 'private' | 'technical' | 'mixed';
export type Route = 'local' | 'claude';

export interface RoutingDecision {
  route: Route;
  sensitivity: Sensitivity;
  sanitized: boolean;
  sanitizedMessage?: string; // rephrased version, if sanitized
  reason: string;
  detectedPatterns: string[]; // for audit log only — no content
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const CLASSIFY_PROMPT = (msg: string): string =>
  `Classify this message. Reply with exactly one word.

PRIVATE  = personal info, names, relationships, health, finances, location
TECHNICAL = code, debugging, architecture, research, general knowledge
MIXED    = has both technical content AND personal identifying information

Message: "${msg}"

Classification:`;

const SANITIZE_PROMPT = (msg: string): string =>
  `Rephrase this message to remove all personally identifying information
while keeping the technical question answerable.

Rules:
- Real names → Person1, Person2, etc.
- Company names → "the company" or "an organization"
- Specific locations → "a location"
- Passwords, tokens, secrets → [REDACTED]
- Keep: all code, commands, error messages, architecture details
- The result must be a coherent, answerable question

Original: "${msg}"

Rephrased:`;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Lazy-loaded PrivacyFilter instance for fast YAML pre-check
let _filter: PrivacyFilter | undefined;

function getFilter(): PrivacyFilter {
  if (!_filter) _filter = new PrivacyFilter();
  return _filter;
}

/** @internal — for tests only */
export function _resetFilter(): void {
  _filter = undefined;
}

/** Write a metadata-only audit entry to logs/routing-audit.jsonl. */
export function writeAuditLog(
  entry: Omit<RoutingDecision, 'sanitizedMessage'>,
): void {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const logPath = path.join(LOGS_DIR, 'routing-audit.jsonl');
  const record = {
    ts: new Date().toISOString(),
    route: entry.route,
    sensitivity: entry.sensitivity,
    sanitized: entry.sanitized,
    detectedPatterns: entry.detectedPatterns,
    reason: entry.reason,
  };
  fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Classify a message and decide how to route it.
 *
 * 1. Fast YAML pre-check — if any hard-blocked pattern matches, skip LLM.
 * 2. LLM classification (local llama.cpp) → PRIVATE / TECHNICAL / MIXED.
 * 3. PRIVATE   → local LLM, no sanitization.
 *    TECHNICAL → Claude, no sanitization.
 *    MIXED     → LLM sanitizes → Claude.
 * 4. Write metadata-only audit log entry.
 */
export async function classifyAndRoute(
  message: string,
): Promise<RoutingDecision> {
  const filter = getFilter();

  // Respect global privacy mode — block all external calls
  if (filter.privacyMode) {
    const decision: RoutingDecision = {
      route: 'local',
      sensitivity: 'private',
      sanitized: false,
      reason: 'privacy mode enabled — all external calls blocked',
      detectedPatterns: [],
    };
    writeAuditLog(decision);
    return decision;
  }

  // Step 1: Fast YAML pre-check
  const [, detectedPatterns] = filter.sanitize(message);
  if (detectedPatterns.length > 0) {
    const decision: RoutingDecision = {
      route: 'local',
      sensitivity: 'private',
      sanitized: false,
      reason: 'hard-blocked pattern detected by YAML pre-filter',
      detectedPatterns,
    };
    writeAuditLog(decision);
    return decision;
  }

  // Step 2: LLM classification
  const classifyResponse = await callLocalLlm(
    [{ role: 'user', content: CLASSIFY_PROMPT(message) }],
    10,
  );
  const label = classifyResponse.trim().toUpperCase().split(/\s+/)[0] ?? '';
  const sensitivity: Sensitivity =
    label === 'PRIVATE' ? 'private' : label === 'MIXED' ? 'mixed' : 'technical';

  // Step 3: Route
  if (sensitivity === 'private') {
    const decision: RoutingDecision = {
      route: 'local',
      sensitivity: 'private',
      sanitized: false,
      reason: 'LLM classified as PRIVATE',
      detectedPatterns: [],
    };
    writeAuditLog(decision);
    return decision;
  }

  if (sensitivity === 'technical') {
    const decision: RoutingDecision = {
      route: 'claude',
      sensitivity: 'technical',
      sanitized: false,
      reason: 'LLM classified as TECHNICAL',
      detectedPatterns: [],
    };
    writeAuditLog(decision);
    return decision;
  }

  // MIXED: sanitize with LLM, then route to Claude
  const sanitizedMessage = await callLocalLlm(
    [{ role: 'user', content: SANITIZE_PROMPT(message) }],
    512,
  );
  const decision: RoutingDecision = {
    route: 'claude',
    sensitivity: 'mixed',
    sanitized: true,
    sanitizedMessage: sanitizedMessage.trim(),
    reason: 'LLM classified as MIXED — sanitized before sending to Claude',
    detectedPatterns: [],
  };
  writeAuditLog(decision);
  return decision;
}
