import type { TrackedPlanData } from '@canopy/desktop-shared/types';
import type * as PlanPersistenceModule from '../lib/plan-persistence';
import type * as SharedPlanSyncModule from '../lib/shared-plan-sync';

type AppendPlanCommentReply =
  typeof PlanPersistenceModule.appendPlanCommentReply;
type WaitForSubmittedPlanCommentThread =
  typeof PlanPersistenceModule.waitForSubmittedPlanCommentThread;
type QueueSharedPlanSync = typeof SharedPlanSyncModule.queueSharedPlanSync;

const mockAppendPlanCommentReply = jest.fn<
  ReturnType<AppendPlanCommentReply>,
  Parameters<AppendPlanCommentReply>
>();
const mockWaitForSubmittedPlanCommentThread = jest.fn<
  ReturnType<WaitForSubmittedPlanCommentThread>,
  Parameters<WaitForSubmittedPlanCommentThread>
>();
const mockQueueSharedPlanSync = jest.fn<
  ReturnType<QueueSharedPlanSync>,
  Parameters<QueueSharedPlanSync>
>();
const mockSendToAllWindows = jest.fn();

jest.mock('../lib/plan-persistence', () => ({
  PLAN_COMMENT_HANDOFF_GRACE_MS: 5_000,
  appendPlanCommentReply: (
    ...args: Parameters<AppendPlanCommentReply>
  ): ReturnType<AppendPlanCommentReply> => mockAppendPlanCommentReply(...args),
  waitForSubmittedPlanCommentThread: (
    ...args: Parameters<WaitForSubmittedPlanCommentThread>
  ): ReturnType<WaitForSubmittedPlanCommentThread> =>
    mockWaitForSubmittedPlanCommentThread(...args),
}));

jest.mock('../lib/shared-plan-sync', () => ({
  queueSharedPlanSync: (...args: Parameters<QueueSharedPlanSync>): void => {
    mockQueueSharedPlanSync(...args);
  },
}));

jest.mock('../lib/window-send', () => ({
  sendToAllWindows: (...args: unknown[]): void => {
    mockSendToAllWindows(...args);
  },
}));

import type { AppendPlanCommentReplyResult } from '../lib/plan-persistence';
import {
  replyToPlanCommentThread,
  type ReplyToPlanCommentThreadRequest,
} from '../lib/plan-comment-reply';

function sharedPlan(): TrackedPlanData {
  return {
    id: 'plan-1',
    projectId: 'project',
    worktreeId: 'worktree',
    source: 'claude',
    title: 'Ship the plan panel',
    content: '# Ship the plan panel\n',
    reviewStatus: 'pending',
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T01:00:00.000Z',
    latestRevisionNumber: 2,
    revisions: [],
    linkedExecutionIds: [],
    share: {
      serverId: 'canopy-cloud',
      remoteId: 'remote-plan-1',
      shareScope: 'team',
      teamId: 'team-1',
      syncStatus: 'synced',
    },
  };
}

const NOT_SUBMITTED: AppendPlanCommentReplyResult = {
  ok: false,
  reason: 'not-submitted',
  error: 'Comment thread has not been submitted.',
};

const REQUEST: ReplyToPlanCommentThreadRequest = {
  projectId: 'project',
  worktreeId: 'worktree',
  planId: 'plan-1',
  threadId: 'thread-1',
  body: 'Split into two steps.',
  resolve: true,
  requireSubmittedThread: true,
};

