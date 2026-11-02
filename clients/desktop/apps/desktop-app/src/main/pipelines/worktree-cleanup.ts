import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  listExecutionSummaries,
  listExecutionSummariesForArchival,
  loadExecutionState,
  requestExecutionCancellation,
  saveExecutionState,
} from '@canopy/desktop-shared/node/pipelines/executor/execution-state';
import type {
  ExecutionRuntime,
  ExecutionSummary,
} from '@canopy/desktop-shared/node/pipelines/executor/types';
import type { ArchiveIoOperationRequest } from '../archive/archive-io-protocol';
import { relocateExecutionStateArtifactPaths } from './execution-state-relocation';
import { getActiveExecutionHandle } from './pipeline-execution-registry';

const CANCEL_TIMEOUT_MS = 10_000;

interface CleanupResult {
  warnings: string[];
  relocatedCount: number;
  failedRelocationIds: string[];
}

export interface CleanupWorktreePipelinesOptions {
  relocateArtifactsTo?: string;
  archiveCaptureExecutor?: (
    executionId: string,
    input: Extract<
      ArchiveIoOperationRequest,
      { type: 'copy-payload' }
    >['input'],
  ) => Promise<void>;
}

function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('cancel timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function deleteExecutionArtifacts(
  executionId: string,
  executionsDir: string,
): Promise<void> {
  await Promise.all([
    fs
      .unlink(path.join(executionsDir, `${executionId}.json`))
      .catch((error: unknown) => {
        if (
          typeof error === 'object' &&
          error !== null &&
          Reflect.get(error, 'code') === 'ENOENT'
        ) {
          return;
        }
        throw error instanceof Error ? error : new Error(String(error));
      }),
    fs
      .unlink(path.join(executionsDir, `${executionId}.cancel`))
      .catch((error: unknown) => {
        if (
          typeof error === 'object' &&
          error !== null &&
          Reflect.get(error, 'code') === 'ENOENT'
        ) {
          return;
        }
        throw error instanceof Error ? error : new Error(String(error));
      }),
    fs.rm(path.join(executionsDir, executionId), {
      recursive: true,
      force: true,
    }),
  ]);
}

function isCleanableStatus(status: ExecutionSummary['status']): boolean {
  return ['pending', 'success', 'failure', 'cancelled', 'paused'].includes(
    status,
  );
}

async function cancelRunningExecutions(
  running: ExecutionSummary[],
  runtime: ExecutionRuntime,
): Promise<PromiseSettledResult<ExecutionSummary>[]> {
  return Promise.allSettled(
    running.map(async (summary) => {
      try {
        const handle = getActiveExecutionHandle(summary.id);
        if (handle) {
          await requestExecutionCancellation(summary.id, runtime.executionsDir);
          // The handle resolves only after the executor has aborted and awaited
          // its child processes. If this bounded wait expires, leave both the
          // durable cancellation marker and running state intact: the still-live
          // handle owns eventual settlement, and a later archive retry must not
          // mistake a force-written terminal snapshot for a completed drain.
          await raceWithTimeout(handle.cancel(), CANCEL_TIMEOUT_MS);
        } else {
          // Nested pipeline executions do not have renderer registry handles,
          // and a just-settled execution may lose its handle after the summary
          // scan. Re-read first so that race is already drained; otherwise use
          // the executor's durable cancellation path, which polls the marker
          // before applying its bounded recovered-execution fallback.
          const current = await loadExecutionState(
            summary.id,
            runtime.executionsDir,
          );
          if (
            current &&
            !['success', 'failure', 'cancelled'].includes(current.status)
          ) {
            const { cancelPipelineExecution } =
              await import('@canopy/desktop-shared/node/pipelines/executor/pipeline-executor');
            await cancelPipelineExecution(summary.id, runtime, {
              allowRecoveredFallback: false,
            });
          }
        }
        return summary;
      } catch {
        throw new Error(summary.id);
      }
    }),
  );
}

/** Stop live pipeline processes while retaining their state for archival. */
export async function drainWorktreePipelines(
  projectId: string,
  worktreeId: string,
  runtime: ExecutionRuntime,
): Promise<void> {
  const { summaries } = await listExecutionSummariesForArchival(
    runtime.executionsDir,
  );
  const running = summaries.filter(
    (summary) =>
      summary.project_id === projectId &&
      summary.worktree_id === worktreeId &&
      summary.status === 'running',
  );
  const results = await cancelRunningExecutions(running, runtime);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') {
    const executionId =
      failed.reason instanceof Error ? failed.reason.message : 'unknown';
    throw new Error(
      `Failed to drain workflow execution '${executionId}' before worktree teardown.`,
    );
  }
}

