/**
 * Main-process half of the code-graph worktree fingerprint: the stored
 * fingerprint and completion, read through the code-graph read hosts by
 * `@canopy/code-graph/host/worktree-fingerprint-reads`; this module never
 * opens SQLite on the Electron main thread.
 *
 * The digest computation itself lives in `code-graph-worktree-fingerprint-core`
 * because it is bundled into a utilityProcess worker. This module is main-only
 * (it reaches `../code-graph/read-runner`, which value-imports `electron`) and
 * must never be imported from a worker entry.
 */

import {
  createCodeGraphWorktreeFingerprintReads,
  type CodeGraphFingerprintMetadataReader,
  type PersistedCodeGraphWorktreeFingerprintRead,
} from '@canopy/code-graph/host/worktree-fingerprint-reads';
import {
  CodeGraphReadFailureError,
  runCodeGraphWorkerRead,
} from '../code-graph/read-runner';

export type {
  CodeGraphFingerprintMetadataReader,
  PersistedCodeGraphWorktreeFingerprintRead,
} from '@canopy/code-graph/host/worktree-fingerprint-reads';

const workerMetadataReader: CodeGraphFingerprintMetadataReader = async (
  dbPath,
  cancellationKey,
) => {
  const response = await runCodeGraphWorkerRead({
    // Must stay the shared `${projectId}/${worktreeId}` key. Worktree cleanup
    // drains in-flight reads with `cancelCodeGraphReads(key)` before it closes
    // the engine and recursively removes `worktree-data/{worktreeId}`
    // (worktree-data-cleanup.ts). A bespoke key here would never match, so an
    // in-flight read could still hold graph.db open across the removal —
    // tolerated on macOS, EBUSY/EPERM on Windows.
    key: cancellationKey,
    kind: 'fingerprint-metadata',
    request: { dbPath, task: { kind: 'fingerprint-metadata' } },
  });
  if (!response.ok) {
    throw new CodeGraphReadFailureError(response.code);
  }
  if (response.result.kind !== 'fingerprint-metadata') {
    throw new Error('Code-graph read worker returned an unexpected result.');
  }
  return response.result.value;
};

let metadataReader: CodeGraphFingerprintMetadataReader = workerMetadataReader;

const reads = createCodeGraphWorktreeFingerprintReads(() => metadataReader);

/** Test seam: replace the worker-backed metadata reader. */
export function setCodeGraphFingerprintMetadataReaderForTests(
  reader: CodeGraphFingerprintMetadataReader | null,
): void {
  metadataReader = reader ?? workerMetadataReader;
}

/** The stored staleness metadata, cached against the database file. */
export function readPersistedCodeGraphWorktreeFingerprintSnapshot(
  dbPath: string,
  cancellationKey: string,
): Promise<PersistedCodeGraphWorktreeFingerprintRead> {
  return reads.snapshot(dbPath, cancellationKey);
}

export async function readPersistedCodeGraphWorktreeFingerprint(
  dbPath: string,
  cancellationKey: string,
): Promise<string | null> {
  return (await reads.snapshot(dbPath, cancellationKey)).fingerprint;
}

/** Whether the graph ever completed; an unreadable graph rejects. */
export function readCodeGraphWorktreeCompletion(
  dbPath: string,
  cancellationKey: string,
): Promise<boolean> {
  return reads.completion(dbPath, cancellationKey);
}

/** Clears the process-local metadata cache when a worktree graph is removed. */
export function clearCodeGraphWorktreeFingerprintCache(dbPath: string): void {
  reads.clear(dbPath);
}
