import { useMemo, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useCapabilities, type LedgerViewStore } from '@canopy/app-state';
import type { LedgerFeedWorkStore } from '@canopy/app-state/ledger-feed';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { LedgerPanelSections } from '@canopy/ui-app/ledger';
import { Notice } from '@canopy/ui-shared/components';
import type { AppAdvisorJson } from '@canopy/desktop-shared/types';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { DESKTOP_LEDGER_FILE_PICKER } from '@/lib/ledger/ledger-file-picker';
import { DESKTOP_LEDGER_FEED_ANSWERS } from '@/lib/ledger/ledger-feed-answers';
import { desktopLedgerLiveStateSource } from '@/lib/ledger/ledger-live-state';
import {
  DESKTOP_LEDGER_NAVIGATOR,
  openLedgerScope,
} from '@/lib/ledger/ledger-navigator';
import {
  ledgerPanelUiState,
  type LedgerPanelWorkUiState,
} from '@/lib/ledger/ledger-panel-ui-state';
import {
  desktopLedgerClient,
  ledgerPanelWorkStoreFor,
  ledgerViewStoreFor,
} from '@/lib/ledger/ledger-view-stores';
import { useLedgerRootChats } from '@/lib/ledger/use-ledger-root-chats';
import { useLedgerScopeNames } from '@/lib/ledger/use-ledger-scope-names';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

/** Reports an open Feed panel to App Advisor (see `ledgerPanelUiState`). */
function LedgerPanelUiStateReporter({
  store,
  workStore,
  projectId,
  worktreeId,
}: {
  store: LedgerViewStore;
  workStore: LedgerFeedWorkStore;
  projectId: string;
  worktreeId: string;
}): null {
  const work = workStore(
    useShallow(
      (state): LedgerPanelWorkUiState => ({
        statusFilter: state.statusFilter,
        openIds: state.openIds,
        rowCount: state.work.rows.length,
        closePending: state.closeIntent !== null,
      }),
    ),
  );
  const value = store(
    useShallow(
      (state): AppAdvisorJson =>
        ledgerPanelUiState(state, projectId, worktreeId, work),
    ),
  );
  useCurrentUiStateReporter(`ledger.panel.${projectId}/${worktreeId}`, value);
  return null;
}

export interface LedgerPanelHostProps {
  projectId: string;
  worktreeId: string;
}

/**
 * The desktop Feed panel (panel kind `ledger`) for one work scope: the shared
 * Needs you, Operations and Activity sections over the IPC clients, the
 * desktop navigator and live chat state. With `canopy-ledger-enabled` off it
 * reads nothing and says so; a layout that kept the panel still opens.
 */
export function LedgerPanelHost({
  projectId,
  worktreeId,
}: LedgerPanelHostProps): JSX.Element {
  const enabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key),
  );
  const store = useMemo(
    () => ledgerViewStoreFor(projectId, worktreeId),
    [projectId, worktreeId],
  );
  const workStore = useMemo(
    () => ledgerPanelWorkStoreFor(projectId, worktreeId),
    [projectId, worktreeId],
  );
  const capabilities = useCapabilities();
  const { scopeNames } = useLedgerScopeNames();
  const rootChats = useLedgerRootChats(projectId, worktreeId);
  if (!enabled) {
    return (
      <div className="p-3">
        <Notice data-testid="ledger-panel-unavailable" intent="neutral">
          The Feed isn&apos;t available.
        </Notice>
      </div>
    );
  }
  return (
    <>
      <LedgerPanelUiStateReporter
        store={store}
        workStore={workStore}
        projectId={projectId}
        worktreeId={worktreeId}
      />
      <LedgerPanelSections
        store={store}
        workStore={workStore}
        client={desktopLedgerClient}
        navigator={DESKTOP_LEDGER_NAVIGATOR}
        files={DESKTOP_LEDGER_FILE_PICKER}
        liveStateSource={desktopLedgerLiveStateSource}
        capabilities={capabilities}
        answers={DESKTOP_LEDGER_FEED_ANSWERS}
        scopeNames={scopeNames}
        onOpenScope={openLedgerScope}
        rootChats={rootChats}
      />
    </>
  );
}
