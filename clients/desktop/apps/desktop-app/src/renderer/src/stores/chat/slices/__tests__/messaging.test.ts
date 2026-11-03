import * as approvalTransitions from '../approvals';
import type {
  ClaudeTerminalScheduledPromptEvent,
  ChatCommandRequest,
  ChatCommandResult,
} from '@canopy/desktop-shared/types';
import type { ChatState, ChatMessagingSlice } from '../../state';
import type { ChatTab, QueuedChatMessage } from '../../types';
import type {
  TerminalWriteDisposition,
  TerminalWriteRequest,
} from '@canopy/protocol/terminal';
import { createMessagingSlice } from '../messaging';

let mockTerminalSnapshot:
  | { terminalId: string; turnState: 'idle' | 'running'; readyForInput: true }
  | undefined;
const mockMarkAutoSendPending = jest.fn();

jest.mock('../../../projectsStore', (): unknown => ({
  useProjectsStore: {
    getState: (): {
      projects: never[];
      enqueuePendingTaskBranchNaming: jest.Mock;
    } => ({ projects: [], enqueuePendingTaskBranchNaming: jest.fn() }),
  },
}));
jest.mock('../../../pipelineRunsStore', (): unknown => ({
  usePipelineRunsStore: {
    getState: (): { summaries: never[] } => ({ summaries: [] }),
  },
}));
jest.mock('@/stores/claudeTerminalStore', (): unknown => ({
  useClaudeTerminalStore: {
    getState: (): {
      getStateForChat: () => typeof mockTerminalSnapshot;
      markAutoSendPending: jest.Mock;
    } => ({
      getStateForChat: (): typeof mockTerminalSnapshot => mockTerminalSnapshot,
      markAutoSendPending: mockMarkAutoSendPending,
    }),
  },
}));
jest.mock('@/lib/claude-tui-chats', (): unknown => ({
  getEffectiveClaudeChatInterfaceMode: (mode: string | undefined): string =>
    mode ?? 'canopy',
  getPersistedClaudeChatInterfaceMode: (
    mode: string | undefined,
  ): string | undefined => mode,
}));

const scope = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
};
const chatId = 'chat-1';
const callbackMatcher: unknown = expect.any(Function);

function makeSlice(): {
  slice: ChatMessagingSlice;
  sendMessage: jest.Mock;
} {
  const sendMessage = jest.fn().mockResolvedValue(undefined);
  const state = {
    worktreeChats: {
      [`${scope.projectId}/${scope.worktreeId}`]: {
        tabs: [{ id: chatId, queuedMessages: [] }],
      },
    },
    sendMessage,
  } as unknown as ChatState;
  const slice = createMessagingSlice(
    () => undefined,
    () => state,
    {} as Parameters<typeof createMessagingSlice>[2],
  );
  return { slice, sendMessage };
}

function makeRetryHarness(queuedMessages: QueuedChatMessage[] = []): {
  slice: ChatMessagingSlice;
  getState: () => ChatState;
  dispatchChatCommand: jest.MockedFunction<ChatState['dispatchChatCommand']>;
  ensureClaudeTerminal: jest.Mock;
} {
  const key = `${scope.projectId}/${scope.worktreeId}`;
  const tab = {
    id: chatId,
    title: 'New Chat',
    messages: [],
    queuedMessages,
    status: 'idle',
    interfaceMode: 'claude-code',
    providerType: 'claude',
  } as unknown as ChatTab;
  const dispatchChatCommand: jest.MockedFunction<
    ChatState['dispatchChatCommand']
  > = jest
    .fn<
      ReturnType<ChatState['dispatchChatCommand']>,
      Parameters<ChatState['dispatchChatCommand']>
    >()
    .mockResolvedValueOnce('conflict')
    .mockResolvedValueOnce('accepted');
  const ensureClaudeTerminal = jest.fn().mockImplementation(() => {
    mockTerminalSnapshot = {
      terminalId: 'terminal-1',
      turnState: 'idle',
      readyForInput: true,
    };
    return Promise.resolve({ lastLaunchConsumedInitialPrompt: true });
  });
  let state = {
    selectedWorktree: scope,
    worktreeChats: {
      [key]: { activeTabId: chatId, tabs: [tab] },
    },
    chatStateSync: { [key]: { phase: 'live', revision: 1 } },
    dispatchChatCommand,
    ensureClaudeTerminal,
  } as unknown as ChatState;
  const setState = (update: unknown): void => {
    const partial =
      typeof update === 'function'
        ? (update as (current: ChatState) => Partial<ChatState>)(state)
        : (update as Partial<ChatState>);
    state = { ...state, ...partial };
  };
  const getState = (): ChatState => state;
  const slice = createMessagingSlice(
    setState,
    getState,
    {} as Parameters<typeof createMessagingSlice>[2],
  );
  state = { ...state, ...slice, ensureClaudeTerminal };
  return { slice, getState, dispatchChatCommand, ensureClaudeTerminal };
}

