import type {
  LedgerActorRef,
  LedgerContainer,
  LedgerEntriesSearchParams,
  LedgerEntriesSearchResult,
  LedgerEntrySearchItem,
  LedgerGlobalOwner,
} from '@canopy/protocol/canopy-core';
import type {
  LedgerMirrorAudience,
  LedgerMirrorEntry,
  LedgerMirrorEntryResponse,
  LedgerMirrorSearchRequest,
  LedgerMirrorSearchResponse,
  LedgerMirrorSource,
} from '@canopy/protocol/ledger-sync';
import {
  ledgerViewScopeKey,
  type LedgerFeedFilters,
  type LedgerFeedPage,
  type LedgerFeedRequest,
  type LedgerViewResult,
  type LedgerViewScope,
} from '@canopy/protocol/ledger-view';
import type {
  LedgerMirrorReadResult,
  LedgerMirrorReader,
} from '../feed-client';
import {
  LEDGER_FEED_CACHE_TTL_MS,
  LedgerFeedService,
  type LedgerFeedAccount,
  type LedgerFeedLocalScope,
  type LedgerFeedScopeIncarnation,
} from '../feed-service';

const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000c1';
const OTHER_ACCOUNT_ID = '00000000-0000-4000-8000-0000000000c2';
const START_MS = Date.parse('2026-10-02T12:00:00.000Z');
const ACTOR: LedgerActorRef = {
  actorId: '00000000-0000-4000-8000-0000000000a1',
  kind: 'user',
  authorityId: 'authority-1',
};
const OTHER_DEVICE: LedgerMirrorSource = {
  kind: 'mine',
  deviceId: 'device-2',
  deviceLabel: 'Studio Mac',
};
const TEAMMATE: LedgerMirrorSource = {
  kind: 'teammate',
  teammateName: 'Ada',
  organizationId: '00000000-0000-4000-8000-0000000000b1',
  organizationName: 'Acme',
};

const FILTERS: LedgerFeedFilters = {
  types: [],
  statuses: [],
  owner: 'anyone',
  author: 'anyone',
  period: 'any',
  includeArchived: false,
};

const DETAILS = {
  harness: null,
  model: null,
  thinkingEffort: null,
  mode: null,
  pipelineExecutionId: null,
  settingsRevision: null,
  unavailableReason: 'not_applicable',
} as const;

let nextEntry = 1;

/** An entry last changed `minutes` after the start of the day. */
function item(minutes: number): LedgerEntrySearchItem {
  const id = nextEntry;
  nextEntry += 1;
  const time = new Date(START_MS - 24 * 60 * 60 * 1000 + minutes * 60_000);
  return {
    entryId: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    revision: 1,
    type: 'TASK',
    title: `Entry ${String(id)}`,
    content: 'Write the plan.',
    highlights: [],
    referenceFiles: [],
    status: 'TODO',
    owner: ACTOR,
    author: ACTOR,
    attributionKind: 'self_reported',
    createdAt: time.toISOString(),
    updatedAt: time.toISOString(),
    sourceAvailability: 'available',
  };
}

function worktree(id: string): LedgerContainer {
  return { kind: 'code_worktree', workspaceId: 'workspace-1', worktreeId: id };
}

function viewScope(
  container: LedgerContainer,
  ledgerId: string,
): LedgerViewScope {
  switch (container.kind) {
    case 'advisor_entry':
      return {
        projectId: container.appWorkspaceId,
        worktreeId: container.entryId,
      };
    case 'global':
      return { kind: 'global', owner: container.owner, ledgerId };
    case 'code_worktree':
      return {
        projectId: container.workspaceId,
        worktreeId: container.worktreeId,
      };
    case 'cowork_entry':
      return {
        projectId: container.workspaceId,
        worktreeId: container.entryId,
      };
  }
}

function newestFirst(
  left: LedgerEntrySearchItem,
  right: LedgerEntrySearchItem,
): number {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt < right.updatedAt ? 1 : -1;
  }
  return left.entryId < right.entryId ? 1 : -1;
}

interface LocalScope {
  readonly scope: LedgerFeedLocalScope;
  readonly entries: LedgerEntrySearchItem[];
}

