jest.mock('../pipelines/config-paths', () => ({
  getEnhancedEnv: jest.fn(() => ({})),
}));

jest.mock('../lib/paths', () => ({
  getWorktreeDataDir: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/tmp/canopy-data/${projectId}/${worktreeId}`,
  ),
}));

const mockHandleHookTriggeredEvent = jest.fn();

jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    handleHookTriggeredEvent: mockHandleHookTriggeredEvent,
  })),
}));

import type { PersistedPrSnapshotFileV1 } from '@canopy/desktop-shared/types/github';
import {
  buildHookWatcherVariables,
  fireHookTriggeredWatchers,
} from '../lib/hook-watcher-events';

describe('hook watcher events', () => {
  beforeEach(() => {
    mockHandleHookTriggeredEvent.mockReset();
  });

  it('strips brand prefixes from hook watcher variables', () => {
    const variables = buildHookWatcherVariables({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      scope: 'project',
      env: {
        CANOPY_PR_NUMBER: '123',
        CANOPY_WORKTREE_PRECOMMIT_FAILURE_COMMIT_MESSAGE: 'feat: test',
        CANOPY_WORKTREE_PRECOMMIT_FAILURE_ERROR: 'pre-commit failed',
      },
    });

    expect(variables).toMatchObject({
      WORKSPACE_ID: 'project-1',
      WORKTREE_NAME: 'worktree-1',
      PR_NUMBER: '123',
      WORKTREE_PRECOMMIT_FAILURE_COMMIT_MESSAGE: 'feat: test',
      WORKTREE_PRECOMMIT_FAILURE_ERROR: 'pre-commit failed',
    });
    expect(variables).not.toHaveProperty('CANOPY_PR_NUMBER');
    expect(variables).not.toHaveProperty(
      'CANOPY_WORKTREE_PRECOMMIT_FAILURE_COMMIT_MESSAGE',
    );
  });

  it('adds merge queue variables for the merge queue triggers only', () => {
    const currentSnapshot: PersistedPrSnapshotFileV1 = {
      version: 1,
      provider: 'github',
      capturedAt: '2026-04-09T00:00:00.000Z',
      includesComments: true,
      includesReviews: true,
      includesReviewComments: true,
      repository: { owner: 'acme', name: 'repo', fullName: 'acme/repo' },
      branch: {
        currentName: 'feature-1',
        headRefName: 'feature-1',
        baseRefName: 'main',
        headSha: 'head',
        baseSha: 'base',
      },
      pr: {
        id: 100,
        number: 42,
        nodeId: null,
        htmlUrl: 'https://github.com/acme/repo/pull/42',
        apiUrl: null,
        state: 'open',
        isDraft: false,
        title: 'Test PR',
        body: '',
        author: null,
        createdAt: '2026-04-09T00:00:00.000Z',
        updatedAt: '2026-04-09T00:00:00.000Z',
        mergedAt: null,
        closedAt: null,
        mergeCommitSha: null,
        mergedBy: null,
        isCrossRepository: false,
        labels: [],
        assignees: [],
        requestedReviewers: [],
      },
      issueComments: [],
      reviews: [],
      reviewComments: [],
      mergeQueue: {
        required: true,
        membership: {
          inQueue: false,
          entryId: null,
          enqueuedAt: null,
          position: null,
        },
        lastRemoved: {
          entryId: 'MQE_1',
          removedAt: null,
          reason: null,
          evidence: 'membership',
          requeued: false,
          observedAt: '2026-04-09T00:00:00.000Z',
        },
      },
    };
    const variablesFor = (triggerName: string): Record<string, string> =>
      buildHookWatcherVariables({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: 'project',
        triggerName,
        currentSnapshot,
        currentSnapshotPath: '/tmp/current.json',
      });

    expect(variablesFor('pr:queue:removed')).toMatchObject({
      PR_NUMBER: '42',
      PR_QUEUE_ENTRY_ID: 'MQE_1',
      PR_QUEUE_REMOVAL_REASON: '',
    });
    const other = variablesFor('pr:checks:fail');
    expect(other).toHaveProperty('PR_NUMBER', '42');
    expect(other).not.toHaveProperty('PR_QUEUE_ENTRY_ID');
    expect(other).not.toHaveProperty('PR_QUEUE_REMOVAL_REASON');
  });

  it('contains watcher dispatch failures for fire-and-forget calls', async () => {
    const rejectedPromise = Promise.reject(new Error('write failed'));
    const catchSpy = jest.spyOn(rejectedPromise, 'catch');
    mockHandleHookTriggeredEvent.mockReturnValue(rejectedPromise);

    fireHookTriggeredWatchers({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      triggerName: 'pr:update',
      scope: 'project',
      configured: true,
      paused: false,
      variables: {},
    });

    expect(mockHandleHookTriggeredEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        triggerName: 'pr:update',
      }),
    );
    expect(catchSpy).toHaveBeenCalledWith(expect.any(Function));
    await expect(catchSpy.mock.results[0]?.value).resolves.toBeUndefined();
  });
});
