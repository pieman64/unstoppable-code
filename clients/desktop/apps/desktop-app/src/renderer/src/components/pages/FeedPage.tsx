import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type JSX,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { LedgerFeedStore } from '@canopy/app-state';
import type { LedgerFeedWorkStore } from '@canopy/app-state/ledger-feed';
import { deriveNeedsYou } from '@canopy/app-state/ledger-feed';
import type {
  LedgerLiveSnapshot,
  LedgerLiveStateSource,
} from '@canopy/app-core';
import type { LedgerViewScope } from '@canopy/protocol/ledger-view';
import {
  LedgerFeedPage,
  LedgerFeedSections,
  type LedgerFeedLocal,
} from '@canopy/ui-app/ledger';
import { useCanopyClient } from '@canopy/app-state';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { ledgerFeedAddableScopes } from '@/lib/ledger/ledger-feed-scopes';
import { ledgerFeedUiState } from '@/lib/ledger/ledger-feed-ui-state';
import { DESKTOP_LEDGER_FILE_PICKER } from '@/lib/ledger/ledger-file-picker';
import {
  DESKTOP_LEDGER_NAVIGATOR,
  openLedgerScope,
} from '@/lib/ledger/ledger-navigator';
import {
  desktopLedgerClient,
  desktopLedgerFeedClient,
  ledgerFeedStore,
  ledgerFeedWorkStore,
  ledgerViewScopeHasDraft,
  ledgerViewStoreForScope,
} from '@/lib/ledger/ledger-view-stores';
import { desktopLedgerLiveStateSource } from '@/lib/ledger/ledger-live-state';
import { DESKTOP_LEDGER_FEED_ANSWERS } from '@/lib/ledger/ledger-feed-answers';
import { useLedgerScopeNames } from '@/lib/ledger/use-ledger-scope-names';
import { PageTitlebar } from '../shared/PageTitlebar';

/** Whether the window is on screen; the Feed looks for activity only then. */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => document.visibilityState !== 'hidden',
  );
  useEffect(() => {
    const update = (): void => {
      setVisible(document.visibilityState !== 'hidden');
    };
    document.addEventListener('visibilitychange', update);
    return (): void => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

/** Reports the Feed to App Advisor (see `ledgerFeedUiState`). */
const EMPTY_LIVE_SNAPSHOT: LedgerLiveSnapshot = { agents: {}, waits: [] };

function FeedUiStateReporter({
  store,
  workStore,
  liveStateSource,
  ledgerLiveAgentStates,
}: {
  readonly store: LedgerFeedStore;
  readonly workStore: LedgerFeedWorkStore;
  readonly liveStateSource: LedgerLiveStateSource;
  readonly ledgerLiveAgentStates: boolean;
}): null {
  const { statusFilter, sort, openIds, olderShown, actorHosts, reviewRows } =
    workStore(
      useShallow((state) => ({
        statusFilter: state.statusFilter,
        sort: state.sort,
        openIds: state.openIds,
        olderShown: state.olderShown,
        actorHosts: state.work.actorHosts,
        reviewRows: state.reviews.rows,
      })),
    );
  const subscribe = useCallback(
    (listener: () => void): (() => void) =>
      ledgerLiveAgentStates
        ? liveStateSource.subscribe(listener)
        : (): void => undefined,
    [ledgerLiveAgentStates, liveStateSource],
  );
  const getSnapshot = useCallback(
    (): LedgerLiveSnapshot =>
      ledgerLiveAgentStates
        ? liveStateSource.getSnapshot(actorHosts)
        : EMPTY_LIVE_SNAPSHOT,
    [actorHosts, ledgerLiveAgentStates, liveStateSource],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    (): LedgerLiveSnapshot => EMPTY_LIVE_SNAPSHOT,
  );
  const workUiState = { statusFilter, sort, openIds, olderShown };
  const needsYouCount = deriveNeedsYou(snapshot, reviewRows).length;
  const value = store(
    useShallow((state) => ledgerFeedUiState(state, workUiState, needsYouCount)),
  );
  useCurrentUiStateReporter('ledger.feed', value);
  return null;
}

/**
 * The global Ledger Feed page (phase 14): entries from every project and
 * task, the person's other devices and, when asked, their teammates. Shown
 * only while `canopy-ledger-enabled` is on.
 */
export function FeedPage(): JSX.Element {
  const store = useMemo(() => ledgerFeedStore(), []);
  const workStore = useMemo(() => ledgerFeedWorkStore(), []);
  const { sources, describeScope, scopeNames } = useLedgerScopeNames();
  const addableScopes = useMemo(
    () => ledgerFeedAddableScopes(sources),
    [sources],
  );
  const local = useMemo(
    (): LedgerFeedLocal => ({
      client: desktopLedgerClient,
      navigator: DESKTOP_LEDGER_NAVIGATOR,
      files: DESKTOP_LEDGER_FILE_PICKER,
      scopeStore: ledgerViewStoreForScope,
      scopeHasDraft: ledgerViewScopeHasDraft,
      describeScope,
      addableScopes,
    }),
    [describeScope, addableScopes],
  );
  const { capabilities } = useCanopyClient();
  const visible = useDocumentVisible();
  const onOpenScope = useCallback(
    (scope: LedgerViewScope): void => {
      store.getState().focusScope(scope);
      void openLedgerScope(scope);
    },
    [store],
  );

  return (
    <section className="flex h-full min-h-0 flex-col" data-testid="page-feed">
      <PageTitlebar />
      <FeedUiStateReporter
        store={store}
        workStore={workStore}
        liveStateSource={desktopLedgerLiveStateSource}
        ledgerLiveAgentStates={capabilities.ledgerLiveAgentStates === true}
      />
      {/* The Feed's sections scroll as one page, their scrollbar at the
          window's edge and their 32px bottom inside the scroller. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <LedgerFeedPage
          capabilities={capabilities}
          store={store}
          local={local}
          visible={visible}
          sections={(heading) => (
            <LedgerFeedSections
              heading={heading}
              local={local}
              feedClient={desktopLedgerFeedClient}
              activityStore={store}
              workStore={workStore}
              visible={visible}
              liveStateSource={desktopLedgerLiveStateSource}
              capabilities={capabilities}
              answers={DESKTOP_LEDGER_FEED_ANSWERS}
              scopeNames={scopeNames}
              onOpenScope={onOpenScope}
            />
          )}
        />
      </div>
    </section>
  );
}
