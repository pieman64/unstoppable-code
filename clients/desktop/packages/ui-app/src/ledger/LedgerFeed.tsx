'use client';

import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import type {
  LedgerClient,
  LedgerFilePicker,
  LedgerNavigator,
} from '@canopy/app-core';
import {
  DEFAULT_LEDGER_FEED_FILTERS,
  type LedgerFeedStore,
  type LedgerViewStore,
  type LedgerViewStoreFor,
} from '@canopy/app-state';
import type {
  LedgerEntrySearchItem,
  LedgerFileRef,
} from '@canopy/protocol/canopy-core';
import type { LedgerScopeKind } from '@canopy/protocol/ledger-sync';
import type {
  LedgerFeedAudience,
  LedgerFeedFilters,
  LedgerFeedNotice,
  LedgerFeedOrigin,
  LedgerFeedRow,
  LedgerViewChange,
  LedgerViewScope,
} from '@canopy/protocol/ledger-view';
import { isLedgerTaskViewScope } from '@canopy/protocol/ledger-view';
import {
  Button,
  EmptyState,
  DelayedLoadingPlaceholder,
  ErrorState,
  Heading,
  LedgerThreadList,
  LedgerThreadListSkeleton,
  Notice,
  NoticeButton,
  ToggleSwitch,
  isLedgerFeedFiltered,
  useRetry,
  type LedgerEntryRowAttribution,
  type LedgerEntryRowDetails,
  type LedgerEntrySlots,
} from '@canopy/ui-shared/components';
import { ledgerActorName } from '@canopy/ui-shared/lib';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { LedgerComposer } from './LedgerComposer';
import {
  FeedComposerRow,
  FeedControls,
  LEDGER_FEED_ALL_AUDIENCES,
} from './ledger-feed-rows';
import {
  ledgerScopeWorkPath,
  type LedgerScopeNamesFor,
} from './ledger-work-path';
import {
  createLedgerScopeActions,
  LedgerEntryReadLoading,
  LedgerEntryReadProblem,
  ledgerReadItem,
  ledgerRestingRowsState,
  ledgerScopeKey,
  ledgerScopeOpenEntry,
  ledgerThreadRootIds,
  useLedgerCorrectionPlacements,
  ledgerWritableEntrySlots,
  ledgerWritableSlotsDeps,
  placeLedgerOpenEntry,
  useLedgerNow,
  useLedgerScopeRowsStates,
  useLedgerSlotsCache,
  type LedgerOpenError,
  type LedgerScopeActions,
  type LedgerScopeRowsState,
} from './ledger-scope-rows';
import { problemCopy } from './ledger-problem-copy';
import {
  LEDGER_GLOBAL_CONTEXT_LABEL,
  ledgerGlobalContextLabel,
} from './ledger-global-labels';
import type { LedgerFeedScopeOption } from './LedgerFeedComposer';

/** Typing settles this long before the search runs. */
const SEARCH_DEBOUNCE_MS = 250;
/** After a committed change, the Feed looks for new activity this much later. */
export const LEDGER_FEED_CHANGE_DELAY_MS = 2_000;
/** While on screen, the Feed looks for new activity this often. */
export const LEDGER_FEED_POLL_MS = 60_000;

/** The person, when the host does not name them. */
const DEFAULT_PERSON_NAME = 'You';

/** A host without a Ledger of its own names none of its scopes. */
function describeNoScope(): null {
  return null;
}

/** A row's work when this device has no name for it. */
const SCOPE_KIND_LABELS: { readonly [Kind in LedgerScopeKind]: string } = {
  code_worktree: 'Worktree',
  cowork_entry: 'Task',
  advisor_entry: ORCHESTRATOR_LABEL,
  global: LEDGER_GLOBAL_CONTEXT_LABEL,
};

/** A row's work as this device names it, else by its owner or kind. */
function localRowContext(
  row: LedgerFeedRow,
  scope: LedgerViewScope,
  describeScope: (scope: LedgerViewScope) => string | null,
): string {
  const described = describeScope(scope);
  if (described !== null) return described;
  if (!isLedgerTaskViewScope(scope)) {
    return ledgerGlobalContextLabel(scope.owner, row.global?.organizationName);
  }
  return SCOPE_KIND_LABELS[row.scopeKind];
}

/** A remote row's work: only a global row names it, by its owner. */
function remoteRowContext(row: LedgerFeedRow): string | undefined {
  if (row.scopeKind !== 'global') return undefined;
  return row.global === undefined
    ? LEDGER_GLOBAL_CONTEXT_LABEL
    : ledgerGlobalContextLabel(row.global.owner, row.global.organizationName);
}

/**
 * What only a host that holds a Ledger itself offers (`ledgerLocal`): its
 * scopes' views and their changes, the composer, corrections, status and
 * owner changes, navigation to sources and files. A host that only reads
 * the mirror (`ledgerFeed` alone) passes none, and its Feed reads only.
 */
export interface LedgerFeedLocal {
  /** This device's Ledger: its committed changes and its scopes' views. */
  readonly client: LedgerClient;
  readonly navigator: LedgerNavigator;
  /** Finds files for an entry's references; without it none can be added. */
  readonly files?: LedgerFilePicker;
  /** The view store of one of this device's scopes, created on first use. */
  readonly scopeStore: LedgerViewStoreFor;
  /** Whether a scope's own view holds a draft, read without creating it. */
  readonly scopeHasDraft: (scope: LedgerViewScope) => boolean;
  /** This device's name for a scope, such as its project and task. */
  readonly describeScope: (scope: LedgerViewScope) => string | null;
  /** The projects and tasks a new entry can go to. */
  readonly addableScopes: readonly LedgerFeedScopeOption[];
}

