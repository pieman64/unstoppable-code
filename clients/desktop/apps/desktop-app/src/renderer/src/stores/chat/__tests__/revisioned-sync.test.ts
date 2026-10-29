// Frontend plan Phase 1/2 coverage: subscribe-before-query hydration,
// events during the snapshot request, duplicate/old delta rejection,
// revision-gap refresh retaining the last good projection, refresh-error
// lifecycle, and per-scope isolation.
import type {
  ChatStateChangedEvent,
  ChatStateSnapshot,
} from '@canopy/desktop-shared/types';
import {
  RevisionedChatSync,
  type ChatScopeSyncStatus,
} from '../revisioned-sync';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function snapshot(
  projectId: string,
  worktreeId: string,
  revision: number,
): ChatStateSnapshot {
  return {
    schemaVersion: 1,
    projectId,
    worktreeId,
    revision,
    tabsFile: { version: 1, tabs: [], activeTabId: '' },
    archives: [],
    runtimeByChatId: {},
    queue: [],
  };
}

let eventCounter = 0;

function event(
  projectId: string,
  worktreeId: string,
  baseRevision: number,
  revision: number,
  eventId?: string,
): ChatStateChangedEvent {
  eventCounter += 1;
  return {
    schemaVersion: 1,
    eventId: eventId ?? `evt-${String(eventCounter)}`,
    occurredAt: '2026-08-07T00:00:00.000Z',
    projectId,
    worktreeId,
    baseRevision,
    revision,
    changes: [{ type: 'tab.removed', tabId: `tab-${String(revision)}` }],
  };
}

interface Harness {
  sync: RevisionedChatSync;
  installed: Array<{ revision: number; reason: 'hydrate' | 'refresh' }>;
  applied: ChatStateChangedEvent[];
  statuses: Array<ChatScopeSyncStatus | null>;
  pendingQueries: Array<Deferred<ChatStateSnapshot>>;
}

