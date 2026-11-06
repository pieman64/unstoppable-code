import { randomUUID } from 'node:crypto';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import type { CodeGraphBuildState } from '@canopy/code-graph/types/code-graph-tools';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import {
  WORKER_CODE_GRAPH_GRANTS,
  type CanopyCallerDescriptor,
  type WorkerCodeGraphBuildParams,
  type WorkerCodeGraphBuildResult,
  type WorkerCodeGraphGenerationReport,
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
import { logMainProcessWarn } from '../lib/main-process-logging';
import { isCodeGraphAvailableForWorkspace } from '../lib/code-graph-availability';
import { recordCodeGraphGenerationReport } from '../lib/code-graph-generation-report';
import { codeGraphReadRecorders } from './read-recorders';
import {
  codeGraphGenerationReportOf,
  codeGraphReadReportOf,
  recordCodeGraphReadReport,
} from '@canopy/core-runtime/node/code-graph';
import { CanopyClientError } from '@canopy/core-client';

/**
 * Routing of renderer code-graph builds and reads to the daemon's graph
 * hosts (CAN-5089), by default on eligible hosts (CAN-5719).
 * Only the code-graph IPC handlers pass a route context, and Electron main's
 * agent build tool and automatic scheduler open one through
 * `selectDaemonCodeGraphForMain` (CAN-5625); Portal, the remote-control
 * bridge, performance scheduling and workspace base graphs keep Electron
 * main's own graph hosts. The route is chosen once per request,
 * before any daemon contact. Both hosts read and write the same graph files
 * under one writer lease (CAN-5084), including in-process fallback.
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
  readonly context: DaemonCodeGraphRouteContext | undefined;
  /** Main's record says the daemon cannot be reached right now. */
  readonly daemonLatched: boolean;
}

/** Whether a renderer code-graph request may go to the daemon, as code. */
export function isDaemonCodeGraphRouteEligible(
  input: DaemonCodeGraphRouteInput,
): boolean {
  return (
    isDaemonCodeGraphPlatformEligible(input.platform) &&
    input.context?.localWindow === true &&
    !input.daemonLatched
  );
}

function isDaemonCodeGraphPlatformEligible(
  platform: PlatformOperatingSystem | null,
): boolean {
  return platform !== null && DAEMON_CODE_GRAPH_PLATFORMS[platform] === true;
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
    context,
    daemonLatched: getElectronDaemonHealth().isLatched(),
  });
}

/**
 * Whether a build Electron main starts on its own, for the agent build tool
 * or the automatic scheduler, goes to the daemon (CAN-5625). Reads only
 * local state. A build the Code Graph flag or the workspace preference
 * refuses stays in process, where it gets the in-process refusal. Plan-explore
 * and code-review chats build under a placeholder workspace that borrows a
 * worktree through Electron main's registries, which the daemon cannot
 * resolve, so they stay in process too.
 */
export function selectDaemonCodeGraphForMain(workspaceId: string): boolean {
  return (
    isDaemonCodeGraphPlatformEligible(hostPlatform()) &&
    !getElectronDaemonHealth().isLatched() &&
    workspaceId !== PLAN_EXPLORE_CHAT_PROJECT_ID &&
    workspaceId !== CODE_REVIEW_CHAT_PROJECT_ID &&
    isCodeGraphAvailableForWorkspace(workspaceId)
  );
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

/**
 * A worktree build in the daemon, keyed so a resent request joins it. Its
 * generation report, on the answer or the refusal, is recorded here as
 * Electron main records its own generations (CAN-5627).
 */
export async function buildCodeGraphInDaemon(
  graphScope: Extract<
    WorkerCodeGraphBuildParams['graphScope'],
    { kind: 'worktree' }
  >,
): Promise<WorkerCodeGraphBuildResult> {
  built.add(worktreeKey(graphScope.workspaceId, graphScope.worktreeId));
  const record = (report: WorkerCodeGraphGenerationReport | null): void => {
    if (report)
      recordCodeGraphGenerationReport({
        projectId: graphScope.workspaceId,
        worktreeId: graphScope.worktreeId,
        report,
      });
  };
  let result: WorkerCodeGraphBuildResult;
  try {
    result = await (
      await client()
    ).instruction(
      'worker.codeGraph.build',
      { graphScope },
      { metadata: { idempotencyKey: randomUUID() } },
    );
  } catch (error) {
    record(
      error instanceof CanopyClientError
        ? codeGraphGenerationReportOf(error.payload.details)
        : null,
    );
    throw error;
  }
  if (result.kind === 'worktree') record(result.generation ?? null);
  return result;
}

/**
 * Worktree cleanup: ends the worktree's graph work in the daemon, queued,
 * running, still preparing or draining derived analysis, and waits until
 * every build host has exited, so none can recreate the graph the cleanup
 * removes. Supported hosts ask even after restart, without a remembered build,
 * renderer event, health gate or current graph preference. Other hosts ask
 * only for remembered daemon work. If the daemon refuses or cannot be reached,
 * cleanup warns and continues so the worktree can still be deleted.
 */
export async function drainDaemonCodeGraphWorktree(
  workspaceId: string,
  worktreeId: string,
): Promise<void> {
  const key = worktreeKey(workspaceId, worktreeId);
  if (!built.has(key) && !isDaemonCodeGraphPlatformEligible(hostPlatform()))
    return;
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
 * The reads it took, on the answer or the refusal, are recorded here as
 * Electron main records its own reads (CAN-5691); callers get the answer
 * an in-process read gives.
 */
export async function queryCodeGraphInDaemon(
  params: WorkerCodeGraphQueryParams,
): Promise<WorkerCodeGraphQueryResult> {
  const key =
    'kind' in params.scope
      ? `${params.scope.workspaceId}/`
      : worktreeKey(params.scope.workspaceId, params.scope.worktreeId);
  const session = await client();
  let result: WorkerCodeGraphQueryResult;
  try {
    result = await session.query('worker.codeGraph.query', params);
  } catch (error) {
    const report =
      error instanceof CanopyClientError
        ? codeGraphReadReportOf(error.payload.details)
        : null;
    if (report) recordCodeGraphReadReport(report, key, codeGraphReadRecorders);
    throw session.signal.aborted && !owner.signal.aborted
      ? markUnreachable(error, 'connection_lost')
      : error;
  }
  const { read, ...answer } = result;
  if (read) recordCodeGraphReadReport(read, key, codeGraphReadRecorders);
  return answer;
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
