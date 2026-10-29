import { setOutput } from '../_lib/output';
import { runWithActionEnvironment } from '../_lib/action-env';
import { getWorkspaceItem } from '../../node/lib/workspace-service';
import {
  createMultiRepoWorktree,
  createSingleRepoWorktree,
  getWorktreeCliRecord,
} from '../../node/lib/worktree-service';

function optionalInput(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requireInput(value: string | undefined, name: string): string {
  const trimmed = optionalInput(value);
  if (!trimmed) {
    throw new Error(`create-worktree requires input "${name}"`);
  }
  return trimmed;
}

function parseOptionalBoolean(
  value: string | undefined,
  name: string,
): boolean | undefined {
  const trimmed = optionalInput(value)?.toLowerCase();
  if (trimmed === undefined) {
    return undefined;
  }
  if (trimmed === 'true') {
    return true;
  }
  if (trimmed === 'false') {
    return false;
  }
  throw new Error(`create-worktree input "${name}" must be true or false`);
}

export async function runCreateWorktreeAction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runWithActionEnvironment(env, async () => {
    const workspaceId = requireInput(env.INPUT_WORKSPACE_ID, 'workspace_id');
    const branch = optionalInput(env.INPUT_BRANCH);
    const baseBranch = optionalInput(env.INPUT_BASE_BRANCH);
    const repair = parseOptionalBoolean(env.INPUT_REPAIR, 'repair') === true;
    const restoreClaudeMd = parseOptionalBoolean(
      env.INPUT_RESTORE_CLAUDE_MD,
      'restore_claude_md',
    );

    const workspace = await getWorkspaceItem(workspaceId);
    const created =
      workspace.type === 'multi-repo'
        ? await createMultiRepoWorktree({
            workspaceId,
            branchName: branch,
            baseBranch,
            repairWorkspaceRoot: repair,
            restoreClaudeMd,
            startPostCreateSetup: false,
          })
        : await createSingleRepoWorktree({
            workspaceId,
            branchName: branch,
            baseBranch,
            startPostCreateSetup: false,
          });

    const record = await getWorktreeCliRecord(workspaceId, created.id);
    setOutput('worktree_id', record.id);
    setOutput('workspace_id', workspaceId);
    setOutput('path', record.path);
    setOutput('branch_name', record.branchName);
    setOutput('created_at', record.createdAt);
  });
}
