import { randomUUID } from 'node:crypto';
import {
  codeGraphBuildCanceledError,
  codeGraphBuildFailedError,
} from '@canopy/core-runtime/node/code-graph';
import {
  WORKER_CODE_GRAPH_GRANTS,
  type CanopyCallerDescriptor,
  type WorkerCodeGraphBuildResult,
} from '@canopy/protocol/canopy-core';
import {
  getActiveDesktopRuntimeIfAccepting,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { withDaemonCodeGraphRoute } from './daemon-code-graph-route-context';
import {
  noteDaemonCodeGraphBuildExcluded,
  noteDaemonCodeGraphBuildSettled,
  selectDaemonCodeGraphForMainExclusion,
} from './daemon-code-graph-route';

/*
 * Electron main's client of `worker.codeGraph.build` for the agent build
 * tool (CAN-5616) and the workspace summary's base repair (CAN-5621).
 * `BuildOrUpdateCodeGraph`, and through it the Orchestrator action and the
 * MCP, Codex and delegation tool surfaces, builds through the operation on
 * the desktop dispatcher instead of calling the build service. Refusals come
 * back as the operation's typed `CanopyOperationError`s. On eligible hosts
 * the agent build takes the daemon route (CAN-5625).
 */

const CODE_GRAPH_BUILDS_CALLER: CanopyCallerDescriptor = {
  principalId: 'desktop-code-graph-builds',
  clientInstanceId: 'desktop-main',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [WORKER_CODE_GRAPH_GRANTS.write],
};

export type CodeGraphBuildDispatcher = Pick<
  DesktopCanopyDispatcher,
  'instruction'
>;

/** Wraps the build dispatcher for one call; agent tools pass their granted table (CAN-5825). */
export type CodeGraphBuildVia = (
  dispatcher: CodeGraphBuildDispatcher,
) => CodeGraphBuildDispatcher;

let dispatcherForTests: CodeGraphBuildDispatcher | null = null;

/** Test seam: route builds through a dispatcher built over the real adapter. */
export function setCodeGraphBuildDispatcherForTests(
  dispatcher: CodeGraphBuildDispatcher | null,
): void {
  dispatcherForTests = dispatcher;
}

export type WorktreeCodeGraphBuild = Extract<
  WorkerCodeGraphBuildResult,
  { kind: 'worktree' }
>;

/**
 * Builds one worktree's graph for an agent through `worker.codeGraph.build`,
 * verifying content whose fingerprint matched, and resolves when the build
 * settles. Each call is one keyed request.
 */
export async function buildWorktreeCodeGraphForAgent(
  scope: {
    projectId: string;
    worktreeId: string;
  },
  options: { via?: CodeGraphBuildVia } = {},
): Promise<WorktreeCodeGraphBuild> {
  const active = dispatcherForTests ?? getActiveDesktopRuntimeIfAccepting();
  // No runtime means the app is starting or quitting: the build is canceled.
  if (active === null) throw codeGraphBuildCanceledError();
  const dispatcher = options.via === undefined ? active : options.via(active);
  const exclusion = selectDaemonCodeGraphForMainExclusion(scope.projectId);
  if (exclusion !== null) noteDaemonCodeGraphBuildExcluded(exclusion);
  const { value: result } = await withDaemonCodeGraphRoute(
    exclusion === null,
    () =>
      dispatcher.instruction(
        'worker.codeGraph.build',
        {
          graphScope: {
            kind: 'worktree',
            workspaceId: scope.projectId,
            worktreeId: scope.worktreeId,
            mode: 'verified',
            requestedBy: 'agent',
          },
        },
        {
          caller: CODE_GRAPH_BUILDS_CALLER,
          metadata: { idempotencyKey: randomUUID() },
        },
      ),
    noteDaemonCodeGraphBuildSettled,
  );
  if (result.kind !== 'worktree')
    throw codeGraphBuildFailedError('malformed_response');
  return result;
}

/**
 * Asks the worker to repair one repository's published workspace base whose
 * summary is pending, in the `maintenance` class, and resolves when the
 * repair settles. A repair already running for it is joined.
 */
export async function repairWorkspaceBaseCodeGraphSummary(scope: {
  workspaceId: string;
  repoId: string;
}): Promise<void> {
  const dispatcher = dispatcherForTests ?? getActiveDesktopRuntimeIfAccepting();
  if (dispatcher === null) return;
  await dispatcher.instruction(
    'worker.codeGraph.build',
    {
      graphScope: {
        kind: 'workspace_base',
        workspaceId: scope.workspaceId,
        background: { trigger: 'summary-repair', repoId: scope.repoId },
      },
    },
    {
      caller: CODE_GRAPH_BUILDS_CALLER,
      metadata: { idempotencyKey: randomUUID() },
    },
  );
}
