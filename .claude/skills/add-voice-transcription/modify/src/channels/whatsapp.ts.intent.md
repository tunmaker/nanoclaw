# Intent: src/channels/whatsapp.ts modifications

## What changed
Added full media handling and voice transcription via local whisper.cpp server. Media (images, video, audio, voice, documents, stickers) is downloaded, stored to disk, and attached to messages. Voice notes (PTT audio) are transcribed using a local whisper.cpp HTTP server.

## Key sections

### Imports (top of file)
- Added: `WAMessage`, `downloadMediaMessage` from Baileys
- Added: `MEDIA_DIR` from config, `readEnvFile` from env
- Added: `MediaAttachment` from types

### New functions (before class)
- `MIME_TO_EXT` — mime type to file extension mapping
- `getExtFromMime()` — resolve file extension from mime type
- `detectMediaInfo()` — detect media type/mime/caption from a WAMessage
- `WHISPER_SERVER_URL` — read from env or default to `http://127.0.0.1:8178`
- `transcribeAudio()` — POST audio file to whisper.cpp server, return transcript text

### messages.upsert handler (inside connectInternal)
- Added: `group` variable from `groups[chatJid]`
- Changed: `content` from `const` to `let` to allow voice transcript override
- Added: media download block — downloads media, saves to `store/media/<group>/`, creates `MediaAttachment`
- Added: voice note transcription — calls `transcribeAudio()` for PTT messages, sets transcript on attachment and content
- Added: descriptive content for media without text (e.g., `[Image]`, `[Document: file.pdf]`, `[Sticker]`)
- Changed: `this.opts.onMessage()` call includes `media` field

## Invariants (must-keep)
- All existing text extraction (conversation, extendedTextMessage, imageMessage caption, videoMessage caption) unchanged
- Connection lifecycle (connect, reconnect, disconnect) unchanged
- LID translation logic unchanged
- Outgoing message queue unchanged
- Group metadata sync unchanged
- sendMessage prefix logic unchanged
- setTyping, ownsJid, isConnected — all unchanged
