import { getCodeGraphWorktreeService } from '@canopy/desktop-shared/node/code-graph/service';
import {
  getWorktreeCodeGraphDbPath,
  getWorktreeCodeGraphDir,
} from '@canopy/desktop-shared/node/code-graph/worktree-paths';
import { getBundledCodeGraphDir } from '@canopy/desktop-shared/pipelines/config-paths';
import type { CodeGraphBuildOptions } from '@canopy/desktop-shared/types/code-graph';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import {
  createCodeGraphWorktreeBuildService,
  type CodeGraphWorktreeBuildFailureCause,
} from '@canopy/code-graph/host/worktree-build-service';
import type { CodeGraphWorkerBuildResponse } from '../code-graph/build-runner';
import { beginCodeGraphWorkerBuild } from '../code-graph/build-runner';
import { runCodeGraphWorkerFingerprint } from '../code-graph/fingerprint-runner';
import {
  CodeGraphReadFailureError,
  codeGraphReadFailure,
} from '../code-graph/read-runner';
import { copyCompatibleCodeGraphBaseForSeed } from './code-graph-base-store';
import type { CodeGraphBuildReason } from './code-graph-scheduler';
import {
  clearCodeGraphWorktreeFingerprintCache,
  readCodeGraphWorktreeCompletion,
} from './code-graph-worktree-fingerprint';
import {
  codeGraphGenerationFailureReason,
  completeCodeGraphGenerationTelemetry,
  failCodeGraphGenerationTelemetry,
  startCodeGraphGenerationTelemetry,
  type CodeGraphGenerationFailureReason,
} from './code-graph-telemetry';
import {
  CODE_GRAPH_UNAVAILABLE_MESSAGE,
  isCodeGraphAvailableForWorkspace,
} from './code-graph-availability';
import {
  clearCodeGraphFirstRequest,
  codeGraphBuildResultDetail,
  codeGraphFirstRequestedAt,
  noteCodeGraphFirstRequest,
  recordCodeGraphBuildDiagnostic,
} from './code-graph-build-diagnostics';
import type { CodeGraphBuildDiagnosticFailureReason } from '../observability/service';
import { resolveWorktreeCwd } from './resolve-worktree';
import { readWorkspaceIndexEntry } from './sidebar-items';
import { readWorkspaceConfig } from './workspace-persistence';
import { resolveWorktreeCodeGraphRepositories } from './worktree-repo-entries';

// Worktree graph generation lives in `@canopy/code-graph/host`. This module
// composes it for Electron main: desktop paths and availability, seeds from
// the published base graphs, the desktop schedulers, and Datadog telemetry
// with local build diagnostics.

export { worktreeQueuePriority } from '@canopy/code-graph/host/worktree-build-service';

function canonicalSourceByRepoId(
  config: Awaited<ReturnType<typeof readWorkspaceConfig>>,
): Map<string, string> {
  const result = new Map<string, string>();
  if (config.type === 'single-repo' && config.repoPath) {
    result.set(WORKSPACE_ROOT_REPO_ID, config.repoPath);
  }
  if (config.type === 'multi-repo') {
    if (config.sourceRepoPath) {
      result.set(WORKSPACE_ROOT_REPO_ID, config.sourceRepoPath);
    }
    for (const repository of config.repos) {
      result.set(repository.id, repository.repoPath);
    }
  }
  return result;
}

function failureReasons(cause: CodeGraphWorktreeBuildFailureCause): {
  generation: CodeGraphGenerationFailureReason;
  diagnostic: CodeGraphBuildDiagnosticFailureReason;
} {
  if (cause.kind !== 'error')
    return { generation: cause.kind, diagnostic: cause.kind };
  const { error } = cause;
  const generation = codeGraphGenerationFailureReason(error);
  return {
    generation,
    diagnostic:
      error instanceof CodeGraphReadFailureError
        ? codeGraphReadFailure(error)
        : generation,
  };
}