function createHarness(): Harness {
  const installed: Harness['installed'] = [];
  const applied: Harness['applied'] = [];
  const statuses: Harness['statuses'] = [];
  const pendingQueries: Harness['pendingQueries'] = [];
  const sync = new RevisionedChatSync(
    {
      getState: (): Promise<ChatStateSnapshot> => {
        const next = deferred<ChatStateSnapshot>();
        pendingQueries.push(next);
        return next.promise;
      },
    },
    {
      installSnapshot: (snap, context): void => {
        installed.push({
          revision: snap.revision,
          reason: context.reason,
        });
      },
      applyCommittedEvent: (evt): void => {
        applied.push(evt);
      },
      onStatusChanged: (_projectId, _worktreeId, status): void => {
        statuses.push(status);
      },
    },
  );
  return { sync, installed, applied, statuses, pendingQueries };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('RevisionedChatSync', () => {
  it('ignores events for a scope that was never hydrated', () => {
    const h = createHarness();
    h.sync.handleEvent(event('p', 'w', 0, 1));
    expect(h.applied).toHaveLength(0);
    expect(h.statuses).toHaveLength(0);
  });

  it('buffers events received during the snapshot request and applies only newer ones in order', async () => {
    const h = createHarness();
    const hydration = h.sync.hydrate('p', 'w');

    // Events arrive while the query is pending — including one the snapshot
    // already contains (revision 3) and two newer ones delivered out of order.
    h.sync.handleEvent(event('p', 'w', 3, 4));
    h.sync.handleEvent(event('p', 'w', 2, 3));
    h.sync.handleEvent(event('p', 'w', 4, 5));

    h.pendingQueries[0].resolve(snapshot('p', 'w', 3));
    await hydration;

    expect(h.installed).toEqual([{ revision: 3, reason: 'hydrate' }]);
    expect(h.applied.map((evt) => evt.revision)).toEqual([4, 5]);
    expect(h.sync.getStatus('p', 'w')).toEqual({ phase: 'live', revision: 5 });
  });

  it('rejects duplicate and older deltas in the live phase', async () => {
    const h = createHarness();
    const hydration = h.sync.hydrate('p', 'w');
    h.pendingQueries[0].resolve(snapshot('p', 'w', 5));
    await hydration;

    const stale = event('p', 'w', 4, 5, 'stale');
    h.sync.handleEvent(stale);
    h.sync.handleEvent(event('p', 'w', 3, 4, 'older'));
    const next = event('p', 'w', 5, 6, 'next');
    h.sync.handleEvent(next);
    h.sync.handleEvent(event('p', 'w', 5, 6, 'next')); // duplicate delivery

    expect(h.applied).toEqual([next]);
    expect(h.sync.getStatus('p', 'w')).toEqual({ phase: 'live', revision: 6 });
  });

  it('bounds retained event ids for a long-lived scope', async () => {
    const h = createHarness();
    const hydration = h.sync.hydrate('p', 'w');
    h.pendingQueries[0].resolve(snapshot('p', 'w', 0));
    await hydration;

    for (let revision = 1; revision <= 1_500; revision += 1) {
      h.sync.handleEvent(event('p', 'w', revision - 1, revision));
    }

    const scopes: unknown = Reflect.get(h.sync, 'scopes');
    if (!(scopes instanceof Map)) throw new Error('Expected sync scope map');
    const scope: unknown = scopes.get('p/w');
    if (
      typeof scope !== 'object' ||
      scope === null ||
      !('seenEventIds' in scope) ||
      !(scope.seenEventIds instanceof Set)
    ) {
      throw new Error('Expected retained event-id set');
    }
    expect(scope.seenEventIds.size).toBeLessThanOrEqual(1_000);
    expect(h.sync.getStatus('p', 'w')?.revision).toBe(1_500);
  });

  it('enters refreshing on a revision gap, keeps the projection, and issues exactly one snapshot query', async () => {
    const h = createHarness();
    const hydration = h.sync.hydrate('p', 'w');
    h.pendingQueries[0].resolve(snapshot('p', 'w', 1));
    await hydration;

    // Gap: baseRevision 4 != applied revision 1.
    h.sync.handleEvent(event('p', 'w', 4, 5));
    expect(h.sync.getStatus('p', 'w')?.phase).toBe('refreshing');
    // The last good projection was not replaced or cleared.
    expect(h.installed).toHaveLength(1);
    expect(h.applied).toHaveLength(0);

    // Additional gap events must not fan out extra queries.
    h.sync.handleEvent(event('p', 'w', 5, 6));
    expect(h.pendingQueries).toHaveLength(2); // hydrate + one refresh

    h.pendingQueries[1].resolve(snapshot('p', 'w', 6));
    await flushMicrotasks();

    expect(h.installed).toEqual([
      { revision: 1, reason: 'hydrate' },
      { revision: 6, reason: 'refresh' },
    ]);
    expect(h.sync.getStatus('p', 'w')).toEqual({ phase: 'live', revision: 6 });
  });

  it('keeps the last good projection and surfaces refresh_error when the refresh fails, then recovers on retry', async () => {
    const h = createHarness();
    const hydration = h.sync.hydrate('p', 'w');
    h.pendingQueries[0].resolve(snapshot('p', 'w', 1));
    await hydration;

    h.sync.handleEvent(event('p', 'w', 4, 5));
    h.pendingQueries[1].reject(new Error('refresh failed'));
    await flushMicrotasks();

    expect(h.sync.getStatus('p', 'w')).toEqual({
      phase: 'refresh_error',
      revision: 1,
    });
    expect(h.installed).toHaveLength(1); // projection retained

    h.sync.retry('p', 'w');
    expect(h.sync.getStatus('p', 'w')?.phase).toBe('refreshing');
    h.pendingQueries[2].resolve(snapshot('p', 'w', 7));
    await flushMicrotasks();
    expect(h.sync.getStatus('p', 'w')).toEqual({ phase: 'live', revision: 7 });
    expect(h.installed[1]).toEqual({ revision: 7, reason: 'refresh' });
  });

  it('keeps hydration state independent per scope', async () => {
    const h = createHarness();
    const first = h.sync.hydrate('p', 'w1');
    const second = h.sync.hydrate('p', 'w2');

    h.sync.handleEvent(event('p', 'w1', 1, 2));
    h.sync.handleEvent(event('p', 'w2', 9, 10));

    h.pendingQueries[0].resolve(snapshot('p', 'w1', 1));
    h.pendingQueries[1].resolve(snapshot('p', 'w2', 9));
    await Promise.all([first, second]);

    expect(h.sync.getStatus('p', 'w1')).toEqual({ phase: 'live', revision: 2 });
    expect(h.sync.getStatus('p', 'w2')).toEqual({
      phase: 'live',
      revision: 10,
    });
    // Each scope applied only its own event.
    expect(
      h.applied.map((evt) => `${evt.worktreeId}:${String(evt.revision)}`),
    ).toEqual(['w1:2', 'w2:10']);
  });

  it('releases a scope so a failed initial hydration never fabricates empty state', async () => {
    const h = createHarness();
    const hydration = h.sync.hydrate('p', 'w');
    h.pendingQueries[0].reject(new Error('load failed'));
    await expect(hydration).rejects.toThrow('load failed');

    expect(h.sync.isTracking('p', 'w')).toBe(false);
    expect(h.installed).toHaveLength(0);
    expect(h.statuses[h.statuses.length - 1]).toBeNull();
  });

  it('adopts an externally fetched snapshot and applies later contiguous deltas', () => {
    const h = createHarness();
    h.sync.adoptSnapshot(snapshot('p', 'w', 12));
    expect(h.sync.getStatus('p', 'w')).toEqual({
      phase: 'live',
      revision: 12,
    });
    h.sync.handleEvent(event('p', 'w', 12, 13));
    expect(h.applied.map((evt) => evt.revision)).toEqual([13]);
  });

  it('forceRefresh runs the one-shot refresh lifecycle from live', async () => {
    const h = createHarness();
    h.sync.adoptSnapshot(snapshot('p', 'w', 3));
    h.sync.forceRefresh('p', 'w');
    expect(h.sync.getStatus('p', 'w')?.phase).toBe('refreshing');
    h.pendingQueries[0].resolve(snapshot('p', 'w', 4));
    await flushMicrotasks();
    expect(h.sync.getStatus('p', 'w')).toEqual({ phase: 'live', revision: 4 });
  });

  it('reports its tracked scopes before each snapshot query and after each release', async () => {
    const order: string[] = [];
    const sync = new RevisionedChatSync(
      {
        getState: (request): Promise<ChatStateSnapshot> => {
          order.push(`query:${request.projectId}/${request.worktreeId}`);
          return request.worktreeId === 'broken'
            ? Promise.reject(new Error('load failed'))
            : Promise.resolve(
                snapshot(request.projectId, request.worktreeId, 1),
              );
        },
      },
      {
        installSnapshot: (): void => undefined,
        applyCommittedEvent: (): void => undefined,
        onTrackedScopesChanged: (scopes): void => {
          order.push(
            `tracked:${scopes
              .map((scope) => `${scope.projectId}/${scope.worktreeId}`)
              .join(',')}`,
          );
        },
      },
    );
    await sync.hydrate('p', 'a');
    await sync.hydrate('p', 'b');
    await sync.hydrate('p', 'a');
    await expect(sync.hydrate('p', 'broken')).rejects.toThrow('load failed');
    sync.release('p', 'a');
    sync.release('p', 'missing');
    sync.adoptSnapshot(snapshot('q', 'c', 4));
    sync.releaseAll();
    expect(order).toEqual([
      'tracked:p/a',
      'query:p/a',
      'tracked:p/a,p/b',
      'query:p/b',
      'tracked:p/a,p/b,p/broken',
      'query:p/broken',
      'tracked:p/a,p/b',
      'tracked:p/b',
      'tracked:p/b,q/c',
      'tracked:',
    ]);
  });
});
