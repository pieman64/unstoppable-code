/**
 * Main-process half of the code-graph worktree fingerprint: reading and
 * persisting the fingerprint stored in a worktree's `graph.db`. Both directions
 * go through the code-graph read worker; this module never opens SQLite on the
 * Electron main thread.
 *
 * The digest computation itself lives in `code-graph-worktree-fingerprint-core`
 * because it is bundled into a utilityProcess worker. This module is main-only
 * (it reaches `../code-graph/read-runner`, which value-imports `electron`) and
 * must never be imported from a worker entry.
 */

import { stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import type { CodeGraphFingerprintMetadata } from '@canopy/desktop-shared/node/code-graph/store/database';
import type { CodeGraphReadFailure } from '@canopy/desktop-shared/types/code-graph-tools';
import {
  CodeGraphReadFailureError,
  codeGraphReadFailure,
  runCodeGraphWorkerRead,
} from '../code-graph/read-runner';
import { isFileNotFoundError } from './code-graph-worktree-fingerprint-core';

type PersistedCodeGraphWorktreeFingerprintMetadata =
  CodeGraphFingerprintMetadata;

interface CachedFingerprintMetadata {
  /** `mtimeMs:size` of the graph database the metadata was read from. */
  identity: string;
  metadata: PersistedCodeGraphWorktreeFingerprintMetadata;
}

const persistedFingerprintCache = new Map<string, CachedFingerprintMetadata>();

/**
 * Reads graph metadata in the code-graph read worker.
 *
 * `cancellationKey` is the shared `${projectId}/${worktreeId}` read key.
 * Injectable so unit tests can exercise the caching and failure semantics
 * without an Electron `utilityProcess`. Production always uses the worker.
 */
export type CodeGraphFingerprintMetadataReader = (
  dbPath: string,
  cancellationKey: string,
) => Promise<CodeGraphFingerprintMetadata>;

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

let readCodeGraphFingerprintMetadataOffThread: CodeGraphFingerprintMetadataReader =
  workerMetadataReader;

/** Test seam: replace the worker-backed metadata reader. */
export function setCodeGraphFingerprintMetadataReaderForTests(
  reader: CodeGraphFingerprintMetadataReader | null,
): void {
  readCodeGraphFingerprintMetadataOffThread = reader ?? workerMetadataReader;
}

/**
 * Writes the end-of-build fingerprint in the code-graph read worker lane.
 * `cancellationKey` is the same `${projectId}/${worktreeId}` key the reads use,
 * so worktree cleanup cancels an in-flight write before removing its graph.
 */
export type CodeGraphFingerprintMetadataWriter = (
  dbPath: string,
  fingerprint: string,
  cancellationKey: string,
) => Promise<void>;

const workerMetadataWriter: CodeGraphFingerprintMetadataWriter = async (
  dbPath,
  fingerprint,
  cancellationKey,
) => {
  const response = await runCodeGraphWorkerRead({
    key: cancellationKey,
    kind: 'fingerprint-persist',
    request: { dbPath, task: { kind: 'persist-fingerprint', fingerprint } },
  });
  if (!response.ok) {
    throw new CodeGraphReadFailureError(response.code);
  }
  if (response.result.kind !== 'persist-fingerprint') {
    throw new Error('Code-graph read worker returned an unexpected result.');
  }
};

let writeCodeGraphFingerprintMetadataOffThread: CodeGraphFingerprintMetadataWriter =
  workerMetadataWriter;

/** Test seam: replace the worker-backed metadata writer. */
export function setCodeGraphFingerprintMetadataWriterForTests(
  writer: CodeGraphFingerprintMetadataWriter | null,
): void {
  writeCodeGraphFingerprintMetadataOffThread = writer ?? workerMetadataWriter;
}

export interface PersistedCodeGraphWorktreeFingerprintRead {
  fingerprint: string | null;
  schemaVersion: number | null;
  extractorVersion: number | null;
  /** Some build completed; false when absent. An unreadable value is separate. */
  completed: boolean;
  /** Derived analysis was left pending (see `CodeGraphFingerprintMetadata`). */
  derivedPending?: boolean;
  cacheHit: boolean;
  readFailed: boolean;
  /** Portable bounded reason; present only when metadata could not be read. */
  readFailure?: CodeGraphReadFailure;
  durationMs: number;
}

/**
 * Reads the staleness metadata for a worktree graph **without opening the
 * database on the calling thread**.
 *
 * These graphs routinely exceed 500 MB. The previous implementation opened
 * them with `new DatabaseSync(dbPath, { readOnly: true })` directly on the
 * Electron main thread; stack samples taken during real stalls showed
 * `node:sqlite StatementSync::Get` accounting for up to 49.7% of main-thread
 * samples, with 30.6% sitting in `pread`. The open is now delegated
 * to the code-graph read worker.
 *
 * The result is cached against the database's `mtimeMs`/`size`, so an
 * unchanged graph is answered from memory and never reaches the worker at all.
 * Failures are still not cached: a transient `SQLITE_BUSY` (the build worker
 * holds the database during a build) must be retried rather than remembered as
 * a durable "no fingerprint" state.
 */
export async function readPersistedCodeGraphWorktreeFingerprintSnapshot(
  dbPath: string,
  cancellationKey: string,
): Promise<PersistedCodeGraphWorktreeFingerprintRead> {
  const startedAtMs = performance.now();
  const elapsed = (): number => Math.max(0, performance.now() - startedAtMs);

  let identity: string;
  try {
    const stats = await stat(dbPath);
    identity = `${stats.mtimeMs}:${stats.size}`;
  } catch (error) {
    // Only a genuinely absent graph is a cacheable "no fingerprint" answer.
    // EACCES/EIO/ELOOP are transient-or-environmental and must stay retryable,
    // matching how a failed metadata read is handled below.
    if (!isFileNotFoundError(error)) {
      return {
        fingerprint: null,
        schemaVersion: null,
        extractorVersion: null,
        completed: false,
        cacheHit: false,
        readFailed: true,
        readFailure: 'database-error',
        durationMs: elapsed(),
      };
    }
    // Absent graph — a durable "no fingerprint" answer, but deliberately not
    // cached: the `stat` above is already the cheap check, and any cached
    // entry would be unreachable anyway (the lookup below only runs once
    // `stat` succeeds, and a successful stat never produces the absent
    // identity).
    return {
      fingerprint: null,
      schemaVersion: null,
      extractorVersion: null,
      completed: false,
      cacheHit: false,
      readFailed: false,
      durationMs: elapsed(),
    };
  }

  const cached = persistedFingerprintCache.get(dbPath);
  if (cached !== undefined && cached.identity === identity) {
    return {
      ...cached.metadata,
      cacheHit: true,
      readFailed: false,
      durationMs: elapsed(),
    };
  }

  try {
    const metadata = await readCodeGraphFingerprintMetadataOffThread(
      dbPath,
      cancellationKey,
    );
    persistedFingerprintCache.set(dbPath, { identity, metadata });
    return {
      ...metadata,
      cacheHit: false,
      readFailed: false,
      durationMs: elapsed(),
    };
  } catch (error) {
    return {
      fingerprint: null,
      schemaVersion: null,
      extractorVersion: null,
      completed: false,
      cacheHit: false,
      readFailed: true,
      readFailure: codeGraphReadFailure(error),
      durationMs: elapsed(),
    };
  }
}

export async function readPersistedCodeGraphWorktreeFingerprint(
  dbPath: string,
  cancellationKey: string,
): Promise<string | null> {
  return (
    await readPersistedCodeGraphWorktreeFingerprintSnapshot(
      dbPath,
      cancellationKey,
    )
  ).fingerprint;
}

/**
 * Whether the worktree graph ever completed a build, answered from the same
 * stat-keyed cache and read worker as the fingerprint. An unreadable graph is
 * not an incomplete graph: it rejects with a bounded read-worker reason so
 * build preparation cannot mistake saturation for a cold graph and reseed it.
 */
export async function readCodeGraphWorktreeCompletion(
  dbPath: string,
  cancellationKey: string,
): Promise<boolean> {
  const snapshot = await readPersistedCodeGraphWorktreeFingerprintSnapshot(
    dbPath,
    cancellationKey,
  );
  if (snapshot.readFailed) {
    throw new CodeGraphReadFailureError(
      snapshot.readFailure ?? 'database-error',
    );
  }
  return snapshot.completed;
}

export async function persistCodeGraphWorktreeFingerprint(
  dbPath: string,
  fingerprint: string,
  cancellationKey: string,
): Promise<void> {
  try {
    await writeCodeGraphFingerprintMetadataOffThread(
      dbPath,
      fingerprint,
      cancellationKey,
    );
  } finally {
    // Drop rather than refresh the cache entry: the write changed the
    // database's mtime/size, and a failed write may have partially applied.
    // The next read re-stats and repopulates.
    persistedFingerprintCache.delete(dbPath);
  }
}

/** Clears the process-local metadata cache when a worktree graph is removed. */
export function clearCodeGraphWorktreeFingerprintCache(dbPath: string): void {
  persistedFingerprintCache.delete(dbPath);
}

export async function persistStableCodeGraphWorktreeFingerprint(
  dbPath: string,
  startFingerprint: string,
  endFingerprint: string,
  cancellationKey: string,
): Promise<boolean> {
  if (startFingerprint !== endFingerprint) {
    return false;
  }
  await persistCodeGraphWorktreeFingerprint(
    dbPath,
    endFingerprint,
    cancellationKey,
  );
  return true;
}
