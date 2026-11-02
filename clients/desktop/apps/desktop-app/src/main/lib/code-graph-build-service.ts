import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fingerprintCustomLanguageInputs } from '@canopy/code-graph/languages/custom-config';
import { getCodeGraphWorktreeService } from '@canopy/desktop-shared/node/code-graph/service';
import {
  getWorktreeCodeGraphDbPath,
  getWorktreeCodeGraphDir,
} from '@canopy/desktop-shared/node/code-graph/worktree-paths';
import { getBundledCodeGraphDir } from '@canopy/desktop-shared/pipelines/config-paths';
import type {
  CodeGraphBuildOptions,
  CodeGraphBuildPrelude,
  CodeGraphRepositoryInput,
} from '@canopy/desktop-shared/types/code-graph';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import type { CodeGraphSeedSource } from '@canopy/code-graph/base-graph';
import type {
  CodeGraphBuildSchedulingOptions,
  CodeGraphWorkerBuildRequest,
  CodeGraphWorkerBuildResponse,
} from '../code-graph/build-runner';
import { beginCodeGraphWorkerBuild } from '../code-graph/build-runner';
import { runCodeGraphWorkerFingerprint } from '../code-graph/fingerprint-runner';
import {
  CodeGraphReadFailureError,
  codeGraphReadFailure,
} from '../code-graph/read-runner';
import { copyCompatibleCodeGraphBaseForSeed } from './code-graph-base-store';
import type { CodeGraphBuildReason } from './code-graph-scheduler';
import {
  persistStableCodeGraphWorktreeFingerprint,
  readCodeGraphWorktreeCompletion,
} from './code-graph-worktree-fingerprint';
import {
  codeGraphGenerationFailureReason,
  completeCodeGraphGenerationTelemetry,
  failCodeGraphGenerationTelemetry,
  startCodeGraphGenerationTelemetry,
  type CodeGraphGenerationFailureReason,
  type CodeGraphGenerationFailureStage,
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

function roundMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.round(Math.max(0, value) * 10) / 10, 86_400_000);
}

async function runAdmittedWorktreeBuild(input: {
  key: string;
  request: CodeGraphWorkerBuildRequest;
  scheduling: CodeGraphBuildSchedulingOptions;
  onAttemptId: (attemptId: string | null) => void;
}): Promise<CodeGraphWorkerBuildResponse> {
  const handle = beginCodeGraphWorkerBuild(
    input.key,
    input.request,
    input.scheduling,
  );
  // The runner returns the stable id of its coalesced BuildRecord. Never
  // invent a caller id: two callers coalesced onto one record must agree.
  input.onAttemptId(handle.attemptId);
  try {
    return await handle.promise;
  } finally {
    input.onAttemptId(handle.attemptId);
  }
}

function diagnosticFailureReason(
  error: unknown,
): CodeGraphBuildDiagnosticFailureReason {
  if (error instanceof CodeGraphReadFailureError) {
    return codeGraphReadFailure(error);
  }
  const reason: CodeGraphGenerationFailureReason =
    codeGraphGenerationFailureReason(error);
  return reason;
}

async function fingerprintWorktreeOffMain(
  key: string,
  repositories: readonly CodeGraphRepositoryInput[],
  background: boolean,
): Promise<string> {
  const response = await runCodeGraphWorkerFingerprint(key, repositories, {
    background,
  });
  if (!response.ok) {
    throw new Error(response.message);
  }
  return response.fingerprint;
}

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

/**
 * Seed staging directories owned by builds that are still preparing or
 * running. Copies left behind by a quit or crash mid-build (each 1–1.6 GB)
 * are removed before the next preparation for that worktree.
 */
const activeSeedStagingDirs = new Set<string>();

async function removeAbandonedSeedStaging(
  seedStagingRoot: string,
): Promise<void> {
  const entries = await readdir(seedStagingRoot, { withFileTypes: true }).catch(
    () => [],
  );
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(seedStagingRoot, entry.name))
      .filter((directory) => !activeSeedStagingDirs.has(directory))
      .map((directory) =>
        rm(directory, { recursive: true, force: true }).catch(() => undefined),
      ),
  );
}

