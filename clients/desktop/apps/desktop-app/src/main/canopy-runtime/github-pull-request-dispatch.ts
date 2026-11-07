import type {
  GitHubMergeQueueRequest,
  GitHubMergeQueueResponse,
} from '@canopy/desktop-shared/types/github';
import type {
  GetRepoSlugRequest,
  GetRepoSlugResponse,
  GitHubRepoSummary,
  ListPullRequestsRequest,
  ListPullRequestsResponse,
  SearchPullRequestsRequest,
  SearchPullRequestsResponse,
  ResolvePullRequestRequest,
  ResolvePullRequestResponse,
} from '@canopy/desktop-shared/types';
import {
  CORE_INTEGRATION_GRANTS,
  CORE_PULL_REQUEST_GRANTS,
  GITHUB_INTEGRATION_ID,
  type CanopyCallerDescriptor,
  type CoreIntegrationResourceListResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  mintPullRequestId,
  mintRepositoryId,
  type RecordedRepositoryRef,
} from '@canopy/core-runtime/node/github';
import {
  runInGitHubProjection,
  type PullRequestListCapture,
  type PullRequestResolveCapture,
  type RepositoryListCapture,
} from '../github/projection-capture';
import {
  getRepoSlugForRepoPath,
  listOpenPullRequestsForRepo,
  searchOpenPullRequestsForRepo,
} from '../lib/github-pr-listing';
import {
  bindPullRequestReference,
  parsePullRequestReferenceForResolver,
  pullRequestResolution,
  resolvePullRequestForRepo,
} from '../lib/github-pr-resolver';
import { validateGitHubMergeQueueRequest } from '../lib/github-merge-queue-read-model';
import { validateAbsolutePath } from '../lib/validation';
import { findRecordedRepository } from '../lib/workspace-recorded-repo';
import type { CorePullRequestDispatcher } from './core-pull-request-adapter';
import type { WorkerGitDispatcher } from './worker-git-adapter';
import { readRepositoryRemoteUrl } from './worker-git-dispatch';

/*
 * The `core.pullRequest.*` and `core.integration.resource.list` projections
 * behind `github:list-pull-requests`, `github:resolve-pull-request`,
 * `github:get-repo-slug` and `github:list-user-repos` (CAN-4109). Each
 * dispatched call holds only its operation's read grant, and each returns the
 * legacy response the host read in the projection context, byte for byte.
 */

export type GitHubPullRequestIpcDispatcher = CorePullRequestDispatcher &
  WorkerGitDispatcher;

/** Resolved only once a call is dispatched, after the legacy validation. */
export type LazyCaller = () => CanopyCallerDescriptor;

const LIST_LIMIT = 50;
const REPOSITORY_PAGE = 200;
// The host lists at most 300 repositories, so two pages of 200 suffice.
const MAX_REPOSITORY_PAGES = 5;

export function withGrant(
  caller: CanopyCallerDescriptor,
  grant: CanopyCallerDescriptor['grants'][number],
): CanopyCallerDescriptor {
  return { ...caller, grants: [grant] };
}

// Legacy channels surfaced the host error itself; the in-process binding
// keeps it as the runtime cause.
export function hostError(error: unknown): unknown {
  return error instanceof CanopyOperationError &&
    error.runtimeCause !== undefined
    ? error.runtimeCause
    : error;
}

/**
 * A dispatched read the host could not serve at the requested path: the
 * record changed under it, or `origin` no longer names a GitHub repository.
 * The direct read answers it, with its own legacy messages.
 */
function servedElsewhere(
  error: unknown,
  capture: { repoPath: string; resolvedRepoPath?: string | null },
): boolean {
  if (
    capture.resolvedRepoPath !== undefined &&
    capture.resolvedRepoPath !== capture.repoPath
  )
    return true;
  return (
    error instanceof CanopyOperationError &&
    error.payload.code === 'core.pullRequest.repositoryUnavailable'
  );
}

async function recordedRepository(repoPath: string): Promise<{
  repository: RecordedRepositoryRef;
  repositoryId: string;
} | null> {
  const recorded = await findRecordedRepository(repoPath).catch(() => null);
  if (!recorded) return null;
  const repository: RecordedRepositoryRef = {
    workspaceId: recorded.workspaceId,
    ...(recorded.repoId === undefined ? {} : { repoId: recorded.repoId }),
  };
  const repositoryId = mintRepositoryId(repository);
  return repositoryId === null ? null : { repository, repositoryId };
}

