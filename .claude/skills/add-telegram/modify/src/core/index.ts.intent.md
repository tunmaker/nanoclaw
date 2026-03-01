# Intent: src/core/index.ts

## What this file does

`src/core/index.ts` is the main orchestrator. It initialises all channels, runs the message poll loop, manages group routing, and drives the container agent.

## Changes introduced by this skill

### New imports

```typescript
import { TELEGRAM_BOT_TOKEN, TELEGRAM_ONLY } from './config.js';
import { TelegramChannel } from '../channels/telegram.js';
import {
  getTelegramRegisteredGroups,
  getTelegramNewMessages,
  storeTelegramChatMetadata,
  storeTelegramMessage,
} from '../channels/telegram-db.js';
```

Note: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ONLY` are added to the existing `config.js` import. `TelegramChannel` and `telegram-db` are new imports.

### `channels` array

A `channels: Channel[]` array is added at module level. The existing `whatsapp` variable is kept but now pushed into `channels` when created.

```typescript
let whatsapp: WhatsAppChannel;
const channels: Channel[] = [];
```

### `loadState()` — merge Telegram registered groups

```typescript
registeredGroups = getAllRegisteredGroups();
// Merge in Telegram registered groups from their own DB
Object.assign(registeredGroups, getTelegramRegisteredGroups());
```

Telegram groups are loaded from `telegramData/telegram.db` and merged into the in-memory `registeredGroups` map alongside WhatsApp groups.

### `processGroupMessages()` — split DB fetch by prefix

```typescript
const missedMessages = chatJid.startsWith('tg:')
  ? getTelegramNewMessages([chatJid], sinceTimestamp, ASSISTANT_NAME).messages
  : getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
```

WhatsApp JIDs use `getMessagesSince` (WhatsApp DB). Telegram JIDs (`tg:` prefix) use `getTelegramNewMessages` (Telegram DB).

### `startMessageLoop()` — split fetch by prefix

```typescript
const waJids = allJids.filter((j) => !j.startsWith('tg:'));
const tgJids = allJids.filter((j) => j.startsWith('tg:'));

const waResult = getNewMessages(waJids, lastTimestamp, ASSISTANT_NAME);
const tgResult = getTelegramNewMessages(tgJids, lastTimestamp, ASSISTANT_NAME);

const messages = [...waResult.messages, ...tgResult.messages];
const newTimestamp = waResult.newTimestamp > tgResult.newTimestamp
  ? waResult.newTimestamp : tgResult.newTimestamp;
```

The poll loop merges results from both DBs each tick. Timestamps are compared lexicographically (ISO 8601 strings sort correctly).

### `recoverPendingMessages()` — split fetch by prefix

Same `tg:` prefix check as above to use `getTelegramNewMessages` for Telegram JIDs.

### `main()` — two separate channel option objects

```typescript
// WhatsApp channel callbacks — write to whatsappData/store/messages.db
const channelOpts = {
  onMessage: (_chatJid, msg) => storeMessage(msg),
  onChatMetadata: (chatJid, timestamp, name?, channel?, isGroup?) =>
    storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
  registeredGroups: () => registeredGroups,
};

// Telegram channel callbacks — write to telegramData/telegram.db
const tgChannelOpts = {
  onMessage: (_chatJid, msg) => storeTelegramMessage(msg),
  onChatMetadata: (chatJid, timestamp, name?) =>
    storeTelegramChatMetadata(chatJid, timestamp, name),
  registeredGroups: () => getTelegramRegisteredGroups(),
};
```

The two option objects are intentionally separate — they route callbacks to different databases.

### `main()` — conditional channel creation

```typescript
if (!TELEGRAM_ONLY) {
  whatsapp = new WhatsAppChannel(channelOpts);
  channels.push(whatsapp);
  await whatsapp.connect();
}

if (TELEGRAM_BOT_TOKEN) {
  const telegram = new TelegramChannel(TELEGRAM_BOT_TOKEN, tgChannelOpts);
  channels.push(telegram);
  await telegram.connect();
}
```

- `TELEGRAM_ONLY=true` skips WhatsApp entirely.
- Telegram is only started if `TELEGRAM_BOT_TOKEN` is set.
- Both channels can coexist (default if `TELEGRAM_ONLY` is not set).

### `findChannel` usage

All places that previously called `whatsapp.sendMessage()` or `whatsapp.setTyping()` now call through `findChannel(channels, chatJid)`, which checks `channel.ownsJid(jid)` to route to the correct channel.

## Invariants

- The WhatsApp DB (`whatsappData/store/messages.db`) and Telegram DB (`telegramData/telegram.db`) are never mixed. WhatsApp callbacks write to the WhatsApp DB; Telegram callbacks write to the Telegram DB.
- `registeredGroups` in memory is the merged union of both DBs for routing purposes.
- `getAvailableGroups()` is unchanged — it reads from `getAllChats()` (WhatsApp DB only) and is used for container snapshots, not for routing Telegram messages.
- The `channels` array is always iterated for shutdown: `for (const ch of channels) await ch.disconnect()`.
- `startIpcWatcher` still references `whatsapp?.syncGroupMetadata` directly (Telegram doesn't have a group sync equivalent).
