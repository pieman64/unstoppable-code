import { randomUUID } from 'node:crypto';
import {
  LEDGER_LIMITS,
  LedgerEntriesSearchParamsSchema,
  type LedgerActorLabel,
  type LedgerContainer,
  type LedgerEntriesSearchParams,
  type LedgerEntriesSearchResult,
} from '@canopy/protocol/canopy-core';
import type {
  LedgerMirrorAudience,
  LedgerMirrorSearchRequest,
} from '@canopy/protocol/ledger-sync';
import {
  ledgerActorLabelFromMirror,
  ledgerFeedRowFromMirror,
  ledgerFeedSearchFilters,
  ledgerMirrorHistoryRevision,
  ledgerViewEntryFromMirror,
  type LedgerFeedEntryRequest,
  type LedgerFeedNotice,
  type LedgerFeedPage,
  type LedgerFeedRequest,
  type LedgerFeedRow,
  type LedgerFeedSearchFilters,
  type LedgerViewEntry,
  type LedgerViewResult,
  type LedgerViewScope,
} from '@canopy/protocol/ledger-view';
import type { LedgerMirrorReader } from './feed-client';

/*
 * The global Feed (phase 14, LD03). One search merges disjoint streams, each
 * newest change first:
 * - this device's scopes bound to the signed-in account (signed out, only
 *   those first used signed out), one stream per scope, read through the
 *   dispatcher as the person, exactly as the Ledger panel reads them;
 * - the mirror's search of the account's own scopes on its other devices;
 * - with "Teammates", the mirror's search of teammates' scopes.
 * The mirror's rows of this device's scopes are dropped: the local stream
 * holds them, at their latest revision and with how they sync.
 *
 * Each stream pages through its own snapshot, so the merge never drops or
 * repeats an entry. Its position lives in a session held here, in memory
 * only, which a page's cursor names; nothing remote is ever written to disk.
 * First pages are cached for 30 seconds per account and query, and any local
 * change drops the cache.
 */

/** Rows in one page of the Feed, matching the Ledger's default page. */
export const LEDGER_FEED_PAGE_SIZE = 30;
/** How long a first page is served from the cache. */
export const LEDGER_FEED_CACHE_TTL_MS = 30_000;
/** First pages kept in the cache, across queries and accounts. */
export const LEDGER_FEED_CACHE_MAX = 50;
/** Searches whose next pages can still be read. */
const SESSIONS_MAX = 20;
/** Stream reads one page may make before it settles for what it has. */
const READS_PER_PAGE_MAX = 64;

/** Who the Feed reads for. */
export type LedgerFeedAccount =
  | { readonly kind: 'signed_in'; readonly accountId: string }
  | { readonly kind: 'signed_out' }
  /** The account could not be read: nothing is assumed about it. */
  | { readonly kind: 'unknown' };

/** One of this device's live scopes, as the Feed selects them. */
export interface LedgerFeedLocalScope {
  readonly ledgerId: string;
  /** The account the scope was first used under; null when signed out. */
  readonly accountId: string | null;
  readonly container: LedgerContainer;
  /**
   * The container incarnation's creation time, as the Ledger store records
   * it. An archived container is gone from its registry, so the Feed reads
   * its scope by this incarnation instead.
   */
  readonly containerCreatedAt: string;
  readonly archived: boolean;
}

/** The container incarnation a Feed read of this device's scope binds to. */
export interface LedgerFeedScopeIncarnation {
  readonly container: LedgerContainer;
  readonly containerCreatedAt: string;
}

/** Reads one page of one local scope as the person using the Feed. */
export type LedgerFeedScopeSearch = (
  scope: LedgerViewScope,
  params: LedgerEntriesSearchParams,
  incarnation: LedgerFeedScopeIncarnation,
) => Promise<LedgerViewResult<LedgerEntriesSearchResult>>;

export interface LedgerFeedServiceOptions {
  readonly readAccount: () => Promise<LedgerFeedAccount>;
  /** This device's scopes, retiring ones excluded. */
  readonly listScopes: () => Promise<readonly LedgerFeedLocalScope[]>;
  /** The work scope that shows a ledger. */
  readonly viewScope: (
    container: LedgerContainer,
    ledgerId: string,
  ) => LedgerViewScope;
  readonly mirror: LedgerMirrorReader;
  readonly now?: () => number;
  readonly newSessionId?: () => string;
}

/** What one search request may use, beside the session it continues. */
interface FeedCall {
  readonly searchScope: LedgerFeedScopeSearch;
}

