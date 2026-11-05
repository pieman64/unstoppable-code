'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type JSX,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import type {
  CanopyCapabilities,
  LedgerClient,
  LedgerFeedAnswerActions,
  LedgerFilePicker,
  LedgerLiveSnapshot,
  LedgerLiveStateSource,
  LedgerNavigator,
} from '@canopy/app-core';
import type { LedgerViewStore } from '@canopy/app-state';
import {
  deriveNeedsYou,
  type LedgerFeedWorkStore,
  type LedgerNeedsYouItem,
} from '@canopy/app-state/ledger-feed';
import type {
  LedgerOwnerCandidate,
  LedgerRootChatFilter,
} from '@canopy/protocol/canopy-core';
import {
  isLedgerTaskViewScope,
  ledgerViewScopeKey,
  type LedgerViewScope,
} from '@canopy/protocol/ledger-view';
import { LedgerFeedNeedsYou } from './LedgerFeedNeedsYou';
import { LedgerFeedOperations } from './LedgerFeedOperations';
import { LedgerPanelActivity } from './LedgerPanelActivity';
import type { LedgerCloseIntentChoice } from './ledger-close-intent';
import type { LedgerScopeNamesFor } from './ledger-work-path';
import { useLedgerEntryReveal } from './ledger-reveal-entry';
import {
  LedgerRootChatFilterBar,
  ledgerRootChatFilter,
  type LedgerFeedRootChat,
} from './ledger-root-chat-filter';

const EMPTY_LIVE_SNAPSHOT: LedgerLiveSnapshot = { agents: {}, waits: [] };
const EMPTY_SNAPSHOT = (): LedgerLiveSnapshot => EMPTY_LIVE_SNAPSHOT;
const NOOP_UNSUBSCRIBE = (): void => undefined;
const DEFAULT_PERSON_NAME = 'You';

/** The task's shared Needs you, Operations, and Activity panel composition. */
export interface LedgerPanelSectionsProps {
  /** The panel's retained scope view store for Activity and owner changes. */
  readonly store: LedgerViewStore;
  /** The task-scoped Operations and review store, created with status sorting. */
  readonly workStore: LedgerFeedWorkStore;
  /** The host's Ledger transport client. */
  readonly client: LedgerClient;
  /** Host navigation for Activity sources and references. */
  readonly navigator: LedgerNavigator;
  /** Optional host file lookup for Activity references. */
  readonly files?: LedgerFilePicker;
  /** The person label used by Activity and their own Feed rows. */
  readonly personName?: string;
  /** The person's actor ID, for owner labels in Operations. */
  readonly personActorId?: string | null;
  /** The host's live Ledger state source; gated by `capabilities`. */
  readonly liveStateSource: LedgerLiveStateSource;
  /** Only the capability needed to show live agent waits and state. */
  readonly capabilities: Pick<CanopyCapabilities, 'ledgerLiveAgentStates'>;
  /** Host actions for answering live waits and messaging owners. */
  readonly answers: LedgerFeedAnswerActions | null;
  /** Host lookup of project and task names for paths outside this scope. */
  readonly scopeNames: LedgerScopeNamesFor;
  /** Opens a path's project or task when it is outside this panel's scope. */
  readonly onOpenScope?: (scope: LedgerViewScope) => void;
  /**
   * The task's chats for the root chat picker; a host that cannot list them
   * leaves the picker out.
   */
  readonly rootChats?: readonly LedgerFeedRootChat[];
}

