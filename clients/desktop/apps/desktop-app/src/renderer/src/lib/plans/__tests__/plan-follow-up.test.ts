/**
 * @jest-environment jsdom
 */
import type {
  ChatCommand,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import {
  buildImplementPlanMessage,
  implementTrackedPlan,
  PLAN_APPROVAL_FAILED_MESSAGE,
} from '@/lib/plans/plan-follow-up';
import { OWNING_CHAT_SEND_REJECTED_MESSAGE } from '@/lib/chat/owningWorktreeChat';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import type { ChatCommandDisposition } from '@/stores/chat/revisioned-commands';

let claudeTuiChatsEnabled = false;
jest.mock('@/lib/claude-tui-chats', () => {
  const actual: Record<string, unknown> = jest.requireActual(
    '@/lib/claude-tui-chats',
  );
  return {
    ...actual,
    isClaudeTuiChatsEnabled: (): boolean => claudeTuiChatsEnabled,
  };
});

const PROJECT_ID = 'proj-1';
const WORKTREE_ID = 'wt-1';

let sendMessage: jest.Mock;
let dispatchChatCommand: jest.Mock<
  Promise<ChatCommandDisposition>,
  [{ projectId: string; worktreeId: string }, ChatCommand]
>;
let markTrackedPlanExecuted: jest.Mock;
let loadTrackedPlans: jest.Mock;
let updatePlan: jest.Mock;
let calls: string[];

function makePlan(overrides: Partial<TrackedPlanData> = {}): TrackedPlanData {
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
    latestRevisionNumber: 3,
    revisions: [],
    linkedExecutionIds: [],
    ...overrides,
  };
}

function tab(id: string, overrides: Partial<ChatTab> = {}): ChatTab {
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
    ...overrides,
  };
}

function sentCommand(index = 0): ChatCommand | undefined {
  return dispatchChatCommand.mock.calls[index]?.[1];
}

beforeEach(() => {
  claudeTuiChatsEnabled = false;
  calls = [];
  sendMessage = jest.fn().mockResolvedValue(undefined);
  dispatchChatCommand = jest.fn<
    Promise<ChatCommandDisposition>,
    [{ projectId: string; worktreeId: string }, ChatCommand]
  >((): Promise<ChatCommandDisposition> => {
    calls.push('send');
    return Promise.resolve('accepted');
  });
  markTrackedPlanExecuted = jest.fn();
  loadTrackedPlans = jest.fn().mockResolvedValue(undefined);
  updatePlan = jest.fn(() => {
    calls.push('approve');
    return Promise.resolve({ ...makePlan(), reviewStatus: 'approved' });
  });
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
    dispatchChatCommand,
    markTrackedPlanExecuted,
  });
  useActivityStore.setState({ loadTrackedPlans });
});

