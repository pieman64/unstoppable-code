import type { JSX } from 'react';
import { useInstallWorkspaces } from '@/hooks/useInstallWorkspaces';
import { requestAutomationProjectCreation } from '@/stores/automationInstallContinuationStore';
import { InstallSharedAutomationModal } from './InstallSharedAutomationModal';
import type { PendingAutomationUpdate } from './useAutomationUpdateSource';

/**
 * The install wizard applying a loaded update to one installed copy, as the
 * Marketplace detail's Update does (CAN-4845).
 */
export function AutomationUpdateModal({
  update,
  onClose,
}: {
  readonly update: PendingAutomationUpdate;
  readonly onClose: () => void;
}): JSX.Element {
  const workspaces = useInstallWorkspaces();
  return (
    <InstallSharedAutomationModal
      onCreateProject={requestAutomationProjectCreation}
      detail={update.detail}
      source={update.sourceKind}
      staleActivities={[update.activity]}
      workspaces={workspaces}
      onClose={onClose}
      onDone={(): void => {
        // The automations store refreshes through the service broadcast, and
        // the row recomputes from it.
      }}
    />
  );
}
