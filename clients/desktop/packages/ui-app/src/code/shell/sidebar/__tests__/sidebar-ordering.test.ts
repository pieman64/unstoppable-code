import {
  canDragSidebarRow,
  DEFAULT_SIDEBAR_SORT_MODE,
  orderSidebarRows,
  orderWorkEntryRows,
  resolveSidebarSortMode,
  toRecencyMs,
  workEntryRecencyMs,
  type SidebarSortMode,
  type SidebarWorkEntryOrderRow,
} from '../sidebar-ordering';

interface Row {
  id: string;
  pinned?: boolean;
  at?: number;
}

function order(rows: Row[], mode: SidebarSortMode | undefined): string[] {
  return orderSidebarRows(rows, {
    mode,
    isPinned: (row) => row.pinned === true,
    recencyMs: (row) => row.at,
  }).map((row) => row.id);
}

describe('resolveSidebarSortMode', () => {
  it('defaults to manual and only honors an explicit last-updated', () => {
    expect(DEFAULT_SIDEBAR_SORT_MODE).toBe('manual');
    expect(resolveSidebarSortMode(undefined)).toBe('manual');
    expect(resolveSidebarSortMode('manual')).toBe('manual');
    expect(resolveSidebarSortMode('last-updated')).toBe('last-updated');
  });
});

describe('toRecencyMs', () => {
  it('parses ISO timestamps and rejects missing or unusable ones', () => {
    expect(toRecencyMs('2026-01-01T00:00:00.000Z')).toBe(
      Date.parse('2026-01-01T00:00:00.000Z'),
    );
    expect(toRecencyMs(undefined)).toBeUndefined();
    expect(toRecencyMs('')).toBeUndefined();
    expect(toRecencyMs('not a date')).toBeUndefined();
  });
});

describe('orderSidebarRows', () => {
  it('keeps the incoming manual order when no mode is set', () => {
    expect(
      order(
        [
          { id: 'a', at: 1 },
          { id: 'b', at: 3 },
          { id: 'c', at: 2 },
        ],
        undefined,
      ),
    ).toEqual(['a', 'b', 'c']);
  });

  it('sorts the unpinned tail most-recent-first in last-updated mode', () => {
    expect(
      order(
        [
          { id: 'a', at: 1 },
          { id: 'b', at: 3 },
          { id: 'c', at: 2 },
        ],
        'last-updated',
      ),
    ).toEqual(['b', 'c', 'a']);
  });

  it('keeps pinned rows first and in their manual order', () => {
    expect(
      order(
        [
          { id: 'a', at: 5 },
          { id: 'p2', pinned: true, at: 1 },
          { id: 'b', at: 9 },
          { id: 'p1', pinned: true, at: 7 },
        ],
        'last-updated',
      ),
    ).toEqual(['p2', 'p1', 'b', 'a']);
  });

  it('keeps the manual order in manual mode', () => {
    expect(
      order(
        [
          { id: 'a', at: 1 },
          { id: 'b', at: 3 },
          { id: 'p', pinned: true },
        ],
        'manual',
      ),
    ).toEqual(['p', 'a', 'b']);
  });

  it('leaves rows without a timestamp in their manual slot', () => {
    expect(
      order(
        [{ id: 'a', at: 1 }, { id: 'unknown' }, { id: 'b', at: 3 }],
        'last-updated',
      ),
    ).toEqual(['b', 'unknown', 'a']);
  });

  it('is stable for equal timestamps', () => {
    expect(
      order(
        [
          { id: 'a', at: 2 },
          { id: 'b', at: 2 },
          { id: 'c', at: 2 },
        ],
        'last-updated',
      ),
    ).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate its input', () => {
    const rows: Row[] = [
      { id: 'a', at: 1 },
      { id: 'b', at: 2 },
    ];
    order(rows, 'last-updated');
    expect(rows.map((row) => row.id)).toEqual(['a', 'b']);
  });
});

describe('canDragSidebarRow', () => {
  it('always drags pinned rows and drags the tail only in manual mode', () => {
    expect(canDragSidebarRow(undefined, true)).toBe(true);
    expect(canDragSidebarRow('last-updated', true)).toBe(true);
    expect(canDragSidebarRow('last-updated', false)).toBe(false);
    expect(canDragSidebarRow(undefined, false)).toBe(true);
    expect(canDragSidebarRow('manual', false)).toBe(true);
  });
});

describe('workEntryRecencyMs', () => {
  it('takes the newest of message, touch, and creation times', () => {
    expect(
      workEntryRecencyMs({
        createdAt: '2026-01-01T00:00:00.000Z',
        lastTouchedAt: '2026-01-03T00:00:00.000Z',
        lastMessageAt: '2026-01-02T00:00:00.000Z',
      }),
    ).toBe(Date.parse('2026-01-03T00:00:00.000Z'));
  });

  it('falls back to creation time and to undefined', () => {
    expect(workEntryRecencyMs({ createdAt: '2026-01-01T00:00:00.000Z' })).toBe(
      Date.parse('2026-01-01T00:00:00.000Z'),
    );
    expect(workEntryRecencyMs({})).toBeUndefined();
    expect(workEntryRecencyMs({ lastMessageAt: 'garbage' })).toBeUndefined();
  });
});

describe('orderWorkEntryRows', () => {
  interface Entry extends SidebarWorkEntryOrderRow {
    id: string;
    createdAt: string;
  }

  const entries: Entry[] = [
    { id: 'old', createdAt: '2026-01-01T00:00:00.000Z' },
    {
      id: 'pinned',
      pinned: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'recent',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastMessageAt: '2026-02-01T00:00:00.000Z',
    },
  ];

  it('orders any structural row type and preserves its element type', () => {
    const ordered: Entry[] = orderWorkEntryRows(entries, 'last-updated');
    expect(ordered.map((entry) => entry.id)).toEqual([
      'pinned',
      'recent',
      'old',
    ]);
  });

  it('keeps manual order for the unpinned tail in manual mode', () => {
    expect(
      orderWorkEntryRows(entries, 'manual').map((entry) => entry.id),
    ).toEqual(['pinned', 'old', 'recent']);
  });
});
