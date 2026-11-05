import type { ProviderCarryoverSummary } from '@canopy/desktop-shared/types';

/**
 * The confirmation under a connected provider: what the user's own setup
 * carries over, and where it is ready (CAN-3701). One fixed sentence per
 * provider, whatever was found, so every signed-in row reads the same way
 * (CAN-4765); the Marketplace lists the items.
 */
const READY_SENTENCE: Record<ProviderCarryoverSummary['provider'], string> = {
  claude:
    'Skills, commands, and plugins you add to Claude Code are ready in your Claude chats.',
  codex: 'Skills and plugins you add to Codex are ready in your Codex chats.',
  cursor:
    'Skills and commands in the folders your Cursor chats read are ready in your Cursor chats.',
};

export function providerCarryoverLine(
  summary: ProviderCarryoverSummary,
): string {
  return READY_SENTENCE[summary.provider];
}

/** The entries that could not be loaded, or `null` when every entry loaded. */
export function providerCarryoverAttention(
  summary: ProviderCarryoverSummary,
): string | null {
  if (summary.attention.length === 0) return null;
  return `Couldn't load ${summary.attention.join(', ')}.`;
}
