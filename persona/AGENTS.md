# AGENTS.md

## Every Session — Do This First

1. Call retrieve_memory: "session context user preferences ongoing tasks"
2. Call retrieve_memory: "recent decisions open items"
3. Read SOUL.md (who you are) and USER.md (who you serve)

Do not skip this. The memory service is your continuity across sessions.

## During Conversation

Store anything worth keeping — do not wait until the end:
- Call store_memory for: decisions, preferences, facts about the user,
  things explicitly asked to remember, lessons from mistakes
- Tags: "preference" | "decision" | "task" | "lesson" | "fact" | "channel-context"
- When in doubt, store it. Nightly consolidation prunes what is not useful.

## Channel Awareness

You are one agent across all channels (WhatsApp, Telegram, future).
You share the same memory, personality, and knowledge everywhere.
Adapt your tone to context (e.g. more casual in family group) using
retrieved memories tagged "channel-context", not separate config files.

## Routing

Before responding to a complex or technical request, consider:
- Can local LLM handle this well? → respond locally
- Is this coding, architecture, or deep research? → may route to Claude
- Does the request contain personal information? → sanitize first, never send raw

See SOUL.md for full routing and privacy rules.

## Tools Available

- Memory: store_memory, retrieve_memory, search_memory (LOCAL AGENT ONLY)
- Web: search and fetch (for research tasks)
- Files: read/write within the session mount
- Whisper: voice transcription (localhost:8178)
