import type { SlashCommandOption } from '../types';

function scoreField(value: string | undefined, query: string): number {
  if (!value) return 0;
  const text = value.toLowerCase().replace(/^[$/]/, '');
  if (text === query) return 100;
  if (text.startsWith(query)) return 80;
  if (text.includes(query)) return 60;
  // Ordered subsequence matching, bounded by the field length. Short queries
  // stay literal so a single character does not match every description.
  if (query.length < 2) return 0;
  let offset = 0;
  for (const char of query) {
    const index = text.indexOf(char, offset);
    if (index < 0) return 0;
    offset = index + 1;
  }
  return 20 + query.length / Math.max(text.length, 1);
}

/** Stable ranking within the existing enablement groups. No catalog IO. */
export function searchSlashCommands<T extends SlashCommandOption>(
  commands: readonly T[],
  query: string,
): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...commands];
  return commands
    .map((command, index) => ({
      command,
      index,
      score: Math.max(
        scoreField(command.name, normalized),
        scoreField(command.displayName, normalized),
        scoreField(command.description, normalized) * 0.5,
        scoreField(command.category, normalized) * 0.6,
      ),
    }))
    .filter((row) => row.score > 0)
    .sort(
      (a, b) =>
        Number(a.command.section === 'available') -
          Number(b.command.section === 'available') ||
        b.score - a.score ||
        a.index - b.index,
    )
    .map((row) => row.command);
}
