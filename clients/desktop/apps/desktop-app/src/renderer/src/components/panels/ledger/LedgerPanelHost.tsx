import { useMemo, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { LedgerViewStore } from '@canopy/app-state';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { LedgerPanel } from '@canopy/ui-app/ledger';
import { Notice } from '@canopy/ui-shared/components';
import type { AppAdvisorJson } from '@canopy/desktop-shared/types';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { DESKTOP_LEDGER_FILE_PICKER } from '@/lib/ledger/ledger-file-picker';
import { DESKTOP_LEDGER_NAVIGATOR } from '@/lib/ledger/ledger-navigator';
import { ledgerPanelUiState } from '@/lib/ledger/ledger-panel-ui-state';
import {
  desktopLedgerClient,
  ledgerViewStoreFor,
} from '@/lib/ledger/ledger-view-stores';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

/** Reports an open Feed panel to App Advisor (see `ledgerPanelUiState`). */
function LedgerPanelUiStateReporter({
  store,
  projectId,
  worktreeId,
}: {
  store: LedgerViewStore;
  projectId: string;
  worktreeId: string;
}): null {
  const value = store(
    useShallow(
      (state): AppAdvisorJson =>
        ledgerPanelUiState(state, projectId, worktreeId),
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
 * The desktop Feed panel (panel kind `ledger`) for one work scope: the shared panel over the IPC
 * client and the desktop navigator. With `canopy-ledger-enabled` off it reads
 * nothing and says so; a layout that kept the panel still opens.
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
        projectId={projectId}
        worktreeId={worktreeId}
      />
      <LedgerPanel
        store={store}
        client={desktopLedgerClient}
        navigator={DESKTOP_LEDGER_NAVIGATOR}
        files={DESKTOP_LEDGER_FILE_PICKER}
      />
    </>
  );
}
