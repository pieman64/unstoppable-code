import type { TrashAttempt, TrashAttempter } from './trash';

const UNSTAGED = 'Recycle Bin support is not staged on this host.';
const NO_RECYCLE_BIN =
  "Windows can't recycle this entry: its volume has no Recycle Bin, or the entry doesn't fit.";
const REFUSED = 'Windows refused to recycle the entry.';
const DELETED = 'Windows reported the entry deleted, not recycled.';
const UNREPORTED = 'The recycle call ended without a report.';

/** Maps the addon's fixed result strings; anything else is no report. */
export function parseWindowsRecycleResult(result: unknown): TrashAttempt {
  switch (result) {
    case 'recycled':
      return { kind: 'moved' };
    case 'refused':
      return { kind: 'refused', code: 'unavailable', reason: NO_RECYCLE_BIN };
    case 'failed':
      return { kind: 'refused', code: 'failed', reason: REFUSED };
    case 'deleted':
      return { kind: 'unfinished', reason: DELETED };
    default:
      return { kind: 'unfinished', reason: UNREPORTED };
  }
}

/**
 * `IFileOperation` through the owned-child addon's `recycleItem`, loaded on
 * the first request. No addon (`null`), or one that fails to load, leaves
 * Trash unavailable.
 */
export function windowsTrashBackend(
  load: (() => (path: string) => Promise<unknown>) | null,
): () => TrashAttempter | string {
  let recycle: ((path: string) => Promise<unknown>) | null | undefined;
  return () => {
    if (recycle === undefined) {
      if (load === null) return UNSTAGED;
      try {
        recycle = load();
      } catch {
        recycle = null;
      }
    }
    const call = recycle;
    if (call === null) return UNSTAGED;
    return async (entry) => parseWindowsRecycleResult(await call(entry));
  };
}
