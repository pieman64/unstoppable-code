import { parsePullRequestReference } from '@canopy/desktop-shared/lib/create-from-reference';
import type { ResolvePullRequestResponse } from '@canopy/desktop-shared/types';
import { getRemoteUrl } from './git';
import { parseGitHubRemote } from './github-pr';
import { getGitHubPullRequestStatus } from './github-pr-read-model';

/**
 * Resolve a PR reference (URL, "#123", or bare number) to its head branch and
 * metadata via the GitHub API. All references are scoped to the repo's origin
 * remote; full URLs must name that same repository.
 */
export async function resolvePullRequestForRepo(
  repoPath: string,
  reference: string,
): Promise<ResolvePullRequestResponse> {
  const parsed = parsePullRequestReference(reference);
  if (!parsed) {
    throw new Error(
      `Could not parse "${reference}" as a pull request URL or number.`,
    );
  }

  const remoteUrl = await getRemoteUrl(repoPath);
  const remote = remoteUrl ? parseGitHubRemote(remoteUrl) : null;
  if (!remote) {
    throw new Error(
      'This repository has no GitHub origin remote, so a pull request cannot be resolved.',
    );
  }

  let owner = remote.owner;
  let repo = remote.repo;
  if (parsed.owner !== undefined && parsed.repo !== undefined) {
    if (
      parsed.owner.toLowerCase() !== remote.owner.toLowerCase() ||
      parsed.repo.toLowerCase() !== remote.repo.toLowerCase()
    ) {
      throw new Error(
        `Pull request ${parsed.owner}/${parsed.repo}#${parsed.number} does not belong to the selected repository (${remote.owner}/${remote.repo}).`,
      );
    }
    owner = parsed.owner;
    repo = parsed.repo;
  }

  const pr = await getGitHubPullRequestStatus(
    { owner, repo, number: parsed.number },
    { priority: 'interactive', caller: 'pr-resolver' },
  );

  const headRefName = pr.headBranch;
  const baseRefName = pr.baseBranch;
  if (!headRefName || !baseRefName) {
    throw new Error(
      `Pull request #${parsed.number} did not include branch information.`,
    );
  }

  // Cross-repo PRs name a branch that lives in the author's fork, which cannot
  // be checked out from this repository. The head repository is null when
  // that fork has been deleted. Reject both cases here with a clear message
  // rather than letting the later worktree create fail with a disconnected
  // "Branch not found" error.
  const headRepoFullName = pr.headRepository;
  const expectedFullName = `${owner}/${repo}`;
  if (
    headRepoFullName === null ||
    headRepoFullName.toLowerCase() !== expectedFullName.toLowerCase()
  ) {
    const forkLabel = headRepoFullName ?? 'an unavailable repository';
    throw new Error(
      `Pull request #${parsed.number}'s branch lives in a fork (${forkLabel}), so it cannot be checked out from this repository.`,
    );
  }

  return {
    number: pr.ref.number,
    title: pr.title,
    headRefName,
    baseRefName,
    url: pr.url,
  };
}
