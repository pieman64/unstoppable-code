import {
  createBoundedReadEvidence,
  type ReadEvidenceCursor,
  type ReadEvidenceJournal,
  type ReadEvidenceSnapshot,
} from '@canopy/desktop-shared/lib/bounded-read-evidence';
import { isAbsolute, join, resolve, sep } from 'node:path';
import {
  CanopyClientError,
  type CanopyClientQueryOptions,
} from '@canopy/core-client';
import {
  CanopyOperationError,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import {
  createFilesystemScopeResolver,
  filesystemScopeError,
  hasGitPathSegment,
  readNativeRootIdentity,
  readRootVisibility,
  requireFilesystemCatalogRevision,
  sortDirectoryEntries,
  withVerifiedFilesystemCatalog,
  type FilesystemReadOperation,
  type FilesystemRootCatalog,
  type FilesystemScopeDependencies,
  type FilesystemScopeResolver,
} from '@canopy/core-runtime/node';
import {
  CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  type CanopyCallerDescriptor,
  type CanopyErrorPayload,
  type CanopyWorkspaceScope,
  type WorkerFilesystemDirectoryListParams,
  type WorkerFilesystemDirectoryListResult,
  type WorkerFilesystemRootsListParams,
  type WorkerFilesystemRootsListResult,
} from '@canopy/protocol/canopy-core';
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type FileTreeDirectoryResponse,
  type FileTreeRootsResponse,
  type WorkspaceType,
} from '@canopy/desktop-shared/types';
import {
  recordFilesRouteOutcome,
  recordFilesRouteSelected,
} from '@canopy/desktop-shared/node/work-counters';
import { validateId, validateOptionalRepoId } from '../lib/validation';
import { normalizeFileTreeRelativePath } from '../services/file-tree-relative-path';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';
import { translateFilesServiceError } from './worker-filesystem-adapter';
import type {
  CallerLifetimeSender,
  ElectronDaemonCallerLifetime,
} from './electron-daemon-caller-lifetime';

/**
 * Opt-in routing of Files roots and directory reads through the local core
 * daemon (CAN-4305), behind `canopy-desktop-daemon-files-reads`.
 *
 * Only the file-tree IPC handlers mark a request as routable; every other
 * caller of the same operations keeps the direct desktop reader. The backend
 * is chosen once, before any daemon contact. A request selected for the
 * daemon never falls back: every failure is returned typed, and the direct
 * reader is not called for it.
 */

export type DaemonFilesOperation = FilesystemReadOperation;

export interface DaemonFilesRouteSender extends CallerLifetimeSender {
  readonly id: number;
}

/** Set only by the file-tree IPC handlers, from the trusted IPC event. */
export interface DaemonFilesRouteRequest {
  readonly sender: DaemonFilesRouteSender;
}

export interface DaemonFilesQueryClient {
  query(
    name: 'worker.filesystem.roots.list',
    params: WorkerFilesystemRootsListParams,
    options?: CanopyClientQueryOptions,
  ): Promise<WorkerFilesystemRootsListResult>;
  query(
    name: 'worker.filesystem.directory.list',
    params: WorkerFilesystemDirectoryListParams,
    options?: CanopyClientQueryOptions,
  ): Promise<WorkerFilesystemDirectoryListResult>;
}

export interface DaemonFilesSession {
  /** Throws once the session closed; a new object after the backend reattached. */
  readonly client: DaemonFilesQueryClient;
}

export interface DaemonFilesConnections {
  get(
    caller: CanopyCallerDescriptor,
    owner: AbortSignal,
  ): Promise<DaemonFilesSession>;
}

export interface DaemonFilesHostContext {
  /** The verified local authority the daemon serves. */
  readonly authorityId: string;
  /** The realpath of the data root; catalog revisions hash these paths. */
  readonly canonicalDataRoot: string;
}

