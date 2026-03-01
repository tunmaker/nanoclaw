# Intent: src/core/config.ts

## What this file does

`src/core/config.ts` centralizes all configuration — env vars, computed paths, and derived constants — for the NanoClaw agent.

## Changes introduced by this skill

Two new exports are added at the end of the file:

### `TELEGRAM_BOT_TOKEN`

```typescript
export const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || envConfig.TELEGRAM_BOT_TOKEN || '';
```

- Read from `readEnvFile` (same mechanism used for `ASSISTANT_NAME`, `TELEGRAM_ONLY`)
- Falls back to empty string so callers can check truthiness (`if (TELEGRAM_BOT_TOKEN)`)

### `TELEGRAM_ONLY`

```typescript
export const TELEGRAM_ONLY =
  (process.env.TELEGRAM_ONLY || envConfig.TELEGRAM_ONLY) === 'true';
```

- Boolean flag — `true` disables WhatsApp entirely and runs Telegram as the sole channel
- Must be `'true'` (string) in the env file to activate

### `TELEGRAM_MEDIA_DIR`

```typescript
export const TELEGRAM_MEDIA_DIR = path.resolve(PROJECT_ROOT, 'telegramData', 'media');
```

- Telegram media downloads land here (voice notes, photos, documents, etc.)
- Created automatically by `TelegramChannel.connect()` via `fs.mkdirSync(..., { recursive: true })`
- Mirrors `MEDIA_DIR` (`whatsappData/store/media`) but is fully separate

### `TELEGRAM_DB_PATH`

```typescript
export const TELEGRAM_DB_PATH = path.resolve(PROJECT_ROOT, 'telegramData', 'telegram.db');
```

- Path to the Telegram-only SQLite database
- Contains: `chats`, `messages`, `registered_groups` tables
- Used by `src/channels/telegram-db.ts` — completely independent of the WhatsApp DB at `whatsappData/store/messages.db`

## Invariants

- `readEnvFile` is called once at module load. The `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ONLY` keys are added to its argument array.
- No existing exports are renamed or removed.
- All Telegram data lives under `telegramData/` — never inside `whatsappData/`.
