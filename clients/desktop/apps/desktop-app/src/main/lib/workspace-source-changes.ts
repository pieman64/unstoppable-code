import type { BrowserWindow } from 'electron';
import type {
  ProjectApplySourceChangesRequest,
  ProjectApplySourceChangesResponse,
  ProjectSourceChangesAppliedEvent,
  WorkspaceApplySourceChangesRequest,
  WorkspaceApplySourceChangesResponse,
  WorkspaceSourceChangesAppliedEvent,
} from '@canopy/desktop-shared/types';
import { applyProjectSourceChangesToWorktree } from './project-source-change-apply';
import { validateId } from './validation';
import { applyWorkspaceSourceChangesToWorktree } from './workspace-source-change-apply';

export {
  WorkspaceSourceChangesRefusedError,
  type WorkspaceSourceChangesRefusal,
} from './workspace-source-change-refusal';

/** Host hooks of a source change: the window for setup progress. */
interface SourceChangesHost<Event> {
  getWindow: () => BrowserWindow | null;
  /** Called once `canopy.json` (and the instructions file) is written. */
  onApplied?: (event: Event) => void;
}

/**
 * `core.workspace.sourceChanges.apply` (CAN-3819): source-controlled settings
 * written to `canopy.json` in a worktree, an existing one or one created for
 * the change. A multi-repo workspace's change is applied in its root
 * worktree and can add or remove repositories; a single-repo project's in
 * its only checkout.
 */
export type WorkspaceSourceChangesRequest =
  | ({
      kind: 'workspace';
      /** `workspace:apply-source-changes`. */
      source: 'workspace_settings';
      request: WorkspaceApplySourceChangesRequest;
    } & SourceChangesHost<WorkspaceSourceChangesAppliedEvent>)
  | ({
      kind: 'project';
      /** `project:apply-source-changes`. */
      source: 'project_settings';
      request: ProjectApplySourceChangesRequest;
    } & SourceChangesHost<ProjectSourceChangesAppliedEvent>);

/**
 * The typed in-process `core.workspace.sourceChanges.apply` boundary
 * (CAN-3819). The caller keeps its own gates (the start page feature flag and,
 * for a workspace, the organization's repository sync around the apply).
 *
 * A target worktree created for the change is recorded by appending its row
 * to the list read under the list lock, so rows written while it was checked
 * out keep their state; a failed apply removes the checkout and the row, as
 * before. Repository bindings that follow the applied `canopy.json` are
 * written in the background to the manifest read inside its write queue.
 * Refusals are {@link WorkspaceSourceChangesRefusedError}s with the existing
 * messages. It makes no revision or idempotency guarantee (CAN-3805), so the
 * operation stays unregistered.
 */
export function applySourceChanges(
  request: Extract<WorkspaceSourceChangesRequest, { kind: 'workspace' }>,
): Promise<WorkspaceApplySourceChangesResponse>;
export function applySourceChanges(
  request: Extract<WorkspaceSourceChangesRequest, { kind: 'project' }>,
): Promise<ProjectApplySourceChangesResponse>;
export async function applySourceChanges(
  request: WorkspaceSourceChangesRequest,
): Promise<
  WorkspaceApplySourceChangesResponse | ProjectApplySourceChangesResponse
> {
  if (request.kind === 'workspace') {
    const change = request.request;
    validateId(change.workspaceId, 'workspaceId');
    if (change.target.mode === 'existing') {
      validateId(change.target.worktreeId, 'worktreeId');
    }
    return applyWorkspaceSourceChangesToWorktree(
      change,
      request.getWindow,
      request.onApplied,
    );
  }
  const change = request.request;
  validateId(change.projectId, 'projectId');
  if (change.target.mode === 'existing') {
    validateId(change.target.worktreeId, 'worktreeId');
  }
  return applyProjectSourceChangesToWorktree(
    change,
    request.getWindow,
    request.onApplied,
  );
}
