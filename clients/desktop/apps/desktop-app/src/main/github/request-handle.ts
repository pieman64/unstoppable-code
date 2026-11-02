import {
  GitHubRequestError,
  type GitHubPullRequestRecord,
  type GitHubRepositoryRecord,
  type GitHubRequestHandle,
} from '@canopy/core-runtime/node/github';
import { describeGitHubCredential } from '../lib/github-auth';
import {
  GitHubBrokerCredentialResetError,
  isGitHubBrokerError,
} from '../lib/github-broker/errors';
import {
  createGitHubPullRequest,
  findOpenGitHubPullRequestForBranch,
  readGitHubBranchHead,
  updateGitHubPullRequest,
} from '../lib/github-pr-writes';
import { listOpenPullRequestsForRepo } from '../lib/github-pr-listing';
import {
  getGitHubPullRequestStatus,
  githubPullRequestDetailOf,
  isCompleteGitHubPullRequestDetail,
  listGitHubPullRequestProjections,
  readGitHubPullRequestProjection,
  type GitHubPullRequestProjection,
} from '../lib/github-pr-read-model';
import {
  isDuplicatePrError,
  isPrBaseBranchCreationError,
} from '../lib/github-pr-rejections';
import {
  GitHubRepoListTimeoutError,
  listUserRepoSnapshot,
  type GitHubRepoAccess,
} from '../lib/github-repo-listing';
import {
  currentGitHubProjection,
  type PullRequestWriteCapture,
} from './projection-capture';

// Spend-summary labels for the canonical reads.
const GET_CALLER = 'core-pull-request-get';
const LIST_CALLER = 'core-pull-request-list';
// Today's resolver read, which `github:resolve-pull-request` keeps.
const RESOLVER_READ = {
  priority: 'interactive',
  caller: 'pr-resolver',
} as const;

/** The host's failure as a typed handle error; the host error stays its cause. */
function requestError(error: unknown): unknown {
  if (error instanceof GitHubRequestError) return error;
  if (error instanceof GitHubRepoListTimeoutError)
    return new GitHubRequestError('timeout', error.message, { cause: error });
  if (error instanceof GitHubBrokerCredentialResetError)
    return new GitHubRequestError('not_authenticated', error.message, {
      cause: error,
    });
  if (!isGitHubBrokerError(error)) return error;
  const cause = { cause: error };
  switch (error.code) {
    case 'not_authenticated':
    case 'credential_reset':
      return new GitHubRequestError('not_authenticated', error.message, cause);
    case 'not_found':
    case 'permission_denied':
      return new GitHubRequestError('not_found', error.message, cause);
    case 'rate_limited':
      return new GitHubRequestError('rate_limited', error.message, {
        cause: error,
        ...(error.retryAt === undefined
          ? {}
          : { retryAfterMs: Math.max(0, error.retryAt - Date.now()) }),
      });
    case 'timeout':
      return new GitHubRequestError('timeout', error.message, cause);
    case 'cancelled':
      return new GitHubRequestError('cancelled', error.message, cause);
    case 'shutdown':
    case 'network':
    case 'server_error':
      return new GitHubRequestError('unavailable', error.message, cause);
    case 'invalid_response':
      return new GitHubRequestError('invalid_response', error.message, cause);
  }
}

async function mapped<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw requestError(error);
  }
}

function projectionUnavailable(): GitHubRequestError {
  return new GitHubRequestError(
    'projection_unavailable',
    'The compatibility projection read no canonical pull request.',
  );
}

function pullRequestRecord({
  view,
  detail,
}: GitHubPullRequestProjection): GitHubPullRequestRecord {
  return {
    number: view.ref.number,
    title: detail.title,
    body: detail.body,
    url: view.url,
    state: view.state,
    draft: view.isDraft,
    baseBranch: view.baseBranch,
    baseSha: detail.baseSha,
    headBranch: view.headBranch,
    headSha: view.headSha,
    mergeable: view.mergeable,
    reviewDecision: view.reviewDecision ?? 'none',
    checks: [...detail.checks],
    reviewThreadCount: detail.reviewThreadCount,
    unresolvedReviewThreadCount: detail.unresolvedReviewThreadCount,
    commentCount: detail.commentCount,
    updatedAt: detail.updatedAt,
  };
}

/** A GitHub refusal of a write, typed; the host error stays its cause. */
function writeRejection(error: unknown, duplicate: boolean): unknown {
  if (duplicate && isDuplicatePrError(error))
    return new GitHubRequestError(
      'duplicate',
      'GitHub reports an open pull request for the head branch.',
      { cause: error },
    );
  if (isPrBaseBranchCreationError(error))
    return new GitHubRequestError(
      'base_rejected',
      'GitHub refused the base branch.',
      { cause: error },
    );
  return requestError(error);
}

