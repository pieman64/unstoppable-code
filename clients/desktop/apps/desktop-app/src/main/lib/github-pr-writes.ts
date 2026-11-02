import { getGitHubClient } from './github-client';
import { invalidateGitHubPullRequest } from './github-pr-read-model';
import { isRecord } from './type-guards';

// The GitHub pull request writes and the reads they need, shared by the
// direct create and update and the `core.pullRequest.*` request handle
// (CAN-4109). Kept apart from github-pr.ts so the handle does not load its
// graph. None is aborted once sent.

/**
 * One `pulls.update` with the given members, then the shared read model
 * forgets the pull request. The direct base-branch update and the
 * `core.pullRequest.update` request handle share it (CAN-4109).
 */
export async function updateGitHubPullRequest(
  ref: { owner: string; repo: string; number: number },
  patch: { title?: string; body?: string; base?: string },
): Promise<{ number: number; url: string }> {
  const client = getGitHubClient();
  const result = await client.enqueue(
    (octokit) =>
      octokit.pulls.update({
        owner: ref.owner,
        repo: ref.repo,
        pull_number: ref.number,
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.body === undefined ? {} : { body: patch.body }),
        ...(patch.base === undefined ? {} : { base: patch.base }),
      }),
    'high',
    { operation: 'mutation', idempotency: 'unsafe' },
  );
  invalidateGitHubPullRequest({
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
  });

  return { number: ref.number, url: result.data.html_url };
}

/**
 * One `pulls.create`. The direct create and the `core.pullRequest.create`
 * request handle share it (CAN-4109); neither aborts it once sent.
 */
export async function createGitHubPullRequest(
  remote: { owner: string; repo: string },
  input: {
    title: string;
    body: string;
    head: string;
    base: string;
    draft: boolean;
  },
): Promise<{ number: number; url: string }> {
  const result = await getGitHubClient().enqueue(
    (octokit) =>
      octokit.pulls.create({
        owner: remote.owner,
        repo: remote.repo,
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: input.draft,
      }),
    'high',
    { operation: 'mutation', idempotency: 'unsafe' },
  );
  return { number: result.data.number, url: result.data.html_url };
}

/** The open pull request of a head branch in the repository, or `null`. */
export async function findOpenGitHubPullRequestForBranch(
  remote: { owner: string; repo: string },
  branchName: string,
  signal?: AbortSignal,
): Promise<{ number: number; url: string } | null> {
  const response = await getGitHubClient().enqueue(
    (octokit) =>
      octokit.pulls.list({
        owner: remote.owner,
        repo: remote.repo,
        head: `${remote.owner}:${branchName}`,
        state: 'open',
        per_page: 1,
      }),
    'high',
    { operation: 'read', idempotency: 'safe', ...(signal ? { signal } : {}) },
  );
  const [pullRequest] = response.data;
  return pullRequest
    ? { number: pullRequest.number, url: pullRequest.html_url }
    : null;
}

function startsWithBranchNotFound(value: unknown): boolean {
  return typeof value === 'string' && /^\s*branch not found\b/i.test(value);
}

/**
 * GitHub's 404 for a missing branch (the broker keeps the response error as
 * its cause). A repository the credential cannot see is a 404 with another
 * message: that stays a failure, not a missing head.
 */
function isMissingBranch(error: unknown): boolean {
  if (!isRecord(error) || error.status !== 404) return false;
  const response = isRecord(error.cause) ? error.cause.response : undefined;
  return (
    startsWithBranchNotFound(error.message) ||
    (isRecord(error.cause) && startsWithBranchNotFound(error.cause.message)) ||
    (isRecord(response) &&
      isRecord(response.data) &&
      startsWithBranchNotFound(response.data.message))
  );
}

/** The branch's commit on GitHub, or `null` when GitHub has no such branch. */
export async function readGitHubBranchHead(
  remote: { owner: string; repo: string },
  branchName: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const response = await getGitHubClient().enqueue(
      (octokit) =>
        octokit.repos.getBranch({
          owner: remote.owner,
          repo: remote.repo,
          branch: branchName,
        }),
      'high',
      { operation: 'read', idempotency: 'safe', ...(signal ? { signal } : {}) },
    );
    // GitHub redirects a renamed branch's old name to the new branch, which
    // is not the head the caller pushed.
    return response.data.name === branchName ? response.data.commit.sha : null;
  } catch (error) {
    if (isMissingBranch(error)) return null;
    throw error;
  }
}