/**
 * `github:list-pull-requests`: a path a workspace records is listed through
 * `core.pullRequest.list`, whose host keeps today's single REST listing and
 * its per-path cache in this context (the full canonical read runs only for
 * canonical callers) and returns that listing.
 */
export async function listPullRequestsForIpc(
  dispatcher: GitHubPullRequestIpcDispatcher,
  resolveCaller: LazyCaller,
  request: ListPullRequestsRequest,
): Promise<ListPullRequestsResponse> {
  validateAbsolutePath(request.repoPath, 'repoPath');
  const recorded = await recordedRepository(request.repoPath);
  // Capability-exception debt (CAN-4109): a path no workspace records has no
  // repository id to name, so it keeps the direct read.
  if (!recorded)
    return {
      pullRequests: await listOpenPullRequestsForRepo(request.repoPath),
    };
  const caller = withGrant(resolveCaller(), CORE_PULL_REQUEST_GRANTS.read);
  const capture: PullRequestListCapture = {
    kind: 'list',
    repoPath: request.repoPath,
  };
  try {
    await runInGitHubProjection(capture, () =>
      dispatcher.query(
        'core.pullRequest.list',
        {
          integrationId: GITHUB_INTEGRATION_ID,
          repositoryId: recorded.repositoryId,
          states: ['open'],
          cursor: null,
          limit: LIST_LIMIT,
        },
        { caller },
      ),
    );
  } catch (error) {
    if (capture.legacy !== undefined) return { pullRequests: capture.legacy };
    if (servedElsewhere(error, capture))
      return {
        pullRequests: await listOpenPullRequestsForRepo(request.repoPath),
      };
    throw hostError(error);
  }
  if (capture.legacy === undefined)
    throw new Error('Pull request listing projection was not captured.');
  return { pullRequests: capture.legacy };
}

/** Title search keeps the host's bounded GraphQL read and per-path cache. */
export async function searchPullRequestsForIpc(
  dispatcher: GitHubPullRequestIpcDispatcher,
  resolveCaller: LazyCaller,
  request: SearchPullRequestsRequest,
): Promise<SearchPullRequestsResponse> {
  const recorded = await recordedRepository(request.repoPath);
  if (!recorded)
    return {
      pullRequests: await searchOpenPullRequestsForRepo(
        request.repoPath,
        request.query,
      ),
    };
  const capture: PullRequestListCapture = {
    kind: 'search',
    repoPath: request.repoPath,
  };
  try {
    await runInGitHubProjection(capture, () =>
      dispatcher.query(
        'core.pullRequest.list',
        {
          integrationId: GITHUB_INTEGRATION_ID,
          repositoryId: recorded.repositoryId,
          states: ['open'],
          cursor: null,
          limit: 20,
          query: request.query.trim(),
        },
        { caller: withGrant(resolveCaller(), CORE_PULL_REQUEST_GRANTS.read) },
      ),
    );
  } catch (error) {
    if (capture.legacy !== undefined) return { pullRequests: capture.legacy };
    if (servedElsewhere(error, capture))
      return {
        pullRequests: await searchOpenPullRequestsForRepo(
          request.repoPath,
          request.query,
        ),
      };
    throw hostError(error);
  }
  if (capture.legacy === undefined)
    throw new Error('Pull request search projection was not captured.');
  return { pullRequests: capture.legacy };
}

/**
 * `github:resolve-pull-request`: the reference is parsed and bound to the
 * recorded repository's `origin` (read through `worker.git.remote.get`) with
 * today's messages, then read through `core.pullRequest.get` with today's
 * read-model call; the branch and fork checks run on the view the host read.
 */