describe('handleScheduledTerminalPrompt', () => {
  it.each(['running', 'placeholder', 'older-queue'] as const)(
    'refuses an admitted plan before a %s terminal delivery can enter a local queue',
    async (scenario) => {
      const previousWindowDescriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        'window',
      );
      const olderQueue =
        scenario === 'older-queue' ? [{ text: 'Older follow-up' }] : [];
      const { slice, getState, ensureClaudeTerminal } =
        makeRetryHarness(olderQueue);
      const tab =
        getState().worktreeChats[`${scope.projectId}/${scope.worktreeId}`]
          ?.tabs[0];
      if (tab && scenario === 'placeholder') tab.queuedHookPlaceholder = true;
      mockTerminalSnapshot =
        scenario === 'older-queue'
          ? undefined
          : {
              terminalId: 'terminal-1',
              turnState: 'running',
              readyForInput: true,
            };
      const terminalWrite = jest.fn();
      const mainCommand = jest
        .fn<Promise<ChatCommandResult>, [ChatCommandRequest]>()
        .mockImplementation((request) =>
          Promise.resolve({
            commandId: request.commandId,
            outcome: 'applied',
            revision: 2,
          }),
        );
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
          api: {
            claudeTerminal: {
              getState: jest.fn().mockResolvedValue(mockTerminalSnapshot),
            },
            terminal: { write: terminalWrite },
            chat: { command: mainCommand },
          },
        },
      });
      try {
        const event = {
          ...scope,
          chatId,
          userMessageId: 'implementation-queued-race',
          text: 'Implement.',
          terminalPlanImplementation: true as const,
        };
        slice.handleScheduledTerminalPrompt(event);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(mainCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            command: {
              type: 'chat.reject_plan_implementation_delivery',
              chatId,
              userMessageId: event.userMessageId,
            },
          }),
        );
        expect(
          getState().worktreeChats[`${scope.projectId}/${scope.worktreeId}`]
            ?.tabs[0]?.queuedMessages,
        ).toEqual(olderQueue);
        expect(terminalWrite).not.toHaveBeenCalled();
        expect(ensureClaudeTerminal).not.toHaveBeenCalled();
      } finally {
        mockTerminalSnapshot = undefined;
        if (previousWindowDescriptor)
          Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
        else Reflect.deleteProperty(globalThis, 'window');
      }
    },
  );

  it.each(['fresh', 'reaped'] as const)(
    'launches a %s Auto terminal once with the admitted plan identity and no local queue',
    async (scenario) => {
      const previousWindowDescriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        'window',
      );
      const { slice, getState, ensureClaudeTerminal, dispatchChatCommand } =
        makeRetryHarness();
      const tab =
        getState().worktreeChats[`${scope.projectId}/${scope.worktreeId}`]
          ?.tabs[0];
      if (!tab) throw new Error('Missing Auto tab');
      tab.interfaceMode = 'auto';
      mockTerminalSnapshot =
        scenario === 'reaped'
          ? {
              terminalId: 'old-terminal',
              turnState: 'idle',
              readyForInput: true,
            }
          : undefined;
      let finishLaunch:
        | ((result: { lastLaunchConsumedInitialPrompt: true }) => void)
        | undefined;
      const launch = new Promise<{ lastLaunchConsumedInitialPrompt: true }>(
        (resolve) => {
          finishLaunch = resolve;
        },
      );
      ensureClaudeTerminal.mockImplementationOnce(() => launch);
      dispatchChatCommand.mockReset().mockResolvedValue('accepted');
      mockMarkAutoSendPending.mockClear();
      const mainCommand = jest.fn();
      const terminalWrite = jest.fn();
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
          api: {
            claudeTerminal: {
              getState: jest.fn().mockResolvedValue(undefined),
            },
            terminal: { write: terminalWrite },
            chat: { command: mainCommand },
          },
        },
      });
      try {
        const send = slice.sendMessage(
          'Implement.',
          undefined,
          { ...scope, chatId },
          'typed',
          {
            initiationSource: 'automation',
            terminalPlanImplementation: true,
            userMessageId: 'implementation-cold-start',
          },
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(ensureClaudeTerminal).toHaveBeenCalledTimes(1);
        expect(ensureClaudeTerminal).toHaveBeenCalledWith(
          chatId,
          scope,
          undefined,
          expect.stringContaining(
            '<!-- canopy-terminal-turn:implementation-cold-start -->',
          ),
          { initialPromptIdempotencyKey: 'implementation-cold-start' },
        );
        expect(mockMarkAutoSendPending).toHaveBeenCalledWith(
          scope.projectId,
          scope.worktreeId,
          chatId,
        );
        expect(
          getState().worktreeChats[`${scope.projectId}/${scope.worktreeId}`]
            ?.tabs[0]?.queuedMessages,
        ).toEqual([]);
        finishLaunch?.({ lastLaunchConsumedInitialPrompt: true });
        await send;
        await Promise.resolve();
        expect(dispatchChatCommand).toHaveBeenCalledWith(
          scope,
          expect.objectContaining({
            type: 'chat.commit_terminal_initial_prompt',
            userMessageId: 'implementation-cold-start',
            text: 'Implement.',
          }),
          undefined,
        );
        expect(mainCommand).not.toHaveBeenCalled();
        expect(terminalWrite).not.toHaveBeenCalled();
        expect(
          getState().worktreeChats[`${scope.projectId}/${scope.worktreeId}`]
            ?.tabs[0]?.queuedMessages,
        ).toEqual([]);
      } finally {
        finishLaunch?.({ lastLaunchConsumedInitialPrompt: true });
        mockTerminalSnapshot = undefined;
        if (previousWindowDescriptor)
          Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
        else Reflect.deleteProperty(globalThis, 'window');
      }
    },
  );

  it.each(['failed', 'not-consumed'] as const)(
    'reports an initial plan launch that is %s without leaving a queued copy',
    async (result) => {
      const previousWindowDescriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        'window',
      );
      const { slice, getState, ensureClaudeTerminal } = makeRetryHarness();
      if (result === 'failed')
        ensureClaudeTerminal.mockRejectedValueOnce(new Error('Launch failed'));
      else
        ensureClaudeTerminal.mockResolvedValueOnce({
          lastLaunchConsumedInitialPrompt: false,
        });
      mockTerminalSnapshot = undefined;
      const mainCommand = jest
        .fn<Promise<ChatCommandResult>, [ChatCommandRequest]>()
        .mockImplementation((request) =>
          Promise.resolve({
            commandId: request.commandId,
            outcome: 'applied',
            revision: 2,
          }),
        );
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
          api: {
            claudeTerminal: {
              getState: jest.fn().mockResolvedValue(undefined),
            },
            chat: { command: mainCommand },
          },
        },
      });
      try {
        slice.handleScheduledTerminalPrompt({
          ...scope,
          chatId,
          userMessageId: 'implementation-launch-refused',
          text: 'Implement.',
          terminalPlanImplementation: true,
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(mainCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            command: {
              type: 'chat.reject_plan_implementation_delivery',
              chatId,
              userMessageId: 'implementation-launch-refused',
            },
          }),
        );
        expect(
          getState().worktreeChats[`${scope.projectId}/${scope.worktreeId}`]
            ?.tabs[0]?.queuedMessages,
        ).toEqual([]);
      } finally {
        mockTerminalSnapshot = undefined;
        if (previousWindowDescriptor)
          Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
        else Reflect.deleteProperty(globalThis, 'window');
      }
    },
  );

  it('forwards trusted accepted-input metadata without labeling it automation', () => {
    const { slice, sendMessage } = makeSlice();
    const event: ClaudeTerminalScheduledPromptEvent = {
      ...scope,
      chatId,
      userMessageId: 'main-user-message-7',
      text: 'Visible request',
      acceptedInputId: 'accepted-input-42',
      hiddenContext: {
        kind: 'agent-sender-context',
        text: 'Hidden sender details',
      },
      agentSent: {
        sender: {
          kind: 'project',
          projectType: 'code',
          projectId: 'sender-project',
          taskId: 'sender-task',
          chatId: 'sender-chat',
        },
        chatTitle: 'Sender chat',
        projectLabel: 'Sender project',
      },
      // Mixed wire payloads must not reclassify a main-accepted tool input.
      automationName: 'not an automation',
    };

    slice.handleScheduledTerminalPrompt(event);

    expect(sendMessage).toHaveBeenCalledWith(
      event.text,
      undefined,
      { ...scope, chatId },
      'typed',
      {
        userMessageId: event.userMessageId,
        onPreDispatchRejected: callbackMatcher,
        onDispatchRejected: callbackMatcher,
        acceptedInputId: event.acceptedInputId,
        hiddenContext: event.hiddenContext,
        agentSent: event.agentSent,
      },
    );
  });

  it('preserves automation labeling for scheduled prompts without an accepted input id', () => {
    const { slice, sendMessage } = makeSlice();
    const event: ClaudeTerminalScheduledPromptEvent = {
      ...scope,
      chatId,
      userMessageId: 'scheduled-user-message-8',
      text: 'Scheduled request',
      automationName: 'Daily summary',
    };

    slice.handleScheduledTerminalPrompt(event);

    expect(sendMessage).toHaveBeenCalledWith(
      event.text,
      undefined,
      { ...scope, chatId },
      'typed',
      {
        initiationSource: 'automation',
        automationName: 'Daily summary',
        userMessageId: event.userMessageId,
        onPreDispatchRejected: callbackMatcher,
        onDispatchRejected: callbackMatcher,
      },
    );
  });

  it('reports scheduled delivery refusal when an approval transition rejects before the first terminal write', async () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'window',
    );
    let rejectTransition: ((error: Error) => void) | undefined;
    const transition = new Promise<void>((_resolve, reject) => {
      rejectTransition = reject;
    });
    const pending = jest
      .spyOn(approvalTransitions, 'pendingApprovalModeTransitions')
      .mockReturnValueOnce(transition);
    const terminalWrite = jest.fn();
    const { slice, dispatchChatCommand, getState } = makeRetryHarness();
    const sync =
      getState().chatStateSync[`${scope.projectId}/${scope.worktreeId}`];
    const mainCommand = jest
      .fn<Promise<ChatCommandResult>, [ChatCommandRequest]>()
      .mockImplementation((request) =>
        Promise.resolve({
          commandId: request.commandId,
          outcome: 'applied',
          revision: 2,
        }),
      );
    mockTerminalSnapshot = {
      terminalId: 'terminal-1',
      turnState: 'idle',
      readyForInput: true,
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: {
          claudeTerminal: {
            getState: jest.fn().mockResolvedValue(mockTerminalSnapshot),
          },
          terminal: { write: terminalWrite },
          chat: { command: mainCommand },
        },
      },
    });
    try {
      slice.handleScheduledTerminalPrompt({
        ...scope,
        chatId,
        userMessageId: 'implementation-declined',
        text: 'Implement.',
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(terminalWrite).not.toHaveBeenCalled();
      expect(dispatchChatCommand).not.toHaveBeenCalled();
      if (sync) sync.phase = 'refreshing';
      rejectTransition?.(new Error('Approval transition refused'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mainCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          ...scope,
          command: {
            type: 'chat.reject_plan_implementation_delivery',
            chatId,
            userMessageId: 'implementation-declined',
          },
        }),
      );
      expect(dispatchChatCommand).not.toHaveBeenCalled();
      expect(terminalWrite).not.toHaveBeenCalled();
    } finally {
      pending.mockRestore();
      mockTerminalSnapshot = undefined;
      if (previousWindowDescriptor)
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  it('keeps a trusted input queued after initial commit failure and retries by acceptedInputId', async () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'window',
    );
    const terminalWrite = jest
      .fn<Promise<TerminalWriteDisposition>, [TerminalWriteRequest]>()
      .mockResolvedValue('already_written');
    const getTerminalState = jest.fn().mockResolvedValue({
      terminalId: 'terminal-1',
      turnState: 'idle',
      readyForInput: true,
    });
    const agentEvent: ClaudeTerminalScheduledPromptEvent = {
      ...scope,
      chatId,
      userMessageId: 'main-user-message-14',
      text: 'Trusted tool request',
      acceptedInputId: 'accepted-input-14',
      hiddenContext: {
        kind: 'agent-sender-context',
        text: 'Private sender context',
      },
      agentSent: {
        sender: {
          kind: 'project',
          projectType: 'code',
          projectId: 'sender-project',
          taskId: 'sender-task',
          chatId: 'sender-chat',
        },
        chatTitle: 'Sender chat',
        projectLabel: 'Sender project',
      },
    };
    const { slice, getState, dispatchChatCommand, ensureClaudeTerminal } =
      makeRetryHarness();

    mockTerminalSnapshot = undefined;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: {
          claudeTerminal: { getState: getTerminalState },
          terminal: { write: terminalWrite },
        },
      },
    });
    jest.useFakeTimers();

    try {
      await slice.sendMessage(
        agentEvent.text,
        undefined,
        { ...scope, chatId },
        'typed',
        {
          userMessageId: agentEvent.userMessageId,
          acceptedInputId: agentEvent.acceptedInputId,
          hiddenContext: agentEvent.hiddenContext,
          agentSent: agentEvent.agentSent,
        },
      );
      await Promise.resolve();
      await Promise.resolve();

      const queuedAfterFailure =
        getState().worktreeChats[`${scope.projectId}/${scope.worktreeId}`]
          ?.tabs[0]?.queuedMessages;
      expect(queuedAfterFailure).toHaveLength(1);
      expect(queuedAfterFailure?.[0]).toMatchObject({
        text: agentEvent.text,
        agentSent: agentEvent.agentSent,
        dispatchOptions: {
          acceptedInputId: agentEvent.acceptedInputId,
          hiddenContext: agentEvent.hiddenContext,
          agentSent: agentEvent.agentSent,
        },
      });
      expect(ensureClaudeTerminal).toHaveBeenCalledWith(
        chatId,
        scope,
        undefined,
        expect.stringContaining('Private sender context'),
        { initialPromptIdempotencyKey: agentEvent.acceptedInputId },
      );

      const retry = slice.sendMessage(
        agentEvent.text,
        undefined,
        { ...scope, chatId },
        'typed',
        {
          userMessageId: agentEvent.userMessageId,
          acceptedInputId: agentEvent.acceptedInputId,
          hiddenContext: agentEvent.hiddenContext,
          agentSent: agentEvent.agentSent,
        },
      );
      await jest.advanceTimersByTimeAsync(600);
      await retry;

      expect(dispatchChatCommand).toHaveBeenCalledTimes(2);
      const commands = dispatchChatCommand.mock.calls.map(
        ([, command]) => command,
      );
      for (const command of commands) {
        expect(command).toMatchObject({
          type: 'chat.commit_terminal_initial_prompt',
          userMessageId: agentEvent.userMessageId,
          text: agentEvent.text,
        });
        expect(command).not.toHaveProperty('acceptedInputId');
        expect(command).not.toHaveProperty('hiddenContext');
        expect(command).not.toHaveProperty('agentSent');
        expect(command).not.toHaveProperty('agentSenderProvenance');
        expect(command).not.toHaveProperty('userMessageSource');
      }
      expect(dispatchChatCommand.mock.calls[1]?.[2]).toBeUndefined();
      expect(
        terminalWrite.mock.calls.map(([request]) => request.idempotencyKey),
      ).toEqual([
        'accepted-input-14-clear-0',
        'accepted-input-14-clear-1',
        'accepted-input-14-clear-2',
        'accepted-input-14-paste',
        'accepted-input-14-submit',
      ]);
      const finalTab =
        getState().worktreeChats[`${scope.projectId}/${scope.worktreeId}`]
          ?.tabs[0];
      expect(finalTab?.queuedMessages).toEqual([]);
      expect(finalTab?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: agentEvent.userMessageId,
            role: 'user',
            blocks: [{ type: 'text', text: agentEvent.text }],
          }),
        ]),
      );
    } finally {
      jest.useRealTimers();
      mockTerminalSnapshot = undefined;
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('keys every scheduled plan delivery write with the admitted message identity', async () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'window',
    );
    const terminalWrite = jest
      .fn<Promise<TerminalWriteDisposition>, [TerminalWriteRequest]>()
      .mockResolvedValue('written');
    const { slice, dispatchChatCommand } = makeRetryHarness();
    dispatchChatCommand.mockReset().mockResolvedValue('accepted');
    mockTerminalSnapshot = {
      terminalId: 'terminal-1',
      turnState: 'idle',
      readyForInput: true,
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: {
          claudeTerminal: {
            getState: jest.fn().mockResolvedValue(mockTerminalSnapshot),
          },
          terminal: { write: terminalWrite },
        },
      },
    });
    jest.useFakeTimers();
    try {
      const send = slice.sendMessage(
        'Implement the plan.',
        undefined,
        { ...scope, chatId },
        'typed',
        {
          initiationSource: 'automation',
          userMessageId: 'implementation-large',
          terminalPlanImplementation: true,
        },
      );
      await jest.advanceTimersByTimeAsync(4000);
      await send;
      expect(
        terminalWrite.mock.calls.map(([request]) => request.idempotencyKey),
      ).toEqual([
        'implementation-large-clear-0',
        'implementation-large-clear-1',
        'implementation-large-clear-2',
        'implementation-large-paste',
        'implementation-large-submit',
      ]);
    } finally {
      mockTerminalSnapshot = undefined;
      jest.useRealTimers();
      if (previousWindowDescriptor)
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  it('keeps staged composer attachments out of accepted agent input', async () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'window',
    );
    const terminalWrite = jest
      .fn<Promise<TerminalWriteDisposition>, [TerminalWriteRequest]>()
      .mockResolvedValue('written');
    const { slice, getState, dispatchChatCommand } = makeRetryHarness();
    dispatchChatCommand.mockReset().mockResolvedValue('accepted');
    const key = `${scope.projectId}/${scope.worktreeId}`;
    const staged = {
      filename: 'draft.png',
      absolutePath: '/tmp/user-draft/draft.png',
    };
    const tab = getState().worktreeChats[key]?.tabs[0];
    if (!tab) throw new Error('missing tab');
    tab.pendingAttachments = [staged];
    mockTerminalSnapshot = {
      terminalId: 'terminal-1',
      turnState: 'idle',
      readyForInput: true,
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: {
          claudeTerminal: {
            getState: jest.fn().mockResolvedValue({
              terminalId: 'terminal-1',
              turnState: 'idle',
              readyForInput: true,
            }),
          },
          terminal: { write: terminalWrite },
        },
      },
    });
    jest.useFakeTimers();

    try {
      const send = slice.sendMessage(
        'Trusted tool request',
        undefined,
        { ...scope, chatId },
        'typed',
        {
          userMessageId: 'accepted-input-21',
          acceptedInputId: 'accepted-input-21',
          hiddenContext: {
            kind: 'agent-sender-context',
            text: 'Private sender context',
          },
        },
      );
      await jest.advanceTimersByTimeAsync(4_000);
      await send;

      const pasted = terminalWrite.mock.calls
        .map(([request]) => request)
        .find(
          (request) => request.idempotencyKey === 'accepted-input-21-paste',
        );
      expect(pasted?.data).toContain('Trusted tool request');
      expect(pasted?.data).not.toContain(staged.absolutePath);
      expect(
        getState().worktreeChats[key]?.tabs[0]?.pendingAttachments,
      ).toEqual([staged]);
    } finally {
      jest.useRealTimers();
      mockTerminalSnapshot = undefined;
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('removes a rejected accepted input without adding a user row or retrying', async () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'window',
    );
    const rejectionMessage =
      'The agent that sent this message can no longer reach this chat.';
    const acceptedInputId = 'accepted-input-revalidation-failure';
    const terminalWrite = jest
      .fn<Promise<TerminalWriteDisposition>, [TerminalWriteRequest]>()
      .mockImplementation((request) =>
        request.idempotencyKey === `${acceptedInputId}-paste`
          ? Promise.reject(new Error(rejectionMessage))
          : Promise.resolve('written'),
      );
    const getTerminalState = jest.fn().mockResolvedValue({
      terminalId: 'terminal-1',
      turnState: 'idle',
      readyForInput: true,
    });
    const queuedMessage: QueuedChatMessage = {
      text: 'Trusted tool request',
      agentSent: {
        sender: {
          kind: 'project',
          projectType: 'code',
          projectId: 'sender-project',
          taskId: 'sender-task',
          chatId: 'sender-chat',
        },
        chatTitle: 'Sender chat',
        projectLabel: 'Sender project',
      },
      dispatchOptions: {
        acceptedInputId,
        hiddenContext: {
          kind: 'agent-sender-context',
          text: 'Private sender context',
        },
      },
    };
    const { slice, getState, dispatchChatCommand, ensureClaudeTerminal } =
      makeRetryHarness([queuedMessage]);
    const onDispatchRejected = jest.fn();

    mockTerminalSnapshot = {
      terminalId: 'terminal-1',
      turnState: 'idle',
      readyForInput: true,
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: {
          claudeTerminal: { getState: getTerminalState },
          terminal: { write: terminalWrite },
        },
      },
    });
    jest.useFakeTimers();

    try {
      const send = slice.sendMessage(
        queuedMessage.text,
        undefined,
        { ...scope, chatId },
        'typed',
        {
          userMessageId: 'main-user-message-rejected',
          acceptedInputId,
          hiddenContext: queuedMessage.dispatchOptions?.hiddenContext,
          agentSent: queuedMessage.agentSent,
          onDispatchRejected,
        },
      );
      await jest.advanceTimersByTimeAsync(600);
      await send;

      const tab =
        getState().worktreeChats[`${scope.projectId}/${scope.worktreeId}`]
          ?.tabs[0];
      expect(
        terminalWrite.mock.calls.map(([request]) => request.idempotencyKey),
      ).toEqual([
        `${acceptedInputId}-clear-0`,
        `${acceptedInputId}-clear-1`,
        `${acceptedInputId}-clear-2`,
        `${acceptedInputId}-paste`,
      ]);
      expect(dispatchChatCommand).not.toHaveBeenCalled();
      expect(ensureClaudeTerminal).not.toHaveBeenCalled();
      expect(onDispatchRejected).toHaveBeenCalledTimes(1);
      expect(tab?.queuedMessages).toEqual([]);
      expect(
        tab?.messages.some(
          (message) => message.id === 'main-user-message-rejected',
        ),
      ).toBe(false);
      expect(tab?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            blocks: [{ type: 'text', text: rejectionMessage }],
          }),
        ]),
      );
    } finally {
      jest.useRealTimers();
      mockTerminalSnapshot = undefined;
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('keeps the ordinary terminal paste rejection path unchanged', async () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'window',
    );
    const rejectionMessage = 'terminal unavailable';
    const terminalWrite = jest
      .fn<Promise<TerminalWriteDisposition>, [TerminalWriteRequest]>()
      .mockImplementation((request) =>
        request.data.startsWith('\x1b[200~')
          ? Promise.reject(new Error(rejectionMessage))
          : Promise.resolve('written'),
      );
    const getTerminalState = jest.fn().mockResolvedValue({
      terminalId: 'terminal-1',
      turnState: 'idle',
      readyForInput: true,
    });
    const { slice, getState } = makeRetryHarness();
    const onDispatchRejected = jest.fn();

    mockTerminalSnapshot = {
      terminalId: 'terminal-1',
      turnState: 'idle',
      readyForInput: true,
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: {
          claudeTerminal: { getState: getTerminalState },
          terminal: { write: terminalWrite },
        },
      },
    });
    jest.useFakeTimers();

    try {
      const send = slice.sendMessage(
        'Ordinary user request',
        undefined,
        { ...scope, chatId },
        'typed',
        { userMessageId: 'ordinary-user-message', onDispatchRejected },
      );
      await jest.advanceTimersByTimeAsync(600);
      await send;

      const tab =
        getState().worktreeChats[`${scope.projectId}/${scope.worktreeId}`]
          ?.tabs[0];
      expect(terminalWrite).toHaveBeenCalledTimes(4);
      expect(terminalWrite.mock.calls[3]?.[0].idempotencyKey).toBeUndefined();
      expect(onDispatchRejected).toHaveBeenCalledTimes(1);
      expect(tab?.status).toBe('error');
      expect(tab?.error).toBe(rejectionMessage);
      expect(
        tab?.messages.some((message) => message.id === 'ordinary-user-message'),
      ).toBe(false);
    } finally {
      jest.useRealTimers();
      mockTerminalSnapshot = undefined;
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });
});
