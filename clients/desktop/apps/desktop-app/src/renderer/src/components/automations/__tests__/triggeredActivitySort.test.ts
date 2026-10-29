/**
 * @jest-environment jsdom
 */
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import {
  cycleTriggeredSort,
  loadTriggeredSort,
  saveTriggeredSort,
  sortTriggeredActivityRows,
  triggeredActivityStatusLabel,
  type TriggeredActivityRow,
  type TriggeredSortState,
} from '../triggeredActivitySort';

const STORAGE_KEY = 'canopy.automations.triggeredSort';

function activity(
  overrides: Partial<ScheduledActivity> = {},
): ScheduledActivity {
  return {
    version: 1,
    id: 'activity-1',
    name: 'Morning review',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt: 'Summarize the plan.' },
    createdAt: '2026-05-27T00:00:00.000Z',
    updatedAt: '2026-05-27T00:00:00.000Z',
    failureCount: 0,
    ...overrides,
  };
}

function row(
  overrides: Partial<ScheduledActivity>,
  nextRun: Date | null = null,
): TriggeredActivityRow {
  return { activity: activity(overrides), nextRun };
}

function ids(rows: readonly TriggeredActivityRow[]): string[] {
  return rows.map((entry) => entry.activity.id);
}

function sorted(
  rows: TriggeredActivityRow[],
  sort: TriggeredSortState | null,
): string[] {
  return ids(sortTriggeredActivityRows(rows, sort));
}

describe('cycleTriggeredSort', () => {
  it('cycles unsorted → ascending → descending → unsorted on one column', () => {
    const asc = cycleTriggeredSort(null, 'name');
    expect(asc).toEqual({ column: 'name', direction: 'asc' });
    const desc = cycleTriggeredSort(asc, 'name');
    expect(desc).toEqual({ column: 'name', direction: 'desc' });
    expect(cycleTriggeredSort(desc, 'name')).toBeNull();
  });

  it('restarts at ascending when a different column is clicked', () => {
    expect(
      cycleTriggeredSort({ column: 'name', direction: 'asc' }, 'status'),
    ).toEqual({ column: 'status', direction: 'asc' });
    expect(
      cycleTriggeredSort({ column: 'name', direction: 'desc' }, 'lastResult'),
    ).toEqual({ column: 'lastResult', direction: 'asc' });
  });
});

describe('triggeredActivityStatusLabel', () => {
  it('labels enabled, disabled, and failed-and-disabled activities', () => {
    expect(triggeredActivityStatusLabel(activity({ enabled: true }))).toBe(
      'Enabled',
    );
    expect(triggeredActivityStatusLabel(activity({ enabled: false }))).toBe(
      'Disabled',
    );
    expect(
      triggeredActivityStatusLabel(
        activity({
          enabled: false,
          lastResult: {
            status: 'failure',
            completedAt: '2026-05-27T00:00:00.000Z',
          },
        }),
      ),
    ).toBe('Failed');
    // A failed run on a still-enabled activity keeps reading as Enabled.
    expect(
      triggeredActivityStatusLabel(
        activity({
          enabled: true,
          lastResult: {
            status: 'failure',
            completedAt: '2026-05-27T00:00:00.000Z',
          },
        }),
      ),
    ).toBe('Enabled');
  });

  it('uses the review-needed badge label for the Status sort', () => {
    const review = activity({
      enabled: false,
      sharedPipelineReview: {
        detectedAt: '2026-09-26T12:00:00.000Z',
        remoteId: 'remote-1',
      },
    });
    expect(triggeredActivityStatusLabel(review)).toBe('Review needed');
    expect(
      sorted(
        [
          row({ ...review, id: 'review' }),
          row({ id: 'disabled', enabled: false }),
        ],
        { column: 'status', direction: 'asc' },
      ),
    ).toEqual(['disabled', 'review']);
  });
});

