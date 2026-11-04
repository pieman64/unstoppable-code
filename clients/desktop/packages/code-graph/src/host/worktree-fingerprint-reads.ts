import { stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import type { CodeGraphFingerprintMetadata } from '../store/database';
import type { CodeGraphReadFailure } from '../types/code-graph-tools';
import {
  CodeGraphReadFailureError,
  codeGraphReadFailure,
} from './read-failure';

/*
 * Reads the fingerprint and completion stored in a worktree's `graph.db`
 * through the host's read hosts, never opening SQLite on the calling thread.
 * The build host that wrote the graph stores them (CAN-5084).
 */

/**
 * Reads graph metadata in a read host. `cancellationKey` is the shared
 * `${projectId}/${worktreeId}` read key, so a worktree cleanup that cancels
 * that key's reads also drains this one.
 */
export type CodeGraphFingerprintMetadataReader = (
  dbPath: string,
  cancellationKey: string,
) => Promise<CodeGraphFingerprintMetadata>;

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

export interface CodeGraphWorktreeFingerprintReads {
  /**
   * The staleness metadata for a worktree graph, cached against the
   * database's `mtimeMs`/`size`, so an unchanged graph never reaches a read
   * host. Failures are not cached: a transient `SQLITE_BUSY` while a build
   * holds the database must be retried, not remembered as "no fingerprint".
   */
  snapshot(
    dbPath: string,
    cancellationKey: string,
  ): Promise<PersistedCodeGraphWorktreeFingerprintRead>;
  /**
   * Whether the worktree graph ever completed a build. An unreadable graph is
   * not an incomplete graph: it rejects with a bounded read failure so build
   * preparation cannot mistake saturation for a cold graph and reseed it.
   */
  completion(dbPath: string, cancellationKey: string): Promise<boolean>;
  /** Forgets the cached metadata when a worktree graph is removed or rebuilt. */
  clear(dbPath: string): void;
}

// Not imported from the fingerprint module: it runs Git, and hosts that only
// read graph metadata never load it.
function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

interface CachedFingerprintMetadata {
  /** `mtimeMs:size` of the graph database the metadata was read from. */
  identity: string;
  metadata: CodeGraphFingerprintMetadata;
}

export function createCodeGraphWorktreeFingerprintReads(
  reader: () => CodeGraphFingerprintMetadataReader,
): CodeGraphWorktreeFingerprintReads {
  const cache = new Map<string, CachedFingerprintMetadata>();

  async function snapshot(
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
      // Only a genuinely absent graph is a "no fingerprint" answer.
      // EACCES/EIO/ELOOP are transient-or-environmental and must stay
      // retryable, matching how a failed metadata read is handled below.
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
      // Absent graph: not cached, since the `stat` above is already the
      // cheap check and a successful stat never produces this identity.
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

    const cached = cache.get(dbPath);
    if (cached !== undefined && cached.identity === identity) {
      return {
        ...cached.metadata,
        cacheHit: true,
        readFailed: false,
        durationMs: elapsed(),
      };
    }

    try {
      const metadata = await reader()(dbPath, cancellationKey);
      cache.set(dbPath, { identity, metadata });
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

  return {
    snapshot,
    async completion(dbPath, cancellationKey) {
      const read = await snapshot(dbPath, cancellationKey);
      if (read.readFailed) {
        throw new CodeGraphReadFailureError(
          read.readFailure ?? 'database-error',
        );
      }
      return read.completed;
    },
    clear(dbPath) {
      cache.delete(dbPath);
    },
  };
}
