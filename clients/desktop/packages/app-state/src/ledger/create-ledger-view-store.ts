import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { LedgerClient } from '@canopy/app-core';
import type {
  LedgerActorLabel,
  LedgerEntriesSearchParams,
  LedgerEntriesSearchResult,
  LedgerEntrySearchItem,
} from '@canopy/protocol/canopy-core';
import type {
  LedgerViewChangedEvent,
  LedgerViewEntry,
  LedgerViewFilters,
  LedgerViewResult,
  LedgerViewScope,
} from '@canopy/protocol/ledger-view';
import {
  normalizeQuery,
  problemOf,
  thrownResult,
  withActors,
  type LedgerViewProblem,
} from './ledger-view-results';
import {
  CLOSED_COMPOSER,
  EMPTY_LEDGER_VIEW_CORRECTIONS,
  IDLE_CHANGE,
  IDLE_OWNERS,
  createLedgerViewWriteSlice,
  defaultLedgerRequestKey,
  type LedgerViewWriteSlice,
} from './ledger-view-writes';

/*
 * One work scope's Ledger view: the filtered entry list, its cursor, the
 * selected entry's detail, the list's scroll position, and the person's
 * draft and changes, so a panel that returns from a source finds everything
 * where it left it. A store belongs to one scope; another scope gets its own
 * store. Entries live in memory only, and every response from a superseded
 * request is dropped.
 */

/** Entries per page, matching the Ledger's default page. */
export const LEDGER_VIEW_PAGE_SIZE = 30;
/** The most a live refresh re-reads in one request (the Ledger's maximum). */
const LEDGER_VIEW_REFRESH_LIMIT = 100;

export type { LedgerViewProblem };

/** Options for selecting an entry in a Ledger view. */
export interface LedgerViewSelectOptions {
  readonly keepDraft?: boolean;
}

export const DEFAULT_LEDGER_VIEW_FILTERS: LedgerViewFilters = {
  types: [],
  statuses: [],
  owner: 'anyone',
};

