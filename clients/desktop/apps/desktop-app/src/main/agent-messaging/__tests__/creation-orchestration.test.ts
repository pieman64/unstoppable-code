/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  APP_ADVISOR_PROJECT_ID,
  type ChatCommandEnvelope,
  type ChatCommandExecutionOptions,
  type ChatSendMessageRequest,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { ChatCreationAction } from '@canopy/desktop-shared/lib/chat-send-actions';
import { reportAgentSendAccepted } from '../../canopy-runtime/core-chat-message-command-adapter';
import { DiscoveryError } from '../../project-discovery/errors';
import { dispatchAgentChatCreation } from '../creation-orchestration';
import {
  AgentChatSendError,
  dispatchAgentChatSend,
  type AgentChatSendContext,
} from '../send-orchestration';

const mockProject = jest.fn();
const mockTasks = jest.fn();
const mockAccess = jest.fn();
const mockEntries = jest.fn();
const mockIdentity = jest.fn();
const mockBuild = jest.fn();
const mockRevalidate = jest.fn();
const mockScaffold = jest.fn<Promise<void>, [string]>();
const mockCreate = jest.fn<
  Promise<{ entry: { id: string }; reusedExistingEmpty: boolean }>,
  [string, { id: string; title?: string; createdAt?: string }]
>();
const mockRemove = jest.fn();
const mockRead = jest.fn();
const mockSnapshot = jest.fn();
const mockDefaults = jest.fn();
const mockDispatch = jest.fn<
  Promise<{ outcome: string; entityId?: string }> | undefined,
  [ChatCommandEnvelope, { executionOptions: ChatCommandExecutionOptions }]
