import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import type { CanopyClientStreamFrame } from '@canopy/core-client';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import { readFilesystemScope } from '@canopy/core-runtime/node';
import {
  WORKER_TERMINAL_GRANTS,
  type CanopyCallerDescriptor,
  type CanopyWorkspaceScope,
  type WorkerTerminalAttachItem,
} from '@canopy/protocol/canopy-core';
import { isSafePortableRelativePath } from '@canopy/protocol/safe-relative-path';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  resolveWorktreeCwd,
  resolveWorktreeTargetIds,
} from '../lib/resolve-worktree';
import { daemonUnreachableReason } from '../canopy-runtime/electron-daemon-connection';
import {
  getElectronDaemonConnections,
  getElectronDaemonFilesContext,
} from '../canopy-runtime/electron-daemon-access';
import type { ElectronDaemonClient } from '../canopy-runtime/electron-daemon-host';
import { getDaemonScopeResolver } from '../canopy-runtime/daemon-scope-resolver';
import { getElectronDaemonHealth } from '../canopy-runtime/electron-daemon-health';
import {
  RemoteTerminals,
  type RemoteTerminalFrame,
  type RemoteTerminalTransport,
} from '@canopy/core-runtime/node/terminal';
import { terminalPersistenceStore } from './persistence';
import { createDesktopTerminalHost, workerTerminal } from './worker-terminal';

/**
 * Routing of renderer terminals to the daemon's terminal host (CAN-5088),
 * used by eligible local main and App Advisor windows. Only the renderer
 * terminal IPC handlers pass a route context, so Portal, script, Claude and
 * every other caller keep the in-process engine. The placement is decided
 * once, before any daemon contact, without a Labs or feature-flag gate.
 * Terminals already placed keep running where they are.
 */

/** Which hosts may place terminals in the daemon. Windows waits for CAN-5091. */
export const DAEMON_TERMINAL_PLATFORMS: Readonly<
  Record<PlatformOperatingSystem, boolean>
> = { darwin: true, linux: true, win32: false };

/** Set only by the renderer terminal IPC handlers, from the trusted event. */
export interface DaemonTerminalRouteContext {
  /**
   * The sender is one of this app's own windows, not the remote-control
   * bridge a paired controller drives.
   */
  readonly localWindow: boolean;
}

/** The parts of a renderer terminal request that decide its placement. */
export interface DaemonTerminalRouteRequest {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly selectedRepoId?: string;
  readonly managedCommand?: unknown;
  readonly relativeCwd?: string;
}

export interface DaemonTerminalRouteInput {
  readonly platform: PlatformOperatingSystem | null;
  readonly context: DaemonTerminalRouteContext | undefined;
  readonly request: DaemonTerminalRouteRequest;
  /** Main's record says the daemon cannot be reached right now. */
  readonly daemonLatched: boolean;
  readonly daemonTerminals: number;
}

/**
 * The daemon's terminal host serves at most 48 terminals; main keeps one
 * attachment to each, leaving the rest of the binding's streams to others.
 */
export const DAEMON_TERMINAL_LIMIT = 48;

/**
 * Whether a renderer terminal may be placed in the daemon, as code. `false`
 * keeps the in-process engine. Shared-container terminals keep their run
 * consent lifecycle in process, and managed or relative-directory terminals
 * are script actions (CAN-5087).
 */
export function isDaemonTerminalRouteEligible(
  input: DaemonTerminalRouteInput,
): boolean {
  const { platform, context, request } = input;
  return (
    platform !== null &&
    DAEMON_TERMINAL_PLATFORMS[platform] &&
    context?.localWindow === true &&
    request.projectId !== SHARED_CONTAINER_VIEWER_PROJECT_ID &&
    request.managedCommand === undefined &&
    (request.relativeCwd === undefined || request.relativeCwd === '') &&
    !input.daemonLatched &&
    input.daemonTerminals < DAEMON_TERMINAL_LIMIT
  );
}

/** Where a selected terminal starts, in the daemon's terms. */
export interface DaemonTerminalTarget {
  readonly scope: CanopyWorkspaceScope;
  readonly cwdRootId: string;
  /** The worktree directory both sides resolve the root to. */
  readonly rootPath: string;
}

function hostPlatform(): PlatformOperatingSystem | null {
  try {
    return hostPlatformOperatingSystem();
  } catch {
    return null;
  }
}

