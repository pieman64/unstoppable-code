// Sort order for the Automations Triggered list table.
//
// The sort is a sticky, renderer-only presentation preference, so it lives in
// `localStorage` next to the List/Calendar view toggles (see
// `calendar/calendarPreferences.ts`) rather than in `preferences.json`. No
// stored value means "unsorted", which keeps the order the store returns.

import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import type { DataTableSortDirection as SortDirection } from '@canopy/ui-shared/components';

export type TriggeredSortColumn =
  | 'name'
  | 'nextTrigger'
  | 'lastResult'
  | 'status';

export interface TriggeredSortState {
  column: TriggeredSortColumn;
  direction: SortDirection;
}

/** A table row: the activity plus the next run time its cell displays. */
export interface TriggeredActivityRow {
  activity: ScheduledActivity;
  nextRun: Date | null;
}

const TRIGGERED_SORT_KEY = 'canopy.automations.triggeredSort';

const SORT_COLUMNS: readonly TriggeredSortColumn[] = [
  'name',
  'nextTrigger',
  'lastResult',
  'status',
];
const SORT_DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];

const collator = new Intl.Collator(undefined, {
  sensitivity: 'base',
  numeric: true,
});

/**
 * The persistent status a row shows. The transient "Running" badge is layered
 * on top by the status dropdown and is deliberately not part of this label, so
 * a row does not jump while it runs under a Status sort.
 */
export function triggeredActivityStatusLabel(
  activity: ScheduledActivity,
): string {
  if (activity.sharedPipelineReview) return 'Review needed';
  if (activity.lastResult?.status === 'failure' && !activity.enabled)
    return 'Failed';
  if (activity.enabled) return 'Enabled';
  return 'Disabled';
}

/** Header click cycle: unsorted → ascending → descending → unsorted. */
export function cycleTriggeredSort(
  current: TriggeredSortState | null,
  column: TriggeredSortColumn,
): TriggeredSortState | null {
  if (current === null || current.column !== column) {
    return { column, direction: 'asc' };
  }
  if (current.direction === 'asc') {
    return { column, direction: 'desc' };
  }
  return null;
}

type SortKey = string | number | null;

function sortKey(
  row: TriggeredActivityRow,
  column: TriggeredSortColumn,
): SortKey {
  switch (column) {
    case 'name':
      return row.activity.name;
    case 'nextTrigger':
      return row.nextRun?.getTime() ?? null;
    case 'lastResult': {
      const completedAt = row.activity.lastResult?.completedAt;
      if (completedAt === undefined) return null;
      const time = Date.parse(completedAt);
      return Number.isNaN(time) ? null : time;
    }
    case 'status':
      return triggeredActivityStatusLabel(row.activity);
  }
}

function compareKeys(a: SortKey, b: SortKey, direction: SortDirection): number {
  // Rows with nothing to show ("—") stay last whichever way the column runs.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const order =
    typeof a === 'number' && typeof b === 'number'
      ? a - b
      : collator.compare(String(a), String(b));
  return direction === 'asc' ? order : -order;
}

/**
 * Returns `rows` itself when unsorted, otherwise a sorted copy. Ties keep
 * their input order (`Array.prototype.sort` is stable), so the default order
 * is the tiebreaker.
 */
export function sortTriggeredActivityRows(
  rows: TriggeredActivityRow[],
  sort: TriggeredSortState | null,
): TriggeredActivityRow[] {
  if (sort === null) {
    return rows;
  }
  const { column, direction } = sort;
  return [...rows].sort((a, b) =>
    compareKeys(sortKey(a, column), sortKey(b, column), direction),
  );
}

/** Last-used sort; `null` (unsorted) when absent, corrupt, or unrecognized. */
export function loadTriggeredSort(): TriggeredSortState | null {
  try {
    const raw = localStorage.getItem(TRIGGERED_SORT_KEY);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('column' in parsed) ||
      !('direction' in parsed)
    ) {
      return null;
    }
    const column = SORT_COLUMNS.find((value) => value === parsed.column);
    const direction = SORT_DIRECTIONS.find(
      (value) => value === parsed.direction,
    );
    if (column === undefined || direction === undefined) {
      return null;
    }
    return { column, direction };
  } catch {
    // ignore corrupt / unavailable storage
    return null;
  }
}

export function saveTriggeredSort(sort: TriggeredSortState | null): void {
  try {
    if (sort === null) {
      localStorage.removeItem(TRIGGERED_SORT_KEY);
      return;
    }
    localStorage.setItem(
      TRIGGERED_SORT_KEY,
      JSON.stringify({ column: sort.column, direction: sort.direction }),
    );
  } catch {
    // ignore quota errors
  }
}
