import { notifyPortalStructureChanged } from '../portal/portal-event-bus';
import { schedulePortalStructuralSync } from '../portal/portal-structural-sync';
import { refreshWorkspaceRegistries } from '../lib/sidebar-items';
import { readWorkspaceWorktreesUnlocked } from '../lib/workspace-persistence';
import { reconcileManifestPluginDefaults } from '../lib/workspace-plugin-defaults';
import { listRegisteredWorkspaceIds } from '../lib/workspace-registry';
import {
  publishWorktreeLifecycleChange,
  publishWorktreeListWrite,
} from '../lib/worktree-lifecycle-signals';
import type { WorkspaceCommitEventHandlers } from './workspace-commit-events';

/** No read of the manifest decided its plugin layer; the revision may lag. */
export class ManifestPluginDefaultsUndecidedError extends Error {
  constructor(readonly workspaceId: string) {
    super('The manifest plugin defaults were not reconciled.');
    this.name = 'ManifestPluginDefaultsUndecidedError';
  }
}

/**
 * Main's handlers for W5e commit events from other origins (CAN-5497): the
 * same refreshes Electron's own writers run after their commits, minus the
 * self-write record, the sidecar `afterWrite`, telemetry and the sidebar
 * group signal, which stay with the issuing writer (W8 moves the first two).
 */
export function createDesktopWorkspaceCommitEventHandlers(): WorkspaceCommitEventHandlers {
  return {
    schedulePortalStructuralSync,
    notifyPortalStructureChanged,
    refreshWorkspaceRegistries,
    // An undecided reconcile leaves the session revision behind the file.
    reconcileManifestPluginDefaults: async (workspaceId) => {
      if (!(await reconcileManifestPluginDefaults(workspaceId, false)))
        throw new ManifestPluginDefaultsUndecidedError(workspaceId);
    },
    listWorkspaceIds: listRegisteredWorkspaceIds,
    readWorktreeList: readWorkspaceWorktreesUnlocked,
    publishWorktreeListWrite: (previous, next) =>
      publishWorktreeListWrite(previous, next),
    publishWorktreeMembershipChange: () =>
      publishWorktreeLifecycleChange('worktree-list-membership'),
  };
}