/** Where a row sits in the Feed's order. */
interface SortKey {
  readonly updatedAt: string;
  readonly entryId: string;
}

type StreamRead =
  | {
      readonly kind: 'page';
      readonly rows: readonly LedgerFeedRow[];
      readonly actors: readonly LedgerActorLabel[];
      readonly nextCursor: string | null;
      readonly hasMore: boolean;
      /** The last row the read returned, kept or not. */
      readonly floor: SortKey | null;
    }
  /** The stream's snapshot is gone: the whole search starts over. */
  | { readonly kind: 'expired' }
  /** The stream has nothing more to give, for a reason the page notes. */
  | { readonly kind: 'ended'; readonly notice: LedgerFeedNotice | null }
  | { readonly kind: 'failed'; readonly result: LedgerViewResult<never> };

interface FeedStream {
  /** Fetched rows not yet served, newest change first. */
  buffer: LedgerFeedRow[];
  cursor: string | null;
  exhausted: boolean;
  /**
   * No row the stream has yet to give is newer than this: once it runs dry,
   * it holds back only rows it could still beat. The mirror's rows of this
   * device's scopes are dropped, so a page of them leaves the stream dry.
   */
  floor: SortKey | null;
  readonly read: (cursor: string | null, call: FeedCall) => Promise<StreamRead>;
}

interface FeedSession {
  readonly id: string;
  readonly accountKey: string;
  readonly expiresAt: number;
  readonly streams: readonly FeedStream[];
  readonly actors: Map<string, LedgerActorLabel>;
  notice: LedgerFeedNotice | null;
  /** The number of the page the next request continues with. */
  nextPage: number;
  /** The last page served, for a retry of its request. */
  last: { readonly page: number; readonly value: LedgerFeedPage } | null;
  /** Pages of one session are served one at a time. */
  queue: Promise<unknown>;
}

const EXPIRED: LedgerViewResult<never> = {
  status: 'error',
  reason: 'CURSOR_EXPIRED',
  message: 'The Feed changed. Load it again.',
};

const INVALID_SEARCH: LedgerViewResult<never> = {
  status: 'error',
  reason: 'INVALID_INPUT',
  message: 'Invalid Feed search.',
};

/** A reply that came back after another account signed in. */
const ACCOUNT_CHANGED: LedgerViewResult<never> = {
  status: 'error',
  reason: 'CURSOR_EXPIRED',
  message: 'Your account changed. Load the Feed again.',
};

const ENTRY_NOT_AVAILABLE: LedgerViewResult<never> = {
  status: 'error',
  reason: 'NOT_FOUND',
  message: "This entry isn't available.",
};

function accountKeyOf(
  account: Exclude<LedgerFeedAccount, { kind: 'unknown' }>,
): string {
  return account.kind === 'signed_in'
    ? `account:${account.accountId}`
    : 'signed_out';
}

function keyOf(entry: {
  readonly updatedAt: string;
  readonly entryId: string;
}): SortKey {
  return { updatedAt: entry.updatedAt, entryId: entry.entryId };
}

/** Newest change first: later `updatedAt`, then the larger entry ID. */
function isNewer(left: SortKey, right: SortKey): boolean {
  const leftTime = Date.parse(left.updatedAt);
  const rightTime = Date.parse(right.updatedAt);
  if (leftTime !== rightTime) return leftTime > rightTime;
  return left.entryId > right.entryId;
}

/** The last of a page's rows, as the stream's floor. */
function floorOf(
  entries: ReadonlyArray<{
    readonly updatedAt: string;
    readonly entryId: string;
  }>,
): SortKey | null {
  const last = entries[entries.length - 1];
  return last === undefined ? null : keyOf(last);
}

function newestStream(streams: readonly FeedStream[]): FeedStream | null {
  let newest: FeedStream | null = null;
  for (const stream of streams) {
    const head = stream.buffer[0];
    if (head === undefined) continue;
    const best = newest?.buffer[0];
    if (best === undefined || isNewer(keyOf(head.entry), keyOf(best.entry))) {
      newest = stream;
    }
  }
  return newest;
}

/**
 * Streams that ran dry and must be read before `head` can be served: those
 * whose next row could still be newer than it.
 */
function blockingStreams(
  streams: readonly FeedStream[],
  head: LedgerFeedRow | undefined,
): FeedStream[] {
  return streams.filter(
    (stream) =>
      stream.buffer.length === 0 &&
      !stream.exhausted &&
      (head === undefined ||
        stream.floor === null ||
        isNewer(stream.floor, keyOf(head.entry))),
  );
}