export interface LedgerViewListState {
  readonly status: 'idle' | 'loading' | 'ready' | 'problem';
  /** Changes whenever a fresh first page establishes a new list placement. */
  readonly generation: number;
  readonly entries: readonly LedgerEntrySearchItem[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly loadMoreProblem: LedgerViewProblem | null;
  readonly problem: LedgerViewProblem | null;
  /**
   * A change of who may read the scope's entries has not reached the cloud
   * yet, as of the last read.
   */
  readonly audienceChangePending: boolean;
  /**
   * The list shows the result of a successful read, even an empty one. A
   * search in flight then leaves it on screen instead of flashing a loading
   * state between results. Before the first result, and after a failed read,
   * which leaves nothing to keep, a read in flight shows loading.
   */
  readonly settled: boolean;
}

export interface LedgerViewDetailState {
  readonly status: 'idle' | 'loading' | 'ready' | 'problem';
  readonly entryId: string | null;
  readonly view: LedgerViewEntry | null;
  readonly problem: LedgerViewProblem | null;
  readonly loadingMoreHistory: boolean;
}

export interface LedgerViewState extends LedgerViewWriteSlice {
  readonly scope: LedgerViewScope;
  readonly queryText: string;
  readonly filters: LedgerViewFilters;
  readonly list: LedgerViewListState;
  readonly selectedEntryId: string | null;
  readonly detail: LedgerViewDetailState;
  /** Every actor label the loaded entries and detail name, by actor ID. */
  readonly actors: Readonly<Record<string, LedgerActorLabel>>;
  readonly scrollTop: number;
  /** Reads the first page for the current query and filters. */
  readonly load: () => Promise<void>;
  /** Changes the query text; the caller decides when to `load`. */
  readonly setQueryText: (text: string) => void;
  /** Changes the filters and reads the first page again. */
  readonly setFilters: (filters: LedgerViewFilters) => Promise<void>;
  readonly loadMore: () => Promise<void>;
  /** Selects an entry and reads its detail; null clears the selection. */
  readonly select: (
    entryId: string | null,
    options?: LedgerViewSelectOptions,
  ) => Promise<void>;
  readonly reloadDetail: () => Promise<void>;
  readonly loadMoreHistory: () => Promise<void>;
  /**
   * Re-reads what a batch of committed changes made stale, and the sync
   * states that changed with them.
   */
  readonly applyChanges: (event: LedgerViewChangedEvent) => void;
  /**
   * Re-reads what the view shows in place, keeping the query, filters,
   * selection and scroll position: for a panel that shows the view again
   * after changes it did not hear about.
   */
  readonly revalidate: () => Promise<void>;
  /** Forgets everything read and drops reads in flight, as before first use. */
  readonly reset: () => void;
  readonly setScrollTop: (scrollTop: number) => void;
}

export type LedgerViewStore = UseBoundStore<StoreApi<LedgerViewState>>;

const IDLE_LIST: LedgerViewListState = {
  status: 'idle',
  generation: 0,
  entries: [],
  nextCursor: null,
  hasMore: false,
  loadingMore: false,
  loadMoreProblem: null,
  problem: null,
  audienceChangePending: false,
  settled: false,
};

function isAudienceChangePending(result: LedgerEntriesSearchResult): boolean {
  return result.scopeSync?.audienceChangePending ?? false;
}

const IDLE_DETAIL: LedgerViewDetailState = {
  status: 'idle',
  entryId: null,
  view: null,
  problem: null,
  loadingMoreHistory: false,
};

/** The search a view runs for its query and filters. */
export function ledgerViewSearchParams(
  queryText: string,
  filters: LedgerViewFilters,
  page: { readonly cursor?: string; readonly limit: number },
): LedgerEntriesSearchParams {
  const query = normalizeQuery(queryText);
  return {
    ...(query.length > 0 ? { query } : {}),
    ...(filters.types.length > 0 ? { types: [...filters.types] } : {}),
    ...(filters.statuses.length > 0 ? { statuses: [...filters.statuses] } : {}),
    ...(filters.owner === 'you' ? { owner: 'self' as const } : {}),
    sort: 'created_desc',
    limit: page.limit,
    ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
  };
}

/** Appends a page, dropping entries an earlier page already holds. */
function appendPage(
  entries: readonly LedgerEntrySearchItem[],
  page: readonly LedgerEntrySearchItem[],
): LedgerEntrySearchItem[] {
  const seen = new Set(entries.map((entry) => entry.entryId));
  return [...entries, ...page.filter((entry) => !seen.has(entry.entryId))];
}

export interface LedgerViewStoreOptions {
  /** A new request key for each draft or change; random UUIDs by default. */
  readonly newRequestKey?: () => string;
}

export function createLedgerViewStore(
  client: LedgerClient,
  scope: LedgerViewScope,
  options: LedgerViewStoreOptions = {},
): LedgerViewStore {
  // Each new request of a kind supersedes the previous one; a response is
  // applied only if no newer request of its kind started meanwhile.
  let listGeneration = 0;
  let detailGeneration = 0;
  /**
   * Whether the detail shown is known to be out of date: something changed
   * the entry, and no read has succeeded since.
   */
  let detailOutdated = false;
  /** The refresh in flight, if any. */
  let refreshing: Promise<void> | null = null;
  let refreshQueued = false;

  return create<LedgerViewState>((set, get) => {
    const search = async (
      params: LedgerEntriesSearchParams,
    ): Promise<LedgerViewResult<LedgerEntriesSearchResult>> => {
      try {
        return await client.searchEntries({ scope, params });
      } catch (error) {
        return thrownResult(error);
      }
    };

    const readDetail = async (
      entryId: string,
      historyCursor?: string,
    ): Promise<LedgerViewResult<LedgerViewEntry>> => {
      try {
        return await client.getEntry({
          scope,
          entryId,
          ...(historyCursor === undefined ? {} : { historyCursor }),
        });
      } catch (error) {
        return thrownResult(error);
      }
    };

    const load = async (): Promise<void> => {
      const generation = ++listGeneration;
      const { queryText, filters } = get();
      set((state) => ({
        list: {
          ...IDLE_LIST,
          status: 'loading',
          generation: state.list.generation,
          entries: state.list.entries,
          settled: state.list.settled,
        },
      }));
      const result = await search(
        ledgerViewSearchParams(queryText, filters, {
          limit: LEDGER_VIEW_PAGE_SIZE,
        }),
      );
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
      set((state) => ({
        list: {
          ...IDLE_LIST,
          status: 'ready',
          generation: state.list.generation + 1,
          entries: result.value.entries,
          nextCursor: result.value.nextCursor,
          hasMore: result.value.hasMore,
          audienceChangePending: isAudienceChangePending(result.value),
          settled: true,
        },
        actors: withActors(state.actors, result.value.actors),
        scrollTop: 0,
      }));
    };

    /** One refresh's reads; see `refresh`. */
    const rereadLoaded = async (): Promise<void> => {
      const { list, queryText, filters } = get();
      const generation = ++listGeneration;
      const wanted = Math.max(LEDGER_VIEW_PAGE_SIZE, list.entries.length);
      // A bound in case pages stop making progress.
      const maxRequests = Math.ceil(wanted / LEDGER_VIEW_REFRESH_LIMIT) + 1;
      let entries: LedgerEntrySearchItem[] = [];
      let labels: LedgerActorLabel[] = [];
      let nextCursor: string | null = null;
      let hasMore = true;
      let audienceChangePending = list.audienceChangePending;
      for (
        let request = 0;
        request < maxRequests && hasMore && entries.length < wanted;
        request += 1
      ) {
        const result = await search(
          ledgerViewSearchParams(queryText, filters, {
            limit: Math.min(LEDGER_VIEW_REFRESH_LIMIT, wanted - entries.length),
            ...(nextCursor === null ? {} : { cursor: nextCursor }),
          }),
        );
        if (generation !== listGeneration) return;
        if (result.status !== 'ok') {
          // What is shown stays. A "load more" this refresh replaced is
          // over, so the next page can still be asked for.
          set((state) => ({ list: { ...state.list, loadingMore: false } }));
          return;
        }
        entries = appendPage(entries, result.value.entries);
        labels = [...labels, ...(result.value.actors ?? [])];
        nextCursor = result.value.nextCursor;
        hasMore = result.value.hasMore && nextCursor !== null;
        // The first page carries the scope's state as of this refresh.
        if (request === 0) {
          audienceChangePending = isAudienceChangePending(result.value);
        }
      }
      set((state) => ({
        list: {
          ...state.list,
          entries,
          nextCursor,
          hasMore,
          loadingMore: false,
          loadMoreProblem: null,
          audienceChangePending,
        },
        actors: withActors(state.actors, labels),
      }));
    };

    /**
     * Re-reads the loaded entries in place after committed changes, without
     * a loading state or a scroll reset. It reads as many rows as the list
     * holds, a request at a time, so a long list keeps its length. Changes
     * during a refresh queue one more refresh. Resolves when the refresh in
     * flight settles.
     */
    const refresh = (): Promise<void> => {
      if (refreshing !== null) {
        refreshQueued = true;
        return refreshing;
      }
      if (get().list.status !== 'ready') return Promise.resolve();
      const run = rereadLoaded().finally((): void => {
        refreshing = null;
        if (refreshQueued) {
          refreshQueued = false;
          void refresh();
        }
      });
      refreshing = run;
      return run;
    };

    const fetchDetail = async (
      entryId: string,
      options: { readonly quiet: boolean },
    ): Promise<void> => {
      const generation = ++detailGeneration;
      if (!options.quiet) {
        set({
          detail: { ...IDLE_DETAIL, status: 'loading', entryId },
        });
      }
      const result = await readDetail(entryId);
      if (generation !== detailGeneration) return;
      if (result.status !== 'ok') {
        // A quiet refresh keeps what is shown when the re-read fails, unless
        // what is shown is known to be out of date.
        if (
          options.quiet &&
          get().detail.status === 'ready' &&
          !detailOutdated
        ) {
          return;
        }
        set({
          detail: {
            ...IDLE_DETAIL,
            status: 'problem',
            entryId,
            problem: problemOf(result),
          },
        });
        return;
      }
      detailOutdated = false;
      set((state) => ({
        detail: {
          ...IDLE_DETAIL,
          status: 'ready',
          entryId,
          view: result.value,
        },
        actors: withActors(state.actors, result.value.entry.actors),
      }));
    };

    /**
     * Re-reads the shown entry in place once something says it changed: the
     * person's own saved change, or a newer revision announced. Until a read
     * succeeds, what is shown is out of date, so a failed read is a problem.
     */
    const refetchOutdatedDetail = (entryId: string): Promise<void> => {
      detailOutdated = true;
      return fetchDetail(entryId, { quiet: true });
    };

    const writes = createLedgerViewWriteSlice({
      client,
      scope,
      get,
      set: (update): void => set(update),
      newRequestKey: options.newRequestKey ?? defaultLedgerRequestKey,
      // A failed list reads again once a write succeeded; an idle one waits
      // for its panel to read it.
      refreshList: (): Promise<void> => {
        const { status } = get().list;
        if (status === 'ready') return refresh();
        return status === 'problem' ? load() : Promise.resolve();
      },
      // Only while that entry is still the one shown.
      reloadDetail: (entryId): Promise<void> =>
        get().selectedEntryId === entryId
          ? refetchOutdatedDetail(entryId)
          : Promise.resolve(),
      rereadDetail: (entryId): Promise<void> =>
        get().selectedEntryId === entryId
          ? fetchDetail(entryId, { quiet: false })
          : Promise.resolve(),
      select: (entryId, selectOptions): Promise<void> =>
        get().select(entryId, selectOptions),
    });

    return {
      ...writes.slice,
      scope,
      queryText: '',
      filters: DEFAULT_LEDGER_VIEW_FILTERS,
      list: IDLE_LIST,
      selectedEntryId: null,
      detail: IDLE_DETAIL,
      actors: {},
      scrollTop: 0,
      load,
      setQueryText: (text): void => {
        set({ queryText: text });
      },
      setFilters: async (filters): Promise<void> => {
        set({ filters });
        await load();
      },
      loadMore: async (): Promise<void> => {
        if (refreshing !== null) {
          // The refresh in flight replaces the list and its cursor. A page
          // read from the old cursor could skip an entry it pushed down, so
          // page on from where the refresh leaves the list.
          await refreshing;
          return get().loadMore();
        }
        const { list, queryText, filters } = get();
        if (
          list.status !== 'ready' ||
          list.loadingMore ||
          list.nextCursor === null
        ) {
          return;
        }
        const generation = listGeneration;
        set({ list: { ...list, loadingMore: true, loadMoreProblem: null } });
        const result = await search(
          ledgerViewSearchParams(queryText, filters, {
            cursor: list.nextCursor,
            limit: LEDGER_VIEW_PAGE_SIZE,
          }),
        );
        if (generation !== listGeneration) return;
        if (result.status !== 'ok') {
          if (result.status === 'error' && result.reason === 'CURSOR_EXPIRED') {
            // The cursor outlived its snapshot: start again from the top.
            await load();
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
            entries: appendPage(state.list.entries, result.value.entries),
            nextCursor: result.value.nextCursor,
            hasMore: result.value.hasMore,
            loadingMore: false,
            loadMoreProblem: null,
          },
          actors: withActors(state.actors, result.value.actors),
        }));
      },
      select: async (entryId, selectOptions): Promise<void> => {
        detailOutdated = false;
        set((state) => ({
          selectedEntryId: entryId,
          // A draft stays, set aside, until saved or discarded.
          composer: {
            ...state.composer,
            shown:
              selectOptions?.keepDraft === true ? state.composer.shown : false,
          },
          // An entry whose change is still unanswered stays saving.
          change:
            state.selectedEntryId === entryId
              ? state.change
              : writes.changeFor(entryId),
        }));
        if (entryId === null) {
          detailGeneration += 1;
          set({ detail: IDLE_DETAIL });
          return;
        }
        await fetchDetail(entryId, { quiet: false });
      },
      reloadDetail: async (): Promise<void> => {
        const { selectedEntryId } = get();
        if (selectedEntryId !== null) {
          await fetchDetail(selectedEntryId, { quiet: false });
        }
      },
      loadMoreHistory: async (): Promise<void> => {
        const { detail } = get();
        const cursor = detail.view?.entry.history?.nextCursor ?? null;
        if (
          detail.status !== 'ready' ||
          detail.entryId === null ||
          detail.view === null ||
          cursor === null ||
          detail.loadingMoreHistory
        ) {
          return;
        }
        const generation = detailGeneration;
        const entryId = detail.entryId;
        set({ detail: { ...detail, loadingMoreHistory: true } });
        const result = await readDetail(entryId, cursor);
        if (generation !== detailGeneration) return;
        set((state) => {
          const current = state.detail;
          const previous = current.view;
          if (result.status !== 'ok' || previous === null) {
            return { detail: { ...current, loadingMoreHistory: false } };
          }
          const mutations = [
            ...(previous.entry.history?.mutations ?? []),
            ...(result.value.entry.history?.mutations ?? []),
          ];
          return {
            detail: {
              ...current,
              loadingMoreHistory: false,
              view: {
                ...result.value,
                entry: {
                  ...result.value.entry,
                  history: {
                    mutations,
                    nextCursor: result.value.entry.history?.nextCursor ?? null,
                  },
                },
              },
            },
            actors: withActors(state.actors, result.value.entry.actors),
          };
        });
      },
      applyChanges: (event): void => {
        const isThisScope = (candidate: LedgerViewScope): boolean =>
          candidate.projectId === scope.projectId &&
          candidate.worktreeId === scope.worktreeId;
        const changes = event.changes.filter((change) =>
          isThisScope(change.scope),
        );
        const syncChanged =
          event.syncChanged === 'all' ||
          (event.syncChanged ?? []).some(isThisScope);
        if (changes.length === 0 && !syncChanged) return;
        void refresh();
        const { detail } = get();
        const selected = changes.find(
          (change) => change.entryId === detail.entryId,
        );
        if (
          selected !== undefined &&
          detail.status === 'ready' &&
          detail.view !== null &&
          detail.entryId === selected.entryId
        ) {
          const currentRevision = detail.view.entry.entry.revision;
          if (selected.revision > currentRevision) {
            void refetchOutdatedDetail(selected.entryId);
            return;
          }
          if (
            selected.revision === currentRevision ||
            ('titleResolved' in selected && selected.titleResolved === true)
          ) {
            // Title resolution can change the detail without a new revision.
            // A quiet read keeps the shown entry if this refresh fails.
            void fetchDetail(selected.entryId, { quiet: true });
            return;
          }
        }
        // Only how the entry syncs changed: what is shown stays meanwhile.
        if (
          syncChanged &&
          detail.status === 'ready' &&
          detail.entryId !== null
        ) {
          void fetchDetail(detail.entryId, { quiet: true });
        }
      },
      revalidate: async (): Promise<void> => {
        const { list, detail, selectedEntryId } = get();
        const reads: Array<Promise<void>> = [];
        if (list.status === 'ready') reads.push(refresh());
        else if (list.status === 'problem') reads.push(load());
        if (
          selectedEntryId !== null &&
          (detail.status === 'ready' || detail.status === 'problem')
        ) {
          reads.push(
            fetchDetail(selectedEntryId, {
              quiet: detail.status === 'ready',
            }),
          );
        }
        await Promise.all(reads);
      },
      reset: (): void => {
        listGeneration += 1;
        detailGeneration += 1;
        detailOutdated = false;
        refreshQueued = false;
        writes.reset();
        set((state) => ({
          queryText: '',
          filters: DEFAULT_LEDGER_VIEW_FILTERS,
          list: { ...IDLE_LIST, generation: state.list.generation },
          selectedEntryId: null,
          detail: IDLE_DETAIL,
          actors: {},
          scrollTop: 0,
          composer: CLOSED_COMPOSER,
          corrections: EMPTY_LEDGER_VIEW_CORRECTIONS,
          owners: IDLE_OWNERS,
          change: IDLE_CHANGE,
          savedAdopted: null,
        }));
      },
      setScrollTop: (scrollTop): void => {
        set({ scrollTop });
      },
    };
  });
}
