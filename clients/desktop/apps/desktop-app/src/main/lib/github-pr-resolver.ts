import { parsePullRequestReference } from '@canopy/protocol/portable-tasks/pull-request-reference';
import type { ResolvePullRequestResponse } from '@canopy/desktop-shared/types';
import { getRemoteUrl } from './git';
import { parseGitHubRemote } from './github-pr';
import {
  getGitHubPullRequestStatus,
  type GitHubPullRequestStatusView,
} from './github-pr-read-model';

type ParsedPullRequestReference = NonNullable<
  ReturnType<typeof parsePullRequestReference>
>;

/** The parsed reference; an unparseable one fails with the resolver's message. */
export function parsePullRequestReferenceForResolver(
  reference: string,
): ParsedPullRequestReference {
  const parsed = parsePullRequestReference(reference);
  if (!parsed) {
    throw new Error(
      `Could not parse "${reference}" as a pull request URL or number.`,
    );
  }
  return parsed;
}

/**
 * Binds a parsed reference to the repository's `origin`: a full URL must
 * name that same repository. Returns the pull request to read.
 */
export function bindPullRequestReference(
  parsed: ParsedPullRequestReference,
  remoteUrl: string | null,
): { owner: string; repo: string; number: number } {
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
  return { owner, repo, number: parsed.number };
}

/**
 * Resolve a PR reference (URL, "#123", or bare number) to its head branch and
 * metadata via the GitHub API. All references are scoped to the repo's origin
 * remote; full URLs must name that same repository.
 */
export async function resolvePullRequestForRepo(
  repoPath: string,
  reference: string,
): Promise<ResolvePullRequestResponse> {
  const parsed = parsePullRequestReferenceForResolver(reference);
  const ref = bindPullRequestReference(parsed, await getRemoteUrl(repoPath));
  const pr = await getGitHubPullRequestStatus(ref, {
    priority: 'interactive',
    caller: 'pr-resolver',
  });
  return pullRequestResolution(pr, ref);
}

/**
 * The resolver's answer for the pull request the read model returned:
 * rejects one without branch information or with a head in a fork.
 */
export function pullRequestResolution(
  pr: GitHubPullRequestStatusView,
  requested: { owner: string; repo: string; number: number },
): ResolvePullRequestResponse {
  const headRefName = pr.headBranch;
  const baseRefName = pr.baseBranch;
  if (!headRefName || !baseRefName) {
    throw new Error(
      `Pull request #${requested.number} did not include branch information.`,
    );
  }

  // Cross-repo PRs name a branch that lives in the author's fork, which cannot
  // be checked out from this repository. The head repository is null when
  // that fork has been deleted. Reject both cases here with a clear message
  // rather than letting the later worktree create fail with a disconnected
  // "Branch not found" error.
  const headRepoFullName = pr.headRepository;
  const expectedFullName = `${requested.owner}/${requested.repo}`;
  if (
    headRepoFullName === null ||
    headRepoFullName.toLowerCase() !== expectedFullName.toLowerCase()
  ) {
    const forkLabel = headRepoFullName ?? 'an unavailable repository';
    throw new Error(
      `Pull request #${requested.number}'s branch lives in a fork (${forkLabel}), so it cannot be checked out from this repository.`,
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
