'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type UIEvent,
  type JSX,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import type {
  CanopyCapabilities,
  LedgerFeedAnswerActions,
  LedgerFeedClient,
  LedgerLiveSnapshot,
  LedgerLiveStateSource,
} from '@canopy/app-core';
import { createLedgerFeedStore, type LedgerFeedStore } from '@canopy/app-state';
import {
  createLedgerFeedWorkStore,
  deriveNeedsYou,
  type LedgerNeedsYouItem,
  type LedgerFeedWorkStore,
} from '@canopy/app-state/ledger-feed';
import type { LedgerViewScope } from '@canopy/protocol/ledger-view';
import { PageColumn, Stack } from '@canopy/ui-shared/components';
import { LedgerFeed } from './LedgerFeed';
import type {
  LedgerFeedLocal,
  LedgerFeedLocalEntryOpener,
  LedgerFeedProps,
} from './LedgerFeed';
import { LedgerFeedNeedsYou } from './LedgerFeedNeedsYou';
import { LedgerFeedOperations } from './LedgerFeedOperations';
import type { LedgerScopeNamesFor } from './ledger-work-path';
import type { LedgerCloseIntentChoice } from './ledger-close-intent';
import { useLedgerEntryReveal } from './ledger-reveal-entry';

const EMPTY_LIVE_SNAPSHOT: LedgerLiveSnapshot = { agents: {}, waits: [] };
const NOOP_UNSUBSCRIBE = (): void => undefined;
const EMPTY_SNAPSHOT = (): LedgerLiveSnapshot => EMPTY_LIVE_SNAPSHOT;
const DEFAULT_PERSON_NAME = 'You';

type ActivityProps = Omit<
  LedgerFeedProps,
  | 'store'
  | 'local'
  | 'scopeNames'
  | 'onOpenScope'
  | 'scrollElement'
  | 'heading'
  | 'registerLocalEntryOpener'
>;

export interface LedgerFeedSectionsProps extends ActivityProps {
  /** This device's Ledger; the sections need a host that holds one. */
  readonly local: LedgerFeedLocal;
  /** The client's Activity reads; retained stores may be supplied by a host. */
  readonly feedClient: LedgerFeedClient;
  readonly activityStore?: LedgerFeedStore;
  readonly workStore?: LedgerFeedWorkStore;
  readonly liveStateSource: LedgerLiveStateSource;
  readonly capabilities: Pick<CanopyCapabilities, 'ledgerLiveAgentStates'>;
  readonly answers: LedgerFeedAnswerActions | null;
  readonly personActorId?: string | null;
  readonly scopeNames: LedgerScopeNamesFor;
  readonly onOpenScope?: (scope: LedgerViewScope) => void;
  /** The page's heading, which scrolls with the sections. */
  readonly heading?: ReactNode;
}

