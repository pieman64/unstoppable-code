import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { LedgerClient, LedgerFeedClient } from '@canopy/app-core';
import { isLedgerTerminalStatus } from '@canopy/protocol/canopy-core';
import type {
  LedgerActorLabel,
  LedgerEntriesSearchResult,
  LedgerEntrySearchItem,
  LedgerStatus,
  LedgerUpdateEntryParams,
} from '@canopy/protocol/canopy-core';
import {
  ledgerViewScopeKey,
  type LedgerFeedPage,
  type LedgerFeedRequest,
  type LedgerFeedRow,
  type LedgerFeedWorkPage,
  type LedgerFeedWorkRow,
  type LedgerViewChangedEvent,
  type LedgerViewEntry,
  type LedgerViewResult,
  type LedgerViewScope,
  type LedgerViewSearchRequest,
  type LedgerViewUpdateRequest,
  type LedgerViewActorHost,
  type LedgerViewReceipt,
} from '@canopy/protocol/ledger-view';
import { DEFAULT_LEDGER_FEED_FILTERS } from './create-ledger-feed-store';
import {
  DEFAULT_LEDGER_WORK_SORT,
  LEDGER_WORK_STATUS_SORT,
  ledgerWorkTreeRows,
  nextLedgerWorkSort,
  type LedgerWorkSort,
  type LedgerWorkSortColumn,
  type LedgerWorkStatus,
} from './ledger-feed-work';
import {
  problemOf,
  thrownResult,
  withActors,
  type LedgerViewProblem,
} from './ledger-view-results';
import { readLedgerOpenDescendants } from './ledger-open-descendants';
import {
  reuseLedgerItems,
  reuseLedgerValue,
} from './ledger-structural-sharing';
import { defaultLedgerRequestKey } from './ledger-view-writes';

const REVIEW_PAGE_LIMIT = 100;
const OPEN_TASK_STATUSES: readonly LedgerStatus[] = [
  'TODO',
  'IN_PROGRESS',
  'BLOCKED',
  'NEEDS_REVIEW',
];

export interface LedgerFeedWorkListState {
  readonly status: 'idle' | 'loading' | 'ready' | 'problem';
  readonly rows: readonly LedgerFeedWorkRow[];
  readonly actorHosts: Readonly<Record<string, LedgerViewActorHost>>;
  readonly olderCount: number;
  readonly truncated: boolean;
  readonly problem: LedgerViewProblem | null;
  /** A successful page stays visible while the next one is loading. */
  readonly settled: boolean;
}

export interface LedgerWorkTreeState {
  readonly status: 'loading' | 'ready' | 'problem';
  readonly scope: LedgerViewScope;
  readonly nodes: readonly LedgerEntrySearchItem[];
  readonly problem: LedgerViewProblem | null;
}

export interface LedgerFeedWorkReviewsState {
  readonly status: 'idle' | 'loading' | 'ready' | 'problem';
  readonly rows: readonly LedgerFeedRow[];
  readonly problem: LedgerViewProblem | null;
}

export interface LedgerFeedWorkStoreOptions {
  readonly scope?: LedgerViewScope;
  readonly sort?: 'status';
  readonly newRequestKey?: () => string;
}

export interface LedgerFeedWorkCloseIntent {
  readonly entryId: string;
  /** Exact for rollups; a lower bound for the one-row review descendant probe. */
  readonly openCount: number;
  readonly openCountIsLowerBound: boolean;
  /** Which list asked, so only that list shows the choice. */
  readonly origin: 'row' | 'review';
}

export type LedgerFeedWorkActionResult =
  /** `needsChoice`: nothing was written; the close waits on `closeIntent`. */
  | { readonly ok: true; readonly needsChoice?: true }
  | { readonly ok: false; readonly message: string };

export type LedgerFeedWorkMoveResult = LedgerFeedWorkActionResult & {
  readonly moved: number;
};

interface CloseTarget {
  readonly entryId: string;
  readonly scope: LedgerViewScope;
  readonly expectedRevision?: number;
}

