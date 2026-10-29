import type { ProviderCarryoverSummary } from '@canopy/desktop-shared/types';

/**
 * The confirmation under a connected provider: what the user's own setup
 * carries over, and where it is ready (CAN-3701). Counts only; the
 * Marketplace lists the items. Zero counts fall back to what will carry over,
 * so the line points at the action rather than at an absence.
 */

function count(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function joinCounts(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

const NOTHING_YET: Record<ProviderCarryoverSummary['provider'], string> = {
  claude:
    'Skills, commands, and plugins you add to Claude Code are ready in your Claude chats.',
  codex: 'Skills and plugins you add to Codex are ready in your Codex chats.',
  cursor:
    'Skills and commands in the folders your Cursor chats read are ready in your Cursor chats.',
};

export function providerCarryoverLine(
  summary: ProviderCarryoverSummary,
): string {
  const parts: string[] = [];
  if (summary.skills > 0) parts.push(count(summary.skills, 'skill', 'skills'));
  if (summary.commands > 0)
    parts.push(count(summary.commands, 'command', 'commands'));
  if (summary.plugins > 0)
    parts.push(count(summary.plugins, 'plugin', 'plugins'));
  if (parts.length === 0) return NOTHING_YET[summary.provider];
  // Claude and Codex rows already name their source; Cursor's line must, since
  // its chats also read other agents' folders.
  if (summary.provider === 'cursor')
    return `From the folders your Cursor chats read: ${joinCounts(parts)}, ready in your Cursor chats.`;
  return `${joinCounts(parts)} ready`;
}

/** The entries that could not be loaded, or `null` when every entry loaded. */
export function providerCarryoverAttention(
  summary: ProviderCarryoverSummary,
): string | null {
  if (summary.attention.length === 0) return null;
  return `Couldn't load ${summary.attention.join(', ')}.`;
}
