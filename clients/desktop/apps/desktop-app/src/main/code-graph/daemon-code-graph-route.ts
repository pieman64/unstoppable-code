import { randomUUID } from 'node:crypto';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import type { CodeGraphBuildState } from '@canopy/code-graph/types/code-graph-tools';
import {
  WORKER_CODE_GRAPH_GRANTS,
  type CanopyCallerDescriptor,
  type WorkerCodeGraphBuildParams,
  type WorkerCodeGraphBuildResult,
  type WorkerCodeGraphQueryParams,
  type WorkerCodeGraphQueryResult,
} from '@canopy/protocol/canopy-core';
import {
  daemonUnreachableReason,
  markUnreachable,
} from '../canopy-runtime/electron-daemon-connection';
import {
  getElectronDaemonConnections,
  getElectronDaemonFilesContext,
} from '../canopy-runtime/electron-daemon-access';
import type { ElectronDaemonClient } from '../canopy-runtime/electron-daemon-host';
import { getElectronDaemonHealth } from '../canopy-runtime/electron-daemon-health';
import { getLabsExperimentsService } from '../services/labs-experiments-runtime';
import { logMainProcessWarn } from '../lib/main-process-logging';

/**
 * Routing of renderer code-graph builds and reads to the daemon's graph
 * hosts (CAN-5089), selected by the `daemon-code-graph` Labs experiment.
 * Only the code-graph IPC handlers pass a route context, so agent tools,
 * hooks, the automatic scheduler, Portal and the remote-control bridge keep
 * Electron main's own graph hosts. The route is chosen once per request,
 * before any daemon contact. Both hosts read and write the same graph files
 * under one writer lease (CAN-5084), so turning the experiment off sends the
 * next build or read in process with nothing to repair.
 */

/** Which hosts may build and read graphs in the daemon. Windows waits for CAN-5091. */
export const DAEMON_CODE_GRAPH_PLATFORMS: Readonly<
  Record<PlatformOperatingSystem, boolean>
> = { darwin: true, linux: true, win32: false };

/** Set only by the code-graph IPC handlers, from the trusted event. */
export interface DaemonCodeGraphRouteContext {
  /**
   * The sender is one of this app's own windows, not the remote-control
   * bridge a paired controller drives.
   */
  readonly localWindow: boolean;
}

export interface DaemonCodeGraphRouteInput {
  readonly platform: PlatformOperatingSystem | null;
  readonly experimentEnabled: boolean;
  readonly context: DaemonCodeGraphRouteContext | undefined;
  /** Main's record says the daemon cannot be reached right now. */
  readonly daemonLatched: boolean;
}

/** Whether a renderer code-graph request may go to the daemon, as code. */
export function isDaemonCodeGraphRouteEligible(
  input: DaemonCodeGraphRouteInput,
): boolean {
  return (
    input.experimentEnabled &&
    input.platform !== null &&
    DAEMON_CODE_GRAPH_PLATFORMS[input.platform] &&
    input.context?.localWindow === true &&
    !input.daemonLatched
  );
}

function isExperimentEnabled(): boolean {
  const snapshot = getLabsExperimentsService().getSnapshot();
  return (
    snapshot.ready &&
    snapshot.experiments.some(
      (entry) => entry.id === 'daemon-code-graph' && entry.enabled,
    )
  );
}

/** The experiment's state for cleanup, which must not fail on it. */
function experimentRoutesHere(): boolean {
  try {
    return isExperimentEnabled();
  } catch {
    return false;
  }
}

function hostPlatform(): PlatformOperatingSystem | null {
  try {
    return hostPlatformOperatingSystem();
  } catch {
    return null;
  }
}

/** Whether this renderer request goes to the daemon. Reads only local state. */
export function selectDaemonCodeGraph(
  context: DaemonCodeGraphRouteContext | undefined,
): boolean {
  return isDaemonCodeGraphRouteEligible({
    platform: hostPlatform(),
    experimentEnabled: context !== undefined && isExperimentEnabled(),
    context,
    daemonLatched: getElectronDaemonHealth().isLatched(),
  });
}

