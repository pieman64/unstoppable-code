import { useMemo, type JSX } from 'react';
import { useStore } from 'zustand';
import type { SessionBreakdownStore } from '@canopy/app-state/cost';
import type { CostScopeRef } from '@canopy/protocol/cost-view';
import {
  SessionBreakdownView,
  useSessionBreakdownStore,
} from '@canopy/ui-app/cost';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { brandText } from '@/lib/brand';
import { DESKTOP_COST_NAVIGATOR } from '@/lib/cost/cost-navigator';
import {
  sessionBreakdownUiState,
  sessionBreakdownUiStateKey,
} from '@/lib/cost/cost-panel-ui-state';
import { desktopCostClient } from '@/lib/cost/ipc-cost-client';

export interface SessionBreakdownPanelHostProps {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

interface SessionBreakdownUiStateReporterProps extends SessionBreakdownPanelHostProps {
  readonly store: SessionBreakdownStore;
}

/** Reports the open breakdown to App Advisor (see `sessionBreakdownUiState`). */
function SessionBreakdownUiStateReporter({
  store,
  projectId,
  worktreeId,
  chatId,
}: SessionBreakdownUiStateReporterProps): null {
  const status = useStore(store, (state) => state.status);
  const value = useStore(store, (state) => state.value);
  useCurrentUiStateReporter(
    sessionBreakdownUiStateKey(projectId, worktreeId, chatId),
    sessionBreakdownUiState(projectId, worktreeId, chatId, status, value),
  );
  return null;
}

function SessionBreakdownBody({
  projectId,
  worktreeId,
  chatId,
}: SessionBreakdownPanelHostProps): JSX.Element {
  const scope = useMemo(
    (): CostScopeRef => ({ kind: 'entry', projectId, worktreeId }),
    [projectId, worktreeId],
  );
  const store = useSessionBreakdownStore(desktopCostClient, scope, chatId);
  return (
    <>
      <SessionBreakdownUiStateReporter
        store={store}
        projectId={projectId}
        worktreeId={worktreeId}
        chatId={chatId}
      />
      <SessionBreakdownView
        client={desktopCostClient}
        navigator={DESKTOP_COST_NAVIGATOR}
        scope={scope}
        chatId={chatId}
        store={store}
        appName={brandText.shortName}
      />
    </>
  );
}

/**
 * Mounts one chat's shared Session breakdown in its owning panel scope. The
 * view pins its header and tabs and scrolls only the tab panel, so this host
 * gives it a bounded, full-height flex box and never adds a scroll container.
 */
export function SessionBreakdownPanelHost({
  projectId,
  worktreeId,
  chatId,
}: SessionBreakdownPanelHostProps): JSX.Element {
  return (
    <div
      data-testid="session-breakdown-panel-host"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <SessionBreakdownBody
        projectId={projectId}
        worktreeId={worktreeId}
        chatId={chatId}
      />
    </div>
  );
}
