/**
 * @jest-environment jsdom
 */
import type { TrackedPlanData } from '@canopy/desktop-shared/types';
import {
  buildImplementPlanMessage,
  implementTrackedPlan,
} from '@/lib/plans/plan-follow-up';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import type { SendMessageDispatchOptions } from '@/stores/chat/types';

const PROJECT_ID = 'proj-1';
const WORKTREE_ID = 'wt-1';

let sendMessage: jest.Mock;
let markTrackedPlanExecuted: jest.Mock;
let loadTrackedPlans: jest.Mock;
let updatePlan: jest.Mock;

function makePlan(): TrackedPlanData {
  return {
    id: 'plan-1',
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    source: 'claude',
    title: 'Plan',
    content: '# Plan\n\nBody',
    reviewStatus: 'pending',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    latestRevisionNumber: 1,
    revisions: [],
    linkedExecutionIds: [],
  };
}

function tab(id: string): ChatTab {
  return {
    id,
    title: `Chat ${id}`,
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
  };
}

beforeEach(() => {
  sendMessage = jest.fn().mockResolvedValue(undefined);
  markTrackedPlanExecuted = jest.fn();
  loadTrackedPlans = jest.fn().mockResolvedValue(undefined);
  updatePlan = jest
    .fn()
    .mockResolvedValue({ ...makePlan(), reviewStatus: 'approved' });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { activity: { plans: { update: updatePlan } } },
  });
  useChatStore.setState({
    selectedWorktree: { projectId: 'proj-2', worktreeId: 'wt-other' },
    worktreeChats: {
      'proj-2/wt-other': {
        tabs: [tab('other-chat')],
        activeTabId: 'other-chat',
      },
      [`${PROJECT_ID}/${WORKTREE_ID}`]: {
        tabs: [tab('owning-chat')],
        activeTabId: 'owning-chat',
      },
    },
    switchTab: jest.fn(),
    sendMessage,
    markTrackedPlanExecuted,
  });
  useActivityStore.setState({ loadTrackedPlans });
});

describe('implementTrackedPlan', () => {
  it('refuses Cursor plan execution before sending or approving', async () => {
    await expect(
      implementTrackedPlan({ ...makePlan(), source: 'cursor' }),
    ).rejects.toThrow('unavailable');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(markTrackedPlanExecuted).not.toHaveBeenCalled();
    expect(updatePlan).not.toHaveBeenCalled();
  });

  it("sends the plan to its own worktree's chat and approves it", async () => {
    await expect(implementTrackedPlan(makePlan())).resolves.toEqual({
      chatId: 'owning-chat',
    });

    expect(sendMessage).toHaveBeenCalledWith(
      buildImplementPlanMessage('# Plan\n\nBody'),
      undefined,
      { projectId: PROJECT_ID, worktreeId: WORKTREE_ID, chatId: 'owning-chat' },
      undefined,
      expect.objectContaining({ throwOnDispatchFailure: true }),
    );
    expect(markTrackedPlanExecuted).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      planId: 'plan-1',
    });
    expect(updatePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        planId: 'plan-1',
        reviewStatus: 'approved',
        initiationSource: 'user',
      }),
    );
    expect(loadTrackedPlans).toHaveBeenCalledWith(PROJECT_ID, WORKTREE_ID);
  });

  it('reports the chosen chat before the send settles', async () => {
    let settleSend: () => void = () => undefined;
    sendMessage.mockImplementation(
      (): Promise<void> =>
        new Promise<void>((resolve) => {
          settleSend = resolve;
        }),
    );
    const onChatChosen = jest.fn();

    const implemented = implementTrackedPlan(makePlan(), { onChatChosen });
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }

    expect(onChatChosen).toHaveBeenCalledTimes(1);
    expect(onChatChosen).toHaveBeenCalledWith('owning-chat');
    expect(updatePlan).not.toHaveBeenCalled();

    settleSend();
    await expect(implemented).resolves.toEqual({ chatId: 'owning-chat' });
    expect(onChatChosen).toHaveBeenCalledTimes(1);
    expect(updatePlan).toHaveBeenCalledTimes(1);
  });

  it('synchronizes approval after admission while the implementation send is still held', async () => {
    let settleSend: () => void = () => undefined;
    sendMessage.mockImplementation(
      (
        _text: unknown,
        _files: unknown,
        _target: unknown,
        _callbacks: unknown,
        options: SendMessageDispatchOptions,
      ): Promise<void> => {
        options.onDispatchAccepted?.();
        return new Promise<void>((resolve) => {
          settleSend = resolve;
        });
      },
    );
    const implemented = implementTrackedPlan(makePlan());
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    expect(updatePlan).toHaveBeenCalledTimes(1);
    expect(loadTrackedPlans).toHaveBeenCalledTimes(1);
    settleSend();
    await implemented;
    expect(updatePlan).toHaveBeenCalledTimes(1);
  });

  it('handles refresh failure after admission without reporting the implementation as failed', async () => {
    loadTrackedPlans.mockRejectedValueOnce(new Error('offline'));
    await expect(implementTrackedPlan(makePlan())).resolves.toEqual({
      chatId: 'owning-chat',
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(
      useActivityStore.getState().trackedPlans[
        `${PROJECT_ID}/${WORKTREE_ID}`
      ]?.[0]?.reviewStatus,
    ).toBe('approved');
  });

  it('leaves the plan unapproved when the send fails', async () => {
    sendMessage.mockRejectedValue(new Error('Provider unavailable'));

    await expect(implementTrackedPlan(makePlan())).rejects.toThrow(
      'Provider unavailable',
    );
    expect(markTrackedPlanExecuted).not.toHaveBeenCalled();
    expect(updatePlan).not.toHaveBeenCalled();
  });

  it('leaves the plan unapproved when chat rejects a stopped send before dispatch', async () => {
    sendMessage.mockImplementation(
      (
        _text: unknown,
        _files: unknown,
        _target: unknown,
        _callbacks: unknown,
        options: SendMessageDispatchOptions,
      ): Promise<void> => {
        options.onPreDispatchRejected?.();
        return Promise.resolve();
      },
    );

    await expect(implementTrackedPlan(makePlan())).rejects.toThrow(
      "Couldn't send to chat. Try again.",
    );
    expect(markTrackedPlanExecuted).not.toHaveBeenCalled();
    expect(updatePlan).not.toHaveBeenCalled();
  });
});