describe('implementTrackedPlan', () => {
  it('refuses Cursor plan execution before sending or approving', async () => {
    await expect(
      implementTrackedPlan(makePlan({ source: 'cursor' })),
    ).rejects.toThrow('unavailable');
    expect(dispatchChatCommand).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(markTrackedPlanExecuted).not.toHaveBeenCalled();
    expect(updatePlan).not.toHaveBeenCalled();
  });

  it("links one attempt identity to the send in the plan's own worktree chat", async () => {
    await expect(implementTrackedPlan(makePlan())).resolves.toEqual({
      chatId: 'owning-chat',
    });

    expect(dispatchChatCommand).toHaveBeenCalledWith(
      { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      expect.objectContaining({
        type: 'chat.send_message',
        chatId: 'owning-chat',
        text: buildImplementPlanMessage('# Plan\n\nBody'),
      }),
    );
    const command = sentCommand();
    if (command?.type !== 'chat.send_message') throw new Error('No send');
    const link = command.trackedPlanImplementation;
    expect(link).toEqual({
      planId: 'plan-1',
      revisionNumber: 3,
      userMessageId: command.userMessageId,
      startedAt: link?.startedAt,
    });
    expect(Number.isNaN(Date.parse(link?.startedAt ?? ''))).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(markTrackedPlanExecuted).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      planId: 'plan-1',
    });
    expect(loadTrackedPlans).toHaveBeenCalledWith(PROJECT_ID, WORKTREE_ID);
  });

  it('approves a pending plan before the linked send, which main admits only for an approved revision', async () => {
    await implementTrackedPlan(makePlan());
    expect(calls).toEqual(['approve', 'send']);
    expect(updatePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: 'plan-1',
        chatId: 'owning-chat',
        reviewStatus: 'approved',
        initiationSource: 'user',
      }),
    );
  });

  it('does not re-approve an approved plan', async () => {
    await implementTrackedPlan(makePlan({ reviewStatus: 'approved' }));
    expect(updatePlan).not.toHaveBeenCalled();
    expect(calls).toEqual(['send']);
  });

  it('does not start an untracked implementation when approval fails', async () => {
    updatePlan.mockResolvedValue(null);
    await expect(implementTrackedPlan(makePlan())).rejects.toThrow(
      PLAN_APPROVAL_FAILED_MESSAGE,
    );
    expect(dispatchChatCommand).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('reports the chosen chat before the send settles', async () => {
    let settleSend: (disposition: ChatCommandDisposition) => void = () =>
      undefined;
    dispatchChatCommand.mockImplementation(
      (): Promise<ChatCommandDisposition> =>
        new Promise<ChatCommandDisposition>((resolve) => {
          settleSend = resolve;
        }),
    );
    const onChatChosen = jest.fn();

    const implemented = implementTrackedPlan(
      makePlan({ reviewStatus: 'approved' }),
      { onChatChosen },
    );
    for (let index = 0; index < 10; index += 1) await Promise.resolve();

    expect(onChatChosen).toHaveBeenCalledTimes(1);
    expect(onChatChosen).toHaveBeenCalledWith('owning-chat');
    expect(markTrackedPlanExecuted).not.toHaveBeenCalled();

    settleSend('accepted');
    await expect(implemented).resolves.toEqual({ chatId: 'owning-chat' });
    expect(onChatChosen).toHaveBeenCalledTimes(1);
  });

  it.each(['rejected', 'transport_failed'] as const)(
    'reports a %s send without recording the plan executed',
    async (disposition) => {
      dispatchChatCommand.mockResolvedValue(disposition);
      await expect(implementTrackedPlan(makePlan())).rejects.toThrow(
        OWNING_CHAT_SEND_REJECTED_MESSAGE,
      );
      expect(markTrackedPlanExecuted).not.toHaveBeenCalled();
    },
  );

  it('joins a repeated click instead of dispatching a second implementation', async () => {
    const plan = makePlan({ reviewStatus: 'approved' });
    const first = implementTrackedPlan(plan);
    const second = implementTrackedPlan(plan);
    expect(second).toBe(first);
    await first;
    expect(dispatchChatCommand).toHaveBeenCalledTimes(1);
  });

  it('gives each accepted retry a new attempt identity', async () => {
    const plan = makePlan({ reviewStatus: 'approved' });
    await implementTrackedPlan(plan);
    await implementTrackedPlan(plan);
    const first = sentCommand(0);
    const second = sentCommand(1);
    if (
      first?.type !== 'chat.send_message' ||
      second?.type !== 'chat.send_message'
    )
      throw new Error('No sends');
    expect(second.userMessageId).not.toBe(first.userMessageId);
    expect(second.trackedPlanImplementation?.userMessageId).toBe(
      second.userMessageId,
    );
  });

  describe('in a managed Claude terminal chat', () => {
    beforeEach(() => {
      claudeTuiChatsEnabled = true;
      useChatStore.setState({
        worktreeChats: {
          [`${PROJECT_ID}/${WORKTREE_ID}`]: {
            tabs: [
              tab('owning-chat', {
                providerType: 'claude',
                interfaceMode: 'claude-code',
              }),
            ],
            activeTabId: 'owning-chat',
          },
        },
      });
    });

    it('uses the same linked canonical admission as a native chat', async () => {
      await expect(implementTrackedPlan(makePlan())).resolves.toEqual({
        chatId: 'owning-chat',
      });
      const command = sentCommand();
      if (command?.type !== 'chat.send_message')
        throw new Error('No linked send');
      expect(command.trackedPlanImplementation).toMatchObject({
        planId: 'plan-1',
        revisionNumber: 3,
        userMessageId: command.userMessageId,
      });
      expect(sendMessage).not.toHaveBeenCalled();
      expect(calls).toEqual(['approve', 'send']);
    });

    it('refuses a terminal implementation when durable approval fails', async () => {
      updatePlan.mockResolvedValue(null);
      await expect(implementTrackedPlan(makePlan())).rejects.toThrow(
        PLAN_APPROVAL_FAILED_MESSAGE,
      );
      expect(sendMessage).not.toHaveBeenCalled();
      expect(dispatchChatCommand).not.toHaveBeenCalled();
    });
  });
});