export interface DaemonFilesRouteOptions {
  readonly isFlagEnabled: () => boolean;
  /** Registers a flag-snapshot listener; returns its unsubscribe. */
  readonly onFlagChanged: (listener: () => void) => () => void;
  readonly lifetime: ElectronDaemonCallerLifetime;
  /** Lazy: called only for a request already selected for the daemon. */
  readonly connections: () => DaemonFilesConnections;
  /** Lazy: called only for a request already selected for the daemon. */
  readonly hostContext: () => Promise<DaemonFilesHostContext>;
  /** The build brand's managed Cowork folder name, as the daemon build bakes it. */
  readonly coworkManagedDirName: string;
  /** The data root spelling the direct reader returns in `absolutePath`. */
  readonly displayDataRoot: () => string;
  readonly workspaceType: (workspaceId: string) => WorkspaceType | null;
  readonly resolveWorktreeTargetIds: (
    projectId: string,
    worktreeId: string,
  ) => { projectId: string; worktreeId: string } | null;
  readonly createScopeResolver?: (
    context: DaemonFilesHostContext,
  ) => Promise<FilesystemScopeResolver>;
  /** Failure bound for one daemon query, not a performance budget. */
  readonly queryDeadlineMs?: number;
  /** Whose entry-name rules a listing must satisfy; defaults to this host's. */
  readonly entryNamePlatform?: 'posix' | 'win32';
}

export interface DaemonFilesRouteRun<Result, Legacy> {
  /** The unchanged direct handler; it captures its own legacy result. */
  direct: () => Promise<Result>;
  /** Stores the legacy projection of a daemon result. */
  capture: (legacy: Legacy) => void;
}

export interface DaemonFilesRoute {
  roots(
    params: WorkerFilesystemRootsListParams,
    context: CanopyHandlerContext,
    request: DaemonFilesRouteRequest,
    run: DaemonFilesRouteRun<
      WorkerFilesystemRootsListResult,
      FileTreeRootsResponse
    >,
  ): Promise<WorkerFilesystemRootsListResult>;
  directory(
    params: WorkerFilesystemDirectoryListParams,
    context: CanopyHandlerContext,
    request: DaemonFilesRouteRequest,
    run: DaemonFilesRouteRun<
      WorkerFilesystemDirectoryListResult,
      FileTreeDirectoryResponse
    >,
  ): Promise<WorkerFilesystemDirectoryListResult>;
  dispose(): void;
}

export interface ObservedDaemonFilesRoute extends DaemonFilesRoute {
  observe(after?: ReadEvidenceCursor): FilesRouteEvidenceSnapshot;
}

/**
 * Scopes that keep their existing route: App Advisor and the sealed
 * shared-container viewer, and the plan-explore/code-review aliases, whose
 * daemon support is CAN-4399.
 */
export const DAEMON_FILES_EXCLUDED_WORKSPACE_IDS: ReadonlySet<string> = new Set(
  [
    APP_ADVISOR_PROJECT_ID,
    SHARED_CONTAINER_VIEWER_PROJECT_ID,
    PLAN_EXPLORE_CHAT_PROJECT_ID,
    CODE_REVIEW_CHAT_PROJECT_ID,
  ],
);

const ROUTED_WORKSPACE_TYPES: ReadonlySet<WorkspaceType> =
  new Set<WorkspaceType>(['single-repo', 'multi-repo', 'cowork']);

const DEFAULT_QUERY_DEADLINE_MS = 30_000;
const LOCAL_CALLER_PREFIX = 'electron-web-contents:';
const ROUTE_REFRESH = {
  kind: 'after_refresh',
  resource: 'filesystem-roots',
} as const;

const OPERATION_CODES: Readonly<
  Record<DaemonFilesOperation, ReadonlySet<string>>
> = {
  roots: new Set([
    'worker.filesystem.roots.invalidState',
    'worker.filesystem.roots.revisionConflict',
    'worker.filesystem.roots.notFound',
  ]),
  directory: new Set([
    'worker.filesystem.directory.invalidState',
    'worker.filesystem.directory.revisionConflict',
    'worker.filesystem.directory.notFound',
  ]),
};

interface ProjectionChecks {
  /** This is the one bounded refresh after a conflict. */
  readonly retrying: boolean;
  /** The daemon's own attachments-visibility predicate, over the same deps. */
  readonly rootVisible: (absolutePath: string) => Promise<boolean>;
}

function rootVisibilityOf(
  dependencies: FilesystemScopeDependencies,
): (absolutePath: string) => Promise<boolean> {
  return dependencies.rootVisibility ?? readRootVisibility;
}

