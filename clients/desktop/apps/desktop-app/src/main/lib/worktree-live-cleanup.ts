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

export async function cleanupLiveWorktreeState(
  projectId: string,
  worktreeId: string,
  onSessionsDestroyed?: () => void,
): Promise<void> {
  stopTracking(projectId, worktreeId);
  cancelScheduledGeneration(projectId, worktreeId);

  const results = await Promise.allSettled([
    getClaudeTerminalSessionService().cleanupWorktree(projectId, worktreeId),
    drainWorktreeShellScripts(projectId, worktreeId),
    workerTerminal.releaseWorktree({ projectId, worktreeId }),
    drainWorktreePipelines(
      projectId,
      worktreeId,
      createElectronExecutionRuntime(),
    ),
  ]);
  await destroyWorktreeSessions(projectId, worktreeId);
  onSessionsDestroyed?.();
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') {
    throw failed.reason instanceof Error
      ? failed.reason
      : new Error('Worktree resource cleanup failed.');
  }
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
