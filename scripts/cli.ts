/**
 * abbes-cli — local interactive REPL for testing the full agent decision loop.
 *
 * Shows:
 *   - Routing decision (local / claude) with sensitivity and reason
 *   - Which persona files loaded (SOUL / USER / AGENTS)
 *   - Retrieved memories injected into the system prompt
 *   - Each ReAct iteration: LLM finish_reason, tool calls, tool results
 *   - Final answer
 *
 * Usage:
 *   cd ~/abbes/nanoclaw && npm run cli
 *   or: npx tsx scripts/cli.ts
 */
import * as readline from 'readline';
import { classifyAndRoute } from '../src/intelligence/privacy-router.js';
import { runLocalAgent } from '../src/intelligence/local-agent.js';
import type { AgentDebugHook } from '../src/intelligence/local-agent.js';

// ---------------------------------------------------------------------------
// ANSI colours
// ---------------------------------------------------------------------------

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  magenta: '\x1b[35m',
  blue:    '\x1b[34m',
  gray:    '\x1b[90m',
  white:   '\x1b[37m',
};

const bold    = (s: string) => `${C.bold}${s}${C.reset}`;
const dim     = (s: string) => `${C.dim}${s}${C.reset}`;
const cyan    = (s: string) => `${C.cyan}${s}${C.reset}`;
const green   = (s: string) => `${C.green}${s}${C.reset}`;
const yellow  = (s: string) => `${C.yellow}${s}${C.reset}`;
const red     = (s: string) => `${C.red}${s}${C.reset}`;
const magenta = (s: string) => `${C.magenta}${s}${C.reset}`;
const gray    = (s: string) => `${C.gray}${s}${C.reset}`;

const DIVIDER = gray('─'.repeat(60));

function header(label: string): void {
  console.log(`\n${DIVIDER}`);
  console.log(bold(cyan(` ▸ ${label}`)));
  console.log(DIVIDER);
}

function row(label: string, value: string): void {
  const padded = label.padEnd(14);
  console.log(`  ${bold(padded)} ${value}`);
}

// ---------------------------------------------------------------------------
// Build the debug hook
// ---------------------------------------------------------------------------