export async function cleanupWorktreePipelines(
  projectId: string,
  worktreeId: string,
  runtime: ExecutionRuntime,
  options?: CleanupWorktreePipelinesOptions,
): Promise<CleanupResult> {
  const warnings: string[] = [];

  let summaries: ExecutionSummary[];
  try {
    if (options?.relocateArtifactsTo) {
      const listed = await listExecutionSummariesForArchival(
        runtime.executionsDir,
      );
      summaries = listed.summaries;
      if (listed.unreadableFiles.length > 0) {
        // Unreadable state files cannot be attributed to any worktree, so
        // this cleanup never deletes them — leaving them in place loses
        // nothing, and failing the archive here would brick every worktree
        // deletion over a single foreign file in the shared executions dir.
        warnings.push(
          `Skipped ${listed.unreadableFiles.length} unreadable workflow execution state file(s) left in place: ${listed.unreadableFiles.join(', ')}`,
        );
      }
    } else {
      summaries = await listExecutionSummaries(runtime.executionsDir);
    }
  } catch (error) {
    if (options?.relocateArtifactsTo) {
      throw error;
    }
    return {
      warnings: ['Failed to list workflow executions for cleanup'],
      relocatedCount: 0,
      failedRelocationIds: [],
    };
  }

  const worktreeExecutions = summaries.filter(
    (s) => s.project_id === projectId && s.worktree_id === worktreeId,
  );

  if (worktreeExecutions.length === 0) {
    return { warnings, relocatedCount: 0, failedRelocationIds: [] };
  }

  const running = worktreeExecutions.filter((s) => s.status === 'running');
  const cleanable = worktreeExecutions.filter((s) =>
    isCleanableStatus(s.status),
  );

  // Cancel running executions concurrently, each with a 10s timeout
  const cancelResults = await cancelRunningExecutions(running, runtime);

  for (const result of cancelResults) {
    if (result.status === 'fulfilled') {
      // Successfully cancelled — add to cleanable set
      cleanable.push(result.value);
    } else {
      const failedId =
        result.reason instanceof Error ? result.reason.message : 'unknown';
      const failedSummary = running.find((s) => s.id === failedId);
      const name = failedSummary?.pipeline_name ?? 'unknown';
      warnings.push(
        `Failed to cancel workflow execution '${failedId}' (workflow: ${name}). It may still be running.`,
      );
    }
  }

  let relocatedCount = 0;
  const failedRelocationIds: string[] = [];
  const artifactResults = await Promise.allSettled(
    cleanable.map(async (summary) => {
      if (options?.relocateArtifactsTo) {
        const destinationRoot = options.relocateArtifactsTo;
        try {
          await fs.mkdir(destinationRoot, { recursive: true });
          const state = await loadExecutionState(
            summary.id,
            runtime.executionsDir,
          );
          if (!state) throw new Error('Execution state disappeared');
          const source = path.join(runtime.executionsDir, summary.id);
          const destination = path.join(destinationRoot, summary.id);
          if (options.archiveCaptureExecutor) {
            await options.archiveCaptureExecutor(summary.id, {
              sourceRoots: [runtime.executionsDir],
              destinationRoot,
              entries: [
                {
                  kind: 'directory',
                  source,
                  destination,
                  missingSource: 'ignore',
                },
              ],
            });
          } else {
            await fs
              .cp(source, destination, { recursive: true, force: true })
              .catch((error: unknown) => {
                if (
                  typeof error === 'object' &&
                  error !== null &&
                  Reflect.get(error, 'code') === 'ENOENT'
                ) {
                  return;
                }
                throw error;
              });
          }
          await saveExecutionState(
            relocateExecutionStateArtifactPaths(
              state,
              runtime.executionsDir,
              destinationRoot,
              summary.id,
            ),
            destinationRoot,
          );
          relocatedCount += 1;
        } catch {
          // A manifest may still be committed for other successfully copied
          // executions. Do not leave a partial state file or artifact tree in
          // that visible container: the live copy remains authoritative and a
          // later delete attempt can retry the relocation from scratch.
          await deleteExecutionArtifacts(summary.id, destinationRoot).catch(
            () => undefined,
          );
          throw new Error(`relocate:${summary.id}`);
        }
      }
      await deleteExecutionArtifacts(summary.id, runtime.executionsDir);
    }),
  );

  artifactResults.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      return;
    }
    const summary = cleanable[index];
    if (
      result.reason instanceof Error &&
      result.reason.message === `relocate:${summary.id}`
    ) {
      failedRelocationIds.push(summary.id);
      warnings.push(
        `Failed to archive workflow execution '${summary.id}' artifacts; the live artifacts were preserved.`,
      );
      return;
    }
    warnings.push(
      `Failed to delete workflow execution '${summary.id}' artifacts. They may need manual cleanup.`,
    );
  });

  return { warnings, relocatedCount, failedRelocationIds };
}
