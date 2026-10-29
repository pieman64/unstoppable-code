import type {
  ArchivedContainerManifestV2,
  ArchivedGitRepositoryState,
  ArchivedPullRequestRepositoryCapture,
  ArchivedPullRequestState,
} from '../../types';

const ARCHIVED_AT = '2026-07-02T00:00:00.000Z';

function repositoryState(
  repoId: string,
  repoName: string,
  index: number,
  multiRepository: boolean,
): ArchivedGitRepositoryState {
  const digit = String(index).slice(-1);
  return {
    repoId,
    repoName,
    relativePath: multiRepository ? `repos/${repoId}` : '.',
    referenceRepoPath: `/private/repos/${repoName}`,
    branchName: 'feature/archive',
    comparisonBaseBranch: 'main',
    baseBranchCommit: 'f'.repeat(40 - digit.length) + digit,
    comparisonBaseCommit: digit.repeat(40),
    headCommit: String(index + 1)
      .slice(-1)
      .repeat(40),
    indexSnapshotCommit: String(index + 2)
      .slice(-1)
      .repeat(40),
    worktreeSnapshotCommit: String(index + 3)
      .slice(-1)
      .repeat(40),
    snapshotRef: `refs/app/archived-containers/workspace-1/archive-1/${repoId}`,
  };
}

function manifestWithRepositories(
  repositories: ArchivedGitRepositoryState[],
  pullRequestRepositories: ArchivedPullRequestRepositoryCapture[],
): ArchivedContainerManifestV2 {
  const workspaceType =
    repositories.length === 1 ? 'single-repo' : 'multi-repo';
  return {
    version: 2,
    kind: 'worktree',
    id: 'archive-1',
    projectId: 'workspace-1',
    name: 'feature/archive',
    createdAt: '2026-07-01T00:00:00.000Z',
    archivedAt: ARCHIVED_AT,
    retentionDays: 7,
    expiresAt: '2026-07-09T00:00:00.000Z',
    chatCount: 2,
    archivedChatCount: 1,
    executionCount: 3,
    branchName: 'feature/archive',
    workspaceType,
    restoredTo: {
      kind: 'worktree',
      id: 'restored-1',
      restoredAt: '2026-07-03T00:00:00.000Z',
      createdAt: '2026-07-03T00:00:00.000Z',
    },
    originalWorktree: {
      id: 'archive-1',
      branchName: 'feature/archive',
      createdAt: '2026-07-01T00:00:00.000Z',
    },
    gitState: {
      version: 1,
      diffFormatVersion: 1,
      repositories,
    },
    gitChanges: {
      status: 'complete',
      capturedAt: ARCHIVED_AT,
      fileCount: repositories.length,
      insertions: repositories.length * 6,
      deletions: repositories.length * 2,
      repositories: repositories.map((repository) => ({
        repoId: repository.repoId,
        repoName: repository.repoName,
        fileCount: 1,
        insertions: 6,
        deletions: 2,
      })),
    },
    pullRequestMetadata: {
      capturedAt: ARCHIVED_AT,
      repositories: pullRequestRepositories,
    },
  };
}

/** Valid single-repository capture after GitHub confirmed no matching PR. */
export function buildConfirmedNoneArchiveManifest(): ArchivedContainerManifestV2 {
  const repository = repositoryState('__single_repo__', 'client', 1, false);
  return manifestWithRepositories(
    [repository],
    [
      {
        repoId: repository.repoId,
        repoName: repository.repoName,
        status: 'complete',
        pullRequest: null,
      },
    ],
  );
}

/** Valid single-repository capture containing one immutable PR snapshot. */
export function buildOnePullRequestArchiveManifest(
  state: ArchivedPullRequestState = 'open',
): ArchivedContainerManifestV2 {
  const repository = repositoryState('__single_repo__', 'client', 1, false);
  return manifestWithRepositories(
    [repository],
    [
      {
        repoId: repository.repoId,
        repoName: repository.repoName,
        status: 'complete',
        pullRequest: {
          number: 42,
          url: 'https://github.com/acme/client/pull/42',
          title: 'Preserve archived pull request metadata',
          state,
          baseRefName: 'main',
          updatedAt: '2026-07-01T23:59:00.000Z',
        },
      },
    ],
  );
}

/** Valid multi-repository capture covering PR, confirmed-none, and unavailable. */
export function buildMixedPullRequestArchiveManifest(): ArchivedContainerManifestV2 {
  const repositories = [
    repositoryState('api', 'service-api', 1, true),
    repositoryState('web', 'service-web', 4, true),
    repositoryState('docs', 'service-docs', 7, true),
  ];
  return manifestWithRepositories(repositories, [
    {
      repoId: 'api',
      repoName: 'service-api',
      status: 'complete',
      pullRequest: {
        number: 101,
        url: 'https://github.com/acme/service-api/pull/101',
        title: 'Archive API changes',
        state: 'draft',
        baseRefName: 'develop',
        updatedAt: '2026-07-01T22:00:00.000Z',
      },
    },
    {
      repoId: 'web',
      repoName: 'service-web',
      status: 'complete',
      pullRequest: null,
    },
    {
      repoId: 'docs',
      repoName: 'service-docs',
      status: 'unavailable',
    },
  ]);
}