export async function resolvePullRequestForIpc(
  dispatcher: GitHubPullRequestIpcDispatcher,
  resolveCaller: LazyCaller,
  request: ResolvePullRequestRequest,
): Promise<ResolvePullRequestResponse> {
  validateAbsolutePath(request.repoPath, 'repoPath');
  const recorded = await recordedRepository(request.repoPath);
  // Capability-exception debt (CAN-4109), as for the listing.
  if (!recorded)
    return resolvePullRequestForRepo(request.repoPath, request.reference);
  const parsed = parsePullRequestReferenceForResolver(request.reference);
  const caller = resolveCaller();
  const { remoteUrl } = await readRepositoryRemoteUrl(
    dispatcher,
    caller,
    request.repoPath,
  );
  const ref = bindPullRequestReference(parsed, remoteUrl);
  const pullRequestId = mintPullRequestId({
    repository: recorded.repository,
    github: { owner: ref.owner, repo: ref.repo },
    number: ref.number,
  });
  // An origin the canonical identifiers cannot name keeps the direct read.
  if (pullRequestId === null)
    return resolvePullRequestForRepo(request.repoPath, request.reference);
  const capture: PullRequestResolveCapture = {
    kind: 'resolve',
    repoPath: request.repoPath,
  };
  try {
    await runInGitHubProjection(capture, () =>
      dispatcher.query(
        'core.pullRequest.get',
        { pullRequestId, refresh: false },
        { caller: withGrant(caller, CORE_PULL_REQUEST_GRANTS.read) },
      ),
    );
  } catch (error) {
    if (capture.view === undefined) {
      if (servedElsewhere(error, capture))
        return resolvePullRequestForRepo(request.repoPath, request.reference);
      throw hostError(error);
    }
  }
  if (capture.view === undefined)
    throw new Error('Pull request resolution projection was not captured.');
  return pullRequestResolution(capture.view, ref);
}

/**
 * `github:get-repo-slug`: today's 5-minute per-path cache; a miss reads
 * `origin` as `repo:get-remote-url` does, through `worker.git.remote.get`
 * for a recorded path (D5), answering `null` on any failure.
 */
export async function getRepoSlugForIpc(
  dispatcher: GitHubPullRequestIpcDispatcher,
  resolveCaller: LazyCaller,
  request: GetRepoSlugRequest,
): Promise<GetRepoSlugResponse> {
  validateAbsolutePath(request.repoPath, 'repoPath');
  return getRepoSlugForRepoPath(
    request.repoPath,
    async (repoPath) =>
      (await readRepositoryRemoteUrl(dispatcher, resolveCaller(), repoPath))
        .remoteUrl,
  );
}

/**
 * `github:list-user-repos`: pages `core.integration.resource.list` (200 per
 * page) and returns the legacy rows of the snapshot the first page read, up
 * to 300, byte for byte.
 */
export async function listUserReposForIpc(
  dispatcher: GitHubPullRequestIpcDispatcher,
  resolveCaller: LazyCaller,
): Promise<GitHubRepoSummary[]> {
  const caller = withGrant(resolveCaller(), CORE_INTEGRATION_GRANTS.read);
  const capture: RepositoryListCapture = { kind: 'repositories' };
  try {
    await runInGitHubProjection(capture, async () => {
      let cursor: string | null = null;
      for (let page = 0; page < MAX_REPOSITORY_PAGES; page += 1) {
        const result: CoreIntegrationResourceListResult =
          await dispatcher.query(
            'core.integration.resource.list',
            {
              integrationId: GITHUB_INTEGRATION_ID,
              kinds: ['repository'],
              query: null,
              cursor,
              limit: REPOSITORY_PAGE,
            },
            { caller },
          );
        cursor = result.nextCursor;
        if (cursor === null) return;
      }
    });
  } catch (error) {
    // The first page's snapshot is the whole legacy answer; a later page
    // failing (its snapshot replaced, say) does not change it.
    if (capture.legacy !== undefined) return capture.legacy;
    throw hostError(error);
  }
  if (capture.legacy === undefined)
    throw new Error('Repository listing projection was not captured.');
  return capture.legacy;
}

/** RC-14: canonical and legacy reads share the broker and its 20-second cache. */
export async function getMergeQueueForIpc(
  dispatcher: CorePullRequestDispatcher,
  resolveCaller: LazyCaller,
  request: GitHubMergeQueueRequest,
): Promise<GitHubMergeQueueResponse> {
  validateGitHubMergeQueueRequest(request);
  try {
    return await dispatcher.query(
      'core.pullRequest.mergeQueue.get',
      { repository: request.repository, baseBranch: request.baseBranch },
      { caller: withGrant(resolveCaller(), CORE_PULL_REQUEST_GRANTS.read) },
    );
  } catch (error) {
    throw hostError(error);
  }
}