export interface LedgerFeedProps {
  /** The Feed's view state; it outlives the page, so returning restores it. */
  readonly store: LedgerFeedStore;
  /** This device's Ledger, when the host holds one (`ledgerLocal`). */
  readonly local?: LedgerFeedLocal;
  /** The audience tabs, in order; every one by default. */
  readonly audiences?: readonly LedgerFeedAudience[];
  /** Whether the Feed is on screen; it looks for new activity only then. */
  readonly visible: boolean;
  /** Opens sign-in, for the notice a signed-out Feed shows. */
  readonly onSignIn?: () => void;
  /** The person's name, for the composer and correction avatars. */
  readonly personName?: string;
  /** This device's names for a scope, used for Activity work paths. */
  readonly scopeNames?: LedgerScopeNamesFor;
  /** Opens a scope named by an Activity work path. */
  readonly onOpenScope?: (scope: LedgerViewScope) => void;
  /** An ancestor's scroller; when supplied, this Feed adds no scroll pane. */
  readonly scrollElement?: () => HTMLElement | null;
  /** Adds the page's Activity heading and audience controls. */
  readonly heading?: boolean;
  /** Registers an opener for this device's entries in a known scope. */
  readonly registerLocalEntryOpener?: (
    opener: LedgerFeedLocalEntryOpener | null,
  ) => void;
}

export type LedgerFeedLocalEntryOpener = (
  scope: LedgerViewScope,
  entryId: string,
) => void;

function attributionOf(
  origin: LedgerFeedOrigin,
): LedgerEntryRowAttribution | null {
  switch (origin.kind) {
    case 'this_device':
      return null;
    case 'other_device':
      return { kind: 'device', label: origin.deviceLabel };
    case 'teammate':
      return {
        kind: 'teammate',
        name: origin.teammateName,
        organization: origin.organizationName,
      };
  }
}

/**
 * Who can change a row of another device or a teammate, and where. `key`
 * identifies the note for the slot cache; a teammate's name in `content` is
 * blocked from session replay.
 */
function readOnlyNote(attribution: LedgerEntryRowAttribution | null): {
  readonly key: string;
  readonly content: ReactNode;
} {
  if (attribution?.kind === 'teammate') {
    return {
      key: `teammate:${attribution.name}`,
      content: (
        <>
          <span className={REPLAY_BLOCK_CLASS}>{attribution.name}</span>{' '}
          recorded this entry. Only they can change it.
        </>
      ),
    };
  }
  if (attribution?.kind === 'device') {
    const text = `Recorded on ${attribution.label}. Change it there.`;
    return { key: `device:${text}`, content: text };
  }
  const text = 'Recorded on another device. Change it there.';
  return { key: `device:${text}`, content: text };
}

/** What the Feed could not include, and how to get it back. */
function FeedNotice({
  notice,
  onRetry,
  onSignIn,
}: {
  readonly notice: LedgerFeedNotice | null;
  readonly onRetry: () => void;
  readonly onSignIn: (() => void) | undefined;
}): JSX.Element | null {
  if (notice === 'remote_unavailable') {
    return (
      <Notice
        data-testid="ledger-feed-notice"
        data-notice={notice}
        className="mt-3"
        actions={<NoticeButton onClick={onRetry}>Try again</NoticeButton>}
      >
        Can&apos;t reach the cloud. Showing this device&apos;s entries.
      </Notice>
    );
  }
  if (notice === 'signed_out') {
    return (
      <Notice
        data-testid="ledger-feed-notice"
        data-notice={notice}
        className="mt-3"
        {...(onSignIn === undefined
          ? {}
          : {
              actions: <NoticeButton onClick={onSignIn}>Sign in</NoticeButton>,
            })}
      >
        Sign in to see your other devices and teammates. Showing work this
        device did while signed out.
      </Notice>
    );
  }
  return null;
}

/**
 * The global Feed: one centered column of entry threads, with the composer
 * at its top. This device's entries open in their scope's view, where they
 * change; entries from elsewhere are read only. Entering the page shows
 * fresh results. While it stays open, newer activity waits behind "Show new
 * activity" so it never moves what the person is reading.
 */