/** The cache's key for a first page: the query, its filters sorted. */
function queryKey(request: LedgerFeedRequest): string {
  const { filters } = request;
  return JSON.stringify([
    request.audience,
    request.query.trim(),
    [...filters.types].sort(),
    [...filters.statuses].sort(),
    filters.owner,
    filters.author,
    filters.period,
    filters.includeArchived,
  ]);
}

/** A cursor this service issued: its session and page. */
function parseCursor(
  cursor: string,
): { readonly sessionId: string; readonly page: number } | null {
  const match = /^feed:([A-Za-z0-9-]{1,64}):([1-9][0-9]{0,5})$/.exec(cursor);
  if (match === null) return null;
  const [, sessionId, page] = match;
  if (sessionId === undefined || page === undefined) return null;
  return { sessionId, page: Number(page) };
}

export class LedgerFeedService {
  private readonly options: LedgerFeedServiceOptions;
  private readonly sessions = new Map<string, FeedSession>();
  private readonly cache = new Map<
    string,
    { readonly at: number; readonly page: LedgerFeedPage }
  >();

  constructor(options: LedgerFeedServiceOptions) {
    this.options = options;
  }

  /**
   * One page of the Feed. A request without a cursor starts a search, served
   * from the cache while it is fresh unless `refresh` asks otherwise.
   */
  async search(
    request: LedgerFeedRequest,
    call: FeedCall,
  ): Promise<LedgerViewResult<LedgerFeedPage>> {
    const account = await this.readAccount();
    if (account === null) {
      return {
        status: 'error',
        reason: 'UNKNOWN',
        message: "Couldn't read your account. Try again.",
      };
    }
    const accountKey = accountKeyOf(account);
    if (request.cursor !== undefined) {
      return this.settled(
        accountKey,
        await this.continueSearch(request.cursor, accountKey, call),
        parseCursor(request.cursor)?.sessionId,
      );
    }
    if (request.peek === true) {
      return this.settled(accountKey, await this.peek(request, account, call));
    }
    const key = `${accountKey}\n${queryKey(request)}`;
    const cached = this.cache.get(key);
    if (
      request.refresh !== true &&
      cached !== undefined &&
      this.now() - cached.at < LEDGER_FEED_CACHE_TTL_MS &&
      this.isContinuable(cached.page)
    ) {
      return { status: 'ok', value: cached.page };
    }
    const session = await this.createSession(request, account, accountKey);
    if (session === null) return INVALID_SEARCH;
    this.keepSession(session);
    const result = await this.settled(
      accountKey,
      await this.servePage(session, 1, call),
      session.id,
    );
    if (result.status === 'ok') {
      this.cache.delete(key);
      this.cache.set(key, { at: this.now(), page: result.value });
      while (this.cache.size > LEDGER_FEED_CACHE_MAX) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
    }
    return result;
  }

  /**
   * A row of another device or a teammate, with a page of its history, read
   * from the mirror. Changes to it are made on the device that owns it.
   */
  async getEntry(
    request: LedgerFeedEntryRequest,
  ): Promise<LedgerViewResult<LedgerViewEntry>> {
    const account = await this.readAccount();
    if (account === null || account.kind !== 'signed_in') {
      return {
        status: 'error',
        reason: 'NOT_FOUND',
        message: 'Sign in to see entries from your other devices.',
      };
    }
    let beforeRevision: number | undefined;
    if (request.historyCursor !== undefined) {
      const revision = ledgerMirrorHistoryRevision(request.historyCursor);
      if (revision === null) {
        return {
          status: 'error',
          reason: 'INVALID_INPUT',
          message: 'Invalid history page.',
        };
      }
      beforeRevision = revision;
    }
    const read = await this.options.mirror.getEntry(
      request.entryId,
      { ...(beforeRevision === undefined ? {} : { beforeRevision }) },
      account.accountId,
    );
    if (!read.ok) {
      // Another account signed in meanwhile: it may not see this entry.
      return read.failure === 'not_found' || read.failure === 'account_changed'
        ? ENTRY_NOT_AVAILABLE
        : {
            status: 'error',
            reason: 'UNKNOWN',
            message: "Couldn't load this entry. Try again.",
          };
    }
    // A reply that came back after another account signed in is not shown.
    if (!(await this.isSignedIn(accountKeyOf(account)))) {
      return ENTRY_NOT_AVAILABLE;
    }
    return { status: 'ok', value: ledgerViewEntryFromMirror(read.value) };
  }

