import * as os from 'node:os';
import * as path from 'node:path';
import {
  getProjectActionsDir,
  getProjectActionsDirCandidates,
  getProjectPipelinesDir,
  getProjectPipelinesDirCandidates,
} from '../config-paths';
import type {
  ExecutionResourceMonitor,
  ExecutionRuntime,
  ResolvePipelineTargetRequest,
  ResolvePipelineTargetResult,
} from '../executor/types';

/** The worktree a launch runs in, as the daemon verified it (CAN-5086 D17). */
export interface DaemonPipelineWorktree {
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly path: string;
}

export interface DaemonPipelineRuntimeOptions {
  readonly executionsDir: string;
  readonly bundledActionsDir: string;
  readonly processEnvironment: Readonly<Record<string, string>>;
  readonly nodeProcess?: ExecutionRuntime['nodeProcess'];
  readonly resourceMonitor?: ExecutionResourceMonitor;
  /** The only worktree target this runtime resolves; none for a lookup runtime. */
  readonly worktree?: DaemonPipelineWorktree;
}

function resolveVerifiedWorktree(
  worktree: DaemonPipelineWorktree | undefined,
  request: ResolvePipelineTargetRequest,
): Promise<ResolvePipelineTargetResult> {
  const requested = request.requested;
  if (
    !worktree ||
    requested.scope !== 'worktree' ||
    requested.workspace_id !== worktree.workspaceId ||
    requested.worktree.id !== worktree.worktreeId
  )
    return Promise.reject(
      new Error('The background workflow service runs only its own worktree.'),
    );
  return Promise.resolve({
    cwd: worktree.path,
    scope: 'worktree',
    target: {
      scope: 'worktree',
      workspace_id: worktree.workspaceId,
      worktree_id: worktree.worktreeId,
      path: worktree.path,
      created: false,
    },
    projectId: worktree.workspaceId,
    worktreeId: worktree.worktreeId,
    repoPath: worktree.path,
  });
}

/**
 * The executor runtime a daemon pipeline host runs one launch with (CAN-5086).
 * It has no prompt runner, ledger, lifecycle, plan persistence, host actions
 * or AI-credit route, so a model or host step that slipped past the
 * classifier fails closed; it resolves only the launch's verified worktree.
 */
export function createDaemonPipelineRuntime(
  options: DaemonPipelineRuntimeOptions,
): ExecutionRuntime {
  return {
    bundledActionsDir: options.bundledActionsDir,
    executionsDir: options.executionsDir,
    tempRootDir: path.join(os.tmpdir(), 'canopy-exec'),
    getProjectActionsDir,
    getProjectActionsDirCandidates,
    getProjectPipelinesDir,
    getProjectPipelinesDirCandidates,
    processEnvironment: options.processEnvironment,
    ...(options.nodeProcess && { nodeProcess: options.nodeProcess }),
    ...(options.resourceMonitor && {
      resourceMonitor: options.resourceMonitor,
    }),
    resolvePipelineTarget: (request) =>
      resolveVerifiedWorktree(options.worktree, request),
    // Every model is refused: daemon runs carry no model steps (D7).
    isModelBlockedByOrgPolicy: () => Promise.resolve(true),
    isOrgModelPolicyActive: () => Promise.resolve(true),
  };
}
