import type {
  CorePullRequest,
  CorePullRequestCreateParams,
  CorePullRequestGetParams,
  CorePullRequestListParams,
  CorePullRequestListResult,
  CorePullRequestUpdateParams,
  CoreIntegrationResourceListParams,
  CoreIntegrationResourceListResult,
} from '@canopy/protocol/canopy-core';
import type {
  CanopyInstructionOptions,
  CanopyQueryOptions,
} from '@canopy/core-runtime';
import {
  createCorePullRequestHandlers,
  createCorePullRequestInstructionHandlers,
  createPullRequestReceipts,
  isGitHubRepositoryRef,
  type CorePullRequestHandlers,
  type CorePullRequestHost,
  type CorePullRequestInstructionHandlers,
  type PullRequestWriteReceipt,
} from '@canopy/core-runtime/node/github';
import { desktopGitHubRequestHandle } from '../github/request-handle';
import { currentGitHubProjection } from '../github/projection-capture';
import { getRemoteUrl } from '../lib/git';
import { parseGitHubRemote } from '../lib/github-pr';
import { IdentifierValidationError } from '../lib/identifier-validation-error';
import { isWritableScope } from '../lib/read-only-scope';
import { validateId, validateOptionalRepoId } from '../lib/validation';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import { recordedRepositoryPath } from '../lib/workspace-recorded-repo';

/** The dispatcher surface the `core.pullRequest.*` projections use. */
export interface CorePullRequestDispatcher {
  query(
    name: 'core.pullRequest.get',
    params: CorePullRequestGetParams,
    options: CanopyQueryOptions,
  ): Promise<CorePullRequest>;
  query(
    name: 'core.pullRequest.list',
    params: CorePullRequestListParams,
    options: CanopyQueryOptions,
  ): Promise<CorePullRequestListResult>;
  query(
    name: 'core.integration.resource.list',
    params: CoreIntegrationResourceListParams,
    options: CanopyQueryOptions,
  ): Promise<CoreIntegrationResourceListResult>;
  instruction(
    name: 'core.pullRequest.create',
    params: CorePullRequestCreateParams,
    options: CanopyInstructionOptions,
  ): Promise<CorePullRequest>;
  instruction(
    name: 'core.pullRequest.update',
    params: CorePullRequestUpdateParams,
    options: CanopyInstructionOptions,
  ): Promise<CorePullRequest>;
}

/** The record's repository path, or `null` for ids no record can hold. */
async function recordedPath(
  workspaceId: string,
  repoId: string | undefined,
): Promise<string | null> {
  try {
    validateId(workspaceId, 'workspaceId');
    validateOptionalRepoId(repoId, 'repoId');
  } catch (error) {
    if (error instanceof IdentifierValidationError) return null;
    throw error;
  }
  return recordedRepositoryPath(await readWorkspaceConfig(workspaceId), repoId);
}

/**
 * The desktop host for `core.pullRequest.*`: workspace records locate the
 * repository, and its `origin` (read as today's pull-request reads read it)
 * names the GitHub repository. Inside a projection it records where it
 * resolved the repository, so the projection can tell a changed record.
 */
export const desktopCorePullRequestHost: CorePullRequestHost = {
  github: desktopGitHubRequestHandle,
  resolveRepository: async ({ workspaceId, repoId }, access) => {
    // The shared-container viewer is read-only (assertWritableScope's rule).
    if (access === 'write' && !isWritableScope(workspaceId)) return null;
    const repoPath = await recordedPath(workspaceId, repoId);
    if (repoPath === null) return null;
    const capture = currentGitHubProjection();
    if (capture?.kind === 'list' || capture?.kind === 'resolve')
      capture.resolvedRepoPath = repoPath;
    const remoteUrl = await getRemoteUrl(repoPath);
    const remote = remoteUrl ? parseGitHubRemote(remoteUrl) : null;
    return remote && isGitHubRepositoryRef(remote.owner, remote.repo)
      ? remote
      : null;
  },
};

/**
 * `core.pullRequest.*` handlers over the desktop host. The adapter holds the
 * keyed write receipts: bounded, in memory, one store per dispatcher (D9).
 */
export function createCorePullRequestAdapter(
  host: CorePullRequestHost = desktopCorePullRequestHost,
): {
  queries: CorePullRequestHandlers;
  instructions: CorePullRequestInstructionHandlers;
} {
  return {
    queries: createCorePullRequestHandlers(host),
    instructions: createCorePullRequestInstructionHandlers(host, {
      receipts: createPullRequestReceipts<PullRequestWriteReceipt>(),
    }),
  };
}
