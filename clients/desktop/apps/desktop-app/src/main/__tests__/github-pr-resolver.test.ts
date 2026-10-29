import { resolvePullRequestForRepo } from '../lib/github-pr-resolver';
import { getRemoteUrl } from '../lib/git';
import {
  getGitHubPullRequestStatus,
  type GitHubPullRequestStatusView,
} from '../lib/github-pr-read-model';

jest.mock('../lib/git', () => ({
  getRemoteUrl: jest.fn(),
}));

jest.mock('../lib/github-pr-read-model', () => ({
  getGitHubPullRequestStatus: jest.fn(),
}));

const mockGetRemoteUrl = jest.mocked(getRemoteUrl);
const mockGetStatus = jest.mocked(getGitHubPullRequestStatus);

function pullRequest(
  overrides: Partial<GitHubPullRequestStatusView> = {},
): GitHubPullRequestStatusView {
  return {
    ref: { owner: 'example-org', repo: 'example-repo', number: 1825 },
    url: 'https://github.com/example-org/example-repo/pull/1825',
    title: 'Improve worktree setup performance',
    state: 'open',
    isDraft: false,
    headBranch: 'tirish/2026-07-22-worktree-setup-performance',
    baseBranch: 'develop',
    headSha: 'a'.repeat(40),
    headRepository: 'example-org/example-repo',
    mergeable: 'mergeable',
    reviewDecision: null,
    checks: {
      state: 'none',
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      failedNames: [],
      available: true,
    },
    mergeQueue: { inQueue: false, position: null },
    fetchedAt: '2026-10-13T12:00:00.000Z',
    ...overrides,
  };
}

describe('resolvePullRequestForRepo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves a bare number against the repo origin remote through the shared read model', async () => {
    mockGetRemoteUrl.mockResolvedValue(
      'git@github.com:example-org/example-repo.git',
    );
    mockGetStatus.mockResolvedValue(pullRequest());

    const resolved = await resolvePullRequestForRepo('/repo', '#1825');

    expect(mockGetStatus).toHaveBeenCalledWith(
      { owner: 'example-org', repo: 'example-repo', number: 1825 },
      { priority: 'interactive', caller: 'pr-resolver' },
    );
    expect(resolved).toEqual({
      number: 1825,
      title: 'Improve worktree setup performance',
      headRefName: 'tirish/2026-07-22-worktree-setup-performance',
      baseRefName: 'develop',
      url: 'https://github.com/example-org/example-repo/pull/1825',
    });
  });

  it('resolves a full PR URL when it matches the repo origin remote', async () => {
    mockGetRemoteUrl.mockResolvedValue(
      'git@github.com:example-org/example-repo.git',
    );
    mockGetStatus.mockResolvedValue(pullRequest());

    await resolvePullRequestForRepo(
      '/repo',
      'https://github.com/example-org/example-repo/pull/1825',
    );

    expect(mockGetStatus).toHaveBeenCalledWith(
      { owner: 'example-org', repo: 'example-repo', number: 1825 },
      { priority: 'interactive', caller: 'pr-resolver' },
    );
  });

  it('rejects a full PR URL for a different repository', async () => {
    mockGetRemoteUrl.mockResolvedValue(
      'git@github.com:example-org/example-repo.git',
    );
    mockGetStatus.mockResolvedValue(pullRequest());

    await expect(
      resolvePullRequestForRepo(
        '/repo',
        'https://github.com/other-org/other-repo/pull/1825',
      ),
    ).rejects.toThrow('does not belong to the selected repository');

    expect(mockGetStatus).not.toHaveBeenCalled();
  });

  it('rejects a PR whose head branch lives in a fork', async () => {
    mockGetRemoteUrl.mockResolvedValue(
      'git@github.com:example-org/example-repo.git',
    );
    mockGetStatus.mockResolvedValue(
      pullRequest({
        ref: { owner: 'example-org', repo: 'example-repo', number: 42 },
        headBranch: 'contributor/feature',
        headRepository: 'contributor/example-repo',
      }),
    );

    await expect(resolvePullRequestForRepo('/repo', '#42')).rejects.toThrow(
      'fork',
    );
  });

  it('rejects a PR whose fork head repo has been deleted', async () => {
    mockGetRemoteUrl.mockResolvedValue(
      'git@github.com:example-org/example-repo.git',
    );
    mockGetStatus.mockResolvedValue(
      pullRequest({
        ref: { owner: 'example-org', repo: 'example-repo', number: 43 },
        headBranch: 'contributor/feature',
        headRepository: null,
      }),
    );

    await expect(resolvePullRequestForRepo('/repo', '#43')).rejects.toThrow(
      'fork',
    );
  });

  it('rejects a PR without branch information', async () => {
    mockGetRemoteUrl.mockResolvedValue(
      'git@github.com:example-org/example-repo.git',
    );
    mockGetStatus.mockResolvedValue(pullRequest({ headBranch: '' }));

    await expect(resolvePullRequestForRepo('/repo', '#1825')).rejects.toThrow(
      'did not include branch information',
    );
  });

  it('resolves when the head repo name matches the target repo case-insensitively', async () => {
    mockGetRemoteUrl.mockResolvedValue(
      'git@github.com:example-org/example-repo.git',
    );
    mockGetStatus.mockResolvedValue(
      pullRequest({ headRepository: 'Example-Org/Example-Repo' }),
    );

    const resolved = await resolvePullRequestForRepo('/repo', '#1825');

    expect(resolved.headRefName).toBe(
      'tirish/2026-07-22-worktree-setup-performance',
    );
  });

  it('throws a parse error for non-PR input', async () => {
    await expect(
      resolvePullRequestForRepo('/repo', 'feature/foo'),
    ).rejects.toThrow('Could not parse');
  });

  it('throws a helpful error when a bare number has no GitHub remote', async () => {
    mockGetRemoteUrl.mockResolvedValue(null);
    await expect(resolvePullRequestForRepo('/repo', '#5')).rejects.toThrow(
      'no GitHub origin remote',
    );
  });
});
