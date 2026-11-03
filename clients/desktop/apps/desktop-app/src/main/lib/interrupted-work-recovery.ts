import { join } from 'node:path';
import { utilityProcess } from 'electron';
import { getAppWorkspacesRootDir, getWorkspacesRootDir } from './paths';
import { getChatStateService } from '../services/chat-state-service';
import { createElectronExecutionRuntime } from '../pipelines/execution-runtime';
import { recoverOrphanedPipelineExecutions } from '@canopy/desktop-shared/node/pipelines/executor/crash-recovery';
import { configureDesktopPipelineOwnerFence } from '../pipelines/pipeline-owner-fence';
import type { InterruptedWorkScan } from './interrupted-work-scan-worker';

function scan(executionsDir: string): Promise<InterruptedWorkScan> {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(
      join(__dirname, 'interrupted-work-scan-worker.js'),
      [],
      { serviceName: 'interrupted-work-scan' },
    );
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error('Interrupted work scan timed out')),
      120_000,
    );
    const finish = (error?: Error, result?: InterruptedWorkScan): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else if (result) resolve(result);
    };
    child.once('exit', (code) =>
      finish(new Error(`Interrupted work scan exited (${code})`)),
    );
    child.once(
      'message',
      (message: { error?: string; result?: InterruptedWorkScan }) => {
        if (message.result) finish(undefined, message.result);
        else
          finish(
            new Error(message.error ?? 'Invalid interrupted work scan result'),
          );
      },
    );
    child.postMessage({
      roots: [getWorkspacesRootDir(), getAppWorkspacesRootDir()],
      executionsDir,
    });
  });
}

/** Complete recovery before the first window can admit new work. Each item is retryable. */
export async function recoverInterruptedWorkAtStartup(): Promise<void> {
  const runtime = createElectronExecutionRuntime();
  // The inspector is installed before recovery; this process's own start
  // identity resolves in the background, and runs that start first record
  // only their PID.
  configureDesktopPipelineOwnerFence().catch(() => undefined);
  const found = await scan(runtime.executionsDir);
  const errors = [...found.errors];
  for (const scope of found.chatScopes) {
    try {
      await getChatStateService().getState(scope);
    } catch (error) {
      errors.push(
        `Chat ${scope.projectId}/${scope.worktreeId}: ${String(error)}`,
      );
    }
  }
  errors.push(
    ...(await recoverOrphanedPipelineExecutions(
      found.pipelineIds,
      runtime.executionsDir,
    )),
  );
  if (errors.length) throw new Error(errors.join('\n'));
}
