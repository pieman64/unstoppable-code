import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  mergeMemoryDocument,
  planMemoryDocumentMerge,
  type MemoryDocumentMerge,
} from '@canopy/memory-consolidation/document-merge';
import { MemoryConflictReasonSchema } from '@canopy/protocol/memory-sync';

/*
 * Runs the three-way merge of a pulled change and a local edit (design
 * §13.2) without holding up Electron main. The shared merge bounds its line
 * diff; a diff past a millisecond or so of that budget runs on a worker
 * thread, so the UI, cancellation and the lease renewal keep going. A worker
 * that fails or has not answered in time leaves the document to the user as
 * a conflict too costly to merge, which keeps both versions.
 */

/** Line diffs up to this much work run inline (well under a millisecond). */
export const MEMORY_MERGE_INLINE_WORK = 1_000_000;

export const MEMORY_MERGE_WORKER_TIMEOUT_MS = 5_000;

const TOO_COSTLY: MemoryDocumentMerge = {
  kind: 'conflict',
  reason: 'too_costly',
};

/** The merge a worker answered with; anything else is too costly. */
function mergeFromWorker(message: unknown): MemoryDocumentMerge {
  if (typeof message !== 'object' || message === null) return TOO_COSTLY;
  if (!('merge' in message)) return TOO_COSTLY;
  const { merge } = message;
  if (typeof merge !== 'object' || merge === null || !('kind' in merge)) {
    return TOO_COSTLY;
  }
  const { kind } = merge;
  if (kind === 'theirs' || kind === 'ours' || kind === 'same') return { kind };
  if (
    kind === 'merged' &&
    'content' in merge &&
    typeof merge.content === 'string'
  ) {
    return { kind, content: merge.content };
  }
  if (kind === 'conflict' && 'reason' in merge) {
    const reason = MemoryConflictReasonSchema.safeParse(merge.reason);
    if (reason.success) return { kind, reason: reason.data };
  }
  return TOO_COSTLY;
}

function mergeInWorker(
  base: string | null,
  ours: string,
  theirs: string,
): Promise<MemoryDocumentMerge> {
  return new Promise((resolve) => {
    let worker: Worker | undefined;
    let settled = false;
    const finish = (merge: MemoryDocumentMerge): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (worker === undefined) {
        resolve(merge);
        return;
      }
      void worker.terminate().then(
        () => resolve(merge),
        () => resolve(merge),
      );
    };
    const timer = setTimeout(
      () => finish(TOO_COSTLY),
      MEMORY_MERGE_WORKER_TIMEOUT_MS,
    );
    try {
      worker = new Worker(join(__dirname, 'memory-sync-merge-worker.js'), {
        workerData: { base, ours, theirs },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
      worker.once('error', () => finish(TOO_COSTLY));
      worker.once('exit', () => finish(TOO_COSTLY));
      worker.once('message', (message: unknown) =>
        finish(mergeFromWorker(message)),
      );
    } catch {
      finish(TOO_COSTLY);
    }
  });
}

/** {@link mergeMemoryDocument}, with any costly line diff off Electron main. */
export function mergeMemoryDocumentOffMain(
  base: string | null,
  ours: string | null,
  theirs: string | null,
): Promise<MemoryDocumentMerge> {
  const plan = planMemoryDocumentMerge(base, ours, theirs);
  if (plan.kind === 'decided') return Promise.resolve(plan.merge);
  if (ours === null || theirs === null) {
    return Promise.resolve({ kind: 'conflict', reason: 'overlap' });
  }
  if (plan.work <= MEMORY_MERGE_INLINE_WORK) {
    return Promise.resolve(mergeMemoryDocument(base, ours, theirs));
  }
  return mergeInWorker(base, ours, theirs);
}
