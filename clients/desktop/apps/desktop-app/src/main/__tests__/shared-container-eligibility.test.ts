import type { SharedContainerEligibilityRequest } from '@canopy/desktop-shared/types';
import {
  getSharedContainerEligibility,
  getSharedContainerGithubReadiness,
  isSharedContainerGithubReady,
  prepareSharedContainerGithub,
  sanitizeGitFailure,
  type SharedContainerEligibilityDependencies,
  type SharedContainerGithubPreparationDependencies,
  type SharedContainerGithubReadinessDependencies,
} from '../shared-containers/eligibility';

const request: SharedContainerEligibilityRequest = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  organizationId: 'org-1',
  containerType: 'CODE_WORKTREE',
};

function dependencies(
  overrides: Partial<SharedContainerEligibilityDependencies> = {},
): SharedContainerEligibilityDependencies {
  return {
    readAccount: () =>
      Promise.resolve({
        status: 'ok',
        entry: {
          apiKey: 'secret',
          authMode: 'oauth',
          capabilities: [],
          organizations: [
            { id: 'org-1', name: 'Org One', createdAt: '', updatedAt: '' },
          ],
          createdAt: '',
          updatedAt: '',
        },
      }),
    loadBillingStates: () => Promise.resolve([]),
    resolveLapsedOrganizationNames: () => Promise.resolve([]),
    supportsSharedContainers: () => Promise.resolve(true),
    loadEnforcement: () => Promise.resolve(new Map()),
    readPreferences: () =>
      Promise.resolve({
        telemetrySharing: {
          metadata: 'private',
          transcripts: 'off',
          plans: 'off',
          summaries: 'off',
        },
      }),
    resolveServerWorktreeExternalId: () => 'server-worktree-1',
    resolveSharedContainerAnchorConflictOrganizationId: () => null,
    refreshWorktreeMetadata: () => Promise.resolve(),
    flushWorktreeNow: () => Promise.resolve(),
    waitForRegistrationRetry: () => Promise.resolve(),
    getGithubReadiness: () => Promise.resolve({ status: 'ready' as const }),
    recordProbeFailure: jest.fn(),
    // Organization-only behavior unless a case opts into external sharing.
    isExternalSharingEnabled: () => false,
    readWorkspaceOwner: () => Promise.resolve(undefined),
    listSharedContainerAnchorKeys: () => [],
    ...overrides,
  };
}

function resolved<T>(value: T): () => Promise<T> {
  return () => Promise.resolve(value);
}

