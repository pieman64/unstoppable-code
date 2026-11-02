/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  APP_ADVISOR_PROJECT_ID,
  getProviderForModel,
  initAgentModels,
  initClaudeModels,
  initCodexModels,
  type ChatCommandEnvelope,
  type ChatCommandExecutionOptions,
  type ChatSendMessageRequest,
  type ChatTabPluginSelections,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type {
  AgentModelDefinition,
  AgentModelRegistryEntry,
} from '@canopy/desktop-shared/types/agent-models';
import { resolveAgentModelRuntime } from '../../agents/agent-model-runtime';
import type * as WorkOwner from '../../agents/work-owner';
import { NoDispatchableModelError } from '../../lib/default-model-lane-resolver';
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
const mockOriginRevalidate = jest.fn().mockResolvedValue(undefined);
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
  revalidatePipelineAgentOrigin: (...args: unknown[]): unknown =>
    mockOriginRevalidate(...args),
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
// Target-scoped model checks (creation-model.ts). The Agent registry and the
// pin/runtime helpers stay real; their storage, policy and runtime edges are
// stubbed per test.
const mockLaneDefault = jest.fn();
const mockIsCowork = jest.fn<boolean, [string]>();
const mockGetAgent = jest.fn<
  Promise<AgentModelDefinition | null>,
  [string, string | undefined]
>();
const mockOwner = jest.fn();
const mockBlocked = jest.fn<Promise<boolean>, [string | undefined, unknown]>();
const mockGateway = jest.fn<
  Promise<{ ok: true; orgRoute: boolean } | { ok: false; message: string }>,
  [string | undefined, unknown]
