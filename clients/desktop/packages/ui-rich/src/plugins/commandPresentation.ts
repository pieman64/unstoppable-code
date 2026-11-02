import type { SlashCommandOption } from '../types';

/**
 * Shared presentation policy for typed slash searches: a capped first view
 * plus one Show all control. Empty-query browsing bypasses this policy. The
 * mobile app ports it to Dart and checks both against shared JSON vectors.
 */

/** Command rows shown before Show all for a typed search. */
export const SLASH_RESULT_LIMIT = 8;
/** Command rows shown per presentation group before Show all. */
export const SLASH_GROUP_LIMIT = 5;

export interface SlashResultLimits {
  total?: number;
  perGroup?: number;
}

export interface LimitedSlashResults<T> {
  /** Admitted rows, in their original ranked order. */
  visible: T[];
  /** Eligible rows not shown; render Show all only when this is positive. */
  hiddenCount: number;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

/**
 * Walks ranked rows once, admitting at most `total` rows and at most
 * `perGroup` rows per group key, counted across repeated runs of a group.
 * Later groups fill slots skipped by a full group.
 */
export function limitSlashResults<T>(
  rows: readonly T[],
  groupKey: (row: T) => string,
  limits: SlashResultLimits = {},
): LimitedSlashResults<T> {
  const total = positiveLimit(limits.total, SLASH_RESULT_LIMIT);
  const perGroup = positiveLimit(limits.perGroup, SLASH_GROUP_LIMIT);
  const counts = new Map<string, number>();
  const visible: T[] = [];
  for (const row of rows) {
    if (visible.length >= total) break;
    const key = groupKey(row);
    const count = counts.get(key) ?? 0;
    if (count >= perGroup) continue;
    counts.set(key, count + 1);
    visible.push(row);
  }
  return { visible, hiddenCount: rows.length - visible.length };
}

export {
  groupContiguousRuns,
  type GroupRun as SlashGroupRun,
} from '@canopy/ui-shared/lib/group-runs';

/**
 * Group key the rich-editor menu renders and caps by: Available rows form
 * their own group, other rows group by their `menuGroup` label.
 */
export function slashCommandGroupKey(command: SlashCommandOption): string {
  return command.section === 'available'
    ? 'available'
    : `group:${command.menuGroup ?? ''}`;
}