describe('replyToPlanCommentThread', () => {
  beforeEach(() => {
    mockAppendPlanCommentReply.mockReset();
    mockQueueSharedPlanSync.mockReset();
    mockSendToAllWindows.mockReset();
    mockWaitForSubmittedPlanCommentThread.mockReset();
    mockWaitForSubmittedPlanCommentThread.mockResolvedValue(false);
  });

  it('appends the reply, broadcasts the plan to every window, then queues shared sync', async () => {
    const plan = sharedPlan();
    mockAppendPlanCommentReply.mockResolvedValue({ ok: true, plan });

    await expect(replyToPlanCommentThread(REQUEST)).resolves.toEqual({
      ok: true,
      plan,
    });

    expect(mockAppendPlanCommentReply).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'worktree',
      planId: 'plan-1',
      threadId: 'thread-1',
      body: 'Split into two steps.',
      resolve: true,
      requireSubmittedThread: true,
    });
    expect(mockSendToAllWindows).toHaveBeenCalledWith('tracked-plans:updated', {
      projectId: 'project',
      worktreeId: 'worktree',
      plan,
      change: 'upsert',
    });
    expect(mockQueueSharedPlanSync).toHaveBeenCalledWith(plan, 'plan');
    expect(mockSendToAllWindows.mock.invocationCallOrder[0]).toBeLessThan(
      mockQueueSharedPlanSync.mock.invocationCallOrder[0],
    );
  });

  it('passes the legacy draft-acceptance flag through unchanged', async () => {
    mockAppendPlanCommentReply.mockResolvedValue({
      ok: true,
      plan: sharedPlan(),
    });

    await replyToPlanCommentThread({
      ...REQUEST,
      resolve: false,
      requireSubmittedThread: false,
    });

    expect(mockAppendPlanCommentReply).toHaveBeenCalledWith(
      expect.objectContaining({
        resolve: false,
        requireSubmittedThread: false,
      }),
    );
  });

  it.each([
    ['a missing thread', 'Comment thread not found.'],
    ['a missing plan', 'Plan not found.'],
  ])(
    'returns the persistence rejection for %s with no wait, broadcast, or sync',
    async (_label, error) => {
      mockAppendPlanCommentReply.mockResolvedValue({ ok: false, error });

      await expect(replyToPlanCommentThread(REQUEST)).resolves.toEqual({
        ok: false,
        error,
      });
      expect(mockAppendPlanCommentReply).toHaveBeenCalledTimes(1);
      expect(mockWaitForSubmittedPlanCommentThread).not.toHaveBeenCalled();
      expect(mockSendToAllWindows).not.toHaveBeenCalled();
      expect(mockQueueSharedPlanSync).not.toHaveBeenCalled();
    },
  );

  describe('a thread the renderer is still acknowledging', () => {
    it('waits for the acknowledgment, retries once, and posts the reply', async () => {
      const plan = sharedPlan();
      mockAppendPlanCommentReply
        .mockResolvedValueOnce(NOT_SUBMITTED)
        .mockResolvedValueOnce({ ok: true, plan });
      mockWaitForSubmittedPlanCommentThread.mockResolvedValue(true);

      await expect(replyToPlanCommentThread(REQUEST)).resolves.toEqual({
        ok: true,
        plan,
      });

      expect(mockWaitForSubmittedPlanCommentThread).toHaveBeenCalledWith(
        {
          projectId: 'project',
          worktreeId: 'worktree',
          planId: 'plan-1',
          threadId: 'thread-1',
        },
        5_000,
      );
      expect(mockAppendPlanCommentReply).toHaveBeenCalledTimes(2);
      expect(mockAppendPlanCommentReply.mock.calls[1]?.[0]).toEqual(
        mockAppendPlanCommentReply.mock.calls[0]?.[0],
      );
      expect(
        mockWaitForSubmittedPlanCommentThread.mock.invocationCallOrder[0],
      ).toBeLessThan(mockAppendPlanCommentReply.mock.invocationCallOrder[1]);
      expect(mockSendToAllWindows).toHaveBeenCalledTimes(1);
      expect(mockQueueSharedPlanSync).toHaveBeenCalledWith(plan, 'plan');
    });

    it('uses an injected hand-off grace', async () => {
      mockAppendPlanCommentReply.mockResolvedValue(NOT_SUBMITTED);

      await replyToPlanCommentThread(REQUEST, { handoffGraceMs: 25 });

      expect(mockWaitForSubmittedPlanCommentThread).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-1' }),
        25,
      );
    });

    it('returns the original rejection unchanged when no acknowledgment arrives in time', async () => {
      mockAppendPlanCommentReply.mockResolvedValue(NOT_SUBMITTED);
      mockWaitForSubmittedPlanCommentThread.mockResolvedValue(false);

      await expect(replyToPlanCommentThread(REQUEST)).resolves.toBe(
        NOT_SUBMITTED,
      );

      expect(mockWaitForSubmittedPlanCommentThread).toHaveBeenCalledTimes(1);
      expect(mockAppendPlanCommentReply).toHaveBeenCalledTimes(1);
      expect(mockSendToAllWindows).not.toHaveBeenCalled();
      expect(mockQueueSharedPlanSync).not.toHaveBeenCalled();
    });

    it('never waits on the legacy path that accepts draft-only threads', async () => {
      mockAppendPlanCommentReply.mockResolvedValue({
        ok: false,
        error: 'Comment thread not found.',
      });

      await replyToPlanCommentThread({
        ...REQUEST,
        requireSubmittedThread: false,
      });

      expect(mockAppendPlanCommentReply).toHaveBeenCalledTimes(1);
      expect(mockWaitForSubmittedPlanCommentThread).not.toHaveBeenCalled();
    });
  });
});
