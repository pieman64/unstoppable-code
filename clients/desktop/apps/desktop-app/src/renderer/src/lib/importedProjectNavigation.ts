import {
  serializeWorkspaceContext,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';
import { getSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { navigateAfterRepositoryWorkspaceCreated } from '@/lib/postWorkspaceCreateNavigation';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

/** The sidebar context when an import of Claude or Codex projects started. */
export interface ProjectImportSubmission {
  readonly sidebarContext: WorkspaceContext | undefined;
  readonly accountEpoch: number;
  readonly revision: number;
  readonly contextKey: string;
}

export function captureProjectImportSubmission(): ProjectImportSubmission {
  const state = useWorkspaceContextStore.getState();
  return {
    sidebarContext: getSidebarScopingContext(),
    accountEpoch: state.accountEpoch,
    revision: state.state.revision,
    contextKey: serializeWorkspaceContext(state.state.context),
  };
}

/**
 * Opens a project imported from Claude or Codex. Imports are Personal, so an
 * organization sidebar switches to Personal first; if the account or context
 * changed while the import ran, the member's newer choice wins and nothing
 * opens.
 */
export async function openImportedProject(
  submission: ProjectImportSubmission,
  workspaceId: string,
): Promise<void> {
  const current = useWorkspaceContextStore.getState();
  const stillCurrent =
    current.accountEpoch === submission.accountEpoch &&
    current.state.revision === submission.revision &&
    serializeWorkspaceContext(current.state.context) === submission.contextKey;
  if (!stillCurrent) return;
  if (submission.sidebarContext?.kind === 'organization') {
    await current.setContext({ kind: 'personal' });
  }
  navigateAfterRepositoryWorkspaceCreated(workspaceId);
}