export function LedgerFeed({
  store,
  local,
  audiences = LEDGER_FEED_ALL_AUDIENCES,
  visible,
  onSignIn,
  personName = DEFAULT_PERSON_NAME,
  scopeNames,
  onOpenScope,
  scrollElement,
  heading = false,
  registerLocalEntryOpener,
}: LedgerFeedProps): JSX.Element {
  const client = local?.client;
  const navigator = local?.navigator;
  const files = local?.files;
  const scopeStore = local?.scopeStore;
  const scopeHasDraft = local?.scopeHasDraft;
  const describeScope = local?.describeScope ?? describeNoScope;
  const addableScopes = local?.addableScopes;
  const {
    audience,
    showTeammates,
    onlyThisDevice,
    live,
    activityShownCount,
    list,
    actors,
    newActivity,
    selectedEntryId,
    selectedScope,
    remoteDetail,
    filtered,
  } = store(
    useShallow((state) => ({
      audience: state.audience,
      showTeammates: state.showTeammates,
      onlyThisDevice: state.onlyThisDevice,
      live: state.live,
      activityShownCount: state.activityShownCount,
      list: state.list,
      actors: state.actors,
      newActivity: state.newActivity,
      selectedEntryId: state.selectedEntryId,
      selectedScope: state.selectedScope,
      remoteDetail: state.remoteDetail,
      filtered:
        isLedgerFeedFiltered(state.filters) ||
        state.queryText.trim().length > 0,
    })),
  );
  // Only the active target is observed here; the composer row subscribes to
  // the rest of its draft state so editing never renders the thread list.
  const composerScope = store((state) => state.composer.scope);
  const [ownersScope, setOwnersScope] = useState<LedgerViewScope | null>(null);
  const [startedCorrectionScopes, setStartedCorrectionScopes] = useState<
    ReadonlyMap<string, LedgerViewScope>
  >(() => new Map());
  // Bumped when the host replaced a watched scope's view, to watch the new one.
  const [scopeStoreEpoch, setScopeStoreEpoch] = useState(0);
  const [openError, setOpenError] = useState<LedgerOpenError | null>(null);
  // Try again keeps the failed Feed on screen, its capsule spinning, until the
  // read settles, instead of blanking to the loading line.
  const listRetry = useRetry(() => store.getState().load({ refresh: true }));
  const [retriedProblem, setRetriedProblem] = useState(list.problem);
  // Only while the list is still loading: a newer read (a search, a filter)
  // that settles first replaces the kept failure at once.
  const listRetrying = listRetry.retrying && list.status === 'loading';
  const shownProblem =
    list.status === 'problem' && list.problem !== null
      ? list.problem
      : listRetrying
        ? retriedProblem
        : null;
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const listScrollRef = useRef<HTMLDivElement>(null);
  const getListScrollElement = useCallback(
    (): HTMLElement | null =>
      scrollElement === undefined ? listScrollRef.current : scrollElement(),
    [scrollElement],
  );
  const now = useLedgerNow();

  // Every page entry reads past the host's cache and shows the newest page.
  // The retained store keeps the search, selection and drafts.
  useEffect(() => {
    void store.getState().load({ refresh: true });
  }, [store]);

  // Account resets reload an idle store. Regaining document visibility only
  // looks for new activity while the person remains on this page.
  const listIdle = list.status === 'idle';
  useEffect(() => {
    const state = store.getState();
    if (state.list.status === 'idle') void state.load();
    else if (visible) void state.checkForNewActivity();
  }, [store, listIdle, visible]);

  // A committed change on this device: look again shortly after. A written
  // title also reaches a loaded row the look would miss, on any page.
  useEffect(() => {
    // Without a Ledger of its own, nothing commits here: the poll looks.
    if (client === undefined) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = client.subscribeChanges((event) => {
      for (const change of event.changes) {
        if (change.titleResolved === true) void refreshResolvedTitle(change);
      }
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void store.getState().checkForNewActivity();
      }, LEDGER_FEED_CHANGE_DELAY_MS);
    });
    const refreshResolvedTitle = async (
      change: LedgerViewChange,
    ): Promise<void> => {
      const row = store
        .getState()
        .list.rows.find(
          (candidate) => candidate.entry.entryId === change.entryId,
        );
      if (row?.entry.titlePending !== true) return;
      try {
        const result = await client.getEntry({
          scope: change.scope,
          entryId: change.entryId,
        });
        const entry =
          result.status === 'ok' ? ledgerReadItem(result.value) : null;
        if (entry !== null) store.getState().replaceEntry(entry);
      } catch {
        // The next look or reload shows the title instead.
      }
    };
    return (): void => {
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, store]);

  // Other devices and teammates change nothing here: look now and then.
  useEffect(() => {
    if (!visible) return undefined;
    const interval = setInterval(() => {
      void store.getState().checkForNewActivity();
    }, LEDGER_FEED_POLL_MS);
    return (): void => clearInterval(interval);
  }, [store, visible]);

  useEffect(
    () => (): void => {
      if (searchTimer.current !== undefined) clearTimeout(searchTimer.current);
    },
    [],
  );

  useEffect(
    () => (): void => {
      void store.getState().setLiveHeld(false);
    },
    [store],
  );

  // Restores the list's scroll position from before the page unmounted.
  useLayoutEffect(() => {
    if (scrollElement !== undefined) return;
    const element = listScrollRef.current;
    if (element !== null) element.scrollTop = store.getState().scrollTop;
  }, [scrollElement, store]);

  // A new first page (a search, filter or audience) starts at the top: the
  // store resets the list's place, and the list follows. A look for newer
  // activity leaves the place alone.
  useEffect(
    () =>
      store.subscribe((state, previous) => {
        if (state.scrollTop !== 0 || previous.scrollTop === 0) return;
        const element = getListScrollElement();
        if (element !== null) element.scrollTop = 0;
      }),
    [getListScrollElement, store],
  );

  const onSearchChange = useCallback(
    (text: string): void => {
      store.getState().setQueryText(text);
      if (searchTimer.current !== undefined) clearTimeout(searchTimer.current);
      searchTimer.current = setTimeout(() => {
        searchTimer.current = undefined;
        void store.getState().load();
      }, SEARCH_DEBOUNCE_MS);
    },
    [store],
  );

  const cancelSearchTimer = useCallback((): void => {
    if (searchTimer.current !== undefined) {
      clearTimeout(searchTimer.current);
      searchTimer.current = undefined;
    }
  }, []);

  const onAudienceChange = useCallback(
    (next: LedgerFeedAudience): void => {
      if (store.getState().audience === next) return;
      cancelSearchTimer();
      void store.getState().setAudience(next);
    },
    [cancelSearchTimer, store],
  );

  const onOnlyThisDeviceChange = useCallback(
    (on: boolean): void => {
      cancelSearchTimer();
      void store.getState().setOnlyThisDevice(on);
    },
    [cancelSearchTimer, store],
  );

  const onShowTeammatesChange = useCallback(
    (on: boolean): void => {
      cancelSearchTimer();
      void store.getState().setShowTeammates(on);
    },
    [cancelSearchTimer, store],
  );

  const onFiltersChange = useCallback(
    (next: LedgerFeedFilters): void => {
      cancelSearchTimer();
      void store.getState().setFilters(next);
    },
    [cancelSearchTimer, store],
  );

  const clearSearchAndFilters = useCallback((): void => {
    cancelSearchTimer();
    store.getState().setQueryText('');
    void store.getState().setFilters(DEFAULT_LEDGER_FEED_FILTERS);
  }, [cancelSearchTimer, store]);

  const onNoticeRetry = useCallback((): void => {
    void store.getState().load({ refresh: true });
  }, [store]);

  const rows = list.rows;
  const activityRows = useMemo(
    () => rows.slice(0, activityShownCount),
    [activityShownCount, rows],
  );
  const rowsById = useMemo(
    () => new Map(rows.map((row) => [row.entry.entryId, row])),
    [rows],
  );
  const rowsByIdRef = useRef(rowsById);
  rowsByIdRef.current = rowsById;
  const selectedScopeRef = useRef(selectedScope);
  selectedScopeRef.current = selectedScope;

  // Watch only scopes that can presently contribute state to a row or action.
  const rowScopesWithDraft = useMemo(() => {
    if (scopeHasDraft === undefined) return [];
    const scopes = new Map<string, LedgerViewScope>();
    for (const row of rows) {
      if (row.origin.kind === 'this_device') {
        scopes.set(ledgerScopeKey(row.origin.scope), row.origin.scope);
      }
    }
    return [...scopes.values()].filter((scope) => scopeHasDraft(scope));
  }, [rows, scopeHasDraft]);
  const candidateScopesByKey = useMemo(() => {
    const scopes = new Map<string, LedgerViewScope>();
    const add = (scope: LedgerViewScope | null): void => {
      if (scope !== null) scopes.set(ledgerScopeKey(scope), scope);
    };
    add(selectedScope);
    add(composerScope);
    add(ownersScope);
    for (const scope of rowScopesWithDraft) add(scope);
    for (const scope of startedCorrectionScopes.values()) add(scope);
    return scopes;
  }, [
    selectedScope,
    composerScope,
    ownersScope,
    rowScopesWithDraft,
    startedCorrectionScopes,
  ]);
  const watchedScopeKeyString = [...candidateScopesByKey.keys()]
    .sort()
    .join('\u001f');
  // A new epoch looks the same scopes' views up again.
  const watchedLookup = `${String(scopeStoreEpoch)}\u001e${watchedScopeKeyString}`;
  const candidateScopesRef = useRef(candidateScopesByKey);
  candidateScopesRef.current = candidateScopesByKey;
  const watchedScopeKeys = useMemo(() => {
    const keys = watchedLookup.slice(watchedLookup.indexOf('\u001e') + 1);
    return keys.length === 0 ? [] : keys.split('\u001f');
  }, [watchedLookup]);
  const watchedStores = useMemo(() => {
    if (scopeStore === undefined) return [];
    const scopes = candidateScopesRef.current;
    const stores: LedgerViewStore[] = [];
    for (const key of watchedScopeKeys) {
      const scope = scopes.get(key);
      if (scope !== undefined) stores.push(scopeStore(scope));
    }
    return stores;
  }, [scopeStore, watchedScopeKeys]);
  const scopeRows = useLedgerScopeRowsStates(watchedStores);
  const watchedStoresByScope = useMemo(
    () =>
      new Map(
        watchedStores.map((view) => [
          ledgerScopeKey(view.getState().scope),
          view,
        ]),
      ),
    [watchedStores],
  );
  const watchedStoresByScopeRef = useRef(watchedStoresByScope);
  watchedStoresByScopeRef.current = watchedStoresByScope;
  const scopeRowsByKey = useMemo(
    () =>
      new Map(scopeRows.map((state) => [ledgerScopeKey(state.scope), state])),
    [scopeRows],
  );
  // A scope whose corrections all ended is no longer watched for them, so the
  // host may let its idle view go; a later correction watches it afresh.
  useEffect(() => {
    setStartedCorrectionScopes((current) => {
      let next: Map<string, LedgerViewScope> | null = null;
      for (const key of current.keys()) {
        if (scopeRowsByKey.get(key)?.correctionIds.length === 0) {
          next ??= new Map(current);
          next.delete(key);
        }
      }
      return next ?? current;
    });
  }, [scopeRowsByKey]);

  // ledgerRestingRowsState currently makes an equivalent state on each call;
  // retain one per scope here so the rows' inputs remain stable.
  const restingRowsCache = useRef(new Map<string, LedgerScopeRowsState>());
  const restingRowsFor = useCallback((scope: LedgerViewScope) => {
    const key = ledgerScopeKey(scope);
    const cached = restingRowsCache.current.get(key);
    if (cached !== undefined) return cached;
    const resting = ledgerRestingRowsState(scope);
    restingRowsCache.current.set(key, resting);
    return resting;
  }, []);

  // The cache is per component lifetime and is replaced if any host boundary
  // changes, so a scope's actions never keep an old client or navigator.
  const scopeActionsCache = useMemo(
    () => ({
      boundary: { scopeStore, client, navigator, store },
      actionsByScope: new Map<string, LedgerScopeActions>(),
    }),
    [scopeStore, client, navigator, store],
  );
  const actionsByScope = scopeActionsCache.actionsByScope;
  const actionsForScope = useCallback(
    (scope: LedgerViewScope): LedgerScopeActions | null => {
      // Only a host that holds the scope can change it.
      if (
        scopeStore === undefined ||
        client === undefined ||
        navigator === undefined
      ) {
        return null;
      }
      const key = ledgerScopeKey(scope);
      const cached = actionsByScope.get(key);
      if (cached !== undefined) return cached;
      const actions = createLedgerScopeActions({
        view: () => scopeStore(scope),
        client,
        navigator,
        onFocus: (entryId) => {
          if (rowsByIdRef.current.has(entryId)) {
            void store.getState().select(entryId, { keepDraft: true });
            return;
          }
          const currentScope = store.getState().selectedScope;
          if (currentScope === null || ledgerScopeKey(currentScope) !== key) {
            store.getState().focusScope(scope);
          }
        },
        onOpenError: setOpenError,
        onStartCorrection: () => {
          const watched = watchedStoresByScopeRef.current.get(key);
          if (watched !== undefined && watched !== scopeStore(scope)) {
            setScopeStoreEpoch((epoch) => epoch + 1);
          }
          setStartedCorrectionScopes((current) => {
            if (current.has(key)) return current;
            const next = new Map(current);
            next.set(key, scope);
            return next;
          });
        },
        onLoadOwners: () => setOwnersScope(scope),
      });
      actionsByScope.set(key, actions);
      return actions;
    },
    [actionsByScope, client, navigator, scopeStore, store],
  );
  const openLocalEntry = useCallback(
    (scope: LedgerViewScope, entryId: string): void => {
      setOpenError(null);
      store.getState().focusScope(scope);
      actionsForScope(scope)?.open(entryId);
    },
    [actionsForScope, store],
  );
  useEffect(() => {
    if (registerLocalEntryOpener === undefined) return;
    registerLocalEntryOpener(openLocalEntry);
    return (): void => registerLocalEntryOpener(null);
  }, [openLocalEntry, registerLocalEntryOpener]);

  const rowDetails = useCallback(
    (entry: LedgerEntrySearchItem): LedgerEntryRowDetails => {
      const row = rowsById.get(entry.entryId);
      if (row === undefined) {
        const scope = selectedScopeRef.current;
        if (scope !== null) {
          const context = describeScope(scope);
          return context === null ? {} : { context };
        }
        const origin =
          remoteDetail.entryId === entry.entryId ? remoteDetail.origin : null;
        if (origin === null) return {};
        const attribution = attributionOf(origin);
        return attribution === null ? {} : { attribution };
      }
      if (row.origin.kind === 'this_device') {
        const scope = row.origin.scope;
        // A workflow scope has no project › task path; it keeps its owner.
        if (scopeNames !== undefined && isLedgerTaskViewScope(scope)) {
          return {
            workPath: ledgerScopeWorkPath(scope, scopeNames(scope) ?? null, {
              fallback:
                describeScope(scope) ?? SCOPE_KIND_LABELS[row.scopeKind],
              ...(onOpenScope === undefined ? {} : { onOpenScope }),
            }),
          };
        }
        return {
          context: localRowContext(row, scope, describeScope),
        };
      }
      const attribution = attributionOf(row.origin);
      const context = remoteRowContext(row);
      return {
        ...(context === undefined ? {} : { context }),
        ...(attribution === null ? {} : { attribution }),
      };
    },
    [
      rowsById,
      describeScope,
      onOpenScope,
      remoteDetail.entryId,
      remoteDetail.origin,
      scopeNames,
    ],
  );

  const slotsCache = useLedgerSlotsCache();
  const readOnlySlotsCache = useRef(
    new Map<
      string,
      { readonly note: string; readonly slots: LedgerEntrySlots }
    >(),
  );
  const entrySlots = useCallback(
    (entry: LedgerEntrySearchItem): LedgerEntrySlots => {
      const row = rowsById.get(entry.entryId);
      const scope =
        row === undefined
          ? selectedScope
          : row.origin.kind === 'this_device'
            ? row.origin.scope
            : null;
      if (scope === null) {
        const origin =
          row !== undefined && row.origin.kind !== 'this_device'
            ? row.origin
            : remoteDetail.entryId === entry.entryId
              ? remoteDetail.origin
              : null;
        if (origin === null) return {};
        const note = readOnlyNote(attributionOf(origin));
        const cached = readOnlySlotsCache.current.get(entry.entryId);
        if (cached !== undefined && cached.note === note.key) {
          return cached.slots;
        }
        const slots: LedgerEntrySlots = {
          readOnlyNote: (
            <span
              data-testid="ledger-feed-read-only"
              className="text-xs fg-secondary"
            >
              {note.content}
            </span>
          ),
        };
        readOnlySlotsCache.current.set(entry.entryId, {
          note: note.key,
          slots,
        });
        return slots;
      }
      const scopeKey = ledgerScopeKey(scope);
      const state = scopeRowsByKey.get(scopeKey) ?? restingRowsFor(scope);
      const actions = actionsForScope(scope);
      if (actions === null) return {};
      const input = {
        entry,
        ownerName: ledgerActorName(entry.owner, actors),
        rows: state,
        actions,
      };
      return slotsCache(entry.entryId, ledgerWritableSlotsDeps(input), () =>
        ledgerWritableEntrySlots(input),
      );
    },
    [
      actionsForScope,
      actors,
      remoteDetail.entryId,
      remoteDetail.origin,
      restingRowsFor,
      rowsById,
      scopeRowsByKey,
      selectedScope,
      slotsCache,
    ],
  );

  const selectedScopeRows =
    selectedScope === null
      ? null
      : (scopeRowsByKey.get(ledgerScopeKey(selectedScope)) ??
        restingRowsFor(selectedScope));
  const selectedScopeActions =
    selectedScope === null ? null : actionsForScope(selectedScope);
  const selectedScopeEntryId = selectedScopeRows?.selectedEntryId ?? null;
  const selectedScopeDetail = selectedScopeRows?.detail ?? null;
  const selectedScopeChange = selectedScopeRows?.change ?? null;
  const selectedScopeCloseIntent = selectedScopeRows?.closeIntent ?? null;
  const remoteView =
    selectedEntryId !== null &&
    remoteDetail.status === 'ready' &&
    remoteDetail.entryId === selectedEntryId
      ? remoteDetail.view
      : null;
  const reloadRemoteDetail = useCallback((): void => {
    void store.getState().reloadRemoteDetail();
  }, [store]);
  const loadMoreRemoteHistory = useCallback((): void => {
    void store.getState().loadMoreRemoteHistory();
  }, [store]);
  const remoteOpenError =
    selectedEntryId !== null && openError?.entryId === selectedEntryId
      ? openError.message
      : null;
  const openEntry = useMemo(() => {
    if (
      selectedScope !== null &&
      selectedScopeDetail !== null &&
      selectedScopeChange !== null &&
      selectedScopeActions !== null
    ) {
      return ledgerScopeOpenEntry(
        {
          selectedEntryId: selectedScopeEntryId,
          detail: selectedScopeDetail,
          change: selectedScopeChange,
          closeIntent: selectedScopeCloseIntent,
        },
        selectedScopeActions,
        openError,
        scopeStore === undefined
          ? undefined
          : (choice): Promise<void> =>
              scopeStore(selectedScope).getState().resolveCloseIntent(choice),
      );
    }
    if (selectedEntryId === null) return null;
    let readState: ReactNode = undefined;
    if (
      remoteDetail.status === 'problem' &&
      remoteDetail.entryId === selectedEntryId &&
      remoteDetail.problem !== null
    ) {
      readState = (
        <LedgerEntryReadProblem
          problem={remoteDetail.problem}
          onRetry={reloadRemoteDetail}
        />
      );
    } else if (remoteView === null) {
      readState = <LedgerEntryReadLoading />;
    }
    const history = remoteView?.entry.history;
    const hasMoreHistory =
      history !== null && history !== undefined && history.nextCursor !== null;
    return {
      entryId: selectedEntryId,
      view: remoteView,
      readState,
      openError: remoteOpenError,
      ...(hasMoreHistory ? { onLoadMoreHistory: loadMoreRemoteHistory } : {}),
      loadingMoreHistory:
        remoteDetail.entryId === selectedEntryId
          ? remoteDetail.loadingMoreHistory
          : false,
    };
  }, [
    loadMoreRemoteHistory,
    openError,
    remoteDetail,
    remoteOpenError,
    remoteView,
    reloadRemoteDetail,
    selectedEntryId,
    selectedScope,
    selectedScopeActions,
    selectedScopeChange,
    selectedScopeCloseIntent,
    selectedScopeDetail,
    selectedScopeEntryId,
    scopeStore,
  ]);
  const rowsWithOpenRead = useMemo(() => {
    const openRead = openEntry?.view?.entry.entry;
    if (selectedScope === null || openRead === undefined) return activityRows;

    let changed = false;
    const updatedRows = activityRows.map((row) => {
      if (
        row.origin.kind !== 'this_device' ||
        ledgerScopeKey(row.origin.scope) !== ledgerScopeKey(selectedScope) ||
        row.entry.entryId !== openRead.entryId ||
        openRead.revision <= row.entry.revision
      ) {
        return row;
      }
      changed = true;
      return {
        ...row,
        entry: {
          ...row.entry,
          status: openRead.status,
          owner: openRead.owner,
          revision: openRead.revision,
          updatedAt: openRead.updatedAt,
        },
      };
    });
    return changed ? updatedRows : activityRows;
  }, [activityRows, openEntry?.view, selectedScope]);
  const entries = useMemo(
    () => rowsWithOpenRead.map((row) => row.entry),
    [rowsWithOpenRead],
  );
  const openItem = useMemo(
    () => ledgerReadItem(openEntry?.view ?? null),
    [openEntry?.view],
  );
  const placed = useMemo(
    () => placeLedgerOpenEntry(entries, openItem),
    [entries, openItem],
  );
  const pinnedEntry = useMemo(() => placed.pinnedEntry, [placed]);
  const roots = useMemo(
    () => ledgerThreadRootIds(placed.entries),
    [placed.entries],
  );

  const correctionDrafts = useMemo(
    () =>
      scopeRows.flatMap((rowsState) => {
        const scopeKey = ledgerScopeKey(rowsState.scope);
        const correctionStore = watchedStoresByScope.get(scopeKey);
        if (correctionStore === undefined) return [];
        return rowsState.correctionIds.map((entryId) => ({
          store: correctionStore,
          entryId,
          scopeKey,
        }));
      }),
    [scopeRows, watchedStoresByScope],
  );
  // A correction the person saves here joins its thread in place at once,
  // never behind "Show new activity" like activity from elsewhere.
  const onCorrectionSaved = useCallback(
    (entryId: string): void => {
      store.getState().noteOwnEntry(entryId);
      void store.getState().checkForNewActivity();
    },
    [store],
  );
  const { corrections, unlisted } = useLedgerCorrectionPlacements(
    correctionDrafts,
    roots,
    pinnedEntry?.entryId ?? null,
    'page',
    personName,
    files,
    onCorrectionSaved,
  );
  const correctionFallback = useMemo(() => {
    if (unlisted.length === 0) return null;
    return (
      <>
        {unlisted.map((draft) => (
          <div
            key={`${draft.scopeKey}:${draft.entryId}`}
            className="border-b border-line-base pb-4"
          >
            <LedgerComposer
              store={draft.store}
              correctionOf={draft.entryId}
              files={files}
              autoFocusContent={false}
              onSaved={onCorrectionSaved}
            />
          </div>
        ))}
      </>
    );
  }, [files, onCorrectionSaved, unlisted]);

  const openEntryListed = placed.entries.some(
    (entry) => entry.entryId === openEntry?.entryId,
  );
  const pendingOpen =
    openEntry !== null && openEntry.view === null && !openEntryListed
      ? (openEntry.readState ?? null)
      : null;
  const composer = useMemo(
    (): ReactNode => (
      <>
        {client !== undefined &&
          scopeStore !== undefined &&
          scopeHasDraft !== undefined &&
          addableScopes !== undefined && (
            <FeedComposerRow
              store={store}
              client={client}
              scopeStore={scopeStore}
              scopeHasDraft={scopeHasDraft}
              addableScopes={addableScopes}
              files={files}
              personName={personName}
            />
          )}
        {correctionFallback}
        {pendingOpen !== null && pendingOpen !== undefined && (
          <div className="border-b border-line-base py-3">{pendingOpen}</div>
        )}
      </>
    ),
    [
      addableScopes,
      client,
      correctionFallback,
      files,
      pendingOpen,
      personName,
      scopeHasDraft,
      scopeStore,
      store,
    ],
  );

  const openEntryById = useCallback(
    (entryId: string): void => {
      const row = rowsById.get(entryId);
      const rowActions =
        row?.origin.kind === 'this_device'
          ? actionsForScope(row.origin.scope)
          : null;
      if (rowActions !== null) {
        rowActions.open(entryId);
        return;
      }
      const currentScope = store.getState().selectedScope;
      const currentActions =
        row === undefined && currentScope !== null
          ? actionsForScope(currentScope)
          : null;
      if (currentActions !== null) {
        currentActions.open(entryId);
        return;
      }
      // A remote entry with no row, such as a teammate correction's target,
      // is read from where the open entry came from.
      const remoteOrigin =
        row === undefined
          ? (store.getState().remoteDetail.origin ?? undefined)
          : undefined;
      void store.getState().select(entryId, {
        keepDraft: true,
        ...(remoteOrigin === undefined ? {} : { remoteOrigin }),
      });
    },
    [actionsForScope, rowsById, store],
  );
  const onToggleOpen = useCallback(
    (entryId: string | null): void => {
      setOpenError(null);
      if (entryId === null) {
        const currentScope = store.getState().selectedScope;
        if (currentScope !== null && scopeStore !== undefined) {
          void scopeStore(currentScope)
            .getState()
            .select(null, { keepDraft: true });
        }
        void store.getState().select(null, { keepDraft: true });
        return;
      }
      openEntryById(entryId);
    },
    [openEntryById, scopeStore, store],
  );
  const onShowEntry = useCallback(
    (entryId: string): void => {
      setOpenError(null);
      openEntryById(entryId);
    },
    [openEntryById],
  );
  const onOpenFile = useCallback(
    (entry: LedgerEntrySearchItem, file: LedgerFileRef): void => {
      const row = rowsById.get(entry.entryId);
      const currentScope = store.getState().selectedScope;
      const localScope =
        row?.origin.kind === 'this_device'
          ? row.origin.scope
          : row === undefined
            ? currentScope
            : null;
      const localActions =
        localScope === null ? null : actionsForScope(localScope);
      if (localActions !== null) {
        localActions.openFile(entry, file);
        return;
      }
      if (store.getState().selectedEntryId !== entry.entryId) {
        void store.getState().select(entry.entryId, { keepDraft: true });
      }
      setOpenError({
        entryId: entry.entryId,
        message: 'This file is on another device.',
      });
    },
    [actionsForScope, rowsById, store],
  );
  const onLoadMore = useCallback((): void => {
    void store.getState().showMoreEntries();
  }, [store]);
  const activityHasMore = activityRows.length < rows.length || list.hasMore;
  const showNewActivity = useCallback((): void => {
    void store.getState().showNewActivity();
    const element = getListScrollElement();
    if (element !== null) element.scrollTop = 0;
  }, [getListScrollElement, store]);

  let listBody: ReactNode;
  if (shownProblem !== null) {
    const copy = problemCopy(shownProblem, 'list');
    listBody = (
      <>
        {composer}
        <ErrorState
          testId="ledger-feed-problem"
          retryTestId="ledger-feed-retry"
          message={copy.message}
          retrying={listRetrying}
          onRetry={
            copy.retry
              ? (): void => {
                  setRetriedProblem(shownProblem);
                  listRetry.retry();
                }
              : undefined
          }
        />
      </>
    );
  } else if (entries.length === 0 && !list.settled) {
    // Only before the first read: later searches keep the last result.
    listBody = (
      <>
        {composer}
        <DelayedLoadingPlaceholder slowNote="Still loading the Feed…">
          <LedgerThreadListSkeleton density="page" />
        </DelayedLoadingPlaceholder>
      </>
    );
  } else if (
    placed.entries.length === 0 &&
    pinnedEntry === null &&
    !activityHasMore
  ) {
    listBody = (
      <>
        {composer}
        {filtered ? (
          <EmptyState
            testId="ledger-feed-empty-filtered"
            title="No matching entries"
            subtitle="Try other words or filters."
            action={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={clearSearchAndFilters}
              >
                Clear search and filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            testId="ledger-feed-empty"
            title="No entries yet"
            subtitle="Agents add entries as they work, and each new summary adds one."
          />
        )}
      </>
    );
  } else {
    listBody = (
      <LedgerThreadList
        entries={placed.entries}
        placementKey={list.generation}
        actors={actors}
        density="page"
        now={now}
        timeField="updatedAt"
        openEntry={openEntry}
        onToggleOpen={onToggleOpen}
        onOpenFile={onOpenFile}
        onShowEntry={onShowEntry}
        rowDetails={rowDetails}
        entrySlots={entrySlots}
        corrections={corrections}
        pinnedEntry={pinnedEntry}
        composer={composer}
        hasMore={activityHasMore}
        loadingMore={list.loadingMore}
        loadMoreError={
          list.loadMoreProblem === null ? null : "Couldn't load more entries."
        }
        onLoadMore={onLoadMore}
        {...(heading ? { loadMoreTestId: 'feed-show-more-entries' } : {})}
        scrollElement={getListScrollElement}
      />
    );
  }

  const listContent = (
    <div
      className="flex w-full flex-col pb-8 pt-2"
      onPointerEnter={() => {
        void store.getState().setLiveHeld(true);
      }}
      onPointerLeave={() => {
        void store.getState().setLiveHeld(false);
      }}
    >
      {newActivity && (
        <div className="sticky top-0 z-10 flex justify-center bg-base pb-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="ledger-feed-new-activity"
            onClick={showNewActivity}
          >
            Show new activity
          </Button>
        </div>
      )}
      {listBody}
    </div>
  );
  // The list's column. With an ancestor's scroller it only holds the list,
  // which scrolls with the page; otherwise it is the list's own scroller.
  const listPane =
    scrollElement === undefined ? (
      <div
        ref={listScrollRef}
        data-testid="ledger-feed-list-pane"
        onScroll={(event) =>
          store.getState().setScrollTop(event.currentTarget.scrollTop)
        }
        className="min-h-0 min-w-0 flex-1 overflow-y-auto"
      >
        {listContent}
      </div>
    ) : (
      <div data-testid="ledger-feed-list-pane" className="min-w-0">
        {listContent}
      </div>
    );
  const feed = (
    <div
      data-testid="ledger-feed"
      data-audience={audience}
      className={
        scrollElement === undefined
          ? 'flex min-h-0 min-w-0 flex-1 flex-col'
          : 'flex min-w-0 flex-col'
      }
    >
      <FeedControls
        store={store}
        audiences={audiences}
        onAudienceChange={onAudienceChange}
        onSearchChange={onSearchChange}
        onFiltersChange={onFiltersChange}
        heading={heading}
        onOnlyThisDeviceChange={onOnlyThisDeviceChange}
      />
      <FeedNotice
        notice={list.notice}
        onRetry={onNoticeRetry}
        onSignIn={onSignIn}
      />
      {listPane}
    </div>
  );
  if (!heading) return feed;

  return (
    <section
      data-testid="feed-activity"
      className={
        scrollElement === undefined
          ? 'flex min-h-0 min-w-0 flex-1 flex-col'
          : 'flex min-w-0 flex-col'
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 pb-3">
        <Heading level={2} variant="title">
          Activity
        </Heading>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2 text-xs fg-secondary">
            <span>Show teammates</span>
            <ToggleSwitch
              label="Show teammates"
              checked={showTeammates && !onlyThisDevice}
              dataTestId="feed-show-teammates"
              onChange={onShowTeammatesChange}
            />
          </div>
          <div className="flex items-center gap-2 text-xs fg-secondary">
            <span>Live</span>
            <ToggleSwitch
              label="Live"
              checked={live}
              dataTestId="feed-live"
              onChange={(on) => {
                void store.getState().setLive(on);
              }}
            />
          </div>
        </div>
      </div>
      {feed}
    </section>
  );
}
