/**
 * The readiness classification is normally tested through injected
 * dependencies, which cannot see which Git helper the production code actually
 * wires in. These tests mock `../lib/git` and call
 * `getSharedContainerGithubReadiness` with no dependency argument, so they pin
 * the DEFAULT wiring specifically.
 *
 * That distinction is the whole point: reading the origin through a
 * best-effort helper that swallows errors classified a transient Git failure
 * as `missing-origin`, and reading only the fetch URL let a repository whose
 * `remote.origin.pushurl` points elsewhere be offered a recovery push that
 * would publish the branch to a different host. Both bugs live in the default
 * dependency table, not in the probe logic.
 */
import type { SharedContainerEligibilityRequest } from '@canopy/desktop-shared/types';

const getRemoteUrlStrict = jest.fn<Promise<string | null>, [string]>();
const getPushRemoteUrlStrict = jest.fn<Promise<string | null>, [string]>();
const getRemoteUrl = jest.fn<Promise<string | null>, [string]>();
const getCurrentBranch = jest.fn<Promise<string>, [string]>();
const resolveRefSha = jest.fn<Promise<string>, [string, string]>();
const getLiveOriginBranchSha = jest.fn<
  Promise<string | null>,
  [string, string]
>();
const isAncestor = jest.fn<Promise<boolean>, [string, string, string]>();
const pushBranchToOriginNonInteractive = jest.fn<
  Promise<void>,
  [string, string]
>();

jest.mock('../lib/git', () => ({
  getRemoteUrl: (repoPath: string): Promise<string | null> =>
    getRemoteUrl(repoPath),
  getRemoteUrlStrict: (repoPath: string): Promise<string | null> =>
    getRemoteUrlStrict(repoPath),
  getPushRemoteUrlStrict: (repoPath: string): Promise<string | null> =>
    getPushRemoteUrlStrict(repoPath),
  getCurrentBranch: (repoPath: string): Promise<string> =>
    getCurrentBranch(repoPath),
  resolveRefSha: (repoPath: string, ref: string): Promise<string> =>
    resolveRefSha(repoPath, ref),
  getLiveOriginBranchSha: (
    repoPath: string,
    branchName: string,
  ): Promise<string | null> => getLiveOriginBranchSha(repoPath, branchName),
  isAncestor: (
    repoPath: string,
    ancestor: string,
    descendant: string,
  ): Promise<boolean> => isAncestor(repoPath, ancestor, descendant),
  pushBranchToOriginNonInteractive: (
    repoPath: string,
    branch: string,
  ): Promise<void> => pushBranchToOriginNonInteractive(repoPath, branch),
}));

interface StubLocalRepository {
  repoId: string;
  repoName: string;
  repoPath: string;
  relativePrefix: string;
}
const listSharedContainerLocalRepositories = jest.fn<
  Promise<StubLocalRepository[]>,
  [string, string]
>();
jest.mock('../shared-containers/local-repositories', () => ({
  listSharedContainerLocalRepositories: (
    projectId: string,
    worktreeId: string,
  ): Promise<StubLocalRepository[]> =>
    listSharedContainerLocalRepositories(projectId, worktreeId),
}));

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

import { getSharedContainerGithubReadiness } from '../shared-containers/eligibility';

describe('shared-container GitHub readiness default dependencies', () => {
  const request: SharedContainerEligibilityRequest = {
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    organizationId: 'org-1',
    containerType: 'CODE_WORKTREE',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    listSharedContainerLocalRepositories.mockResolvedValue([
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        repoPath: '/worktree',
        relativePrefix: '',
      },
    ]);
    getRemoteUrlStrict.mockResolvedValue('git@github.com:acme/repo.git');
    getPushRemoteUrlStrict.mockResolvedValue('git@github.com:acme/repo.git');
    getCurrentBranch.mockResolvedValue('feature/test');
    resolveRefSha.mockResolvedValue('head-sha');
    getLiveOriginBranchSha.mockResolvedValue('head-sha');
    isAncestor.mockResolvedValue(true);
  });

  it('reads the origin URL through the strict helper, never the swallowing one', async () => {
    await expect(getSharedContainerGithubReadiness(request)).resolves.toEqual({
      status: 'ready',
    });

    expect(getRemoteUrlStrict).toHaveBeenCalledWith('/worktree');
    // `getRemoteUrl` returns `null` on ANY failure, so using it here reports a
    // transient Git problem as a permanent "no origin configured".
    expect(getRemoteUrl).not.toHaveBeenCalled();
  });

  it('reports an operational origin lookup failure as unavailable, not missing-origin', async () => {
    getRemoteUrlStrict.mockRejectedValue(
      new Error('fatal: could not read config'),
    );

    await expect(getSharedContainerGithubReadiness(request)).resolves.toEqual({
      status: 'blocked',
      reason: 'unavailable',
    });
  });

  it('resolves the effective push URL, not just the fetch URL', async () => {
    await expect(getSharedContainerGithubReadiness(request)).resolves.toEqual({
      status: 'ready',
    });

    expect(getPushRemoteUrlStrict).toHaveBeenCalledWith('/worktree');
  });

  it('refuses to offer a push when origin pushes to a different host', async () => {
    // `git push origin` honors `remote.origin.pushurl`. Validating only the
    // fetch URL would offer recovery for a repository whose push would land
    // somewhere other than the GitHub repository that was checked.
    getPushRemoteUrlStrict.mockResolvedValue(
      'https://gitlab.com/acme/repo.git',
    );

    await expect(getSharedContainerGithubReadiness(request)).resolves.toEqual({
      status: 'blocked',
      reason: 'non-github-origin',
    });
    expect(getLiveOriginBranchSha).not.toHaveBeenCalled();
  });
});
