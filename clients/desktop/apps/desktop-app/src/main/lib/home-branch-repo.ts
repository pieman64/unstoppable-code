import { readWorkspaceConfig } from './workspace-persistence';
import { resolveWorkspaceReferenceRepoPath } from './workspace-reference-repo';

/**
 * The repository Home branch targets enumerate: a single-repo workspace's
 * repository or a multi-repo workspace's source repository, resolved to its
 * main repository root. `null` when the workspace has neither.
 */
export async function resolveHomeBranchRepoPath(
  workspaceId: string,
): Promise<string | null> {
  const config = await readWorkspaceConfig(workspaceId);
  if (config.type === 'single-repo' && config.repoPath) {
    return resolveWorkspaceReferenceRepoPath(config.repoPath);
  }
  if (config.type === 'multi-repo' && config.sourceRepoPath) {
    return resolveWorkspaceReferenceRepoPath(config.sourceRepoPath);
  }
  return null;
}