/** The write capture of the projection this call runs in, if any. */
function writeCapture(): PullRequestWriteCapture | undefined {
  const capture = currentGitHubProjection();
  return capture?.kind === 'write' ? capture : undefined;
}

function repositoryRecord(access: GitHubRepoAccess): GitHubRepositoryRecord {
  return {
    fullName: access.fullName,
    webUrl: access.htmlUrl,
    permissions: (['pull', 'push', 'admin'] as const).filter(
      (permission) => access.permissions[permission],
    ),
    updatedAt: access.updatedAt,
  };
}

/**
 * The desktop's only `GitHubRequestHandle`: today's secure store, broker,
 * shared pull-request read model and listings, behind results-only members.
 * Inside a compatibility projection it makes today's read instead and
 * captures its legacy result (CAN-4109). The daemon vault replaces this
 * implementation, not the interface (CAN-4415).
 */
const handle: GitHubRequestHandle = {
  describe: describeGitHubCredential,
  getPullRequest: (ref, options) =>
    mapped(async (): Promise<GitHubPullRequestRecord> => {
      const capture = currentGitHubProjection();
      if (capture?.kind !== 'resolve')
        return pullRequestRecord(
          await readGitHubPullRequestProjection(ref, {
            refresh: options.refresh,
            caller: GET_CALLER,
            ...(options.signal ? { signal: options.signal } : {}),
          }),
        );
      // The resolver's own read, exactly as before; its view is the legacy
      // answer. Its detail stands in only when that read listed everything.
      if (capture.resolvedRepoPath !== capture.repoPath)
        throw projectionUnavailable();
      const view = await getGitHubPullRequestStatus(ref, { ...RESOLVER_READ });
      capture.view = view;
      const detail = githubPullRequestDetailOf(view);
      if (!detail || !isCompleteGitHubPullRequestDetail(detail))
        throw projectionUnavailable();
      return pullRequestRecord({ view, detail });
    }),
  listPullRequests: (repository, page, options) =>
    mapped(async () => {
      const capture = currentGitHubProjection();
      if (capture?.kind === 'list') {
        // Today's single REST listing and its per-path cache (rail answer
        // Q2 (a)); the canonical full read runs only for canonical callers.
        if (capture.resolvedRepoPath !== capture.repoPath)
          throw projectionUnavailable();
        capture.legacy = await listOpenPullRequestsForRepo(capture.repoPath, {
          owner: repository.owner,
          repo: repository.repo,
        });
        throw projectionUnavailable();
      }
      const listed = await listGitHubPullRequestProjections(
        repository,
        { states: page.states, first: page.first, after: page.after },
        {
          caller: LIST_CALLER,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      return {
        pullRequests: listed.pullRequests.map(pullRequestRecord),
        endCursor: listed.endCursor,
      };
    }),
  listRepositories: () =>
    mapped(async () => {
      const snapshot = await listUserRepoSnapshot();
      const capture = currentGitHubProjection();
      if (capture?.kind === 'repositories' && capture.legacy === undefined)
        capture.legacy = snapshot.repos;
      return {
        snapshotId: snapshot.id,
        repositories: snapshot.access.map(repositoryRecord),
      };
    }),
  getBranchHead: (repository, branch, options) =>
    mapped(async () => {
      const sha = await readGitHubBranchHead(
        repository,
        branch,
        options.signal,
      );
      return sha === null ? null : { sha };
    }),
  // The writes take no signal: a sent GitHub mutation is never aborted. In a
  // projection they record that one was sent, and what it wrote.
  createPullRequest: async (repository, input) => {
    const capture = writeCapture();
    if (capture) capture.mutationSent = true;
    let created: { number: number; url: string };
    try {
      created = await createGitHubPullRequest(repository, {
        title: input.title,
        body: input.body,
        head: input.headBranch,
        base: input.baseBranch,
        draft: input.draft,
      });
    } catch (error) {
      throw writeRejection(error, true);
    }
    if (capture) capture.written = { ...created, created: true };
    return created;
  },
  findOpenPullRequest: (repository, headBranch, options) =>
    mapped(async () => {
      const found = await findOpenGitHubPullRequestForBranch(
        repository,
        headBranch,
        options.signal,
      );
      // Inside a write projection this is the adoption of GitHub's duplicate.
      const capture = writeCapture();
      if (found && capture && capture.written === undefined)
        capture.written = { ...found, created: false };
      return found;
    }),
  updatePullRequest: async (ref, input) => {
    const capture = writeCapture();
    if (capture) capture.mutationSent = true;
    let updated: { number: number; url: string };
    try {
      updated = await updateGitHubPullRequest(ref, {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.baseBranch === undefined ? {} : { base: input.baseBranch }),
      });
    } catch (error) {
      throw writeRejection(error, false);
    }
    if (capture) capture.written = { ...updated, created: false };
    return updated;
  },
};

export const desktopGitHubRequestHandle: GitHubRequestHandle =
  Object.freeze(handle);