  /**
   * The newest first page, for a look at whether anything changed. The
   * search is not kept and the cache is not touched, so a look never
   * displaces a search a list is paging; its page has no cursor.
   */
  private async peek(
    request: LedgerFeedRequest,
    account: Exclude<LedgerFeedAccount, { kind: 'unknown' }>,
    call: FeedCall,
  ): Promise<LedgerViewResult<LedgerFeedPage>> {
    const session = await this.createSession(
      request,
      account,
      accountKeyOf(account),
    );
    if (session === null) return INVALID_SEARCH;
    const result = await this.nextPage(session, call);
    return result.status === 'ok'
      ? { status: 'ok', value: { ...result.value, nextCursor: null } }
      : result;
  }

  /**
   * A reply for the account its request started under, while that account
   * is still the one signed in. Otherwise the reply is dropped with the
   * search it came from, so another account never sees it (LD02).
   */
  private async settled(
    accountKey: string,
    result: LedgerViewResult<LedgerFeedPage>,
    sessionId?: string,
  ): Promise<LedgerViewResult<LedgerFeedPage>> {
    if (result.status !== 'ok' || (await this.isSignedIn(accountKey))) {
      return result;
    }
    if (sessionId !== undefined) this.sessions.delete(sessionId);
    return ACCOUNT_CHANGED;
  }

  /** Whether the account of `accountKey` is still the one signed in. */
  private async isSignedIn(accountKey: string): Promise<boolean> {
    const account = await this.readAccount();
    return account !== null && accountKeyOf(account) === accountKey;
  }