export interface LedgerFeedWorkState {
  readonly work: LedgerFeedWorkListState;
  readonly actors: Readonly<Record<string, LedgerActorLabel>>;
  readonly olderShown: boolean;
  readonly statusFilter: LedgerWorkStatus | null;
  readonly sort: LedgerWorkSort;
  readonly openIds: readonly string[];
  readonly trees: Readonly<Record<string, LedgerWorkTreeState>>;
  readonly reviews: LedgerFeedWorkReviewsState;
  readonly closeIntent: LedgerFeedWorkCloseIntent | null;
  readonly load: (options?: { readonly refresh?: boolean }) => Promise<void>;
  /** Lists the older rows already loaded; reads nothing. */
  readonly showOlder: () => void;
  readonly hideOlder: () => void;
  readonly setStatusFilter: (status: LedgerWorkStatus | null) => void;
  readonly toggleSort: (column: LedgerWorkSortColumn) => void;
  readonly toggleOpen: (entryId: string) => Promise<void>;
  readonly loadReviews: () => Promise<void>;
  /**
   * `origin` says which list shows the close choice when one is needed;
   * by default an id is an Operations row and a Feed row is a review.
   */
  readonly markCompleted: (
    row: LedgerFeedRow | string,
    options?: { readonly origin?: LedgerFeedWorkCloseIntent['origin'] },
  ) => Promise<LedgerFeedWorkActionResult>;
  readonly resolveCloseIntent: (
    choice: 'cancel' | 'detach' | 'complete',
  ) => Promise<LedgerFeedWorkActionResult>;
  readonly moveOutOpenTasks: (
    entryId: string,
  ) => Promise<LedgerFeedWorkMoveResult>;
  /** Subscribes to Ledger changes; the caller owns the returned cleanup. */
  readonly connect: () => () => void;
  readonly reset: () => void;
}

export type LedgerFeedWorkStore = UseBoundStore<StoreApi<LedgerFeedWorkState>>;

const IDLE_WORK: LedgerFeedWorkListState = {
  status: 'idle',
  rows: [],
  actorHosts: {},
  olderCount: 0,
  truncated: false,
  problem: null,
  settled: false,
};

const IDLE_REVIEWS: LedgerFeedWorkReviewsState = {
  status: 'idle',
  rows: [],
  problem: null,
};

function sameScope(left: LedgerViewScope, right: LedgerViewScope): boolean {
  return ledgerViewScopeKey(left) === ledgerViewScopeKey(right);
}

function receivedUpdateProblem(
  result: Exclude<LedgerViewResult<unknown>, { status: 'ok' }>,
): string {
  const problem = problemOf(result);
  return problem.kind === 'error' ? problem.message : problem.reason;
}

/** Moving a task moves its whole subtree, so never update its open children. */
function nearestOpenTasks(
  rootEntryId: string,
  entries: readonly LedgerEntrySearchItem[],
): LedgerEntrySearchItem[] {
  const byId = new Map(entries.map((entry) => [entry.entryId, entry]));
  return ledgerWorkTreeRows(entries).flatMap(({ entry }) => {
    if (
      entry.entryId === rootEntryId ||
      entry.type !== 'TASK' ||
      !OPEN_TASK_STATUSES.includes(entry.status)
    )
      return [];
    let parentId = entry.parentEntryId;
    const visited = new Set<string>([entry.entryId]);
    while (parentId !== undefined && parentId !== rootEntryId) {
      if (visited.has(parentId)) return [];
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (parent === undefined) return [];
      if (parent.type === 'TASK' && OPEN_TASK_STATUSES.includes(parent.status))
        return [];
      parentId = parent.parentEntryId;
    }
    return parentId === rootEntryId ? [entry] : [];
  });
}