>();
const mockSend = jest.fn();
const mockReusable = jest.fn();
const mockResolveChat = jest.fn();
jest.mock('../../project-discovery/owner-policy', () => ({
  requireAuthorizedProject: (...args: unknown[]): unknown =>
    mockProject(...args),
}));
jest.mock('../../project-discovery/chats-list', () => ({
  listDiscoverableTaskIds: (...args: unknown[]): unknown => mockTasks(...args),
}));
jest.mock('../../project-discovery/chat-target', () => ({
  resolveAuthorizedChat: (...args: unknown[]): unknown =>
    mockResolveChat(...args),
}));
jest.mock('../../project-discovery/bots/target', () => ({
  requireBotAccess: (...args: unknown[]): unknown => mockAccess(...args),
  readBotEntries: (...args: unknown[]): unknown => mockEntries(...args),
}));
jest.mock('../../project-discovery/bots/registry', () => ({
  requireBot: (): object => ({
    botId: 'app_advisor',
    projectId: APP_ADVISOR_PROJECT_ID,
  }),
}));
jest.mock('../../project-discovery/runtime-state', () => ({
  readTaskRuntimeSnapshot: (...args: unknown[]): unknown =>
    mockSnapshot(...args),
}));
jest.mock('../../lib/cowork-work-entries', () => ({
  createWorkEntry: (...args: Parameters<typeof mockCreate>): unknown =>
    mockCreate(...args),
  removeWorkEntryRow: (...args: unknown[]): unknown => mockRemove(...args),
}));
jest.mock('../../lib/chat-project-utils', () => ({
  ensureCoworkHomeScaffold: (workspaceId: string): Promise<void> =>
    mockScaffold(workspaceId),
}));
jest.mock('../../lib/chat-tabs-reader', () => ({
  readChatTabsFile: (...args: unknown[]): unknown => mockRead(...args),
}));
jest.mock('../../portal/adapters/chat-adapter', () => ({
  resolveRemoteCreateTabSeed: (...args: unknown[]): unknown =>
    mockDefaults(...args),
}));
jest.mock('../sender-context', () => ({
  resolveAgentSenderIdentity: (...args: unknown[]): unknown =>
    mockIdentity(...args),
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
  dispatchTrustedChatCommand: (
    ...args: Parameters<typeof mockDispatch>
  ): unknown => mockDispatch(...args),
}));
jest.mock('../../services/chat-service', () => ({
  // The predicate's exact count/interface semantics are covered in chat-service.test.ts.
  isReusableEmptyChatTab: (...args: unknown[]): unknown =>
    mockReusable(...args),
  buildExistingTabDispatchOptions: (): Promise<object> => Promise.resolve({}),
  getRegisteredAppAdvisorSurfaces: (): undefined => undefined,
  sendWorktreeChatMessage: (...args: unknown[]): unknown => mockSend(...args),
}));
const source = {
  projectId: 'source-project',
  worktreeId: 'source-task',
  chatId: 'source-chat',
};
const context: AgentChatSendContext = {
  caller: { kind: 'project_root', source },
  watcherDestination: source,
};
const action: ChatCreationAction = {
  type: 'projects.create_task',
  projectId: 'target-project',
};
let tabs: PersistedChatTab[];
function tab(
  id: string,
  overrides: Partial<PersistedChatTab> = {},
): PersistedChatTab {
  return {
    id,
    title: 'Empty',
    createdAt: '2026-10-17T00:00:00.000Z',
    messages: [],
    ...overrides,
  };
}
beforeEach(() => {
  jest.resetAllMocks();
  mockScaffold.mockResolvedValue(undefined);
  tabs = [];
  mockProject.mockResolvedValue({
    projectId: 'target-project',
    type: 'cowork',
    readiness: 'ready',
  });
  mockTasks.mockResolvedValue(['target-task', source.worktreeId]);
  mockAccess.mockResolvedValue(undefined);
  // Like the real registry, a created entry is visible to later reads.
  const entries = [{ id: 'target-task' }];
  mockEntries.mockImplementation(() => Promise.resolve([...entries]));
  mockIdentity.mockResolvedValue({
    kind: 'project',
    projectId: source.projectId,
    taskId: source.worktreeId,
    chatId: source.chatId,
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
    agentSenderProvenance: { acceptedInputId: 'captured-input' },
    hiddenContext: {
      kind: 'agent-sender-context',
      text: 'trusted sender context',
    },
  });
  mockRevalidate.mockResolvedValue(undefined);
  mockCreate.mockImplementation(
    (_projectId: string, options: { id: string }) => {
      entries.push({ id: options.id });
      return Promise.resolve({
        entry: { id: options.id },
        reusedExistingEmpty: false,
      });
    },
  );
  mockRemove.mockResolvedValue(undefined);
  mockRead.mockImplementation(() => Promise.resolve({ tabs }));
  mockSnapshot.mockImplementation(() =>
    Promise.resolve({ tabsFile: { tabs } }),
  );
  mockDefaults.mockResolvedValue({
    model: 'fresh-model',
    providerType: 'claude',
    deferredToolsAllowed: true,
  });
  mockReusable.mockReturnValue(true);
  mockDispatch.mockImplementation(
    (
      envelope: ChatCommandEnvelope,
      options: { executionOptions: ChatCommandExecutionOptions },
    ) => {
      if (envelope.command.type === 'chat.create_tab') {
        tabs.push(tab(envelope.command.tabId));
        return Promise.resolve({
          outcome: 'applied',
          entityId: envelope.command.tabId,
        });
      }
      if (envelope.command.type === 'chat.send_message') {
        options.executionOptions.onAgentSendAccepted?.({
          disposition: 'started',
          acceptedInputId: envelope.command.userMessageId,
          acceptedAt: '2026-10-17T00:00:01.000Z',
        });
        return Promise.resolve({ outcome: 'applied' });
      }
      throw new Error('Unexpected command');
    },
  );
  mockResolveChat.mockImplementation(
    (address: { projectId: string; taskId: string; chatId: string }) =>
      Promise.resolve({
        address,
        projectType: 'cowork',
        scope: {
          workspaceId: address.projectId,
          worktreeId: address.taskId,
          chatId: address.chatId,
        },
        tab: tab(address.chatId),
      }),
  );
  mockSend.mockImplementation((request: ChatSendMessageRequest) => {
    reportAgentSendAccepted(request, {
      disposition: 'started',
      acceptedInputId: request.userMessageId,
      acceptedAt: '2026-10-17T00:00:01.000Z',
    });
    return Promise.resolve({ chatId: request.chatId });
  });
});