async function canonical(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/**
 * The catalog root the daemon resolves to the directory the in-process
 * engine would start in, read from the same tracking records the daemon
 * reads. `null` when none matches: the terminal stays in process.
 */
async function resolveTarget(
  request: DaemonTerminalRouteRequest,
): Promise<DaemonTerminalTarget | null> {
  const ids = resolveWorktreeTargetIds(request.projectId, request.worktreeId);
  if (!ids) return null;
  const rootPath = resolveWorktreeCwd(
    request.projectId,
    request.worktreeId,
    request.selectedRepoId,
  );
  const wanted = await canonical(rootPath);
  if (wanted === null) return null;
  const scope = { workspaceId: ids.projectId, worktreeId: ids.worktreeId };
  try {
    const catalog = await readFilesystemScope(
      scope,
      await (
        await getDaemonScopeResolver()
      )(scope, 'roots'),
      'roots',
    );
    for (const root of catalog.roots) {
      if (root.kind === 'attachments') continue;
      if ((await canonical(root.absolutePath)) === wanted)
        return { scope, cwdRootId: root.id, rootPath };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The daemon placement for a renderer terminal, or `null` to keep it in
 * process. Reads only local state; the daemon is contacted afterwards.
 */
export async function selectDaemonTerminalTarget(
  request: DaemonTerminalRouteRequest,
  context: DaemonTerminalRouteContext | undefined,
): Promise<DaemonTerminalTarget | null> {
  const health = getElectronDaemonHealth();
  const eligible = isDaemonTerminalRouteEligible({
    platform: hostPlatform(),
    context,
    request,
    daemonLatched: health.isLatched(),
    daemonTerminals: workerTerminal.daemonTerminals?.count() ?? 0,
  });
  return eligible ? resolveTarget(request) : null;
}

/**
 * A restored terminal's directory, as the engine picks it: its persisted
 * directory while that still exists inside the root, otherwise the root.
 */
export function daemonRestoreDirectory(
  root: string,
  persisted: string,
): { readonly cwdRelativePath: string; readonly cwd: string } {
  const path = isAbsolute(persisted)
    ? relative(root, persisted).split(sep).join('/')
    : '';
  return isSafePortableRelativePath(path) && existsSync(persisted)
    ? { cwdRelativePath: path, cwd: persisted }
    : { cwdRelativePath: '', cwd: root };
}

/**
 * Whether a daemon call failed because the daemon could not be reached, so
 * the terminal opens in process instead (shown as the background service
 * warning), or because a reached daemon could not start its terminal host
 * (an install without the host entry beside it). Any other refusal from a
 * reached daemon is not.
 */
export function noteDaemonTerminalFallback(error: unknown): boolean {
  const reason = daemonUnreachableReason(error);
  if (reason !== null) {
    getElectronDaemonHealth().noteFallback('terminals', reason);
    return true;
  }
  // Only the worker's definitive refusal: an `unavailable` the client may
  // retry with its key has an unknown outcome, and the daemon may already
  // hold that terminal.
  const { kind, retry } = errorPayload(error);
  if (kind !== 'unavailable' || retry !== 'never') return false;
  // The daemon itself is reachable, so its health and Files reads stay as
  // they are; only this terminal opens in process.
  logMainProcessWarn('Daemon terminal host unavailable; opening in process.');
  return true;
}

function errorPayload(error: unknown): { kind: unknown; retry: unknown } {
  const field = (value: unknown, name: string): unknown =>
    typeof value === 'object' && value !== null
      ? Reflect.get(value, name)
      : undefined;
  const payload = field(error, 'payload');
  return {
    kind: field(payload, 'kind'),
    retry: field(field(payload, 'retry'), 'kind'),
  };
}

const owner = new AbortController();

/**
 * Main's own terminal session with the daemon, for every daemon terminal,
 * under the verified local authority the daemon serves.
 */
async function client(): Promise<ElectronDaemonClient> {
  getElectronDaemonHealth().setConsumerEnabled('terminals', true);
  const { authorityId } = await getElectronDaemonFilesContext();
  const caller: CanopyCallerDescriptor = {
    principalId: 'local-desktop-user',
    clientInstanceId: 'electron-main:terminals',
    authorityId,
    interfaceKind: 'desktop',
    grants: [WORKER_TERMINAL_GRANTS.read, WORKER_TERMINAL_GRANTS.write],
  };
  return (await getElectronDaemonConnections().get(caller, owner.signal))
    .client;
}

function frameOf(
  frame: CanopyClientStreamFrame<WorkerTerminalAttachItem, unknown>,
): RemoteTerminalFrame {
  return frame.kind === 'item'
    ? { kind: 'item', item: frame.item }
    : { kind: 'end', outcome: frame.outcome, error: frame.error };
}

const transport: RemoteTerminalTransport = {
  create: async (params) =>
    (await client()).instruction('worker.terminal.create', params),
  restore: async (params) =>
    (await client()).instruction('worker.terminal.restore', params),
  write: async (params) =>
    (await client()).instruction('worker.terminal.write', params),
  resize: async (params) =>
    (await client()).instruction('worker.terminal.resize', params),
  kill: async (params) =>
    (await client()).instruction('worker.terminal.kill', params),
  release: async (params) =>
    (await client()).instruction('worker.terminal.release', params),
  attach: async (params, onFrame) => {
    const session = await client();
    const handle = await session.openStream('worker.terminal.attach', params);
    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      onFrame({ kind: 'end', outcome: 'error', error: null });
    };
    // A dropped connection ends the stream without an end frame.
    session.signal.addEventListener('abort', end, { once: true });
    const unsubscribe = handle.onFrame((frame) => {
      if (ended) return;
      if (frame.kind === 'end') {
        ended = true;
        session.signal.removeEventListener('abort', end);
      }
      onFrame(frameOf(frame));
    });
    return {
      close: () => {
        ended = true;
        session.signal.removeEventListener('abort', end);
        unsubscribe();
        handle.close();
      },
    };
  },
};

/** Daemon terminals, composed into the routed port on first placement. */
export function getDaemonTerminals(): RemoteTerminals {
  const existing = workerTerminal.daemonTerminals;
  if (existing) return existing;
  const host = createDesktopTerminalHost();
  const daemon = new RemoteTerminals({
    transport,
    persistence: terminalPersistenceStore,
    resources: host.resources,
    emit: (event): void => workerTerminal.emit(event),
    log: (message, details): void => logMainProcessWarn(message, details),
    createIdempotencyKey: randomUUID,
  });
  workerTerminal.useDaemonTerminals(daemon);
  return daemon;
}