describe('sortTriggeredActivityRows', () => {
  it('returns the same array reference when there is no sort', () => {
    const rows = [row({ id: 'b', name: 'Bravo' }), row({ id: 'a', name: 'A' })];
    expect(sortTriggeredActivityRows(rows, null)).toBe(rows);
  });

  it('returns a new array and leaves the input order unchanged', () => {
    const rows = [
      row({ id: 'b', name: 'Bravo' }),
      row({ id: 'a', name: 'alpha' }),
    ];
    const result = sortTriggeredActivityRows(rows, {
      column: 'name',
      direction: 'asc',
    });
    expect(result).not.toBe(rows);
    expect(ids(result)).toEqual(['a', 'b']);
    expect(ids(rows)).toEqual(['b', 'a']);
  });

  it('sorts names case-insensitively and numerically', () => {
    const rows = [
      row({ id: 'item-10', name: 'item 10' }),
      row({ id: 'bravo', name: 'Bravo' }),
      row({ id: 'item-2', name: 'item 2' }),
      row({ id: 'alpha', name: 'alpha' }),
    ];
    expect(sorted(rows, { column: 'name', direction: 'asc' })).toEqual([
      'alpha',
      'bravo',
      'item-2',
      'item-10',
    ]);
    expect(sorted(rows, { column: 'name', direction: 'desc' })).toEqual([
      'item-10',
      'item-2',
      'bravo',
      'alpha',
    ]);
  });

  it('sorts by next trigger time with empty rows last in both directions', () => {
    const rows = [
      row({ id: 'late' }, new Date('2099-06-01T15:00:00.000Z')),
      row({ id: 'none' }, null),
      row({ id: 'early' }, new Date('2098-06-01T15:00:00.000Z')),
    ];
    expect(sorted(rows, { column: 'nextTrigger', direction: 'asc' })).toEqual([
      'early',
      'late',
      'none',
    ]);
    expect(sorted(rows, { column: 'nextTrigger', direction: 'desc' })).toEqual([
      'late',
      'early',
      'none',
    ]);
  });

  it('sorts by last result completion time, treating missing and unparseable times as empty', () => {
    const rows = [
      row({
        id: 'unparseable',
        lastResult: { status: 'success', completedAt: 'not-a-date' },
      }),
      row({
        id: 'newer',
        lastResult: {
          status: 'failure',
          completedAt: '2026-09-02T00:00:00.000Z',
        },
      }),
      row({ id: 'never' }),
      row({
        id: 'older',
        lastResult: {
          status: 'success',
          completedAt: '2026-09-01T00:00:00.000Z',
        },
      }),
    ];
    expect(sorted(rows, { column: 'lastResult', direction: 'asc' })).toEqual([
      'older',
      'newer',
      'unparseable',
      'never',
    ]);
    expect(sorted(rows, { column: 'lastResult', direction: 'desc' })).toEqual([
      'newer',
      'older',
      'unparseable',
      'never',
    ]);
  });

  it('sorts by status label: Disabled, Enabled, Failed', () => {
    const rows = [
      row({ id: 'enabled', enabled: true }),
      row({
        id: 'failed',
        enabled: false,
        lastResult: {
          status: 'failure',
          completedAt: '2026-09-01T00:00:00.000Z',
        },
      }),
      row({ id: 'disabled', enabled: false }),
    ];
    expect(sorted(rows, { column: 'status', direction: 'asc' })).toEqual([
      'disabled',
      'enabled',
      'failed',
    ]);
    expect(sorted(rows, { column: 'status', direction: 'desc' })).toEqual([
      'failed',
      'enabled',
      'disabled',
    ]);
  });

  it('keeps the input order for ties in both directions', () => {
    const rows = [
      row({ id: 'first', name: 'Same' }),
      row({ id: 'second', name: 'same' }),
      row({ id: 'third', name: 'SAME' }),
    ];
    expect(sorted(rows, { column: 'name', direction: 'asc' })).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(sorted(rows, { column: 'name', direction: 'desc' })).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('keeps the input order when every key is empty', () => {
    const rows = [row({ id: 'b' }), row({ id: 'a' }), row({ id: 'c' })];
    expect(sorted(rows, { column: 'nextTrigger', direction: 'asc' })).toEqual([
      'b',
      'a',
      'c',
    ]);
    expect(sorted(rows, { column: 'nextTrigger', direction: 'desc' })).toEqual([
      'b',
      'a',
      'c',
    ]);
  });
});

describe('triggered sort persistence', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  it('loads null when nothing is stored', () => {
    expect(loadTriggeredSort()).toBeNull();
  });

  it('round-trips a saved sort', () => {
    saveTriggeredSort({ column: 'lastResult', direction: 'desc' });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(
      '{"column":"lastResult","direction":"desc"}',
    );
    expect(loadTriggeredSort()).toEqual({
      column: 'lastResult',
      direction: 'desc',
    });
  });

  it('removes the key when the sort is cleared', () => {
    saveTriggeredSort({ column: 'name', direction: 'asc' });
    saveTriggeredSort(null);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(loadTriggeredSort()).toBeNull();
  });

  it.each([
    ['corrupt JSON', '{not json'],
    ['an array', '["name","asc"]'],
    ['a string', '"name"'],
    ['null', 'null'],
    ['a missing direction', '{"column":"name"}'],
    ['a missing column', '{"direction":"asc"}'],
    ['an unknown column', '{"column":"trigger","direction":"asc"}'],
    ['an unknown direction', '{"column":"name","direction":"sideways"}'],
    ['non-string fields', '{"column":1,"direction":true}'],
  ])('loads null for %s', (_label, raw) => {
    localStorage.setItem(STORAGE_KEY, raw);
    expect(loadTriggeredSort()).toBeNull();
  });
});