interface DaemonPlan {
  readonly scope: { readonly workspaceId: string; readonly worktreeId: string };
  readonly caller: CanopyCallerDescriptor;
  readonly sender: DaemonFilesRouteSender;
}

function routeError(
  kind: CanopyErrorPayload['kind'],
  message: string,
  retry: CanopyErrorPayload['retry'] = { kind: 'never' },
): CanopyOperationError {
  return new CanopyOperationError({ kind, message, retry });
}

function routeChangedError(): CanopyOperationError {
  return routeError(
    'cancelled',
    'The Files read route changed while this read ran. Refresh and retry.',
    ROUTE_REFRESH,
  );
}

function documentClosedError(): CanopyOperationError {
  return routeError('cancelled', 'The requesting window closed or reloaded.');
}

/**
 * The operation's typed form of a routed failure: kind, message and details
 * are kept, a code only when the operation declares it, and retry becomes
 * `never` unless it is a refresh.
 */
export function normalizeDaemonFilesError(
  operation: DaemonFilesOperation,
  error: unknown,
): CanopyOperationError {
  const payload =
    error instanceof CanopyOperationError || error instanceof CanopyClientError
      ? error.payload
      : null;
  if (!payload) return routeError('internal', 'The daemon Files read failed.');
  const code =
    payload.code !== undefined && OPERATION_CODES[operation].has(payload.code)
      ? payload.code
      : undefined;
  return new CanopyOperationError({
    kind: payload.kind,
    message: payload.message,
    ...(code !== undefined && { code }),
    ...(payload.details !== undefined && { details: payload.details }),
    retry:
      payload.retry.kind === 'after_refresh'
        ? payload.retry
        : { kind: 'never' },
  });
}

/**
 * The direct reader's own request checks, in its order, with its errors
 * (payload and runtime cause), so the backend never changes how a malformed
 * request fails. They check the ids the caller sent, before alias mapping,
 * and run before any contact. Returns the daemon's spelling of the relative
 * directory: the direct reader lists the root for a leftover `.` (from
 * `./`); the daemon spells the root `''`.
 */
