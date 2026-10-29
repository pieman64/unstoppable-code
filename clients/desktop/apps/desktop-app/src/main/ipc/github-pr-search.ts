import type { SearchPullRequestsResponse } from '@canopy/desktop-shared/types';
import { normalizePullRequestTitleQuery } from '@canopy/desktop-shared/lib/pull-request-search';
import { validateAbsolutePath } from '../lib/validation';
import { searchOpenPullRequestsForRepo } from '../lib/github-pr-listing';

/** Validate the untrusted IPC envelope before entering the GitHub service. */
export async function handleSearchPullRequestsRequest(
  request: unknown,
): Promise<SearchPullRequestsResponse> {
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    !('repoPath' in request) ||
    typeof request.repoPath !== 'string' ||
    !('query' in request) ||
    typeof request.query !== 'string'
  ) {
    throw new Error('Invalid pull request search request.');
  }
  validateAbsolutePath(request.repoPath, 'repoPath');
  normalizePullRequestTitleQuery(request.query);
  const pullRequests = await searchOpenPullRequestsForRepo(
    request.repoPath,
    request.query,
  );
  return { pullRequests };
}
