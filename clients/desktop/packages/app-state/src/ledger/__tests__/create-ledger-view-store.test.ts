import type { LedgerClient } from '@canopy/app-core';
import type {
  LedgerActorRef,
  LedgerEntriesSearchResult,
  LedgerEntryGetResult,
  LedgerEntrySearchItem,
} from '@canopy/protocol/canopy-core';
import type {
  LedgerViewChangedEvent,
  LedgerViewEntry,
  LedgerViewEntryRequest,
  LedgerViewResult,
  LedgerTaskViewScope,
  LedgerViewScope,
  LedgerViewSearchRequest,
} from '@canopy/protocol/ledger-view';
import {
  DEFAULT_LEDGER_VIEW_FILTERS,
  createLedgerViewStore,
  ledgerViewSearchParams,
} from '../create-ledger-view-store';

const SCOPE: LedgerTaskViewScope = {
  projectId: 'project-1',
  worktreeId: 'wt-1',
};
const ACTOR: LedgerActorRef = {
  actorId: '00000000-0000-4000-8000-0000000000a1',
  kind: 'chat',
  authorityId: 'authority-1',
};

function item(index: number, revision = 1): LedgerEntrySearchItem {
  return {
    entryId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    revision,
    type: 'TASK',
    title: `Entry ${index}`,
    content: `Content ${index}`,
    highlights: [],
    referenceFiles: [],
    status: 'TODO',
    owner: ACTOR,
    author: ACTOR,
    attributionKind: 'self_reported',
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:00:00.000Z',
    sourceAvailability: 'available',
  };
}

function page(
  items: LedgerEntrySearchItem[],
  nextCursor: string | null = null,
  audienceChangePending?: boolean,
): LedgerViewResult<LedgerEntriesSearchResult> {
  return {
    status: 'ok',
    value: {
      entries: items,
      nextCursor,
      hasMore: nextCursor !== null,
      watermark: '1',
      actors: [
        { actorId: ACTOR.actorId, kind: 'chat', displayName: 'Chat one' },
      ],
      ...(audienceChangePending === undefined
        ? {}
        : { scopeSync: { audienceChangePending } }),
    },
  };
}

