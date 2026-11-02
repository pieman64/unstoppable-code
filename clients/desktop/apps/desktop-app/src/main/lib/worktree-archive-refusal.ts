export type WorktreeArchiveRefusal =
  | 'unsupported-workspace'
  | 'kind-mismatch'
  | 'not-found'
  | 'busy'
  | 'source-unavailable';

/** An admission check refused the archive before any effect. */
export class WorktreeArchiveRefusedError extends Error {
  constructor(
    readonly reason: WorktreeArchiveRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'WorktreeArchiveRefusedError';
  }
}
