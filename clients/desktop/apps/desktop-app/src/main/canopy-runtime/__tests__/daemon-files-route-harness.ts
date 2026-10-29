import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import {
  CanopyClientError,
  type CanopyClientQueryOptions,
} from '@canopy/core-client';
import {
  createFilesystemScopeResolver,
  listFilesystemScopeDirectory,
  listFilesystemScopeRoots,
  readNativeRootIdentity,
  type FilesystemScopeResolver,
  type GitIgnoreHostPort,
} from '@canopy/core-runtime/node';
import {
  CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  type CanopyCallerDescriptor,
  type CanopyWorkspaceScope,
  type WorkerFilesystemDirectoryListParams,
  type WorkerFilesystemDirectoryListResult,
  type WorkerFilesystemRootsListParams,
  type WorkerFilesystemRootsListResult,
} from '@canopy/protocol/canopy-core';
import type {
  FileTreeDirectoryRequest,
  FileTreeRootsRequest,
  WorkspaceType,
} from '@canopy/desktop-shared/types';
import {
  directoryInputsFor,
  fakeGit,
  seedFilesystemRecords,
} from '../../../../../core-daemon/src/__tests__/filesystem-fixtures';
import {
  listFileTreeDirectory,
  listFileTreeRoots,
} from '../../services/files-service';
import { resolveWorktreeTargetIds } from '../../lib/resolve-worktree';
import {
  getWorkspaceType,
  registerWorkspaceTypes,
} from '../../lib/workspace-registry';
import {
  createDaemonFilesRoute,
  type DaemonFilesConnections,
  type DaemonFilesQueryClient,
  type DaemonFilesRouteSender,
  type DaemonFilesSession,
} from '../daemon-files-route';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../desktop-runtime-identity';
import {
  createElectronDaemonCallerLifetime,
  type ElectronDaemonCallerLifetime,
} from '../electron-daemon-caller-lifetime';

export const AUTHORITY = 'authority-c4305';
export const COWORK_DIR = '.canopy';

/** The fixture's tracked workspaces, as the sidebar read registers them. */
export const FIXTURE_TYPES: ReadonlyArray<[string, WorkspaceType]> = [
  ['single', 'single-repo'],
  ['multi', 'multi-repo'],
  ['cowork', 'cowork'],
  ['team-a', 'single-repo'],
  ['team-b', 'single-repo'],
  ['malformed', 'single-repo'],
];

const DESKTOP_GRANTS: CanopyCallerDescriptor['grants'] = [
  'worker.filesystem.read',
  'core.workspace.read',
  'core.chat.read',
  'core.chat.write',
  'core.worktree.read',
];

/** A `WebContents` stand-in: an emitter with an id and a destroyed state. */
export class FakeSender extends EventEmitter implements DaemonFilesRouteSender {
  private destroyedState = false;
  public constructor(public readonly id: number) {
    super();
  }
  public isDestroyed(): boolean {
    return this.destroyedState;
  }
  public destroy(): void {
    this.destroyedState = true;
    this.emit('destroyed');
  }
  public retiringListeners(): number {
    return (
      this.listenerCount('destroyed') +
      this.listenerCount('render-process-gone') +
      this.listenerCount('did-navigate')
    );
  }
}

export function localCaller(sender: { id: number }): CanopyCallerDescriptor {
  return {
    principalId: 'local-desktop-user',
    clientInstanceId: `electron-web-contents:${sender.id}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants: [...DESKTOP_GRANTS],
  };
}

export function bridgeCaller(
  sender: { id: number },
  controllerDeviceId: string,
): CanopyCallerDescriptor {
  return {
    principalId: `remote-device:${controllerDeviceId}`,
    clientInstanceId: `remote-bridge:${sender.id}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants: [...DESKTOP_GRANTS],
  };
}

export interface ControllableFlag {
  readonly isEnabled: () => boolean;
  readonly onChanged: (listener: () => void) => () => void;
  set(value: boolean): void;
  listeners(): number;
}

export function controllableFlag(initial: boolean): ControllableFlag {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    isEnabled: () => value,
    onChanged: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next): void {
      value = next;
      for (const listener of Array.from(listeners)) listener();
    },
    listeners: () => listeners.size,
  };
}

export interface Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolveValue: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolveValue = done;
  });
  return { promise, resolve: resolveValue };
}

export type DaemonQueryName =
  | 'worker.filesystem.roots.list'
  | 'worker.filesystem.directory.list';
type DaemonParams =
  | WorkerFilesystemRootsListParams
  | WorkerFilesystemDirectoryListParams;
