import { createHash } from 'node:crypto';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';

/** Stable host-owned row identity, including across activation retries. */
export function mcpActivationMessageId(originatingMessageId: string): string {
  return `mcp-activation-${createHash('sha256').update(originatingMessageId).digest('hex').slice(0, 24)}`;
}

/** Compatibility saves cannot write host-owned recovery rows. Check the
 * reserved identity too, since an older client may discard unknown blocks.
 */
export function isMcpActivationMessage(message: PersistedChatMessage): boolean {
  return (
    /^mcp-activation-[a-f0-9]{24}$/.test(message.id) ||
    message.blocks.some((block) => block.type === 'mcp_activation')
  );
}