/** This device's scopes, searched a page at a time like the dispatcher. */
class FakeLocalLedger {
  readonly scopes: LocalScope[] = [];
  readonly searches: Array<{ worktreeId: string; cursor?: string }> = [];

  /** A global (workflow) Ledger of this device. */
  addGlobal(
    id: string,
    owner: LedgerGlobalOwner,
    entries: LedgerEntrySearchItem[],
    options: { accountId?: string | null } = {},
  ): string {
    const ledgerId = `00000000-0000-4000-8000-${id.padStart(12, 'f')}`;
    this.scopes.push({
      scope: {
        ledgerId,
        accountId:
          options.accountId === undefined ? ACCOUNT_ID : options.accountId,
        container: { kind: 'global', owner },
        containerCreatedAt: `2026-09-01T00:00:0${String(this.scopes.length)}.000Z`,
        archived: false,
      },
      entries: [...entries].sort(newestFirst),
    });
    return ledgerId;
  }
  readonly incarnations: LedgerFeedScopeIncarnation[] = [];
  failNext: LedgerViewResult<never> | null = null;

  add(
    id: string,
    entries: LedgerEntrySearchItem[],
    options: { accountId?: string | null; archived?: boolean } = {},
  ): string {
    const ledgerId = `00000000-0000-4000-8000-${id.padStart(12, 'e')}`;
    this.scopes.push({
      scope: {
        ledgerId,
        accountId:
          options.accountId === undefined ? ACCOUNT_ID : options.accountId,
        container: worktree(id),
        containerCreatedAt: `2026-09-01T00:00:0${String(this.scopes.length)}.000Z`,
        archived: options.archived ?? false,
      },
      entries: [...entries].sort(newestFirst),
    });
    return ledgerId;
  }

  readonly search = (
    scope: LedgerViewScope,
    params: LedgerEntriesSearchParams,
    incarnation: LedgerFeedScopeIncarnation,
  ): Promise<LedgerViewResult<LedgerEntriesSearchResult>> => {
    this.incarnations.push(incarnation);
    this.searches.push({
      worktreeId: 'kind' in scope ? scope.ledgerId : scope.worktreeId,
      ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
    });
    if (this.failNext !== null) {
      const failure = this.failNext;
      this.failNext = null;
      return Promise.resolve(failure);
    }
    const local = this.scopes.find(
      (candidate) =>
        ledgerViewScopeKey(
          viewScope(candidate.scope.container, candidate.scope.ledgerId),
        ) === ledgerViewScopeKey(scope),
    );
    if (local === undefined) {
      return Promise.resolve({ status: 'unavailable', reason: 'no_scope' });
    }
    const offset =
      params.cursor === undefined ? 0 : Number(params.cursor.split(':')[1]);
    const limit = params.limit ?? 30;
    const entries = local.entries.slice(offset, offset + limit);
    const hasMore = offset + limit < local.entries.length;
    return Promise.resolve({
      status: 'ok',
      value: {
        entries,
        nextCursor: hasMore ? `local:${String(offset + limit)}` : null,
        hasMore,
        watermark: '1',
        actors: [{ actorId: ACTOR.actorId, kind: 'user', displayName: 'You' }],
      },
    });
  };
}

function mirrorEntry(
  entry: LedgerEntrySearchItem,
  source: LedgerMirrorSource,
  ledgerId = '00000000-0000-4000-8000-dddddddddddd',
): LedgerMirrorEntry {
  return {
    ...entry,
    ledgerId,
    scopeKind: 'code_worktree',
    scopeArchived: false,
    source,
  };
}

/** The cloud mirror's read API, with each audience's rows. */
class FakeMirror implements LedgerMirrorReader {
  readonly rows: { [Audience in LedgerMirrorAudience]: LedgerMirrorEntry[] } = {
    mine: [],
    teammates: [],
  };
  readonly requests: LedgerMirrorSearchRequest[] = [];
  /** The account whose credentials are current. */
  signedIn = ACCOUNT_ID;
  /** What another account's own search returns. */
  readonly otherAccountRows: LedgerMirrorEntry[] = [];
  /** Runs while a read is on its way, after it was sent. */
  duringRead: (() => void) | null = null;
  unavailable = false;