>();
const mockOpenCodeAvailable = jest.fn<Promise<boolean>, []>();
jest.mock('../../lib/default-model-lane-resolver', () => {
  const actual = jest.requireActual<object>(
    '../../lib/default-model-lane-resolver',
  );
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      requireLaneAwareDefaultSelection: {
        value: (...args: unknown[]): unknown => mockLaneDefault(...args),
        enumerable: true,
      },
    },
  );
});
jest.mock('../../lib/preferences-store', () => {
  const actual = jest.requireActual<object>('../../lib/preferences-store');
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      readPreferencesFile: {
        value: (): Promise<object> => Promise.resolve({}),
        enumerable: true,
      },
    },
  );
});
jest.mock('../../lib/workspace-registry', () => {
  const actual = jest.requireActual<object>('../../lib/workspace-registry');
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      isCoworkWorkspace: {
        value: (id: string): boolean => mockIsCowork(id),
        enumerable: true,
      },
    },
  );
});
jest.mock('../../agents/agent-model-store', () => ({
  getAgentModel: (id: string, projectId?: string): unknown =>
    mockGetAgent(id, projectId),
}));
jest.mock('../../agents/work-owner', () => {
  const actual = jest.requireActual<object>('../../agents/work-owner');
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      resolveAiCreditsScopeOwner: {
        value: (...args: unknown[]): unknown => mockOwner(...args),
        enumerable: true,
      },
    },
  );
});
// Owner-authority edges of the real `resolveAiCreditsScopeOwner`, stubbed only
// by the tests that run it; otherwise the real modules answer.
const mockContextService = jest.fn();
const mockWorkspaceTarget = jest.fn();
jest.mock('../../lib/workspace-context-service', () => {
  const actual = jest.requireActual<{
    getWorkspaceContextService: () => unknown;
  }>('../../lib/workspace-context-service');
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      getWorkspaceContextService: {
        value: (): unknown =>
          mockContextService.getMockImplementation()
            ? mockContextService()
            : actual.getWorkspaceContextService(),
        enumerable: true,
      },
    },
  );
});
jest.mock('../../services/background-execution-context', () => {
  const actual = jest.requireActual<{
    resolveBackgroundWorkspaceTarget: (...args: unknown[]) => unknown;
  }>('../../services/background-execution-context');
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      resolveBackgroundWorkspaceTarget: {
        value: (...args: unknown[]): unknown =>
          mockWorkspaceTarget.getMockImplementation()
            ? mockWorkspaceTarget(...args)
            : actual.resolveBackgroundWorkspaceTarget(...args),
        enumerable: true,
      },
    },
  );
});
jest.mock('../../lib/model-policy-state', () => {
  const actual = jest.requireActual<object>('../../lib/model-policy-state');
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      isModelBlockedByStoredPolicy: {
        value: (model: string | undefined, owner: unknown): Promise<boolean> =>
          mockBlocked(model, owner),
        enumerable: true,
      },
    },
  );
});
jest.mock('../../lib/model-gateway-state', () => {
  const actual = jest.requireActual<object>('../../lib/model-gateway-state');
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      checkModelGatewayRoute: {
        value: (
          model: string | undefined,
          owner: unknown,
        ): ReturnType<typeof mockGateway> => mockGateway(model, owner),
        enumerable: true,
      },
    },
  );
});
jest.mock('../../cursor/runtime-availability', () => ({
  isCursorRuntimeAvailable: (): Promise<boolean> => Promise.resolve(true),
}));
jest.mock('../../copilot/runtime-availability', () => ({
  isCopilotRuntimeAvailable: (): Promise<boolean> => Promise.resolve(true),
}));
jest.mock('../../opencode/runtime-availability', () => ({
  isOpenCodeRuntimeAvailable: (): Promise<boolean> => mockOpenCodeAvailable(),
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
it('creates an App Advisor task and founding chat without a first message', async () => {
  const receipt = await dispatchAgentChatCreation(
    { type: 'bots.create_task', botId: 'app_advisor', title: 'Nightly' },
    context,
  );
  expect(mockCreate).toHaveBeenCalledWith(
    APP_ADVISOR_PROJECT_ID,
    expect.objectContaining({ title: 'Nightly' }),
  );
  // Bots get no project seed: App Advisor resolves its defaults on first send.
  expect(mockDispatch.mock.calls[0]?.[0].command).toEqual({
    type: 'chat.create_tab',
    tabId: receipt.address.taskId,
  });
  expect(mockSend).not.toHaveBeenCalled();
  expect(receipt).toEqual({
    address: {
      botId: 'app_advisor',
      taskId: receipt.address.taskId,
      chatId: receipt.address.taskId,
    },
    taskCreated: true,
    chatCreated: true,
  });
});
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

describe('explicit model selection', () => {
  const NO_PLUGINS: ChatTabPluginSelections = {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
  };
  const CODER_PLUGINS: ChatTabPluginSelections = {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [{ marketplaceId: 'market', pluginName: 'coder-plugin' }],
  };
  // Boost-shaped Agents inherit the default model; one pins its own base.
  const AGENTS: AgentModelDefinition[] = [
    {
      id: 'agent_model_boost_coder',
      name: 'Boost Coder',
      baseModel: 'default',
      instructions: 'Coordinate the coding round.',
      pluginSelections: CODER_PLUGINS,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      importedFromRemoteId: 'shared-coder',
    },
    {
      id: 'agent_model_pinned',
      name: 'Pinned',
      baseModel: 'gpt-5.5',
      instructions: 'Pinned instructions.',
      pluginSelections: NO_PLUGINS,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    },
  ];
  const CODER = 'agent_model_boost_coder';
  const startAdmission = jest.fn();
  const chatAction = (
    model: string,
    extra: { initialMessage?: string; taskId?: string } = {},
  ): ChatCreationAction => ({
    type: 'projects.create_task_chat',
    projectId: 'target-project',
    taskId: extra.taskId ?? 'target-task',
    model,
    ...(extra.initialMessage ? { initialMessage: extra.initialMessage } : {}),
  });
  function createdTab(): Record<string, unknown> {
    const command = mockDispatch.mock.calls[0]?.[0]?.command;
    if (command?.type !== 'chat.create_tab')
      throw new Error('Expected a create-tab command');
    return { ...command };
  }
  function expectNothingAllocated(): void {
    expect(mockScaffold).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockDefaults).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    initClaudeModels([
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'opus', label: 'Opus' },
    ]);
    initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
    initAgentModels(
      AGENTS.map(
        (agent): AgentModelRegistryEntry => ({ ...agent, available: true }),
      ),
    );
    mockIsCowork.mockImplementation((id) => id === 'target-project');
    mockLaneDefault.mockResolvedValue({
      providerType: 'claude',
      model: 'sonnet',
    });
    mockGetAgent.mockImplementation((id) =>
      Promise.resolve(AGENTS.find((agent) => agent.id === id) ?? null),
    );
    mockOwner.mockResolvedValue({ kind: 'personal' });
    mockBlocked.mockResolvedValue(false);
    mockGateway.mockResolvedValue({ ok: true, orgRoute: false });
    mockOpenCodeAvailable.mockResolvedValue(true);
    startAdmission.mockResolvedValue({ approvalMode: 'ask' });
    // The default seed is the destination default; the explicit seed derives
    // its provider from the model like the real explicit-model seed does.
    mockDefaults.mockImplementation(
      (_projectId: string, requested?: { model: string }) => {
        if (!requested)
          return Promise.resolve({
            model: 'sonnet',
            defaultStampModel: 'sonnet',
            providerType: 'claude',
            modelConfig: { thinkingLevel: 'medium', speed: 'standard' },
            deferredToolsAllowed: true,
            aiCreditsRouting: { active: true, scope: 'persistent' },
          });
        const providerType = getProviderForModel(requested.model);
        return Promise.resolve({
          model: requested.model,
          ...(providerType ? { providerType } : {}),
          deferredToolsAllowed: true,
        });
      },
    );
  });
  afterEach(() => {
    initAgentModels([]);
  });

  it('keeps the default seed, reuse and admission and runs no model checks when model is omitted', async () => {
    tabs = [tab('reusable')];
    const reused = await dispatchAgentChatCreation(
      {
        type: 'projects.create_task_chat',
        projectId: 'target-project',
        taskId: 'target-task',
      },
      context,
    );
    expect(reused).toEqual({
      address: {
        projectId: 'target-project',
        taskId: 'target-task',
        chatId: 'reusable',
      },
      taskCreated: false,
      chatCreated: false,
    });
    const created = await dispatchAgentChatCreation(action, {
      ...context,
      startAdmission,
    });
    expect(created).not.toHaveProperty('model');
    expect(created).not.toHaveProperty('agentId');
    expect(mockDefaults).toHaveBeenCalledTimes(1);
    expect(mockDefaults.mock.calls[0]).toEqual(['target-project']);
    expect(createdTab()).toMatchObject({
      model: 'sonnet',
      defaultStampModel: 'sonnet',
      approvalMode: 'ask',
    });
    expect(mockLaneDefault).not.toHaveBeenCalled();
    expect(mockGetAgent).not.toHaveBeenCalled();
    expect(mockBlocked).not.toHaveBeenCalled();
    expect(mockGateway).not.toHaveBeenCalled();
  });

  it.each([
    ['cowork', 'chat', 'sonnet', 'claude'],
    ['code', 'worktree', 'gpt-5.5', 'codex'],
  ] as const)(
    'pins an inheriting Agent to the %s target %s-lane default',
    async (type, lane, base, provider) => {
      mockProject.mockResolvedValue({
        projectId: 'target-project',
        type,
        readiness: 'ready',
      });
      mockIsCowork.mockReturnValue(type === 'cowork');
      mockLaneDefault.mockResolvedValue({
        providerType: provider,
        model: base,
      });
      mockDefaults.mockImplementation(
        (_projectId: string, requested?: { model: string }) =>
          Promise.resolve(
            requested
              ? { model: requested.model }
              : {
                  model: base,
                  defaultStampModel: base,
                  providerType: provider,
                  modelConfig: { thinkingLevel: 'medium', speed: 'standard' },
                  deferredToolsAllowed: true,
                },
          ),
      );
      const route = `${CODER}@${base}`;
      const receipt = await dispatchAgentChatCreation(
        chatAction(CODER),
        context,
      );
      expect(mockLaneDefault).toHaveBeenCalledWith(
        expect.anything(),
        lane,
        { workspaceId: 'target-project' },
        undefined,
        false,
      );
      expect(receipt).toEqual({
        address: {
          projectId: 'target-project',
          taskId: 'target-task',
          chatId: expect.any(String),
        },
        taskCreated: false,
        chatCreated: true,
        model: route,
        agentId: CODER,
      });
      // The default's own seed with the route swapped in: model config and
      // provider follow the base, and no default stamp can reconcile it away.
      const seeded = createdTab();
      expect(seeded).toMatchObject({
        model: route,
        providerType: provider,
        modelConfig: { thinkingLevel: 'medium', speed: 'standard' },
      });
      expect(seeded).not.toHaveProperty('defaultStampModel');
      // Install context is reauthorized against the target project.
      expect(mockGetAgent).toHaveBeenCalledWith(CODER, 'target-project');
      expect(mockBlocked).toHaveBeenCalledWith(route, { kind: 'personal' });
      expect(mockGateway).toHaveBeenCalledWith(route, { kind: 'personal' });
      expect(mockOwner).toHaveBeenCalledWith({
        kind: 'work',
        projectId: 'target-project',
        worktreeId: 'target-task',
      });
    },
  );

  describe('an automation’s own chat (CAN-5379)', () => {
    const automationCaller: AgentChatSendContext['caller'] = {
      kind: 'pipeline',
      source: {
        kind: 'automation',
        automationId: 'automation-1',
        automationName: 'Nightly review',
        owner: { kind: 'personal' },
      },
    };
    const stepCaller: AgentChatSendContext['caller'] = {
      kind: 'pipeline',
      source: {
        executionId: 'execution-1',
        pipelineId: 'nightly',
        stepId: 'send',
        pipelineName: 'Nightly',
        owner: { kind: 'personal' },
      },
    };
    const newChat: ChatCreationAction = {
      type: 'projects.create_task_chat',
      projectId: 'target-project',
      taskId: 'target-task',
    };

    it('keeps the inheriting Agent route the automation resolved, as its native send did', async () => {
      const route = `${CODER}@sonnet`;
      const receipt = await dispatchAgentChatCreation(newChat, {
        caller: automationCaller,
        newChatSeed: { model: route },
      });
      expect(receipt).toMatchObject({
        chatCreated: true,
        model: route,
        agentId: CODER,
      });
      expect(createdTab()).toMatchObject({
        model: route,
        providerType: 'claude',
      });
      // The route is still checked against the target like any model.
      expect(mockGetAgent).toHaveBeenCalledWith(CODER, 'target-project');
      expect(mockBlocked).toHaveBeenCalledWith(route, { kind: 'personal' });
    });

    it('still makes a pipeline step name the Agent itself', async () => {
      await expect(
        dispatchAgentChatCreation(newChat, {
          caller: stepCaller,
          newChatSeed: { model: `${CODER}@sonnet` },
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expectNothingAllocated();
    });

    it('starts on automatic billing, never the last interactive billing choice', async () => {
      mockDefaults.mockImplementation(
        (_projectId: string, requested?: { model: string }) =>
          Promise.resolve({
            model: requested?.model ?? 'sonnet',
            providerType: 'claude',
            deferredToolsAllowed: true,
            aiCreditsRouting: { active: true, scope: 'persistent' },
            subscriptionBillingOverride: true,
          }),
      );
      await dispatchAgentChatCreation(newChat, {
        caller: automationCaller,
        newChatSeed: { model: 'sonnet' },
      });
      const automationTab = createdTab();
      expect(automationTab).toMatchObject({ model: 'sonnet' });
      expect(automationTab).not.toHaveProperty('aiCreditsRouting');
      expect(automationTab).not.toHaveProperty('subscriptionBillingOverride');
      // An agent's own creation keeps the remembered choice, as before.
      mockDispatch.mockClear();
      await dispatchAgentChatCreation(chatAction('sonnet'), context);
      expect(createdTab()).toMatchObject({
        aiCreditsRouting: { active: true, scope: 'persistent' },
        subscriptionBillingOverride: true,
      });
    });
  });

  it('keeps the confirmed billing lane of the target default for an inheriting Agent', async () => {
    await dispatchAgentChatCreation(
      { ...action, model: CODER },
      { ...context, startAdmission },
    );
    expect(createdTab()).toMatchObject({
      model: `${CODER}@sonnet`,
      providerType: 'claude',
      aiCreditsRouting: { active: true, scope: 'persistent' },
      deferredToolsAllowed: true,
    });
  });

  it('seeds the route base provider through the explicit seed when the default moved meanwhile', async () => {
    // A bare inheriting Agent has no provider; its route resolves to the base.
    expect(getProviderForModel(CODER)).toBeUndefined();
    mockLaneDefault.mockResolvedValue({
      providerType: 'codex',
      model: 'gpt-5.5',
    });
    await dispatchAgentChatCreation(chatAction(CODER), context);
    expect(mockDefaults).toHaveBeenLastCalledWith('target-project', {
      model: `${CODER}@gpt-5.5`,
    });
    const seeded = createdTab();
    expect(seeded).toMatchObject({
      model: `${CODER}@gpt-5.5`,
      providerType: 'codex',
    });
    expect(seeded).not.toHaveProperty('defaultStampModel');
  });

  it('stores the bare id of an Agent with its own base model', async () => {
    const receipt = await dispatchAgentChatCreation(
      chatAction('agent_model_pinned'),
      context,
    );
    expect(receipt).toMatchObject({
      model: 'agent_model_pinned',
      agentId: 'agent_model_pinned',
    });
    expect(mockLaneDefault).not.toHaveBeenCalled();
    expect(mockDefaults).toHaveBeenCalledWith('target-project', {
      model: 'agent_model_pinned',
    });
    expect(createdTab()).toMatchObject({
      model: 'agent_model_pinned',
      providerType: 'codex',
    });
  });

  it('reports a provider model without an agentId', async () => {
    const receipt = await dispatchAgentChatCreation(
      { ...action, model: 'opus' },
      context,
    );
    expect(receipt.model).toBe('opus');
    expect(receipt).not.toHaveProperty('agentId');
    expect(createdTab()).toMatchObject({
      model: 'opus',
      providerType: 'claude',
    });
  });

  it('trims the model id like chat.create.model', async () => {
    const receipt = await dispatchAgentChatCreation(
      chatAction(' agent_model_pinned '),
      context,
    );
    expect(receipt).toMatchObject({
      model: 'agent_model_pinned',
      agentId: 'agent_model_pinned',
    });
    expect(createdTab()).toMatchObject({ model: 'agent_model_pinned' });
  });

  it('refuses a blank model id before any check', async () => {
    await expect(
      dispatchAgentChatCreation(chatAction('   '), context),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(mockGetAgent).not.toHaveBeenCalled();
    expectNothingAllocated();
  });

  it.each([
    [
      'an unknown id',
      'agent_model_missing',
      (): void => undefined,
      'not_found',
    ],
    [
      'an uninstalled Agent',
      CODER,
      (): void => {
        mockGetAgent.mockResolvedValue(null);
      },
      'not_found',
    ],
    [
      'an Agent whose install context refuses the target',
      CODER,
      (): void => {
        mockGetAgent.mockRejectedValue(
          new Error('Agent unavailable (access-removed)'),
        );
      },
      'not_found',
    ],
    [
      'a policy-blocked Agent',
      CODER,
      (): void => {
        mockBlocked.mockResolvedValue(true);
      },
      'validation_failed',
    ],
    [
      'a gateway-refused Agent',
      CODER,
      (): void => {
        mockGateway.mockResolvedValue({
          ok: false,
          message: 'Acme requires model traffic to use its configured gateway.',
        });
      },
      'validation_failed',
    ],
    [
      'a forged route for a pinned Agent',
      'agent_model_pinned@sonnet',
      (): void => undefined,
      'validation_failed',
    ],
    [
      'a route choosing another base for an inheriting Agent',
      `${CODER}@opus`,
      (): void => undefined,
      'validation_failed',
    ],
    [
      'a route for an inheriting Agent even on the target default',
      `${CODER}@sonnet`,
      (): void => undefined,
      'validation_failed',
    ],
    [
      'an unresolved target work owner',
      CODER,
      (): void => {
        mockOwner.mockResolvedValue(undefined);
      },
      'target_not_ready',
    ],
    [
      'an Agent default',
      CODER,
      (): void => {
        mockLaneDefault.mockResolvedValue({
          providerType: 'claude',
          model: 'agent_model_pinned',
        });
      },
      'validation_failed',
    ],
    [
      'a target without a default',
      CODER,
      (): void => {
        mockLaneDefault.mockRejectedValue(
          new NoDispatchableModelError('billing-lane'),
        );
      },
      'target_not_ready',
    ],
    [
      'a model whose policy cannot be read',
      CODER,
      (): void => {
        mockBlocked.mockRejectedValue(new Error('account store unreadable'));
      },
      'target_not_ready',
    ],
    [
      'a disconnected runtime',
      'opencode:fixture%2Fmodel',
      (): void => {
        mockOpenCodeAvailable.mockResolvedValue(false);
      },
      'target_not_ready',
    ],
  ] as const)(
    'refuses %s before any scaffold, entry, tab or send',
    async (_case, model, arrange, code) => {
      arrange();
      for (const creation of [
        { ...action, model, initialMessage: 'first input' },
        chatAction(model, { initialMessage: 'first input' }),
      ]) {
        await expect(
          dispatchAgentChatCreation(creation, { ...context, startAdmission }),
        ).rejects.toMatchObject({ code });
      }
      expectNothingAllocated();
      expect(startAdmission).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'the navigation context is unavailable',
      (): void => {
        mockContextService.mockImplementation(() => {
          throw new Error('workspace context service not ready');
        });
      },
      0,
    ],
    [
      'owner authority cannot be read',
      (): void => {
        mockContextService.mockImplementation(() => ({
          getState: (): object => ({ context: { kind: 'personal' } }),
        }));
        mockWorkspaceTarget.mockRejectedValue(
          new Error('workspace index unreadable'),
        );
      },
      2,
    ],
  ] as const)(
    'fails closed before the policy and gateway checks when %s',
    async (_case, arrange, authorityReads) => {
      const { resolveAiCreditsScopeOwner } = jest.requireActual<
        typeof WorkOwner
      >('../../agents/work-owner');
      mockOwner.mockImplementation(resolveAiCreditsScopeOwner);
      arrange();
      for (const creation of [
        { ...action, model: CODER, initialMessage: 'first input' },
        chatAction(CODER, { initialMessage: 'first input' }),
      ]) {
        await expect(
          dispatchAgentChatCreation(creation, { ...context, startAdmission }),
        ).rejects.toMatchObject({ code: 'target_not_ready' });
      }
      expect(mockOwner).toHaveBeenCalledTimes(2);
      await expect(mockOwner.mock.results[0]?.value).resolves.toBeUndefined();
      expect(mockWorkspaceTarget).toHaveBeenCalledTimes(authorityReads);
      expect(mockBlocked).not.toHaveBeenCalled();
      expect(mockGateway).not.toHaveBeenCalled();
      expectNothingAllocated();
      expect(startAdmission).not.toHaveBeenCalled();
    },
  );

  it('does not stamp Agent plugins or instructions on the tab; the turn merges them from the stored route', async () => {
    await dispatchAgentChatCreation(chatAction(CODER), context);
    const seeded = createdTab();
    expect(seeded).not.toHaveProperty('pluginSelections');
    expect(seeded).not.toHaveProperty('systemPromptAppend');
    const stored = seeded.model;
    if (typeof stored !== 'string') throw new Error('Expected a stored model');
    const tabPlugins: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'tab-plugin' }],
    };
    const runtime = await resolveAgentModelRuntime({
      model: stored,
      projectId: 'target-project',
      pluginSelections: tabPlugins,
    });
    expect(runtime).toMatchObject({
      runtimeModel: 'sonnet',
      providerType: 'claude',
      agent: { id: CODER },
      systemPromptAppend: expect.stringContaining(
        'Coordinate the coding round.',
      ),
    });
    expect(
      runtime.pluginSelections?.pluginRefs.map((ref) => ref.pluginName),
    ).toEqual(['tab-plugin', 'coder-plugin']);
  });

  it('creates a new chat instead of reusing a mismatched empty tab, leaving it untouched', async () => {
    const existing = tab('empty', { model: 'opus', providerType: 'claude' });
    tabs = [existing];
    const before = structuredClone(existing);
    const receipt = await dispatchAgentChatCreation(chatAction(CODER), context);
    expect(receipt.chatCreated).toBe(true);
    expect(receipt.address.chatId).not.toBe('empty');
    expect(mockReusable).not.toHaveBeenCalled();
    expect(tabs[0]).toEqual(before);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(createdTab()).toMatchObject({ model: `${CODER}@sonnet` });
  });

  it('creates nothing when the start admission refuses a selected Agent', async () => {
    startAdmission.mockRejectedValue(
      new AgentChatSendError('authorization_conflict', 'Broader approvals.'),
    );
    await expect(
      dispatchAgentChatCreation(
        { ...action, model: CODER, initialMessage: 'first input' },
        { ...context, startAdmission },
      ),
    ).rejects.toMatchObject({ code: 'authorization_conflict' });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('keeps the start admission approval mode unchanged by Agent selection', async () => {
    const receipt = await dispatchAgentChatCreation(
      { ...action, model: CODER, initialMessage: 'first input' },
      { ...context, startAdmission },
    );
    expect(startAdmission).toHaveBeenCalledTimes(1);
    expect(startAdmission).toHaveBeenCalledWith(
      { workspaceId: 'target-project', worktreeId: receipt.address.taskId },
      true,
    );
    expect(createdTab()).toMatchObject({ approvalMode: 'ask' });
  });

  it('dispatches the initial message to the created chat whose stored model is the route', async () => {
    const receipt = await dispatchAgentChatCreation(
      { ...action, model: CODER, initialMessage: 'first input' },
      context,
    );
    expect(receipt).toMatchObject({
      taskCreated: true,
      chatCreated: true,
      model: `${CODER}@sonnet`,
      agentId: CODER,
      input: { disposition: 'started', address: receipt.address },
    });
    const commands = mockDispatch.mock.calls.map(([envelope]) => envelope);
    expect(commands.map((envelope) => envelope.command.type)).toEqual([
      'chat.create_tab',
      'chat.send_message',
    ]);
    expect(commands[0]?.command).toMatchObject({
      tabId: receipt.address.chatId,
      model: `${CODER}@sonnet`,
    });
    expect(commands[1]).toMatchObject({
      worktreeId: receipt.address.taskId,
      command: { chatId: receipt.address.chatId, text: 'first input' },
    });
    expect(mockBuild).toHaveBeenCalledTimes(1);
  });

  it.each(['bots.create_task', 'bots.create_task_chat'] as const)(
    '%s still rejects a model field',
    async (type) => {
      const botAction: ChatCreationAction =
        type === 'bots.create_task'
          ? { type, botId: 'app_advisor', initialMessage: 'hello' }
          : {
              type,
              botId: 'app_advisor',
              taskId: 'target-task',
              initialMessage: 'hello',
            };
      const withModel = { ...botAction, model: CODER };
      await expect(
        dispatchAgentChatCreation(withModel, context),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect(mockDispatch).not.toHaveBeenCalled();
    },
  );
});

describe('pipeline caller', () => {
  const pipelineContext: AgentChatSendContext = {
    caller: {
      kind: 'pipeline',
      source: {
        executionId: 'exec-1',
        pipelineId: 'pipeline-1',
        pipelineName: 'Pipeline',
        stepId: 'create',
        owner: { kind: 'personal' },
      },
    },
    plannedTaskId: 'planned-task',
  };
  const mockReserve = jest.fn();

  it('creates a cowork task with the planned id and no sender identity', async () => {
    const receipt = await dispatchAgentChatCreation(
      { type: 'projects.create_task', projectId: 'target-project' },
      pipelineContext,
    );
    expect(mockIdentity).not.toHaveBeenCalled();
    expect(mockProject).toHaveBeenCalledWith('target-project', {
      kind: 'pipeline',
      owner: { kind: 'personal' },
    });
    expect(mockCreate).toHaveBeenCalledWith(
      'target-project',
      expect.objectContaining({ id: 'planned-task' }),
    );
    expect(receipt).toEqual({
      address: {
        projectId: 'target-project',
        taskId: 'planned-task',
        chatId: 'planned-task',
      },
      taskCreated: true,
      chatCreated: true,
    });
  });

  it('checks App Advisor access with the pipeline caller', async () => {
    await dispatchAgentChatCreation(
      { type: 'bots.create_task', botId: 'app_advisor' },
      pipelineContext,
    );
    expect(mockAccess).toHaveBeenCalledWith({
      kind: 'pipeline',
      owner: { kind: 'personal' },
    });
  });

  it('carries the agent origin into the discovery caller', async () => {
    const agentOrigin = { projectId: 'p', worktreeId: 'w', chatId: 'c' };
    await dispatchAgentChatCreation(
      { type: 'bots.create_task', botId: 'app_advisor' },
      {
        ...pipelineContext,
        caller: {
          kind: 'pipeline',
          source: {
            executionId: 'exec-1',
            pipelineId: 'pipeline-1',
            pipelineName: 'Pipeline',
            stepId: 'create',
            owner: { kind: 'personal' },
            agentOrigin,
          },
        },
      },
    );
    expect(mockOriginRevalidate).toHaveBeenCalledWith(
      agentOrigin,
      { kind: 'personal' },
      APP_ADVISOR_PROJECT_ID,
    );
    expect(mockAccess).toHaveBeenCalledWith({
      kind: 'pipeline',
      owner: { kind: 'personal' },
      agentOrigin,
    });
  });

  it('ignores plannedTaskId for project agents', async () => {
    await dispatchAgentChatCreation(action, {
      ...context,
      plannedTaskId: 'planned-task',
    });
    expect(mockCreate).toHaveBeenCalledWith(
      'target-project',
      expect.objectContaining({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    );
  });

  it('does not reserve a watcher or read watcherDestination for a pipeline creation', async () => {
    const receipt = await dispatchAgentChatCreation(
      { type: 'projects.create_task', projectId: 'target-project' },
      {
        ...pipelineContext,
        watchers: {
          reserveInlineChatWatchers: mockReserve,
          confirmInlineChatWatchers: jest.fn(),
          cancelInlineChatWatchers: jest.fn(),
        },
      },
    );
    expect(receipt.taskCreated).toBe(true);
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
