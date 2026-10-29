const commitPlanExit = jest.fn<Promise<boolean>, [unknown, unknown?]>();
const mockRetirePlanReview = jest.fn<Promise<boolean>, [unknown]>();
const mockGetState = jest.fn<Promise<unknown>, [unknown]>();
const mockCreatePlan = jest.fn<Promise<unknown>, [unknown]>();
const mockUpdatePlan = jest.fn<Promise<unknown>, [unknown]>();
const mockPlanInstruction = jest.fn<Promise<unknown>, [unknown]>();
const mockSendToWindow = jest.fn<void, unknown[]>();
const mockMarkAttention = jest.fn<void, [unknown]>();
jest.mock('../plans-service', () => ({
  createTrackedPlanData: (request: unknown): Promise<unknown> =>
    mockCreatePlan(request),
  updateTrackedPlanData: (request: unknown): Promise<unknown> =>
    mockUpdatePlan(request),
}));
jest.mock('../../lib/plan-system-instructions', () => ({
  buildPlanFileSystemInstruction: (request: unknown): Promise<unknown> =>
    mockPlanInstruction(request),
}));
jest.mock('../../lib/workspace-registry', () => ({
  isCoworkWorkspace: (): boolean => false,
}));
jest.mock('../../lib/window-send', () => ({
  sendToWindow: (...args: unknown[]): void => mockSendToWindow(...args),
}));
jest.mock('../attention-tracker', () => ({
  getAttentionTracker: (): { mark: typeof mockMarkAttention } => ({
    mark: mockMarkAttention,
  }),
}));

jest.mock('../chat-state-service', () => ({
  getChatStateService: (): {
    commitPlanExit: typeof commitPlanExit;
    getState: typeof mockGetState;
    retirePlanReview: typeof mockRetirePlanReview;
  } => ({
    commitPlanExit,
    getState: mockGetState,
    retirePlanReview: mockRetirePlanReview,
  }),
}));

import {
  commitPendingPlanExit,
  publishOpenCodePlanProposal,
} from '../chat-state-plan-exit';

describe('commitPendingPlanExit', () => {
  beforeEach(() => {
    commitPlanExit.mockReset();
  });

  it('propagates canonical commit failures so callers cannot broadcast', async () => {
    commitPlanExit.mockRejectedValueOnce(new Error('journal fsync failed'));

    await expect(
      commitPendingPlanExit({
        requestId: 'plan-request',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        toolInput: { plan: 'Do the work' },
      }),
    ).rejects.toThrow('journal fsync failed');
  });
});

