import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { LedgerFeedClient } from '@canopy/app-core';
import type {
  LedgerActorLabel,
  LedgerEntrySearchItem,
} from '@canopy/protocol/canopy-core';
import type {
  LedgerFeedAudience,
  LedgerFeedFilters,
  LedgerFeedNotice,
  LedgerFeedOrigin,
  LedgerFeedPage,
  LedgerFeedRequest,
  LedgerFeedRow,
  LedgerViewEntry,
  LedgerTaskViewScope,
  LedgerViewResult,
  LedgerViewScope,
} from '@canopy/protocol/ledger-view';
import { ledgerViewScopeKey } from '@canopy/protocol/ledger-view';
import type {
  LedgerViewSelectOptions,
  LedgerViewStore,
} from './create-ledger-view-store';
import {
  normalizeQuery,
  problemOf,
  thrownResult,
  withActors,
  type LedgerViewProblem,
} from './ledger-view-results';
import {
  applyLedgerDraftPatch,
  blankLedgerViewDraft,
  defaultLedgerRequestKey,
  type LedgerViewComposerState,
  type LedgerViewDraft,
} from './ledger-view-writes';

/*
 * The global Feed's view (phase 14): whose entries, the search and filters,
 * the merged rows and their cursor, the selection, and the read-only detail
 * of a row from another device or a teammate. Rows of this device's scopes
 * open in their scope's own view store, which can change them. Entries live
 * in memory only, and every response from a superseded request is dropped.
 *
 * Newer activity never moves what the person is reading: a background look
 * at the first page that finds something new waits behind "New activity"
 * until they ask for it, and showing it reads the newest page. A look that
 * finds the same rows takes their fresh copies in place, including status,
 * owner and sync changes, without moving them.
 */

export const DEFAULT_LEDGER_FEED_FILTERS: LedgerFeedFilters = {
  types: [],
  statuses: [],
  owner: 'anyone',
  author: 'anyone',
  period: 'any',
  includeArchived: false,
};

