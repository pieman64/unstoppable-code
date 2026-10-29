import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { LedgerFeedStore } from '@canopy/app-state';
import type { LedgerViewScope } from '@canopy/protocol/ledger-view';
import { LedgerFeed } from '@canopy/ui-app/ledger';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  describeLedgerScope,
  ledgerFeedAddableScopes,
  type LedgerFeedScopeSources,
} from '@/lib/ledger/ledger-feed-scopes';
import { ledgerFeedUiState } from '@/lib/ledger/ledger-feed-ui-state';
import { DESKTOP_LEDGER_FILE_PICKER } from '@/lib/ledger/ledger-file-picker';
import { DESKTOP_LEDGER_NAVIGATOR } from '@/lib/ledger/ledger-navigator';
import {
  desktopLedgerClient,
  ledgerFeedStore,
  ledgerViewHasDraft,
  ledgerViewStoreFor,
} from '@/lib/ledger/ledger-view-stores';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { PageContent } from '../shared/PageContent';
import { PageHeading } from '../shared/PageHeading';
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
function FeedUiStateReporter({ store }: { store: LedgerFeedStore }): null {
  const value = store(useShallow(ledgerFeedUiState));
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
  const projects = useProjectsStore((state) => state.projects);
  const { workEntries, activeChatProjectId, sidebarEntriesByProject } =
    useStandaloneChatStore(
      useShallow((state) => ({
        workEntries: state.workEntries,
        activeChatProjectId: state.activeChatProjectId,
        sidebarEntriesByProject: state.sidebarEntriesByProject,
      })),
    );
  const sources = useMemo(
    (): LedgerFeedScopeSources => ({
      projects,
      coworkEntries: {
        ...sidebarEntriesByProject,
        [activeChatProjectId]: workEntries,
      },
    }),
    [projects, sidebarEntriesByProject, activeChatProjectId, workEntries],
  );
  const describeScope = useCallback(
    (scope: LedgerViewScope): string | null =>
      describeLedgerScope(scope, sources),
    [sources],
  );
  const addableScopes = useMemo(
    () => ledgerFeedAddableScopes(sources),
    [sources],
  );
  const scopeStore = useCallback(
    (scope: LedgerViewScope) =>
      ledgerViewStoreFor(scope.projectId, scope.worktreeId),
    [],
  );
  const scopeHasDraft = useCallback(
    (scope: LedgerViewScope): boolean =>
      ledgerViewHasDraft(scope.projectId, scope.worktreeId),
    [],
  );
  const visible = useDocumentVisible();

  return (
    <section className="flex h-full min-h-0 flex-col" data-testid="page-feed">
      <PageTitlebar />
      <PageContent bottomInset="tight">
        <PageHeading
          title="Feed"
          subtitle="Entries from all your projects and tasks, newest change first."
        />
      </PageContent>
      <PageContent className="flex min-h-0 flex-1 flex-col">
        <FeedUiStateReporter store={store} />
        <LedgerFeed
          store={store}
          client={desktopLedgerClient}
          navigator={DESKTOP_LEDGER_NAVIGATOR}
          files={DESKTOP_LEDGER_FILE_PICKER}
          scopeStore={scopeStore}
          scopeHasDraft={scopeHasDraft}
          describeScope={describeScope}
          addableScopes={addableScopes}
          visible={visible}
        />
      </PageContent>
    </section>
  );
}
