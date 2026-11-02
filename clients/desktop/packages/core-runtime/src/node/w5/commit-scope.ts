import {
  withW5CommitLocks,
  acquireW5RepositoryLocks,
  outsideW5CommitLocks,
  type W5RepositoryLock,
} from './repository-locks';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { W5StorageTarget } from './storage-target';
import type { W5CommitRequest, W5Resource } from './commit-log';

export interface W5CommitOptions {
  operation: string;
  /** Host-local files to lock before work; multi-file boundaries declare their full set. */
  locks?: readonly W5RepositoryLock[];
  /** Fence declared locks' entry images, including unchanged or absent dependencies. */
  fenceLockedFiles?: boolean;
  expectedRevisions?: W5CommitRequest['expectedRevisions'];
  receipt?: W5CommitRequest['receipt'];
  reservationId?: string;
  /** Portable result recorded atomically with the files and receipt. */
  outcome?: unknown;
  /** Trusted attempt signal before the decision; never sent to the worker. */
  beforeDecision?: () => void;
}

export interface W5ObservedFile {
  path: string;
  contents: string | null;
  previousRaw: string | null;
}

export interface W5StagedFile extends W5ObservedFile {
  contents: string;
}

export interface W5CommitScope {
  options: W5CommitOptions;
  files: Map<string, W5StagedFile>;
  observed: Map<string, W5ObservedFile>;
  advance: Map<string, W5Resource>;
  storage: Map<string, W5StorageTarget>;
  afterCommit: Array<() => void | Promise<void>>;
  /** Owner phases that must finish under the scope's locks after application. */
  afterApply: Array<() => void | Promise<void>>;
  /** Synchronous host-memory undo for work that wrote nothing durable. */
  onAbort: Array<() => void>;
  closed: boolean;
  store: object;
}

const context = new AsyncLocalStorage<W5CommitScope>();

/** Each written file's commits, from application until their post-commit work ends. */
const settling = new Map<string, Set<Promise<void>>>();

/**
 * The commits that wrote `path` and have not finished their post-commit work,
 * which runs after their locks release. Awaiting them from that work would
 * never settle.
 */
export function w5CommitsSettling(path: string): Promise<void>[] {
  return Array.from(settling.get(path) ?? []);
}

function markSettling(paths: readonly string[]): () => void {
  let done = (): void => {};
  const promise = new Promise<void>((resolve) => {
    done = resolve;
  });
  for (const path of paths) {
    const entries = settling.get(path) ?? new Set<Promise<void>>();
    settling.set(path, entries);
    entries.add(promise);
  }
  return (): void => {
    for (const path of paths) {
      const entries = settling.get(path);
      entries?.delete(promise);
      if (entries?.size === 0) settling.delete(path);
    }
    done();
  };
}

export function currentW5CommitScope(): W5CommitScope | undefined {
  const scope = context.getStore();
  if (scope?.closed) throw new Error('The W5 commit scope has finished');
  return scope;
}

/**
 * Runs host work that precedes a decision without belonging to it (chat
 * normalization before a defaults change): its W5 writes, and the deferred
 * ones it schedules, commit on their own instead of joining or outliving the
 * caller's scope.
 */
export function outsideW5CommitScope<T>(work: () => T): T {
  return context.exit(() => outsideW5CommitLocks(work));
}

/** Repository hooks and host notifications run only after durable application. */
export async function afterW5Commit(
  work: () => void | Promise<void>,
): Promise<void> {
  const scope = currentW5CommitScope();
  if (scope) scope.afterCommit.push(work);
  else await work();
}

/**
 * Runs after durable application while the scope still holds its locks, for
 * registry-owner phases (such as sidebar group reconciliation) that rely on
 * that lock to serialize their own writes. Outside a scope it runs now, under
 * whatever lock the caller holds.
 */
export async function afterW5Apply(
  work: () => void | Promise<void>,
): Promise<void> {
  const scope = currentW5CommitScope();
  if (scope) scope.afterApply.push(work);
  else await work();
}

/**
 * Undoes host-memory state staged with the scope's writes when the scope
 * fails, so a refused decision leaves nothing behind. Outside a scope the
 * write has already applied, so there is nothing to undo.
 */
export function onW5Abort(undo: () => void): void {
  currentW5CommitScope()?.onAbort.push(undo);
}

/** Boundaries project their result while still inside the staging scope. */
export function setW5CommitOutcome(outcome: unknown): void {
  const scope = currentW5CommitScope();
  if (!scope) throw new Error('A W5 outcome requires a commit scope');
  scope.options.outcome = outcome;
}

/** No retry: work may have performed Git, filesystem or other host effects. */
export async function runW5Commit<T>(
  store: object,
  options: W5CommitOptions,
  work: () => Promise<T>,
  commit: (scope: W5CommitScope) => Promise<void>,
): Promise<T> {
  const outer = currentW5CommitScope();
  if (outer) {
    if (outer.store !== store) throw new Error('A W5 scope cannot span stores');
    if (options.receipt || options.reservationId)
      throw new Error('A keyed W5 decision cannot join another commit scope');
    outer.options.expectedRevisions = [
      ...(outer.options.expectedRevisions ?? []),
      ...(options.expectedRevisions ?? []),
    ];
    await acquireW5RepositoryLocks(options.locks ?? []);
    return work();
  }
  const scope: W5CommitScope = {
    options: { ...options },
    files: new Map(),
    observed: new Map(),
    advance: new Map(),
    storage: new Map(),
    afterCommit: [],
    afterApply: [],
    onAbort: [],
    closed: false,
    store,
  };
  let settled = (): void => {};
  try {
    const result = await withW5CommitLocks(
      options.locks ?? [],
      async (): Promise<T> => {
        let value: T;
        try {
          value = await context.run(scope, work);
          // Detached descendants must not stage during decision/application.
          scope.closed = true;
          await commit(scope);
        } catch (error) {
          // Still under the scope's locks, before any waiting writer rereads.
          for (const undo of scope.onAbort.reverse()) undo();
          throw error;
        } finally {
          scope.closed = true;
        }
        for (const callback of scope.afterApply) await callback();
        // Before the locks release, so their next holder sees the work pending.
        settled = markSettling(Array.from(scope.files.keys()));
        return value;
      },
    );
    for (const callback of scope.afterCommit) await callback();
    return result;
  } finally {
    settled();
  }
}