/** Composes this task's Needs you, Operations, and Activity in one scroller. */
export function LedgerPanelSections({
  store,
  workStore,
  client,
  navigator,
  files,
  personName = DEFAULT_PERSON_NAME,
  personActorId,
  liveStateSource,
  capabilities,
  answers,
  scopeNames,
  onOpenScope,
  rootChats,
}: LedgerPanelSectionsProps): JSX.Element {
  const scope = store((state) => state.scope);
  // Activity's filters hold the root chat filter, so Clear filters resets it.
  const rootChat = store((state) => state.filters.rootChat ?? null);
  const setRootChat = useCallback(
    (next: LedgerRootChatFilter | null): void => {
      void store
        .getState()
        .setFilters({ ...store.getState().filters, rootChat: next });
    },
    [store],
  );
  // A picked chat whose tab closed leaves the picker, so it leaves the filter
  // too: otherwise the picker reads All while the work stays narrowed to it.
  useEffect(() => {
    const chatId = rootChat?.chatId;
    if (rootChats === undefined || rootChat === null || chatId === undefined) {
      return;
    }
    if (rootChats.some((chat) => chat.chatId === chatId)) return;
    setRootChat(ledgerRootChatFilter(null, rootChat.rootOnly));
  }, [rootChat, rootChats, setRootChat]);
  const { candidates, ownersStatus } = store(
    useShallow((state) => ({
      candidates: state.owners.candidates,
      ownersStatus: state.owners.status,
    })),
  );
  const {
    actors,
    actorHosts,
    reviewRows,
    reviewsStatus,
    workListStatus,
    closeIntent,
  } = workStore(
    useShallow((state) => ({
      actors: state.actors,
      actorHosts: state.work.actorHosts,
      reviewRows: state.reviews.rows,
      reviewsStatus: state.reviews.status,
      workListStatus: state.work.status,
      closeIntent: state.closeIntent,
    })),
  );
  const liveEnabled = capabilities.ledgerLiveAgentStates === true;
  const subscribe = useCallback(
    (listener: () => void): (() => void) =>
      liveEnabled ? liveStateSource.subscribe(listener) : NOOP_UNSUBSCRIBE,
    [liveEnabled, liveStateSource],
  );
  const getSnapshot = useCallback(
    (): LedgerLiveSnapshot =>
      liveEnabled
        ? liveStateSource.getSnapshot(actorHosts)
        : EMPTY_LIVE_SNAPSHOT,
    [actorHosts, liveEnabled, liveStateSource],
  );
  const liveSnapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    EMPTY_SNAPSHOT,
  );
  const scopeKey = ledgerViewScopeKey(scope);
  const scopedSnapshot = useMemo<LedgerLiveSnapshot>(
    () => ({
      agents: liveSnapshot.agents,
      waits: liveSnapshot.waits.filter(
        (wait) =>
          isLedgerTaskViewScope(scope) &&
          wait.projectId === scope.projectId &&
          wait.worktreeId === scope.worktreeId,
      ),
    }),
    [liveSnapshot, scope],
  );
  const needsYou = useMemo(
    () => deriveNeedsYou(scopedSnapshot, reviewRows),
    [reviewRows, scopedSnapshot],
  );
  const sectionsScrollRef = useRef<HTMLDivElement>(null);
  const activitySectionRef = useRef<HTMLDivElement>(null);
  const scrollElement = useCallback(
    (): HTMLElement | null => sectionsScrollRef.current,
    [],
  );

  // The column scrolls as one, so it keeps the panel's position in the
  // retained view store, as Activity does when it scrolls alone.
  useLayoutEffect(() => {
    const element = sectionsScrollRef.current;
    if (element !== null) element.scrollTop = store.getState().scrollTop;
  }, [store]);

  useEffect(() => {
    const state = workStore.getState();
    const disconnect = state.connect();
    // Re-read a retained store on each visit; the idle-state effects below
    // load a store that has not been used yet.
    if (state.work.status !== 'idle') void state.load({ refresh: true });
    if (state.reviews.status !== 'idle') void state.loadReviews();
    return disconnect;
  }, [workStore]);

  useEffect(() => {
    if (workListStatus === 'idle') void workStore.getState().load();
  }, [workListStatus, workStore]);

  useEffect(() => {
    if (reviewsStatus === 'idle') void workStore.getState().loadReviews();
  }, [reviewsStatus, workStore]);

  const loadOwners = useCallback((): void => {
    void store.getState().loadOwners();
  }, [store]);
  const assignOwner = useCallback(
    (
      targetScope: LedgerViewScope,
      entryId: string,
      owner: LedgerOwnerCandidate | null,
    ): Promise<void> | void => {
      if (ledgerViewScopeKey(targetScope) !== scopeKey) return;
      return store.getState().assignOwnerOf(entryId, owner);
    },
    [scopeKey, store],
  );
  const leftOpenActions = useMemo(
    () => ({ candidates, ownersStatus, loadOwners, assignOwner }),
    [assignOwner, candidates, loadOwners, ownersStatus],
  );

  const onMarkCompleted = useCallback(
    async (
      item: LedgerNeedsYouItem,
    ): Promise<
      { readonly ok: true } | { readonly ok: false; readonly message: string }
    > => {
      if (item.review === undefined) {
        return { ok: false, message: 'This item cannot be completed.' };
      }
      return await workStore.getState().markCompleted(item.review);
    },
    [workStore],
  );

  // Opening an entry in Activity scrolls to its row, so the jump lands on it.
  const revealEntry = useLedgerEntryReveal();
  const openEntryInActivity = useCallback(
    (entryId: string): void => {
      void store.getState().select(entryId);
      revealEntry(
        activitySectionRef.current,
        entryId,
        activitySectionRef.current,
      );
    },
    [store, revealEntry],
  );
  const onOpenReview = useCallback(
    (item: LedgerNeedsYouItem): void => {
      const review = item.review;
      if (
        review?.origin.kind !== 'this_device' ||
        ledgerViewScopeKey(review.origin.scope) !== scopeKey
      ) {
        return;
      }
      openEntryInActivity(review.entry.entryId);
    },
    [openEntryInActivity, scopeKey],
  );
  const onOpenEntry = useCallback(
    (entryScope: LedgerViewScope, entryId: string): void => {
      if (ledgerViewScopeKey(entryScope) !== scopeKey) return;
      openEntryInActivity(entryId);
    },
    [openEntryInActivity, scopeKey],
  );
  const onRetryReviews = useCallback((): void => {
    void workStore.getState().loadReviews();
  }, [workStore]);
  const onResolveCloseIntent = useCallback(
    (choice: LedgerCloseIntentChoice) =>
      workStore.getState().resolveCloseIntent(choice),
    [workStore],
  );
  const now = Date.now();

  // A stable gutter keeps the rows' width when the scrollbar comes and goes,
  // as Activity's loading skeleton gives way to its entries. Positioned, so a
  // row's visually hidden actions lay out in this scroller, not around it.
  return (
    <div
      ref={sectionsScrollRef}
      data-testid="ledger-panel-sections"
      onScroll={(event): void =>
        store.getState().setScrollTop(event.currentTarget.scrollTop)
      }
      className="relative min-h-0 min-w-0 flex-1 overflow-y-auto"
      style={{ scrollbarGutter: 'stable' }}
    >
      {/* The panel has no page margin: headings and the status counts inset
          to the rows under them. */}
      <div className="flex min-w-0 flex-col gap-4 pb-4 [&_[data-feed-section-heading]]:px-3 [&_[data-testid=feed-status-counts]]:px-3">
        {rootChats === undefined ? null : (
          <div className="px-3 pt-2">
            <LedgerRootChatFilterBar
              rootChats={rootChats}
              filter={rootChat}
              onChange={setRootChat}
            />
          </div>
        )}
        <LedgerFeedNeedsYou
          layout="panel"
          hideWhenEmpty
          items={needsYou}
          actors={actors}
          scopeNames={scopeNames}
          onOpenScope={onOpenScope}
          pathRoot={scope}
          answers={answers}
          onMarkCompleted={onMarkCompleted}
          onOpenReview={onOpenReview}
          reviewsStatus={reviewsStatus}
          onRetryReviews={onRetryReviews}
          closeIntent={closeIntent}
          onResolveCloseIntent={onResolveCloseIntent}
          now={now}
        />
        <LedgerFeedOperations
          store={workStore}
          snapshot={scopedSnapshot}
          scopeNames={scopeNames}
          onOpenScope={onOpenScope}
          answers={answers}
          personActorId={personActorId}
          personName={personName}
          now={now}
          onOpenEntry={onOpenEntry}
          layout="panel"
          hideWhenEmpty
          pathRoot={scope}
          leftOpenActions={leftOpenActions}
          rootChat={rootChat}
        />
        <div ref={activitySectionRef}>
          <LedgerPanelActivity
            store={store}
            client={client}
            navigator={navigator}
            files={files}
            personName={personName}
            heading
            scrollContainer="parent"
            scrollElement={scrollElement}
          />
        </div>
      </div>
    </div>
  );
}