/** The independent Operations/Needs you store for Feed variant E. */
export function createLedgerFeedWorkStore(
  feedClient: LedgerFeedClient,
  client: LedgerClient,
  options: LedgerFeedWorkStoreOptions = {},
): LedgerFeedWorkStore {
  const newRequestKey = options.newRequestKey ?? defaultLedgerRequestKey;
  const initialSort =
    options.sort === 'status'
      ? LEDGER_WORK_STATUS_SORT
      : DEFAULT_LEDGER_WORK_SORT;
  let closeTarget: CloseTarget | null = null;
  let workGeneration = 0;
  let reviewGeneration = 0;
  const treeGenerations = new Map<string, number>();

  return create<LedgerFeedWorkState>((set, get) => {
    const load = async (
      loadOptions: { readonly refresh?: boolean } = {},
    ): Promise<void> => {
      const generation = ++workGeneration;
      // A settled list refreshes in place: it never reads as loading again.
      if (!get().work.settled) {
        set((state) => ({
          work: { ...state.work, status: 'loading', problem: null },
        }));
      }

      let result: LedgerViewResult<LedgerFeedWorkPage>;
      try {
        // Older rows always load, marked `older`, so counts include them;
        // the list shows them once the person asks.
        result = await feedClient.listFeedWork({
          includeOlder: true,
          ...(options.scope === undefined ? {} : { scope: options.scope }),
          ...(loadOptions.refresh === true ? { refresh: true } : {}),
        });
      } catch (error) {
        result = thrownResult(error);
      }
      if (generation !== workGeneration) return;
      if (result.status !== 'ok') {
        set((state) => ({
          work: {
            ...state.work,
            status: 'problem',
            problem: problemOf(result),
          },
        }));
        return;
      }
      const page = result.value;
      set((state) => {
        const previous = state.work;
        const rows = reuseLedgerItems(
          previous.rows,
          page.rows,
          (row) => `${row.ledgerId}\n${row.item.entryId}`,
        );
        const actorHosts = reuseLedgerValue(
          previous.actorHosts,
          page.actorHosts,
        );
        const actors = withActors(state.actors, page.actors);
        const unchanged =
          previous.status === 'ready' &&
          previous.settled &&
          previous.problem === null &&
          rows === previous.rows &&
          actorHosts === previous.actorHosts &&
          previous.olderCount === page.olderCount &&
          previous.truncated === page.truncated;
        if (unchanged && actors === state.actors) return state;
        return {
          work: unchanged
            ? previous
            : {
                status: 'ready',
                rows,
                actorHosts,
                olderCount: page.olderCount,
                truncated: page.truncated,
                problem: null,
                settled: true,
              },
          actors,
        };
      });
    };

    const loadTree = async (
      entryId: string,
      requestedScope?: LedgerViewScope,
    ): Promise<void> => {
      if (!get().openIds.includes(entryId)) return;
      const row = get().work.rows.find(
        (candidate) => candidate.item.entryId === entryId,
      );
      const existingTree = get().trees[entryId];
      const scope = requestedScope ?? existingTree?.scope ?? row?.scope;
      if (scope === undefined) return;

      const generation = (treeGenerations.get(entryId) ?? 0) + 1;
      treeGenerations.set(entryId, generation);
      // A loaded tree stays on screen while it reads again.
      if (existingTree?.status !== 'ready') {
        set((state) => ({
          trees: {
            ...state.trees,
            [entryId]: {
              status: 'loading',
              scope,
              nodes: state.trees[entryId]?.nodes ?? [],
              problem: null,
            },
          },
        }));
      }

      const entries: LedgerEntrySearchItem[] = [];
      let cursor: string | undefined;
      do {
        const request: LedgerViewSearchRequest = {
          scope,
          params: {
            rootEntryId: entryId,
            limit: REVIEW_PAGE_LIMIT,
            ...(cursor === undefined ? {} : { cursor }),
          },
        };
        let result: LedgerViewResult<LedgerEntriesSearchResult>;
        try {
          result = await client.searchEntries(request);
        } catch (error) {
          result = thrownResult(error);
        }
        if (
          treeGenerations.get(entryId) !== generation ||
          !get().openIds.includes(entryId)
        ) {
          return;
        }
        if (result.status !== 'ok') {
          set((state) => ({
            trees: {
              ...state.trees,
              [entryId]: {
                status: 'problem',
                scope,
                nodes: state.trees[entryId]?.nodes ?? [],
                problem: problemOf(result),
              },
            },
          }));
          return;
        }
        entries.push(...result.value.entries);
        const labels = result.value.actors;
        set((state) => {
          const actors = withActors(state.actors, labels);
          return actors === state.actors ? state : { actors };
        });
        cursor = result.value.nextCursor ?? undefined;
      } while (cursor !== undefined);

      if (
        treeGenerations.get(entryId) !== generation ||
        !get().openIds.includes(entryId)
      ) {
        return;
      }
      const ordered = ledgerWorkTreeRows(entries).map(
        (treeRow) => treeRow.entry,
      );
      set((state) => {
        const previous = state.trees[entryId];
        const nodes = reuseLedgerItems(
          previous?.nodes ?? [],
          ordered,
          (node) => node.entryId,
        );
        if (
          previous?.status === 'ready' &&
          previous.nodes === nodes &&
          previous.problem === null &&
          sameScope(previous.scope, scope)
        ) {
          return state;
        }
        return {
          trees: {
            ...state.trees,
            [entryId]: { status: 'ready', scope, nodes, problem: null },
          },
        };
      });
    };

    const loadReviews = async (): Promise<void> => {
      const generation = ++reviewGeneration;
      // Reviews already shown stay while they read again.
      if (get().reviews.status !== 'ready') {
        set((state) => ({
          reviews: { ...state.reviews, status: 'loading', problem: null },
        }));
      }
      const rows: LedgerFeedRow[] = [];
      let cursor: string | undefined;
      while (rows.length < REVIEW_PAGE_LIMIT) {
        const request: LedgerFeedRequest = {
          audience: 'this_device',
          ...(options.scope === undefined ? {} : { scope: options.scope }),
          query: '',
          filters: {
            ...DEFAULT_LEDGER_FEED_FILTERS,
            statuses: ['NEEDS_REVIEW'],
            owner: 'you',
          },
          ...(cursor === undefined ? { refresh: true } : { cursor }),
        };
        let result: LedgerViewResult<LedgerFeedPage>;
        try {
          result = await feedClient.searchFeed(request);
        } catch (error) {
          result = thrownResult(error);
        }
        if (generation !== reviewGeneration) return;
        if (result.status !== 'ok') {
          set((state) => ({
            reviews: {
              ...state.reviews,
              status: 'problem',
              problem: problemOf(result),
            },
          }));
          return;
        }
        const available = REVIEW_PAGE_LIMIT - rows.length;
        rows.push(...result.value.rows.slice(0, available));
        const labels = result.value.actors;
        set((state) => {
          const actors = withActors(state.actors, labels);
          return actors === state.actors ? state : { actors };
        });
        cursor = result.value.nextCursor ?? undefined;
        if (cursor === undefined) break;
      }
      if (generation !== reviewGeneration) return;
      set((state) => {
        const previous = state.reviews;
        const kept = reuseLedgerItems(
          previous.rows,
          rows,
          (row) => `${row.ledgerId}\n${row.entry.entryId}`,
        );
        if (
          previous.status === 'ready' &&
          previous.problem === null &&
          kept === previous.rows
        ) {
          return state;
        }
        return { reviews: { status: 'ready', rows: kept, problem: null } };
      });
    };

    const update = async (
      scope: LedgerViewScope,
      params: LedgerUpdateEntryParams,
    ): Promise<LedgerFeedWorkActionResult> => {
      let result: LedgerViewResult<LedgerViewReceipt>;
      try {
        const request: LedgerViewUpdateRequest = {
          scope,
          requestKey: newRequestKey(),
          params,
        };
        result = await client.updateEntry(request);
      } catch (error) {
        result = thrownResult(error);
      }
      return result.status === 'ok'
        ? { ok: true }
        : { ok: false, message: receivedUpdateProblem(result) };
    };

    const reloadAfterWrite = async (entryId: string): Promise<void> => {
      await Promise.all([loadReviews(), load(), loadTree(entryId)]);
    };

    const completeTarget = async (
      target: CloseTarget,
      openChildren?: 'detach' | 'complete',
    ): Promise<LedgerFeedWorkActionResult> => {
      let expectedRevision = target.expectedRevision;
      if (expectedRevision === undefined) {
        let result: LedgerViewResult<LedgerViewEntry>;
        try {
          result = await client.getEntry({
            scope: target.scope,
            entryId: target.entryId,
          });
        } catch (error) {
          result = thrownResult(error);
        }
        if (result.status !== 'ok')
          return { ok: false, message: receivedUpdateProblem(result) };
        expectedRevision = result.value.entry.entry.revision;
      }
      const outcome = await update(target.scope, {
        entryId: target.entryId,
        expectedRevision,
        status: 'COMPLETED',
        ...(openChildren === undefined ? {} : { openChildren }),
      });
      if (outcome.ok) await reloadAfterWrite(target.entryId);
      return outcome;
    };

    return {
      work: IDLE_WORK,
      actors: {},
      olderShown: false,
      statusFilter: null,
      sort: initialSort,
      openIds: [],
      trees: {},
      reviews: IDLE_REVIEWS,
      closeIntent: null,
      load,
      showOlder: (): void => {
        set({ olderShown: true });
      },
      hideOlder: (): void => {
        set({ olderShown: false });
      },
      setStatusFilter: (status): void => {
        set({ statusFilter: status });
      },
      toggleSort: (column): void => {
        set((state) => ({ sort: nextLedgerWorkSort(state.sort, column) }));
      },
      toggleOpen: async (entryId): Promise<void> => {
        if (get().openIds.includes(entryId)) {
          treeGenerations.set(entryId, (treeGenerations.get(entryId) ?? 0) + 1);
          set((state) => {
            const trees = { ...state.trees };
            delete trees[entryId];
            return {
              openIds: state.openIds.filter((openId) => openId !== entryId),
              trees,
            };
          });
          return;
        }
        const row = get().work.rows.find(
          (candidate) => candidate.item.entryId === entryId,
        );
        if (row === undefined) return;
        set((state) => ({ openIds: [...state.openIds, entryId] }));
        await loadTree(entryId, row.scope);
      },
      loadReviews,
      markCompleted: async (
        row,
        options,
      ): Promise<LedgerFeedWorkActionResult> => {
        let target: CloseTarget;
        let parentEntryId: string | undefined;
        if (typeof row === 'string') {
          const workRow = get().work.rows.find(
            (candidate) => candidate.item.entryId === row,
          );
          if (workRow === undefined)
            return { ok: false, message: 'This entry is no longer available.' };
          // Operations rows are top-level work.
          target = { entryId: row, scope: workRow.scope };
        } else {
          if (row.origin.kind !== 'this_device') {
            return { ok: false, message: 'This entry is read-only.' };
          }
          target = {
            entryId: row.entry.entryId,
            scope: row.origin.scope,
            expectedRevision: row.entry.revision,
          };
          parentEntryId = row.entry.parentEntryId;
        }
        // Rollups flag child tasks only, and their leaf counts miss an open
        // task whose own tasks are closed, so read every open entry under it.
        const open = await readLedgerOpenDescendants(
          client,
          target.scope,
          target.entryId,
          parentEntryId,
        );
        if (open.status !== 'ok')
          return { ok: false, message: receivedUpdateProblem(open) };
        const openCount = open.value.count;
        const openCountIsLowerBound = open.value.lowerBound;
        if (openCount > 0) {
          closeTarget = target;
          set({
            closeIntent: {
              entryId: target.entryId,
              openCount,
              openCountIsLowerBound,
              origin:
                options?.origin ?? (typeof row === 'string' ? 'row' : 'review'),
            },
          });
          return { ok: true, needsChoice: true };
        }
        return completeTarget(target);
      },
      resolveCloseIntent: async (
        choice,
      ): Promise<LedgerFeedWorkActionResult> => {
        const target = closeTarget;
        if (choice === 'cancel') {
          closeTarget = null;
          set({ closeIntent: null });
          return { ok: true };
        }
        if (target === null) return { ok: true };
        const outcome = await completeTarget(target, choice);
        if (outcome.ok && closeTarget === target) {
          closeTarget = null;
          set({ closeIntent: null });
        }
        return outcome;
      },
      moveOutOpenTasks: async (entryId): Promise<LedgerFeedWorkMoveResult> => {
        const row = get().work.rows.find(
          (candidate) => candidate.item.entryId === entryId,
        );
        if (
          row === undefined ||
          row.item.type !== 'OPERATION' ||
          !isLedgerTerminalStatus(row.item.status)
        ) {
          return {
            ok: false,
            moved: 0,
            message: 'This operation is not closed.',
          };
        }
        const entries: LedgerEntrySearchItem[] = [];
        let cursor: string | undefined;
        do {
          let result: LedgerViewResult<LedgerEntriesSearchResult>;
          try {
            result = await client.searchEntries({
              scope: row.scope,
              params: {
                rootEntryId: entryId,
                limit: REVIEW_PAGE_LIMIT,
                ...(cursor === undefined ? {} : { cursor }),
              },
            });
          } catch (error) {
            result = thrownResult(error);
          }
          if (result.status !== 'ok')
            return {
              ok: false,
              moved: 0,
              message: receivedUpdateProblem(result),
            };
          entries.push(...result.value.entries);
          cursor = result.value.nextCursor ?? undefined;
        } while (cursor !== undefined);
        let moved = 0;
        for (const task of nearestOpenTasks(entryId, entries)) {
          const outcome = await update(row.scope, {
            entryId: task.entryId,
            expectedRevision: task.revision,
            parentEntryId: null,
          });
          if (!outcome.ok) {
            if (moved > 0) await reloadAfterWrite(entryId);
            return { ...outcome, moved };
          }
          moved += 1;
        }
        await reloadAfterWrite(entryId);
        return { ok: true, moved };
      },
      connect: (): (() => void) => {
        let reloadRunning = false;
        let reloadQueued = false;
        let reloadAllTrees = false;
        const reloadScopes: LedgerViewScope[] = [];

        const addReloadScope = (scope: LedgerViewScope): void => {
          if (!reloadScopes.some((candidate) => sameScope(candidate, scope))) {
            reloadScopes.push(scope);
          }
        };

        const runReloads = async (): Promise<void> => {
          if (reloadRunning) return;
          reloadRunning = true;
          try {
            while (reloadQueued) {
              reloadQueued = false;
              const reloadAll = reloadAllTrees;
              reloadAllTrees = false;
              const scopes = reloadScopes.splice(0, reloadScopes.length);
              const openTreeIds = get().openIds.filter((entryId) => {
                const tree = get().trees[entryId];
                return (
                  tree !== undefined &&
                  (reloadAll ||
                    scopes.some((scope) => sameScope(scope, tree.scope)))
                );
              });
              await Promise.all([
                load(),
                loadReviews(),
                ...openTreeIds.map((entryId) => loadTree(entryId)),
              ]);
            }
          } finally {
            reloadRunning = false;
            if (reloadQueued) void runReloads();
          }
        };

        const handleChange = (event: LedgerViewChangedEvent): void => {
          const scope = options.scope;
          if (
            scope !== undefined &&
            event.syncChanged !== 'all' &&
            !event.changes.some((change) => sameScope(change.scope, scope)) &&
            !(event.syncChanged ?? []).some((changedScope) =>
              sameScope(changedScope, scope),
            )
          )
            return;
          for (const change of event.changes) addReloadScope(change.scope);
          if (event.syncChanged === 'all') {
            reloadAllTrees = true;
          } else {
            for (const scope of event.syncChanged ?? []) addReloadScope(scope);
          }
          reloadQueued = true;
          void runReloads();
        };

        let unsubscribe: () => void;
        try {
          unsubscribe = client.subscribeChanges(handleChange);
        } catch {
          return (): void => undefined;
        }
        // Changes went unheard while nothing was connected; open trees read
        // again, as the host reloads the work and reviews itself.
        for (const entryId of get().openIds) {
          if (get().trees[entryId] !== undefined) void loadTree(entryId);
        }
        return unsubscribe;
      },
      reset: (): void => {
        closeTarget = null;
        workGeneration += 1;
        reviewGeneration += 1;
        for (const [entryId, generation] of Array.from(treeGenerations)) {
          treeGenerations.set(entryId, generation + 1);
        }
        set({
          work: IDLE_WORK,
          actors: {},
          olderShown: false,
          statusFilter: null,
          sort: initialSort,
          openIds: [],
          trees: {},
          reviews: IDLE_REVIEWS,
          closeIntent: null,
        });
      },
    };
  });
}
