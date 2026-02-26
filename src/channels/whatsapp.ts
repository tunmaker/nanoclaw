import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  WASocket,
  WAMessage,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { ASSISTANT_HAS_OWN_NUMBER, ASSISTANT_NAME, MEDIA_DIR, STORE_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import {
  getLastGroupSync,
  setLastGroupSync,
  updateChatName,
} from '../db.js';
import { logger } from '../logger.js';
import { Channel, MediaAttachment, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Mime type to file extension mapping
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/3gpp': '.3gp',
  'audio/ogg; codecs=opus': '.ogg',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'application/pdf': '.pdf',
};

function getExtFromMime(mimeType: string): string {
  return MIME_TO_EXT[mimeType] || `.${mimeType.split('/')[1]?.split(';')[0] || 'bin'}`;
}

/** Detect media type from a Baileys message */
function detectMediaInfo(msg: WAMessage): {
  type: MediaAttachment['type'];
  mimeType: string;
  caption?: string;
  fileName?: string;
  isPtt: boolean;
} | null {
  const m = msg.message;
  if (!m) return null;

  if (m.imageMessage) {
    return { type: 'image', mimeType: m.imageMessage.mimetype || 'image/jpeg', caption: m.imageMessage.caption || undefined, isPtt: false };
  }
  if (m.videoMessage) {
    return { type: 'video', mimeType: m.videoMessage.mimetype || 'video/mp4', caption: m.videoMessage.caption || undefined, isPtt: false };
  }
  if (m.audioMessage) {
    const isPtt = m.audioMessage.ptt === true;
    return { type: isPtt ? 'voice' : 'audio', mimeType: m.audioMessage.mimetype || 'audio/ogg; codecs=opus', isPtt };
  }
  if (m.documentMessage) {
    return { type: 'document', mimeType: m.documentMessage.mimetype || 'application/octet-stream', fileName: m.documentMessage.fileName || undefined, isPtt: false };
  }
  if (m.stickerMessage) {
    return { type: 'sticker', mimeType: m.stickerMessage.mimetype || 'image/webp', isPtt: false };
  }
  return null;
}

const WHISPER_SERVER_URL = readEnvFile(['WHISPER_SERVER_URL']).WHISPER_SERVER_URL || 'http://127.0.0.1:8178';

/** Transcribe an audio file using local whisper.cpp server */
async function transcribeAudio(filePath: string): Promise<string | undefined> {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const blob = new Blob([fileBuffer]);
    const formData = new FormData();
    formData.append('file', blob, path.basename(filePath));
    formData.append('response_format', 'text');

    const response = await fetch(`${WHISPER_SERVER_URL}/inference`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      logger.error({ status: response.status, filePath }, 'Whisper server returned error');
      return undefined;
    }

    const text = await response.text();
    return text.trim() || undefined;
  } catch (err) {
    logger.error({ err, filePath }, 'Failed to transcribe audio with whisper-server');
    return undefined;
  }
}

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private sock!: WASocket;
  private connected = false;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;

  private opts: WhatsAppChannelOpts;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve).catch(reject);
    });
  }

  private async connectInternal(onFirstOpen?: () => void): Promise<void> {
    const authDir = path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
      logger.warn({ err }, 'Failed to fetch latest WA Web version, using default');
      return { version: undefined };
    });
    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Chrome'),
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const msg =
          'WhatsApp authentication required. Run /setup in Claude Code.';
        logger.error(msg);
        exec(
          `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
        );
        setTimeout(() => process.exit(1), 1000);
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        logger.info({ reason, shouldReconnect, queuedMessages: this.outgoingQueue.length }, 'Connection closed');

        if (shouldReconnect) {
          logger.info('Reconnecting...');
          this.connectInternal().catch((err) => {
            logger.error({ err }, 'Failed to reconnect, retrying in 5s');
            setTimeout(() => {
              this.connectInternal().catch((err2) => {
                logger.error({ err: err2 }, 'Reconnection retry failed');
              });
            }, 5000);
          });
        } else {
          logger.info('Logged out. Run /setup to re-authenticate.');
          process.exit(0);
        }
      } else if (connection === 'open') {
        this.connected = true;
        logger.info('Connected to WhatsApp');

        // Announce availability so WhatsApp relays subsequent presence updates (typing indicators)
        this.sock.sendPresenceUpdate('available').catch((err) => {
          logger.warn({ err }, 'Failed to send presence update');
        });

        // Build LID to phone mapping from auth state for self-chat translation
        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
            logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
          }
        }

        // Flush any messages queued while disconnected
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing queue'),
        );

        // Sync group metadata on startup (respects 24h cache)
        this.syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );
        // Set up daily sync timer (only once)
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        // Signal first connection to caller
        if (onFirstOpen) {
          onFirstOpen();
          onFirstOpen = undefined;
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) continue;
        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid === 'status@broadcast') continue;

        // Translate LID JID to phone JID if applicable
        const chatJid = await this.translateJid(rawJid);

        const timestamp = new Date(
          Number(msg.messageTimestamp) * 1000,
        ).toISOString();

        // Always notify about chat metadata for group discovery
        const isGroup = chatJid.endsWith('@g.us');
        this.opts.onChatMetadata(chatJid, timestamp, undefined, 'whatsapp', isGroup);

        // Only deliver full message for registered groups
        const groups = this.opts.registeredGroups();
        if (groups[chatJid]) {
          const group = groups[chatJid];

          // Extract text content
          let content =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            '';

          // Download media if present
          let media: MediaAttachment[] | undefined;
          const mediaInfo = detectMediaInfo(msg);
          if (mediaInfo) {
            try {
              const buffer = await downloadMediaMessage(msg, 'buffer', {});
              const ext = mediaInfo.fileName
                ? path.extname(mediaInfo.fileName)
                : getExtFromMime(mediaInfo.mimeType);
              const fileName = `${Date.now()}-${msg.key.id || 'unknown'}${ext}`;
              const groupMediaDir = path.join(MEDIA_DIR, group.folder);
              fs.mkdirSync(groupMediaDir, { recursive: true });
              const filePath = path.join(groupMediaDir, fileName);
              fs.writeFileSync(filePath, buffer as Buffer);

              const containerPath = `/workspace/group/media/${fileName}`;

              const attachment: MediaAttachment = {
                type: mediaInfo.type,
                filePath,
                containerPath,
                mimeType: mediaInfo.mimeType,
              };

              if (mediaInfo.caption) attachment.caption = mediaInfo.caption;
              if (mediaInfo.fileName) attachment.fileName = mediaInfo.fileName;

              // Transcribe voice notes
              if (mediaInfo.type === 'voice') {
                const transcript = await transcribeAudio(filePath);
                if (transcript) {
                  attachment.transcript = transcript;
                  // Use transcript as content so message isn't filtered as empty
                  if (!content) content = `[Voice message] ${transcript}`;
                }
              }

              // For media without text, set a descriptive content
              if (!content) {
                if (mediaInfo.type === 'document' && mediaInfo.fileName) {
                  content = `[Document: ${mediaInfo.fileName}]`;
                } else if (mediaInfo.type === 'sticker') {
                  content = '[Sticker]';
                } else {
                  content = `[${mediaInfo.type.charAt(0).toUpperCase() + mediaInfo.type.slice(1)}]`;
                }
              }

              media = [attachment];
              logger.info(
                { group: group.name, type: mediaInfo.type, fileName },
                'Media downloaded',
              );
            } catch (err) {
              logger.error({ err, group: group.name, type: mediaInfo.type }, 'Failed to download media');
              // Still process the message with whatever text content exists
              if (!content) continue;
            }
          }

          // Skip protocol messages with no text content (encryption keys, read receipts, etc.)
          if (!content) continue;

          const sender = msg.key.participant || msg.key.remoteJid || '';
          const senderName = msg.pushName || sender.split('@')[0];

          const fromMe = msg.key.fromMe || false;
          // Detect bot messages: with own number, fromMe is reliable
          // since only the bot sends from that number.
          // With shared number, bot messages carry the assistant name prefix
          // (even in DMs/self-chat) so we check for that.
          const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
            ? fromMe
            : content.startsWith(`${ASSISTANT_NAME}:`);

          this.opts.onMessage(chatJid, {
            id: msg.key.id || '',
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content,
            timestamp,
            is_from_me: fromMe,
            is_bot_message: isBotMessage,
            media,
          });
        }
      }
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Prefix bot messages with assistant name so users know who's speaking.
    // On a shared number, prefix is also needed in DMs (including self-chat)
    // to distinguish bot output from user messages.
    // Skip only when the assistant has its own dedicated phone number.
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${ASSISTANT_NAME}: ${text}`;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.info({ jid, length: prefixed.length, queueSize: this.outgoingQueue.length }, 'WA disconnected, message queued');
      return;
    }
    try {
      await this.sock.sendMessage(jid, { text: prefixed });
      logger.info({ jid, length: prefixed.length }, 'Message sent');
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.warn({ jid, err, queueSize: this.outgoingQueue.length }, 'Failed to send, message queued');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sock?.end(undefined);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const status = isTyping ? 'composing' : 'paused';
      logger.debug({ jid, status }, 'Sending presence update');
      await this.sock.sendPresenceUpdate(status, jid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  /**
   * Sync group metadata from WhatsApp.
   * Fetches all participating groups and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncGroupMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing group metadata from WhatsApp...');
      const groups = await this.sock.groupFetchAllParticipating();

      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          updateChatName(jid, metadata.subject);
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];

    // Check local cache first
    const cached = this.lidToPhoneMap[lidUser];
    if (cached) {
      logger.debug({ lidJid: jid, phoneJid: cached }, 'Translated LID to phone JID (cached)');
      return cached;
    }

    // Query Baileys' signal repository for the mapping
    try {
      const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.lidToPhoneMap[lidUser] = phoneJid;
        logger.info({ lidJid: jid, phoneJid }, 'Translated LID to phone JID (signalRepository)');
        return phoneJid;
      }
    } catch (err) {
      logger.debug({ err, jid }, 'Failed to resolve LID via signalRepository');
    }

    return jid;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info({ count: this.outgoingQueue.length }, 'Flushing outgoing message queue');
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        // Send directly — queued items are already prefixed by sendMessage
        await this.sock.sendMessage(item.jid, { text: item.text });
        logger.info({ jid: item.jid, length: item.text.length }, 'Queued message sent');
      }
    } finally {
      this.flushing = false;
    }
  }
}
