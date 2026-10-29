import type {
  CoworkWorkEntryMeta,
  SidebarItem,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  orderSidebarRows,
  orderSidebarWorkspaces,
  orderWorkEntryRows,
  orderWorktreeRows,
  workspaceRecencyMs,
} from '../sidebar-ordering';

interface Row {
  id: string;
  pinned?: boolean;
  at?: number;
}

function order(rows: Row[], mode: 'last-updated' | 'manual'): string[] {
  return orderSidebarRows(rows, {
    mode,
    isPinned: (row) => row.pinned === true,
    recencyMs: (row) => row.at,
  }).map((row) => row.id);
}

describe('orderSidebarRows', () => {
  it('leaves rows with unknown recency in their manual slot', () => {
    // 'x' has no timestamp: it stays at index 1 while the timestamped rows
    // redistribute into the remaining slots newest-first.
    expect(
      order(
        [
          { id: 'a', at: 1 },
          { id: 'x' },
          { id: 'b', at: 3 },
          { id: 'c', at: 2 },
        ],
        'last-updated',
      ),
    ).toEqual(['b', 'x', 'c', 'a']);
  });
});

function worktree(
  partial: Partial<WorktreeData> & { id: string },
): WorktreeData {
  return {
    branchName: partial.id,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('orderWorktreeRows', () => {
  it('ranks by lastTouchedAt, falling back to createdAt', () => {
    const rows = orderWorktreeRows(
      [
        worktree({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
        worktree({
          id: 'touched',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastTouchedAt: '2026-03-01T00:00:00.000Z',
        }),
        worktree({ id: 'newer', createdAt: '2026-02-01T00:00:00.000Z' }),
      ],
      'last-updated',
    );
    expect(rows.map((row) => row.id)).toEqual(['touched', 'newer', 'old']);
  });

  it('floats pinned worktrees above the tail', () => {
    const rows = orderWorktreeRows(
      [
        worktree({ id: 'newest', lastTouchedAt: '2026-05-01T00:00:00.000Z' }),
        worktree({
          id: 'pin',
          pinned: true,
          createdAt: '2020-01-01T00:00:00.000Z',
        }),
      ],
      'last-updated',
    );
    expect(rows.map((row) => row.id)).toEqual(['pin', 'newest']);
  });
});

function entry(
  partial: Partial<CoworkWorkEntryMeta> & { id: string },
): CoworkWorkEntryMeta {
  return {
    title: partial.id,
    createdAt: '2026-01-01T00:00:00.000Z',
    chatCount: 0,
    ...partial,
  };
}

describe('orderWorkEntryRows', () => {
  it('ranks by lastMessageAt first', () => {
    const rows = orderWorkEntryRows(
      [
        entry({ id: 'quiet', createdAt: '2026-04-01T00:00:00.000Z' }),
        entry({
          id: 'chatty',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-06-01T00:00:00.000Z',
        }),
      ],
      'last-updated',
    );
    expect(rows.map((row) => row.id)).toEqual(['chatty', 'quiet']);
  });

  it('uses a newer durable touch instead of an older message', () => {
    const rows = orderWorkEntryRows(
      [
        entry({
          id: 'recently-touched',
          lastMessageAt: '2026-02-01T00:00:00.000Z',
          lastTouchedAt: '2026-07-01T00:00:00.000Z',
        }),
        entry({
          id: 'newer-message',
          lastMessageAt: '2026-06-01T00:00:00.000Z',
        }),
      ],
      'last-updated',
    );
    expect(rows.map((row) => row.id)).toEqual([
      'recently-touched',
      'newer-message',
    ]);
  });

  it('keeps pinned entries on top', () => {
    const rows = orderWorkEntryRows(
      [
        entry({ id: 'chatty', lastMessageAt: '2026-06-01T00:00:00.000Z' }),
        entry({ id: 'pin', pinned: true }),
      ],
      'last-updated',
    );
    expect(rows.map((row) => row.id)).toEqual(['pin', 'chatty']);
  });
});

function codeWorkspace(
  id: string,
  worktrees: WorktreeData[],
  pinned?: boolean,
): SidebarItem {
  return {
    type: 'single-repo',
    id,
    name: id,
    repoPath: `/repos/${id}`,
    color: '#fff',
    collapsed: false,
    order: 0,
    worktrees,
    ...(pinned ? { pinned: true } : {}),
  };
}

function coworkWorkspace(id: string, lastActivityAt?: string): SidebarItem {
  return {
    type: 'cowork',
    id,
    name: id,
    color: '#fff',
    collapsed: false,
    order: 0,
    ...(lastActivityAt ? { lastActivityAt } : {}),
  };
}

describe('workspaceRecencyMs', () => {
  it('uses the newest worktree watermark for a code workspace', () => {
    expect(
      workspaceRecencyMs(
        codeWorkspace('ws', [
          worktree({ id: 'a', lastTouchedAt: '2026-01-01T00:00:00.000Z' }),
          worktree({ id: 'b', lastTouchedAt: '2026-09-01T00:00:00.000Z' }),
        ]),
      ),
    ).toBe(Date.parse('2026-09-01T00:00:00.000Z'));
  });

  it('has no intrinsic recency for a cowork workspace', () => {
    expect(workspaceRecencyMs(coworkWorkspace('cw'))).toBeUndefined();
  });

  it('uses the persisted workspace activity for an unloaded cowork workspace', () => {
    expect(
      workspaceRecencyMs(coworkWorkspace('cw', '2026-09-15T00:00:00.000Z')),
    ).toBe(Date.parse('2026-09-15T00:00:00.000Z'));
  });

  it('honors a caller-supplied override', () => {
    expect(
      workspaceRecencyMs(coworkWorkspace('cw'), new Map([['cw', 42]])),
    ).toBe(42);
  });

  it('keeps the fresher of persisted and live cowork activity', () => {
    expect(
      workspaceRecencyMs(
        coworkWorkspace('cw', '2026-09-15T00:00:00.000Z'),
        new Map([['cw', Date.parse('2026-09-10T00:00:00.000Z')]]),
      ),
    ).toBe(Date.parse('2026-09-15T00:00:00.000Z'));
  });
});

describe('orderSidebarWorkspaces', () => {
  it('sorts unloaded cowork workspaces by persisted activity', () => {
    const items = orderSidebarWorkspaces(
      [
        coworkWorkspace('stale-cowork', '2026-01-01T00:00:00.000Z'),
        coworkWorkspace('fresh-cowork', '2026-09-01T00:00:00.000Z'),
      ],
      'last-updated',
    );
    expect(items.map((item) => item.id)).toEqual([
      'fresh-cowork',
      'stale-cowork',
    ]);
  });

  it('sorts code workspaces by their newest worktree', () => {
    const items = orderSidebarWorkspaces(
      [
        codeWorkspace('stale', [
          worktree({ id: 'a', lastTouchedAt: '2026-01-01T00:00:00.000Z' }),
        ]),
        codeWorkspace('fresh', [
          worktree({ id: 'b', lastTouchedAt: '2026-09-01T00:00:00.000Z' }),
        ]),
      ],
      'last-updated',
    );
    expect(items.map((item) => item.id)).toEqual(['fresh', 'stale']);
  });

  it('keeps a cowork workspace in place instead of sinking it', () => {
    const items = orderSidebarWorkspaces(
      [
        codeWorkspace('stale', [
          worktree({ id: 'a', lastTouchedAt: '2026-01-01T00:00:00.000Z' }),
        ]),
        coworkWorkspace('cw'),
        codeWorkspace('fresh', [
          worktree({ id: 'b', lastTouchedAt: '2026-09-01T00:00:00.000Z' }),
        ]),
      ],
      'last-updated',
    );
    expect(items.map((item) => item.id)).toEqual(['fresh', 'cw', 'stale']);
  });

  it('floats a pinned workspace to the top of the list', () => {
    const items = orderSidebarWorkspaces(
      [
        codeWorkspace('fresh', [
          worktree({ id: 'b', lastTouchedAt: '2026-09-01T00:00:00.000Z' }),
        ]),
        codeWorkspace(
          'pinned',
          [worktree({ id: 'a', lastTouchedAt: '2020-01-01T00:00:00.000Z' })],
          true,
        ),
      ],
      'last-updated',
    );
    expect(items.map((item) => item.id)).toEqual(['pinned', 'fresh']);
  });
});
