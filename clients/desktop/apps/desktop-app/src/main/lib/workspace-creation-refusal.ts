export type WorkspaceCreationRefusal =
  | 'name-required'
  | 'invalid-path'
  | 'missing-folder'
  | 'not-a-repository'
  | 'not-a-manifest'
  | 'not-importable'
  | 'already-tracked'
  | 'invalid-remote';

/**
 * A workspace create or import refused before it indexed anything (CAN-3806).
 * The message is the one the desktop has always shown.
 */
export class WorkspaceCreationRefusedError extends Error {
  constructor(
    readonly reason: WorkspaceCreationRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceCreationRefusedError';
  }
}

export function refuseWorkspaceCreation(
  reason: WorkspaceCreationRefusal,
  message: string,
): never {
  throw new WorkspaceCreationRefusedError(reason, message);
}
