import type { FileReference } from '@canopy/desktop-shared/types';
import {
  isPluginMentionReference,
  parsePluginMentionAbsolutePath,
} from '@canopy/desktop-shared/lib/plugin-mention';

export interface PluginMentionTarget {
  marketplaceId: string;
  pluginName: string;
  /** User-facing plugin name — the pill's display token in the sent text. */
  label: string;
}

/**
 * Per-message index of whole-plugin `@` mentions. Built from the message's
 * own `file_references` block (kind `plugin`), never from the global plugin
 * catalog: a bare plugin name such as `figma` is ordinary prose everywhere
 * except in a message where the user actually dropped the pill.
 */
export interface PluginMentionIndex {
  aliases: Map<string, PluginMentionTarget>;
  /** Longest-first matcher over every alias, bounded by non-word characters. */
  pattern: RegExp;
}

export type PluginMentionPiece =
  | { type: 'text'; text: string }
  | { type: 'plugin'; text: string; target: PluginMentionTarget };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildPluginMentionIndex(
  references: readonly FileReference[] | undefined,
): PluginMentionIndex | null {
  if (!references || references.length === 0) return null;
  const aliases = new Map<string, PluginMentionTarget>();
  for (const reference of references) {
    if (!isPluginMentionReference(reference)) continue;
    const ref = parsePluginMentionAbsolutePath(reference.absolutePath);
    const label = reference.displayPath.trim();
    if (!ref || !label || aliases.has(label)) continue;
    aliases.set(label, { ...ref, label });
  }
  if (aliases.size === 0) return null;
  const alternation = Array.from(aliases.keys())
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  return {
    aliases,
    pattern: new RegExp(`(?<![\\w-])(?:${alternation})(?![\\w-])`, 'g'),
  };
}

export function splitTextByPluginMentions(
  text: string,
  index: PluginMentionIndex | null | undefined,
): PluginMentionPiece[] {
  if (!index || index.aliases.size === 0 || text.length === 0) {
    return [{ type: 'text', text }];
  }
  const pieces: PluginMentionPiece[] = [];
  let cursor = 0;
  index.pattern.lastIndex = 0;
  for (
    let match = index.pattern.exec(text);
    match !== null;
    match = index.pattern.exec(text)
  ) {
    const target = index.aliases.get(match[0]);
    if (!target) continue;
    if (match.index > cursor) {
      pieces.push({ type: 'text', text: text.slice(cursor, match.index) });
    }
    pieces.push({ type: 'plugin', text: match[0], target });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    pieces.push({ type: 'text', text: text.slice(cursor) });
  }
  return pieces.length > 0 ? pieces : [{ type: 'text', text }];
}