type DaemonResult =
  | WorkerFilesystemRootsListResult
  | WorkerFilesystemDirectoryListResult;

export interface DaemonQueryRecord {
  readonly name: DaemonQueryName;
  readonly params: DaemonParams;
  readonly options: CanopyClientQueryOptions | undefined;
}

/**
 * The daemon's filesystem module, in process: Leg A's scope readers over the
 * same records, with its own resolver. Hooks fail, gate, rewrite or race a
 * reply; `null` from `rewrite` serves the real reply.
 */
export class FakeDaemon {
  public readonly queries: DaemonQueryRecord[] = [];
  public fail: ((record: DaemonQueryRecord) => Error | null) | null = null;
  public beforeReply: ((record: DaemonQueryRecord) => Promise<void>) | null =
    null;
  public afterReply:
    | ((record: DaemonQueryRecord, attempt: number) => Promise<void>)
    | null = null;
  public rewriteRoots:
    | ((
        result: WorkerFilesystemRootsListResult,
      ) => WorkerFilesystemRootsListResult)
    | null = null;
  public rewriteDirectory:
    | ((
        result: WorkerFilesystemDirectoryListResult,
      ) => WorkerFilesystemDirectoryListResult)
    | null = null;

  public constructor(
    private readonly dataRoot: string,
    private readonly resolveScope: FilesystemScopeResolver,
    public git: GitIgnoreHostPort,
  ) {}

  public async serve(
    name: DaemonQueryName,
    params: DaemonParams,
    options: CanopyClientQueryOptions | undefined,
  ): Promise<DaemonResult> {
    const record: DaemonQueryRecord = { name, params, options };
    this.queries.push(record);
    const attempt = this.queries.length;
    const failure = this.fail?.(record) ?? null;
    if (failure) throw failure;
    if (this.beforeReply) await this.beforeReply(record);
    if (options?.signal?.aborted)
      throw new CanopyClientError({
        kind: 'cancelled',
        message: 'The request was cancelled.',
        retry: { kind: 'never' },
      });
    let result: DaemonResult;
    if ('fileRootId' in params) {
      const real = await listFilesystemScopeDirectory(
        params,
        await this.resolveScope(params.scope, 'directory'),
        await directoryInputsFor(this.dataRoot, this.git).readOptions(
          new AbortController().signal,
        ),
      );
      result = this.rewriteDirectory ? this.rewriteDirectory(real) : real;
    } else {
      const real = await listFilesystemScopeRoots(
        params,
        await this.resolveScope(params.scope, 'roots'),
      );
      result = this.rewriteRoots ? this.rewriteRoots(real) : real;
    }
    if (this.afterReply) await this.afterReply(record, attempt);
    return result;
  }

  public names(): DaemonQueryName[] {
    return this.queries.map((query) => query.name);
  }
}

class FakeDaemonClient implements DaemonFilesQueryClient {
  public constructor(private readonly daemon: FakeDaemon) {}
  public query(
    name: 'worker.filesystem.roots.list',
    params: WorkerFilesystemRootsListParams,
    options?: CanopyClientQueryOptions,
  ): Promise<WorkerFilesystemRootsListResult>;
  public query(
    name: 'worker.filesystem.directory.list',
    params: WorkerFilesystemDirectoryListParams,
    options?: CanopyClientQueryOptions,
  ): Promise<WorkerFilesystemDirectoryListResult>;
  public query(
    name: DaemonQueryName,
    params: DaemonParams,
    options?: CanopyClientQueryOptions,
  ): Promise<DaemonResult> {
    return this.daemon.serve(name, params, options);
  }
}

export interface FakeSessionRecord {
  readonly caller: CanopyCallerDescriptor;
  readonly owner: AbortSignal;
  closed: boolean;
  client: DaemonFilesQueryClient;
}

/**
 * The connection service's reuse rule: one session per `clientInstanceId`,
 * reused only for the same caller and owner, closed when its owner aborts.
 */
export class FakeConnections implements DaemonFilesConnections {
  public readonly gets: Array<{
    caller: CanopyCallerDescriptor;
    owner: AbortSignal;
  }> = [];
  public readonly sessions: FakeSessionRecord[] = [];
  public fail: (() => Error) | null = null;
  public gate: Promise<void> | null = null;

  public constructor(private readonly daemon: FakeDaemon) {}

