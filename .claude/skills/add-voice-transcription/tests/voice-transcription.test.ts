import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('voice-transcription skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: voice-transcription');
    expect(content).toContain('version: 2.0.0');
    expect(content).toContain('whisper.cpp');
    expect(content).toContain('WHISPER_SERVER_URL');
  });

  it('has all files declared in modifies', () => {
    const whatsappFile = path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.ts');
    const whatsappTestFile = path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.test.ts');

    expect(fs.existsSync(whatsappFile)).toBe(true);
    expect(fs.existsSync(whatsappTestFile)).toBe(true);
  });

  it('has intent files for key modified files', () => {
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.ts.intent.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.test.ts.intent.md'))).toBe(true);
  });

  it('modified whatsapp.ts includes whisper.cpp transcription', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.ts'),
      'utf-8',
    );

    // Core class and methods preserved
    expect(content).toContain('class WhatsAppChannel');
    expect(content).toContain('implements Channel');
    expect(content).toContain('async connect()');
    expect(content).toContain('async sendMessage(');

    // Media handling
    expect(content).toContain('detectMediaInfo');
    expect(content).toContain('downloadMediaMessage');
    expect(content).toContain('MIME_TO_EXT');
    expect(content).toContain('MediaAttachment');

    // Whisper.cpp transcription
    expect(content).toContain('WHISPER_SERVER_URL');
    expect(content).toContain('transcribeAudio');
    expect(content).toContain('/inference');
    expect(content).toContain('response_format');
    expect(content).toContain('[Voice message]');
  });

  it('modified whatsapp.test.ts includes media mock', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.test.ts'),
      'utf-8',
    );

    // Media mock
    expect(content).toContain('downloadMediaMessage');
    expect(content).toContain('MEDIA_DIR');
    expect(content).toContain('readEnvFile');

    // All existing test sections preserved
    expect(content).toContain("describe('connection lifecycle'");
    expect(content).toContain("describe('message handling'");
    expect(content).toContain("describe('LID to JID translation'");
    expect(content).toContain("describe('outgoing message queue'");
    expect(content).toContain("describe('group metadata sync'");
  });
});
