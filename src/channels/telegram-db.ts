/**
 * Telegram-specific SQLite database.
 * All Telegram data (chats, messages, registered groups) lives in
 * telegramData/telegram.db — completely separate from the WhatsApp DB
 * at whatsappData/store/messages.db.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { TELEGRAM_DB_PATH } from '../core/config.js';
import type { NewMessage, RegisteredGroup } from '../core/types.js';

let _db: Database.Database | null = null;

function db(): Database.Database {
  if (!_db) {
    fs.mkdirSync(path.dirname(TELEGRAM_DB_PATH), { recursive: true });
    _db = new Database(TELEGRAM_DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        jid TEXT PRIMARY KEY,
        name TEXT,
        last_message_time TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT,
        chat_jid TEXT,
        sender TEXT,
        sender_name TEXT,
        content TEXT,
        timestamp TEXT,
        is_from_me INTEGER,
        is_bot_message INTEGER DEFAULT 0,
        media_json TEXT,
        PRIMARY KEY (id, chat_jid)
      );
      CREATE INDEX IF NOT EXISTS idx_tg_timestamp ON messages(timestamp);
      CREATE TABLE IF NOT EXISTS registered_groups (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folder TEXT NOT NULL UNIQUE,
        trigger_pattern TEXT NOT NULL,
        added_at TEXT NOT NULL,
        container_config TEXT,
        requires_trigger INTEGER DEFAULT 1
      );
    `);
    // Migration: add media_json to existing DBs created before this column existed
    try {
      _db.exec(`ALTER TABLE messages ADD COLUMN media_json TEXT`);
    } catch {
      // Column already exists — safe to ignore
    }
  }
  return _db;
}

export function storeTelegramChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
): void {
  if (name) {
    db().prepare(
      `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         name = excluded.name,
         last_message_time = MAX(last_message_time, excluded.last_message_time)`,
    ).run(chatJid, name, timestamp);
  } else {
    db().prepare(
      `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         last_message_time = MAX(last_message_time, excluded.last_message_time)`,
    ).run(chatJid, chatJid, timestamp);
  }
}

export function storeTelegramMessage(msg: NewMessage): void {
  db().prepare(
    `INSERT OR REPLACE INTO messages
       (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, media_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.media ? JSON.stringify(msg.media) : null,
  );
}

export function getTelegramNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  const rows = db().prepare(
    `SELECT id, chat_jid, sender, sender_name, content, timestamp, media_json
     FROM messages
     WHERE timestamp > ? AND chat_jid IN (${placeholders})
       AND is_bot_message = 0 AND content NOT LIKE ?
     ORDER BY timestamp`,
  ).all(lastTimestamp, ...jids, `${botPrefix}:%`) as Array<NewMessage & { media_json?: string }>;

  let newTimestamp = lastTimestamp;
  const messages: NewMessage[] = rows.map((row) => {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
    const { media_json, ...msg } = row;
    if (media_json) {
      try { msg.media = JSON.parse(media_json) as NewMessage['media']; } catch { /* ignore */ }
    }
    return msg;
  });
  return { messages, newTimestamp };
}

export function getTelegramRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db().prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    };
  }
  return result;
}

export function setTelegramRegisteredGroup(
  jid: string,
  group: RegisteredGroup,
): void {
  db().prepare(
    `INSERT OR REPLACE INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
  );
}

/** @internal - for tests only */
export function _closeTelegramDb(): void {
  if (_db) { _db.close(); _db = null; }
}
