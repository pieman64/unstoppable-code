export type WorkspaceSourceChangesRefusal =
  | 'not-found'
  | 'not-single-repo'
  | 'no-source-repository'
  | 'invalid-request';

/**
 * `core.workspace.sourceChanges.apply` was refused (CAN-3819). Only a refusal
 * before effects releases a retry key; rollback does not prove safe retry.
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
