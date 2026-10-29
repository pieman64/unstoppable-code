import { getRepoRootFromWorktree } from './git';

export async function resolveProjectReferenceRepoPath(
  configuredRepoPath: string,
): Promise<string> {
  try {
    const resolvedRepoPath = await getRepoRootFromWorktree(configuredRepoPath);
    return resolvedRepoPath.trim() ? resolvedRepoPath : configuredRepoPath;
  } catch {
    return configuredRepoPath;
  }
}
