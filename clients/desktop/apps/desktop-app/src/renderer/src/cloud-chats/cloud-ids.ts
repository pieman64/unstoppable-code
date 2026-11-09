import type { CanopyCoreRelayAuthority } from '../../../shared/canopy-core-relay';

/**
 * Renderer identity for cloud chats (CAN-4185 D6): every cloud id carries
 * its authority, and no local id starts with this prefix, so a cloud key can
 * never be mistaken for, or sent as, a local one.
 */
const AUTHORITY: CanopyCoreRelayAuthority = 'web-core';
const PREFIX = `${AUTHORITY}:`;

export function cloudChatKey(chatId: string): string {
  return `${PREFIX}${chatId}`;
}

export function isCloudChatKey(key: string): boolean {
  return key.startsWith(PREFIX) && key.length > PREFIX.length;
}

export function parseCloudChatKey(
  key: string,
): { authority: CanopyCoreRelayAuthority; chatId: string } | null {
  if (!isCloudChatKey(key)) return null;
  const chatId = key.slice(PREFIX.length);
  return chatId.includes(':') ? null : { authority: AUTHORITY, chatId };
}