/** The Feed page's shared Needs you, Operations and Activity sections. */
export function LedgerFeedSections({
  local,
  feedClient,
  activityStore: retainedActivityStore,
  workStore: retainedWorkStore,
  liveStateSource,
  capabilities,
  answers,
  personActorId,
  personName = DEFAULT_PERSON_NAME,
  scopeNames,
  onOpenScope,
  heading,
  ...activityProps
}: LedgerFeedSectionsProps): JSX.Element {
  const { client } = local;
  const activityStore = useMemo(
    () => retainedActivityStore ?? createLedgerFeedStore(feedClient),
    [feedClient, retainedActivityStore],
  );
  const workStore = useMemo(
    () => retainedWorkStore ?? createLedgerFeedWorkStore(feedClient, client),
    [client, feedClient, retainedWorkStore],
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
  const needsYou = useMemo(
    () => deriveNeedsYou(liveSnapshot, reviewRows),
    [liveSnapshot, reviewRows],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const localEntryOpenerRef = useRef<LedgerFeedLocalEntryOpener | null>(null);
  const registerLocalEntryOpener = useCallback(
    (opener: LedgerFeedLocalEntryOpener | null): void => {
      localEntryOpenerRef.current = opener;
    },
    [],
  );
  const scrollElement = useCallback(
    (): HTMLElement | null => scrollRef.current,
    [],
  );
  const onScroll = useCallback(
    (event: UIEvent<HTMLDivElement>): void => {
      activityStore.getState().setScrollTop(event.currentTarget.scrollTop);
    },
    [activityStore],
  );

  useEffect(() => {
    const state = workStore.getState();
    const disconnect = state.connect();
    // A retained store refreshes on each visit; an idle one loads below.
    if (state.work.status !== 'idle') void state.load();
    if (state.reviews.status !== 'idle') void state.loadReviews();
    return disconnect;
  }, [workStore]);

  // An account change resets the retained store to idle while the page is open.
  useEffect(() => {
    if (workListStatus === 'idle') void workStore.getState().load();
  }, [workListStatus, workStore]);
  useEffect(() => {
    if (reviewsStatus === 'idle') void workStore.getState().loadReviews();
  }, [reviewsStatus, workStore]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element !== null) {
      element.scrollTop = activityStore.getState().scrollTop;
    }
  }, [activityStore]);

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
  const onOpenReview = useCallback((item: LedgerNeedsYouItem): void => {
    const review = item.review;
    if (review?.origin.kind !== 'this_device') return;
    localEntryOpenerRef.current?.(review.origin.scope, review.entry.entryId);
  }, []);
  const onRetryReviews = useCallback((): void => {
    void workStore.getState().loadReviews();
  }, [workStore]);
  const onResolveCloseIntent = useCallback(
    (choice: LedgerCloseIntentChoice) =>
      workStore.getState().resolveCloseIntent(choice),
    [workStore],
  );
  // Open entry opens it in Activity and scrolls to its row.
  const revealEntry = useLedgerEntryReveal();
  const onOpenEntry = useCallback(
    (scope: LedgerViewScope, entryId: string): void => {
      localEntryOpenerRef.current?.(scope, entryId);
      const page = scrollRef.current;
      revealEntry(
        page,
        entryId,
        page?.querySelector<HTMLElement>('[data-testid="feed-activity"]') ??
          null,
      );
    },
    [revealEntry],
  );

  // The page scrolls as one, its scrollbar at the page's edge: the heading
  // and sections move together in the Feed's page column, as wide as
  // Workflows so the Operations table has room. The scroller is positioned so a row's visually hidden actions lay out in it,
  // not in the page around it, which would then scroll past the Feed. Its
  // gutter is reserved on both edges, as the desktop's pages reserve theirs,
  // so the centered content keeps its place whether or not it overflows.
  return (
    <div
      ref={scrollRef}
      data-testid="ledger-feed-page"
      onScroll={onScroll}
      className="relative min-h-0 min-w-0 flex-1 overflow-y-auto"
      style={{ scrollbarGutter: 'stable both-edges' }}
    >
      <PageColumn width="wide" data-testid="ledger-feed-page-column">
        {/* The heading introduces the sections, 16px above them, as it does
            the Feed's list. */}
        <Stack gap="group">
          {heading}
          <div className="flex min-w-0 flex-col gap-8 pb-8">
            <LedgerFeedNeedsYou
              items={needsYou}
              actors={actors}
              scopeNames={scopeNames}
              onOpenScope={onOpenScope}
              answers={answers}
              onMarkCompleted={onMarkCompleted}
              onOpenReview={onOpenReview}
              reviewsStatus={reviewsStatus}
              onRetryReviews={onRetryReviews}
              closeIntent={closeIntent}
              onResolveCloseIntent={onResolveCloseIntent}
              now={Date.now()}
            />
            <LedgerFeedOperations
              store={workStore}
              snapshot={liveSnapshot}
              scopeNames={scopeNames}
              onOpenScope={onOpenScope}
              answers={answers}
              personActorId={personActorId}
              personName={personName}
              now={Date.now()}
              onOpenEntry={onOpenEntry}
            />
            <LedgerFeed
              {...activityProps}
              store={activityStore}
              local={local}
              personName={personName}
              scopeNames={scopeNames}
              onOpenScope={onOpenScope}
              scrollElement={scrollElement}
              heading
              registerLocalEntryOpener={registerLocalEntryOpener}
            />
          </div>
        </Stack>
      </PageColumn>
    </div>
  );
}
