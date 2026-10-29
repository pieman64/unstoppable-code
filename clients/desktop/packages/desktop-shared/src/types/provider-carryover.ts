/**
 * What carried over when the user connected a provider (CAN-3701, CAN-1063):
 * the skills, commands, and plugins a chat on that provider reads from the
 * user's own setup without an import step, plus the entries that could not
 * be loaded. Counts only; the Marketplace lists the items.
 */
export type ProviderCarryoverProvider = 'claude' | 'codex' | 'cursor';

export interface ProviderCarryoverSummary {
  provider: ProviderCarryoverProvider;
  skills: number;
  commands: number;
  plugins: number;
  /** Home entries found but not usable, as `~/.claude/skills/<name>` labels. */
  attention: string[];
}

export function isProviderCarryoverProvider(
  value: unknown,
): value is ProviderCarryoverProvider {
  return value === 'claude' || value === 'codex' || value === 'cursor';
}