const service = createCodeGraphWorktreeBuildService({
  isAvailable: (workspaceId) => isCodeGraphAvailableForWorkspace(workspaceId),
  unavailableMessage: CODE_GRAPH_UNAVAILABLE_MESSAGE,
  worktreeGraphDir: (workspaceId, worktreeId) =>
    getWorktreeCodeGraphDir(workspaceId, worktreeId),
  worktreeDbPath: (workspaceId, worktreeId) =>
    getWorktreeCodeGraphDbPath(workspaceId, worktreeId),
  resourcesDir: () => getBundledCodeGraphDir(),
  worktreeRoot: (workspaceId, worktreeId) =>
    resolveWorktreeCwd(workspaceId, worktreeId),
  repositories: (workspaceId, _worktreeId, worktreeRootPath) =>
    resolveWorktreeCodeGraphRepositories(workspaceId, worktreeRootPath),
  workspaceLabel: async (workspaceId) =>
    (await readWorkspaceIndexEntry(workspaceId))?.name ?? null,
  seeds: {
    canonicalSources: async (workspaceId) =>
      canonicalSourceByRepoId(await readWorkspaceConfig(workspaceId)),
    copy: (input) => copyCompatibleCodeGraphBaseForSeed(input),
  },
  beginBuild: (key, request, scheduling) =>
    beginCodeGraphWorkerBuild(key, request, scheduling),
  fingerprint: (key, repositories, options) =>
    runCodeGraphWorkerFingerprint(key, repositories, options),
  readCompletion: (dbPath, key) => readCodeGraphWorktreeCompletion(dbPath, key),
  clearFingerprintCache: (dbPath) =>
    clearCodeGraphWorktreeFingerprintCache(dbPath),
  withWorktreeClosed: (workspaceId, worktreeId, operation) =>
    getCodeGraphWorktreeService().withWorktreeClosed(
      workspaceId,
      worktreeId,
      operation,
    ),
  scheduleFollowup: (projectId, worktreeId) => {
    // Keep this dynamic to break the scheduler -> build-service circular
    // dependency while still coalescing an edit-during-build follow-up.
    void import('./code-graph-scheduler')
      .then(({ scheduleCodeGraphFollowupBuild }) =>
        scheduleCodeGraphFollowupBuild({ projectId, worktreeId }),
      )
      .catch(() => undefined);
  },
  firstRequests: {
    note: (key, requestedAt) => noteCodeGraphFirstRequest(key, requestedAt),
    clear: (key) => clearCodeGraphFirstRequest(key),
    at: (key) => codeGraphFirstRequestedAt(key),
  },
  observe: ({ projectId, worktreeId, trigger }) => {
    const telemetry = startCodeGraphGenerationTelemetry({
      operationSeed: `${projectId}/${worktreeId}`,
      scope: 'worktree',
      trigger,
    });
    return {
      setRepositoryCount: (count): void => {
        telemetry.context.repository_count = count;
      },
      succeeded: (input): void => {
        completeCodeGraphGenerationTelemetry(telemetry, {
          result: input.response.result,
          fusionDurationMs: input.response.fusionDurationMs ?? 0,
          seededRepositoryCount: input.seededRepositoryCount,
          coldFallbackRepositoryCount: input.coldFallbackRepositoryCount,
          reusedRepositoryCount: input.reusedRepositoryCount,
          preparationFailed: input.preparationFailed,
        });
        recordCodeGraphBuildDiagnostic({
          projectId,
          worktreeId,
          detail: {
            scope: 'worktree',
            trigger,
            outcome: 'success',
            ...(input.attemptId === undefined
              ? {}
              : { attemptId: input.attemptId }),
            ...(input.queuePriority === undefined
              ? {}
              : { queuePriority: input.queuePriority }),
            totalMs: input.totalMs,
            ...codeGraphBuildResultDetail(input.response.result),
            ...(input.endFingerprintMs === undefined
              ? {}
              : { endFingerprintMs: input.endFingerprintMs }),
            ...(input.fingerprintPersistMs === undefined
              ? {}
              : { fingerprintPersistMs: input.fingerprintPersistMs }),
            fingerprintPersistOutcome: input.fingerprintPersistOutcome,
          },
        });
      },
      failed: (input): void => {
        const reasons = failureReasons(input.cause);
        failCodeGraphGenerationTelemetry(telemetry, {
          stage: input.stage,
          reason: reasons.generation,
        });
        // Local build diagnostic, alongside the Datadog lifecycle above.
        const deferred =
          reasons.diagnostic === 'busy' && input.attemptId === undefined;
        recordCodeGraphBuildDiagnostic({
          projectId,
          worktreeId,
          detail: {
            scope: 'worktree',
            trigger,
            outcome: deferred ? 'deferred' : 'failure',
            failureStage: input.stage,
            failureReason: reasons.diagnostic,
            ...(input.attemptId === undefined
              ? {}
              : { attemptId: input.attemptId }),
            ...(input.queuePriority === undefined
              ? {}
              : { queuePriority: input.queuePriority }),
            totalMs: input.totalMs,
          },
        });
      },
    };
  },
});

export function runWorktreeCodeGraphBuild(input: {
  projectId: string;
  worktreeId: string;
  reason: CodeGraphBuildReason | 'tool-request' | 'manual';
  options?: CodeGraphBuildOptions;
  /** Fingerprint already observed by the automatic scheduler immediately before this build. */
  observedFingerprint?: string;
  /** How long the scheduler's fingerprint read took, when it supplied one. */
  observedFingerprintMs?: number;
  /** Cancels the generation while it prepares, before its build queues. */
  signal?: AbortSignal;
  /** Called once the generation's build is in the queue. */
  onQueued?: () => void;
}): Promise<CodeGraphWorkerBuildResponse> {
  return service.run(input);
}
