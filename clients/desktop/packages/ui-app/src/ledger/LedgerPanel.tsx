'use client';

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
  DEFAULT_LEDGER_VIEW_FILTERS,
  type LedgerViewStore,
} from '@canopy/app-state';
import type { LedgerEntrySearchItem } from '@canopy/protocol/canopy-core';
import {
  isLedgerTaskViewScope,
  type LedgerViewFilters,
} from '@canopy/protocol/ledger-view';
import {
  Button,
  EmptyState,
  ErrorState,
  LedgerComposerPrompt,
  LedgerFilterMenu,
  DelayedLoadingPlaceholder,
  LedgerThreadList,
  LedgerThreadListSkeleton,
  Notice,
  SearchField,
  isLedgerViewFiltered,
  useRetry,
  type LedgerEntrySlots,
} from '@canopy/ui-shared/components';
import { ledgerActorName } from '@canopy/ui-shared/lib';
import { LedgerComposer } from './LedgerComposer';
import {
  createLedgerScopeActions,
  ledgerReadItem,
  ledgerScopeKey,
  ledgerScopeOpenEntry,
  ledgerThreadRootIds,
  useLedgerCorrectionPlacements,
  ledgerWritableEntrySlots,
  ledgerWritableSlotsDeps,
  placeLedgerOpenEntry,
  useLedgerNow,
  useLedgerScopeRowsState,
  useLedgerSlotsCache,
  type LedgerOpenError,
} from './ledger-scope-rows';
import { problemCopy } from './ledger-problem-copy';

/** Typing settles this long before the search runs. */
const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_INPUT_MAX_LENGTH = 256;
/** The person, when the host does not name them. */
const DEFAULT_PERSON_NAME = 'You';

export interface LedgerPanelProps {
  /** The scope's view state; it outlives the panel, so returning restores it. */
  readonly store: LedgerViewStore;
  readonly client: LedgerClient;
  readonly navigator: LedgerNavigator;
  /** Finds files for an entry's references; without it none can be added. */
  readonly files?: LedgerFilePicker;
  /** The person's name, for their avatar beside what they write. */
  readonly personName?: string;
}

/**
 * The panel's filters and search. It reads the search text itself, so
 * typing renders only the toolbar.
 */
function PanelToolbar({
  store,
  onSearchChange,
  onFiltersChange,
}: {
  readonly store: LedgerViewStore;
  readonly onSearchChange: (text: string) => void;
  readonly onFiltersChange: (filters: LedgerViewFilters) => void;
}): JSX.Element {
  const { queryText, filters } = store(
    useShallow((state) => ({
      queryText: state.queryText,
      filters: state.filters,
    })),
  );
  return (
    <div
      data-testid="ledger-toolbar"
      className="flex shrink-0 items-center gap-2 border-b border-line-base px-3 py-2"
    >
      <LedgerFilterMenu filters={filters} onChange={onFiltersChange} />
      <SearchField
        data-testid="ledger-search"
        value={queryText}
        maxLength={SEARCH_INPUT_MAX_LENGTH}
        onValueChange={onSearchChange}
        placeholder="Search entries"
        aria-label="Search entries"
        className="min-w-0 flex-1"
      />
    </div>
  );
}

/**
 * The composer row above the entries: a prompt that opens a new entry's
 * form in its place, or `Continue draft` while a new-entry draft is set
 * aside. Corrections never block the prompt.
 */
function PanelComposerRow({
  store,
  files,
  personName,
}: {
  readonly store: LedgerViewStore;
  readonly files: LedgerFilePicker | undefined;
  readonly personName: string;
}): JSX.Element {
  const { shown, draft } = store(
    useShallow((state) => ({
      shown: state.composer.shown,
      draft: state.composer.draft,
    })),
  );
  if (shown && draft !== null) {
    return (
      <div className="border-b border-line-base pb-3">
        <LedgerComposer store={store} files={files} />
      </div>
    );
  }
  return (
    <LedgerComposerPrompt
      density="panel"
      personName={personName}
      testId="ledger-add-entry"
      {...(draft === null ? {} : { label: 'Continue draft' })}
      disabledReason={null}
      onOpen={() => store.getState().startEntry()}
    />
  );
}

