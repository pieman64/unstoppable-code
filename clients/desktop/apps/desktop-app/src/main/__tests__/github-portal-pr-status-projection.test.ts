jest.mock('../lib/validation', () => ({
  validateId: jest.fn(),
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
}));

jest.mock('../lib/workspace-registry', () => ({
  isMultiRepoWorkspace: jest.fn(),
}));

jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(),
}));

jest.mock('../lib/git', () => ({
  getCurrentBranch: jest.fn(),
  getDiffStats: jest.fn(),
  getFullDiff: jest.fn(),
  getCommitLog: jest.fn(),
  pushBranch: jest.fn(),
  getRemoteDefaultBranch: jest.fn(),
  hasUncommittedChanges: jest.fn(),
  hasCommitsAhead: jest.fn(),
  hasRemoteTrackingBranch: jest.fn(),
  hasUnpushedCommits: jest.fn(),
  stageAllChanges: jest.fn(),
  commitWithMessage: jest.fn(),
  getUncommittedDiff: jest.fn(),
}));

jest.mock('../lib/github-pr', () => ({
  createPrForRepo: jest.fn(),
  updatePrBaseBranchForRepo: jest.fn(),
}));

jest.mock('../lib/github-repo-listing', () => ({
  listUserRepos: jest.fn(),
}));

jest.mock('../lib/github-pr-generator', () => ({
  generatePrContent: jest.fn(),
}));

jest.mock('../lib/github-poller', () => ({
  refreshNow: jest.fn(() => Promise.resolve(null)),
  requestRefresh: jest.fn(),
  startPolling: jest.fn(),
  enqueueFastRefresh: jest.fn(),
  enqueueKnownPrFastRefresh: jest.fn(() => Promise.resolve(false)),
  setForegroundWorktree: jest.fn(),
}));

jest.mock('../lib/commit-message-generator', () => ({
  generateCommitMessage: jest.fn(),
}));

jest.mock('../lib/github-client', () => ({
  getGitHubClient: jest.fn(),
}));

jest.mock('../ipc/preferences', () => ({
  readPreferencesFile: jest.fn(),
}));

jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

jest.mock('../portal/portal-event-bus', () => ({
  isCanopyPortalActive: jest.fn(() => true),
  enqueuePortalEvent: jest.fn(),
  createPortalEvent: jest.fn((type: string, payload: unknown) => ({
    type,
    payload,
  })),
}));

import { emitWorktreePrStatusChange } from '../lib/pr-status-change-emitter';
import { enqueuePortalEvent } from '../portal/portal-event-bus';

const mockedEnqueuePortalEvent = jest.mocked(enqueuePortalEvent);

