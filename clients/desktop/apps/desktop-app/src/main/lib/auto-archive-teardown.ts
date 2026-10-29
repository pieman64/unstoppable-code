import type { ScriptRunRequest } from '@canopy/desktop-shared/types';
import { cancelWorktreeSetup, runScript } from '../services/scripts-service';
import { readWorkspaceConfig } from './workspace-persistence';

/**
 * Resolve the same configured scripts as manual deletion; failures preserve
 * the target. `operation` names the deletion in a failure message.
 */
export async function runAutoArchiveTeardown(
  workspaceId: string,
  worktreeId: string,
  multiRepo: boolean,
  operation = 'Auto Delete',
): Promise<void> {
  // Teardown must not run beside a setup the deletion is about to discard.
  await cancelWorktreeSetup({ projectId: workspaceId, worktreeId });
  const run = async (request: ScriptRunRequest): Promise<void> => {
    const result = await runScript(request);
    if (!result.success) {
      throw new Error(
        `${operation} ${request.scriptName} failed${result.timedOut ? ' (timed out)' : ''}: ${result.output}`,
      );
    }
  };
  if (!multiRepo) {
    await run({
      target: 'project',
      projectId: workspaceId,
      worktreeId,
      scriptName: 'teardown',
    });
    return;
  }
  const config = await readWorkspaceConfig(workspaceId);
  await run({
    target: 'workspace-root',
    workspaceId,
    worktreeId,
    scriptName: 'before-teardown',
  });
  const results = await Promise.allSettled(
    (config.repos ?? []).map((repo) =>
      run({
        target: 'workspace-repo',
        workspaceId,
        worktreeId,
        repoId: repo.id,
        scriptName: 'teardown',
      }),
    ),
  );
  const errors: unknown[] = [];
  for (const result of results) {
    if (result.status === 'rejected') errors.push(result.reason);
  }
  if (errors.length) throw new Error(errors.map(String).join('; '));
  await run({
    target: 'workspace-root',
    workspaceId,
    worktreeId,
    scriptName: 'after-teardown',
  });
}
