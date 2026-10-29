import {
  feedItemMatchesClientFilters,
  mergeLiveFeedItem,
} from '../merge-live-feed-item';
import type {
  PrOpenedFeedItem,
  WorktreeUpdatedFeedItem,
} from '@canopy/protocol';
import type { TeamFeedFilters } from '../team-api';

function item(
  id: string,
  overrides?: {
    userId?: string;
    summary?: string | null;
    occurredAt?: string;
  },
): WorktreeUpdatedFeedItem {
  return {
    id,
    type: 'worktree_updated',
    occurredAt: overrides?.occurredAt ?? '2026-01-01T00:00:00.000Z',
    actor: { userId: overrides?.userId ?? 'user-1', displayName: 'Ada' },
    worktreeId: 'wt-1',
    branchName: 'feature/x',
    summary: overrides?.summary ?? null,
  };
}

function prItem(id: string): PrOpenedFeedItem {
  return {
    id,
    type: 'pr_opened',
    occurredAt: '2026-01-01T00:00:00.000Z',
    actor: { userId: 'user-1', displayName: 'Ada' },
    worktreeId: 'wt-1',
    repoName: 'demo',
    prNumber: 1,
    prUrl: 'https://example.test/pr/1',
    title: 'Add feature',
    branchName: 'feature/x',
    checkStatus: 'passing',
    reviewStatus: 'pending',
    hasConflicts: false,
    commentCount: 0,
    summary: null,
  };
}

describe('feedItemMatchesClientFilters', () => {
  it('matches when no client filters are set', () => {
    expect(feedItemMatchesClientFilters(item('a'), {})).toBe(true);
  });

  it('matches an empty types array (all types)', () => {
    const filters: TeamFeedFilters = { types: [] };
    expect(feedItemMatchesClientFilters(item('a'), filters)).toBe(true);
  });

  it('respects the type filter', () => {
    const filters: TeamFeedFilters = { types: ['pr_opened'] };
    expect(feedItemMatchesClientFilters(prItem('a'), filters)).toBe(true);
    expect(feedItemMatchesClientFilters(item('b'), filters)).toBe(false);
  });

  it('respects the actor (member) filter', () => {
    const filters: TeamFeedFilters = { actorId: 'user-2' };
    expect(
      feedItemMatchesClientFilters(item('a', { userId: 'user-2' }), filters),
    ).toBe(true);
    expect(
      feedItemMatchesClientFilters(item('b', { userId: 'user-1' }), filters),
    ).toBe(false);
  });

  it('does not evaluate the search query (server-only)', () => {
    // `q` is intentionally ignored here; the consumer buffers when a search is
    // active rather than calling the merge path.
    const filters: TeamFeedFilters = { q: 'anything' };
    expect(feedItemMatchesClientFilters(item('a'), filters)).toBe(true);
  });
});

describe('mergeLiveFeedItem', () => {
  it('inserts a newer item ahead of older ones by occurredAt', () => {
    const existing = [
      item('a', { occurredAt: '2026-01-02T00:00:00.000Z' }),
      item('b', { occurredAt: '2026-01-01T00:00:00.000Z' }),
    ];
    const merged = mergeLiveFeedItem(
      existing,
      item('c', { occurredAt: '2026-01-03T00:00:00.000Z' }),
      {},
    );
    expect(merged.map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('dedupes by id, replacing an existing entry with fresh content', () => {
    // Same occurredAt for both copies: the update keeps its chronological slot
    // and only its content changes — it is not pinned to the top.
    const existing = [
      item('a', { occurredAt: '2026-01-02T00:00:00.000Z' }),
      item('b', { occurredAt: '2026-01-01T00:00:00.000Z', summary: 'old' }),
    ];
    const updated = item('b', {
      occurredAt: '2026-01-01T00:00:00.000Z',
      summary: 'new',
    });
    const merged = mergeLiveFeedItem(existing, updated, {});
    expect(merged.map((i) => i.id)).toEqual(['a', 'b']);
    expect(merged[1]).toBe(updated);
    expect(
      merged[1].type === 'worktree_updated' ? merged[1].summary : null,
    ).toBe('new');
  });

  it('drops items that fail the client filters (list unchanged)', () => {
    const existing = [item('a')];
    const filtered = mergeLiveFeedItem(existing, prItem('c'), {
      types: ['worktree_updated'],
    });
    expect(filtered).toBe(existing);
  });

  it('does not mutate the input array', () => {
    const existing = [item('a'), item('b')];
    const snapshot = existing.map((i) => i.id);
    mergeLiveFeedItem(existing, item('c'), {});
    expect(existing.map((i) => i.id)).toEqual(snapshot);
  });

  it('inserts an out-of-order (stale) live item below newer items', () => {
    // The list loaded newest-first from the server. An SSE frame arrives
    // carrying an older instant than items already on screen — it must drop
    // into its chronological slot, not jump to the top (CAN-389 regression).
    const existing = [
      item('newest', { occurredAt: '2026-01-03T00:00:00.000Z' }),
      item('middle', { occurredAt: '2026-01-02T00:00:00.000Z' }),
      item('oldest', { occurredAt: '2026-01-01T00:00:00.000Z' }),
    ];
    const stale = item('stale', { occurredAt: '2026-01-01T12:00:00.000Z' });
    const merged = mergeLiveFeedItem(existing, stale, {});
    expect(merged.map((i) => i.id)).toEqual([
      'newest',
      'middle',
      'stale',
      'oldest',
    ]);
  });

  it('prepends a genuinely newer live item', () => {
    const existing = [
      item('a', { occurredAt: '2026-01-02T00:00:00.000Z' }),
      item('b', { occurredAt: '2026-01-01T00:00:00.000Z' }),
    ];
    const fresh = item('c', { occurredAt: '2026-01-03T00:00:00.000Z' });
    const merged = mergeLiveFeedItem(existing, fresh, {});
    expect(merged.map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('appends a live item older than everything on screen', () => {
    const existing = [
      item('a', { occurredAt: '2026-01-03T00:00:00.000Z' }),
      item('b', { occurredAt: '2026-01-02T00:00:00.000Z' }),
    ];
    const ancient = item('c', { occurredAt: '2026-01-01T00:00:00.000Z' });
    const merged = mergeLiveFeedItem(existing, ancient, {});
    expect(merged.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('re-positions an updated item by its new occurredAt', () => {
    // An in-place update (same id) whose fresh occurredAt moved it earlier in
    // time should settle into the matching slot, not pin to the top.
    const existing = [
      item('a', { occurredAt: '2026-01-03T00:00:00.000Z' }),
      item('b', { occurredAt: '2026-01-02T00:00:00.000Z', summary: 'old' }),
      item('c', { occurredAt: '2026-01-01T00:00:00.000Z' }),
    ];
    const updated = item('b', {
      occurredAt: '2026-01-01T06:00:00.000Z',
      summary: 'new',
    });
    const merged = mergeLiveFeedItem(existing, updated, {});
    expect(merged.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    const moved = merged[1];
    expect(moved.type === 'worktree_updated' ? moved.summary : null).toBe(
      'new',
    );
  });
});
