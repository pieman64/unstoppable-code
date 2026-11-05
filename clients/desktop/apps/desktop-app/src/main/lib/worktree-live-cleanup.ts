import { destroyWorktreeSessions } from '../agents/session-manager';
import { getObservabilityService } from '../observability';
import { getTelemetrySyncService } from '../services/telemetry-sync-service';
import { stopTracking } from './github-poller';
import { cancelScheduledGeneration } from './worktree-summary-scheduler';
import { workerTerminal } from '../terminal/worker-terminal';
import { getClaudeTerminalSessionService } from '../integration/claude-terminal-session-service';
import { drainWorktreeShellScripts } from './script-runner';
import { drainWorktreePipelines } from '../pipelines/worktree-cleanup';
import { createElectronExecutionRuntime } from '../pipelines/execution-runtime';
import { getWorktreeDir } from './paths';
import { captureLinuxWorktreeWriterVerification } from './worktree-process-cleanup';

/**
 * Stops everything in this process that can write into a worktree, in a fixed
 * order: first the work that produces output (pipelines, then shell scripts),
 * then `destroyWorktreeSessions`, which destroys agent providers and drains
 * their final events and transcript entries, then Claude terminal settlement
 * before releasing terminals. Pipeline or script work cannot emit after the
 * session event drain, and nothing is closed under a live producer.
 *
 * Every step runs even when an earlier one fails, so one stuck owner does not
 * leave the others running. The first failure, starting with writer capture,
 * is rethrown once all steps settle, and no caller proceeds to removal.
 *
 * On Linux the writers present before cancellation are captured first and
 * verified gone afterwards, which also catches a provider child that outlived
 * its parent and left the process subtree.
 */
export async function cleanupLiveWorktreeState(
  projectId: string,
  worktreeId: string,
  onSessionsDestroyed?: () => void,
): Promise<void> {
  const failures: unknown[] = [];
  let verifyWritersGone: (() => Promise<void>) | undefined;
  try {
    verifyWritersGone = await captureLinuxWorktreeWriterVerification(
      getWorktreeDir(projectId, worktreeId),
    );
  } catch (error) {
    failures.push(error);
  }
  stopTracking(projectId, worktreeId);
  cancelScheduledGeneration(projectId, worktreeId);

  const steps: Array<() => Promise<void>> = [
    () =>
      drainWorktreePipelines(
        projectId,
        worktreeId,
        createElectronExecutionRuntime(),
      ),
    () => drainWorktreeShellScripts(projectId, worktreeId),
    async (): Promise<void> => {
      await destroyWorktreeSessions(projectId, worktreeId);
      onSessionsDestroyed?.();
    },
    // Terminal release fires an exit event that drops Claude runtime records.
    // Drain their transcript/watcher settlement while those records still exist.
    () =>
      getClaudeTerminalSessionService().cleanupWorktree(projectId, worktreeId),
    () => workerTerminal.releaseWorktree({ projectId, worktreeId }),
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    const [failed] = failures;
    throw failed instanceof Error
      ? failed
      : new Error('Worktree resource cleanup failed.');
  }
  await verifyWritersGone?.();
}

export async function purgeLiveWorktreeObservabilityData(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  // Drain pending telemetry for this worktree before its audit/transcript
  // sidecars are purged (CAN-402), then drop it from the queue and sync-map.
  await getTelemetrySyncService()
    .drainWorktreeForDeletion(projectId, worktreeId)
    .catch(() => undefined);
  await getObservabilityService().purgeWorktreeData(projectId, worktreeId);
}