function makeDebugHook(): AgentDebugHook {
  return {
    onSystemPrompt({ soulLoaded, userLoaded, agentsLoaded, sessionMemories, decisionMemories }) {
      header('Persona & Memory');

      const tick = (loaded: boolean, name: string) =>
        loaded ? `${green('✓')} ${name}` : `${red('✗')} ${name} ${red('(missing!)')}`;

      console.log(`  ${tick(soulLoaded, 'SOUL.md')}   ${tick(userLoaded, 'USER.md')}   ${tick(agentsLoaded, 'AGENTS.md')}`);

      console.log();
      if (sessionMemories.length === 0 && decisionMemories.length === 0) {
        console.log(`  ${dim('No memories retrieved (empty store or mcp-memory down)')}`);
      } else {
        if (sessionMemories.length > 0) {
          console.log(`  ${bold('Session memories:')} (${sessionMemories.length})`);
          for (const m of sessionMemories) {
            console.log(`    ${gray('•')} ${m.content}`);
          }
        }
        if (decisionMemories.length > 0) {
          console.log(`  ${bold('Decision memories:')} (${decisionMemories.length})`);
          for (const m of decisionMemories) {
            console.log(`    ${gray('•')} ${m.content}`);
          }
        }
      }
    },

    onIteration(iteration) {
      header(`ReAct iteration ${iteration}`);
    },

    onLlmResponse(finishReason, content, toolCalls) {
      const reasonLabel =
        finishReason === 'stop'       ? green('stop')
        : finishReason === 'tool_calls' ? yellow('tool_calls')
        : finishReason === 'length'   ? red('length (truncated)')
        : yellow(finishReason);

      console.log(`  ${bold('finish_reason')} ${reasonLabel}`);

      if (finishReason === 'stop' && content) {
        console.log();
        console.log(`  ${bold('LLM output:')}`);
        const lines = content.split('\n');
        for (const line of lines) {
          console.log(`    ${line}`);
        }
      }

      if (toolCalls?.length) {
        for (const tc of toolCalls) {
          let argsStr: string;
          try {
            argsStr = JSON.stringify(JSON.parse(tc.function.arguments), null, 2)
              .split('\n')
              .join('\n    ');
          } catch {
            argsStr = tc.function.arguments;
          }
          console.log(`  ${bold('→ tool:')} ${magenta(tc.function.name)}  ${gray(`[${tc.id.slice(0, 8)}]`)}`);
          console.log(`    ${gray('args:')} ${argsStr}`);
        }
      }
    },

    onToolResult(name, _args, result) {
      console.log(`  ${bold('← result:')} ${cyan(name)}`);
      const lines = result.split('\n').slice(0, 20); // cap long results
      for (const line of lines) {
        console.log(`    ${dim(line)}`);
      }
      if (result.split('\n').length > 20) {
        console.log(`    ${dim('… (truncated)')}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Process a single input through the full decision loop
// ---------------------------------------------------------------------------

async function processInput(input: string): Promise<void> {
  const trimmed = input.trim();
  if (!trimmed) return;

  // --- Routing ---
  header('Routing');
  if (process.stdout.isTTY) process.stdout.write(`  ${dim('Classifying…')}\r`);

  let decision: Awaited<ReturnType<typeof classifyAndRoute>>;
  try {
    decision = await classifyAndRoute(trimmed);
  } catch (err) {
    console.log(`  ${red('Routing error:')} ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (process.stdout.isTTY) process.stdout.write('\x1b[2K'); // clear the "Classifying…" line

  const routeLabel =
    decision.route === 'local'
      ? `${green('LOCAL')}  ${dim('(local LLM)')}`
      : `${yellow('CLAUDE')} ${dim('(container)')}`;

  const sensitivityLabel =
    decision.sensitivity === 'private'   ? gray('PRIVATE')
    : decision.sensitivity === 'technical' ? cyan('TECHNICAL')
    : yellow('MIXED');

  row('Route',       routeLabel);
  row('Sensitivity', sensitivityLabel);
  row('Reason',      dim(decision.reason));

  if (decision.sanitized && decision.sanitizedMessage) {
    console.log();
    console.log(`  ${bold('Sanitized message sent to Claude:')}`);
    console.log(`  ${yellow(decision.sanitizedMessage)}`);
  }

  // --- Local path ---
  if (decision.route === 'local') {
    const debug = makeDebugHook();
    const messageToSend = decision.sanitizedMessage ?? trimmed;

    let reply: string;
    try {
      reply = await runLocalAgent({ text: messageToSend }, debug);
    } catch (err) {
      header('Error');
      console.log(`  ${red(err instanceof Error ? err.message : String(err))}`);
      return;
    }

    header('Response  (LOCAL LLM)');
    console.log();
    // Print with indentation
    for (const line of reply.split('\n')) {
      console.log(`  ${line}`);
    }
    console.log();
    return;
  }

  // --- Claude path ---
  header('Response  (CLAUDE — container not spawned in CLI)');
  console.log();
  console.log(`  ${dim('In production this would launch a sandboxed Claude container.')}`);
  if (decision.sanitizedMessage) {
    console.log(`  ${dim('Sanitized input that would be sent:')}`);
    console.log(`  ${yellow(decision.sanitizedMessage)}`);
  } else {
    console.log(`  ${dim('Input (no sanitization needed):')}`);
    console.log(`  ${yellow(trimmed)}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// REPL
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log();
  console.log(bold(cyan('  abbes CLI')));
  console.log(dim('  Full decision loop: routing → persona → ReAct → response'));
  console.log(dim('  Type a message, or .quit / Ctrl+C to exit'));
  console.log();

  const isTTY = Boolean(process.stdout.isTTY);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: isTTY,
    prompt: isTTY ? `${bold(cyan('abbes'))}${bold('>')} ` : '',
  });

  if (isTTY) rl.prompt();

  let pending = false;

  rl.on('line', async (line) => {
    const trimmed = line.trim();

    if (trimmed === '.quit' || trimmed === '.exit') {
      console.log(dim('  Bye.'));
      rl.close();
      process.exit(0);
    }

    if (trimmed === '.help') {
      console.log();
      console.log(`  ${bold('.help')}   — show this help`);
      console.log(`  ${bold('.quit')}   — exit`);
      console.log();
      if (isTTY) rl.prompt();
      return;
    }

    if (!trimmed) {
      if (isTTY) rl.prompt();
      return;
    }

    pending = true;
    rl.pause();
    try {
      await processInput(trimmed);
    } catch (err) {
      console.log(`${red('Unexpected error:')} ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      pending = false;
    }
    rl.resume();
    if (isTTY) rl.prompt();
  });

  rl.on('close', async () => {
    // Wait for any in-flight processing before exiting
    if (pending) {
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (!pending) { clearInterval(check); resolve(); }
        }, 100);
      });
    }
    console.log();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(red(`Fatal: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