  /** A local change: cached first pages may no longer be the newest. */
  invalidate(): void {
    this.cache.clear();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The account, or null when it cannot be read. */
  private async readAccount(): Promise<Exclude<
    LedgerFeedAccount,
    { kind: 'unknown' }
  > | null> {
    let account: LedgerFeedAccount;
    try {
      account = await this.options.readAccount();
    } catch {
      return null;
    }
    return account.kind === 'unknown' ? null : account;
  }

  /**
   * Whether a cached first page's next page can still be read: its search
   * is kept, and has not moved past page 2.
   */
  private isContinuable(page: LedgerFeedPage): boolean {
    if (page.nextCursor === null) return true;
    const parsed = parseCursor(page.nextCursor);
    if (parsed === null) return false;
    const session = this.sessions.get(parsed.sessionId);
    return (
      session !== undefined &&
      this.now() < session.expiresAt &&
      (session.nextPage === parsed.page || session.last?.page === parsed.page)
    );
  }

  private async continueSearch(
    cursor: string,
    accountKey: string,
    call: FeedCall,
  ): Promise<LedgerViewResult<LedgerFeedPage>> {
    const parsed = parseCursor(cursor);
    const session =
      parsed === null ? undefined : this.sessions.get(parsed.sessionId);
    // A cursor of another account, or one past its lifetime, is refused.
    if (
      parsed === null ||
      session === undefined ||
      session.accountKey !== accountKey ||
      this.now() >= session.expiresAt
    ) {
      return EXPIRED;
    }
    return this.servePage(session, parsed.page, call);
  }

  private async createSession(
    request: LedgerFeedRequest,
    account: Exclude<LedgerFeedAccount, { kind: 'unknown' }>,
    accountKey: string,
  ): Promise<FeedSession | null> {
    const filters = ledgerFeedSearchFilters(
      request.query,
      request.filters,
      this.now(),
    );
    const localParams = LedgerEntriesSearchParamsSchema.safeParse({
      ...filters,
      sort: 'updated_desc',
      limit: LEDGER_FEED_PAGE_SIZE,
    });
    if (!localParams.success) return null;
    const scopes = await this.options.listScopes();
    const owned = scopes.filter(
      (scope) =>
        (account.kind === 'signed_in'
          ? scope.accountId === account.accountId
          : scope.accountId === null) &&
        (request.filters.includeArchived || !scope.archived),
    );
    const streams: FeedStream[] = owned.map((scope) =>
      this.localStream(scope, localParams.data),
    );
    if (account.kind === 'signed_in' && request.audience !== 'this_device') {
      // The local stream holds every scope this device has.
      const local = new Set(scopes.map((scope) => scope.ledgerId));
      const audiences: LedgerMirrorAudience[] =
        request.audience === 'teammates' ? ['mine', 'teammates'] : ['mine'];
      for (const audience of audiences) {
        streams.push(
          this.mirrorStream(
            audience,
            {
              ...filters,
              includeArchived: request.filters.includeArchived,
              local,
            },
            account.accountId,
          ),
        );
      }
    }
    const id = (this.options.newSessionId ?? randomUUID)();
    const session: FeedSession = {
      id,
      accountKey,
      expiresAt: this.now() + LEDGER_LIMITS.cursorLifetimeMs,
      streams,
      actors: new Map(),
      notice: account.kind === 'signed_out' ? 'signed_out' : null,
      nextPage: 1,
      last: null,
      queue: Promise.resolve(),
    };
    return session;
  }

  /** Keeps a search so its next pages can be read, dropping the oldest. */
  private keepSession(session: FeedSession): void {
    this.sessions.set(session.id, session);
    while (this.sessions.size > SESSIONS_MAX) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }

  private localStream(
    scope: LedgerFeedLocalScope,
    params: LedgerEntriesSearchParams,
  ): FeedStream {
    const viewScope = this.options.viewScope(scope.container, scope.ledgerId);
    return {
      buffer: [],
      cursor: null,
      exhausted: false,
      floor: null,
      read: async (cursor, call): Promise<StreamRead> => {
        const result = await call.searchScope(
          viewScope,
          {
            ...params,
            ...(cursor === null ? {} : { cursor }),
          },
          {
            container: scope.container,
            containerCreatedAt: scope.containerCreatedAt,
          },
        );
        if (result.status !== 'ok') return localFailure(result);
        return {
          kind: 'page',
          rows: result.value.entries.map(
            (entry): LedgerFeedRow => ({
              entry,
              ledgerId: scope.ledgerId,
              scopeKind: scope.container.kind,
              scopeArchived: scope.archived,
              origin: { kind: 'this_device', scope: viewScope },
            }),
          ),
          actors: result.value.actors ?? [],
          nextCursor: result.value.nextCursor,
          hasMore: result.value.hasMore,
          floor: floorOf(result.value.entries),
        };
      },
    };
  }

  /** A mirror search, read only as the account the search started with. */
  private mirrorStream(
    audience: LedgerMirrorAudience,
    search: LedgerFeedSearchFilters & {
      readonly includeArchived: boolean;
      readonly local: ReadonlySet<string>;
    },
    accountId: string,
  ): FeedStream {
    const { local, ...filters } = search;
    return {
      buffer: [],
      cursor: null,
      exhausted: false,
      floor: null,
      read: async (cursor): Promise<StreamRead> => {
        const request: LedgerMirrorSearchRequest = {
          ...filters,
          audience,
          sort: 'updated_desc',
          limit: LEDGER_FEED_PAGE_SIZE,
          ...(cursor === null ? {} : { cursor }),
        };
        const read = await this.options.mirror.search(request, accountId);
        if (!read.ok) {
          // Another account signed in meanwhile: this search is over, and
          // nothing of the other account's is read for it.
          return read.failure === 'expired' ||
            read.failure === 'account_changed'
            ? { kind: 'expired' }
            : { kind: 'ended', notice: 'remote_unavailable' };
        }
        return {
          kind: 'page',
          rows: read.value.entries
            .filter((entry) => !local.has(entry.ledgerId))
            .map(ledgerFeedRowFromMirror),
          actors: read.value.actors.map(ledgerActorLabelFromMirror),
          nextCursor: read.value.nextCursor,
          hasMore: read.value.hasMore,
          // Rows of this device's scopes count too: the stream is past them.
          floor: floorOf(read.value.entries),
        };
      },
    };
  }

  /** Serves page `page` of a session, one page of a session at a time. */
  private servePage(
    session: FeedSession,
    page: number,
    call: FeedCall,
  ): Promise<LedgerViewResult<LedgerFeedPage>> {
    const served = session.queue.then(
      (): Promise<LedgerViewResult<LedgerFeedPage>> => {
        // A retry of the last page gets the same page back.
        if (session.last !== null && page === session.last.page) {
          return Promise.resolve({ status: 'ok', value: session.last.value });
        }
        if (page !== session.nextPage) return Promise.resolve(EXPIRED);
        return this.nextPage(session, call);
      },
    );
    session.queue = served.catch((): void => undefined);
    return served;
  }

  private async nextPage(
    session: FeedSession,
    call: FeedCall,
  ): Promise<LedgerViewResult<LedgerFeedPage>> {
    const merged = await this.mergeRows(session, call);
    if (merged.status !== 'ok') {
      if (merged === EXPIRED) this.sessions.delete(session.id);
      return merged;
    }
    const rows = merged.value;
    const hasMore = session.streams.some(
      (stream) => stream.buffer.length > 0 || !stream.exhausted,
    );
    const page = session.nextPage;
    const value: LedgerFeedPage = {
      rows,
      actors: actorsOf(rows, session.actors),
      nextCursor: hasMore ? `feed:${session.id}:${String(page + 1)}` : null,
      hasMore,
      notice: session.notice,
    };
    session.nextPage = page + 1;
    session.last = { page, value };
    return { status: 'ok', value };
  }

  /**
   * Takes up to a page of rows, newest change first, reading each stream
   * again as it runs dry. A page reads a bounded number of times; a short
   * page is fine, since the next one continues where it stopped.
   */
  private async mergeRows(
    session: FeedSession,
    call: FeedCall,
  ): Promise<LedgerViewResult<LedgerFeedRow[]>> {
    const rows: LedgerFeedRow[] = [];
    // The stream each row came from: a page that fails puts its rows back,
    // so retrying it serves the same rows.
    const sources: FeedStream[] = [];
    let reads = 0;
    while (rows.length < LEDGER_FEED_PAGE_SIZE) {
      const next = newestStream(session.streams);
      const head = next?.buffer[0];
      const dry = blockingStreams(session.streams, head);
      if (dry.length > 0) {
        if (reads >= READS_PER_PAGE_MAX) break;
        reads += dry.length;
        const failure = await this.fill(session, dry, call);
        if (failure !== null) {
          putBack(rows, sources);
          return failure;
        }
        continue;
      }
      if (next === null || head === undefined) break;
      next.buffer.shift();
      rows.push(head);
      sources.push(next);
    }
    return { status: 'ok', value: rows };
  }

  /** Reads the next page of each stream that ran dry, all at once. */
  private async fill(
    session: FeedSession,
    streams: readonly FeedStream[],
    call: FeedCall,
  ): Promise<LedgerViewResult<never> | null> {
    const reads = await Promise.all(
      streams.map((stream) => stream.read(stream.cursor, call)),
    );
    for (let index = 0; index < reads.length; index += 1) {
      const read = reads[index];
      const stream = streams[index];
      if (read === undefined || stream === undefined) continue;
      switch (read.kind) {
        case 'expired':
          return EXPIRED;
        case 'failed':
          return read.result;
        case 'ended':
          stream.exhausted = true;
          if (read.notice !== null) session.notice ??= read.notice;
          break;
        case 'page':
          stream.buffer = [...read.rows];
          stream.cursor = read.nextCursor;
          stream.exhausted = !read.hasMore || read.nextCursor === null;
          stream.floor = read.floor ?? stream.floor;
          for (const label of read.actors) {
            session.actors.set(label.actorId, label);
          }
          break;
      }
    }
    return null;
  }
}

/** Returns a failed page's rows to the heads of the streams they came from. */
function putBack(
  rows: readonly LedgerFeedRow[],
  sources: readonly FeedStream[],
): void {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const stream = sources[index];
    if (row !== undefined && stream !== undefined) stream.buffer.unshift(row);
  }
}

/** What a local scope's failed read means for the whole search. */
function localFailure(
  result: Exclude<LedgerViewResult<unknown>, { status: 'ok' }>,
): StreamRead {
  if (result.status === 'unavailable') {
    // A scope that went away meanwhile simply has nothing more to show.
    return result.reason === 'no_scope'
      ? { kind: 'ended', notice: null }
      : { kind: 'failed', result };
  }
  switch (result.reason) {
    case 'CURSOR_EXPIRED':
      return { kind: 'expired' };
    case 'NOT_FOUND':
    case 'SCOPE_RETIRED':
      return { kind: 'ended', notice: null };
    default:
      return { kind: 'failed', result };
  }
}

/** Labels of the actors a page's rows name. */
function actorsOf(
  rows: readonly LedgerFeedRow[],
  known: ReadonlyMap<string, LedgerActorLabel>,
): LedgerActorLabel[] {
  const labels = new Map<string, LedgerActorLabel>();
  for (const row of rows) {
    for (const actorId of [row.entry.author.actorId, row.entry.owner.actorId]) {
      const label = known.get(actorId);
      if (label !== undefined) labels.set(actorId, label);
    }
  }
  return Array.from(labels.values());
}