async function runColdFallback(input: {
  projectId: string;
  worktreeId: string;
  worktreePath: string;
  repositories: CodeGraphRepositoryInput[];
  options?: CodeGraphBuildOptions;
  reason: string;
  workspaceLabel: string;
  priority: 'agent' | 'worktree';
  timings: CodeGraphBuildPrelude;
  onQueuePriority: (priority: CodeGraphWorktreeQueuePriority) => void;
  onAttemptId: (attemptId: string | null) => void;
}): Promise<CodeGraphWorkerBuildResponse> {
  if (!isCodeGraphAvailableForWorkspace(input.projectId)) {
    return { ok: false, message: CODE_GRAPH_UNAVAILABLE_MESSAGE };
  }
  const existingGraph = await readCodeGraphWorktreeCompletion(
    getWorktreeCodeGraphDbPath(input.projectId, input.worktreeId),
    `${input.projectId}/${input.worktreeId}`,
  );
  const queuePriority = worktreeQueuePriority(input.priority, existingGraph);
  input.onQueuePriority(queuePriority);
  const response = await runAdmittedWorktreeBuild({
    key: `${input.projectId}/${input.worktreeId}`,
    request: {
      dbPath: getWorktreeCodeGraphDbPath(input.projectId, input.worktreeId),
      worktreeRootPath: input.worktreePath,
      resourcesDir: getBundledCodeGraphDir(),
      repositories: input.repositories,
      options: input.options ?? {},
      // Answer at publication; derived analysis follows in the worker.
      deferDerived: true,
      timings: existingGraph
        ? withoutFirstGraphRequest(input.timings)
        : input.timings,
    },
    scheduling: {
      priority: queuePriority,
      metadata: {
        scope: 'worktree',
        workspaceIds: [input.projectId],
        workspaceLabel: input.workspaceLabel,
        worktreeId: input.worktreeId,
        label: input.worktreeId,
        trigger: 'seed-preparation-fallback',
      },
    },
    onAttemptId: input.onAttemptId,
  });
  if (response.ok) {
    response.seedOutcomes = input.repositories.map((repository) =>
      existingGraph
        ? {
            repoId: repository.repoId,
            status: 'existing-graph-reused' as const,
          }
        : {
            repoId: repository.repoId,
            status: 'cold-fallback' as const,
            reason: input.reason,
          },
    );
  }
  return response;
}

type CodeGraphWorktreeQueuePriority = 'agent' | 'first-build' | 'worktree';

/**
 * The build queue class for a worktree build: agent requests keep `agent`;
 * an automatic build for a worktree with no completed graph is a first build.
 */
export function worktreeQueuePriority(
  requested: 'agent' | 'worktree',
  graphCompleted: boolean,
): CodeGraphWorktreeQueuePriority {
  if (requested === 'agent') return 'agent';
  return graphCompleted ? 'worktree' : 'first-build';
}

/** An existing graph is not a first graph: drop its request time. */
function withoutFirstGraphRequest(
  timings: CodeGraphBuildPrelude,
): CodeGraphBuildPrelude {
  const kept: CodeGraphBuildPrelude = { ...timings };
  delete kept.firstGraphRequestedAt;
  return kept;
}