it('creates a fresh cowork task and empty chat without building sender payload or sending', async () => {
  const receipt = await dispatchAgentChatCreation(
    { ...action, title: '  My task  ' },
    context,
  );
  expect(receipt).toEqual({
    address: {
      projectId: 'target-project',
      taskId: expect.any(String),
      chatId: expect.any(String),
    },
    taskCreated: true,
    chatCreated: true,
  });
  expect(mockIdentity).toHaveBeenCalledWith(source);
  expect(mockCreate).toHaveBeenCalledWith('target-project', {
    id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    title: 'My task',
    createdAt: expect.any(String),
  });
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(mockDispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      command: expect.objectContaining({
        type: 'chat.create_tab',
        model: 'fresh-model',
        providerType: 'claude',
      }),
    }),
    expect.objectContaining({
      caller: expect.objectContaining({
        interfaceKind: 'mcp',
        clientInstanceId: 'agent-chat-creation',
        grants: ['core.chat.write'],
      }),
      executionOptions: { preserveActiveTab: true },
    }),
  );
  expect(mockBuild).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});
it.each([
  ['projects.create_task', undefined, false],
  ['projects.create_task', 'first input', false],
  ['projects.create_task_chat', undefined, false],
  ['projects.create_task_chat', 'first input', false],
  ['projects.create_task_chat', undefined, true],
  ['projects.create_task_chat', 'first input', true],
] as const)(
  '%s awaits the cowork cwd scaffold before receipt or send (initialMessage: %s, reuse: %s)',
  async (type, initialMessage, reuse) => {
    if (reuse) tabs = [tab('reused')];
    let finishScaffold = (): void => {};
    mockScaffold.mockReturnValue(
      new Promise<void>((resolve) => {
        finishScaffold = resolve;
      }),
    );
    const creationAction: ChatCreationAction =
      type === 'projects.create_task'
        ? { type, projectId: 'target-project', initialMessage }
        : {
            type,
            projectId: 'target-project',
            taskId: 'target-task',
            initialMessage,
          };
    let returned = false;
    const creation = dispatchAgentChatCreation(creationAction, context).then(
      (receipt) => {
        returned = true;
        return receipt;
      },
    );
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mockScaffold).toHaveBeenCalledWith('target-project');
      expect(returned).toBe(false);
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockDispatch).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    } finally {
      finishScaffold();
    }
    const receipt = await creation;
    expect(mockScaffold).toHaveBeenCalledTimes(1);
    if (initialMessage === undefined) {
      await dispatchAgentChatSend(
        {
          type: 'projects.send_message',
          projectId: 'target-project',
          taskId: receipt.address.taskId,
          chatId: receipt.address.chatId,
          text: 'first input',
        },
        context,
      );
    }
    expect(
      mockDispatch.mock.calls.map(([envelope]) => envelope.command.type),
    ).toEqual(
      reuse ? ['chat.send_message'] : ['chat.create_tab', 'chat.send_message'],
    );
  },
);
it.each(['projects.create_task', 'projects.create_task_chat'] as const)(
  '%s does not create a task or chat when the cowork cwd scaffold fails',
  async (type) => {
    mockScaffold.mockRejectedValue(new Error('cwd unavailable'));
    const creationAction: ChatCreationAction =
      type === 'projects.create_task'
        ? { type, projectId: 'target-project', initialMessage: 'first input' }
        : {
            type,
            projectId: 'target-project',
            taskId: 'target-task',
            initialMessage: 'first input',
          };
    await expect(
      dispatchAgentChatCreation(creationAction, context),
    ).rejects.toMatchObject({ code: 'target_not_ready' });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  },
);
it('omits a blank trimmed task title', async () => {
  await dispatchAgentChatCreation({ ...action, title: '   ' }, context);
  expect(mockCreate.mock.calls[0]?.[1]).not.toHaveProperty('title');
});
it('sends a cowork founding message exactly once through trusted send with marker and context', async () => {
  const receipt = await dispatchAgentChatCreation(
    { ...action, initialMessage: '  first input  ' },
    context,
  );
  expect(receipt.input).toMatchObject({
    address: receipt.address,
    disposition: 'started',
    messageId: expect.any(String),
  });
  expect(mockBuild).toHaveBeenCalledTimes(1);
  expect(mockDispatch).toHaveBeenCalledTimes(2);
  expect(mockDispatch).toHaveBeenLastCalledWith(
    expect.objectContaining({
      command: expect.objectContaining({
        type: 'chat.send_message',
        chatId: receipt.address.chatId,
        text: '  first input  ',
        agentSent: expect.any(Object),
        hiddenContext: {
          kind: 'agent-sender-context',
          text: 'trusted sender context',
        },
      }),
    }),
    expect.any(Object),
  );
});
it("starts a root-created chat in its start admission's mode", async () => {
  const startAdmission = jest.fn().mockResolvedValue({ approvalMode: 'ask' });
  const receipt = await dispatchAgentChatCreation(
    { ...action, initialMessage: 'first input' },
    { ...context, startAdmission },
  );
  expect(startAdmission).toHaveBeenCalledWith(
    { workspaceId: 'target-project', worktreeId: receipt.address.taskId },
    true,
  );
  expect(mockDispatch.mock.calls[0]?.[0]?.command).toMatchObject({
    type: 'chat.create_tab',
    approvalMode: 'ask',
  });
});
it('creates nothing when the start admission refuses', async () => {
  const startAdmission = jest
    .fn()
    .mockRejectedValue(
      new AgentChatSendError('authorization_conflict', 'Broader approvals.'),
    );
  await expect(
    dispatchAgentChatCreation(
      { ...action, initialMessage: 'first input' },
      { ...context, startAdmission },
    ),
  ).rejects.toMatchObject({ code: 'authorization_conflict' });
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockDispatch).not.toHaveBeenCalled();
});
it('refuses code task creation with worktree workflow guidance and no writes', async () => {
  mockProject.mockResolvedValue({
    projectId: 'target-project',
    type: 'code',
    readiness: 'ready',
  });
  await expect(
    dispatchAgentChatCreation(action, context),
  ).rejects.toMatchObject({
    code: 'unsupported_action',
    message: expect.stringContaining('worktree-creation workflow'),
  });
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockDispatch).not.toHaveBeenCalled();
  expect(mockScaffold).not.toHaveBeenCalled();
});
it('reuses the first eligible empty task chat without resetting its defaults', async () => {
  tabs = [tab('first', { model: 'chosen-model' }), tab('second')];
  const receipt = await dispatchAgentChatCreation(
    {
      type: 'projects.create_task_chat',
      projectId: 'target-project',
      taskId: 'target-task',
    },
    context,
  );
  expect(receipt).toEqual({
    address: {
      projectId: 'target-project',
      taskId: 'target-task',
      chatId: 'first',
    },
    taskCreated: false,
    chatCreated: false,
  });
  expect(mockDispatch).not.toHaveBeenCalled();
  expect(mockDefaults).not.toHaveBeenCalled();
  expect(mockScaffold).toHaveBeenCalledWith('target-project');
  expect(tabs[0]?.model).toBe('chosen-model');
});
it('creates a task chat when the existing empty-tab predicate rejects every candidate', async () => {
  tabs = [tab('non-reusable')];
  mockReusable.mockReturnValue(false);
  const receipt = await dispatchAgentChatCreation(
    {
      type: 'projects.create_task_chat',
      projectId: 'target-project',
      taskId: 'target-task',
    },
    context,
  );
  expect(receipt).toMatchObject({ taskCreated: false, chatCreated: true });
  expect(receipt.address.chatId).not.toBe('non-reusable');
  expect(mockReusable).toHaveBeenCalledWith(tabs[0]);
  expect(mockCreate).not.toHaveBeenCalled();
});
it('skips read-only, stale-session, file and caller-self tabs before empty-tab reuse', async () => {
  tabs = [
    tab('read-only', { readOnly: true }),
    tab('stale', {
      staleSessionDetected: { droppedMessageText: '' },
    }),
    tab('file', { kind: 'file' }),
    tab(source.chatId),
    tab('safe'),
  ];
  mockProject.mockResolvedValue({
    projectId: source.projectId,
    type: 'cowork',
    readiness: 'ready',
  });
  const receipt = await dispatchAgentChatCreation(
    {
      type: 'projects.create_task_chat',
      projectId: source.projectId,
      taskId: source.worktreeId,
    },
    context,
  );
  expect(receipt.address.chatId).toBe('safe');
  expect(mockReusable).toHaveBeenCalledTimes(1);
  expect(mockDispatch).not.toHaveBeenCalled();
});
it('creates a new chat when only the caller chat is empty in the same task', async () => {
  tabs = [tab(source.chatId)];
  mockProject.mockResolvedValue({
    projectId: source.projectId,
    type: 'code',
    readiness: 'ready',
  });
  const receipt = await dispatchAgentChatCreation(
    {
      type: 'projects.create_task_chat',
      projectId: source.projectId,
      taskId: source.worktreeId,
      initialMessage: 'start sibling',
    },
    context,
  );
  expect(receipt.chatCreated).toBe(true);
  expect(receipt.address.chatId).not.toBe(source.chatId);
  expect(mockDispatch).toHaveBeenCalledTimes(2);
  expect(mockScaffold).not.toHaveBeenCalled();
});
it.each(['bots.create_task', 'bots.create_task_chat'] as const)(
  '%s creates through a bare command and sends once with Advisor defaults and sender fields',
  async (type) => {
    const botAction: ChatCreationAction =
      type === 'bots.create_task'
        ? { type, botId: 'app_advisor', initialMessage: 'bot input' }
        : {
            type,
            botId: 'app_advisor',
            taskId: 'target-task',
            initialMessage: 'bot input',
          };
    const receipt = await dispatchAgentChatCreation(botAction, context);
    expect(receipt).toMatchObject({
      address: {
        botId: 'app_advisor',
        taskId: expect.any(String),
        chatId: expect.any(String),
      },
      taskCreated: type === 'bots.create_task',
      chatCreated: true,
      input: { disposition: 'started' },
    });
    expect(mockDefaults).not.toHaveBeenCalled();
    expect(mockScaffold).not.toHaveBeenCalled();
    const command = mockDispatch.mock.calls[0]?.[0]?.command;
    expect(command).toEqual({
      type: 'chat.create_tab',
      tabId: receipt.address.chatId,
    });
    expect(command).not.toHaveProperty('model');
    expect(command).not.toHaveProperty('providerType');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: receipt.address.chatId,
        text: 'bot input',
        agentSent: expect.any(Object),
        hiddenContext: expect.any(Object),
      }),
      expect.objectContaining({ preserveActiveTab: true }),
    );
  },
);
it('reuses a bot task chat and attaches its accepted initial input', async () => {
  tabs = [tab('bot-empty')];
  const receipt = await dispatchAgentChatCreation(
    {
      type: 'bots.create_task_chat',
      botId: 'app_advisor',
      taskId: 'target-task',
      initialMessage: 'hello',
    },
    context,
  );
  expect(receipt).toMatchObject({
    address: { chatId: 'bot-empty' },
    taskCreated: false,
    chatCreated: false,
    input: { disposition: 'started' },
  });
  expect(mockDispatch).not.toHaveBeenCalled();
  expect(mockSend).toHaveBeenCalledTimes(1);
});
it('hides cross-owner project targets as not_found before writes', async () => {
  mockProject.mockRejectedValue(new DiscoveryError('not_found', 'hidden'));
  await expect(
    dispatchAgentChatCreation(action, context),
  ).rejects.toMatchObject({ code: 'not_found' });
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockDispatch).not.toHaveBeenCalled();
});
it('refuses a disallowed bot origin as advisor_access_disabled before writes', async () => {
  mockAccess.mockRejectedValue(
    new DiscoveryError('advisor_access_disabled', 'disabled'),
  );
  await expect(
    dispatchAgentChatCreation(
      {
        type: 'bots.create_task',
        botId: 'app_advisor',
        initialMessage: 'hello',
      },
      context,
    ),
  ).rejects.toMatchObject({ code: 'advisor_access_disabled' });
  expect(mockEntries).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockDispatch).not.toHaveBeenCalled();
});
it.each(['projects.create_task_chat', 'bots.create_task_chat'] as const)(
  '%s requires a discoverable existing task',
  async (type) => {
    mockTasks.mockResolvedValue([]);
    mockEntries.mockResolvedValue([]);
    const targetAction: ChatCreationAction =
      type === 'projects.create_task_chat'
        ? { type, projectId: 'target-project', taskId: 'missing-task' }
        : {
            type,
            botId: 'app_advisor',
            taskId: 'missing-task',
            initialMessage: 'hello',
          };
    await expect(
      dispatchAgentChatCreation(targetAction, context),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(mockSnapshot).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  },
);
it('uses distinct command UUIDs for every create and its send', async () => {
  await dispatchAgentChatCreation(
    { ...action, initialMessage: 'one' },
    context,
  );
  await dispatchAgentChatCreation(
    { ...action, initialMessage: 'two' },
    context,
  );
  const ids = mockDispatch.mock.calls.map((args) => {
    const envelope: ChatCommandEnvelope = args[0];
    return envelope.commandId;
  });
  expect(ids).toHaveLength(4);
  expect(new Set(ids).size).toBe(4);
  for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(mockCreate.mock.calls[0]?.[1]?.id).not.toBe(
    mockCreate.mock.calls[1]?.[1]?.id,
  );
});
it('removes only its newly allocated entry when chat creation fails and no chat exists', async () => {
  mockDispatch.mockResolvedValue({ outcome: 'rejected' });
  await expect(
    dispatchAgentChatCreation(action, context),
  ).rejects.toMatchObject({ code: 'target_not_ready' });
  expect(mockRemove).toHaveBeenCalledWith(
    'target-project',
    mockCreate.mock.calls[0]?.[1]?.id,
  );
});
it.each(['saved chat', 'unreadable state'])(
  'keeps a new entry after an ambiguous failure with %s',
  async (state) => {
    mockDispatch.mockImplementation(() => {
      if (state === 'saved chat') tabs.push(tab('concurrently-saved'));
      else mockRead.mockRejectedValue(new Error('unreadable'));
      return Promise.reject(new Error('reply lost'));
    });
    await expect(
      dispatchAgentChatCreation(action, context),
    ).rejects.toMatchObject({ code: 'target_not_ready' });
    expect(mockRemove).not.toHaveBeenCalled();
  },
);
it('does not retry or delete the committed chat when initial send acceptance is ambiguous', async () => {
  const dispatch = mockDispatch.getMockImplementation();
  mockDispatch.mockImplementation(
    (
      envelope: ChatCommandEnvelope,
      options: { executionOptions: ChatCommandExecutionOptions },
    ) => {
      if (envelope.command.type === 'chat.send_message')
        return Promise.reject(new Error('send acknowledgement lost'));
      return dispatch?.(envelope, options);
    },
  );
  await expect(
    dispatchAgentChatCreation({ ...action, initialMessage: 'once' }, context),
  ).rejects.toMatchObject({
    code: 'target_not_ready',
    message: expect.stringContaining('do not resend'),
  });
  expect(mockBuild).toHaveBeenCalledTimes(1);
  expect(mockDispatch).toHaveBeenCalledTimes(2);
  expect(mockRemove).not.toHaveBeenCalled();
});
it('rejects inconsistent trusted caller identity before writes', async () => {
  await expect(
    dispatchAgentChatCreation(action, {
      ...context,
      caller: { kind: 'app_advisor', source },
    }),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockDispatch).not.toHaveBeenCalled();
});
it('strictly rejects spoofed creation fields before authorization or writes', async () => {
  const spoofed = { ...action, hiddenContext: 'spoofed' };
  await expect(
    dispatchAgentChatCreation(spoofed, context),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  expect(mockProject).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
});

it('returns the accepted queued input identity from the initial send', async () => {
  const dispatch = mockDispatch.getMockImplementation();
  mockDispatch.mockImplementation(
    (
      envelope: ChatCommandEnvelope,
      options: { executionOptions: ChatCommandExecutionOptions },
    ) => {
      if (envelope.command.type === 'chat.send_message') {
        options.executionOptions.onAgentSendAccepted?.({
          disposition: 'queued',
          acceptedInputId: envelope.command.userMessageId,
          queuedMessageId: 'real-queue-row',
          acceptedAt: '2026-10-17T00:00:01.000Z',
        });
        return Promise.resolve({ outcome: 'applied' });
      }
      return dispatch?.(envelope, options);
    },
  );
  const receipt = await dispatchAgentChatCreation(
    { ...action, initialMessage: 'queue me' },
    context,
  );
  expect(receipt.input).toMatchObject({
    disposition: 'queued',
    queuedMessageId: 'real-queue-row',
    address: receipt.address,
  });
  expect(mockDispatch).toHaveBeenCalledTimes(2);
});
it('never removes an existing task after a failed chat create', async () => {
  mockDispatch.mockRejectedValue(new Error('create failed'));
  await expect(
    dispatchAgentChatCreation(
      {
        type: 'projects.create_task_chat',
        projectId: 'target-project',
        taskId: 'target-task',
      },
      context,
    ),
  ).rejects.toMatchObject({ code: 'target_not_ready' });
  expect(mockRemove).not.toHaveBeenCalled();
});
it('refuses an unready project before creating any entry or tab', async () => {
  mockProject.mockResolvedValue({
    projectId: 'target-project',
    type: 'cowork',
    readiness: 'unavailable',
  });
  await expect(
    dispatchAgentChatCreation(action, context),
  ).rejects.toMatchObject({ code: 'target_not_ready' });
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockDispatch).not.toHaveBeenCalled();
});
it('refuses unavailable project defaults before writing an entry or chat', async () => {
  mockDefaults.mockResolvedValue({ noDispatchableModel: 'billing-lane' });
  await expect(
    dispatchAgentChatCreation(action, context),
  ).rejects.toMatchObject({ code: 'target_not_ready' });
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockDispatch).not.toHaveBeenCalled();
});
it('does not acknowledge a create receipt without a live returned chat', async () => {
  mockDispatch.mockResolvedValue({ outcome: 'applied', entityId: 'missing' });
  await expect(
    dispatchAgentChatCreation(action, context),
  ).rejects.toMatchObject({ code: 'target_not_ready' });
  expect(mockBuild).not.toHaveBeenCalled();
  expect(mockRemove).toHaveBeenCalledTimes(1);
});