  search(
    request: LedgerMirrorSearchRequest,
    accountId?: string,
  ): Promise<LedgerMirrorReadResult<LedgerMirrorSearchResponse>> {
    this.requests.push(request);
    // A read pinned to an account refuses another's credentials; an
    // unpinned one answers as whoever is signed in.
    if (accountId !== undefined && accountId !== this.signedIn) {
      return Promise.resolve({ ok: false, failure: 'account_changed' });
    }
    if (this.unavailable) {
      return Promise.resolve({ ok: false, failure: 'unavailable' });
    }
    const audience = request.audience ?? 'mine';
    // The reply is the account the read was sent as, whatever signs in next.
    const sentAs = this.signedIn;
    this.duringRead?.();
    const rows =
      sentAs === ACCOUNT_ID ? this.rows[audience] : this.otherAccountRows;
    const all = [...rows].sort(newestFirst);
    const offset =
      request.cursor === undefined ? 0 : Number(request.cursor.split(':')[2]);
    const limit = request.limit ?? 30;
    const entries = all.slice(offset, offset + limit);
    const hasMore = offset + limit < all.length;
    return Promise.resolve({
      ok: true,
      value: {
        entries,
        actors: [],
        nextCursor: hasMore
          ? `mirror:${audience}:${String(offset + limit)}`
          : null,
        hasMore,
      },
    });
  }

  getEntry(
    entryId: string,
    _options: { readonly beforeRevision?: number },
    accountId?: string,
  ): Promise<LedgerMirrorReadResult<LedgerMirrorEntryResponse>> {
    if (accountId !== undefined && accountId !== this.signedIn) {
      return Promise.resolve({ ok: false, failure: 'account_changed' });
    }
    this.duringRead?.();
    const found = [...this.rows.mine, ...this.rows.teammates].find(
      (row) => row.entryId === entryId,
    );
    if (found === undefined) {
      return Promise.resolve({ ok: false, failure: 'not_found' });
    }
    return Promise.resolve({
      ok: true,
      value: {
        entry: {
          schemaVersion: 1,
          entryId: found.entryId,
          scope: {
            ledgerId: found.ledgerId,
            authorityId: 'authority-2',
            container: worktree('remote'),
          },
          createdAt: found.createdAt,
          updatedAt: found.updatedAt,
          revision: found.revision,
          author: found.author,
          authorDetails: DETAILS,
          owner: found.owner,
          type: found.type,
          title: found.title,
          content: found.content,
          highlights: [],
          referenceFiles: [],
          status: found.status,
          origin: {
            kind: 'user',
            ledgerId: found.ledgerId,
            userActorId: found.author.actorId,
          },
          attribution: {
            kind: 'self_reported',
            effectiveActor: found.author,
            recordedBy: found.author,
            executorDetails: DETAILS,
          },
        },
        ledgerId: found.ledgerId,
        scopeKind: 'code_worktree',
        scopeArchived: false,
        source: found.source,
        sourceAvailability: 'not_on_this_device',
        history: { mutations: [], nextBeforeRevision: null },
        actors: [
          {
            ledgerId: found.ledgerId,
            actorId: found.author.actorId,
            kind: 'user',
            displayName: 'Ada',
          },
        ],
      },
    });
  }
}

interface Harness {
  readonly local: FakeLocalLedger;
  readonly mirror: FakeMirror;
  account: LedgerFeedAccount;
  now: number;
  readonly service: LedgerFeedService;
  search(
    request?: Partial<LedgerFeedRequest>,
  ): Promise<LedgerViewResult<LedgerFeedPage>>;
  /** Every page of a search, following its cursors. */
  searchAll(request?: Partial<LedgerFeedRequest>): Promise<LedgerFeedPage[]>;
}