describe('shared-container eligibility', () => {
  it('fails closed when the secure cloud-account read is unavailable', async () => {
    const recordProbeFailure = jest.fn();

    await expect(
      getSharedContainerEligibility(
        request,
        dependencies({
          readAccount: () =>
            Promise.resolve({
              status: 'error',
              error: new Error('decrypt-failed'),
            }),
          recordProbeFailure,
        }),
      ),
    ).resolves.toEqual({ eligible: false, reason: 'account-unavailable' });
  });

  function repository(
    id: string,
    repoPath: string,
  ): {
    repoId: string;
    repoName: string;
    repoPath: string;
    relativePrefix: string;
  } {
    return {
      repoId: id,
      repoName: id,
      repoPath,
      relativePrefix: repoPath.includes('/repos/') ? `repos/${id}` : '',
    };
  }

  function readinessDeps(
    overrides: Partial<SharedContainerGithubReadinessDependencies> = {},
  ): SharedContainerGithubReadinessDependencies {
    const getRemoteUrl: (repoPath: string) => Promise<string | null> =
      overrides.getRemoteUrl ??
      ((): Promise<string> => Promise.resolve('git@github.com:acme/repo.git'));
    return {
      listRepositories: () =>
        Promise.resolve([repository('repo-a', '/worktree')]),
      getCurrentBranch: () => Promise.resolve('feature/test'),
      resolveHeadSha: () => Promise.resolve('head-sha'),
      getLiveOriginBranchSha: () => Promise.resolve('head-sha'),
      isAncestor: () => Promise.resolve(true),
      ...overrides,
      getRemoteUrl,
      // Git falls back to the fetch URL when `remote.origin.pushurl` is unset,
      // so the default mirrors whatever fetch URL the case under test uses.
      // Tests that care about a divergent push URL override this explicitly.
      getPushRemoteUrl: overrides.getPushRemoteUrl ?? getRemoteUrl,
    };
  }

  function preparationDeps(
    overrides: Partial<SharedContainerGithubPreparationDependencies> = {},
  ): SharedContainerGithubPreparationDependencies {
    return {
      ...readinessDeps(),
      pushBranch: () => Promise.resolve(),
      scheduleKnown: () => Promise.resolve(),
      recordFailure: jest.fn(),
      ...overrides,
    };
  }

  describe('github readiness classification', () => {
    it('reports ready when the live origin branch already matches HEAD', async () => {
      const isAncestor = jest.fn(() => Promise.resolve(true));

      await expect(
        getSharedContainerGithubReadiness(
          request,
          readinessDeps({ isAncestor }),
        ),
      ).resolves.toEqual({ status: 'ready' });
      // Identical SHAs short-circuit before any merge-base work.
      expect(isAncestor).not.toHaveBeenCalled();
    });

    it('reports ready when the remote already contains local HEAD', async () => {
      await expect(
        getSharedContainerGithubReadiness(
          request,
          readinessDeps({
            getLiveOriginBranchSha: () => Promise.resolve('remote-ahead-sha'),
            isAncestor: (_repoPath, ancestor) =>
              Promise.resolve(ancestor === 'head-sha'),
          }),
        ),
      ).resolves.toEqual({ status: 'ready' });
    });

    it('requires a push when the same-named remote branch is absent', async () => {
      const isAncestor = jest.fn(() => Promise.resolve(true));

      await expect(
        getSharedContainerGithubReadiness(
          request,
          readinessDeps({
            getLiveOriginBranchSha: () => Promise.resolve(null),
            isAncestor,
          }),
        ),
      ).resolves.toEqual({ status: 'push-required' });
      expect(isAncestor).not.toHaveBeenCalled();
    });

    it('requires a push when the remote branch is behind local HEAD', async () => {
      await expect(
        getSharedContainerGithubReadiness(
          request,
          readinessDeps({
            getLiveOriginBranchSha: () => Promise.resolve('behind-sha'),
            isAncestor: (_repoPath, ancestor) =>
              Promise.resolve(ancestor === 'behind-sha'),
          }),
        ),
      ).resolves.toEqual({ status: 'push-required' });
    });

    it('blocks diverged history instead of offering a push', async () => {
      await expect(
        getSharedContainerGithubReadiness(
          request,
          readinessDeps({
            getLiveOriginBranchSha: () => Promise.resolve('diverged-sha'),
            isAncestor: () => Promise.resolve(false),
          }),
        ),
      ).resolves.toEqual({ status: 'blocked', reason: 'diverged' });
    });

    const blockedCases: Array<
      [string, Partial<SharedContainerGithubReadinessDependencies>]
    > = [
      [
        'no-repositories',
        { listRepositories: (): Promise<[]> => Promise.resolve([]) },
      ],
      [
        'missing-origin',
        { getRemoteUrl: (): Promise<null> => Promise.resolve(null) },
      ],
      [
        'non-github-origin',
        {
          getRemoteUrl: (): Promise<string> =>
            Promise.resolve('https://gitlab.com/acme/repo.git'),
        },
      ],
      [
        'no-head',
        {
          resolveHeadSha: (): Promise<string> =>
            Promise.reject(new Error('unborn branch')),
        },
      ],
      [
        'no-branch',
        { getCurrentBranch: (): Promise<string> => Promise.resolve('HEAD') },
      ],
      [
        'unavailable',
        {
          getLiveOriginBranchSha: (): Promise<string | null> =>
            Promise.reject(new Error('fatal: could not read from remote')),
        },
      ],
    ];

    it.each(blockedCases)('blocks with %s', async (reason, overrides) => {
      await expect(
        getSharedContainerGithubReadiness(request, readinessDeps(overrides)),
      ).resolves.toEqual({ status: 'blocked', reason });
    });

    it('classifies an unborn branch as no-head rather than no-branch', async () => {
      await expect(
        getSharedContainerGithubReadiness(
          request,
          readinessDeps({
            getCurrentBranch: () =>
              Promise.reject(new Error('ambiguous argument HEAD')),
            resolveHeadSha: () => Promise.reject(new Error('unborn branch')),
          }),
        ),
      ).resolves.toEqual({ status: 'blocked', reason: 'no-head' });
    });

    it('blocks when the push URL points at a different host than the fetch URL', async () => {
      // `git push origin` honors `remote.origin.pushurl`. Validating only the
      // fetch URL would offer a recovery push that publishes the branch
      // somewhere other than the GitHub repository that was checked.
      await expect(
        getSharedContainerGithubReadiness(
          request,
          readinessDeps({
            getRemoteUrl: () => Promise.resolve('git@github.com:acme/repo.git'),
            getPushRemoteUrl: () =>
              Promise.resolve('https://gitlab.com/acme/repo.git'),
          }),
        ),
      ).resolves.toEqual({ status: 'blocked', reason: 'non-github-origin' });
    });

    it('blocks when the push URL is a different GitHub repository', async () => {
      await expect(
        getSharedContainerGithubReadiness(
          request,
          readinessDeps({
            getRemoteUrl: () => Promise.resolve('git@github.com:acme/repo.git'),
            getPushRemoteUrl: () =>
              Promise.resolve('git@github.com:someone-else/repo.git'),
          }),
        ),
      ).resolves.toEqual({ status: 'blocked', reason: 'non-github-origin' });
    });

    it('accepts a push URL that names the same repository in another form', async () => {
      await expect(
        getSharedContainerGithubReadiness(
          request,
          readinessDeps({
            getRemoteUrl: () => Promise.resolve('git@github.com:Acme/Repo.git'),
            getPushRemoteUrl: () =>
              Promise.resolve('https://github.com/acme/repo.git'),
          }),
        ),
      ).resolves.toEqual({ status: 'ready' });
    });

    it('never probes the live remote for a divergent push URL', async () => {
      const getLiveOriginBranchSha = jest.fn(() =>
        Promise.resolve('live-origin-sha'),
      );

      await expect(
        getSharedContainerGithubReadiness(
          request,
          readinessDeps({
            getPushRemoteUrl: () =>
              Promise.resolve('https://gitlab.com/acme/repo.git'),
            getLiveOriginBranchSha,
          }),
        ),
      ).resolves.toEqual({ status: 'blocked', reason: 'non-github-origin' });
      expect(getLiveOriginBranchSha).not.toHaveBeenCalled();
    });

    it('reports an inconclusive origin lookup as unavailable, not missing-origin', async () => {
      // A thrown lookup is an operational failure. Classifying it as
      // `missing-origin` would tell the user their repository has no origin
      // when it may simply not be inspectable right now.
      await expect(
        getSharedContainerGithubReadiness(
          request,
          readinessDeps({
            getRemoteUrl: () =>
              Promise.reject(new Error('fatal: could not read config')),
          }),
        ),
      ).resolves.toEqual({ status: 'blocked', reason: 'unavailable' });
    });

    it('reports an inconclusive push-URL lookup as unavailable', async () => {
      await expect(
        getSharedContainerGithubReadiness(
          request,
          readinessDeps({
            getPushRemoteUrl: () =>
              Promise.reject(new Error('fatal: could not read config')),
          }),
        ),
      ).resolves.toEqual({ status: 'blocked', reason: 'unavailable' });
    });

    it('never probes the live remote for a non-GitHub origin', async () => {
      const getLiveOriginBranchSha = jest.fn(() =>
        Promise.resolve('live-origin-sha'),
      );

      await expect(
        getSharedContainerGithubReadiness(
          request,
          readinessDeps({
            getRemoteUrl: () =>
              Promise.resolve('https://gitlab.com/acme/repo.git'),
            getLiveOriginBranchSha,
          }),
        ),
      ).resolves.toEqual({ status: 'blocked', reason: 'non-github-origin' });
      expect(getLiveOriginBranchSha).not.toHaveBeenCalled();
    });

    it('treats a non-code container as ready without touching git', async () => {
      const listRepositories = jest.fn(() => Promise.resolve([]));

      await expect(
        getSharedContainerGithubReadiness(
          { ...request, containerType: 'COWORK_WORK_ENTRY' },
          readinessDeps({ listRepositories }),
        ),
      ).resolves.toEqual({ status: 'ready' });
      expect(listRepositories).not.toHaveBeenCalled();
    });

    it('checks every child repository in a multi-repo worktree', async () => {
      const getRemoteUrl = jest.fn<Promise<string>, [string]>(() =>
        Promise.resolve('git@github.com:acme/repo.git'),
      );

      await expect(
        getSharedContainerGithubReadiness(
          request,
          readinessDeps({
            listRepositories: () =>
              Promise.resolve([
                repository('repo-a', '/worktree/repos/repo-a'),
                repository('repo-b', '/worktree/repos/repo-b'),
              ]),
            getRemoteUrl,
            getPushRemoteUrl: () =>
              Promise.resolve('git@github.com:acme/repo.git'),
          }),
        ),
      ).resolves.toEqual({ status: 'ready' });
      expect(getRemoteUrl.mock.calls.map(([repoPath]) => repoPath)).toEqual([
        '/worktree/repos/repo-a',
        '/worktree/repos/repo-b',
      ]);
    });

    it('requires a push when only one child repository is missing its branch', async () => {
      await expect(
        getSharedContainerGithubReadiness(
          request,
          readinessDeps({
            listRepositories: () =>
              Promise.resolve([
                repository('repo-a', '/worktree/repos/repo-a'),
                repository('repo-b', '/worktree/repos/repo-b'),
              ]),
            getLiveOriginBranchSha: (repoPath) =>
              Promise.resolve(repoPath.endsWith('repo-b') ? null : 'head-sha'),
          }),
        ),
      ).resolves.toEqual({ status: 'push-required' });
    });

    it('prefers a deterministic blocker over a transient probe failure', async () => {
      await expect(
        getSharedContainerGithubReadiness(
          request,
          readinessDeps({
            listRepositories: () =>
              Promise.resolve([
                repository('repo-a', '/worktree/repos/repo-a'),
                repository('repo-b', '/worktree/repos/repo-b'),
              ]),
            getRemoteUrl: (repoPath) =>
              Promise.resolve(
                repoPath.endsWith('repo-a')
                  ? 'https://gitlab.com/acme/repo.git'
                  : 'git@github.com:acme/repo.git',
              ),
          }),
        ),
      ).resolves.toEqual({ status: 'blocked', reason: 'non-github-origin' });
    });

    it('rejects a stale local tracking ref when the live branch is gone', async () => {
      await expect(
        isSharedContainerGithubReady(
          request,
          readinessDeps({
            getLiveOriginBranchSha: () => Promise.resolve(null),
          }),
        ),
      ).resolves.toBe(false);
    });

    it('starts independent repository readiness probes concurrently', async () => {
      let releaseFirstProbe: (() => void) | undefined;
      const firstProbe = new Promise<void>((resolve) => {
        releaseFirstProbe = resolve;
      });
      const getLiveOriginBranchSha = jest.fn((repoPath: string) =>
        repoPath.endsWith('repo-a')
          ? firstProbe.then(() => 'head-sha')
          : Promise.resolve('head-sha'),
      );

      const readiness = getSharedContainerGithubReadiness(
        request,
        readinessDeps({
          listRepositories: () =>
            Promise.resolve([
              repository('repo-a', '/worktree/repos/repo-a'),
              repository('repo-b', '/worktree/repos/repo-b'),
            ]),
          getLiveOriginBranchSha,
        }),
      );

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(getLiveOriginBranchSha).toHaveBeenCalledTimes(2);
      releaseFirstProbe?.();
      await expect(readiness).resolves.toEqual({ status: 'ready' });
    });

    it('limits concurrent repository readiness probes', async () => {
      let releaseProbes: (() => void) | undefined;
      const probeGate = new Promise<void>((resolve) => {
        releaseProbes = resolve;
      });
      let activeProbes = 0;
      let maximumActiveProbes = 0;
      const repositories = Array.from({ length: 8 }, (_, index) =>
        repository(`repo-${index}`, `/worktree/repos/repo-${index}`),
      );

      const readiness = getSharedContainerGithubReadiness(
        request,
        readinessDeps({
          listRepositories: () => Promise.resolve(repositories),
          getLiveOriginBranchSha: async () => {
            activeProbes += 1;
            maximumActiveProbes = Math.max(maximumActiveProbes, activeProbes);
            await probeGate;
            activeProbes -= 1;
            return 'head-sha';
          },
        }),
      );

      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseProbes?.();

      await expect(readiness).resolves.toEqual({ status: 'ready' });
      expect(maximumActiveProbes).toBe(4);
    });
  });

  describe('github preparation', () => {
    it('pushes the same-named branch and reports ready', async () => {
      const pushBranch = jest.fn<Promise<void>, [string, string]>(() =>
        Promise.resolve(),
      );
      let pushed = false;

      await expect(
        prepareSharedContainerGithub(
          request,
          preparationDeps({
            getLiveOriginBranchSha: () =>
              Promise.resolve(pushed ? 'head-sha' : null),
            pushBranch: (repoPath, branchName) => {
              pushed = true;
              return pushBranch(repoPath, branchName);
            },
          }),
        ),
      ).resolves.toEqual({ status: 'ready' });
      expect(pushBranch).toHaveBeenCalledWith('/worktree', 'feature/test');
      expect(pushBranch).toHaveBeenCalledTimes(1);
    });

    it('reports ready after a successful push when publication scheduling fails', async () => {
      let pushed = false;
      const recordFailure = jest.fn();

      await expect(
        prepareSharedContainerGithub(
          request,
          preparationDeps({
            getLiveOriginBranchSha: () =>
              Promise.resolve(pushed ? 'head-sha' : null),
            pushBranch: () => {
              pushed = true;
              return Promise.resolve();
            },
            scheduleKnown: () =>
              Promise.reject(new Error('state store unavailable')),
            recordFailure,
          }),
        ),
      ).resolves.toEqual({ status: 'ready' });
      expect(recordFailure).toHaveBeenCalledWith('schedule', expect.any(Error));
    });

    it('is a no-op when the branch is already on GitHub', async () => {
      const pushBranch = jest.fn(() => Promise.resolve());

      await expect(
        prepareSharedContainerGithub(request, preparationDeps({ pushBranch })),
      ).resolves.toEqual({ status: 'ready' });
      expect(pushBranch).not.toHaveBeenCalled();
    });

    it('re-probes at click time so stale renderer state cannot authorize a push', async () => {
      const pushBranch = jest.fn(() => Promise.resolve());

      await expect(
        prepareSharedContainerGithub(
          request,
          preparationDeps({
            getLiveOriginBranchSha: () => Promise.resolve('diverged-sha'),
            isAncestor: () => Promise.resolve(false),
            pushBranch,
          }),
        ),
      ).resolves.toEqual({
        status: 'blocked',
        readiness: { status: 'blocked', reason: 'diverged' },
      });
      expect(pushBranch).not.toHaveBeenCalled();
    });

    it('pushes every child repository that needs a branch and skips ready ones', async () => {
      const pushed = new Set<string>();
      const pushBranch = jest.fn((repoPath: string) => {
        pushed.add(repoPath);
        return Promise.resolve();
      });

      await expect(
        prepareSharedContainerGithub(
          request,
          preparationDeps({
            listRepositories: () =>
              Promise.resolve([
                repository('repo-a', '/worktree/repos/repo-a'),
                repository('repo-b', '/worktree/repos/repo-b'),
                repository('repo-c', '/worktree/repos/repo-c'),
              ]),
            getLiveOriginBranchSha: (repoPath) =>
              Promise.resolve(
                repoPath.endsWith('repo-a') || pushed.has(repoPath)
                  ? 'head-sha'
                  : null,
              ),
            pushBranch,
          }),
        ),
      ).resolves.toEqual({ status: 'ready' });
      expect(pushBranch.mock.calls.map(([repoPath]) => repoPath)).toEqual([
        '/worktree/repos/repo-b',
        '/worktree/repos/repo-c',
      ]);
    });

    it('verifies only the repositories it actually pushed', async () => {
      // Repositories that were already `ready` in the preflight were not
      // touched, so re-probing them spends a remote round trip re-deriving an
      // answer this call did not change.
      const pushedBranches = new Set<string>();
      const probedRepoPaths: string[] = [];

      await expect(
        prepareSharedContainerGithub(
          request,
          preparationDeps({
            listRepositories: () =>
              Promise.resolve([
                repository('repo-a', '/worktree/repos/repo-a'),
                repository('repo-b', '/worktree/repos/repo-b'),
              ]),
            getLiveOriginBranchSha: (repoPath) => {
              probedRepoPaths.push(repoPath);
              if (repoPath.endsWith('repo-a'))
                return Promise.resolve('head-sha');
              return Promise.resolve(
                pushedBranches.has(repoPath) ? 'head-sha' : null,
              );
            },
            pushBranch: (repoPath) => {
              pushedBranches.add(repoPath);
              return Promise.resolve();
            },
          }),
        ),
      ).resolves.toEqual({ status: 'ready' });

      // Preflight probes both; the post-push verification revisits only the
      // repository that was pushed.
      expect(probedRepoPaths).toEqual([
        '/worktree/repos/repo-a',
        '/worktree/repos/repo-b',
        '/worktree/repos/repo-b',
      ]);
    });

    it('pushes nothing when any child repository has a configuration blocker', async () => {
      const pushBranch = jest.fn(() => Promise.resolve());

      await expect(
        prepareSharedContainerGithub(
          request,
          preparationDeps({
            listRepositories: () =>
              Promise.resolve([
                repository('repo-a', '/worktree/repos/repo-a'),
                repository('repo-b', '/worktree/repos/repo-b'),
              ]),
            getRemoteUrl: (repoPath) =>
              Promise.resolve(
                repoPath.endsWith('repo-b') ? null : 'git@github.com:a/b.git',
              ),
            getLiveOriginBranchSha: () => Promise.resolve(null),
            pushBranch,
          }),
        ),
      ).resolves.toEqual({
        status: 'blocked',
        readiness: { status: 'blocked', reason: 'missing-origin' },
      });
      expect(pushBranch).not.toHaveBeenCalled();
    });

    it('reports a bounded failure when the push is rejected', async () => {
      const recordFailure = jest.fn();

      await expect(
        prepareSharedContainerGithub(
          request,
          preparationDeps({
            getLiveOriginBranchSha: () => Promise.resolve(null),
            pushBranch: () =>
              Promise.reject(
                new Error('fatal: could not read Username for https://x'),
              ),
            recordFailure,
          }),
        ),
      ).resolves.toEqual({ status: 'failed' });
      expect(recordFailure).toHaveBeenCalledWith('push', expect.any(Error));
    });

    it('stops at the first push failure so a retry can re-probe', async () => {
      const pushBranch = jest.fn(() => Promise.reject(new Error('denied')));

      await expect(
        prepareSharedContainerGithub(
          request,
          preparationDeps({
            listRepositories: () =>
              Promise.resolve([
                repository('repo-a', '/worktree/repos/repo-a'),
                repository('repo-b', '/worktree/repos/repo-b'),
              ]),
            getLiveOriginBranchSha: () => Promise.resolve(null),
            pushBranch,
          }),
        ),
      ).resolves.toEqual({ status: 'failed' });
      expect(pushBranch).toHaveBeenCalledTimes(1);
    });

    it('retries idempotently, pushing only what still needs it', async () => {
      const pushedRepoPaths: string[] = [];
      let failNext = true;
      const deps = preparationDeps({
        listRepositories: () =>
          Promise.resolve([
            repository('repo-a', '/worktree/repos/repo-a'),
            repository('repo-b', '/worktree/repos/repo-b'),
          ]),
        getLiveOriginBranchSha: (repoPath) =>
          Promise.resolve(
            pushedRepoPaths.includes(repoPath) ? 'head-sha' : null,
          ),
        pushBranch: (repoPath) => {
          if (failNext && repoPath.endsWith('repo-b')) {
            return Promise.reject(new Error('transport failure'));
          }
          pushedRepoPaths.push(repoPath);
          return Promise.resolve();
        },
      });

      await expect(
        prepareSharedContainerGithub(request, deps),
      ).resolves.toEqual({ status: 'failed' });
      expect(pushedRepoPaths).toEqual(['/worktree/repos/repo-a']);

      failNext = false;
      await expect(
        prepareSharedContainerGithub(request, deps),
      ).resolves.toEqual({ status: 'ready' });
      expect(pushedRepoPaths).toEqual([
        '/worktree/repos/repo-a',
        '/worktree/repos/repo-b',
      ]);
    });

    it('blocks instead of pushing when the preflight probe is inconclusive', async () => {
      const pushBranch = jest.fn(() => Promise.resolve());
      const recordFailure = jest.fn();

      await expect(
        prepareSharedContainerGithub(
          request,
          preparationDeps({
            getLiveOriginBranchSha: () =>
              Promise.reject(new Error('timed out')),
            pushBranch,
            recordFailure,
          }),
        ),
      ).resolves.toEqual({
        status: 'blocked',
        readiness: { status: 'blocked', reason: 'unavailable' },
      });
      expect(pushBranch).not.toHaveBeenCalled();
      expect(recordFailure).toHaveBeenCalledWith(
        'preflight',
        expect.any(Error),
      );
    });

    it('coalesces duplicate requests into a single in-flight push', async () => {
      let releasePush: (() => void) | undefined;
      const pushGate = new Promise<void>((resolve) => {
        releasePush = resolve;
      });
      let pushed = false;
      const pushBranch = jest.fn(async () => {
        await pushGate;
        pushed = true;
      });
      const deps = preparationDeps({
        getLiveOriginBranchSha: () =>
          Promise.resolve(pushed ? 'head-sha' : null),
        pushBranch,
      });

      const first = prepareSharedContainerGithub(request, deps);
      const second = prepareSharedContainerGithub(request, deps);
      expect(second).toBe(first);

      await new Promise<void>((resolve) => setImmediate(resolve));
      releasePush?.();

      await expect(first).resolves.toEqual({ status: 'ready' });
      await expect(second).resolves.toEqual({ status: 'ready' });
      expect(pushBranch).toHaveBeenCalledTimes(1);

      // The in-flight entry is released, so a later request runs fresh.
      await expect(
        prepareSharedContainerGithub(request, deps),
      ).resolves.toEqual({ status: 'ready' });
      expect(pushBranch).toHaveBeenCalledTimes(1);
    });

    it('redacts embedded remote credentials from git failures', () => {
      expect(
        sanitizeGitFailure(
          new Error(
            'fatal: unable to access https://user:ghp_secret@github.com/a/b.git',
          ),
        ),
      ).toBe('fatal: unable to access https://<redacted>@github.com/a/b.git');
    });

    it('bounds an oversized git failure message', () => {
      expect(sanitizeGitFailure(new Error('x'.repeat(5000)))).toHaveLength(500);
    });
  });

  it.each([
    [
      'no-cloud-account',
      { readAccount: resolved({ status: 'ok' as const, entry: null }) },
    ],
    [
      'guest-account',
      {
        readAccount: resolved({
          status: 'ok',
          entry: {
            apiKey: 'secret',
            authMode: 'guest',
            capabilities: [],
            organizations: [
              { id: 'org-1', name: 'Org One', createdAt: '', updatedAt: '' },
            ],
            createdAt: '',
            updatedAt: '',
          },
        }),
      },
    ],
    [
      'no-organization',
      {
        readAccount: resolved({
          status: 'ok',
          entry: {
            apiKey: 'secret',
            capabilities: [],
            organizations: [],
            createdAt: '',
            updatedAt: '',
          },
        }),
      },
    ],
    ['unsupported-capability', { supportsSharedContainers: resolved(false) }],
    [
      'sync-disabled',
      {
        readPreferences: resolved({
          telemetrySharing: {
            metadata: 'off',
            transcripts: 'private',
            plans: 'private',
            summaries: 'private',
          },
        }),
      },
    ],
  ])('returns %s', async (reason, overrides) => {
    await expect(
      getSharedContainerEligibility(
        request,
        dependencies(
          overrides as Partial<SharedContainerEligibilityDependencies>,
        ),
      ),
    ).resolves.toMatchObject({ eligible: false, reason });
  });

  it.each([
    { status: 'push-required' as const },
    { status: 'blocked' as const, reason: 'diverged' as const },
    { status: 'blocked' as const, reason: 'no-branch' as const },
    { status: 'blocked' as const, reason: 'no-repositories' as const },
    { status: 'blocked' as const, reason: 'missing-origin' as const },
    { status: 'blocked' as const, reason: 'non-github-origin' as const },
    { status: 'blocked' as const, reason: 'no-head' as const },
  ])('does not gate sharing on GitHub readiness %#', async (readiness) => {
    await expect(
      getSharedContainerEligibility(
        request,
        dependencies({ getGithubReadiness: resolved(readiness) }),
      ),
    ).resolves.toEqual({
      eligible: true,
      serverWorktreeExternalId: 'server-worktree-1',
    });
  });

  it('blocks metadata prohibited by an organization and preserves attribution', async () => {
    const result = await getSharedContainerEligibility(
      request,
      dependencies({
        loadEnforcement: () =>
          Promise.resolve(
            new Map([
              [
                'org-1',
                {
                  organizationName: 'Policy Org',
                  enforcement: {
                    required: {
                      metadata: false,
                      transcripts: false,
                      plans: false,
                      summaries: false,
                    },
                    prohibited: {
                      metadata: true,
                      transcripts: false,
                      plans: false,
                      summaries: false,
                    },
                  },
                },
              ],
            ]),
          ),
      }),
    );
    expect(result).toEqual({
      eligible: false,
      reason: 'sync-blocked-by-org',
      blockedByOrganizationNames: ['Policy Org'],
      serverWorktreeExternalId: 'server-worktree-1',
    });
  });

  it('allows an owner-required metadata scope when the saved preference is off', async () => {
    await expect(
      getSharedContainerEligibility(
        request,
        dependencies({
          loadEnforcement: () =>
            Promise.resolve(
              new Map([
                [
                  'org-1',
                  {
                    organizationName: 'Policy Org',
                    enforcement: {
                      required: {
                        metadata: true,
                        transcripts: false,
                        plans: false,
                        summaries: false,
                      },
                      prohibited: {
                        metadata: false,
                        transcripts: false,
                        plans: false,
                        summaries: false,
                      },
                    },
                  },
                ],
              ]),
            ),
          readPreferences: () =>
            Promise.resolve({
              telemetrySharing: {
                metadata: 'off',
                transcripts: 'off',
                plans: 'off',
                summaries: 'off',
              },
            }),
        }),
      ),
    ).resolves.toEqual({
      eligible: true,
      serverWorktreeExternalId: 'server-worktree-1',
    });
  });

  it('ignores a non-owner organization metadata prohibition', async () => {
    await expect(
      getSharedContainerEligibility(
        request,
        dependencies({
          loadEnforcement: () =>
            Promise.resolve(
              new Map([
                [
                  'org-2',
                  {
                    organizationName: 'Other Org',
                    enforcement: {
                      required: {
                        metadata: false,
                        transcripts: false,
                        plans: false,
                        summaries: false,
                      },
                      prohibited: {
                        metadata: true,
                        transcripts: false,
                        plans: false,
                        summaries: false,
                      },
                    },
                  },
                ],
              ]),
            ),
        }),
      ),
    ).resolves.toMatchObject({ eligible: true });
  });

  it('preserves the known server worktree when invite creation is blocked', async () => {
    await expect(
      getSharedContainerEligibility(
        request,
        dependencies({
          readPreferences: () =>
            Promise.resolve({
              telemetrySharing: {
                metadata: 'off',
                transcripts: 'private',
                plans: 'private',
                summaries: 'private',
              },
            }),
        }),
      ),
    ).resolves.toEqual({
      eligible: false,
      reason: 'sync-disabled',
      serverWorktreeExternalId: 'server-worktree-1',
    });
  });

  it('blocks when every org is explicitly not teams-entitled', async () => {
    const result = await getSharedContainerEligibility(
      request,
      dependencies({
        loadBillingStates: () =>
          Promise.resolve([
            {
              organizationId: 'org-1',
              organizationName: 'Org One',
              teamsEntitled: false,
            },
          ]),
      }),
    );
    expect(result).toMatchObject({
      eligible: false,
      reason: 'blocked-by-org-billing',
      blockedByOrganizationNames: ['Org One'],
    });
  });

  it('checks the selected organization before GitHub preflight work', async () => {
    const resolveSelectedBilling = jest.fn(() => Promise.resolve(['Org One']));
    const getGithubReadiness = jest.fn(() =>
      Promise.resolve({ status: 'ready' as const }),
    );
    const overrides = {
      // The account-wide visibility snapshot still says at least one org is
      // usable, but the selected org lapses before the final preflight step.
      loadBillingStates: () => Promise.resolve([]),
      resolveLapsedOrganizationNames: resolveSelectedBilling,
      getGithubReadiness,
    } as Partial<SharedContainerEligibilityDependencies> & {
      resolveLapsedOrganizationNames: (ids: string[]) => Promise<string[]>;
    };

    await expect(
      getSharedContainerEligibility(request, dependencies(overrides)),
    ).resolves.toEqual({
      eligible: false,
      reason: 'blocked-by-org-billing',
      blockedByOrganizationNames: ['Org One'],
      serverWorktreeExternalId: 'server-worktree-1',
    });
    expect(resolveSelectedBilling).toHaveBeenCalledWith(['org-1']);
    expect(getGithubReadiness).not.toHaveBeenCalled();
  });

  it('does not gate sharing on a live GitHub readiness probe', async () => {
    const getGithubReadiness = jest.fn(() =>
      Promise.reject(new Error('network unavailable')),
    );

    await expect(
      getSharedContainerEligibility(
        request,
        dependencies({ getGithubReadiness }),
      ),
    ).resolves.toEqual({
      eligible: true,
      serverWorktreeExternalId: 'server-worktree-1',
    });
    expect(getGithubReadiness).not.toHaveBeenCalled();
  });

  it('retries registration with the explicitly selected organization', async () => {
    const resolve = jest.fn(() => null);
    const refresh = jest.fn(() => Promise.resolve());
    const flush = jest.fn(() => Promise.resolve());
    const waitForRegistrationRetry = jest.fn(() => Promise.resolve());
    const result = await getSharedContainerEligibility(
      request,
      dependencies({
        resolveServerWorktreeExternalId: resolve,
        refreshWorktreeMetadata: refresh,
        flushWorktreeNow: flush,
        waitForRegistrationRetry,
      }),
    );
    expect(result).toMatchObject({ eligible: false, reason: 'not-yet-synced' });
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledWith('project-1', 'worktree-1', 'org-1');
    expect(flush).toHaveBeenCalledTimes(3);
    expect(resolve).toHaveBeenCalledTimes(4);
    expect(waitForRegistrationRetry).toHaveBeenCalledTimes(2);
  });

  it('separates a failed registration flush from a pending registration', async () => {
    await expect(
      getSharedContainerEligibility(
        request,
        dependencies({
          resolveServerWorktreeExternalId: () => null,
          flushWorktreeNow: () => Promise.reject(new Error('offline')),
        }),
      ),
    ).resolves.toMatchObject({
      eligible: false,
      reason: 'registration-failed',
    });
  });

  it('becomes eligible when a Personal-context flush creates a private anchor for organization-scoped preferences', async () => {
    const resolve = jest
      .fn<
        ReturnType<
          SharedContainerEligibilityDependencies['resolveServerWorktreeExternalId']
        >,
        Parameters<
          SharedContainerEligibilityDependencies['resolveServerWorktreeExternalId']
        >
      >()
      .mockReturnValueOnce(null)
      .mockReturnValue('private-worktree-external-id');
    const refresh = jest.fn(() => Promise.resolve());
    const flush = jest.fn(() => Promise.resolve());

    await expect(
      getSharedContainerEligibility(
        request,
        dependencies({
          readPreferences: () =>
            Promise.resolve({
              telemetrySharing: {
                metadata: 'organization',
                transcripts: 'organization',
                plans: 'organization',
                summaries: 'organization',
              },
            }),
          resolveServerWorktreeExternalId: resolve,
          refreshWorktreeMetadata: refresh,
          flushWorktreeNow: flush,
        }),
      ),
    ).resolves.toEqual({
      eligible: true,
      serverWorktreeExternalId: 'private-worktree-external-id',
    });
    expect(refresh).toHaveBeenCalledWith('project-1', 'worktree-1', 'org-1');
    expect(flush).toHaveBeenCalledWith('project-1', 'worktree-1');
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('reports a permanent organization anchor conflict honestly', async () => {
    const resolve = jest.fn(() => null);
    const conflict = jest.fn(() => 'org-2');

    await expect(
      getSharedContainerEligibility(
        request,
        dependencies({
          readAccount: () =>
            Promise.resolve({
              status: 'ok',
              entry: {
                apiKey: 'secret',
                authMode: 'oauth',
                capabilities: [],
                organizations: [
                  {
                    id: 'org-1',
                    name: 'Org One',
                    createdAt: '',
                    updatedAt: '',
                  },
                  {
                    id: 'org-2',
                    name: 'Org Two',
                    createdAt: '',
                    updatedAt: '',
                  },
                ],
                createdAt: '',
                updatedAt: '',
              },
            }),
          resolveServerWorktreeExternalId: resolve,
          resolveSharedContainerAnchorConflictOrganizationId: conflict,
        }),
      ),
    ).resolves.toEqual({
      eligible: false,
      reason: 'anchored-to-other-organization',
      blockedByOrganizationNames: ['Org Two'],
    });
    expect(conflict).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'org-1',
      [],
    );
  });

  it('refuses a legacy multi-anchor container when the requested owner is absent', async () => {
    await expect(
      getSharedContainerEligibility(
        request,
        dependencies({
          isExternalSharingEnabled: () => true,
          readAccount: resolved({
            status: 'ok' as const,
            entry: {
              apiKey: 'secret',
              authMode: 'oauth' as const,
              capabilities: [],
              organizations: [
                { id: 'org-1', name: 'Org One', createdAt: '', updatedAt: '' },
                { id: 'org-2', name: 'Org Two', createdAt: '', updatedAt: '' },
                {
                  id: 'org-3',
                  name: 'Org Three',
                  createdAt: '',
                  updatedAt: '',
                },
              ],
              createdAt: '',
              updatedAt: '',
            },
          }),
          listSharedContainerAnchorKeys: () => ['org-2', 'org-3'],
        }),
      ),
    ).resolves.toEqual({
      eligible: false,
      reason: 'anchored-to-other-organization',
      blockedByOrganizationNames: ['Org Two', 'Org Three'],
    });
  });

  it('keeps the requested owner when it is one of several legacy anchors', async () => {
    await expect(
      getSharedContainerEligibility(
        request,
        dependencies({
          isExternalSharingEnabled: () => true,
          listSharedContainerAnchorKeys: () => ['org-2', 'org-1'],
        }),
      ),
    ).resolves.toMatchObject({
      eligible: true,
      ownerOrganizationId: 'org-1',
      ownerFixed: true,
    });
  });

  it('requires metadata only; all content telemetry scopes may remain off', async () => {
    await expect(
      getSharedContainerEligibility(request, dependencies()),
    ).resolves.toEqual({
      eligible: true,
      serverWorktreeExternalId: 'server-worktree-1',
    });
  });

  it('resolves legacy team-scoped metadata only for teams in the selected organization', async () => {
    const resolveServerWorktreeExternalId = jest.fn(
      () => 'team-server-worktree-1',
    );
    const readAccount = resolved({
      status: 'ok' as const,
      entry: {
        apiKey: 'secret',
        authMode: 'oauth' as const,
        capabilities: [],
        organizations: [
          { id: 'org-1', name: 'Org One', createdAt: '', updatedAt: '' },
        ],
        teams: [
          {
            id: 'team-selected',
            name: 'Selected',
            createdAt: '',
            updatedAt: '',
            organization: {
              id: 'org-1',
              name: 'Org One',
              createdAt: '',
              updatedAt: '',
            },
          },
          {
            id: 'team-other',
            name: 'Other',
            createdAt: '',
            updatedAt: '',
            organization: {
              id: 'org-2',
              name: 'Org Two',
              createdAt: '',
              updatedAt: '',
            },
          },
        ],
        createdAt: '',
        updatedAt: '',
      },
    });

    await expect(
      getSharedContainerEligibility(
        request,
        dependencies({ readAccount, resolveServerWorktreeExternalId }),
      ),
    ).resolves.toMatchObject({
      eligible: true,
      serverWorktreeExternalId: 'team-server-worktree-1',
    });
    expect(resolveServerWorktreeExternalId).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'org-1',
      ['team-selected'],
    );
  });

  it('fails closed when organization enforcement is unavailable', async () => {
    const recordProbeFailure = jest.fn();
    await expect(
      getSharedContainerEligibility(
        request,
        dependencies({
          loadEnforcement: () =>
            Promise.reject(new Error('temporary read failure')),
          recordProbeFailure,
        }),
      ),
    ).resolves.toMatchObject({
      eligible: false,
      reason: 'sync-blocked-by-org',
    });
    expect(recordProbeFailure).toHaveBeenCalledWith(
      'telemetry-enforcement',
      expect.any(Error),
    );
  });

  it('fails open and records an inconclusive capability probe', async () => {
    const recordProbeFailure = jest.fn();
    await expect(
      getSharedContainerEligibility(
        request,
        dependencies({
          supportsSharedContainers: () =>
            Promise.reject(new Error('temporary capability read failure')),
          recordProbeFailure,
        }),
      ),
    ).resolves.toMatchObject({ eligible: true });
    expect(recordProbeFailure).toHaveBeenCalledWith(
      'shared-containers-capability',
      expect.any(Error),
    );
  });
  describe('external sharing', () => {
    const organization = (
      id: string,
      name: string,
      allowExternalContainerSharing?: boolean,
    ): {
      id: string;
      name: string;
      createdAt: string;
      updatedAt: string;
      allowExternalContainerSharing?: boolean;
    } => ({
      id,
      name,
      createdAt: '',
      updatedAt: '',
      ...(allowExternalContainerSharing !== undefined
        ? { allowExternalContainerSharing }
        : {}),
    });

    function accountWith(
      organizations: ReturnType<typeof organization>[],
      teams?: {
        id: string;
        name: string;
        organization: ReturnType<typeof organization>;
        createdAt: string;
        updatedAt: string;
      }[],
    ): SharedContainerEligibilityDependencies['readAccount'] {
      return () =>
        Promise.resolve({
          status: 'ok',
          entry: {
            apiKey: 'secret',
            authMode: 'oauth',
            capabilities: [],
            organizations,
            ...(teams ? { teams } : {}),
            createdAt: '',
            updatedAt: '',
          },
        });
    }

    it('offers a user with no organization Public only, as a personal container', async () => {
      const resolve = jest
        .fn<
          ReturnType<
            SharedContainerEligibilityDependencies['resolveServerWorktreeExternalId']
          >,
          Parameters<
            SharedContainerEligibilityDependencies['resolveServerWorktreeExternalId']
          >
        >()
        .mockReturnValueOnce(null)
        .mockReturnValue('private-worktree');
      const refresh = jest.fn(() => Promise.resolve());
      const resolveLapsed = jest.fn(() => Promise.resolve([]));

      await expect(
        getSharedContainerEligibility(
          {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            containerType: 'CODE_WORKTREE',
            audience: 'public',
          },
          dependencies({
            isExternalSharingEnabled: () => true,
            readAccount: accountWith([]),
            resolveServerWorktreeExternalId: resolve,
            refreshWorktreeMetadata: refresh,
            resolveLapsedOrganizationNames: resolveLapsed,
          }),
        ),
      ).resolves.toEqual({
        eligible: true,
        serverWorktreeExternalId: 'private-worktree',
        audiences: { team: false, organization: false, public: true },
        link: { anyone: true, organization: false },
        ownerFixed: false,
      });
      // A personal container registers through the user-owned target and is
      // never gated on organization billing.
      expect(resolve).toHaveBeenCalledWith(
        'project-1',
        'worktree-1',
        undefined,
        [],
      );
      expect(refresh).toHaveBeenCalledWith('project-1', 'worktree-1', null);
      expect(resolveLapsed).not.toHaveBeenCalled();
    });

    it('reports sync-disabled for a personal container whose metadata sharing is Off', async () => {
      const resolve = jest.fn(() => null);
      const refresh = jest.fn(() => Promise.resolve());
      const waitForRegistrationRetry = jest.fn(() => Promise.resolve());

      await expect(
        getSharedContainerEligibility(
          {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            containerType: 'CODE_WORKTREE',
            audience: 'public',
          },
          dependencies({
            isExternalSharingEnabled: () => true,
            readAccount: accountWith([]),
            resolveServerWorktreeExternalId: resolve,
            refreshWorktreeMetadata: refresh,
            waitForRegistrationRetry,
            readPreferences: () =>
              Promise.resolve({
                telemetrySharing: {
                  metadata: 'off',
                  transcripts: 'off',
                  plans: 'off',
                  summaries: 'off',
                },
              }),
          }),
        ),
      ).resolves.toEqual({
        eligible: false,
        reason: 'sync-disabled',
        audiences: { team: false, organization: false, public: true },
        link: { anyone: true, organization: false },
        ownerFixed: false,
      });
      // Registration would never queue with metadata Off, so it is not tried.
      expect(refresh).not.toHaveBeenCalled();
      expect(waitForRegistrationRetry).not.toHaveBeenCalled();
    });

    it('keeps the known server worktree when a personal container has metadata Off', async () => {
      await expect(
        getSharedContainerEligibility(
          {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            containerType: 'CODE_WORKTREE',
            audience: 'public',
          },
          dependencies({
            isExternalSharingEnabled: () => true,
            readAccount: accountWith([]),
            readPreferences: () =>
              Promise.resolve({
                telemetrySharing: {
                  metadata: 'off',
                  transcripts: 'private',
                  plans: 'private',
                  summaries: 'private',
                },
              }),
          }),
        ),
      ).resolves.toMatchObject({
        eligible: false,
        reason: 'sync-disabled',
        serverWorktreeExternalId: 'server-worktree-1',
      });
    });

    it('does not apply organization metadata policy to a personal container', async () => {
      await expect(
        getSharedContainerEligibility(
          {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            containerType: 'CODE_WORKTREE',
            audience: 'public',
          },
          dependencies({
            isExternalSharingEnabled: () => true,
            readAccount: accountWith([]),
            loadEnforcement: () =>
              Promise.resolve(
                new Map([
                  [
                    'former-org',
                    {
                      organizationName: 'Former Org',
                      enforcement: {
                        required: {
                          metadata: false,
                          transcripts: false,
                          plans: false,
                          summaries: false,
                        },
                        prohibited: {
                          metadata: true,
                          transcripts: false,
                          plans: false,
                          summaries: false,
                        },
                      },
                    },
                  ],
                ]),
              ),
            readPreferences: () =>
              Promise.resolve({
                telemetrySharing: {
                  metadata: 'private',
                  transcripts: 'off',
                  plans: 'off',
                  summaries: 'off',
                },
              }),
          }),
        ),
      ).resolves.toEqual({
        eligible: true,
        serverWorktreeExternalId: 'server-worktree-1',
        audiences: { team: false, organization: false, public: true },
        link: { anyone: true, organization: false },
        ownerFixed: false,
      });
    });

    it('keeps no-organization while the external-sharing flag is off', async () => {
      await expect(
        getSharedContainerEligibility(
          {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            containerType: 'CODE_WORKTREE',
            audience: 'public',
          },
          dependencies({ readAccount: accountWith([]) }),
        ),
      ).resolves.toEqual({ eligible: false, reason: 'no-organization' });
    });

    it('disables Public for an organization-owned workspace whose organization keeps sharing inside', async () => {
      const readAccount = accountWith([
        organization('org-1', 'Org One', false),
      ]);
      const readWorkspaceOwner = (): ReturnType<
        SharedContainerEligibilityDependencies['readWorkspaceOwner']
      > =>
        Promise.resolve({
          type: 'organization',
          organizationId: 'org-1',
          projectId: '00000000-0000-4000-8000-000000000001',
          instanceId: '00000000-0000-4000-8000-000000000002',
          bindingGeneration: 0,
        });

      await expect(
        getSharedContainerEligibility(
          { ...request, audience: 'organization' },
          dependencies({
            isExternalSharingEnabled: () => true,
            readAccount,
            readWorkspaceOwner,
          }),
        ),
      ).resolves.toEqual({
        eligible: true,
        serverWorktreeExternalId: 'server-worktree-1',
        audiences: { team: true, organization: true, public: false },
        link: { anyone: false, organization: true },
        publicBlockedReason: 'external-sharing-disabled',
        ownerOrganizationId: 'org-1',
        ownerFixed: true,
      });
      await expect(
        getSharedContainerEligibility(
          { ...request, audience: 'public' },
          dependencies({
            isExternalSharingEnabled: () => true,
            readAccount,
            readWorkspaceOwner,
          }),
        ),
      ).resolves.toMatchObject({
        eligible: false,
        reason: 'external-sharing-disabled',
        ownerOrganizationId: 'org-1',
      });
    });

    it('offers Public for an organization-owned container once the organization allows it', async () => {
      await expect(
        getSharedContainerEligibility(
          { ...request, audience: 'public' },
          dependencies({
            isExternalSharingEnabled: () => true,
            readAccount: accountWith([organization('org-1', 'Org One', true)]),
            readWorkspaceOwner: () =>
              Promise.resolve({
                type: 'organization',
                organizationId: 'org-1',
                projectId: '00000000-0000-4000-8000-000000000001',
                instanceId: '00000000-0000-4000-8000-000000000002',
                bindingGeneration: 0,
              }),
          }),
        ),
      ).resolves.toMatchObject({
        eligible: true,
        audiences: { public: true },
        ownerOrganizationId: 'org-1',
        ownerFixed: true,
      });
    });

    it('fixes the owner to the organization-owned workspace, not the picked organization', async () => {
      const resolve = jest.fn(() => 'server-worktree-1');
      const resolveLapsed = jest.fn(() => Promise.resolve([]));

      await expect(
        getSharedContainerEligibility(
          { ...request, organizationId: 'org-2', audience: 'organization' },
          dependencies({
            isExternalSharingEnabled: () => true,
            readAccount: accountWith([
              organization('org-1', 'Org One'),
              organization('org-2', 'Org Two'),
            ]),
            readWorkspaceOwner: () =>
              Promise.resolve({
                type: 'organization',
                organizationId: 'org-1',
                projectId: '00000000-0000-4000-8000-000000000001',
                instanceId: '00000000-0000-4000-8000-000000000002',
                bindingGeneration: 0,
              }),
            resolveServerWorktreeExternalId: resolve,
            resolveLapsedOrganizationNames: resolveLapsed,
          }),
        ),
      ).resolves.toMatchObject({
        eligible: true,
        ownerOrganizationId: 'org-1',
        ownerFixed: true,
      });
      expect(resolve).toHaveBeenCalledWith(
        'project-1',
        'worktree-1',
        'org-1',
        [],
      );
      expect(resolveLapsed).toHaveBeenCalledWith(['org-1']);
    });

    it('keeps an already-personal container personal', async () => {
      const resolve = jest.fn(() => 'private-worktree');

      await expect(
        getSharedContainerEligibility(
          { ...request, audience: 'organization' },
          dependencies({
            isExternalSharingEnabled: () => true,
            listSharedContainerAnchorKeys: () => ['personal'],
            resolveServerWorktreeExternalId: resolve,
          }),
        ),
      ).resolves.toEqual({
        eligible: true,
        serverWorktreeExternalId: 'private-worktree',
        audiences: { team: false, organization: false, public: true },
        link: { anyone: true, organization: false },
        ownerFixed: true,
      });
      expect(resolve).toHaveBeenCalledWith(
        'project-1',
        'worktree-1',
        undefined,
        [],
      );
    });

    it('keeps an organization anchor as the owner, even for Public', async () => {
      await expect(
        getSharedContainerEligibility(
          { ...request, audience: 'public' },
          dependencies({
            isExternalSharingEnabled: () => true,
            readAccount: accountWith([organization('org-1', 'Org One', true)]),
            listSharedContainerAnchorKeys: () => ['org-1'],
          }),
        ),
      ).resolves.toMatchObject({
        eligible: true,
        audiences: { organization: true, public: true },
        ownerOrganizationId: 'org-1',
        ownerFixed: true,
      });
    });

    it('offers Team only when the user has a team in that organization', async () => {
      const otherOrganization = organization('org-2', 'Org Two');
      await expect(
        getSharedContainerEligibility(
          { ...request, audience: 'organization' },
          dependencies({
            isExternalSharingEnabled: () => true,
            readAccount: accountWith(
              [organization('org-1', 'Org One'), otherOrganization],
              [
                {
                  id: 'team-other',
                  name: 'Other',
                  organization: otherOrganization,
                  createdAt: '',
                  updatedAt: '',
                },
              ],
            ),
          }),
        ),
      ).resolves.toMatchObject({
        eligible: true,
        audiences: { team: false, organization: true, public: true },
        ownerOrganizationId: 'org-1',
        ownerFixed: false,
      });
    });

    it('does not gate a new personal container on organization billing', async () => {
      await expect(
        getSharedContainerEligibility(
          { ...request, audience: 'public' },
          dependencies({
            isExternalSharingEnabled: () => true,
            loadBillingStates: () =>
              Promise.resolve([
                {
                  organizationId: 'org-1',
                  organizationName: 'Org One',
                  teamsEntitled: false,
                },
              ]),
            resolveLapsedOrganizationNames: () => Promise.resolve(['Org One']),
          }),
        ),
      ).resolves.toMatchObject({ eligible: true, ownerFixed: false });
    });
  });
});