it.each(['projects.create_task', 'bots.create_task'] as const)(
  '%s retains its empty founding chat after a definite initial-send refusal when safe entry-and-tab removal is unavailable',
  async (type) => {
    // Canonical create already committed the founding tab before send refused.
    const dispatch = mockDispatch.getMockImplementation();
    mockDispatch.mockImplementation(
      (
        envelope: ChatCommandEnvelope,
        options: { executionOptions: ChatCommandExecutionOptions },
      ) => {
        if (envelope.command.type === 'chat.send_message')
          return Promise.resolve({ outcome: 'rejected' });
        return dispatch?.(envelope, options);
      },
    );
    mockSend.mockRejectedValue(
      new AgentChatSendError('not_found', 'Refused before acceptance'),
    );
    const initialAction: ChatCreationAction =
      type === 'projects.create_task'
        ? { type, projectId: 'target-project', initialMessage: 'first' }
        : { type, botId: 'app_advisor', initialMessage: 'first' };
    await expect(
      dispatchAgentChatCreation(initialAction, context),
    ).rejects.toBeInstanceOf(AgentChatSendError);
    expect(mockRemove).not.toHaveBeenCalled();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.messages).toEqual([]);
    expect(mockBuild).toHaveBeenCalledTimes(1);
  },
);
it.each(['projects.create_task', 'bots.create_task'] as const)(
  '%s keeps its entry after an ambiguous initial send even if a later probe would find no chat',
  async (type) => {
    mockRead.mockResolvedValue({ tabs: [] });
    const dispatch = mockDispatch.getMockImplementation();
    mockDispatch.mockImplementation(
      (
        envelope: ChatCommandEnvelope,
        options: { executionOptions: ChatCommandExecutionOptions },
      ) => {
        if (envelope.command.type === 'chat.send_message')
          return Promise.reject(new Error('Acknowledgement lost'));
        return dispatch?.(envelope, options);
      },
    );
    mockSend.mockRejectedValue(new Error('Acknowledgement lost'));
    const initialAction: ChatCreationAction =
      type === 'projects.create_task'
        ? { type, projectId: 'target-project', initialMessage: 'first' }
        : { type, botId: 'app_advisor', initialMessage: 'first' };
    await expect(
      dispatchAgentChatCreation(initialAction, context),
    ).rejects.toMatchObject({
      code: 'target_not_ready',
      message: expect.stringContaining('do not resend'),
    });
    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockBuild).toHaveBeenCalledTimes(1);
  },
);