export interface LedgerFeedListState {
  readonly status: 'idle' | 'loading' | 'ready' | 'problem';
  /** Changes whenever a fresh first page establishes a new list placement. */
  readonly generation: number;
  readonly rows: readonly LedgerFeedRow[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly loadMoreProblem: LedgerViewProblem | null;
  readonly problem: LedgerViewProblem | null;
  /** What the Feed could not include, such as other devices offline. */
  readonly notice: LedgerFeedNotice | null;
  /**
   * The list shows the result of a successful read, even an empty one. A
   * search in flight then leaves it on screen instead of flashing a loading
   * state between results. Before the first result, and after a failed read,
   * which leaves nothing to keep, a read in flight shows loading.
   */
  readonly settled: boolean;
}

/** The view store of one of this device's scopes, created on first use. */
export type LedgerViewStoreFor = (scope: LedgerViewScope) => LedgerViewStore;

/**
 * The Feed's new entry: whether its form is open, and where the entry goes.
 * The person chooses a project, then one of its tasks. Until a task is
 * chosen the Feed holds the draft; from then on the task's own view does,
 * so saving keeps that view's request key and confirmation rules. Choosing
 * again moves the draft and keeps what was written, except what belongs to
 * where it was: the owner starts again as the person, and reference files,
 * which name the project's repositories and folders, go when the project
 * changes.
 */
export interface LedgerFeedComposerState {
  /** Whether the form is in the detail; choosing an entry sets it aside. */
  readonly shown: boolean;
  /** The project chosen; null until one is. */
  readonly projectId: string | null;
  /**
   * The task chosen, whose view holds the draft; null until one is. A new
   * entry only ever goes to a task, never a global (workflow) scope.
   */
  readonly scope: LedgerTaskViewScope | null;
  /** The draft while no task holds it. */
  readonly draft: LedgerViewDraft | null;
  /**
   * The draft's ID, which the task view holding it records: a draft that
   * view started itself is never taken for the Feed's. Null when closed.
   */
  readonly draftId: string | null;
}

/**
 * The Feed's new entry draft as it now reads: the Feed's own while no task
 * holds it, then the chosen task view's, but only while that view still
 * holds the draft the Feed moved there.
 */
export function ledgerFeedDraft(
  feed: LedgerFeedComposerState,
  view: LedgerViewComposerState | null,
): LedgerViewDraft | null {
  if (feed.scope === null) return feed.draft;
  return view !== null &&
    feed.draftId !== null &&
    view.adoptedId === feed.draftId
    ? view.draft
    : null;
}

export interface LedgerFeedStoreOptions {
  /** IDs for the Feed's new drafts; random by default. */
  readonly newDraftId?: () => string;
}

/** Where a row the Feed reads from the cloud was recorded. */
export type LedgerFeedRemoteOrigin = Exclude<
  LedgerFeedOrigin,
  { readonly kind: 'this_device' }
>;

export interface LedgerFeedSelectOptions extends LedgerViewSelectOptions {
  /** Where an entry with no loaded row comes from; it is read from there. */
  readonly remoteOrigin?: LedgerFeedRemoteOrigin;
}

/** The read-only detail of a row from another device or a teammate. */
export interface LedgerFeedRemoteDetailState {
  readonly status: 'idle' | 'loading' | 'ready' | 'problem';
  readonly entryId: string | null;
  /**
   * Where the entry was recorded, kept from its row: a search or newer
   * activity can drop the row while its detail stays open.
   */
  readonly origin: LedgerFeedRemoteOrigin | null;
  readonly view: LedgerViewEntry | null;
  readonly problem: LedgerViewProblem | null;
  readonly loadingMoreHistory: boolean;
}

export interface LedgerFeedState {
  readonly audience: LedgerFeedAudience;
  readonly queryText: string;
  readonly filters: LedgerFeedFilters;
  readonly list: LedgerFeedListState;
  /** Labels of every actor the rows and details name. */
  readonly actors: Readonly<Record<string, LedgerActorLabel>>;
  /** A newer first page waits to be shown; the list stays until it is. */
  readonly newActivity: boolean;
  readonly selectedEntryId: string | null;
  /**
   * This device's scope the detail shows: the selected row's, or the one a
   * new entry is being added to. Its own view store holds that detail.
   */
  readonly selectedScope: LedgerViewScope | null;
  readonly remoteDetail: LedgerFeedRemoteDetailState;
  readonly composer: LedgerFeedComposerState;
  readonly scrollTop: number;
  /** Reads the first page; `refresh` reads past the host's cache. */
  readonly load: (options?: { readonly refresh?: boolean }) => Promise<void>;
  readonly setAudience: (audience: LedgerFeedAudience) => Promise<void>;
  /** Sets the search text; the next `load` searches for it. */
  readonly setQueryText: (text: string) => void;
  readonly setFilters: (filters: LedgerFeedFilters) => Promise<void>;
  readonly loadMore: () => Promise<void>;
  /**
   * Looks at the newest first page in the background. Rows already shown
   * take fresh copies in place; a new entry within the reached range, a
   * changed notice or rows missing from a final page wait behind
   * `newActivity`. An empty list just shows the page.
   */
  readonly checkForNewActivity: () => Promise<void>;
  /**
   * Notes an entry the person just saved from the Feed, such as a correction,
   * so the next look adds its row in place, at the front of the list where
   * its thread picks it up, instead of holding it behind `newActivity`.
   * Anything else the list lacks still waits there.
   */
  readonly noteOwnEntry: (entryId: string) => void;
  /** Reads and shows the newest first page, from the top; the selection stays. */
  readonly showNewActivity: () => Promise<void>;
  /**
   * Puts a fresh read of a loaded row's entry in place, such as once its
   * title was written; the row keeps its position. An entry no row holds, or
   * an older revision than the row's, changes nothing.
   */
  readonly replaceEntry: (entry: LedgerEntrySearchItem) => void;
  /**
   * Selects an entry. A remote entry with no loaded row, such as the entry a
   * teammate's correction corrects, is read from `remoteOrigin` when given.
   */
  readonly select: (
    entryId: string | null,
    options?: LedgerFeedSelectOptions,
  ) => Promise<void>;
  /** Shows one of this device's scopes in the detail, with no row selected. */
  readonly focusScope: (scope: LedgerViewScope | null) => void;
  /**
   * Shows the new entry's form in the detail, with its draft as it was. A
   * draft its task saved or dropped meanwhile starts again, blank, in the
   * same project.
   */
  readonly startEntry: (viewFor: LedgerViewStoreFor) => void;
  /** Changes the draft while no task holds it. */
  readonly updateDraft: (patch: Partial<LedgerViewDraft>) => void;
  /**
   * Chooses the new entry's project. Another project lets go of the task,
   * and the draft comes back to the Feed. Returns false, changing nothing,
   * while the task's view cannot let it go (see `ledgerDraftMovable`).
   */
  readonly chooseProject: (
    projectId: string,
    viewFor: LedgerViewStoreFor,
  ) => boolean;
  /**
   * Chooses the task the new entry goes to; its view takes the draft.
   * Returns false, changing nothing, when that task has a draft of its own
   * in its new-entry composer, or the current task's view cannot let the
   * draft go. Independent correction drafts do not block this move.
   */
  readonly chooseTask: (
    scope: LedgerTaskViewScope,
    viewFor: LedgerViewStoreFor,
  ) => boolean;
  /** Sets the form aside; the draft stays. */
  readonly hideEntry: () => void;
  /** Closes the form for good: the draft was saved or discarded. */
  readonly closeEntry: () => void;
  readonly reloadRemoteDetail: () => Promise<void>;
  readonly loadMoreRemoteHistory: () => Promise<void>;
  /** Starts over, as after another account signed in. */
  readonly reset: () => void;
  readonly setScrollTop: (scrollTop: number) => void;
}

export type LedgerFeedStore = UseBoundStore<StoreApi<LedgerFeedState>>;

/** The most saves the Feed keeps waiting to add in place. */
const LEDGER_FEED_OWN_ENTRIES_MAX = 20;

const IDLE_LIST: LedgerFeedListState = {
  status: 'idle',
  generation: 0,
  rows: [],
  nextCursor: null,
  hasMore: false,
  loadingMore: false,
  loadMoreProblem: null,
  problem: null,
  notice: null,
  settled: false,
};

const CLOSED_FEED_COMPOSER: LedgerFeedComposerState = {
  shown: false,
  projectId: null,
  scope: null,
  draft: null,
  draftId: null,
};

function sameScope(
  left: LedgerViewScope | null,
  right: LedgerViewScope | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    ledgerViewScopeKey(left) === ledgerViewScopeKey(right)
  );
}

