import type { LedgerClient, LedgerFeedClient } from '@canopy/app-core';
import type {
  LedgerActorRef,
  LedgerEntryGetResult,
  LedgerEntrySearchItem,
  LedgerMutation,
  LedgerOwnerCandidate,
} from '@canopy/protocol/canopy-core';
import type {
  LedgerFeedEntryRequest,
  LedgerFeedPage,
  LedgerFeedRequest,
  LedgerFeedRow,
  LedgerViewEntry,
  LedgerViewReceipt,
  LedgerViewResult,
  LedgerViewScope,
} from '@canopy/protocol/ledger-view';
import {
  DEFAULT_LEDGER_FEED_FILTERS,
  createLedgerFeedStore,
} from '../create-ledger-feed-store';
import {
  createLedgerViewStore,
  type LedgerViewStore,
} from '../create-ledger-view-store';
import { blankLedgerViewDraft } from '../ledger-view-writes';

const ACTOR: LedgerActorRef = {
  actorId: '00000000-0000-4000-8000-0000000000a1',
  kind: 'user',
  authorityId: 'authority-1',
};

function item(index: number, revision = 1): LedgerEntrySearchItem {
  return {
    entryId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    revision,
    type: 'TASK',
    title: `Entry ${String(index)}`,
    content: 'Write the plan.',
    highlights: [],
    referenceFiles: [],
    status: 'TODO',
    owner: ACTOR,
    author: ACTOR,
    attributionKind: 'self_reported',
    createdAt: '2026-10-02T10:00:00.000Z',
    updatedAt: '2026-10-02T10:00:00.000Z',
    sourceAvailability: 'available',
  };
}

function localRow(index: number, revision = 1): LedgerFeedRow {
  return {
    entry: item(index, revision),
    ledgerId: '00000000-0000-4000-8000-0000000000e1',
    scopeKind: 'code_worktree',
    scopeArchived: false,
    origin: {
      kind: 'this_device',
      scope: { projectId: 'project-1', worktreeId: 'wt-1' },
    },
  };
}

function remoteRow(index: number): LedgerFeedRow {
  return {
    entry: item(index),
    ledgerId: '00000000-0000-4000-8000-0000000000e2',
    scopeKind: 'cowork_entry',
    scopeArchived: false,
    origin: { kind: 'other_device', deviceLabel: 'Studio Mac' },
  };
}

function teammateRow(index: number): LedgerFeedRow {
  return {
    entry: item(index),
    ledgerId: '00000000-0000-4000-8000-0000000000e3',
    scopeKind: 'code_worktree',
    scopeArchived: false,
    origin: {
      kind: 'teammate',
      teammateName: 'Ada Lovelace',
      organizationName: 'Acme',
    },
  };
}

function synced(
  row: LedgerFeedRow,
  syncState: NonNullable<LedgerEntrySearchItem['syncState']>,
): LedgerFeedRow {
  return { ...row, entry: { ...row.entry, syncState } };
}

function page(
  rows: LedgerFeedRow[],
  nextCursor: string | null = null,
  notice: LedgerFeedPage['notice'] = null,
): LedgerViewResult<LedgerFeedPage> {
  return {
    status: 'ok',
    value: {
      rows,
      actors: [{ actorId: ACTOR.actorId, kind: 'user', displayName: 'You' }],
      nextCursor,
      hasMore: nextCursor !== null,
      notice,
    },
  };
}

function mutation(revision: number): LedgerMutation {
  return {
    mutationId: `00000000-0000-4000-8000-${String(900 + revision).padStart(12, '0')}`,
    entryId: item(7).entryId,
    kind: 'update',
    revision,
    previousRevision: revision - 1,
    occurredAt: '2026-10-02T10:00:00.000Z',
    status: { from: 'TODO', to: 'IN_PROGRESS' },
    attribution: {
      kind: 'self_reported',
      effectiveActor: ACTOR,
      recordedBy: ACTOR,
      executorDetails: {
        harness: null,
        model: null,
        thinkingEffort: null,
        mode: null,
        pipelineExecutionId: null,
        settingsRevision: null,
        unavailableReason: 'not_applicable',
      },
    },
    invocationOrigin: {
      kind: 'user',
      ledgerId: '00000000-0000-4000-8000-0000000000e2',
      userActorId: ACTOR.actorId,
    },
  };
}

