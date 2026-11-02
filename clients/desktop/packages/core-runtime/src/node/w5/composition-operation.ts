import type { W5ExpectedRevisionCheck } from './boundary-operation';
// The explicit store module: the commit-log index loads node:sqlite.
import { w5ResourceKey } from './commit-log-file-store';
import { currentW5CommitScope, type W5CommitOptions } from './commit-scope';
import type { W5KeyedAttempt } from './keyed-operation';
import {
  withW5RepositoryLocks,
  type W5RepositoryLock,
} from './repository-locks';

/** Until composition options have a resource, callers carry the rows they read. */
export interface W5CompositionOptions {
  expectedRevisions?: W5CommitOptions['expectedRevisions'];
  idempotencyKey?: string;
}

/** Trusted host projection of workspace record paths; core assumes no data root. */
export interface W5CompositionPaths {
  workspaceIndex: () => string;
  workspaceManifest: (workspaceId: string) => string;
  worktreeList: (workspaceId: string) => string;
}

export interface W5CompositionLockInput {
  index?: boolean;
  manifests?: readonly string[];
  lists?: readonly string[];
}

export type W5CommitRunner = <T>(
  options: W5CommitOptions,
  work: () => Promise<T>,
) => Promise<T>;

export type W5BoundaryStep = <T>(
  options: W5CommitOptions | undefined,
  locks: readonly W5RepositoryLock[],
  work: () => Promise<T>,
) => Promise<T>;

/** Keep lock declarations beside the record-only scope, away from effect paths. */
export function createW5CompositionLocks(
  paths: W5CompositionPaths,
): (input: W5CompositionLockInput) => W5RepositoryLock[] {
  return (input) => [
    ...(input.index
      ? [{ kind: 'index' as const, path: paths.workspaceIndex() }]
      : []),
    ...(input.manifests ?? []).map(
      (id): W5RepositoryLock => ({
        kind: 'manifest',
        path: paths.workspaceManifest(id),
      }),
    ),
    ...(input.lists ?? []).map(
      (id): W5RepositoryLock => ({
        kind: 'list',
        path: paths.worktreeList(id),
      }),
    ),
  ];
}

export function createW5CompositionRevisionCheck(
  checkExpectedRevision: W5ExpectedRevisionCheck,
): (options: W5CommitOptions) => Promise<void> {
  return async (options) => {
    for (const { resource, revision } of options.expectedRevisions ?? []) {
      await checkExpectedRevision(resource, revision);
    }
  };
}

/** A record-only transition. Never place Git, provisioning, migration or publication inside work. */
export function createW5BoundaryStep(
  withCommit: W5CommitRunner,
): W5BoundaryStep {
  return async function commitW5BoundaryStep<T>(
    options: W5CommitOptions | undefined,
    locks: readonly W5RepositoryLock[],
    work: () => Promise<T>,
  ): Promise<T> {
    if (!options) return work();
    const advanced = new Set<string>();
    const result = await withW5RepositoryLocks(locks, () =>
      withCommit({ ...options, locks }, async () => {
        const value = await work();
        currentW5CommitScope()?.advance.forEach((_resource, key) =>
          advanced.add(key),
        );
        return value;
      }),
    );
    // Advance only images this attempt staged, never revisions read after effects.
    options.expectedRevisions = options.expectedRevisions?.map((entry) => ({
      ...entry,
      revision:
        entry.revision + (advanced.has(w5ResourceKey(entry.resource)) ? 1 : 0),
    }));
    return result;
  };
}

/** Read-only failures are known refusals only until the attempt marks an effect. */
export async function admitW5Composition<T>(
  attempt: W5KeyedAttempt | undefined,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw error instanceof Error && attempt
      ? attempt.validationError(error)
      : error;
  }
}
