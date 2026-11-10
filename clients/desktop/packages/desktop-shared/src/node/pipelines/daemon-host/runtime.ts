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
  PipelineHostActions,
  PipelineStepNotification,
  ResolvePipelineTargetRequest,
  ResolvePipelineTargetResult,
} from '../executor/types';
import type { CodexRuntimeService } from '../../codex-runtime';
import { runCodexPipelinePromptWith } from '../codex-pipeline-prompt';
import type { DaemonPipelineOwnerPorts } from './owner-ports';

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
  /** Owner-bound launches only (CAN-5771). */
  readonly pipelineHostActions?: PipelineHostActions;
  /** An owner-bound launch's model ports (CAN-5095): its core answers each call. */
  readonly owner?: DaemonPipelineOwnerPorts;
  /** The host's own Codex runtime, for an owner-bound launch's Codex steps. */
  readonly codexRuntime?: () => CodexRuntimeService;
  /** Hands a step's desktop notifications to Electron main (CAN-5868). */
  readonly onStepNotifications?: (
    stepId: string,
    notifications: readonly PipelineStepNotification[],
  ) => void;
}

function noCodexRuntime(): CodexRuntimeService {
  throw new Error('The background service has no Codex runtime.');
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
 * A step's desktop notifications go to Electron main, which shows them
 * (CAN-5868).
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
    ...(options.pipelineHostActions && {
      pipelineHostActions: options.pipelineHostActions,
    }),
    ...(options.onStepNotifications && {
      onStepPostProcess: notificationForwarder(options.onStepNotifications),
    }),
    resolvePipelineTarget: (request) =>
      resolveVerifiedWorktree(options.worktree, request),
    // Every model is refused unless the launch's core answers for it (D7).
    isModelBlockedByOrgPolicy: () => Promise.resolve(true),
    isOrgModelPolicyActive: () => Promise.resolve(true),
    ...(options.owner && ownerModelPorts(options.owner, options.codexRuntime)),
  };
}

function notificationForwarder(
  forward: NonNullable<DaemonPipelineRuntimeOptions['onStepNotifications']>,
): NonNullable<ExecutionRuntime['onStepPostProcess']> {
  return (ctx) => {
    if (ctx.notifications?.length) forward(ctx.step.id, ctx.notifications);
  };
}

/**
 * The model ports of an owner-bound launch (CAN-5095 D2): Claude steps run
 * their action subprocess, Codex steps the shared runner on the host's own
 * runtime; Agent model aliases resolve through the owner (CAN-5832).
 * Terminal workers, Cursor, Copilot, OpenCode and plugin collections stay
 * absent, so such a step fails closed.
 */
function ownerModelPorts(
  owner: DaemonPipelineOwnerPorts,
  codexRuntime: (() => CodexRuntimeService) | undefined,
): Partial<ExecutionRuntime> {
  const { codex, ...ports } = owner;
  return {
    ...ports,
    codexPromptRunner: {
      runCodexPrompt: (request) =>
        runCodexPipelinePromptWith(request, {
          ...codex,
          runtime: codexRuntime ?? noCodexRuntime,
        }),
    },
  };
}