export async function runWorktreeCodeGraphBuild(input: {
  projectId: string;
  worktreeId: string;
  reason: CodeGraphBuildReason | 'tool-request' | 'manual';
  options?: CodeGraphBuildOptions;
  /** Fingerprint already observed by the automatic scheduler immediately before this build. */
  observedFingerprint?: string;
  /** How long the scheduler's fingerprint read took, when it supplied one. */
  observedFingerprintMs?: number;
}): Promise<CodeGraphWorkerBuildResponse> {
  if (!isCodeGraphAvailableForWorkspace(input.projectId)) {
    return { ok: false, message: CODE_GRAPH_UNAVAILABLE_MESSAGE };
  }
  const telemetry = startCodeGraphGenerationTelemetry({
    operationSeed: `${input.projectId}/${input.worktreeId}`,
    scope: 'worktree',
    trigger: input.reason,
  });
  const requestedAt = Date.now();
  const flowStartedAt = performance.now();
  let seedStagingDir: string | undefined;
  let workerStarted = false;
  let preparationFailed = false;
  let failureStage: CodeGraphGenerationFailureStage = 'preflight';
  // The queue class the worker build was enqueued with, once known.
  let queuePriority: CodeGraphWorktreeQueuePriority | undefined;
  let attemptId: string | undefined;
  // Local build diagnostic, alongside the Datadog lifecycle above.
  const recordFailure = (
    failureReason?: CodeGraphBuildDiagnosticFailureReason,
  ): void => {
    const deferred = failureReason === 'busy' && attemptId === undefined;
    recordCodeGraphBuildDiagnostic({
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      detail: {
        scope: 'worktree',
        trigger: input.reason,
        outcome: deferred ? 'deferred' : 'failure',
        failureStage,
        ...(failureReason === undefined ? {} : { failureReason }),
        ...(attemptId === undefined ? {} : { attemptId }),
        ...(queuePriority === undefined ? {} : { queuePriority }),
        totalMs: roundMs(performance.now() - flowStartedAt),
      },
    });
  };
  const unavailableResponse = (): CodeGraphWorkerBuildResponse => {
    failCodeGraphGenerationTelemetry(telemetry, {
      stage: failureStage,
      reason: 'unavailable',
    });
    recordFailure('unavailable');
    return { ok: false, message: CODE_GRAPH_UNAVAILABLE_MESSAGE };
  };

  try {
    const buildKey = `${input.projectId}/${input.worktreeId}`;
    const worktreePath = resolveWorktreeCwd(input.projectId, input.worktreeId);
    const repositories = await resolveWorktreeCodeGraphRepositories(
      input.projectId,
      worktreePath,
    );
    telemetry.context.repository_count = repositories.length;
    const workspaceLabel =
      (
        await readWorkspaceIndexEntry(input.projectId).catch(() => null)
      )?.name.trim() || input.projectId;
    if (!isCodeGraphAvailableForWorkspace(input.projectId)) {
      return unavailableResponse();
    }
    const workerPriority =
      input.reason === 'tool-request' || input.reason === 'manual'
        ? 'agent'
        : 'worktree';
    const backgroundFingerprint = workerPriority !== 'agent';
    const fingerprintStartedAt = performance.now();
    const startFingerprint =
      input.observedFingerprint ??
      (await fingerprintWorktreeOffMain(
        buildKey,
        repositories,
        backgroundFingerprint,
      ));
    const fingerprintMs =
      input.observedFingerprint === undefined
        ? performance.now() - fingerprintStartedAt
        : input.observedFingerprintMs;
    let seedCopyMs = 0;
    const preludeTimings = (graphCompleted: boolean): CodeGraphBuildPrelude => {
      // Time to first graph runs from the earliest request for a graph this
      // worktree has never completed.
      if (graphCompleted) clearCodeGraphFirstRequest(buildKey);
      else noteCodeGraphFirstRequest(buildKey, requestedAt);
      const firstGraphRequestedAt = graphCompleted
        ? undefined
        : codeGraphFirstRequestedAt(buildKey);
      return {
        ...(fingerprintMs === undefined
          ? {}
          : { fingerprintMs: roundMs(fingerprintMs) }),
        seedCopyMs: roundMs(seedCopyMs),
        ...(firstGraphRequestedAt === undefined
          ? {}
          : { firstGraphRequestedAt }),
      };
    };
    const seedStagingRoot = path.join(
      getWorktreeCodeGraphDir(input.projectId, input.worktreeId),
      'seed-staging',
    );
    await removeAbandonedSeedStaging(seedStagingRoot);
    const preparedSeedStagingDir = path.join(seedStagingRoot, randomUUID());
    seedStagingDir = preparedSeedStagingDir;
    activeSeedStagingDirs.add(preparedSeedStagingDir);
    await mkdir(preparedSeedStagingDir, { recursive: true });
    failureStage = 'seed-preparation';

    let response: CodeGraphWorkerBuildResponse;
    try {
      const customLanguagesFingerprint =
        await fingerprintCustomLanguageInputs(worktreePath);
      const config = await readWorkspaceConfig(input.projectId);
      const sourceByRepoId = canonicalSourceByRepoId(config);
      const seedSources: CodeGraphSeedSource[] = [];
      const coldFallbacks: Array<{ repoId: string; reason: string }> = [];
      failureStage = 'preflight';
      const graphAlreadyCompleted = await readCodeGraphWorktreeCompletion(
        getWorktreeCodeGraphDbPath(input.projectId, input.worktreeId),
        buildKey,
      );
      failureStage = 'seed-preparation';
      for (const repository of graphAlreadyCompleted ? [] : repositories) {
        if (!isCodeGraphAvailableForWorkspace(input.projectId)) {
          return unavailableResponse();
        }
        const canonicalRepoPath = sourceByRepoId.get(repository.repoId);
        if (canonicalRepoPath === undefined) {
          coldFallbacks.push({
            repoId: repository.repoId,
            reason: 'no canonical source repository',
          });
          continue;
        }
        const copyStartedAt = performance.now();
        try {
          const source = await copyCompatibleCodeGraphBaseForSeed({
            canonicalRepoPath,
            repoId: repository.repoId,
            customLanguagesFingerprint: customLanguagesFingerprint.value,
            destinationRootPath: repository.rootPath,
            seedStagingDir: preparedSeedStagingDir,
          });
          seedCopyMs += performance.now() - copyStartedAt;
          if (source === null) {
            coldFallbacks.push({
              repoId: repository.repoId,
              reason: 'no compatible published base',
            });
          } else {
            seedSources.push(source);
          }
        } catch (error) {
          seedCopyMs += performance.now() - copyStartedAt;
          coldFallbacks.push({
            repoId: repository.repoId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const timings = preludeTimings(graphAlreadyCompleted);
      workerStarted = true;
      failureStage = 'worker-build';
      queuePriority = worktreeQueuePriority(
        workerPriority,
        graphAlreadyCompleted,
      );
      const preparedQueuePriority = queuePriority;
      const runPreparedBuild = (): Promise<CodeGraphWorkerBuildResponse> =>
        isCodeGraphAvailableForWorkspace(input.projectId)
          ? runAdmittedWorktreeBuild({
              key: `${input.projectId}/${input.worktreeId}`,
              request: {
                dbPath: getWorktreeCodeGraphDbPath(
                  input.projectId,
                  input.worktreeId,
                ),
                worktreeRootPath: worktreePath,
                resourcesDir: getBundledCodeGraphDir(),
                repositories,
                options: input.options ?? {},
                // Answer at publication; derived analysis follows in the
                // worker (see build-runner.ts, the drain).
                deferDerived: true,
                preparation: {
                  seedSources,
                  coldFallbacks,
                  customLanguagesFingerprint: customLanguagesFingerprint.value,
                  seedStagingDir: preparedSeedStagingDir,
                },
                timings,
              },
              scheduling: {
                priority: preparedQueuePriority,
                metadata: {
                  scope: 'worktree',
                  workspaceIds: [input.projectId],
                  workspaceLabel,
                  worktreeId: input.worktreeId,
                  label: input.worktreeId,
                  trigger: input.reason,
                },
              },
              onAttemptId: (id) => {
                attemptId = id ?? undefined;
              },
            })
          : Promise.resolve({
              ok: false,
              message: CODE_GRAPH_UNAVAILABLE_MESSAGE,
            });
      response = graphAlreadyCompleted
        ? await runPreparedBuild()
        : await getCodeGraphWorktreeService().withWorktreeClosed(
            input.projectId,
            input.worktreeId,
            runPreparedBuild,
          );
    } catch (error) {
      // Read-worker saturation says freshness is unknown, not that the graph
      // is absent. In particular, do not fall back to a cold seed build when
      // completion metadata could not be admitted; let a later scheduler tick
      // retry the read after the lane has capacity.
      if (
        error instanceof CodeGraphReadFailureError &&
        codeGraphReadFailure(error) === 'busy'
      ) {
        throw error;
      }
      if (workerStarted) {
        throw error;
      }
      preparationFailed = true;
      const preparationReason = `seed preparation failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      failureStage = 'preflight';
      response = await runColdFallback({
        projectId: input.projectId,
        worktreeId: input.worktreeId,
        worktreePath,
        repositories,
        options: input.options,
        reason: preparationReason,
        workspaceLabel,
        priority: workerPriority,
        timings: preludeTimings(false),
        onQueuePriority: (priority) => {
          queuePriority = priority;
        },
        onAttemptId: (id) => {
          attemptId = id ?? undefined;
          failureStage = 'worker-build';
        },
      });
    }

    if (response.ok) {
      // A completed build means the worktree has its graph.
      clearCodeGraphFirstRequest(buildKey);
      const endFingerprintStartedAt = performance.now();
      let endFingerprintMs: number | undefined;
      let fingerprintPersistMs: number | undefined;
      let fingerprintPersistOutcome:
        | 'persisted'
        | 'unstable'
        | 'busy'
        | 'error' = 'error';
      let fingerprintPersistFailure:
        | ReturnType<typeof codeGraphReadFailure>
        | undefined;
      let changedDuringBuild = false;
      try {
        const endFingerprint = await fingerprintWorktreeOffMain(
          buildKey,
          repositories,
          backgroundFingerprint,
        );
        const persistStartedAt = performance.now();
        endFingerprintMs = roundMs(persistStartedAt - endFingerprintStartedAt);
        changedDuringBuild = startFingerprint !== endFingerprint;
        if (changedDuringBuild) {
          fingerprintPersistOutcome = 'unstable';
        } else {
          try {
            await persistStableCodeGraphWorktreeFingerprint(
              getWorktreeCodeGraphDbPath(input.projectId, input.worktreeId),
              startFingerprint,
              endFingerprint,
              buildKey,
            );
            fingerprintPersistOutcome = 'persisted';
          } catch (error) {
            const readFailure = codeGraphReadFailure(error);
            fingerprintPersistFailure = readFailure;
            fingerprintPersistOutcome =
              readFailure === 'busy' ? 'busy' : 'error';
          } finally {
            fingerprintPersistMs = roundMs(
              performance.now() - persistStartedAt,
            );
          }
        }
      } catch {
        // The graph facts are already durably published. A failed end
        // fingerprint observation must not turn that build into a failure or
        // cause the build runner to retry; the next scheduler tick can observe
        // current Git state independently.
        fingerprintPersistOutcome = 'error';
      }
      const seeded = response.seedOutcomes?.filter(
        (outcome) => outcome.status === 'seeded',
      ).length;
      const cold = response.seedOutcomes?.filter(
        (outcome) => outcome.status === 'cold-fallback',
      ).length;
      if (changedDuringBuild) {
        // Keep this dynamic to break the scheduler -> build-service circular
        // dependency while still coalescing an edit-during-build follow-up.
        void import('./code-graph-scheduler')
          .then(({ scheduleCodeGraphFollowupBuild }) =>
            scheduleCodeGraphFollowupBuild({
              projectId: input.projectId,
              worktreeId: input.worktreeId,
            }),
          )
          .catch(() => undefined);
      }
      completeCodeGraphGenerationTelemetry(telemetry, {
        result: response.result,
        fusionDurationMs: response.fusionDurationMs ?? 0,
        seededRepositoryCount: seeded ?? 0,
        coldFallbackRepositoryCount: preparationFailed
          ? repositories.length
          : (cold ?? 0),
        reusedRepositoryCount:
          response.seedOutcomes?.filter(
            (outcome) => outcome.status === 'existing-graph-reused',
          ).length ?? 0,
        preparationFailed,
      });
      recordCodeGraphBuildDiagnostic({
        projectId: input.projectId,
        worktreeId: input.worktreeId,
        detail: {
          scope: 'worktree',
          trigger: input.reason,
          outcome: 'success',
          ...(attemptId === undefined ? {} : { attemptId }),
          ...(queuePriority === undefined ? {} : { queuePriority }),
          totalMs: roundMs(performance.now() - flowStartedAt),
          ...codeGraphBuildResultDetail(response.result),
          ...(endFingerprintMs === undefined ? {} : { endFingerprintMs }),
          ...(fingerprintPersistMs === undefined
            ? {}
            : { fingerprintPersistMs }),
          fingerprintPersistOutcome,
          ...(fingerprintPersistFailure === undefined
            ? {}
            : { fingerprintPersistFailure }),
        },
      });
    } else {
      failCodeGraphGenerationTelemetry(telemetry, {
        stage: failureStage,
        reason: 'worker-response',
      });
      recordFailure('worker-response');
    }
    return response;
  } catch (error) {
    failCodeGraphGenerationTelemetry(telemetry, {
      stage: failureStage,
      reason: codeGraphGenerationFailureReason(error),
    });
    recordFailure(diagnosticFailureReason(error));
    throw error;
  } finally {
    if (seedStagingDir) {
      await rm(seedStagingDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
      activeSeedStagingDirs.delete(seedStagingDir);
    }
  }
}