/**
 * The draft as it moves to another task. Its owner belongs to the task it was
 * chosen in. Its reference files name the project's repositories and folders,
 * so they move only within a project.
 */
function movedDraft(
  draft: LedgerViewDraft,
  sameProject: boolean,
): LedgerViewDraft {
  return {
    ...draft,
    owner: null,
    referenceFiles: sameProject ? draft.referenceFiles : [],
  };
}

const IDLE_REMOTE_DETAIL: LedgerFeedRemoteDetailState = {
  status: 'idle',
  entryId: null,
  origin: null,
  view: null,
  problem: null,
  loadingMoreHistory: false,
};

/** Whether an audience lists the entries recorded where `origin` says. */
function audienceIncludes(
  audience: LedgerFeedAudience,
  origin: LedgerFeedRemoteOrigin,
): boolean {
  return origin.kind === 'teammate'
    ? audience === 'teammates'
    : audience !== 'this_device';
}

/**
 * Whether the fresh page offers an entry within the range the list has
 * reached, or says that shown rows or the notice have changed. A passing
 * remote outage is not new activity, and rows past the list's end are not
 * new while the list can still go on to them.
 */
function hasNewActivity(
  shown: LedgerFeedListState,
  fresh: LedgerFeedPage,
): boolean {
  const passingOutage =
    fresh.notice === 'remote_unavailable' && shown.notice === null;
  if (fresh.notice !== shown.notice && !passingOutage) return true;

  const shownIds = new Set(shown.rows.map((row) => row.entry.entryId));
  const freshIds = new Set(fresh.rows.map((row) => row.entry.entryId));
  const hasNewEntryInReachedRange = fresh.rows.some(
    (row, index) =>
      !shownIds.has(row.entry.entryId) &&
      (index < shown.rows.length || !shown.hasMore),
  );
  if (hasNewEntryInReachedRange) return true;

  // A final page says that rows the list had shown are no longer present.
  return (
    !passingOutage &&
    !fresh.hasMore &&
    shown.rows.some((row) => !freshIds.has(row.entry.entryId))
  );
}

