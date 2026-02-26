import { Channel, MediaAttachment, NewMessage } from './types.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMediaTags(media: MediaAttachment[]): string {
  return media.map((m) => {
    const attrs: string[] = [`type="${escapeXml(m.type)}"`, `path="${escapeXml(m.containerPath)}"`];
    if (m.caption) attrs.push(`caption="${escapeXml(m.caption)}"`);
    if (m.transcript) attrs.push(`transcript="${escapeXml(m.transcript)}"`);
    if (m.fileName) attrs.push(`filename="${escapeXml(m.fileName)}"`);
    return `<media ${attrs.join(' ')}/>`;
  }).join('\n  ');
}

export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map((m) => {
    const mediaXml = m.media?.length ? `\n  ${formatMediaTags(m.media)}` : '';
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}${mediaXml}</message>`;
  });
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