function detail(
  entry: LedgerEntrySearchItem,
): LedgerViewResult<LedgerViewEntry> {
  const result: LedgerEntryGetResult = {
    entry: {
      schemaVersion: 1,
      entryId: entry.entryId,
      scope: {
        ledgerId: '00000000-0000-4000-8000-0000000000f1',
        authorityId: 'authority-1',
        container: {
          kind: 'code_worktree',
          workspaceId: SCOPE.projectId,
          worktreeId: SCOPE.worktreeId,
        },
      },
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      revision: entry.revision,
      author: ACTOR,
      authorDetails: {
        harness: 'claude',
        model: null,
        thinkingEffort: null,
        mode: null,
        pipelineExecutionId: null,
        settingsRevision: null,
        unavailableReason: null,
      },
      owner: ACTOR,
      type: entry.type,
      title: entry.title,
      content: entry.content,
      highlights: [],
      referenceFiles: [],
      status: entry.status,
      origin: {
        kind: 'chat',
        ledgerId: '00000000-0000-4000-8000-0000000000f1',
        chatId: 'chat-1',
      },
      attribution: {
        kind: 'self_reported',
        effectiveActor: ACTOR,
        recordedBy: ACTOR,
        executorDetails: {
          harness: 'claude',
          model: null,
          thinkingEffort: null,
          mode: null,
          pipelineExecutionId: null,
          settingsRevision: null,
          unavailableReason: null,
        },
      },
    },
    sourceAvailability: 'available',
    history: { mutations: [], nextCursor: null },
    actors: [],
  };
  return {
    status: 'ok',
    value: {
      entry: result,
      source: { availability: 'available', target: null },
    },
  };
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A client whose reads the test answers one at a time. */
function scriptedClient(): {
  client: LedgerClient;
  searches: Array<{
    request: LedgerViewSearchRequest;
    answer: Deferred<LedgerViewResult<LedgerEntriesSearchResult>>;
  }>;
  reads: Array<{
    request: LedgerViewEntryRequest;
    answer: Deferred<LedgerViewResult<LedgerViewEntry>>;
  }>;
  emit(event: LedgerViewChangedEvent): void;
} {
  const searches: Array<{
    request: LedgerViewSearchRequest;
    answer: Deferred<LedgerViewResult<LedgerEntriesSearchResult>>;
  }> = [];
  const reads: Array<{
    request: LedgerViewEntryRequest;
    answer: Deferred<LedgerViewResult<LedgerViewEntry>>;
  }> = [];
  const handlers = new Set<(event: LedgerViewChangedEvent) => void>();
  return {
    searches,
    reads,
    emit: (event): void => handlers.forEach((handler) => handler(event)),
    client: {
      searchEntries: (
        request,
      ): Promise<LedgerViewResult<LedgerEntriesSearchResult>> => {
        const answer = deferred<LedgerViewResult<LedgerEntriesSearchResult>>();
        searches.push({ request, answer });
        return answer.promise;
      },
      getEntry: (request): Promise<LedgerViewResult<LedgerViewEntry>> => {
        const answer = deferred<LedgerViewResult<LedgerViewEntry>>();
        reads.push({ request, answer });
        return answer.promise;
      },
      addEntry: () =>
        Promise.resolve({ status: 'unavailable', reason: 'disabled' }),
      updateEntry: () =>
        Promise.resolve({ status: 'unavailable', reason: 'disabled' }),
      listOwners: () =>
        Promise.resolve({ status: 'unavailable', reason: 'disabled' }),
      subscribeChanges: (handler) => {
        handlers.add(handler);
        return (): void => {
          handlers.delete(handler);
        };
      },
    },
  };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

describe('ledgerViewSearchParams', () => {
  it('sends only the filters that narrow, newest entries first', () => {
    expect(
      ledgerViewSearchParams('', DEFAULT_LEDGER_VIEW_FILTERS, { limit: 30 }),
    ).toEqual({ sort: 'created_desc', limit: 30 });
    expect(
      ledgerViewSearchParams(
        '  parser\u0007 recovery ',
        { types: ['TASK'], statuses: ['BLOCKED'], owner: 'you' },
        { limit: 30, cursor: 'cursor-1' },
      ),
    ).toEqual({
      query: 'parser  recovery',
      types: ['TASK'],
      statuses: ['BLOCKED'],
      owner: 'self',
      sort: 'created_desc',
      limit: 30,
      cursor: 'cursor-1',
    });
  });

  it('cuts the query to the Ledger limit in code points', () => {
    const params = ledgerViewSearchParams(
      '😀'.repeat(300),
      DEFAULT_LEDGER_VIEW_FILTERS,
      { limit: 30 },
    );
    expect(Array.from(params.query ?? '')).toHaveLength(256);
  });
});

describe('createLedgerViewStore', () => {
  it('loads the first page, then appends the next without repeating an entry', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE);
    expect(store.getState().list.generation).toBe(0);

    const loading = store.getState().load();
    expect(store.getState().list.status).toBe('loading');
    scripted.searches[0]?.answer.resolve(page([item(1), item(2)], 'cursor-1'));
    await loading;
    expect(store.getState().list).toMatchObject({
      status: 'ready',
      generation: 1,
      hasMore: true,
      nextCursor: 'cursor-1',
    });
    expect(store.getState().actors[ACTOR.actorId]?.displayName).toBe(
      'Chat one',
    );

    const more = store.getState().loadMore();
    expect(scripted.searches[1]?.request.params.cursor).toBe('cursor-1');
    scripted.searches[1]?.answer.resolve(page([item(2), item(3)]));
    await more;
    expect(store.getState().list.entries.map((entry) => entry.title)).toEqual([
      'Entry 1',
      'Entry 2',
      'Entry 3',
    ]);
    expect(store.getState().list.hasMore).toBe(false);
    expect(store.getState().list.generation).toBe(1);
  });

  it('drops a response a newer search superseded', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE);

    const first = store.getState().load();
    store.getState().setQueryText('parser');
    const second = store.getState().load();
    scripted.searches[1]?.answer.resolve(page([item(2)]));
    await second;
    scripted.searches[0]?.answer.resolve(page([item(1)]));
    await first;

    expect(store.getState().list.entries.map((entry) => entry.title)).toEqual([
      'Entry 2',
    ]);
  });

  it('shows a failed read as a problem, never as an empty list', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE);

    const loading = store.getState().load();
    scripted.searches[0]?.answer.resolve({
      status: 'error',
      reason: 'STORAGE_UNAVAILABLE',
      message: 'The Ledger store is not available.',
    });
    await loading;

    expect(store.getState().list).toMatchObject({
      status: 'problem',
      entries: [],
      problem: { kind: 'error', reason: 'STORAGE_UNAVAILABLE' },
    });
  });

  it('starts again from the top when a cursor expires', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE);
    const loading = store.getState().load();
    scripted.searches[0]?.answer.resolve(page([item(1)], 'cursor-1'));
    await loading;

    const more = store.getState().loadMore();
    scripted.searches[1]?.answer.resolve({
      status: 'error',
      reason: 'CURSOR_EXPIRED',
      message: 'Expired',
    });
    await settle();
    expect(scripted.searches[2]?.request.params.cursor).toBeUndefined();
    scripted.searches[2]?.answer.resolve(page([item(1), item(2)]));
    await more;

    expect(store.getState().list.entries).toHaveLength(2);
  });

  it('applies filters by reading the first page again', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE);

    const filtering = store.getState().setFilters({
      ...DEFAULT_LEDGER_VIEW_FILTERS,
      statuses: ['IN_PROGRESS'],
    });
    expect(scripted.searches[0]?.request).toEqual({
      scope: SCOPE,
      params: {
        statuses: ['IN_PROGRESS'],
        sort: 'created_desc',
        limit: 30,
      },
    });
    scripted.searches[0]?.answer.resolve(page([]));
    await filtering;
    expect(store.getState().list.status).toBe('ready');
    expect(store.getState().list.generation).toBe(1);

    const reloading = store.getState().load();
    scripted.searches[1]?.answer.resolve(page([item(2)]));
    await reloading;
    expect(store.getState().list.generation).toBe(2);
  });

  it('reads the selected entry, and clears it when the selection clears', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE);
    const entry = item(1);

    const selecting = store.getState().select(entry.entryId);
    expect(store.getState().detail).toMatchObject({
      status: 'loading',
      entryId: entry.entryId,
    });
    scripted.reads[0]?.answer.resolve(detail(entry));
    await selecting;
    expect(store.getState().detail.status).toBe('ready');

    await store.getState().select(null);
    expect(store.getState()).toMatchObject({
      selectedEntryId: null,
      detail: { status: 'idle', view: null },
    });
  });

  it('keeps a shown draft only when selection asks to keep it', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE);

    store.getState().startEntry();
    const keptSelection = store.getState().select(item(1).entryId, {
      keepDraft: true,
    });
    scripted.reads[0]?.answer.resolve(detail(item(1)));
    await keptSelection;
    expect(store.getState().composer.shown).toBe(true);

    store.getState().startEntry();
    const ordinarySelection = store.getState().select(item(2).entryId);
    scripted.reads[1]?.answer.resolve(detail(item(2)));
    await ordinarySelection;
    expect(store.getState().composer).toMatchObject({
      shown: false,
      draft: { type: 'TASK' },
    });
  });

  it('starts a correction from the fields on a search row', () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE);
    const row = item(1);

    store.getState().startCorrection(row);
    expect(store.getState().corrections[row.entryId]?.draft.supersedes).toEqual(
      {
        entryId: row.entryId,
        title: row.title,
      },
    );
  });

  it('takes changes only of its own global (workflow) Ledger', async () => {
    const scripted = scriptedClient();
    const globalScope: LedgerViewScope = {
      kind: 'global',
      owner: { kind: 'personal' },
      ledgerId: 'ledger-1',
    };
    const store = createLedgerViewStore(scripted.client, globalScope);
    const loading = store.getState().load();
    scripted.searches[0]?.answer.resolve(page([item(1)]));
    await loading;

    // Another incarnation of the same owner's Ledger, and a task, are not it.
    store.getState().applyChanges({
      changes: [
        {
          scope: { ...globalScope, ledgerId: 'ledger-2' },
          entryId: 'a',
          revision: 1,
        },
        { scope: SCOPE, entryId: 'b', revision: 1 },
      ],
    });
    expect(scripted.searches).toHaveLength(1);

    store.getState().applyChanges({
      changes: [{ scope: { ...globalScope }, entryId: 'c', revision: 1 }],
    });
    expect(scripted.searches).toHaveLength(2);
    expect(scripted.searches[1]?.request.scope).toEqual(globalScope);
  });

  it('quietly re-reads an open entry on a same-revision change', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE);
    const entry = item(1);
    const loading = store.getState().load();
    scripted.searches[0]?.answer.resolve(page([entry]));
    await loading;
    const selecting = store.getState().select(entry.entryId);
    scripted.reads[0]?.answer.resolve(detail(entry));
    await selecting;

    store.getState().applyChanges({
      changes: [{ scope: SCOPE, entryId: entry.entryId, revision: 1 }],
    });
    expect(scripted.searches).toHaveLength(2);
    expect(scripted.reads).toHaveLength(2);
    expect(store.getState().detail.status).toBe('ready');
    scripted.searches[1]?.answer.resolve(page([entry]));
    scripted.reads[1]?.answer.resolve({
      status: 'error',
      reason: 'UNKNOWN',
      message: 'The title is still being resolved.',
    });
    await settle();

    expect(store.getState().detail.status).toBe('ready');
    expect(store.getState().detail.view?.entry.entry.title).toBe(entry.title);
    expect(store.getState().list.status).toBe('ready');
  });

  it('quietly re-reads an open entry when its title resolves at the same revision', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE);
    const entry = item(1);
    const loading = store.getState().load();
    scripted.searches[0]?.answer.resolve(page([entry]));
    await loading;
    const selecting = store.getState().select(entry.entryId);
    scripted.reads[0]?.answer.resolve(detail(entry));
    await selecting;

    const titleResolvedFlag: { readonly titleResolved: true } = {
      titleResolved: true,
    };
    const titleResolved = {
      scope: SCOPE,
      entryId: entry.entryId,
      revision: entry.revision,
      ...titleResolvedFlag,
    };
    store.getState().applyChanges({ changes: [titleResolved] });
    expect(scripted.searches).toHaveLength(2);
    expect(scripted.reads).toHaveLength(2);
    expect(store.getState().detail.status).toBe('ready');
    scripted.searches[1]?.answer.resolve(page([entry]));
    scripted.reads[1]?.answer.resolve(
      detail({ ...entry, title: 'Resolved title' }),
    );
    await settle();

    expect(store.getState().detail.status).toBe('ready');
    expect(store.getState().detail.view?.entry.entry.title).toBe(
      'Resolved title',
    );
    expect(store.getState().detail.view?.entry.entry.revision).toBe(
      entry.revision,
    );
  });

  it("re-reads the list and the selected entry when a change names this scope, and nothing for another scope's", async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE);
    const entry = item(1);
    const loading = store.getState().load();
    scripted.searches[0]?.answer.resolve(page([entry]));
    await loading;
    const generation = store.getState().list.generation;
    const selecting = store.getState().select(entry.entryId);
    scripted.reads[0]?.answer.resolve(detail(entry));
    await selecting;

    store.getState().applyChanges({
      changes: [
        {
          scope: { projectId: 'project-1', worktreeId: 'wt-other' },
          entryId: entry.entryId,
          revision: 2,
        },
      ],
    });
    expect(scripted.searches).toHaveLength(1);
    expect(scripted.reads).toHaveLength(1);

    store.getState().applyChanges({
      changes: [{ scope: SCOPE, entryId: entry.entryId, revision: 2 }],
    });
    expect(scripted.searches).toHaveLength(2);
    expect(scripted.reads).toHaveLength(2);
    // A refresh keeps the list on screen while it re-reads.
    expect(store.getState().list.status).toBe('ready');
    scripted.searches[1]?.answer.resolve(page([item(1, 2)]));
    scripted.reads[1]?.answer.resolve(detail(item(1, 2)));
    await settle();

    expect(store.getState().list.entries[0]?.revision).toBe(2);
    expect(store.getState().list.generation).toBe(generation);
    expect(store.getState().detail.view?.entry.entry.revision).toBe(2);
  });

  it('re-reads its sync states in place when they changed for this scope or for every scope', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE);
    const entry = item(1);
    const loading = store.getState().load();
    scripted.searches[0]?.answer.resolve(page([entry]));
    await loading;
    const selecting = store.getState().select(entry.entryId);
    scripted.reads[0]?.answer.resolve(detail(entry));
    await selecting;

    store.getState().applyChanges({
      changes: [],
      syncChanged: [{ projectId: 'project-1', worktreeId: 'wt-other' }],
    });
    expect(scripted.searches).toHaveLength(1);
    expect(scripted.reads).toHaveLength(1);

    store.getState().applyChanges({ changes: [], syncChanged: [SCOPE] });
    expect(scripted.searches).toHaveLength(2);
    expect(scripted.reads).toHaveLength(2);
    // Neither the list nor the entry leaves the screen while it re-reads.
    expect(store.getState().list.status).toBe('ready');
    expect(store.getState().detail.status).toBe('ready');
    scripted.searches[1]?.answer.resolve(page([entry]));
    scripted.reads[1]?.answer.resolve({
      status: 'error',
      reason: 'UNKNOWN',
      message: 'Offline',
    });
    await settle();
    // A failed re-read of a sync state keeps the entry shown.
    expect(store.getState().detail.status).toBe('ready');

    store.getState().applyChanges({ changes: [], syncChanged: 'all' });
    expect(scripted.searches).toHaveLength(3);
    expect(scripted.reads).toHaveLength(3);
  });

  it("keeps the scope's pending audience change from each read", async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE);
    expect(store.getState().list.audienceChangePending).toBe(false);

    const loading = store.getState().load();
    scripted.searches[0]?.answer.resolve(page([item(1)], null, true));
    await loading;
    expect(store.getState().list.audienceChangePending).toBe(true);

    store.getState().applyChanges({ changes: [], syncChanged: [SCOPE] });
    scripted.searches[1]?.answer.resolve(page([item(1)], null, false));
    await settle();
    expect(store.getState().list.audienceChangePending).toBe(false);
  });

  it('queues one more refresh for changes that arrive during a refresh', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE);
    const loading = store.getState().load();
    scripted.searches[0]?.answer.resolve(page([item(1)]));
    await loading;

    const change: LedgerViewChangedEvent = {
      changes: [{ scope: SCOPE, entryId: item(2).entryId, revision: 1 }],
    };
    store.getState().applyChanges(change);
    store.getState().applyChanges(change);
    store.getState().applyChanges(change);
    expect(scripted.searches).toHaveLength(2);
    scripted.searches[1]?.answer.resolve(page([item(2), item(1)]));
    await settle();

    expect(scripted.searches).toHaveLength(3);
    scripted.searches[2]?.answer.resolve(page([item(2), item(1)]));
    await settle();
    expect(scripted.searches).toHaveLength(3);
  });

  it('keeps every loaded row when a change refreshes a list longer than one read', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE);
    const items = Array.from({ length: 130 }, (_, index) => item(index + 1));
    const loading = store.getState().load();
    scripted.searches[0]?.answer.resolve(page(items, 'cursor-1'));
    await loading;

    store.getState().applyChanges({
      changes: [{ scope: SCOPE, entryId: item(1).entryId, revision: 2 }],
    });
    expect(scripted.searches[1]?.request.params).toMatchObject({ limit: 100 });
    expect(scripted.searches[1]?.request.params.cursor).toBeUndefined();
    scripted.searches[1]?.answer.resolve(
      page([item(1, 2), ...items.slice(1, 100)], 'refresh-1'),
    );
    await settle();
    // The refresh keeps going until it has re-read every loaded row.
    expect(scripted.searches[2]?.request.params).toMatchObject({
      cursor: 'refresh-1',
      limit: 30,
    });
    scripted.searches[2]?.answer.resolve(page(items.slice(100), 'refresh-2'));
    await settle();

    expect(scripted.searches).toHaveLength(3);
    expect(store.getState().list).toMatchObject({
      status: 'ready',
      nextCursor: 'refresh-2',
      hasMore: true,
    });
    expect(store.getState().list.entries).toHaveLength(130);
    expect(store.getState().list.entries[0]?.revision).toBe(2);
    expect(store.getState().list.entries[129]?.title).toBe('Entry 130');
  });

  it('lets "load more" run again after a refresh that replaced it fails', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE);
    const loading = store.getState().load();
    scripted.searches[0]?.answer.resolve(page([item(1)], 'cursor-1'));
    await loading;

    const more = store.getState().loadMore();
    expect(store.getState().list.loadingMore).toBe(true);
    store.getState().applyChanges({
      changes: [{ scope: SCOPE, entryId: item(1).entryId, revision: 2 }],
    });
    scripted.searches[1]?.answer.resolve(page([item(2)]));
    await more;
    scripted.searches[2]?.answer.resolve({
      status: 'unavailable',
      reason: 'runtime_unavailable',
    });
    await settle();

    // What was shown stays, and the next page can still be asked for.
    expect(store.getState().list).toMatchObject({
      status: 'ready',
      loadingMore: false,
      nextCursor: 'cursor-1',
    });
    expect(store.getState().list.entries).toHaveLength(1);
    void store.getState().loadMore();
    expect(scripted.searches).toHaveLength(4);
    expect(scripted.searches[3]?.request.params.cursor).toBe('cursor-1');
  });

  it('pages on from the refreshed list when "load more" starts during a refresh', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE);
    const loading = store.getState().load();
    scripted.searches[0]?.answer.resolve(
      page([item(3), item(2), item(1)], 'cursor-1'),
    );
    await loading;

    // A new entry at the top pushes Entry 1 past the rows the refresh reads.
    store.getState().applyChanges({
      changes: [{ scope: SCOPE, entryId: item(4).entryId, revision: 1 }],
    });
    const more = store.getState().loadMore();
    // The page waits for the refresh instead of reading the old cursor.
    expect(scripted.searches).toHaveLength(2);
    scripted.searches[1]?.answer.resolve(
      page([item(4), item(3), item(2)], 'refresh-1'),
    );
    await settle();
    expect(scripted.searches[2]?.request.params.cursor).toBe('refresh-1');
    scripted.searches[2]?.answer.resolve(page([item(1)]));
    await more;

    expect(store.getState().list.entries.map((entry) => entry.title)).toEqual([
      'Entry 4',
      'Entry 3',
      'Entry 2',
      'Entry 1',
    ]);
    expect(store.getState().list).toMatchObject({
      loadingMore: false,
      hasMore: false,
    });
  });

  it('re-reads a ready list and the selected entry in place on revalidate', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE);
    const entry = item(1);
    const loading = store.getState().load();
    scripted.searches[0]?.answer.resolve(page([entry]));
    await loading;
    const selecting = store.getState().select(entry.entryId);
    scripted.reads[0]?.answer.resolve(detail(entry));
    await selecting;
    store.getState().setScrollTop(120);

    const revalidating = store.getState().revalidate();
    expect(scripted.searches).toHaveLength(2);
    expect(scripted.searches[1]?.request.params.cursor).toBeUndefined();
    expect(scripted.reads).toHaveLength(2);
    // Nothing on screen gives way to a loading state meanwhile.
    expect(store.getState().list.status).toBe('ready');
    expect(store.getState().detail.status).toBe('ready');
    scripted.searches[1]?.answer.resolve(page([item(2), item(1, 2)]));
    scripted.reads[1]?.answer.resolve(detail(item(1, 2)));
    await revalidating;

    expect(store.getState().list.entries.map((row) => row.title)).toEqual([
      'Entry 2',
      'Entry 1',
    ]);
    expect(store.getState().detail.view?.entry.entry.revision).toBe(2);
    expect(store.getState().selectedEntryId).toBe(entry.entryId);
    expect(store.getState().scrollTop).toBe(120);
    expect(store.getState().list.generation).toBe(1);
  });

  it('reads the first page again on revalidate after a failed read', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE);
    const loading = store.getState().load();
    scripted.searches[0]?.answer.resolve({
      status: 'error',
      reason: 'STORAGE_UNAVAILABLE',
      message: 'The Ledger store is not available.',
    });
    await loading;

    const revalidating = store.getState().revalidate();
    scripted.searches[1]?.answer.resolve(page([item(1)]));
    await revalidating;

    expect(store.getState().list).toMatchObject({ status: 'ready' });
    expect(store.getState().list.entries).toHaveLength(1);
    expect(store.getState().list.generation).toBe(1);
  });

  it('forgets the whole view on reset and drops reads still in flight', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE);
    const entry = item(1);
    store.getState().setQueryText('parser');
    const filtering = store.getState().setFilters({
      ...DEFAULT_LEDGER_VIEW_FILTERS,
      types: ['TASK'],
    });
    scripted.searches[0]?.answer.resolve(page([entry], 'cursor-1'));
    await filtering;
    const selecting = store.getState().select(entry.entryId);
    scripted.reads[0]?.answer.resolve(detail(entry));
    await selecting;
    store.getState().setScrollTop(80);
    store.getState().applyChanges({
      changes: [{ scope: SCOPE, entryId: entry.entryId, revision: 2 }],
    });
    expect(scripted.searches).toHaveLength(2);
    expect(scripted.reads).toHaveLength(2);

    store.getState().reset();
    expect(store.getState()).toMatchObject({
      queryText: '',
      filters: DEFAULT_LEDGER_VIEW_FILTERS,
      list: { status: 'idle', generation: 1, entries: [], nextCursor: null },
      selectedEntryId: null,
      detail: { status: 'idle', entryId: null, view: null },
      actors: {},
      scrollTop: 0,
    });

    scripted.searches[1]?.answer.resolve(page([item(1, 2)]));
    scripted.reads[1]?.answer.resolve(detail(item(1, 2)));
    await settle();
    expect(store.getState().list).toMatchObject({
      status: 'idle',
      entries: [],
    });
    expect(store.getState().detail).toMatchObject({ status: 'idle' });
    expect(store.getState().actors).toEqual({});
    // Nothing queued during the dropped refresh runs after it.
    expect(scripted.searches).toHaveLength(2);
  });
});
