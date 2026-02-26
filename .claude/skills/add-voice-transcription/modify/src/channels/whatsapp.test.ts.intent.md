# Intent: src/channels/whatsapp.test.ts modifications

## What changed
Added mocks for new dependencies (env, media download) and updated voice note test to verify media handling.

## Key sections

### Mocks (top of file)
- Added: `MEDIA_DIR` to config mock
- Added: `vi.mock('../env.js', ...)` with `readEnvFile` returning empty object
- Added: `downloadMediaMessage` mock to Baileys mock returning `Buffer.from('fake-media')`

### Test cases
- Existing "handles message with no extractable text (e.g. voice note without caption)" test now covers media download path

## Invariants (must-keep)
- All existing test cases for text, extendedTextMessage, imageMessage, videoMessage unchanged
- All connection lifecycle tests unchanged
- All LID translation tests unchanged
- All outgoing queue tests unchanged
- All group metadata sync tests unchanged
- All ownsJid and setTyping tests unchanged
- All existing mocks (config, logger, db, fs, child_process, baileys) preserved
- Test helpers (createTestOpts, triggerConnection, triggerDisconnect, triggerMessages, connectChannel) unchanged
