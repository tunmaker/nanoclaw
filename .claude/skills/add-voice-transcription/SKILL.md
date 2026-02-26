---
name: add-voice-transcription
description: Add voice message transcription to NanoClaw using a local whisper.cpp server. Automatically transcribes WhatsApp voice notes so the agent can read and respond to them. Also adds full media handling (images, video, audio, documents, stickers).
---

# Add Voice Transcription (whisper.cpp)

This skill adds automatic voice message transcription to NanoClaw using a local whisper.cpp server. It also adds full media handling — downloading and mounting all media types (images, video, audio, documents, stickers) so the agent can access them inside containers.

When a voice note arrives, it is downloaded, transcribed via the local whisper.cpp HTTP server, and delivered to the agent as `[Voice message] <transcript>`.

## Prerequisites

- whisper.cpp compiled and running as an HTTP server
- A Whisper model downloaded (e.g., `ggml-base.bin` or `ggml-small.bin`)

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/whatsapp.ts` already contains `transcribeAudio`. If so, skip to Phase 3 (Configure).

### Check whisper.cpp status

```bash
curl -s http://127.0.0.1:8178/inference -F "file=@/dev/null" -F "response_format=text"
```

If the server responds (even with an error about the file), it's running. If connection refused, proceed to Phase 2 for setup instructions.

## Phase 2: Set Up whisper.cpp

### Build whisper.cpp

```bash
git clone https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp
cmake -B build
cmake --build build --config Release
```

### Download a model

```bash
./models/download-ggml-model.sh base
# Or for better accuracy: ./models/download-ggml-model.sh small
```

### Start the server

```bash
./build/bin/whisper-server -m models/ggml-base.bin --port 8178
```

For persistent operation, create a systemd service:

```ini
[Unit]
Description=Whisper.cpp Server
After=network.target

[Service]
ExecStart=/path/to/whisper.cpp/build/bin/whisper-server -m /path/to/whisper.cpp/models/ggml-base.bin --port 8178
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Save to `~/.config/systemd/user/whisper.service`, then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now whisper
```

## Phase 3: Apply Code Changes

The following changes are needed across these files:

### `src/types.ts`
Add `MediaAttachment` interface and `media` field to `NewMessage`:

```typescript
export interface MediaAttachment {
  type: 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker';
  filePath: string;        // absolute host path
  containerPath: string;   // path inside container
  mimeType: string;
  fileName?: string;       // original filename for documents
  transcript?: string;     // voice note transcript (Whisper)
  caption?: string;        // image/video caption
}
```

### `src/config.ts`
Add `MEDIA_DIR` export:
```typescript
export const MEDIA_DIR = path.resolve(PROJECT_ROOT, 'store', 'media');
```

### `src/channels/whatsapp.ts`
- Add mime-to-extension mapping, `detectMediaInfo()`, and `transcribeAudio()` functions
- Import `downloadMediaMessage` from Baileys, `MEDIA_DIR` from config, `readEnvFile` from env
- In the `messages.upsert` handler: download media, transcribe voice notes, attach media to messages
- `transcribeAudio()` sends the audio file to the whisper.cpp server via multipart form POST

### `src/db.ts`
- Add `media_json` column migration
- Store/retrieve media as JSON in messages table
- Add `parseMediaFromRow()` helper

### `src/router.ts`
- Add `formatMediaTags()` to render media as XML tags in agent messages
- Include media tags in `formatMessages()` output

### `src/container-runner.ts`
- Mount group media directory read-only at `/workspace/group/media`

### `container/Dockerfile`
- Add `ffmpeg` to container packages (needed for audio format conversion)

### Validate

```bash
npm run build
npx vitest run src/channels/whatsapp.test.ts src/container-runner.test.ts
```

## Phase 4: Configure

### Set whisper server URL (optional)

If the whisper.cpp server is not at the default `http://127.0.0.1:8178`, add to `.env`:

```bash
WHISPER_SERVER_URL=http://your-host:port
```

### Build and restart

```bash
npm run build
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
systemctl --user restart nanoclaw
```

## Phase 5: Verify

### Test with a voice note

Send a voice note in any registered WhatsApp chat. The agent should receive it with the transcript and respond to its content.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -iE 'transcri|whisper|voice|media'
```

Look for:
- `Media downloaded` — media file saved successfully
- `Whisper server returned error` — server responded but couldn't process the file
- `Failed to transcribe audio with whisper-server` — connection error (server down?)

## Troubleshooting

### Voice notes not transcribed

1. Check whisper.cpp server is running: `curl http://127.0.0.1:8178/inference -F "file=@test.ogg" -F "response_format=text"`
2. Check `WHISPER_SERVER_URL` in `.env` if using a non-default address
3. Check NanoClaw logs for whisper errors

### Media not accessible in container

1. Verify `store/media/<group-folder>/` exists and contains files
2. Check container logs for mount errors
3. Media is mounted read-only at `/workspace/group/media/` inside containers

### Agent doesn't respond to voice notes

Verify the chat is registered and the agent is running. Voice transcription only runs for registered groups.