describe('GitHub handler registration', () => {
  beforeEach(() => {
    mockedEnqueuePortalEvent.mockClear();
  });

  beforeAll(async () => {
    const { getGitHubClient } = await import('../lib/github-client');
    jest.mocked(getGitHubClient).mockReturnValue({ enqueue: jest.fn() });
    const { registerGitHubHandlers } = await import('../ipc/github');
    registerGitHubHandlers(() => null, {
      // These tests reach no projected pull request read.
      dispatcher: {} as never,
      resolveCaller: () => {
        throw new Error('No projected pull request read in this test.');
      },
    });
  });

  it('projects desktop-polled PR status changes to the portal', () => {
    emitWorktreePrStatusChange('project-a', 'wt-1', {
      repos: [
        {
          repoId: 'repo',
          repoName: 'repo',
          status: {
            prNumber: 12,
            prUrl: 'https://github.com/acme/repo/pull/12',
            state: 'merged',
            title: 'Merged',
            checkStatus: 'passing',
            checkDetails: [],
            reviewStatus: 'approved',
            reviewers: [],
            hasConflicts: false,
            commentCount: 0,
            updatedAt: '2026-10-01T20:00:00.000Z',
          },
        },
      ],
      lastCheckedAt: '2026-10-01T20:00:00.000Z',
    });

    expect(mockedEnqueuePortalEvent).toHaveBeenCalledTimes(1);
    expect(mockedEnqueuePortalEvent.mock.calls[0][0]).toMatchObject({
      type: 'portal.state.delta',
      payload: {
        scope: 'pr',
        target: { workspaceLocalId: 'project-a', worktreeLocalId: 'wt-1' },
      },
    });
  });

  it('preserves unavailable lookup in a polled PR delta', () => {
    emitWorktreePrStatusChange('project-a', 'wt-1', {
      repos: [
        {
          repoId: 'repo',
          repoName: 'repo',
          status: null,
          prLookupAvailable: false,
        },
      ],
      lastCheckedAt: '2026-10-01T20:00:00.000Z',
    });

    expect(mockedEnqueuePortalEvent.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        entities: [
          {
            payload: {
              repos: [
                { repoId: 'repo', status: null, prLookupAvailable: false },
              ],
            },
          },
        ],
      },
    });
  });

  it('keeps a cached PR when a polled worktree has no lookup targets', () => {
    emitWorktreePrStatusChange('project-a', 'wt-1', {
      repos: [
        {
          repoId: 'repo',
          repoName: 'repo',
          status: {
            prNumber: 12,
            prUrl: 'https://github.com/acme/repo/pull/12',
            state: 'open',
            title: 'Open PR',
            checkStatus: 'passing',
            checkDetails: [],
            reviewStatus: 'approved',
            reviewers: [],
            hasConflicts: false,
            commentCount: 0,
            updatedAt: '2026-10-01T20:00:00.000Z',
          },
        },
      ],
      lastCheckedAt: '2026-10-01T20:00:00.000Z',
    });
    emitWorktreePrStatusChange('project-a', 'wt-1', null);

    expect(mockedEnqueuePortalEvent).toHaveBeenCalledTimes(1);
    expect(mockedEnqueuePortalEvent.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        entities: [{ payload: { repos: [{ status: { number: 12 } }] } }],
      },
    });
  });

  it('projects a confirmed PR removal after a successful lookup', () => {
    emitWorktreePrStatusChange('project-a', 'wt-1', {
      repos: [
        {
          repoId: 'repo',
          repoName: 'repo',
          status: null,
          prLookupAvailable: true,
        },
      ],
      lastCheckedAt: '2026-10-01T20:00:00.000Z',
    });

    expect(mockedEnqueuePortalEvent.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        entities: [
          { payload: { repos: [{ status: null, prLookupAvailable: true }] } },
        ],
      },
    });
  });
  // CAN-4876: remote clients stop polling for PR state, so each kind of
  // change the poller observes must reach them on its own.
  it.each([
    {
      change: 'checks',
      before: { checkStatus: 'pending' },
      after: { checkStatus: 'passing' },
      projected: { checkStatus: 'passing' },
    },
    {
      change: 'review',
      before: { reviewStatus: 'pending' },
      after: { reviewStatus: 'approved' },
      projected: { reviewStatus: 'approved' },
    },
    {
      change: 'merge state',
      before: { state: 'open' },
      after: { state: 'merged' },
      projected: { state: 'merged' },
    },
  ] as const)(
    'projects a $change-only change with the new value',
    ({ before, after, projected }) => {
      const status = (
        fields: object,
      ): Parameters<typeof emitWorktreePrStatusChange>[2] => ({
        repos: [
          {
            repoId: 'repo',
            repoName: 'repo',
            prLookupAvailable: true,
            status: {
              prNumber: 12,
              prUrl: 'https://github.com/acme/repo/pull/12',
              state: 'open' as const,
              title: 'Open PR',
              checkStatus: 'pending' as const,
              checkDetails: [],
              reviewStatus: 'pending' as const,
              reviewers: [],
              hasConflicts: false,
              commentCount: 0,
              updatedAt: '2026-01-01T00:00:00.000Z',
              ...fields,
            },
          },
        ],
        lastCheckedAt: '2026-10-01T20:00:00.000Z',
      });
      emitWorktreePrStatusChange('project-a', 'wt-1', status(before));
      emitWorktreePrStatusChange('project-a', 'wt-1', status(after));

      expect(mockedEnqueuePortalEvent).toHaveBeenCalledTimes(2);
      expect(mockedEnqueuePortalEvent.mock.calls[1]?.[0]).toMatchObject({
        type: 'portal.state.delta',
        payload: {
          scope: 'pr',
          entities: [
            {
              entityType: 'pr_status',
              payload: { repos: [{ repoId: 'repo', status: projected }] },
            },
          ],
        },
      });
    },
  );
});
