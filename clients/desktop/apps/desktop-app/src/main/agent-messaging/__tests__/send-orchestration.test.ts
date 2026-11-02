import { reportAgentSendAccepted } from '../../canopy-runtime/core-chat-message-command-adapter';
import { DiscoveryError } from '../../project-discovery/errors';
import {
  APP_ADVISOR_PROJECT_ID,
  type ChatSendMessageRequest,
} from '@canopy/desktop-shared/types';
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  AgentChatSendError,
  dispatchAgentChatSend,
  type AgentChatSendContext,
} from '../send-orchestration';
import { chatSendAdmissionCheck } from '../../services/chat-send-admission';
import type {
  AgentSendAcceptanceFacts,
  ChatSendAction,
  InlineChatWatcherReservationPort,
} from '@canopy/desktop-shared/lib/chat-send-actions';
import type {
  ChatCommandEnvelope,
  ChatCommandExecutionOptions,
} from '@canopy/desktop-shared/types';

const mockResolve = jest.fn();
const mockBotAccess = jest.fn();
const mockBotEntries = jest.fn();
const mockBuild = jest.fn();
const mockRevalidate = jest.fn();
const mockDispatch = jest.fn();
const mockSend = jest.fn();
jest.mock('../../project-discovery/chat-target', () => ({
  resolveAuthorizedChat: (...args: unknown[]): unknown => mockResolve(...args),
}));
jest.mock('../../project-discovery/bots/target', () => ({
  requireBotAccess: (...args: unknown[]): unknown => mockBotAccess(...args),
  readBotEntries: (...args: unknown[]): unknown => mockBotEntries(...args),
}));
jest.mock('../../project-discovery/bots/registry', () => ({
  requireBot: (): object => ({
    botId: 'app_advisor',
    projectId: 'app-advisor',
  }),
}));
jest.mock('../../project-discovery/runtime-state', () => ({
  readTaskRuntimeSnapshot: (): Promise<object> =>
    Promise.resolve({
      tabsFile: { tabs: [{ id: 'target-chat', kind: 'chat' }] },
    }),
}));
jest.mock('../sender-context', () => ({
  buildAgentSenderRequest: (...args: unknown[]): unknown => mockBuild(...args),
  revalidateAgentSenderRequest: (...args: unknown[]): unknown =>
    mockRevalidate(...args),
  isAgentSenderContextError: (): boolean => false,
}));
jest.mock('../../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): object => ({}),
}));
jest.mock('../../ipc/chat-state', () => ({
  getChatStateCommandPort: (): object => ({ command: jest.fn() }),
}));
jest.mock('../../canopy-runtime/core-chat-command-adapter', () => ({
  createChatCommandDispatchOptions: (
    _port: unknown,
    _runtime: unknown,
    caller: unknown,
  ): object => ({ caller }),
  dispatchTrustedChatCommand: (...args: unknown[]): unknown =>
    mockDispatch(...args),
}));
const registeredSurfaces = { getMainWindow: (): null => null };
jest.mock('../../services/chat-service', () => ({
  buildExistingTabDispatchOptions: (): Promise<{ model: string }> =>
    Promise.resolve({ model: 'target-model' }),
  getRegisteredAppAdvisorSurfaces: (): object => registeredSurfaces,
  sendWorktreeChatMessage: (...args: unknown[]): unknown => mockSend(...args),
}));
const source = {
  projectId: 'source-project',
  worktreeId: 'source-task',
  chatId: 'source-chat',
};
const target = {
  projectId: 'target-project',
  taskId: 'target-task',
  chatId: 'target-chat',
};
const action: ChatSendAction = {
  type: 'projects.send_message',
  ...target,
  text: '  original text  ',
};
let facts: AgentSendAcceptanceFacts;
let watchers: {
  reserveInlineChatWatchers: jest.Mock<
    ReturnType<InlineChatWatcherReservationPort['reserveInlineChatWatchers']>,
    Parameters<InlineChatWatcherReservationPort['reserveInlineChatWatchers']>
  >;
  confirmInlineChatWatchers: jest.Mock<
    ReturnType<InlineChatWatcherReservationPort['confirmInlineChatWatchers']>,
    Parameters<InlineChatWatcherReservationPort['confirmInlineChatWatchers']>
  >;
  cancelInlineChatWatchers: jest.Mock<
    ReturnType<InlineChatWatcherReservationPort['cancelInlineChatWatchers']>,
    Parameters<InlineChatWatcherReservationPort['cancelInlineChatWatchers']>
  >;
};
let context: AgentChatSendContext;
beforeEach(() => {
  jest.clearAllMocks();
  mockBotAccess.mockResolvedValue(undefined);
  mockBotEntries.mockResolvedValue([{ id: 'target-task' }]);
  facts = {
    acceptedInputId: 'input',
    disposition: 'queued',
    queuedMessageId: 'real-queue-row',
    acceptedAt: '2026-10-17T00:00:00.000Z',
  };
  mockResolve.mockResolvedValue({
    address: target,
    projectType: 'code',
    scope: {
      workspaceId: target.projectId,
      worktreeId: target.taskId,
      chatId: target.chatId,
    },
    tab: { id: target.chatId },
    row: {},
  });
  mockBuild.mockResolvedValue({
    agentSent: {
      sender: {
        kind: 'project',
        projectId: source.projectId,
        taskId: source.worktreeId,
        chatId: source.chatId,
      },
    },
    agentSenderProvenance: { acceptedInputId: 'input' },
    hiddenContext: { kind: 'agent-sender-context', text: 'trusted note' },
  });
  mockDispatch.mockImplementation(
    (
      envelope: ChatCommandEnvelope,
      options: { executionOptions: ChatCommandExecutionOptions },
    ) => {
      facts.acceptedInputId =
        envelope.command.type === 'chat.send_message'
          ? envelope.command.userMessageId
          : 'wrong';
      options.executionOptions.onAgentSendAccepted?.(facts);
      return Promise.resolve({ outcome: 'applied' });
    },
  );
  watchers = {
    reserveInlineChatWatchers: jest.fn().mockResolvedValue({
      ok: true,
      reservation: { reservationId: 'reservation', receipts: [] },
    }),
    confirmInlineChatWatchers: jest
      .fn()
      .mockResolvedValue([{ watcherId: 'watch', disposition: 'created' }]),
    cancelInlineChatWatchers: jest.fn().mockResolvedValue(undefined),
  };
  context = {
    caller: { kind: 'project_root', source },
    watcherDestination: source,
    toolUseId: 'tool-use',
    watchers,
  };
});
it('uses the core command and captured actual queue identity, reserving before dispatch', async () => {
  const receipt = await dispatchAgentChatSend(
    { ...action, watchers: [{}] },
    context,
  );
  expect(receipt).toMatchObject({
    address: target,
    disposition: 'queued',
    queuedMessageId: 'real-queue-row',
    acceptedAt: facts.acceptedAt,
    watcherReceipts: [{ watcherId: 'watch', disposition: 'created' }],
  });
  expect(mockDispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      command: expect.objectContaining({
        agentSent: expect.any(Object),
        hiddenContext: { kind: 'agent-sender-context', text: 'trusted note' },
        text: action.text,
      }),
    }),
    expect.objectContaining({
      caller: expect.objectContaining({
        interfaceKind: 'mcp',
        grants: ['core.chat.write'],
      }),
    }),
  );
  expect(
    watchers.reserveInlineChatWatchers.mock.invocationCallOrder[0],
  ).toBeLessThan(mockDispatch.mock.invocationCallOrder[0] ?? 0);
  expect(watchers.confirmInlineChatWatchers).toHaveBeenCalledWith(
    'reservation',
    facts,
  );
});
it('fails a chat caller without a watcher destination at the reservation, sending nothing', async () => {
  const withoutDestination: AgentChatSendContext = {
    caller: context.caller,
    toolUseId: 'tool-use',
    watchers,
  };
  await expect(
    dispatchAgentChatSend({ ...action, watchers: [{}] }, withoutDestination),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  expect(watchers.reserveInlineChatWatchers).not.toHaveBeenCalled();
  expect(mockDispatch).not.toHaveBeenCalled();
});
it('does not dispatch if reservation fails', async () => {
  watchers.reserveInlineChatWatchers.mockResolvedValue({
    ok: false,
    code: 'not_found',
    error: 'Unavailable',
  });
  await expect(
    dispatchAgentChatSend({ ...action, watchers: [{}] }, context),
  ).rejects.toMatchObject({ code: 'not_found' });
  expect(mockDispatch).not.toHaveBeenCalled();
});
it('never cancels an accepted reservation when confirmation fails', async () => {
  watchers.confirmInlineChatWatchers.mockRejectedValue(new Error('disk error'));
  await expect(
    dispatchAgentChatSend({ ...action, watchers: [{}] }, context),
  ).rejects.toThrow('disk error');
  expect(watchers.cancelInlineChatWatchers).not.toHaveBeenCalled();
});
it('cancels a reservation on a definite command refusal', async () => {
  mockDispatch.mockResolvedValue({ outcome: 'rejected' });
  await expect(
    dispatchAgentChatSend({ ...action, watchers: [{}] }, context),
  ).rejects.toMatchObject({ code: 'target_not_ready' });
  expect(watchers.cancelInlineChatWatchers).toHaveBeenCalledWith('reservation');
});
it('rejects canonical self sends and unsupported cowork setup options before dispatch', async () => {
  mockResolve.mockResolvedValueOnce({
    address: {
      projectId: source.projectId,
      taskId: source.worktreeId,
      chatId: source.chatId,
    },
    scope: {
      workspaceId: source.projectId,
      worktreeId: source.worktreeId,
      chatId: source.chatId,
    },
    tab: {},
    projectType: 'code',
  });
  await expect(dispatchAgentChatSend(action, context)).rejects.toMatchObject({
    code: 'unsupported_action',
  });
  mockResolve.mockResolvedValueOnce({
    address: target,
    scope: {
      workspaceId: source.projectId,
      worktreeId: source.worktreeId,
      chatId: source.chatId,
    },
    tab: {},
    projectType: 'cowork',
  });
  await expect(
    dispatchAgentChatSend({ ...action, queueForSetup: false }, context),
  ).rejects.toMatchObject({ code: 'unsupported_action' });
  expect(mockDispatch).not.toHaveBeenCalled();
});

it('confirms an accepted reservation after an ambiguous transport failure without resending', async () => {
  mockDispatch.mockImplementationOnce(
    (
      envelope: ChatCommandEnvelope,
      options: { executionOptions: ChatCommandExecutionOptions },
    ) => {
      options.executionOptions.onAgentSendAccepted?.({
        ...facts,
        acceptedInputId:
          envelope.command.type === 'chat.send_message'
            ? envelope.command.userMessageId
            : 'wrong',
      });
      return Promise.reject(new Error('transport disconnected after commit'));
    },
  );
  await expect(
    dispatchAgentChatSend({ ...action, watchers: [{}] }, context),
  ).resolves.toMatchObject({ disposition: 'queued' });
  expect(watchers.confirmInlineChatWatchers).toHaveBeenCalledTimes(1);
  expect(watchers.cancelInlineChatWatchers).not.toHaveBeenCalled();
  expect(mockDispatch).toHaveBeenCalledTimes(1);
});

it('keeps an unconfirmed reservation inert on an ambiguous unaccepted error', async () => {
  mockDispatch.mockRejectedValueOnce(new Error('transport disconnected'));
  await expect(
    dispatchAgentChatSend({ ...action, watchers: [{}] }, context),
  ).rejects.toThrow('transport disconnected');
  expect(watchers.cancelInlineChatWatchers).not.toHaveBeenCalled();
  expect(watchers.confirmInlineChatWatchers).not.toHaveBeenCalled();
});

it('rejects invalid text and forged caller fields before resolving a target', async () => {
  await expect(
    dispatchAgentChatSend({ ...action, text: ' \n ' }, context),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  const forged = { ...action, agentSent: { sender: { kind: 'bot' } } };
  await expect(dispatchAgentChatSend(forged, context)).rejects.toMatchObject({
    code: 'validation_failed',
  });
  expect(mockResolve).not.toHaveBeenCalled();
});

it('uses the retained trusted bot send with the target settings and no navigation', async () => {
  mockSend.mockImplementation((request: ChatSendMessageRequest) => {
    reportAgentSendAccepted(request, {
      ...facts,
      acceptedInputId: request.userMessageId,
    });
    return Promise.resolve({ ok: true, chatId: request.chatId });
  });
  await expect(
    dispatchAgentChatSend(
      {
        type: 'bots.send_message',
        botId: 'app_advisor',
        taskId: 'target-task',
        chatId: 'target-chat',
        text: 'bot input',
      },
      context,
    ),
  ).resolves.toMatchObject({
    address: {
      botId: 'app_advisor',
      taskId: 'target-task',
      chatId: 'target-chat',
    },
    disposition: 'queued',
    queuedMessageId: 'real-queue-row',
  });
  expect(mockSend).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: APP_ADVISOR_PROJECT_ID,
      model: 'target-model',
      text: 'bot input',
      agentSenderProvenance: expect.any(Object),
    }),
    // A root project caller has no surfaces; the registered Advisor ones apply.
    expect.objectContaining({
      preserveActiveTab: true,
      appAdvisorSurfaces: registeredSurfaces,
    }),
  );
  expect(mockDispatch).not.toHaveBeenCalled();
  expect(mockBotAccess.mock.invocationCallOrder[0]).toBeLessThan(
    mockBotEntries.mock.invocationCallOrder[0] ?? 0,
  );
});

