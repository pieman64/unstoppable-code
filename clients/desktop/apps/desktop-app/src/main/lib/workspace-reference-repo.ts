import { getRepoRootFromWorktree } from './git';

export async function resolveWorkspaceReferenceRepoPath(
  configuredSourceRepoPath: string,
): Promise<string> {
  try {
    const resolvedRepoPath = await getRepoRootFromWorktree(
      configuredSourceRepoPath,
    );
    return typeof resolvedRepoPath === 'string' && resolvedRepoPath.length > 0
      ? resolvedRepoPath
      : configuredSourceRepoPath;
  } catch {
    return configuredSourceRepoPath;
  }
}
