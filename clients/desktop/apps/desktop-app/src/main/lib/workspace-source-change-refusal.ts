export type WorkspaceSourceChangesRefusal =
  | 'not-found'
  | 'not-single-repo'
  | 'no-source-repository'
  | 'invalid-request';

/**
 * `core.workspace.sourceChanges.apply` was refused (CAN-3819). Every refusal
 * comes before the source files are written; a target worktree created for
 * the change is rolled back as before.
 */
export class WorkspaceSourceChangesRefusedError extends Error {
  constructor(
    readonly reason: WorkspaceSourceChangesRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceSourceChangesRefusedError';
  }
}