it('refuses a disallowed bot origin before reading bot storage', async () => {
  mockBotAccess.mockRejectedValueOnce(
    new DiscoveryError('advisor_access_disabled', 'Unavailable'),
  );
  await expect(
    dispatchAgentChatSend(
      {
        type: 'bots.send_message',
        botId: 'app_advisor',
        taskId: 'target-task',
        chatId: 'target-chat',
        text: 'bot input',
      },
      context,
    ),
  ).rejects.toMatchObject({ code: 'advisor_access_disabled' });
  expect(mockBotEntries).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});

it('refuses an expired-session target that discovery reports as unsendable', async () => {
  mockResolve.mockResolvedValueOnce({
    address: target,
    projectType: 'code',
    scope: {
      workspaceId: target.projectId,
      worktreeId: target.taskId,
      chatId: target.chatId,
    },
    tab: { id: target.chatId, staleSessionDetected: {} },
    row: {},
  });
  await expect(dispatchAgentChatSend(action, context)).rejects.toMatchObject({
    code: 'not_found',
  });
  expect(mockDispatch).not.toHaveBeenCalled();
  expect(watchers.reserveInlineChatWatchers).not.toHaveBeenCalled();
});

describe('root send admission', () => {
  const check = jest.fn((): string | undefined => undefined);

  it('reads admission before reserving watchers and checks it as the message commits', async () => {
    const admission = jest.fn().mockResolvedValue({
      check,
      refusal: (): undefined => undefined,
    });
    let activeCheck: unknown;
    mockDispatch.mockImplementation(
      (
        envelope: ChatCommandEnvelope,
        options: { executionOptions: ChatCommandExecutionOptions },
      ) => {
        if (envelope.command.type !== 'chat.send_message')
          throw new Error('Unexpected command');
        activeCheck = chatSendAdmissionCheck({
          projectId: target.projectId,
          worktreeId: target.taskId,
          chatId: target.chatId,
          userMessageId: envelope.command.userMessageId,
        });
        facts.acceptedInputId = envelope.command.userMessageId;
        options.executionOptions.onAgentSendAccepted?.(facts);
        return Promise.resolve({ outcome: 'applied' });
      },
    );
    await dispatchAgentChatSend(
      { ...action, watchers: [{}] },
      { ...context, admission },
    );
    expect(admission).toHaveBeenCalledWith({
      workspaceId: target.projectId,
      worktreeId: target.taskId,
      chatId: target.chatId,
    });
    expect(admission.mock.invocationCallOrder[0]).toBeLessThan(
      watchers.reserveInlineChatWatchers.mock.invocationCallOrder[0] ?? 0,
    );
    expect(activeCheck).toBe(check);
  });

  it('throws the admission refusal when the commit refuses the message', async () => {
    const refusal = new AgentChatSendError(
      'authorization_conflict',
      'Chat target-chat runs with broader tool approvals than this chat.',
    );
    mockDispatch.mockResolvedValue({ outcome: 'rejected', reason: 'refused' });
    await expect(
      dispatchAgentChatSend(
        { ...action, watchers: [{}] },
        {
          ...context,
          admission: () => Promise.resolve({ check, refusal: () => refusal }),
        },
      ),
    ).rejects.toBe(refusal);
    expect(watchers.cancelInlineChatWatchers).toHaveBeenCalledWith(
      'reservation',
    );
  });

  it('reserves and dispatches nothing when admission refuses up front', async () => {
    await expect(
      dispatchAgentChatSend(
        { ...action, watchers: [{}] },
        {
          ...context,
          admission: () =>
            Promise.reject(
              new AgentChatSendError('target_not_ready', 'Terminal chat.'),
            ),
        },
      ),
    ).rejects.toMatchObject({ code: 'target_not_ready' });
    expect(watchers.reserveInlineChatWatchers).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('leaves bot sends to the bot path without admission', async () => {
    const admission = jest.fn();
    mockSend.mockImplementation(() => Promise.resolve());
    await dispatchAgentChatSend(
      {
        type: 'bots.send_message',
        botId: 'app_advisor',
        taskId: 'target-task',
        chatId: 'target-chat',
        text: 'hello',
      },
      { ...context, admission },
    ).catch(() => undefined);
    expect(admission).not.toHaveBeenCalled();
  });
});