/** Replaces shown rows with same-or-newer copies, without changing their order. */
function refreshedRows(
  rows: readonly LedgerFeedRow[],
  fresh: readonly LedgerFeedRow[],
): LedgerFeedRow[] {
  const byId = new Map(fresh.map((row) => [row.entry.entryId, row]));
  return rows.map((row) => {
    const copy = byId.get(row.entry.entryId);
    return copy !== undefined && copy.entry.revision >= row.entry.revision
      ? copy
      : row;
  });
}

/** Appends a page, dropping rows an earlier page already holds. */
function appendRows(
  rows: readonly LedgerFeedRow[],
  page: readonly LedgerFeedRow[],
): LedgerFeedRow[] {
  const seen = new Set(rows.map((row) => row.entry.entryId));
  return [...rows, ...page.filter((row) => !seen.has(row.entry.entryId))];
}

function readyList(
  page: LedgerFeedPage,
  generation: number,
): LedgerFeedListState {
  return {
    ...IDLE_LIST,
    status: 'ready',
    generation,
    rows: page.rows,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    notice: page.notice,
    settled: true,
  };
}

export function createLedgerFeedStore(
  client: LedgerFeedClient,
  options: LedgerFeedStoreOptions = {},
): LedgerFeedStore {
  const newDraftId = options.newDraftId ?? defaultLedgerRequestKey;
  // A response is applied only if no newer request of its kind started.
  let listGeneration = 0;
  let detailGeneration = 0;
  let checkGeneration = 0;
  /**
   * Entries the person just saved here, by ID, oldest first: the next look
   * adds their rows in place. An ID goes once its row is in the list, and
   * all of them go with a fresh first page or a reset.
   */
  const ownEntries = new Set<string>();

  const noteOwnEntry = (entryId: string): void => {
    ownEntries.delete(entryId);
    ownEntries.add(entryId);
    // A row that never reaches the first page, such as one a search leaves
    // out, waits for the next fresh read; only the newest few are kept.
    for (const oldest of Array.from(ownEntries)) {
      if (ownEntries.size <= LEDGER_FEED_OWN_ENTRIES_MAX) break;
      ownEntries.delete(oldest);
    }
  };

  return create<LedgerFeedState>((set, get) => {
    const request = (options: {
      readonly cursor?: string;
      readonly refresh?: boolean;
      readonly peek?: boolean;
    }): LedgerFeedRequest => {
      const { audience, queryText, filters } = get();
      return {
        audience,
        query: normalizeQuery(queryText),
        filters,
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        ...(options.refresh === true ? { refresh: true } : {}),
        ...(options.peek === true ? { peek: true } : {}),
      };
    };

    const searchFeed = async (
      body: LedgerFeedRequest,
    ): Promise<LedgerViewResult<LedgerFeedPage>> => {
      try {
        return await client.searchFeed(body);
      } catch (error) {
        return thrownResult(error);
      }
    };

    const readRemote = async (
      entryId: string,
      historyCursor?: string,
    ): Promise<LedgerViewResult<LedgerViewEntry>> => {
      try {
        return await client.getFeedEntry({
          entryId,
          ...(historyCursor === undefined ? {} : { historyCursor }),
        });
      } catch (error) {
        return thrownResult(error);
      }
    };

    const load = async (
      options: { readonly refresh?: boolean } = {},
    ): Promise<void> => {
      const generation = ++listGeneration;
      set((state) => ({
        list: {
          ...IDLE_LIST,
          status: 'loading',
          generation: state.list.generation,
          rows: state.list.rows,
          settled: state.list.settled,
        },
        newActivity: false,
      }));
      const result = await searchFeed(request(options));
      if (generation !== listGeneration) return;
      if (result.status !== 'ok') {
        set((state) => ({
          list: {
            ...IDLE_LIST,
            status: 'problem',
            generation: state.list.generation,
            problem: problemOf(result),
          },
        }));
        return;
      }
      // A fresh first page shows whatever the person saved that it holds.
      ownEntries.clear();
      set((state) => ({
        list: readyList(result.value, state.list.generation + 1),
        actors: withActors(state.actors, result.value.actors),
        scrollTop: 0,
      }));
    };

    const loadMore = async (): Promise<void> => {
      const { list } = get();
      if (
        list.status !== 'ready' ||
        !list.hasMore ||
        list.loadingMore ||
        list.nextCursor === null
      ) {
        return;
      }
      const generation = listGeneration;
      set((state) => ({
        list: { ...state.list, loadingMore: true, loadMoreProblem: null },
      }));
      const result = await searchFeed(request({ cursor: list.nextCursor }));
      if (generation !== listGeneration) return;
      if (result.status !== 'ok') {
        // The search's snapshot ended: it starts over from the newest.
        if (result.status === 'error' && result.reason === 'CURSOR_EXPIRED') {
          await load({ refresh: true });
          return;
        }
        set((state) => ({
          list: {
            ...state.list,
            loadingMore: false,
            loadMoreProblem: problemOf(result),
          },
        }));
        return;
      }
      set((state) => ({
        list: {
          ...state.list,
          rows: appendRows(state.list.rows, result.value.rows),
          nextCursor: result.value.nextCursor,
          hasMore: result.value.hasMore,
          loadingMore: false,
          loadMoreProblem: null,
          notice: state.list.notice ?? result.value.notice,
        },
        actors: withActors(state.actors, result.value.actors),
      }));
    };

    const checkForNewActivity = async (): Promise<void> => {
      const shown = get().list;
      if (shown.status !== 'ready') return;
      const generation = listGeneration;
      const check = ++checkGeneration;
      // An empty list has no place to lose: it takes the newest page as is,
      // with a search to go on from. Otherwise this is only a look.
      const adopt = shown.rows.length === 0;
      const result = await searchFeed(
        request(adopt ? { refresh: true } : { peek: true }),
      );
      if (
        generation !== listGeneration ||
        check !== checkGeneration ||
        result.status !== 'ok'
      ) {
        return;
      }
      const fresh = result.value;
      const { list } = get();
      if (list.status !== 'ready') return;
      if (adopt) {
        if (list.rows.length > 0) return;
        for (const row of fresh.rows) ownEntries.delete(row.entry.entryId);
        set((state) => ({
          list: readyList(fresh, state.list.generation + 1),
          actors: withActors(state.actors, fresh.actors),
        }));
        return;
      }
      // The person's own saves join the list in place, newest first, and
      // never count as new activity. Read when the look lands, so a look
      // already on its way when the save was noted adopts it too.
      const shownIds = new Set(list.rows.map((row) => row.entry.entryId));
      for (const id of Array.from(ownEntries)) {
        if (shownIds.has(id)) ownEntries.delete(id);
      }
      const own = fresh.rows.filter((row) => ownEntries.has(row.entry.entryId));
      for (const row of own) ownEntries.delete(row.entry.entryId);
      const withOwn =
        own.length === 0 ? list : { ...list, rows: [...own, ...list.rows] };
      const newActivity = hasNewActivity(withOwn, fresh);
      set((state) => {
        const current = new Set(
          state.list.rows.map((row) => row.entry.entryId),
        );
        const added = own.filter((row) => !current.has(row.entry.entryId));
        return {
          list: {
            ...state.list,
            rows: refreshedRows([...added, ...state.list.rows], fresh.rows),
          },
          actors: withActors(state.actors, fresh.actors),
          ...(newActivity ? { newActivity: true } : {}),
        };
      });
    };

    // The newest page, read anew: a look keeps no search to go on from.
    const showNewActivity = (): Promise<void> => load({ refresh: true });

    const fetchRemoteDetail = async (
      entryId: string,
      origin: LedgerFeedRemoteOrigin,
    ): Promise<void> => {
      const generation = ++detailGeneration;
      set({
        remoteDetail: {
          ...IDLE_REMOTE_DETAIL,
          status: 'loading',
          entryId,
          origin,
        },
      });
      const result = await readRemote(entryId);
      if (generation !== detailGeneration) return;
      if (result.status !== 'ok') {
        set({
          remoteDetail: {
            ...IDLE_REMOTE_DETAIL,
            status: 'problem',
            entryId,
            origin,
            problem: problemOf(result),
          },
        });
        return;
      }
      set((state) => ({
        remoteDetail: {
          ...IDLE_REMOTE_DETAIL,
          status: 'ready',
          entryId,
          origin,
          view: result.value,
        },
        actors: withActors(state.actors, result.value.entry.actors),
      }));
    };

    const select = async (
      entryId: string | null,
      selectOptions?: LedgerFeedSelectOptions,
    ): Promise<void> => {
      detailGeneration += 1;
      const row =
        entryId === null
          ? undefined
          : get().list.rows.find(
              (candidate) => candidate.entry.entryId === entryId,
            );
      set((state) => ({
        selectedEntryId: entryId,
        // This device's rows open in their scope's own view.
        selectedScope:
          row?.origin.kind === 'this_device' ? row.origin.scope : null,
        remoteDetail: IDLE_REMOTE_DETAIL,
        // A new entry's draft stays, set aside, until saved or discarded.
        composer: {
          ...state.composer,
          shown:
            selectOptions?.keepDraft === true ? state.composer.shown : false,
        },
      }));
      if (entryId === null) return;
      const origin =
        row === undefined ? selectOptions?.remoteOrigin : row.origin;
      if (origin === undefined || origin.kind === 'this_device') return;
      await fetchRemoteDetail(entryId, origin);
    };

    const reloadRemoteDetail = async (): Promise<void> => {
      const { remoteDetail } = get();
      if (remoteDetail.entryId === null || remoteDetail.origin === null) {
        return;
      }
      await fetchRemoteDetail(remoteDetail.entryId, remoteDetail.origin);
    };

    const loadMoreRemoteHistory = async (): Promise<void> => {
      const { remoteDetail } = get();
      const view = remoteDetail.view;
      const history = view?.entry.history;
      if (
        remoteDetail.status !== 'ready' ||
        remoteDetail.loadingMoreHistory ||
        remoteDetail.entryId === null ||
        view === null ||
        history === null ||
        history === undefined ||
        history.nextCursor === null
      ) {
        return;
      }
      const generation = detailGeneration;
      const { entryId } = remoteDetail;
      set((state) => ({
        remoteDetail: { ...state.remoteDetail, loadingMoreHistory: true },
      }));
      const result = await readRemote(entryId, history.nextCursor);
      if (generation !== detailGeneration) return;
      if (result.status !== 'ok' || result.value.entry.history === null) {
        set((state) => ({
          remoteDetail: { ...state.remoteDetail, loadingMoreHistory: false },
        }));
        return;
      }
      const more = result.value.entry.history;
      set((state) => ({
        remoteDetail: {
          ...state.remoteDetail,
          loadingMoreHistory: false,
          view: {
            ...view,
            entry: {
              ...view.entry,
              history: {
                mutations: [...history.mutations, ...more.mutations],
                nextCursor: more.nextCursor,
              },
            },
          },
        },
        actors: withActors(state.actors, result.value.entry.actors),
      }));
    };

    return {
      audience: 'mine',
      queryText: '',
      filters: DEFAULT_LEDGER_FEED_FILTERS,
      list: IDLE_LIST,
      actors: {},
      newActivity: false,
      selectedEntryId: null,
      selectedScope: null,
      remoteDetail: IDLE_REMOTE_DETAIL,
      composer: CLOSED_FEED_COMPOSER,
      scrollTop: 0,
      load,
      setAudience: async (audience): Promise<void> => {
        if (audience === get().audience) return;
        // This device's entries are in every audience; a remote one the
        // new audience leaves out is let go of, not shown as someone else's.
        const { origin } = get().remoteDetail;
        if (origin !== null && !audienceIncludes(audience, origin)) {
          detailGeneration += 1;
          set({
            audience,
            selectedEntryId: null,
            selectedScope: null,
            remoteDetail: IDLE_REMOTE_DETAIL,
          });
        } else {
          set({ audience });
        }
        await load();
      },
      setQueryText: (text): void => {
        set({ queryText: text });
      },
      setFilters: async (filters): Promise<void> => {
        set({ filters });
        await load();
      },
      loadMore,
      checkForNewActivity,
      noteOwnEntry,
      showNewActivity,
      replaceEntry: (entry): void => {
        const { rows } = get().list;
        const index = rows.findIndex(
          (row) => row.entry.entryId === entry.entryId,
        );
        const row = rows[index];
        if (row === undefined || row.entry.revision > entry.revision) return;
        set((state) => ({
          list: {
            ...state.list,
            rows: state.list.rows.map((candidate) =>
              candidate.entry.entryId === entry.entryId
                ? { ...candidate, entry }
                : candidate,
            ),
          },
        }));
      },
      select,
      focusScope: (scope): void => {
        detailGeneration += 1;
        set((state) => ({
          selectedEntryId: null,
          selectedScope: scope,
          remoteDetail: IDLE_REMOTE_DETAIL,
          composer: { ...state.composer, shown: false },
        }));
      },
      startEntry: (viewFor): void => {
        const { composer } = get();
        const view = composer.scope === null ? null : viewFor(composer.scope);
        let next: LedgerFeedComposerState;
        if (view === null && composer.draft !== null) {
          next = { ...composer, shown: true };
        } else if (
          view !== null &&
          ledgerFeedDraft(composer, view.getState().composer) !== null
        ) {
          view.getState().startEntry();
          next = { ...composer, shown: true };
        } else {
          // None yet, or its task saved, dropped or replaced it meanwhile.
          next = {
            shown: true,
            projectId: composer.projectId,
            scope: null,
            draft: blankLedgerViewDraft('TASK'),
            draftId: newDraftId(),
          };
        }
        detailGeneration += 1;
        set({
          composer: next,
          selectedEntryId: null,
          selectedScope: null,
          remoteDetail: IDLE_REMOTE_DETAIL,
        });
      },
      updateDraft: (patch): void => {
        set((state) =>
          state.composer.draft === null
            ? {}
            : {
                composer: {
                  ...state.composer,
                  draft: applyLedgerDraftPatch(state.composer.draft, patch),
                },
              },
        );
      },
      chooseProject: (projectId, viewFor): boolean => {
        const { composer } = get();
        if (composer.projectId === projectId) return true;
        let draft = composer.draft ?? blankLedgerViewDraft('TASK');
        if (composer.scope !== null) {
          const released = viewFor(composer.scope).getState().releaseDraft();
          if (released === null) return false;
          draft = movedDraft(released, false);
        }
        set({ composer: { ...composer, projectId, scope: null, draft } });
        return true;
      },
      chooseTask: (scope, viewFor): boolean => {
        const { composer } = get();
        if (sameScope(composer.scope, scope)) return true;
        const target = viewFor(scope);
        // A task with its own draft keeps it; the Feed's stays where it is.
        if (target.getState().composer.draft !== null) return false;
        const source = composer.scope === null ? null : viewFor(composer.scope);
        let draft = composer.draft ?? blankLedgerViewDraft('TASK');
        if (source !== null) {
          const released = source.getState().releaseDraft();
          if (released === null) return false;
          draft = released;
        }
        const from = composer.scope?.projectId ?? composer.projectId;
        const draftId = composer.draftId ?? newDraftId();
        if (
          !target
            .getState()
            .adoptDraft(movedDraft(draft, from === scope.projectId), draftId)
        ) {
          source?.getState().adoptDraft(draft, draftId);
          return false;
        }
        set({
          composer: {
            shown: composer.shown,
            projectId: scope.projectId,
            scope,
            draft: null,
            draftId,
          },
        });
        return true;
      },
      hideEntry: (): void => {
        set((state) => ({ composer: { ...state.composer, shown: false } }));
      },
      closeEntry: (): void => {
        set({ composer: CLOSED_FEED_COMPOSER });
      },
      reloadRemoteDetail,
      loadMoreRemoteHistory,
      reset: (): void => {
        listGeneration += 1;
        detailGeneration += 1;
        checkGeneration += 1;
        ownEntries.clear();
        set((state) => ({
          audience: 'mine',
          queryText: '',
          filters: DEFAULT_LEDGER_FEED_FILTERS,
          list: { ...IDLE_LIST, generation: state.list.generation },
          actors: {},
          newActivity: false,
          selectedEntryId: null,
          selectedScope: null,
          remoteDetail: IDLE_REMOTE_DETAIL,
          composer: CLOSED_FEED_COMPOSER,
          scrollTop: 0,
        }));
      },
      setScrollTop: (scrollTop): void => {
        set({ scrollTop });
      },
    };
  });
}