function createHarness(): Harness {
  const local = new FakeLocalLedger();
  const mirror = new FakeMirror();
  let sessions = 0;
  const harness: Harness = {
    local,
    mirror,
    account: { kind: 'signed_in', accountId: ACCOUNT_ID },
    now: START_MS,
    service: new LedgerFeedService({
      readAccount: () => Promise.resolve(harness.account),
      listScopes: () =>
        Promise.resolve(local.scopes.map((scope) => scope.scope)),
      viewScope,
      mirror,
      now: () => harness.now,
      newSessionId: (): string => {
        sessions += 1;
        return `session-${String(sessions)}`;
      },
    }),
    search: (request = {}) =>
      harness.service.search(
        { audience: 'mine', query: '', filters: FILTERS, ...request },
        { searchScope: local.search },
      ),
    async searchAll(request = {}): Promise<LedgerFeedPage[]> {
      const pages: LedgerFeedPage[] = [];
      let cursor: string | undefined;
      do {
        const result = await harness.search({
          ...request,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (result.status !== 'ok') throw new Error('Expected a page');
        pages.push(result.value);
        cursor = result.value.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return pages;
    },
  };
  return harness;
}

function titles(page: LedgerFeedPage): string[] {
  return page.rows.map((row) => row.entry.title);
}

function okPage(result: LedgerViewResult<LedgerFeedPage>): LedgerFeedPage {
  if (result.status !== 'ok')
    throw new Error(`Expected a page: ${result.status}`);
  return result.value;
}

describe('LedgerFeedService', () => {
  let harness: Harness;

  beforeEach(() => {
    nextEntry = 1;
    harness = createHarness();
  });

  describe('Mine, Teammates and This device (LD03)', () => {
    it("merges this device's scopes with the account's other devices, newest change first", async () => {
      const [first, second, third] = [item(50), item(30), item(10)];
      if (first === undefined || second === undefined || third === undefined) {
        throw new Error('Expected entries');
      }
      const ledgerId = harness.local.add('wt-1', [first, second, third]);
      const [remoteNewer, remoteOlder, mirroredHere] = [
        item(40),
        item(20),
        item(60),
      ];
      if (
        remoteNewer === undefined ||
        remoteOlder === undefined ||
        mirroredHere === undefined
      ) {
        throw new Error('Expected entries');
      }
      harness.mirror.rows.mine.push(
        mirrorEntry(remoteNewer, OTHER_DEVICE),
        mirrorEntry(remoteOlder, OTHER_DEVICE),
        // This device's own scope, as the mirror holds it: the local row wins.
        mirrorEntry(mirroredHere, OTHER_DEVICE, ledgerId),
      );

      const page = okPage(await harness.search());

      expect(titles(page)).toEqual([
        first.title,
        remoteNewer.title,
        second.title,
        remoteOlder.title,
        third.title,
      ]);
      expect(page.rows[0]?.origin).toEqual({
        kind: 'this_device',
        scope: { projectId: 'workspace-1', worktreeId: 'wt-1' },
      });
      expect(page.rows[1]?.origin).toEqual({
        kind: 'other_device',
        deviceLabel: 'Studio Mac',
      });
      expect(page.notice).toBeNull();
      expect(page.hasMore).toBe(false);
      expect(harness.mirror.requests).toEqual([
        expect.objectContaining({ audience: 'mine', sort: 'updated_desc' }),
      ]);
    });

    it("adds teammates' entries only with Teammates, and reads nothing remote for This device", async () => {
      const mine = item(30);
      const teammate = item(20);
      const own = item(10);
      harness.local.add('wt-1', [own]);
      harness.mirror.rows.mine.push(mirrorEntry(mine, OTHER_DEVICE));
      harness.mirror.rows.teammates.push(mirrorEntry(teammate, TEAMMATE));

      expect(titles(okPage(await harness.search()))).toEqual([
        mine.title,
        own.title,
      ]);
      const teammates = okPage(await harness.search({ audience: 'teammates' }));
      expect(titles(teammates)).toEqual([
        mine.title,
        teammate.title,
        own.title,
      ]);
      expect(teammates.rows[1]?.origin).toEqual({
        kind: 'teammate',
        teammateName: 'Ada',
        organizationName: 'Acme',
      });

      harness.mirror.requests.length = 0;
      const device = okPage(await harness.search({ audience: 'this_device' }));
      expect(titles(device)).toEqual([own.title]);
      expect(harness.mirror.requests).toEqual([]);
    });

    it('merges global (workflow) rows, labeled by owner, without duplicates', async () => {
      const ORG_ID = '00000000-0000-4000-8000-0000000000b1';
      const own = item(50);
      const mirroredHere = item(60);
      const teammate = item(40);
      const otherAccount = item(30);
      const ledgerId = harness.local.addGlobal('g-1', { kind: 'personal' }, [
        own,
      ]);
      // Another account's global Ledger on this installation stays its own.
      harness.local.addGlobal('g-2', { kind: 'personal' }, [otherAccount], {
        accountId: OTHER_ACCOUNT_ID,
      });
      harness.mirror.rows.mine.push({
        // This device's own global entry, as the mirror holds it.
        ...mirrorEntry(mirroredHere, OTHER_DEVICE, ledgerId),
        scopeKind: 'global',
        globalOwner: { kind: 'personal' },
      });
      harness.mirror.rows.teammates.push({
        ...mirrorEntry(
          teammate,
          TEAMMATE,
          '00000000-0000-4000-8000-ffffffffff99',
        ),
        scopeKind: 'global',
        globalOwner: { kind: 'organization', organizationId: ORG_ID },
        organizationName: 'Acme',
      });

      const page = okPage(await harness.search({ audience: 'teammates' }));

      expect(titles(page)).toEqual([own.title, teammate.title]);
      expect(page.rows[0]).toMatchObject({
        ledgerId,
        scopeKind: 'global',
        origin: {
          kind: 'this_device',
          scope: { kind: 'global', owner: { kind: 'personal' }, ledgerId },
        },
      });
      expect(page.rows[1]).toMatchObject({
        scopeKind: 'global',
        origin: { kind: 'teammate', teammateName: 'Ada' },
        global: {
          owner: { kind: 'organization', organizationId: ORG_ID },
          organizationName: 'Acme',
        },
      });
    });

    it('passes the same filters to every stream', async () => {
      harness.local.add('wt-1', [item(10)]);

      await harness.search({
        query: '  parser  ',
        filters: {
          ...FILTERS,
          types: ['DECISION'],
          statuses: ['BLOCKED'],
          owner: 'you',
          author: 'you',
          period: 'week',
          includeArchived: true,
        },
      });

      const expected = {
        query: 'parser',
        types: ['DECISION'],
        statuses: ['BLOCKED'],
        owner: 'self',
        author: 'self',
        updatedAfter: new Date(
          START_MS - 7 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        sort: 'updated_desc',
        limit: 30,
      };
      expect(harness.mirror.requests).toEqual([
        { ...expected, includeArchived: true, audience: 'mine' },
      ]);
    });
  });

  describe('paging (T07)', () => {
    it('pages through every stream without dropping or repeating an entry', async () => {
      const entries = Array.from({ length: 65 }, (_, index) => item(index));
      harness.local.add(
        'wt-1',
        entries.filter((_, index) => index % 3 === 0),
      );
      harness.local.add(
        'wt-2',
        entries.filter((_, index) => index % 3 === 1),
      );
      harness.mirror.rows.mine.push(
        ...entries
          .filter((_, index) => index % 3 === 2)
          .map((entry) => mirrorEntry(entry, OTHER_DEVICE)),
      );

      const pages = await harness.searchAll();

      expect(pages.map((page) => page.rows.length)).toEqual([30, 30, 5]);
      expect(pages.flatMap(titles)).toEqual(
        [...entries].sort(newestFirst).map((entry) => entry.title),
      );
    });

    it('serves a retried page again, and refuses a page out of turn', async () => {
      harness.local.add(
        'wt-1',
        Array.from({ length: 40 }, (_, index) => item(index)),
      );
      const first = okPage(await harness.search());
      const cursor = first.nextCursor;
      if (cursor === null) throw new Error('Expected a cursor');

      const second = okPage(await harness.search({ cursor }));
      expect(okPage(await harness.search({ cursor }))).toEqual(second);
      expect(
        await harness.search({ cursor: cursor.replace(/:2$/, ':5') }),
      ).toEqual(
        expect.objectContaining({ status: 'error', reason: 'CURSOR_EXPIRED' }),
      );
    });

    it('serves a page that failed partway through whole when it is retried', async () => {
      // Scope A is newer than scope B; page 3 takes B's last buffered rows,
      // then B's next read fails.
      harness.local.add(
        'wt-a',
        Array.from({ length: 35 }, (_, index) => item(200 + index)),
      );
      const older = Array.from({ length: 40 }, (_, index) => item(index));
      harness.local.add('wt-b', older);
      const first = okPage(await harness.search());
      const second = okPage(
        await harness.search({ cursor: first.nextCursor ?? undefined }),
      );
      const cursor = second.nextCursor;
      if (cursor === null) throw new Error('Expected a third page');

      harness.local.failNext = {
        status: 'error',
        reason: 'UNKNOWN',
        message: 'The store is busy.',
      };
      expect(await harness.search({ cursor })).toEqual(
        expect.objectContaining({ status: 'error', reason: 'UNKNOWN' }),
      );
      const third = okPage(await harness.search({ cursor }));

      // Every entry of B that the first two pages did not show, none lost.
      const shown = new Set(
        [...first.rows, ...second.rows].map((row) => row.entry.entryId),
      );
      expect(titles(third)).toEqual(
        [...older]
          .sort(newestFirst)
          .filter((entry) => !shown.has(entry.entryId))
          .map((entry) => entry.title),
      );
    });

    it("refuses a cursor past its lifetime, or another account's", async () => {
      harness.local.add(
        'wt-1',
        Array.from({ length: 40 }, (_, index) => item(index)),
      );
      const cursor = okPage(await harness.search()).nextCursor;
      if (cursor === null) throw new Error('Expected a cursor');

      harness.account = { kind: 'signed_in', accountId: OTHER_ACCOUNT_ID };
      expect(await harness.search({ cursor })).toEqual(
        expect.objectContaining({ status: 'error', reason: 'CURSOR_EXPIRED' }),
      );
      harness.account = { kind: 'signed_in', accountId: ACCOUNT_ID };
      harness.now += 10 * 60_000;
      expect(await harness.search({ cursor })).toEqual(
        expect.objectContaining({ status: 'error', reason: 'CURSOR_EXPIRED' }),
      );
    });

    it("fills a page when the mirror's newest rows are this device's own", async () => {
      // The person's main device: every one of its 3,000 entries is synced,
      // and another device's entry is older than all of them.
      const own = Array.from({ length: 3000 }, (_, index) =>
        item(1000 + index),
      );
      const ledgerId = harness.local.add('wt-1', own);
      harness.mirror.rows.mine.push(
        ...own.map((entry) => mirrorEntry(entry, OTHER_DEVICE, ledgerId)),
        mirrorEntry(item(1), OTHER_DEVICE),
      );

      const first = okPage(await harness.search());

      expect(first.rows).toHaveLength(30);
      expect(first.hasMore).toBe(true);
      // The mirror is read only as far as the page reaches.
      expect(harness.mirror.requests.length).toBeLessThanOrEqual(2);
    });

    it("keeps a list's next page through any number of background looks", async () => {
      harness.local.add(
        'wt-1',
        Array.from({ length: 40 }, (_, index) => item(index)),
      );
      const first = okPage(await harness.search());
      const reads = harness.mirror.requests.length;

      for (let look = 0; look < 30; look += 1) {
        // A look reads the newest page, keeps nothing, and has no cursor.
        const peek = okPage(await harness.search({ peek: true }));
        expect(peek.rows).toHaveLength(30);
        expect(peek.nextCursor).toBeNull();
      }

      expect(harness.mirror.requests).toHaveLength(reads + 30);
      expect(okPage(await harness.search()).nextCursor).toBe(first.nextCursor);
      const second = okPage(
        await harness.search({ cursor: first.nextCursor ?? undefined }),
      );
      expect(second.rows).toHaveLength(10);
    });

    it('ends a scope that went away mid-search and keeps the others', async () => {
      harness.local.add(
        'wt-1',
        Array.from({ length: 35 }, (_, index) => item(100 + index)),
      );
      harness.local.add('wt-2', [item(1)]);
      const first = okPage(await harness.search());
      harness.local.scopes.splice(0, 1);

      const second = okPage(
        await harness.search({ cursor: first.nextCursor ?? undefined }),
      );

      expect(second.rows.map((row) => row.entry.title)).toEqual(['Entry 36']);
      expect(second.hasMore).toBe(false);
    });
  });

  describe('cache', () => {
    it('serves a first page for 30 seconds, and reads again after a local change', async () => {
      harness.local.add('wt-1', [item(1)]);

      await harness.search();
      await harness.search();
      expect(harness.mirror.requests).toHaveLength(1);

      harness.service.invalidate();
      await harness.search();
      expect(harness.mirror.requests).toHaveLength(2);

      harness.now += LEDGER_FEED_CACHE_TTL_MS;
      await harness.search();
      await harness.search({ refresh: true });
      expect(harness.mirror.requests).toHaveLength(4);
    });

    it("reads again once the cached page's search has moved past page 2", async () => {
      harness.local.add(
        'wt-1',
        Array.from({ length: 100 }, (_, index) => item(index)),
      );
      const pages = await harness.searchAll();
      expect(pages).toHaveLength(4);

      // Back to the same query: its cached first page must still lead on.
      const again = okPage(await harness.search());
      const next = okPage(
        await harness.search({ cursor: again.nextCursor ?? undefined }),
      );

      expect(next.rows).toEqual(pages[1]?.rows);
    });

    it('keeps each account to its own cached pages', async () => {
      harness.local.add('wt-1', [item(1)]);
      await harness.search();

      harness.account = { kind: 'signed_in', accountId: OTHER_ACCOUNT_ID };
      harness.mirror.signedIn = OTHER_ACCOUNT_ID;
      const other = okPage(await harness.search());

      expect(other.rows).toEqual([]);
      expect(harness.mirror.requests).toHaveLength(2);
    });
  });

  describe('accounts and the cloud (LD02, T12)', () => {
    it("never shows another account's scopes", async () => {
      harness.local.add('wt-1', [item(2)]);
      harness.local.add('wt-2', [item(1)], { accountId: OTHER_ACCOUNT_ID });
      harness.local.add('wt-3', [item(3)], { accountId: null });

      const page = okPage(await harness.search({ audience: 'this_device' }));

      expect(titles(page)).toEqual(['Entry 1']);
    });

    it("never keeps another account's mirror rows when the account switches mid-search", async () => {
      harness.local.add('wt-1', [item(1)]);
      harness.mirror.rows.mine.push(mirrorEntry(item(2), OTHER_DEVICE));
      harness.mirror.otherAccountRows.push(mirrorEntry(item(3), OTHER_DEVICE));

      // The Feed read account A; B's credentials are current by the read.
      harness.mirror.signedIn = OTHER_ACCOUNT_ID;
      const during = await harness.search();
      expect(during).toEqual(
        expect.objectContaining({ status: 'error', reason: 'CURSOR_EXPIRED' }),
      );

      // Back as A: nothing of B's was kept under A.
      harness.mirror.signedIn = ACCOUNT_ID;
      const after = okPage(await harness.search());
      expect(titles(after)).toEqual(['Entry 2', 'Entry 1']);
    });

    it('drops a reply that arrives after another account signed in', async () => {
      harness.local.add('wt-1', [item(1)]);
      const remote = mirrorEntry(item(2), OTHER_DEVICE);
      harness.mirror.rows.mine.push(remote);
      const signInAsOther = (): void => {
        harness.account = { kind: 'signed_in', accountId: OTHER_ACCOUNT_ID };
        harness.mirror.signedIn = OTHER_ACCOUNT_ID;
      };
      const signInAsFirst = (): void => {
        harness.account = { kind: 'signed_in', accountId: ACCOUNT_ID };
        harness.mirror.signedIn = ACCOUNT_ID;
      };

      // Each read went out as the first account; another signed in before
      // its reply came back.
      harness.mirror.duringRead = signInAsOther;
      expect(await harness.search()).toEqual(
        expect.objectContaining({ status: 'error', reason: 'CURSOR_EXPIRED' }),
      );
      signInAsFirst();
      expect(
        await harness.service.getEntry({ entryId: remote.entryId }),
      ).toEqual(expect.objectContaining({ status: 'error' }));

      // Back as the first account: nothing of those replies was kept.
      harness.mirror.duringRead = null;
      signInAsFirst();
      const reads = harness.mirror.requests.length;
      expect(titles(okPage(await harness.search()))).toEqual([
        'Entry 2',
        'Entry 1',
      ]);
      expect(harness.mirror.requests).toHaveLength(reads + 1);
    });

    it('signed out, shows only work first done signed out, with a notice', async () => {
      harness.local.add('wt-1', [item(2)]);
      harness.local.add('wt-2', [item(1)], { accountId: null });
      harness.account = { kind: 'signed_out' };

      const page = okPage(await harness.search());

      expect(titles(page)).toEqual(['Entry 2']);
      expect(page.notice).toBe('signed_out');
      expect(harness.mirror.requests).toEqual([]);
    });

    it("shows this device's work with a notice when the cloud can't be reached", async () => {
      harness.local.add('wt-1', [item(1)]);
      harness.mirror.unavailable = true;

      const page = okPage(await harness.search());

      expect(titles(page)).toEqual(['Entry 1']);
      expect(page.notice).toBe('remote_unavailable');
    });

    it("leaves archived work out unless it's asked for", async () => {
      harness.local.add('wt-1', [item(1)], { archived: true });
      harness.local.add('wt-2', [item(2)]);

      expect(titles(okPage(await harness.search()))).toEqual(['Entry 2']);
      expect(
        titles(
          okPage(
            await harness.search({
              filters: { ...FILTERS, includeArchived: true },
            }),
          ),
        ),
      ).toEqual(['Entry 2', 'Entry 1']);
      // An archived container is gone from its registry: its scope is read
      // by the incarnation the Ledger store records.
      expect(harness.local.incarnations).toContainEqual({
        container: worktree('wt-1'),
        containerCreatedAt: '2026-09-01T00:00:00.000Z',
      });
    });

    it('refuses to guess when the account cannot be read', async () => {
      harness.local.add('wt-1', [item(1)]);
      harness.account = { kind: 'unknown' };

      expect(await harness.search()).toEqual(
        expect.objectContaining({ status: 'error', reason: 'UNKNOWN' }),
      );
    });

    it("reports a local scope's failure instead of an empty Feed", async () => {
      harness.local.add('wt-1', [item(1)]);
      harness.local.failNext = {
        status: 'error',
        reason: 'STORAGE_UNAVAILABLE',
        message: 'The Feed could not be read.',
      };

      expect(await harness.search()).toEqual(
        expect.objectContaining({
          status: 'error',
          reason: 'STORAGE_UNAVAILABLE',
        }),
      );
    });
  });

  describe('entries of other devices', () => {
    it('reads a remote entry for a read-only detail', async () => {
      const remote = item(1);
      harness.mirror.rows.teammates.push(mirrorEntry(remote, TEAMMATE));

      const result = await harness.service.getEntry({
        entryId: remote.entryId,
      });

      if (result.status !== 'ok') throw new Error('Expected the entry');
      expect(result.value.entry.entry.title).toBe(remote.title);
      expect(result.value.source).toEqual({
        availability: 'not_on_this_device',
        target: null,
      });
      expect(result.value.entry.actors).toEqual([
        { actorId: ACTOR.actorId, kind: 'user', displayName: 'Ada' },
      ]);
    });

    it('says when an entry is not available, or the person is signed out', async () => {
      expect(
        await harness.service.getEntry({ entryId: item(1).entryId }),
      ).toEqual(
        expect.objectContaining({ status: 'error', reason: 'NOT_FOUND' }),
      );
      harness.account = { kind: 'signed_out' };
      expect(
        await harness.service.getEntry({ entryId: item(2).entryId }),
      ).toEqual(
        expect.objectContaining({ status: 'error', reason: 'NOT_FOUND' }),
      );
    });
  });
});
