import { access } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import {
  WorkerFilesystemWatchErrorSchema,
  type CanopyWorkspaceScope,
  type WORKER_STREAM_DEFINITIONS,
  type WorkerFilesystemWatchItem,
  type WorkerFilesystemWatchSubject,
} from '@canopy/protocol/canopy-core';

import { CanopyOperationError } from '../../runtime/errors';
import type {
  CanopyDispatcherStreamHandlerMap,
  CanopyHandlerContext,
} from '../../runtime/types';
import type {
  FilesystemWatchAnchor,
  FilesystemWatchChange,
  FilesystemWatchRegistry,
  FilesystemWatchSubscription,
} from './watch-registry';

/** One host path the scope watches today; `mayBeAbsent` bridges through a parent. */
export interface FilesystemWatchScopePath {
  path: string;
  mayBeAbsent: boolean;
}

/**
 * Host-private resolution of one watched root. Paths never leave the worker;
 * `inert` keeps the stream open without a native handle.
 */
export type FilesystemWatchTarget =
  | { kind: 'inert' }
  | {
      kind: 'tree';
      rootPath: string;
      /** The root may be absent; watch its nearest existing ancestor up to its parent. */
      rootMayBeAbsent: boolean;
      /** Every watch path of the scope, so nested roots share an outer handle. */
      scopePaths: readonly FilesystemWatchScopePath[];
    }
  | { kind: 'gitHead'; headPath: string };

export interface FilesystemWatchTargetRequest {
  scope: CanopyWorkspaceScope;
  fileRootId: string;
  subject: WorkerFilesystemWatchSubject;
}

/**
 * Implemented by each host: the desktop over its file-browser roots, and the
 * daemon (CAN-4730) over `readFilesystemScope`. Throw a `CanopyOperationError`
 * built with {@link filesystemWatchError} for unresolvable scopes or roots.
 * The handler recodes another operation's code by kind before it ends the
 * stream; `onAttachFailed` still receives the port's own error.
 */
export interface FilesystemWatchResolutionPort {
  resolveWatchTarget(
    request: FilesystemWatchTargetRequest,
    context: CanopyHandlerContext,
  ): Promise<FilesystemWatchTarget>;
}

export type WorkerFilesystemWatchHandler = CanopyDispatcherStreamHandlerMap<
  typeof WORKER_STREAM_DEFINITIONS
>['worker.filesystem.watch'];

export interface WorkerFilesystemWatchHandlerOptions {
  registry: FilesystemWatchRegistry;
  port: FilesystemWatchResolutionPort;
  /** Resolves false only for a missing path; other failures reject. */
  exists?: (path: string) => Promise<boolean>;
  now?: () => Date;
  /** Runs once the stream's native handle is attached (or the stream is inert). */
  onAttached?: (context: CanopyHandlerContext) => void;
  /** Runs with the original failure before the stream ends without attaching. */
  onAttachFailed?: (context: CanopyHandlerContext, error: unknown) => void;
}

export type FilesystemWatchErrorReason =
  | 'invalidState'
  | 'notFound'
  | 'snapshotRequired';

export function filesystemWatchError(
  reason: FilesystemWatchErrorReason,
  message?: string,
  runtimeCause?: unknown,
): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: reason === 'notFound' ? 'not_found' : 'failed_precondition',
      code: `worker.filesystem.watch.${reason}`,
      message:
        message ??
        (reason === 'notFound'
          ? 'The selected filesystem root no longer exists.'
          : reason === 'snapshotRequired'
            ? 'The watch cursor cannot resume. Rescan, then watch without a cursor.'
            : 'The selected filesystem root cannot be watched this way.'),
      retry:
        reason === 'snapshotRequired'
          ? { kind: 'after_refresh', resource: 'filesystem-watch' }
          : { kind: 'never' },
    },
    runtimeCause,
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error))
    return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

function contains(parent: string, candidate: string): boolean {
  if (candidate === parent) return true;
  return candidate.startsWith(
    parent.endsWith(sep) ? parent : `${parent}${sep}`,
  );
}