/**
 * Whether a daemon call failed because the daemon could not be reached, so
 * the request runs in process instead (shown as the background service
 * warning). Any refusal from a reached daemon is the request's answer.
 */
export function noteDaemonCodeGraphFallback(error: unknown): boolean {
  const reason = daemonUnreachableReason(error);
  if (reason === null) return false;
  getElectronDaemonHealth().noteFallback('code_graph', reason);
  return true;
}

const owner = new AbortController();

/** Main's own code-graph session with the daemon, under its verified authority. */
async function client(): Promise<ElectronDaemonClient> {
  getElectronDaemonHealth().setConsumerEnabled('code_graph', true);
  const { authorityId } = await getElectronDaemonFilesContext();
  const caller: CanopyCallerDescriptor = {
    principalId: 'local-desktop-user',
    clientInstanceId: 'electron-main:code-graph',
    authorityId,
    interfaceKind: 'desktop',
    grants: [WORKER_CODE_GRAPH_GRANTS.read, WORKER_CODE_GRAPH_GRANTS.write],
  };
  return (await getElectronDaemonConnections().get(caller, owner.signal))
    .client;
}

/**
 * Worktrees this app has sent a build to the daemon for. Whatever became of
 * the answer, the daemon may still prepare, build or drain derived analysis
 * for them, so cleanup ends their graph work there.
 */
const built = new Set<string>();

function worktreeKey(workspaceId: string, worktreeId: string): string {
  return `${workspaceId}/${worktreeId}`;
}

/** A worktree build in the daemon, keyed so a resent request joins it. */
export async function buildCodeGraphInDaemon(
  graphScope: Extract<
    WorkerCodeGraphBuildParams['graphScope'],
    { kind: 'worktree' }
  >,
): Promise<WorkerCodeGraphBuildResult> {
  built.add(worktreeKey(graphScope.workspaceId, graphScope.worktreeId));
  return (await client()).instruction(
    'worker.codeGraph.build',
    { graphScope },
    { metadata: { idempotencyKey: randomUUID() } },
  );
}

/**
 * Worktree cleanup: ends the worktree's graph work in the daemon, queued,
 * running, still preparing or draining derived analysis, and waits until
 * every build host has exited, so none can recreate the graph the cleanup
 * removes. Asks only a daemon this app built the worktree in, or one the
 * experiment routes to. A daemon that can't be reached can't be asked; the
 * cleanup goes on, as it must for a worktree being deleted.
 */
export async function drainDaemonCodeGraphWorktree(
  workspaceId: string,
  worktreeId: string,
): Promise<void> {
  const key = worktreeKey(workspaceId, worktreeId);
  if (!built.has(key) && !experimentRoutesHere()) return;
  try {
    await (
      await client()
    ).instruction(
      'worker.codeGraph.builds.cancel',
      { workspaceId, worktreeId },
      { metadata: { idempotencyKey: randomUUID() } },
    );
    built.delete(key);
  } catch {
    logMainProcessWarn('Daemon code graph builds were not drained.', {
      reason: 'daemon refused or unreachable',
    });
  }
}

/**
 * One worktree read in the daemon. A session that closed under the read
 * reads as an unreachable daemon, so the summary comes from the local graph.
 */
export async function queryCodeGraphInDaemon(
  params: WorkerCodeGraphQueryParams,
): Promise<WorkerCodeGraphQueryResult> {
  const session = await client();
  try {
    return await session.query('worker.codeGraph.query', params);
  } catch (error) {
    throw session.signal.aborted && !owner.signal.aborted
      ? markUnreachable(error, 'connection_lost')
      : error;
  }
}

const BUILD_STATE_RANK: Readonly<Record<CodeGraphBuildState, number>> = {
  idle: 0,
  queued: 1,
  running: 2,
};

/**
 * A worktree's source build state across both hosts: the automatic
 * scheduler still builds in process while renderer builds go to the daemon.
 */
export function combinedCodeGraphBuildState(
  local: CodeGraphBuildState,
  daemon: CodeGraphBuildState,
): CodeGraphBuildState {
  return BUILD_STATE_RANK[daemon] > BUILD_STATE_RANK[local] ? daemon : local;
}