/**
 * One work scope's Agent Ledger: search and filters, then one column with
 * the composer on top and the entries below, newest first, each with its
 * corrections as replies. An entry opens in place to show its activity and
 * details; an open entry's status and owner change on its row, and a
 * correction is written in a box under the entry it corrects. The view
 * state lives in `store`, so leaving for a source and coming back finds the
 * same query, page, open entry, scroll position and draft.
 */
export function LedgerPanel({
  store,
  client,
  navigator,
  files,
  personName = DEFAULT_PERSON_NAME,
}: LedgerPanelProps): JSX.Element {
  const { scope, list, actors, filtered } = store(
    useShallow((state) => ({
      scope: state.scope,
      list: state.list,
      actors: state.actors,
      filtered:
        isLedgerViewFiltered(state.filters) ||
        state.queryText.trim().length > 0,
    })),
  );
  const rows = useLedgerScopeRowsState(store);
  const { selectedEntryId, detail, change, correctionIds } = rows;
  const [openError, setOpenError] = useState<LedgerOpenError | null>(null);
  // Try again keeps the failed list on screen, its capsule spinning, until the
  // read settles, instead of blanking to the loading line.
  const listRetry = useRetry(() => store.getState().load());
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
  const now = useLedgerNow();

  // The first mount reads the first page. A remount shows what the view kept
  // at once and re-reads it in place, because changes committed while the
  // panel was closed never reached it. A view that was reset (going idle
  // again) starts over.
  const listIdle = list.status === 'idle';
  const revalidatedStore = useRef<LedgerViewStore | null>(null);
  useEffect(() => {
    const state = store.getState();
    if (state.list.status === 'idle') {
      void state.load();
    } else if (revalidatedStore.current !== store) {
      void state.revalidate();
    }
    revalidatedStore.current = store;
  }, [store, listIdle]);

  useEffect(
    () =>
      client.subscribeChanges((event) => store.getState().applyChanges(event)),
    [client, store],
  );

  useEffect(
    () => (): void => {
      if (searchTimer.current !== undefined) clearTimeout(searchTimer.current);
    },
    [],
  );

  // Restores the list's scroll position from before the panel unmounted.
  useLayoutEffect(() => {
    const element = listScrollRef.current;
    if (element !== null) element.scrollTop = store.getState().scrollTop;
  }, [store]);

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

  const onFiltersChange = useCallback(
    (next: LedgerViewFilters): void => {
      void store.getState().setFilters(next);
    },
    [store],
  );

  const clearSearchAndFilters = useCallback((): void => {
    if (searchTimer.current !== undefined) clearTimeout(searchTimer.current);
    store.getState().setQueryText('');
    void store.getState().setFilters(DEFAULT_LEDGER_VIEW_FILTERS);
  }, [store]);

  const actions = useMemo(
    () =>
      createLedgerScopeActions({
        view: () => store,
        client,
        navigator,
        onOpenError: setOpenError,
      }),
    [store, client, navigator],
  );

  const onToggleOpen = useCallback(
    (entryId: string | null): void => {
      setOpenError(null);
      if (entryId === null) actions.close();
      else actions.open(entryId);
    },
    [actions],
  );

  const onShowEntry = useCallback(
    (entryId: string): void => {
      setOpenError(null);
      actions.open(entryId);
    },
    [actions],
  );

  const onLoadMore = useCallback((): void => {
    void store.getState().loadMore();
  }, [store]);

  const scrollElement = useCallback(
    (): HTMLElement | null => listScrollRef.current,
    [],
  );

  const openEntry = useMemo(
    () =>
      ledgerScopeOpenEntry(
        { selectedEntryId, detail, change },
        actions,
        openError,
      ),
    [selectedEntryId, detail, change, actions, openError],
  );
  const openView = openEntry?.view ?? null;
  const openItem = useMemo(() => ledgerReadItem(openView), [openView]);
  const placed = useMemo(
    () => placeLedgerOpenEntry(list.entries, openItem),
    [list.entries, openItem],
  );

  const slotsCache = useLedgerSlotsCache();
  const entrySlots = useCallback(
    (entry: LedgerEntrySearchItem): LedgerEntrySlots => {
      const input = {
        entry,
        ownerName: ledgerActorName(entry.owner, actors),
        rows,
        actions,
      };
      return slotsCache(entry.entryId, ledgerWritableSlotsDeps(input), () =>
        ledgerWritableEntrySlots(input),
      );
    },
    [slotsCache, actors, rows, actions],
  );

  const roots = useMemo(
    () => ledgerThreadRootIds(placed.entries),
    [placed.entries],
  );
  const pinnedId = placed.pinnedEntry?.entryId ?? null;
  const correctionDrafts = useMemo(
    () =>
      correctionIds.map((entryId) => ({
        store,
        entryId,
        scopeKey: ledgerScopeKey(scope),
      })),
    [correctionIds, scope, store],
  );
  const { corrections, unlisted } = useLedgerCorrectionPlacements(
    correctionDrafts,
    roots,
    pinnedId,
    'panel',
    personName,
    files,
  );
  const unlistedCorrectionForms = useMemo(
    () =>
      unlisted.map((draft) => (
        <div
          key={`${draft.scopeKey}:${draft.entryId}`}
          className="border-b border-line-base pb-3"
        >
          <LedgerComposer
            store={draft.store}
            correctionOf={draft.entryId}
            files={files}
            autoFocusContent={false}
          />
        </div>
      )),
    [files, unlisted],
  );

  // An open entry that isn't listed yet shows how its read goes on top.
  const pendingOpen =
    openEntry !== null &&
    openEntry.view === null &&
    !placed.entries.some((entry) => entry.entryId === openEntry.entryId)
      ? openEntry.readState
      : null;
  const composer = useMemo(
    (): ReactNode => (
      <>
        <PanelComposerRow store={store} files={files} personName={personName} />
        {unlistedCorrectionForms}
        {pendingOpen !== null && pendingOpen !== undefined && (
          <div className="border-b border-line-base py-3">{pendingOpen}</div>
        )}
      </>
    ),
    [store, files, personName, unlistedCorrectionForms, pendingOpen],
  );

  const loadMoreError =
    list.loadMoreProblem === null ? null : "Couldn't load more entries.";

  let listBody: ReactNode;
  if (shownProblem !== null) {
    const copy = problemCopy(shownProblem, 'list');
    listBody = (
      <>
        {composer}
        <ErrorState
          testId="ledger-list-problem"
          retryTestId="ledger-list-retry"
          space="panel"
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
  } else if (!list.settled && list.entries.length === 0) {
    // Only before the first read: later searches keep the last result.
    listBody = (
      <>
        {composer}
        {/* The placeholder fills only the room under the composer, so the
            pane never scrolls and the composer keeps its width. */}
        <div className="flex min-h-0 flex-1 flex-col">
          <DelayedLoadingPlaceholder slowNote="Still loading the Feed…">
            <LedgerThreadListSkeleton density="panel" />
          </DelayedLoadingPlaceholder>
        </div>
      </>
    );
  } else if (placed.entries.length === 0 && placed.pinnedEntry === null) {
    listBody = (
      <>
        {composer}
        {filtered ? (
          <EmptyState
            testId="ledger-empty-filtered"
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
            testId="ledger-empty"
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
        density="panel"
        now={now}
        timeField="createdAt"
        openEntry={openEntry}
        onToggleOpen={onToggleOpen}
        onOpenFile={actions.openFile}
        onShowEntry={onShowEntry}
        entrySlots={entrySlots}
        corrections={corrections}
        pinnedEntry={placed.pinnedEntry}
        composer={composer}
        hasMore={list.hasMore}
        loadingMore={list.loadingMore}
        loadMoreError={loadMoreError}
        onLoadMore={onLoadMore}
        scrollElement={scrollElement}
      />
    );
  }

  return (
    <div
      data-testid="ledger-panel"
      {...(isLedgerTaskViewScope(scope)
        ? {
            'data-project-id': scope.projectId,
            'data-worktree-id': scope.worktreeId,
          }
        : {})}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <PanelToolbar
        store={store}
        onSearchChange={onSearchChange}
        onFiltersChange={onFiltersChange}
      />
      <div
        ref={listScrollRef}
        data-testid="ledger-list-pane"
        onScroll={(event) =>
          store.getState().setScrollTop(event.currentTarget.scrollTop)
        }
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-3"
      >
        {list.status === 'ready' && list.audienceChangePending && (
          <Notice
            data-testid="ledger-audience-change-pending"
            className="mb-3"
            title="Sharing change waiting to sync"
          >
            Who can see these entries changes once this device syncs.
          </Notice>
        )}
        {listBody}
      </div>
    </div>
  );
}