describe('OpenCode proposal publication', () => {
  const request = {
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    plan: '# Parser validation',
    userMessageId: 'planning-turn',
    isCurrent: (): boolean => true,
    getWindow: (): null => null,
  };
  beforeEach(() => {
    jest.resetAllMocks();
    mockGetState.mockResolvedValue({
      tabsFile: { tabs: [{ id: 'chat', planMode: true }] },
    });
    mockCreatePlan.mockResolvedValue({
      id: 'plan-new',
      latestRevisionNumber: 1,
    });
    mockUpdatePlan.mockResolvedValue({
      id: 'plan-existing',
      latestRevisionNumber: 2,
    });
    mockPlanInstruction.mockResolvedValue({
      id: 'plan-file-location:plan-new',
      text: 'Read the plan file.',
    });
    commitPlanExit.mockResolvedValue(true);
    mockRetirePlanReview.mockResolvedValue(true);
  });

  it('tracks the proposal before committing and notifying its review request', async () => {
    await publishOpenCodePlanProposal(request);
    expect(mockCreatePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'opencode',
        content: request.plan,
        reviewStatus: 'pending',
        chatId: 'chat',
      }),
    );
    expect(commitPlanExit).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'opencode',
        reviewMode: 'proposal',
        planId: 'plan-new',
        revisionNumber: 1,
        toolInput: { plan: request.plan, source: 'opencode' },
        pendingSystemInstructions: [
          expect.objectContaining({ id: 'plan-file-location:plan-new' }),
        ],
      }),
      expect.objectContaining({
        requirePlanMode: true,
        expectedUserMessageId: 'planning-turn',
      }),
    );
    expect(mockCreatePlan.mock.invocationCallOrder[0]).toBeLessThan(
      commitPlanExit.mock.invocationCallOrder[0],
    );
    expect(commitPlanExit.mock.invocationCallOrder[0]).toBeLessThan(
      mockSendToWindow.mock.invocationCallOrder[0],
    );
    expect(mockMarkAttention).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'plan_review', state: 'needs_input' }),
    );
  });

  it('updates a restored OpenCode plan as a new pending revision', async () => {
    mockGetState.mockResolvedValue({
      tabsFile: {
        tabs: [
          {
            id: 'chat',
            planMode: true,
            trackedPlanSource: 'opencode',
            trackedPlanId: 'plan-existing',
            trackedPlanReviewStatus: 'pending',
          },
        ],
      },
    });
    await publishOpenCodePlanProposal(request);
    expect(mockUpdatePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: 'plan-existing',
        approvedAt: null,
        dismissedAt: null,
      }),
    );
    expect(mockCreatePlan).not.toHaveBeenCalled();
    expect(commitPlanExit.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ planId: 'plan-existing', revisionNumber: 2 }),
    );
  });

  it.each(['dismissed', 'other-provider'])(
    'creates a separate proposal for %s history',
    async (mode) => {
      mockGetState.mockResolvedValue({
        tabsFile: {
          tabs: [
            {
              id: 'chat',
              planMode: true,
              trackedPlanSource:
                mode === 'other-provider' ? 'codex' : 'opencode',
              trackedPlanId: 'plan-existing',
              trackedPlanReviewStatus:
                mode === 'dismissed' ? 'dismissed' : 'pending',
            },
          ],
        },
      });
      await publishOpenCodePlanProposal(request);
      expect(mockUpdatePlan).not.toHaveBeenCalled();
      expect(mockCreatePlan).toHaveBeenCalledTimes(1);
    },
  );

  it('retires the old actionable review before a revision can change its plan file', async () => {
    let current = true;
    let actionableRequest: string | undefined = 'previous-review';
    mockGetState.mockResolvedValue({
      tabsFile: {
        tabs: [
          {
            id: 'chat',
            planMode: true,
            trackedPlanId: 'plan-existing',
            trackedPlanSource: 'opencode',
            trackedPlanReviewStatus: 'pending',
            pendingPlanExitRequestId: actionableRequest,
          },
        ],
      },
    });
    mockRetirePlanReview.mockImplementationOnce(() => {
      actionableRequest = undefined;
      return Promise.resolve(true);
    });
    mockUpdatePlan.mockImplementationOnce(() => {
      // Cancellation during the cross-store write must not leave the old
      // request able to approve the changed plan file when the turn ends.
      current = false;
      return Promise.resolve({ id: 'plan-existing', latestRevisionNumber: 2 });
    });
    await publishOpenCodePlanProposal({ ...request, isCurrent: () => current });
    expect(actionableRequest).toBeUndefined();
    expect(commitPlanExit).not.toHaveBeenCalled();
    expect(mockSendToWindow).not.toHaveBeenCalled();
  });

  it('does not change the plan when its previous review cannot be retired', async () => {
    mockGetState.mockResolvedValue({
      tabsFile: {
        tabs: [
          {
            id: 'chat',
            planMode: true,
            trackedPlanId: 'plan-existing',
            trackedPlanSource: 'opencode',
            trackedPlanReviewStatus: 'pending',
          },
        ],
      },
    });
    mockRetirePlanReview.mockResolvedValue(false);
    await publishOpenCodePlanProposal(request);
    expect(mockUpdatePlan).not.toHaveBeenCalled();
    expect(mockCreatePlan).not.toHaveBeenCalled();
    expect(commitPlanExit).not.toHaveBeenCalled();
  });

  it('does not notify when cancellation arrives while preparing the plan file', async () => {
    let current = true;
    mockPlanInstruction.mockImplementationOnce(() => {
      current = false;
      return Promise.resolve(null);
    });
    await publishOpenCodePlanProposal({ ...request, isCurrent: () => current });
    expect(commitPlanExit).not.toHaveBeenCalled();
    expect(mockSendToWindow).not.toHaveBeenCalled();
    expect(mockMarkAttention).not.toHaveBeenCalled();
  });

  it('does not notify a rejected or stale canonical proposal', async () => {
    commitPlanExit.mockResolvedValue(false);
    await publishOpenCodePlanProposal(request);
    expect(mockSendToWindow).not.toHaveBeenCalled();
    expect(mockMarkAttention).not.toHaveBeenCalled();
  });

  it('stops before writing a plan when planning mode was already disabled', async () => {
    mockGetState.mockResolvedValue({
      tabsFile: { tabs: [{ id: 'chat', planMode: false }] },
    });
    await publishOpenCodePlanProposal(request);
    expect(mockCreatePlan).not.toHaveBeenCalled();
    expect(commitPlanExit).not.toHaveBeenCalled();
  });

  it('propagates plan persistence failure without announcing a review', async () => {
    mockCreatePlan.mockRejectedValue(new Error('plan write failed'));
    await expect(publishOpenCodePlanProposal(request)).rejects.toThrow(
      'plan write failed',
    );
    expect(commitPlanExit).not.toHaveBeenCalled();
    expect(mockSendToWindow).not.toHaveBeenCalled();
  });
});