function remoteView(
  mutations: LedgerMutation[],
  nextCursor: string | null,
): LedgerViewResult<LedgerViewEntry> {
  const entry = item(7);
  const result: LedgerEntryGetResult = {
    entry: {
      schemaVersion: 1,
      entryId: entry.entryId,
      scope: {
        ledgerId: '00000000-0000-4000-8000-0000000000e2',
        authorityId: 'authority-2',
        container: {
          kind: 'cowork_entry',
          workspaceId: 'workspace-2',
          entryId: 'entry-2',
        },
      },
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      revision: entry.revision,
      author: ACTOR,
      authorDetails: {
        harness: null,
        model: null,
        thinkingEffort: null,
        mode: null,
        pipelineExecutionId: null,
        settingsRevision: null,
        unavailableReason: 'not_applicable',
      },
      owner: ACTOR,
      type: entry.type,
      title: entry.title,
      content: entry.content,
      highlights: [],
      referenceFiles: [],
      status: entry.status,
      origin: {
        kind: 'user',
        ledgerId: '00000000-0000-4000-8000-0000000000e2',
        userActorId: ACTOR.actorId,
      },
      attribution: {
        kind: 'self_reported',
        effectiveActor: ACTOR,
        recordedBy: ACTOR,
        executorDetails: {
          harness: null,
          model: null,
          thinkingEffort: null,
          mode: null,
          pipelineExecutionId: null,
          settingsRevision: null,
          unavailableReason: 'not_applicable',
        },
      },
    },
    sourceAvailability: 'not_on_this_device',
    history: { mutations, nextCursor },
    actors: [{ actorId: ACTOR.actorId, kind: 'user', displayName: 'Ada' }],
  };
  return {
    status: 'ok',
    value: {
      entry: result,
      source: { availability: 'not_on_this_device', target: null },
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

/** A client answering each call with the next queued answer. */
class FakeFeedClient implements LedgerFeedClient {
  readonly searches: LedgerFeedRequest[] = [];
  readonly entryReads: LedgerFeedEntryRequest[] = [];
  readonly answers: Array<
    LedgerViewResult<LedgerFeedPage> | Promise<LedgerViewResult<LedgerFeedPage>>
  > = [];
  readonly entryAnswers: Array<LedgerViewResult<LedgerViewEntry>> = [];

  searchFeed(
    request: LedgerFeedRequest,
  ): Promise<LedgerViewResult<LedgerFeedPage>> {
    this.searches.push(request);
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error('No answer queued');
    return Promise.resolve(answer);
  }

  getFeedEntry(
    request: LedgerFeedEntryRequest,
  ): Promise<LedgerViewResult<LedgerViewEntry>> {
    this.entryReads.push(request);
    const answer = this.entryAnswers.shift();
    if (answer === undefined) throw new Error('No entry answer queued');
    return Promise.resolve(answer);
  }
}

function titles(rows: readonly LedgerFeedRow[]): string[] {
  return rows.map((row) => row.entry.title);
}

describe('createLedgerFeedStore', () => {
  let client: FakeFeedClient;

  beforeEach(() => {
    client = new FakeFeedClient();
  });

  it('reads the first page for its audience, search and filters', async () => {
    const store = createLedgerFeedStore(client);
    expect(store.getState().list.generation).toBe(0);
    client.answers.push(page([localRow(1), remoteRow(2)], 'feed:s:2'));

    store.getState().setQueryText('  parser\u0007 fix ');
    await store.getState().load();

    expect(client.searches).toEqual([
      {
        audience: 'mine',
        query: 'parser  fix',
        filters: DEFAULT_LEDGER_FEED_FILTERS,
      },
    ]);
    const { list, actors } = store.getState();
    expect(list.status).toBe('ready');
    expect(list.generation).toBe(1);
    expect(titles(list.rows)).toEqual(['Entry 1', 'Entry 2']);
    expect(list.hasMore).toBe(true);
    expect(actors[ACTOR.actorId]?.displayName).toBe('You');
  });

  it('reads again for another audience or filters', async () => {
    const store = createLedgerFeedStore(client);
    client.answers.push(page([]), page([]), page([]));
    await store.getState().load();

    await store.getState().setAudience('teammates');
    await store.getState().setAudience('teammates');
    await store
      .getState()
      .setFilters({ ...DEFAULT_LEDGER_FEED_FILTERS, period: 'week' });

    expect(client.searches.map((search) => search.audience)).toEqual([
      'mine',
      'teammates',
      'teammates',
    ]);
    expect(client.searches[2]?.filters.period).toBe('week');
    expect(store.getState().list.generation).toBe(3);
  });

  it('keeps what the Feed could not include beside the rows', async () => {
    const store = createLedgerFeedStore(client);
    client.answers.push(page([localRow(1)], null, 'remote_unavailable'));

    await store.getState().load();

    expect(store.getState().list.notice).toBe('remote_unavailable');
  });

  it('shows a failed read as a problem, never as an empty Feed', async () => {
    const store = createLedgerFeedStore(client);
    client.answers.push({
      status: 'error',
      reason: 'UNKNOWN',
      message: "Couldn't read your account. Try again.",
    });

    await store.getState().load();

    expect(store.getState().list).toEqual(
      expect.objectContaining({
        status: 'problem',
        rows: [],
        problem: {
          kind: 'error',
          reason: 'UNKNOWN',
          message: "Couldn't read your account. Try again.",
        },
      }),
    );
  });

  it('appends the next page, and starts over when its snapshot ended', async () => {
    const store = createLedgerFeedStore(client);
    client.answers.push(page([localRow(1)], 'feed:s:2'));
    await store.getState().load();

    client.answers.push(page([localRow(1), remoteRow(2)], 'feed:s:3'));
    await store.getState().loadMore();
    expect(titles(store.getState().list.rows)).toEqual(['Entry 1', 'Entry 2']);
    expect(store.getState().list.generation).toBe(1);
    expect(client.searches[1]?.cursor).toBe('feed:s:2');

    client.answers.push(
      {
        status: 'error',
        reason: 'CURSOR_EXPIRED',
        message: 'The Feed changed. Load it again.',
      },
      page([remoteRow(3)]),
    );
    await store.getState().loadMore();

    expect(client.searches[3]).toEqual(
      expect.objectContaining({ refresh: true }),
    );
    expect(client.searches[3]?.cursor).toBeUndefined();
    expect(titles(store.getState().list.rows)).toEqual(['Entry 3']);
  });

  it('refreshes changed rows in place and waits for a new entry', async () => {
    const store = createLedgerFeedStore(client);
    client.answers.push(page([localRow(1), localRow(2)]));
    await store.getState().load();
    await store.getState().select(item(2).entryId);
    store.getState().setScrollTop(120);

    // Same rows: nothing new.
    client.answers.push(page([localRow(1), localRow(2)]));
    await store.getState().checkForNewActivity();
    expect(store.getState().newActivity).toBe(false);
    expect(store.getState().list.generation).toBe(1);

    // The fresh page moves Entry 2 above Entry 1, but their shown positions
    // remain fixed while both rows take their new copies.
    client.answers.push(page([localRow(2, 2), localRow(1, 2)]));
    await store.getState().checkForNewActivity();
    expect(client.searches[2]).toEqual(expect.objectContaining({ peek: true }));
    expect(store.getState().newActivity).toBe(false);
    expect(titles(store.getState().list.rows)).toEqual(['Entry 1', 'Entry 2']);
    expect(store.getState().list.rows[0]?.entry.revision).toBe(2);
    expect(store.getState().list.rows[1]?.entry.revision).toBe(2);
    expect(store.getState().list.generation).toBe(1);

    // A genuinely new entry waits for the person to ask for the fresh page.
    client.answers.push(page([localRow(3), localRow(2, 2), localRow(1, 2)]));
    await store.getState().checkForNewActivity();
    expect(store.getState().newActivity).toBe(true);

    // Showing it reads the newest page, from the top; the selection stays.
    client.answers.push(
      page([localRow(3), localRow(2, 2), localRow(1, 2)], 'next'),
    );
    await store.getState().showNewActivity();
    expect(client.searches[4]).toEqual(
      expect.objectContaining({ refresh: true }),
    );
    expect(client.searches[4]?.peek).toBeUndefined();
    expect(store.getState()).toEqual(
      expect.objectContaining({
        newActivity: false,
        selectedEntryId: item(2).entryId,
        scrollTop: 0,
      }),
    );
    expect(store.getState().list.rows[0]?.entry.entryId).toBe(item(3).entryId);
    expect(store.getState().list.nextCursor).toBe('next');
    expect(store.getState().list.generation).toBe(2);
  });

  it('does not replace a shown row with an older fresh copy', async () => {
    const store = createLedgerFeedStore(client);
    client.answers.push(page([localRow(1, 3)]));
    await store.getState().load();

    client.answers.push(page([localRow(1, 2)]));
    await store.getState().checkForNewActivity();

    expect(store.getState().newActivity).toBe(false);
    expect(store.getState().list.rows[0]?.entry.revision).toBe(3);
    expect(store.getState().list.generation).toBe(1);
  });

  it('replaces a same-revision pending title in place without new activity', async () => {
    const store = createLedgerFeedStore(client);
    const row = localRow(1);
    const pending: LedgerFeedRow = {
      ...row,
      entry: { ...row.entry, title: '', titlePending: true },
    };
    client.answers.push(page([pending]));
    await store.getState().load();

    client.answers.push(
      page([{ ...row, entry: { ...row.entry, title: 'Resolved title' } }]),
    );
    await store.getState().checkForNewActivity();

    expect(store.getState().newActivity).toBe(false);
    expect(store.getState().list.rows).toHaveLength(1);
    expect(store.getState().list.rows[0]?.entry).toMatchObject({
      entryId: row.entry.entryId,
      revision: row.entry.revision,
      title: 'Resolved title',
    });
    expect(store.getState().list.rows[0]?.entry.titlePending).toBeUndefined();
    expect(store.getState().list.generation).toBe(1);
  });

  it('takes what changed in the shown rows, such as how they sync, in place', async () => {
    const store = createLedgerFeedStore(client);
    client.answers.push(
      page([synced(localRow(1), 'pending'), localRow(2)], 'next'),
    );
    await store.getState().load();

    client.answers.push(page([synced(localRow(1), 'mirrored'), localRow(2)]));
    await store.getState().checkForNewActivity();

    const { list, newActivity } = store.getState();
    expect(newActivity).toBe(false);
    expect(titles(list.rows)).toEqual(['Entry 1', 'Entry 2']);
    expect(list.rows[0]?.entry.syncState).toBe('mirrored');
    // The list keeps its own place to go on from.
    expect(list.nextCursor).toBe('next');
    expect(list.generation).toBe(1);
  });

  it("offers the cloud's rows once it is back, past the rows already shown", async () => {
    const store = createLedgerFeedStore(client);
    const shown = Array.from({ length: 30 }, (_, index) => localRow(index + 1));
    client.answers.push(page(shown, null, 'remote_unavailable'));
    await store.getState().load();

    // The same newest rows, then another device's, with more to come.
    client.answers.push(
      page([...shown.slice(0, 29), remoteRow(31)], 'next', null),
    );
    await store.getState().checkForNewActivity();

    expect(store.getState().newActivity).toBe(true);
    expect(store.getState().list.notice).toBe('remote_unavailable');
    expect(store.getState().list.rows).toHaveLength(30);
  });

  it('offers a shorter final page that no longer has the last rows', async () => {
    const store = createLedgerFeedStore(client);
    client.answers.push(page([localRow(1), localRow(2), localRow(3)]));
    await store.getState().load();

    // Entry 3 is gone, archived say: nothing after Entry 2 remains.
    client.answers.push(page([localRow(1), localRow(2)]));
    await store.getState().checkForNewActivity();

    expect(store.getState().newActivity).toBe(true);
    expect(store.getState().list.generation).toBe(1);
    expect(titles(store.getState().list.rows)).toEqual([
      'Entry 1',
      'Entry 2',
      'Entry 3',
    ]);
  });

  it('leaves the list as it is through a passing outage', async () => {
    const store = createLedgerFeedStore(client);
    client.answers.push(page([localRow(1), remoteRow(2)]));
    await store.getState().load();

    client.answers.push(page([localRow(1)], null, 'remote_unavailable'));
    await store.getState().checkForNewActivity();

    expect(store.getState().newActivity).toBe(false);
    expect(store.getState().list.notice).toBeNull();
    expect(titles(store.getState().list.rows)).toEqual(['Entry 1', 'Entry 2']);
  });

  it("adds the person's own saved correction in place, without new activity", async () => {
    const store = createLedgerFeedStore(client);
    client.answers.push(page([localRow(1), localRow(2)]));
    await store.getState().load();
    const correction: LedgerFeedRow = {
      ...localRow(3),
      entry: { ...localRow(3).entry, supersedesEntryId: item(1).entryId },
    };

    store.getState().noteOwnEntry(correction.entry.entryId);
    client.answers.push(page([correction, localRow(1), localRow(2)]));
    await store.getState().checkForNewActivity();

    expect(store.getState().newActivity).toBe(false);
    expect(store.getState().list.generation).toBe(1);
    expect(titles(store.getState().list.rows)).toEqual([
      'Entry 3',
      'Entry 1',
      'Entry 2',
    ]);

    // Adopted once: a later look neither repeats it nor calls it new.
    client.answers.push(page([correction, localRow(1), localRow(2)]));
    await store.getState().checkForNewActivity();
    expect(store.getState().list.rows).toHaveLength(3);
    expect(store.getState().newActivity).toBe(false);

    // An entry the person did not save here still waits.
    client.answers.push(
      page([localRow(4), correction, localRow(1), localRow(2)]),
    );
    await store.getState().checkForNewActivity();
    expect(store.getState().newActivity).toBe(true);
    expect(store.getState().list.rows).toHaveLength(3);
    expect(store.getState().list.generation).toBe(1);
  });

  it('adopts a noted entry from a look already on its way', async () => {
    const store = createLedgerFeedStore(client);
    client.answers.push(page([localRow(1)]));
    await store.getState().load();
    const slow = deferred<LedgerViewResult<LedgerFeedPage>>();
    client.answers.push(slow.promise);

    const look = store.getState().checkForNewActivity();
    store.getState().noteOwnEntry(item(2).entryId);
    slow.resolve(page([localRow(2), localRow(1)]));
    await look;

    expect(store.getState().newActivity).toBe(false);
    expect(titles(store.getState().list.rows)).toEqual(['Entry 2', 'Entry 1']);
  });

  it('forgets noted entries with a fresh first page or a reset', async () => {
    const store = createLedgerFeedStore(client);
    client.answers.push(page([localRow(1)]));
    await store.getState().load();

    store.getState().noteOwnEntry(item(2).entryId);
    client.answers.push(page([localRow(1)]));
    await store.getState().load();
    client.answers.push(page([localRow(2), localRow(1)]));
    await store.getState().checkForNewActivity();
    expect(store.getState().newActivity).toBe(true);
    expect(store.getState().list.rows).toHaveLength(1);

    store.getState().noteOwnEntry(item(3).entryId);
    store.getState().reset();
    client.answers.push(page([localRow(1)]));
    await store.getState().load();
    client.answers.push(page([localRow(3), localRow(1)]));
    await store.getState().checkForNewActivity();
    expect(store.getState().newActivity).toBe(true);
    expect(store.getState().list.rows).toHaveLength(1);
  });

  it('drops a look that a newer look overtook', async () => {
    const store = createLedgerFeedStore(client);
    client.answers.push(page([localRow(1), localRow(2)]));
    await store.getState().load();
    const slow = deferred<LedgerViewResult<LedgerFeedPage>>();
    client.answers.push(slow.promise, page([localRow(1), localRow(2)]));

    const older = store.getState().checkForNewActivity();
    await store.getState().checkForNewActivity();
    slow.resolve(page([localRow(3), localRow(1), localRow(2)]));
    await older;

    expect(store.getState().newActivity).toBe(false);
  });

  it('shows newer activity at once when the list is empty', async () => {
    const store = createLedgerFeedStore(client);
    client.answers.push(page([]));
    await store.getState().load();
    expect(store.getState().list.generation).toBe(1);

    client.answers.push(page([localRow(1)]));
    await store.getState().checkForNewActivity();

    expect(store.getState().newActivity).toBe(false);
    expect(titles(store.getState().list.rows)).toEqual(['Entry 1']);
    expect(store.getState().list.generation).toBe(2);
  });

  it('reads the detail of a remote row, and leaves local rows to their scope', async () => {
    const store = createLedgerFeedStore(client);
    client.answers.push(page([localRow(1), remoteRow(7)]));
    await store.getState().load();

    await store.getState().select(item(1).entryId);
    expect(client.entryReads).toEqual([]);
    expect(store.getState().remoteDetail.status).toBe('idle');
    expect(store.getState().selectedScope).toEqual({
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });

    client.entryAnswers.push(remoteView([mutation(3)], '2'));
    await store.getState().select(item(7).entryId);
    expect(store.getState().selectedScope).toBeNull();
    expect(client.entryReads).toEqual([{ entryId: item(7).entryId }]);
    expect(store.getState().remoteDetail.status).toBe('ready');
    expect(store.getState().actors[ACTOR.actorId]?.displayName).toBe('Ada');

    client.entryAnswers.push(remoteView([mutation(2)], null));
    await store.getState().loadMoreRemoteHistory();
    expect(client.entryReads[1]).toEqual({
      entryId: item(7).entryId,
      historyCursor: '2',
    });
    expect(
      store
        .getState()
        .remoteDetail.view?.entry.history?.mutations.map(
          (each) => each.revision,
        ),
    ).toEqual([3, 2]);
  });

  it('keeps where a remote entry came from while the list changes', async () => {
    const store = createLedgerFeedStore(client);
    client.answers.push(page([teammateRow(7)]));
    await store.getState().setAudience('teammates');
    client.entryAnswers.push(remoteView([], null));
    await store.getState().select(item(7).entryId);

    // A search that leaves the row out keeps its detail, and who wrote it.
    store.getState().setQueryText('release');
    client.answers.push(page([]));
    await store.getState().load();
    expect(store.getState().selectedEntryId).toBe(item(7).entryId);
    expect(store.getState().remoteDetail.origin).toEqual(teammateRow(7).origin);

    client.entryAnswers.push(remoteView([], null));
    await store.getState().reloadRemoteDetail();
    expect(store.getState().remoteDetail.origin).toEqual(teammateRow(7).origin);
  });

  it('lets go of a selection the new audience leaves out', async () => {
    const store = createLedgerFeedStore(client);
    const all = [localRow(1), remoteRow(2), teammateRow(3)];
    client.answers.push(page(all));
    await store.getState().setAudience('teammates');

    // A teammate's entry is only among Teammates.
    client.entryAnswers.push(remoteView([], null));
    await store.getState().select(item(3).entryId);
    client.answers.push(page([localRow(1), remoteRow(2)]));
    await store.getState().setAudience('mine');
    expect(store.getState()).toEqual(
      expect.objectContaining({ selectedEntryId: null, selectedScope: null }),
    );
    expect(store.getState().remoteDetail.status).toBe('idle');

    // Another device's entry is among Mine and Teammates, not This device.
    client.entryAnswers.push(remoteView([], null));
    await store.getState().select(item(2).entryId);
    client.answers.push(page(all));
    await store.getState().setAudience('teammates');
    expect(store.getState().selectedEntryId).toBe(item(2).entryId);
    client.answers.push(page([localRow(1)]));
    await store.getState().setAudience('this_device');
    expect(store.getState().selectedEntryId).toBeNull();
    expect(store.getState().remoteDetail.status).toBe('idle');

    // This device's entries are in every audience.
    await store.getState().select(item(1).entryId);
    client.answers.push(page([localRow(1), remoteRow(2)]));
    await store.getState().setAudience('mine');
    expect(store.getState()).toEqual(
      expect.objectContaining({
        selectedEntryId: item(1).entryId,
        selectedScope: { projectId: 'project-1', worktreeId: 'wt-1' },
      }),
    );
  });

  it('drops a response a newer read superseded', async () => {
    const store = createLedgerFeedStore(client);
    const slow = deferred<LedgerViewResult<LedgerFeedPage>>();
    client.answers.push(slow.promise, page([remoteRow(2)]));

    const first = store.getState().load();
    await store.getState().setAudience('teammates');
    slow.resolve(page([localRow(1)]));
    await first;

    expect(titles(store.getState().list.rows)).toEqual(['Entry 2']);
  });

  it('starts over on reset', async () => {
    const store = createLedgerFeedStore(client);
    client.answers.push(page([localRow(1)]));
    await store.getState().load();
    expect(store.getState().list.generation).toBe(1);

    store.getState().reset();

    expect(store.getState().list.status).toBe('idle');
    expect(store.getState().list.generation).toBe(1);
    expect(store.getState().list.rows).toEqual([]);
    expect(store.getState().actors).toEqual({});
  });

  it("forgets the previous account's search, audience and filters on reset", async () => {
    const store = createLedgerFeedStore(client);
    client.answers.push(page([]), page([]));
    await store.getState().setAudience('teammates');
    await store.getState().setFilters({
      ...DEFAULT_LEDGER_FEED_FILTERS,
      types: ['TASK'],
    });
    store.getState().setQueryText('quarterly plan');

    store.getState().reset();

    expect(store.getState()).toEqual(
      expect.objectContaining({
        audience: 'mine',
        queryText: '',
        filters: DEFAULT_LEDGER_FEED_FILTERS,
      }),
    );
  });

  it('shows a scope of this device with no row selected, for a new entry', async () => {
    const store = createLedgerFeedStore(client);
    client.answers.push(page([localRow(1)]));
    await store.getState().load();
    await store.getState().select(item(1).entryId);

    store.getState().focusScope({ projectId: 'project-2', worktreeId: 'wt-2' });

    expect(store.getState()).toEqual(
      expect.objectContaining({
        selectedEntryId: null,
        selectedScope: { projectId: 'project-2', worktreeId: 'wt-2' },
      }),
    );
  });
});

describe('the Feed new entry', () => {
  /** A Feed whose drafts are numbered, so tests can name them. */
  function feedStore(
    client: FakeFeedClient = new FakeFeedClient(),
  ): ReturnType<typeof createLedgerFeedStore> {
    let drafts = 0;
    return createLedgerFeedStore(client, {
      newDraftId: () => `feed-draft-${String(++drafts)}`,
    });
  }
  const WT1: LedgerViewScope = { projectId: 'project-1', worktreeId: 'wt-1' };
  const WT2: LedgerViewScope = { projectId: 'project-1', worktreeId: 'wt-2' };
  const OTHER: LedgerViewScope = { projectId: 'project-2', worktreeId: 'wt-3' };
  const CHAT_OWNER: LedgerOwnerCandidate = {
    actor: {
      actorId: '00000000-0000-4000-8000-0000000000a2',
      kind: 'chat',
      authorityId: 'authority-1',
    },
    displayName: 'Parser fixes',
    eligibilityToken: 'token-chat',
    isSelf: false,
  };

  /** This device's scope views, as the host keeps them. */
  function scopeViews(): {
    readonly viewFor: (scope: LedgerViewScope) => LedgerViewStore;
    readonly addAnswer: { current: LedgerViewResult<LedgerViewReceipt> };
  } {
    const addAnswer: { current: LedgerViewResult<LedgerViewReceipt> } = {
      current: { status: 'error', reason: 'UNKNOWN', message: 'Lost' },
    };
    const viewClient: LedgerClient = {
      searchEntries: () =>
        Promise.resolve({
          status: 'ok',
          value: {
            entries: [],
            nextCursor: null,
            hasMore: false,
            watermark: '1',
          },
        }),
      getEntry: () =>
        Promise.resolve({ status: 'unavailable', reason: 'LEDGER_DISABLED' }),
      addEntry: () => Promise.resolve(addAnswer.current),
      updateEntry: () =>
        Promise.resolve({ status: 'error', reason: 'UNKNOWN', message: '' }),
      listOwners: () =>
        Promise.resolve({
          status: 'ok',
          value: { candidates: [], nextCursor: null },
        }),
      subscribeChanges: () => (): void => undefined,
    };
    const views = new Map<string, LedgerViewStore>();
    let keys = 0;
    return {
      addAnswer,
      viewFor: (scope): LedgerViewStore => {
        const key = `${scope.projectId}/${scope.worktreeId}`;
        const existing = views.get(key);
        if (existing !== undefined) return existing;
        const created = createLedgerViewStore(viewClient, scope, {
          newRequestKey: () => `key-${String(++keys)}`,
        });
        views.set(key, created);
        return created;
      },
    };
  }

  it('opens a blank draft with nothing chosen, and keeps it while set aside', async () => {
    const store = feedStore();
    const { viewFor } = scopeViews();

    store.getState().startEntry(viewFor);
    expect(store.getState().composer).toEqual({
      shown: true,
      projectId: null,
      scope: null,
      draft: blankLedgerViewDraft('TASK'),
      draftId: 'feed-draft-1',
    });
    store.getState().updateDraft({ title: 'Ship it', type: 'DECISION' });
    expect(store.getState().composer.draft).toMatchObject({
      title: 'Ship it',
      type: 'DECISION',
      status: 'INFO',
    });

    // Going back to the list sets it aside; adding again shows it as it was.
    await store.getState().select(null);
    expect(store.getState().composer.shown).toBe(false);
    store.getState().startEntry(viewFor);
    expect(store.getState().composer).toMatchObject({
      shown: true,
      draft: { title: 'Ship it' },
    });

    store.getState().closeEntry();
    expect(store.getState().composer).toEqual({
      shown: false,
      projectId: null,
      scope: null,
      draft: null,
      draftId: null,
    });
  });

  it('keeps a shown draft only when selection asks to keep it', async () => {
    const client = new FakeFeedClient();
    const store = feedStore(client);
    const { viewFor } = scopeViews();
    store.getState().startEntry(viewFor);
    client.answers.push(page([localRow(1)]));
    await store.getState().load();

    await store.getState().select(item(1).entryId, { keepDraft: true });
    expect(store.getState().composer.shown).toBe(true);

    store.getState().startEntry(viewFor);
    await store.getState().select(item(1).entryId);
    expect(store.getState().composer).toMatchObject({
      shown: false,
      draft: { type: 'TASK' },
    });
  });

  it('moves the draft to the chosen task, and between tasks, keeping what was written', () => {
    const store = feedStore();
    const { viewFor } = scopeViews();
    store.getState().startEntry(viewFor);
    store.getState().updateDraft({ title: 'Ship it', content: 'Today.' });

    expect(store.getState().chooseProject('project-1', viewFor)).toBe(true);
    expect(store.getState().composer).toMatchObject({
      projectId: 'project-1',
      scope: null,
      draft: { title: 'Ship it' },
    });

    expect(store.getState().chooseTask(WT1, viewFor)).toBe(true);
    // The task's own view holds the draft from now on.
    expect(store.getState().composer).toEqual({
      shown: true,
      projectId: 'project-1',
      scope: WT1,
      draft: null,
      draftId: 'feed-draft-1',
    });
    expect(viewFor(WT1).getState().composer.adoptedId).toBe('feed-draft-1');
    expect(viewFor(WT1).getState().composer).toMatchObject({
      shown: true,
      draft: { title: 'Ship it', content: 'Today.', owner: null },
    });

    // An owner of one task does not follow the draft to another.
    viewFor(WT1).getState().updateDraft({ owner: CHAT_OWNER });
    expect(store.getState().chooseTask(WT2, viewFor)).toBe(true);
    expect(viewFor(WT1).getState().composer.draft).toBeNull();
    expect(viewFor(WT2).getState().composer.draft).toMatchObject({
      title: 'Ship it',
      owner: null,
    });

    // Another project lets go of the task; the draft comes back to the Feed.
    expect(store.getState().chooseProject('project-2', viewFor)).toBe(true);
    expect(viewFor(WT2).getState().composer.draft).toBeNull();
    expect(store.getState().composer).toMatchObject({
      projectId: 'project-2',
      scope: null,
      draft: { title: 'Ship it', content: 'Today.', owner: null },
    });
  });

  it('does not let a correction draft block choosing its task for a new entry', () => {
    const store = feedStore();
    const { viewFor } = scopeViews();
    const correctedEntryId = item(9).entryId;
    viewFor(WT1).getState().startCorrection({
      entryId: correctedEntryId,
      title: 'Entry 9',
      type: 'TASK',
    });
    store.getState().startEntry(viewFor);
    store.getState().updateDraft({ title: 'Feed draft' });
    store.getState().chooseProject('project-1', viewFor);

    expect(store.getState().chooseTask(WT1, viewFor)).toBe(true);
    expect(store.getState().composer.scope).toEqual(WT1);
    expect(
      viewFor(WT1).getState().corrections[correctedEntryId]?.draft,
    ).toMatchObject({
      title: 'Entry 9',
      supersedes: { entryId: correctedEntryId },
    });
    expect(viewFor(WT1).getState().composer.draft?.title).toBe('Feed draft');
  });

  it("keeps reference files within a project, and drops them in another project's tasks", () => {
    const store = feedStore();
    const { viewFor } = scopeViews();
    const files = [{ rootId: 'repo-1', path: 'src/parser.ts' }];
    store.getState().startEntry(viewFor);
    store.getState().chooseProject('project-1', viewFor);
    store.getState().chooseTask(WT1, viewFor);
    viewFor(WT1)
      .getState()
      .updateDraft({ title: 'Ship it', referenceFiles: files });

    // The project's tasks share its repositories.
    store.getState().chooseTask(WT2, viewFor);
    expect(viewFor(WT2).getState().composer.draft?.referenceFiles).toEqual(
      files,
    );

    // Another project's are not these, whichever way the draft gets there.
    store.getState().chooseTask(OTHER, viewFor);
    expect(viewFor(OTHER).getState().composer.draft).toMatchObject({
      title: 'Ship it',
      referenceFiles: [],
    });
    viewFor(OTHER).getState().updateDraft({ referenceFiles: files });
    store.getState().chooseProject('project-1', viewFor);
    expect(store.getState().composer.draft).toMatchObject({
      title: 'Ship it',
      referenceFiles: [],
    });
  });

  it("never takes a task's own draft, nor moves one the Ledger may have recorded", async () => {
    const store = feedStore();
    const { viewFor } = scopeViews();
    viewFor(WT1).getState().startEntry();
    viewFor(WT1).getState().updateDraft({ title: 'Its own' });
    store.getState().startEntry(viewFor);
    store.getState().updateDraft({ title: 'Ship it', content: 'Today.' });
    store.getState().chooseProject('project-1', viewFor);

    expect(store.getState().chooseTask(WT1, viewFor)).toBe(false);
    expect(store.getState().composer).toMatchObject({
      scope: null,
      draft: { title: 'Ship it' },
    });
    expect(viewFor(WT1).getState().composer.draft?.title).toBe('Its own');

    expect(store.getState().chooseTask(WT2, viewFor)).toBe(true);
    // A save whose answer was lost: the entry may be recorded in this task.
    await viewFor(WT2).getState().submitDraft();
    expect(viewFor(WT2).getState().composer.unconfirmed).toHaveLength(1);

    expect(store.getState().chooseTask(OTHER, viewFor)).toBe(false);
    expect(store.getState().chooseProject('project-2', viewFor)).toBe(false);
    expect(store.getState().composer).toMatchObject({
      projectId: 'project-1',
      scope: WT2,
    });
    expect(viewFor(WT2).getState().composer.draft?.title).toBe('Ship it');
  });

  it('starts again, in the same project, once its task saved or dropped the draft', () => {
    const store = feedStore();
    const { viewFor } = scopeViews();
    store.getState().startEntry(viewFor);
    store.getState().updateDraft({ title: 'Ship it' });
    store.getState().chooseProject('project-1', viewFor);
    store.getState().chooseTask(WT1, viewFor);
    store.getState().hideEntry();

    // Discarded from the task's own panel meanwhile.
    viewFor(WT1).getState().discardDraft();
    store.getState().startEntry(viewFor);

    expect(store.getState().composer).toEqual({
      shown: true,
      projectId: 'project-1',
      scope: null,
      draft: blankLedgerViewDraft('TASK'),
      draftId: 'feed-draft-2',
    });
  });

  it("never continues a task's own draft in place of the one it moved there", () => {
    const store = feedStore();
    const { viewFor } = scopeViews();
    store.getState().startEntry(viewFor);
    store.getState().updateDraft({ title: 'Ship it' });
    store.getState().chooseProject('project-1', viewFor);
    store.getState().chooseTask(WT1, viewFor);
    store.getState().hideEntry();
    // The task's panel discards the moved draft and starts its own.
    viewFor(WT1).getState().discardDraft();
    viewFor(WT1).getState().startEntry();
    viewFor(WT1).getState().updateDraft({ title: 'Its own' });

    store.getState().startEntry(viewFor);

    expect(store.getState().composer).toMatchObject({
      shown: true,
      projectId: 'project-1',
      scope: null,
      draft: blankLedgerViewDraft('TASK'),
    });
    expect(viewFor(WT1).getState().composer).toMatchObject({
      shown: true,
      draft: { title: 'Its own' },
    });
  });

  it('shows the draft again in its task when continued', () => {
    const store = feedStore();
    const { viewFor } = scopeViews();
    store.getState().startEntry(viewFor);
    store.getState().chooseProject('project-1', viewFor);
    store.getState().chooseTask(WT1, viewFor);
    store.getState().hideEntry();
    // Choosing one of the task's entries set its draft aside.
    void viewFor(WT1).getState().select(null);
    expect(viewFor(WT1).getState().composer.shown).toBe(false);

    store.getState().startEntry(viewFor);

    expect(store.getState().composer).toMatchObject({
      shown: true,
      scope: WT1,
    });
    expect(viewFor(WT1).getState().composer.shown).toBe(true);
  });

  it('forgets the new entry on reset', () => {
    const store = feedStore();
    const { viewFor } = scopeViews();
    store.getState().startEntry(viewFor);
    store.getState().chooseProject('project-1', viewFor);

    store.getState().reset();

    expect(store.getState().composer).toEqual({
      shown: false,
      projectId: null,
      scope: null,
      draft: null,
      draftId: null,
    });
  });
});