  public async get(
    caller: CanopyCallerDescriptor,
    owner: AbortSignal,
  ): Promise<DaemonFilesSession> {
    this.gets.push({ caller, owner });
    if (this.gate) await this.gate;
    if (this.fail) throw this.fail();
    if (owner.aborted)
      throw new CanopyClientError({
        kind: 'cancelled',
        message: 'Desktop connection owner is closed.',
        retry: { kind: 'never' },
      });
    const key = JSON.stringify(caller);
    let record = this.sessions.find(
      (session) =>
        !session.closed &&
        JSON.stringify(session.caller) === key &&
        session.owner === owner,
    );
    if (!record) {
      for (const session of this.sessions)
        if (session.caller.clientInstanceId === caller.clientInstanceId)
          session.closed = true;
      const created: FakeSessionRecord = {
        caller,
        owner,
        closed: false,
        client: new FakeDaemonClient(this.daemon),
      };
      owner.addEventListener(
        'abort',
        () => {
          created.closed = true;
        },
        { once: true },
      );
      this.sessions.push(created);
      record = created;
    }
    const session = record;
    return {
      get client(): DaemonFilesQueryClient {
        if (session.closed)
          throw new CanopyClientError({
            kind: 'cancelled',
            message: 'Desktop connection owner is closed.',
            retry: { kind: 'never' },
          });
        return session.client;
      },
    };
  }

  /** Simulates a lease moving to a freshly attached backend connection. */
  public reattach(index = this.sessions.length - 1): void {
    const session = this.sessions[index];
    if (session) session.client = new FakeDaemonClient(this.daemon);
  }
}

export interface RouteHarness {
  readonly base: string;
  readonly dataRoot: string;
  readonly displayRoot: string;
  readonly flag: ControllableFlag;
  readonly lifetime: ElectronDaemonCallerLifetime;
  readonly daemon: FakeDaemon;
  readonly connections: FakeConnections;
  readonly hostContext: jest.Mock<
    Promise<{ authorityId: string; canonicalDataRoot: string }>,
    []
  >;
  readonly connectionsFactory: jest.Mock<DaemonFilesConnections, []>;
  readonly direct: {
    readonly roots: jest.Mock<
      ReturnType<typeof listFileTreeRoots>,
      [FileTreeRootsRequest]
    >;
    readonly directory: jest.Mock<
      ReturnType<typeof listFileTreeDirectory>,
      [FileTreeDirectoryRequest]
    >;
  };
  readonly route: ReturnType<typeof createDaemonFilesRoute>;
  readonly runtime: DesktopCanopyDispatcher;
  roots(
    scope: CanopyWorkspaceScope,
    sender: DaemonFilesRouteSender,
    caller?: CanopyCallerDescriptor,
  ): ReturnType<DesktopCanopyDispatcher['queryFileTreeRootsForLegacyIpc']>;
  directory(
    scope: CanopyWorkspaceScope,
    fileRootId: string,
    relativePath: string,
    sender: DaemonFilesRouteSender,
    caller?: CanopyCallerDescriptor,
  ): ReturnType<DesktopCanopyDispatcher['queryFileTreeDirectoryForLegacyIpc']>;
  close(): Promise<void>;
}

export interface RouteHarnessOptions {
  readonly flag?: boolean;
  readonly queryDeadlineMs?: number;
  /** Ignore results for the in-process daemon; legacy uses real Git. */
  readonly git?: GitIgnoreHostPort;
  readonly entryNamePlatform?: 'posix' | 'win32';
}

/**
 * A real data root (canonical) reached through a symlinked display spelling,
 * the desktop runtime and dispatcher, the production route, and an in-process
 * daemon behind the connection-service reuse rule. The direct reader is the
 * real desktop service, spied.
 */