function checkDirectReaderRequest(
  operation: DaemonFilesOperation,
  scope: CanopyWorkspaceScope,
  directory?: { readonly fileRootId: string; readonly relativePath: string },
): string {
  try {
    validateId(scope.workspaceId, 'projectId');
    validateId(scope.worktreeId, 'worktreeId');
    if (!directory) return '';
    validateOptionalRepoId(directory.fileRootId, 'repoId');
    const relativePath = normalizeFileTreeRelativePath(directory.relativePath);
    return relativePath === '.' ? '' : relativePath;
  } catch (error) {
    const failure = translateFilesServiceError(error);
    recordFilesRouteOutcome(operation, `daemon.failed.${failure.payload.kind}`);
    throw new CanopyOperationError(failure.payload, failure.runtimeCause);
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(documentClosedError());
  return new Promise<T>((settle, reject) => {
    const onAbort = (): void => reject(documentClosedError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        settle(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

type FilesRouteEvidenceEvent = {
  operation: DaemonFilesOperation;
  backend: 'direct' | 'daemon';
  senderId: number;
  generation: number;
  request: number;
  phase: 'started' | 'success' | 'failed';
};

export interface FilesRouteEvidenceSnapshot extends ReadEvidenceSnapshot<FilesRouteEvidenceEvent> {
  enabled: boolean;
  generation: number;
  disposed: boolean;
}

function createRouteEvidence(): ReadEvidenceJournal<FilesRouteEvidenceEvent> {
  return createBoundedReadEvidence<FilesRouteEvidenceEvent>();
}

export function createDaemonFilesRoute(
  options: DaemonFilesRouteOptions,
): ObservedDaemonFilesRoute {
  const queryDeadlineMs = options.queryDeadlineMs ?? DEFAULT_QUERY_DEADLINE_MS;
  const entryNamePlatform =
    options.entryNamePlatform ?? (sep === '/' ? 'posix' : 'win32');
  const evidence = createRouteEvidence();
  let requestSequence = 0;
  const observeRead = async <T>(
    operation: DaemonFilesOperation,
    backend: 'direct' | 'daemon',
    senderId: number,
    run: () => Promise<T>,
  ): Promise<T> => {
    const event = {
      operation,
      backend,
      senderId,
      generation,
      request: ++requestSequence,
    };
    evidence.record({ ...event, phase: 'started' });
    try {
      const result = await run();
      evidence.record({ ...event, phase: 'success' });
      return result;
    } catch (error) {
      evidence.record({ ...event, phase: 'failed' });
      throw error;
    }
  };
  let enabled = options.isFlagEnabled();
  // Changes on every flip, both ways; a read that spans one is discarded.
  let generation = 0;
  let flagEpoch = new AbortController();
  let disposed = false;
  const unsubscribe = options.onFlagChanged(() => {
    const next = options.isFlagEnabled();
    if (next === enabled) return;
    enabled = next;
    generation += 1;
    if (!next) {
      // Off: routed reads in flight end now and their sessions close.
      const previous = flagEpoch;
      flagEpoch = new AbortController();
      previous.abort();
      options.lifetime.renewAll();
    }
  });

  let resolver:
    | { key: string; resolve: Promise<FilesystemScopeResolver> }
    | undefined;
  const scopeResolverFor = (
    context: DaemonFilesHostContext,
  ): Promise<FilesystemScopeResolver> => {
    const key = JSON.stringify([
      context.authorityId,
      context.canonicalDataRoot,
    ]);
    if (resolver?.key === key) return resolver.resolve;
    // The daemon's own resolver inputs; any difference changes every revision.
    const pending = (
      options.createScopeResolver ??
      ((host: DaemonFilesHostContext): Promise<FilesystemScopeResolver> =>
        createFilesystemScopeResolver({
          canonicalDataRoot: host.canonicalDataRoot,
          authorityId: host.authorityId,
          targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
          coworkManagedDirName: options.coworkManagedDirName,
          paths: { join, resolve, isAbsolute, sep },
          rootIdentity: readNativeRootIdentity,
        }))
    )(context);
    const entry = { key, resolve: pending };
    resolver = entry;
    void pending.catch(() => {
      if (resolver === entry) resolver = undefined;
    });
    return pending;
  };

  /**
   * Whether the flag decides this request's backend: the trusted caller for
   * this exact sender, an eligible scope, nothing foreign selected. Local
   * lookups only, never daemon contact; `null` keeps the direct reader
   * whatever the flag says.
   */
  const eligibility = (
    scope: CanopyWorkspaceScope,
    caller: CanopyCallerDescriptor,
    request: DaemonFilesRouteRequest,
  ): DaemonPlan | null => {
    if (disposed) return null;
    if (
      caller.interfaceKind !== 'desktop' ||
      caller.authorityId !== LOCAL_DESKTOP_AUTHORITY_ID
    )
      return null;
    const { sender } = request;
    // Only the local window caller trusted main derived for this exact
    // sender. Remote-control bridge callers (`remote-bridge:<id>`) always keep
    // the direct reader, by decision, whatever the flag says.
    if (caller.clientInstanceId !== `${LOCAL_CALLER_PREFIX}${sender.id}`)
      return null;
    // IPC scopes carry exactly these two ids; never reinterpret another selection.
    const { workspaceId, worktreeId, ...selectors } = scope;
    if (
      workspaceId === undefined ||
      worktreeId === undefined ||
      Object.values(selectors).some((value) => value !== undefined)
    )
      return null;
    if (DAEMON_FILES_EXCLUDED_WORKSPACE_IDS.has(workspaceId)) return null;
    // Trusted alias normalization (standalone Cowork); unresolvable stays direct.
    const target = options.resolveWorktreeTargetIds(workspaceId, worktreeId);
    if (!target) return null;
    // Only registered workspaces: an unknown id keeps today's direct read.
    const type = options.workspaceType(target.projectId);
    if (type === null || !ROUTED_WORKSPACE_TYPES.has(type)) return null;
    return {
      scope: { workspaceId: target.projectId, worktreeId: target.worktreeId },
      caller,
      sender,
    };
  };

  /** Decided before any daemon contact; `null` keeps the direct reader. */
  const select = (
    scope: CanopyWorkspaceScope,
    caller: CanopyCallerDescriptor,
    request: DaemonFilesRouteRequest,
  ): DaemonPlan | null =>
    enabled && options.isFlagEnabled()
      ? eligibility(scope, caller, request)
      : null;

  const runDirect = async <Result>(
    operation: DaemonFilesOperation,
    scope: CanopyWorkspaceScope,
    context: CanopyHandlerContext,
    request: DaemonFilesRouteRequest,
    direct: () => Promise<Result>,
  ): Promise<Result> => {
    recordFilesRouteSelected(operation, 'direct');
    const startedAt = generation;
    const result = await direct();
    // A flip mid-read discards a result only where the flag picks the
    // backend; excluded scopes and callers are never affected by it.
    if (
      generation !== startedAt &&
      eligibility(scope, context.caller, request) !== null
    ) {
      recordFilesRouteOutcome(operation, 'direct.discarded');
      throw routeChangedError();
    }
    return result;
  };

  const runDaemon = async <
    Canonical extends { catalogRevision?: string },
    Legacy,
  >(
    operation: DaemonFilesOperation,
    plan: DaemonPlan,
    context: CanopyHandlerContext,
    query: (
      client: DaemonFilesQueryClient,
      scope: CanopyWorkspaceScope,
      queryOptions: CanopyClientQueryOptions,
    ) => Promise<Canonical>,
    project: (
      result: Canonical,
      catalog: FilesystemRootCatalog,
      projectPath: (path: string) => string,
      checks: ProjectionChecks,
    ) => Legacy | Promise<Legacy>,
  ): Promise<{ canonical: Canonical; legacy: Legacy }> => {
    const startedAt = generation;
    const owner = options.lifetime.ownerFor(plan.sender);
    const signal = AbortSignal.any([context.signal, owner, flagEpoch.signal]);
    const throwIfInvalidated = (): void => {
      if (generation !== startedAt || disposed) throw routeChangedError();
      if (owner.aborted) throw documentClosedError();
    };
    const attempt = async (
      retrying: boolean,
    ): Promise<{
      canonical: Canonical;
      legacy: Legacy;
    }> => {
      throwIfInvalidated();
      let host: DaemonFilesHostContext;
      let resolveScope: FilesystemScopeResolver;
      try {
        host = await options.hostContext();
        resolveScope = await scopeResolverFor(host);
      } catch (error) {
        throw error instanceof CanopyOperationError ||
          error instanceof CanopyClientError
          ? error
          : routeError(
              'unavailable',
              'The desktop daemon data root could not be prepared.',
            );
      }
      // `local-desktop` becomes the verified daemon authority here, and only here.
      const scope: CanopyWorkspaceScope = {
        ...plan.scope,
        authorityId: host.authorityId,
      };
      // The trusted owner resolves first: a malformed owner fails before contact.
      const dependencies = await resolveScope(scope, operation);
      throwIfInvalidated();
      const session = await raceAbort(
        options
          .connections()
          .get({ ...plan.caller, authorityId: host.authorityId }, owner),
        signal,
      );
      const client = session.client;
      recordFilesRouteOutcome(operation, 'daemon.queries');
      const result = await query(client, scope, {
        signal,
        metadata: {
          deadlineAt: new Date(Date.now() + queryDeadlineMs).toISOString(),
        },
      });
      const requireSameBackend = (): void => {
        if (session.client !== client)
          throw routeError(
            'unavailable',
            'The desktop daemon connection changed. Retry the read.',
          );
      };
      requireSameBackend();
      throwIfInvalidated();
      const revision = requireFilesystemCatalogRevision(result, operation);
      const canonicalRoot = host.canonicalDataRoot;
      const displayRoot = resolve(options.displayDataRoot());
      const projectPath = (path: string): string => {
        if (path === canonicalRoot) return displayRoot;
        if (path.startsWith(`${canonicalRoot}${sep}`))
          return `${displayRoot}${path.slice(canonicalRoot.length)}`;
        // Attached Cowork folders live outside the data root.
        return path;
      };
      const legacy = await withVerifiedFilesystemCatalog(
        scope,
        revision,
        dependencies,
        operation,
        async (catalog) =>
          project(result, catalog, projectPath, {
            retrying,
            rootVisible: rootVisibilityOf(dependencies),
          }),
      );
      requireSameBackend();
      throwIfInvalidated();
      return { canonical: result, legacy };
    };
    try {
      for (let conflicts = 0; ; conflicts += 1) {
        try {
          const served = await attempt(conflicts > 0);
          recordFilesRouteOutcome(operation, 'daemon.served');
          return served;
        } catch (error) {
          throwIfInvalidated();
          const failure = normalizeDaemonFilesError(operation, error);
          if (failure.payload.kind !== 'conflict') throw failure;
          // One bounded refresh: re-resolve, re-query and re-project once.
          if (conflicts >= 1)
            throw filesystemScopeError(operation, 'revisionConflict');
          recordFilesRouteOutcome(operation, 'daemon.retries');
        }
      }
    } catch (error) {
      const failure = normalizeDaemonFilesError(operation, error);
      recordFilesRouteOutcome(
        operation,
        `daemon.failed.${failure.payload.kind}`,
      );
      throw failure;
    }
  };

  return {
    async roots(
      params,
      context,
      request,
      run,
    ): Promise<WorkerFilesystemRootsListResult> {
      const plan = select(params.scope, context.caller, request);
      return observeRead(
        'roots',
        plan ? 'daemon' : 'direct',
        request.sender.id,
        async () => {
          if (!plan)
            return runDirect(
              'roots',
              params.scope,
              context,
              request,
              run.direct,
            );
          recordFilesRouteSelected('roots', 'daemon');
          checkDirectReaderRequest('roots', params.scope);
          const served = await runDaemon<
            WorkerFilesystemRootsListResult,
            FileTreeRootsResponse
          >(
            'roots',
            plan,
            context,
            (client, scope, queryOptions) =>
              client.query(
                'worker.filesystem.roots.list',
                { scope },
                queryOptions,
              ),
            projectRoots,
          );
          run.capture(served.legacy);
          return served.canonical;
        },
      );
    },
    async directory(
      params,
      context,
      request,
      run,
    ): Promise<WorkerFilesystemDirectoryListResult> {
      const plan = select(params.scope, context.caller, request);
      return observeRead(
        'directory',
        plan ? 'daemon' : 'direct',
        request.sender.id,
        async () => {
          if (!plan)
            return runDirect(
              'directory',
              params.scope,
              context,
              request,
              run.direct,
            );
          recordFilesRouteSelected('directory', 'daemon');
          const relativePath = checkDirectReaderRequest(
            'directory',
            params.scope,
            params,
          );
          const served = await runDaemon<
            WorkerFilesystemDirectoryListResult,
            FileTreeDirectoryResponse
          >(
            'directory',
            plan,
            context,
            async (client, scope, queryOptions) =>
              inDirectReaderOrder(
                await client.query(
                  'worker.filesystem.directory.list',
                  { scope, fileRootId: params.fileRootId, relativePath },
                  queryOptions,
                ),
              ),
            (result, catalog, projectPath, checks) =>
              projectDirectory(
                params.fileRootId,
                relativePath,
                result,
                catalog,
                projectPath,
                entryNamePlatform,
                checks,
              ),
          );
          run.capture(served.legacy);
          return served.canonical;
        },
      );
    },
    observe(after): FilesRouteEvidenceSnapshot {
      return { ...evidence.snapshot(after), enabled, generation, disposed };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      flagEpoch.abort();
    },
  };
}

/**
 * The daemon lists an attachments root exactly while it has visible entries.
 * A mismatch is either a file added or removed after the daemon's read, which
 * the one refresh resolves, or a wrong reply, which persists.
 */
async function requireAttachmentsListing(
  absolutePath: string,
  isListed: boolean,
  checks: ProjectionChecks,
): Promise<void> {
  if ((await checks.rootVisible(absolutePath)) === isListed) return;
  if (checks.retrying) throw filesystemScopeError('roots', 'invalidState');
  throw filesystemScopeError('roots', 'revisionConflict');
}

/**
 * Legacy roots from a validated daemon result and the matching private
 * catalog. Ids, names and kinds must match the catalog, appear once, and keep
 * the catalog's order. An attachments root is listed exactly while it has
 * visible entries, as both readers decide.
 */
async function projectRoots(
  result: WorkerFilesystemRootsListResult,
  catalog: FilesystemRootCatalog,
  projectPath: (path: string) => string,
  checks: ProjectionChecks,
): Promise<FileTreeRootsResponse> {
  const invalid = (): never => {
    throw filesystemScopeError('roots', 'invalidState');
  };
  const listed = result.roots;
  let index = 0;
  const roots: FileTreeRootsResponse['roots'] = [];
  for (const trusted of catalog.roots) {
    const root = listed[index];
    const isListed = root?.fileRootId === trusted.id;
    if (trusted.kind === 'attachments')
      await requireAttachmentsListing(trusted.absolutePath, isListed, checks);
    else if (!isListed) invalid();
    if (!isListed || root === undefined) continue;
    if (trusted.name !== root.name || trusted.kind !== root.kind) invalid();
    roots.push({
      repoId: root.fileRootId,
      repoName: root.name,
      absolutePath: projectPath(trusted.absolutePath),
      rootKind: root.kind,
    });
    index += 1;
  }
  // Unknown, duplicate or out-of-order ids are left over.
  if (index !== listed.length) invalid();
  return { roots };
}

// Win32 device basenames, with or without spaces and an extension.
const WIN32_DEVICE_NAME =
  /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³]) *(?:\.|$)/i;
// NTFS aliases of `.git` that the case-sensitive `.git` check misses (Git
// for Windows' core.protectNTFS set; trailing dots, spaces and streams are
// refused separately).
const WIN32_DOT_GIT_ALIAS = /^(?:\.git|git~1)$/i;

/**
 * One name as the platform's directory listing can return it. POSIX names
 * may hold `\` or start like a drive (`c:notes`); the direct reader lists
 * them, so they are not refused here. On Windows, `:` (drive-relative or
 * stream syntax), device names, `.git` aliases and a trailing dot or space
 * would make the joined path name something other than this child, so they
 * are refused.
 */
export function isDirectoryEntryName(
  name: string,
  platform: 'posix' | 'win32',
): boolean {
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\0')
  )
    return false;
  if (platform === 'posix') return true;
  return (
    !name.includes('\\') &&
    !name.includes(':') &&
    !WIN32_DEVICE_NAME.test(name) &&
    !WIN32_DOT_GIT_ALIAS.test(name) &&
    !/[. ]$/.test(name)
  );
}

/**
 * The direct reader's comparator, run here in main, so the daemon's locale
 * cannot change the entry order. Names it ranks equal keep the daemon's
 * order: the direct reader's readdir order is not visible here.
 */
function inDirectReaderOrder(
  result: WorkerFilesystemDirectoryListResult,
): WorkerFilesystemDirectoryListResult {
  return { ...result, entries: sortDirectoryEntries(result.entries) };
}

/**
 * Legacy entries under the catalog root, in the order of the reordered
 * result. Every entry must be a direct child of the requested directory,
 * outside `.git`, and listed once; any other entry rejects the whole response.
 * A hidden attachments root is not a root, as in the roots list.
 */
async function projectDirectory(
  fileRootId: string,
  relativePath: string,
  result: WorkerFilesystemDirectoryListResult,
  catalog: FilesystemRootCatalog,
  projectPath: (path: string) => string,
  entryNamePlatform: 'posix' | 'win32',
  checks: ProjectionChecks,
): Promise<FileTreeDirectoryResponse> {
  const root = catalog.byId.get(fileRootId);
  if (
    !root ||
    (root.kind === 'attachments' &&
      !(await checks.rootVisible(root.absolutePath)))
  )
    throw filesystemScopeError('directory', 'notFound');
  const rootPath = projectPath(root.absolutePath);
  const seen = new Set<string>();
  return {
    entries: result.entries.map((entry) => {
      const expected =
        relativePath === '' ? entry.name : `${relativePath}/${entry.name}`;
      if (
        !isDirectoryEntryName(entry.name, entryNamePlatform) ||
        entry.relativePath !== expected ||
        hasGitPathSegment(entry.relativePath) ||
        seen.has(entry.relativePath)
      )
        throw filesystemScopeError('directory', 'invalidState');
      seen.add(entry.relativePath);
      return {
        name: entry.name,
        relativePath: entry.relativePath,
        absolutePath: join(rootPath, ...entry.relativePath.split('/')),
        kind: entry.kind,
        isIgnored: entry.isIgnored,
        isIndexExcluded: entry.isIndexExcluded,
        isSymlink: entry.isSymlink,
        hasChildren: entry.hasChildren,
      };
    }),
  };
}
