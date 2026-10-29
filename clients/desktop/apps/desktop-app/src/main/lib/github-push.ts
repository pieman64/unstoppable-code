import { getPushRemoteUrlStrict, pushBranch } from './git';
import {
  classifyGitHubAuthFailure,
  GitHubAuthFailureError,
} from './github-push-auth-failure';

/** Capture the actual origin push URL; a separate pushurl can override its fetch URL. */
export function pushBranchWithAuthFailure(repoPath: string): Promise<void> {
  return withGitHubPushAuthFailure(repoPath, () => pushBranch(repoPath));
}

export async function withGitHubPushAuthFailure<T>(
  repoPath: string,
  push: () => Promise<T>,
): Promise<T> {
  let remoteUrl: string | null = null;
  try {
    remoteUrl = await getPushRemoteUrlStrict(repoPath);
  } catch {
    // Missing metadata is not evidence of missing authentication.
  }
  try {
    return await push();
  } catch (error) {
    if (classifyGitHubAuthFailure(remoteUrl, error))
      throw new GitHubAuthFailureError(error);
    throw error;
  }
}