async function nearestExistingPath(
  path: string,
  boundary: string,
  exists: (path: string) => Promise<boolean>,
): Promise<string | null> {
  for (let candidate = path; ; ) {
    if (await exists(candidate)) return candidate;
    if (candidate === boundary) return null;
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

function outermostPaths(paths: readonly string[]): string[] {
  const unique = Array.from(new Set(paths)).sort(
    (left, right) => left.length - right.length,
  );
  return unique.filter(
    (candidate, index) =>
      !unique
        .slice(0, index)
        .some((parent) => parent !== candidate && contains(parent, candidate)),
  );
}

function toWirePath(path: string): string {
  return path === '' ? '' : path.split(sep).join('/');
}

interface MappedChange {
  kind: WorkerFilesystemWatchItem['kind'];
  relativePath: string;
}

interface WatchPlan {
  anchor: FilesystemWatchAnchor;
  map(change: FilesystemWatchChange): MappedChange | null;
}

/** Re-bases anchor-relative paths onto the root; drops changes outside it. */
function rebaseOntoRoot(
  change: FilesystemWatchChange,
  prefix: string,
): MappedChange | null {
  if (change.kind === 'overflow') return { kind: 'overflow', relativePath: '' };
  if (prefix === '') return { kind: change.kind, relativePath: change.path };
  if (change.path === prefix) return { kind: change.kind, relativePath: '' };
  if (change.path.startsWith(`${prefix}/`))
    return {
      kind: change.kind,
      relativePath: change.path.slice(prefix.length + 1),
    };
  // An ancestor of an absent or bridged root changed: the root may have
  // appeared or gone, so the subscriber must rescan.
  if (change.path === '' || prefix.startsWith(`${change.path}/`))
    return change.kind === 'deleted'
      ? { kind: 'deleted', relativePath: '' }
      : { kind: 'overflow', relativePath: '' };
  return null;
}

async function planTree(
  target: Extract<FilesystemWatchTarget, { kind: 'tree' }>,
  exists: (path: string) => Promise<boolean>,
): Promise<WatchPlan | null> {
  const rootPath = resolve(target.rootPath);
  const scopeAnchors = await Promise.all(
    target.scopePaths.map(({ path, mayBeAbsent }) => {
      const resolved = resolve(path);
      return mayBeAbsent
        ? nearestExistingPath(resolved, dirname(resolved), exists)
        : Promise.resolve(resolved);
    }),
  );
  // An outer root's handle serves the root even when the root and its parent
  // are both absent.
  let anchorPath = outermostPaths(
    scopeAnchors.filter((path): path is string => path !== null),
  ).find((anchor) => contains(anchor, rootPath));
  if (anchorPath === undefined) {
    const effective = target.rootMayBeAbsent
      ? await nearestExistingPath(rootPath, dirname(rootPath), exists)
      : rootPath;
    if (effective === null) return null;
    anchorPath = effective;
  }
  const prefix = toWirePath(relative(anchorPath, rootPath));
  return {
    anchor: { path: anchorPath, recursive: true, release: 'close' },
    map: (change): MappedChange | null => rebaseOntoRoot(change, prefix),
  };
}

/**
 * While watch or open-file limits keep a HEAD handle detached, its subscribers
 * reread HEAD this often: the worktree observers' bounded poll (CAN-3190).
 */
export const GIT_HEAD_UNAVAILABLE_RESCAN_MS = 2_000;

function planGitHead(headPath: string): WatchPlan {
  const name = basename(headPath);
  return {
    anchor: {
      path: dirname(headPath),
      recursive: false,
      persistent: false,
      release: 'retain',
      rescanWhileUnavailableMs: GIT_HEAD_UNAVAILABLE_RESCAN_MS,
    },
    map: (change): MappedChange | null => {
      // The Git directory itself changed or went away: reread HEAD.
      if (change.kind === 'overflow' || change.path === '')
        return { kind: 'overflow', relativePath: '' };
      return change.path === name
        ? { kind: 'modified', relativePath: 'HEAD' }
        : null;
    },
  };
}

function normalizeRelativeFilters(
  relativePaths: readonly string[] | undefined,
  subject: WorkerFilesystemWatchSubject,
): string[] | null {
  if (!relativePaths || relativePaths.length === 0) return null;
  if (subject === 'gitHead')
    throw new CanopyOperationError({
      kind: 'invalid_argument',
      message: 'relativePaths cannot narrow a gitHead watch.',
      retry: { kind: 'never' },
    });
  return relativePaths.map((value) => {
    const segments = value.split(/[\\/]/);
    if (
      value.startsWith('/') ||
      value.startsWith('\\') ||
      /^[A-Za-z]:/.test(value) ||
      segments.includes('..')
    )
      throw new CanopyOperationError({
        kind: 'invalid_argument',
        message: 'relativePaths must be relative to the root.',
        retry: { kind: 'never' },
      });
    return segments
      .filter((segment) => segment !== '' && segment !== '.')
      .join('/');
  });
}

function matchesFilters(
  filters: readonly string[] | null,
  change: MappedChange,
): boolean {
  if (!filters || change.kind === 'overflow') return true;
  return filters.some(
    (filter) =>
      filter === '' ||
      change.relativePath === filter ||
      change.relativePath.startsWith(`${filter}/`) ||
      // The root itself appearing or going affects every filtered path.
      change.relativePath === '',
  );
}

function nativeAttachError(error: unknown): CanopyOperationError {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR'
    ? filesystemWatchError('notFound', undefined, error)
    : new CanopyOperationError(
        {
          kind: 'internal',
          message: 'The filesystem watch could not attach.',
          retry: { kind: 'never' },
        },
        error,
      );
}

/**
 * `worker.filesystem.watch` over a shared native-handle registry. Resolution,
 * cursor validation and attachment happen before `onAttached`; the returned
 * cleanup releases only this stream's subscription.
 */
export function createWorkerFilesystemWatchHandler(
  options: WorkerFilesystemWatchHandlerOptions,
): WorkerFilesystemWatchHandler {
  const exists = options.exists ?? pathExists;
  const now = options.now ?? ((): Date => new Date());
  const open: WorkerFilesystemWatchHandler = async (params, context, sink) => {
    const subject = params.subject ?? 'tree';
    const filters = normalizeRelativeFilters(params.relativePaths, subject);
    const target = await options.port.resolveWatchTarget(
      { scope: params.scope, fileRootId: params.fileRootId, subject },
      context,
    );
    if (context.signal.aborted) return;
    const plan =
      target.kind === 'inert'
        ? null
        : target.kind === 'gitHead'
          ? planGitHead(resolve(target.headPath))
          : await planTree(target, exists);
    if (context.signal.aborted) return;
    if (!plan) {
      // No native source exists, so no cursor can resume against it.
      if (params.cursor) throw filesystemWatchError('snapshotRequired');
      options.onAttached?.(context);
      return;
    }
    if (params.cursor) {
      const position = options.registry.position(plan.anchor);
      if (
        !position ||
        position.epoch !== params.cursor.daemonEpoch ||
        position.sequence !== params.cursor.sequence
      )
        throw filesystemWatchError('snapshotRequired');
    }
    let subscription: FilesystemWatchSubscription;
    try {
      subscription = options.registry.acquire(plan.anchor, (batch) => {
        for (const change of batch.changes) {
          const mapped = plan.map(change);
          if (!mapped || !matchesFilters(filters, mapped)) continue;
          sink.emitAt(
            { daemonEpoch: batch.epoch, sequence: change.sequence },
            {
              changeId: `${batch.epoch}:${change.sequence}`,
              kind: mapped.kind,
              relativePath: mapped.relativePath,
              previousRelativePath: null,
              version: null,
              occurredAt: now().toISOString(),
              eventCount: change.eventCount,
            },
          );
        }
      });
    } catch (error) {
      throw nativeAttachError(error);
    }
    const attached = subscription;
    options.onAttached?.(context);
    return (): void => attached.release();
  };
  return async (params, context, sink) => {
    try {
      return await open(params, context, sink);
    } catch (error) {
      options.onAttachFailed?.(context, error);
      throw withWatchErrorCode(error);
    }
  };
}

const WatchErrorCodeSchema =
  WorkerFilesystemWatchErrorSchema.shape.code.unwrap();

/**
 * Recodes a failure carrying another operation's code (such as the roots
 * read's `worker.filesystem.roots.notFound`) by its kind, or drops the code,
 * so the dispatcher does not redact it to `internal`.
 */
function withWatchErrorCode(error: unknown): unknown {
  if (!(error instanceof CanopyOperationError)) return error;
  const { code, ...payload } = error.payload;
  if (code === undefined || WatchErrorCodeSchema.safeParse(code).success)
    return error;
  const reason: FilesystemWatchErrorReason | null =
    payload.kind === 'not_found'
      ? 'notFound'
      : payload.kind === 'failed_precondition'
        ? 'invalidState'
        : null;
  return new CanopyOperationError(
    reason === null
      ? payload
      : { ...payload, code: `worker.filesystem.watch.${reason}` },
    error.runtimeCause,
  );
}