export async function createRouteHarness(
  options: RouteHarnessOptions = {},
): Promise<RouteHarness> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'c4305-route-')));
  const dataRoot = join(base, 'data');
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const displayRoot = join(base, 'display');
  await symlink(dataRoot, displayRoot);
  await seedFilesystemRecords(dataRoot);
  const previousDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = displayRoot;
  registerWorkspaceTypes(new Map(FIXTURE_TYPES));

  const daemonResolver = await createFilesystemScopeResolver({
    canonicalDataRoot: dataRoot,
    authorityId: AUTHORITY,
    targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
    coworkManagedDirName: COWORK_DIR,
    paths: { join, resolve, isAbsolute, sep },
    rootIdentity: readNativeRootIdentity,
  });
  const daemon = new FakeDaemon(
    dataRoot,
    daemonResolver,
    options.git ?? fakeGit(() => Promise.resolve(new Set<string>())),
  );
  const connections = new FakeConnections(daemon);
  const flag = controllableFlag(options.flag ?? true);
  const lifetime = createElectronDaemonCallerLifetime();
  const hostContext = jest.fn(() =>
    Promise.resolve({ authorityId: AUTHORITY, canonicalDataRoot: dataRoot }),
  );
  const connectionsFactory = jest.fn((): DaemonFilesConnections => connections);
  const direct = {
    roots: jest.fn(listFileTreeRoots),
    directory: jest.fn(listFileTreeDirectory),
  };
  const route = createDaemonFilesRoute({
    isFlagEnabled: flag.isEnabled,
    onFlagChanged: flag.onChanged,
    lifetime,
    connections: connectionsFactory,
    hostContext,
    coworkManagedDirName: COWORK_DIR,
    displayDataRoot: () => displayRoot,
    workspaceType: getWorkspaceType,
    resolveWorktreeTargetIds,
    ...(options.queryDeadlineMs !== undefined && {
      queryDeadlineMs: options.queryDeadlineMs,
    }),
    ...(options.entryNamePlatform && {
      entryNamePlatform: options.entryNamePlatform,
    }),
  });
  const runtime = createDesktopRuntime({
    services: {
      listFileTreeRoots: direct.roots,
      listFileTreeDirectory: direct.directory,
    },
    daemonFilesRoute: () => route,
    shutdownTimeoutMs: 1_000,
  });
  return {
    base,
    dataRoot,
    displayRoot,
    flag,
    lifetime,
    daemon,
    connections,
    hostContext,
    connectionsFactory,
    direct,
    route,
    runtime,
    roots: (scope, sender, caller = localCaller(sender)) =>
      runtime.queryFileTreeRootsForLegacyIpc({ scope }, { caller }, { sender }),
    directory: (
      scope,
      fileRootId,
      relativePath,
      sender,
      caller = localCaller(sender),
    ) =>
      runtime.queryFileTreeDirectoryForLegacyIpc(
        { scope, fileRootId, relativePath },
        { caller },
        { sender },
      ),
    async close(): Promise<void> {
      route.dispose();
      lifetime.disposeAll();
      await runtime.shutdown();
      registerWorkspaceTypes(new Map());
      if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = previousDataDir;
      await rm(base, { recursive: true, force: true });
    },
  };
}

export interface ReplyHold {
  /** Resolves once `count` replies are held, or rejects if `read` settles first. */
  reached(count: number, read: Promise<unknown>): Promise<void>;
  release(): void;
}

/**
 * Holds every daemon reply from now on until `release`. Tests wait on the
 * hold itself, never on a poll, so a slow filesystem cannot starve the wait.
 */
export function holdReplies(daemon: FakeDaemon): ReplyHold {
  const gate = deferred();
  let held = 0;
  const waiters: Array<{ count: number; done: () => void }> = [];
  daemon.beforeReply = (): Promise<void> => {
    held += 1;
    for (const waiter of waiters.splice(0))
      if (held >= waiter.count) waiter.done();
      else waiters.push(waiter);
    return gate.promise;
  };
  return {
    reached: (count, read): Promise<void> => {
      const reached =
        held >= count
          ? Promise.resolve()
          : new Promise<void>((done) => waiters.push({ count, done }));
      return untilReached(reached, read);
    },
    release: (): void => gate.resolve(),
  };
}

/**
 * Resolves when `reached` does; rejects if `read` settles first, so a read
 * that fails before the hold fails the test at once instead of timing out.
 */
export async function untilReached(
  reached: Promise<void>,
  read: Promise<unknown>,
): Promise<void> {
  const settled = read.then(
    () => 'settled' as const,
    () => 'settled' as const,
  );
  const first = await Promise.race([
    reached.then(() => 'reached' as const),
    settled,
  ]);
  if (first !== 'reached')
    throw new Error('The read settled before reaching the hold.');
}

/** The payload of a rejected routed read. */
export async function rejection(
  read: Promise<unknown>,
): Promise<{ kind: string; code?: string; message: string; retry: unknown }> {
  try {
    await read;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'payload' in error &&
      typeof error.payload === 'object' &&
      error.payload !== null
    ) {
      const payload: Record<string, unknown> = { ...error.payload };
      const { kind, code, message, retry } = payload;
      if (typeof kind === 'string' && typeof message === 'string')
        return {
          kind,
          ...(typeof code === 'string' && { code }),
          message,
          retry,
        };
    }
    throw error;
  }
  throw new Error('Expected the read to be rejected.');
}
