/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import type {
  ChatCommandEnvelope,
  ChatCommandExecutionOptions,
  ChatSendTurnOverride,
} from '@canopy/desktop-shared/types';
import type {
  AgentSendAcceptanceFacts,
  ChatSendAction,
} from '@canopy/desktop-shared/lib/chat-send-actions';
import {
  AgentChatSendError,
  dispatchAgentChatSend,
  type AgentChatSendContext,
  type TrustedSendCaller,
} from '../send-orchestration';
import { dispatchAgentChatSteer } from '../steer-orchestration';
import { dispatchAgentChatCreation } from '../creation-orchestration';
import { runPipelineProjectBotAction } from '../../agent-actions/desktop-project-bot-port';
import { createWorkEntry } from '../../lib/cowork-work-entries';
import type * as SenderContext from '../sender-context';
import type {
  PipelineSenderSource,
  PipelineStepSenderSource,
} from '../sender-context';

const mockResolveChat = jest.fn();
const mockProject = jest.fn();
const mockTasks = jest.fn();
const mockBotAccess = jest.fn();
const mockBotEntries = jest.fn();
const mockSnapshot = jest.fn();
const mockBuildPipeline = jest.fn();
const mockBuildAgent = jest.fn();
const mockIdentity = jest.fn();
const mockRevalidate = jest.fn();
const mockOriginCheck = jest.fn();
const mockDispatch = jest.fn();
const mockReceipt = jest.fn();
const mockSend = jest.fn();
const mockReusable = jest.fn();
const mockDefaults = jest.fn();
const mockSelection = jest.fn();
const mockModelSeed = jest.fn();
let mockAdvisorModelConfig: object = { fastMode: false };

jest.mock('../../project-discovery/chat-target', () => ({
  resolveAuthorizedChat: (...args: unknown[]): unknown =>
    mockResolveChat(...args),
}));
jest.mock('../../project-discovery/owner-policy', () => ({
  requireAuthorizedProject: (...args: unknown[]): unknown =>
    mockProject(...args),
}));
jest.mock('../../project-discovery/chats-list', () => ({
  listDiscoverableTaskIds: (...args: unknown[]): unknown => mockTasks(...args),
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
  readTaskRuntimeSnapshot: (...args: unknown[]): unknown =>
    mockSnapshot(...args),
}));
jest.mock('../../lib/cowork-work-entries', () => ({
  createWorkEntry: jest.fn(),
  removeWorkEntryRow: jest.fn(),
}));
jest.mock('../../lib/chat-project-utils', () => ({
  ensureCoworkHomeScaffold: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../../lib/chat-tabs-reader', () => ({
  readChatTabsFile: (): Promise<object> => Promise.resolve({ tabs: [] }),
}));
jest.mock('../creation-model', () => ({
  resolveCreationModelSelection: (...args: unknown[]): unknown =>
    mockSelection(...args),
  resolveCreationModelSeed: (...args: unknown[]): unknown =>
    mockModelSeed(...args),
}));
jest.mock('../../portal/adapters/chat-adapter', () => ({
  resolveRemoteCreateTabSeed: (...args: unknown[]): unknown =>
    mockDefaults(...args),
}));
jest.mock('../sender-context', () => ({
  buildPipelineSenderRequest: (...args: unknown[]): unknown =>
    mockBuildPipeline(...args),
  buildAgentSenderRequest: (...args: unknown[]): unknown =>
    mockBuildAgent(...args),
  pipelineSenderIdentity: (source: PipelineStepSenderSource): object => ({
    kind: 'pipeline',
    executionId: source.executionId,
    pipelineId: source.pipelineId,
    stepId: source.stepId,
  }),
  resolveAgentSenderIdentity: (...args: unknown[]): unknown =>
    mockIdentity(...args),
  revalidateAgentSenderRequest: (...args: unknown[]): unknown =>
    mockRevalidate(...args),
  revalidatePipelineAgentOrigin: (...args: unknown[]): unknown =>
    mockOriginCheck(...args),
  isAgentSenderContextError: (): boolean => false,
  changesAuthority:
    jest.requireActual<typeof SenderContext>('../sender-context')
      .changesAuthority,
}));
jest.mock('../../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): object => ({}),
}));
jest.mock('../../ipc/chat-state', () => ({
  getChatStateCommandPort: (): object => ({
    command: jest.fn(),
    getCommandReceipt: (...args: unknown[]): unknown => mockReceipt(...args),
  }),
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
jest.mock('../../canopy-runtime/core-chat-message-command-adapter', () => ({
  withLegacyChatMessageCommand: async (
    _envelope: unknown,
    run: () => Promise<unknown>,
    _unused: unknown,
    options: ChatCommandExecutionOptions,
  ): Promise<unknown> => {
    await run();
    options.onAgentSendAccepted?.(facts);
    return { outcome: 'applied' };
  },
}));
jest.mock('../../services/chat-service', () => ({
  isReusableEmptyChatTab: (...args: unknown[]): unknown =>
    mockReusable(...args),
  buildExistingTabDispatchOptions: (): Promise<object> =>
    Promise.resolve({
      model: 'advisor-model',
      modelConfig: mockAdvisorModelConfig,
    }),
  getRegisteredAppAdvisorSurfaces: (): undefined => undefined,
  sendWorktreeChatMessage: (...args: unknown[]): unknown => mockSend(...args),
}));

const pipelineSource: PipelineSenderSource = {
  executionId: 'exec-1',
  pipelineId: 'nightly',
  stepId: 'notify',
  pipelineName: 'Nightly',
  owner: { kind: 'personal' },
};
const agentOrigin = {
  projectId: 'agent-project',
  worktreeId: 'agent-task',
  chatId: 'agent-chat',
};
const userRun: Extract<TrustedSendCaller, { kind: 'pipeline' }> = {
  kind: 'pipeline',
  source: pipelineSource,
};
const agentRun: Extract<TrustedSendCaller, { kind: 'pipeline' }> = {
  kind: 'pipeline',
  source: { ...pipelineSource, agentOrigin },
};
const target = {
  projectId: 'target-project',
  taskId: 'target-task',
  chatId: 'target-chat',
};
const send: ChatSendAction = {
  type: 'projects.send_message',
  ...target,
  text: 'Report',
};
let facts: AgentSendAcceptanceFacts;
let tabs: Array<{ id: string; kind: string; readOnly?: boolean }>;

function sentCommand(): Record<string, unknown> {
  const envelope = mockDispatch.mock.calls
    .map(([value]: [ChatCommandEnvelope]) => value)
    .find((value) => value.command.type === 'chat.send_message');
  if (!envelope) throw new Error('No send was dispatched.');
  return { ...envelope.command, commandId: envelope.commandId };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAdvisorModelConfig = { fastMode: false };
  facts = {
    acceptedInputId: 'input',
    disposition: 'started',
    acceptedAt: '2026-10-26T00:00:00.000Z',
  };
  mockReceipt.mockResolvedValue(null);
  mockResolveChat.mockImplementation(
    (address: { projectId: string; taskId: string; chatId: string }) =>
      Promise.resolve({
        address,
        projectType: 'code',
        scope: {
          workspaceId: address.projectId,
          worktreeId: address.taskId,
          chatId: address.chatId,
        },
        tab: { id: address.chatId },
      }),
  );
  mockProject.mockResolvedValue({
    projectId: target.projectId,
    type: 'single-repo',
    readiness: 'ready',
  });
  mockTasks.mockResolvedValue([target.taskId]);
  mockBotAccess.mockResolvedValue(undefined);
  mockBotEntries.mockResolvedValue([{ id: 'advisor-task' }]);
  tabs = [{ id: 'empty-chat', kind: 'chat' }];
  mockSnapshot.mockImplementation(() =>
    Promise.resolve({ tabsFile: { tabs: [...tabs] } }),
  );
  mockReusable.mockReturnValue(true);
  mockDefaults.mockResolvedValue({ model: 'default-model' });
  mockBuildPipeline.mockResolvedValue({
    agentSent: {
      sender: { kind: 'pipeline', executionId: 'exec-1' },
      chatTitle: 'Nightly',
      projectLabel: '',
    },
    agentSenderProvenance: { acceptedInputId: 'input' },
    hiddenContext: { kind: 'agent-sender-context', text: 'pipeline note' },
  });
  mockIdentity.mockResolvedValue({ kind: 'project' });
  mockDispatch.mockImplementation(
    (
      envelope: ChatCommandEnvelope,
      options: { executionOptions?: ChatCommandExecutionOptions },
    ) => {
      if (envelope.command.type === 'chat.create_tab') {
        tabs.push({ id: envelope.command.tabId, kind: 'chat' });
        return Promise.resolve({
          outcome: 'applied',
          entityId: envelope.command.tabId,
        });
      }
      if (envelope.command.type === 'chat.send_message') {
        facts.acceptedInputId = envelope.command.userMessageId;
        options.executionOptions?.onAgentSendAccepted?.(facts);
      }
      return Promise.resolve({ outcome: 'applied' });
    },
  );
});

describe('pipeline sends', () => {
  it('sends as the pipeline under its owner, with composition on the command', async () => {
    const receipt = await dispatchAgentChatSend(
      { ...send, queueForSetup: true },
      {
        caller: userRun,
        composition: {
          fileReferences: [
            { displayPath: 'notes.md', absolutePath: '/work/notes.md' },
          ],
          attachmentPaths: ['/work/report.png'],
        },
      },
    );

    expect(receipt).toMatchObject({ address: target, disposition: 'started' });
    expect(mockResolveChat).toHaveBeenCalledWith(
      {
        projectId: 'target-project',
        taskId: 'target-task',
        chatId: 'target-chat',
      },
      { kind: 'pipeline', owner: { kind: 'personal' } },
    );
    expect(mockBuildPipeline).toHaveBeenCalledWith(
      pipelineSource,
      expect.any(String),
      'target-project',
    );
    expect(mockBuildAgent).not.toHaveBeenCalled();
    expect(sentCommand()).toMatchObject({
      agentSent: expect.objectContaining({ chatTitle: 'Nightly' }),
      hiddenContext: { kind: 'agent-sender-context', text: 'pipeline note' },
      fileReferences: [
        { displayPath: 'notes.md', absolutePath: '/work/notes.md' },
      ],
      attachmentPaths: ['/work/report.png'],
      agentSendSetup: { version: 1 },
    });
  });

  it('may report back to the chat that started the run', async () => {
    mockResolveChat.mockResolvedValue({
      address: {
        projectId: 'agent-project',
        taskId: 'agent-task',
        chatId: 'agent-chat',
      },
      projectType: 'code',
      scope: {
        workspaceId: 'agent-project',
        worktreeId: 'agent-task',
        chatId: 'agent-chat',
      },
      tab: { id: 'agent-chat' },
    });
    await expect(
      dispatchAgentChatSend(
        {
          ...send,
          projectId: 'agent-project',
          taskId: 'agent-task',
          chatId: 'agent-chat',
        },
        { caller: agentRun },
      ),
    ).resolves.toMatchObject({ disposition: 'started' });
  });

  it('refuses watchers before anything is dispatched', async () => {
    await expect(
      dispatchAgentChatSend({ ...send, watchers: [{}] }, { caller: userRun }),
    ).rejects.toMatchObject({ code: 'unsupported_action' });
    expect(mockResolveChat).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("commits a user-originated run's override with the message (D2)", async () => {
    const turnOverride: ChatSendTurnOverride = {
      version: 1,
      model: 'sonnet',
      approvalMode: 'full-access',
      planMode: true,
    };
    await dispatchAgentChatSend(send, { caller: userRun, turnOverride });
    expect(sentCommand()).toMatchObject({ turnOverride });
  });

  it("refuses an agent-originated run's authority settings before dispatch (D11)", async () => {
    const overrides: ChatSendTurnOverride[] = [
      { version: 1, approvalMode: 'full-access' },
      { version: 1, model: 'sonnet' },
      { version: 1, planMode: false },
      {
        version: 1,
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      },
    ];
    for (const turnOverride of overrides) {
      await expect(
        dispatchAgentChatSend(send, { caller: agentRun, turnOverride }),
      ).rejects.toMatchObject({ code: 'authorization_conflict' });
    }
    expect(mockDispatch).not.toHaveBeenCalled();
    // Thinking effort and fast mode change no authority.
    await dispatchAgentChatSend(send, {
      caller: agentRun,
      turnOverride: { version: 1, modelConfig: { fastMode: true } },
    });
    expect(sentCommand()).toMatchObject({
      turnOverride: { version: 1, modelConfig: { fastMode: true } },
    });
  });

  it("runs an agent-originated run's admission", async () => {
    const check = jest.fn();
    const admission = jest.fn().mockResolvedValue({
      check,
      refusal: () => undefined,
    });
    await dispatchAgentChatSend(send, { caller: agentRun, admission });
    expect(admission).toHaveBeenCalledWith({
      workspaceId: 'target-project',
      worktreeId: 'target-task',
      chatId: 'target-chat',
    });
  });

  it('uses fixed IDs and returns the original acceptance on a replay', async () => {
    const fixedIds = {
      commandId: 'fixed-command',
      userMessageId: 'fixed-input',
    };
    await dispatchAgentChatSend(send, { caller: userRun, fixedIds });
    expect(sentCommand()).toMatchObject({
      commandId: 'fixed-command',
      userMessageId: 'fixed-input',
    });

    mockDispatch.mockClear();
    mockReceipt.mockResolvedValue({
      commandId: 'fixed-command',
      revision: 1,
      outcome: 'applied',
      agentSendAcceptance: {
        acceptedInputId: 'fixed-input',
        disposition: 'queued',
        queuedMessageId: 'row-1',
        acceptedAt: '2026-10-26T00:00:00.000Z',
      },
    });
    await expect(
      dispatchAgentChatSend(send, { caller: userRun, fixedIds }),
    ).resolves.toMatchObject({
      disposition: 'queued',
      queuedMessageId: 'row-1',
      messageId: 'fixed-input',
    });
    expect(mockReceipt).toHaveBeenCalledWith({
      projectId: 'target-project',
      worktreeId: 'target-task',
      commandId: 'fixed-command',
    });
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockBuildPipeline).toHaveBeenCalledTimes(1);
  });

  it('refuses a replay receipt that belongs to another input', async () => {
    mockReceipt.mockResolvedValue({
      commandId: 'fixed-command',
      revision: 1,
      outcome: 'applied',
      agentSendAcceptance: {
        acceptedInputId: 'other-input',
        disposition: 'started',
        acceptedAt: '2026-10-26T00:00:00.000Z',
      },
    });
    await expect(
      dispatchAgentChatSend(send, {
        caller: userRun,
        fixedIds: { commandId: 'fixed-command', userMessageId: 'fixed-input' },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('applies bot-safe settings in the bot branch and refuses the rest', async () => {
    tabs = [{ id: 'advisor-chat', kind: 'chat' }];
    const botSend: ChatSendAction = {
      type: 'bots.send_message',
      botId: 'app_advisor',
      taskId: 'advisor-task',
      chatId: 'advisor-chat',
      text: 'Report',
    };
    await dispatchAgentChatSend(botSend, {
      caller: userRun,
      turnOverride: {
        version: 1,
        modelConfig: { thinkingLevel: 'high' },
        approvalMode: 'full-access',
      },
    });
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'advisor-model',
        modelConfig: expect.objectContaining({
          fastMode: false,
          thinkingLevel: 'high',
        }),
        approvalMode: 'full-access',
      }),
      expect.any(Object),
    );
    // A speed patch replaces the chat's speed instead of contradicting it.
    mockAdvisorModelConfig = { speed: 'fast', fastMode: true };
    mockSend.mockClear();
    await dispatchAgentChatSend(botSend, {
      caller: userRun,
      turnOverride: { version: 1, modelConfig: { fastMode: false } },
    });
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        modelConfig: expect.objectContaining({
          speed: 'standard',
          fastMode: false,
        }),
      }),
      expect.any(Object),
    );
    const overrides: ChatSendTurnOverride[] = [
      { version: 1, model: 'sonnet' },
      {
        version: 1,
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      },
    ];
    for (const turnOverride of overrides) {
      await expect(
        dispatchAgentChatSend(botSend, { caller: userRun, turnOverride }),
      ).rejects.toMatchObject({ code: 'unsupported_action' });
    }
  });

  it('refuses a turn override from an agent action caller', async () => {
    await expect(
      dispatchAgentChatSend(send, {
        caller: { kind: 'project_root', source: agentOrigin },
        watcherDestination: agentOrigin,
        turnOverride: { version: 1 },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('an automation’s own send (CAN-4549)', () => {
  const automationRun: Extract<TrustedSendCaller, { kind: 'pipeline' }> = {
    kind: 'pipeline',
    source: {
      kind: 'automation',
      automationId: 'automation-1',
      automationName: 'Morning report',
      owner: { kind: 'personal' },
    },
  };
  const overlay = { packageDigest: 'sha256:abc', resources: [] };
  const botSend: ChatSendAction = {
    type: 'bots.send_message',
    botId: 'app_advisor',
    taskId: 'advisor-task',
    chatId: 'advisor-chat',
    text: 'Report',
  };

  function activations(): ChatCommandEnvelope[] {
    return mockDispatch.mock.calls
      .map(([value]: [ChatCommandEnvelope]) => value)
      .filter((value) => value.command.type === 'chat.activate_tab');
  }

  it('refuses automation facts from any other caller before dispatch', async () => {
    for (const caller of [
      userRun,
      { kind: 'project_root' as const, source: agentOrigin },
    ])
      await expect(
        dispatchAgentChatSend(send, {
          caller,
          watcherDestination: agentOrigin,
          automationDispatch: {
            version: 1,
            automationName: 'Morning report',
            presentation: 'background',
          },
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('carries the block and input mode on the project command, in the background', async () => {
    const automationDispatch = {
      version: 1 as const,
      automationName: 'Morning report',
      presentation: 'background' as const,
      executionContext: 'personal',
      packageOverlay: overlay,
    };
    await dispatchAgentChatSend(send, {
      caller: automationRun,
      composition: { inputMode: 'voice' },
      automationDispatch,
    });
    expect(sentCommand()).toMatchObject({
      inputMode: 'voice',
      automationDispatch,
    });
    // A scheduled run keeps the scope's active tab.
    expect(activations()).toHaveLength(0);
  });

  it('brings the target forward after a foreground send is accepted', async () => {
    await dispatchAgentChatSend(send, {
      caller: automationRun,
      automationDispatch: {
        version: 1,
        automationName: 'Morning report',
        presentation: 'foreground',
      },
    });
    const commands = mockDispatch.mock.calls.map(
      ([value]: [ChatCommandEnvelope]) => value.command.type,
    );
    expect(commands).toEqual(['chat.send_message', 'chat.activate_tab']);
    expect(activations()[0]).toMatchObject({
      projectId: 'target-project',
      worktreeId: 'target-task',
      command: { type: 'chat.activate_tab', tabId: 'target-chat' },
    });
  });

  it('applies the block in the Orchestrator branch (Review Focus 6)', async () => {
    tabs = [{ id: 'advisor-chat', kind: 'chat' }];
    await dispatchAgentChatSend(botSend, {
      caller: automationRun,
      automationDispatch: {
        version: 1,
        automationName: 'Morning report',
        presentation: 'background',
        executionContext: 'personal',
        packageOverlay: overlay,
      },
    });
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        initiationSource: 'automation',
        automationName: 'Morning report',
        packageOverlay: overlay,
        preserveActiveTab: true,
        automationDispatch: expect.objectContaining({ version: 1 }),
      }),
      expect.objectContaining({
        executionContext: 'personal',
        preserveActiveTab: true,
      }),
    );
    mockSend.mockClear();
    await dispatchAgentChatSend(botSend, {
      caller: automationRun,
      automationDispatch: {
        version: 1,
        automationName: 'Morning report',
        presentation: 'foreground',
      },
    });
    expect(mockSend).toHaveBeenCalledWith(
      expect.not.objectContaining({ preserveActiveTab: expect.anything() }),
      expect.objectContaining({ preserveActiveTab: false }),
    );
    // Activation goes through the retained path's own tab selection.
    expect(activations()).toHaveLength(0);
  });

  it('keeps preserveActiveTab for an Orchestrator send without the block', async () => {
    tabs = [{ id: 'advisor-chat', kind: 'chat' }];
    await dispatchAgentChatSend(botSend, { caller: userRun });
    expect(mockSend).toHaveBeenCalledWith(
      expect.not.objectContaining({ initiationSource: expect.anything() }),
      expect.objectContaining({ preserveActiveTab: true }),
    );
    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ executionContext: expect.anything() }),
    );
  });

  it('keeps its model, runtime and plugins on an Orchestrator chat (Review Focus 7)', async () => {
    tabs = [{ id: 'advisor-chat', kind: 'chat' }];
    const pluginSelections = {
      collectionIds: ['c'],
      skillRefs: [],
      pluginRefs: [],
    };
    await dispatchAgentChatSend(botSend, {
      caller: automationRun,
      turnOverride: {
        version: 1,
        model: 'gpt-5.4',
        providerType: 'codex',
        executionHarness: 'codex',
        resetRuntime: true,
        modelConfig: { thinkingLevel: 'low' },
        pluginSelections,
      },
    });
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.4',
        providerType: 'codex',
        executionHarness: 'codex',
        sdkSessionId: undefined,
        // As the native send did: the resolved config replaces the chat's.
        modelConfig: { thinkingLevel: 'low' },
        pluginSelections,
      }),
      expect.any(Object),
    );
  });

  it('still refuses those settings for an agent-originated automation', async () => {
    tabs = [{ id: 'advisor-chat', kind: 'chat' }];
    await expect(
      dispatchAgentChatSend(botSend, {
        caller: {
          kind: 'pipeline',
          source: { ...automationRun.source, agentOrigin },
        },
        turnOverride: { version: 1, model: 'sonnet' },
      }),
    ).rejects.toMatchObject({ code: 'authorization_conflict' });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('pipeline steers', () => {
  it('steers as the captured pipeline sender with a fixed command ID', async () => {
    const receipt = await dispatchAgentChatSteer(
      {
        type: 'projects.steer_queued_message',
        ...target,
        queuedMessageId: 'row-1',
      },
      { caller: userRun, fixedIds: { steerCommandId: 'fixed-steer' } },
    );
    expect(receipt).toMatchObject({ disposition: 'steered' });
    expect(mockIdentity).not.toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: 'fixed-steer',
        command: expect.objectContaining({
          type: 'chat.steer_queued_message',
          agentSteeringActor: {
            kind: 'pipeline',
            executionId: 'exec-1',
            pipelineId: 'nightly',
            stepId: 'notify',
          },
        }),
      }),
      expect.any(Object),
    );
  });

  it("revalidates an agent-originated run's agent before steering (D11)", async () => {
    mockOriginCheck.mockRejectedValueOnce(
      new AgentChatSendError('authorization_conflict', 'Owner changed.'),
    );
    await expect(
      dispatchAgentChatSteer(
        {
          type: 'projects.steer_queued_message',
          ...target,
          queuedMessageId: 'row-1',
        },
        { caller: agentRun },
      ),
    ).rejects.toMatchObject({ code: 'authorization_conflict' });
    expect(mockOriginCheck).toHaveBeenCalledWith(
      agentOrigin,
      pipelineSource.owner,
      target.projectId,
    );
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('does not steer twice on a replay', async () => {
    mockReceipt.mockResolvedValue({
      commandId: 'fixed-steer',
      revision: 1,
      outcome: 'applied',
    });
    await expect(
      dispatchAgentChatSteer(
        {
          type: 'projects.steer_queued_message',
          ...target,
          queuedMessageId: 'row-1',
        },
        { caller: userRun, fixedIds: { steerCommandId: 'fixed-steer' } },
      ),
    ).resolves.toMatchObject({ disposition: 'steered' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('pipeline creations', () => {
  const create = {
    type: 'projects.create_task_chat' as const,
    projectId: target.projectId,
    taskId: target.taskId,
    initialMessage: 'Report',
  };

  it("reuses an empty chat with no seed, as an agent's creation does", async () => {
    const receipt = await dispatchAgentChatCreation(create, {
      caller: userRun,
    });
    expect(receipt).toMatchObject({
      chatCreated: false,
      address: { chatId: 'empty-chat' },
    });
    expect(mockProject).toHaveBeenCalledWith('target-project', {
      kind: 'pipeline',
      owner: { kind: 'personal' },
    });
    // A pipeline's first message to a code task waits for its setup.
    expect(sentCommand()).toMatchObject({ agentSendSetup: { version: 1 } });
  });

  it('creates a seeded chat at the fixed tab with fixed command IDs', async () => {
    const onChatResolved = jest.fn().mockResolvedValue(undefined);
    const receipt = await dispatchAgentChatCreation(create, {
      caller: userRun,
      newChatSeed: { planMode: true, interfaceMode: 'canopy' },
      fixedIds: {
        commandId: 'fixed-send',
        userMessageId: 'fixed-input',
        tabId: 'fixed-tab',
        createTabCommandId: 'fixed-create',
      },
      onChatResolved,
    });
    expect(receipt).toMatchObject({
      chatCreated: true,
      address: { chatId: 'fixed-tab' },
    });
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: 'fixed-create',
        command: {
          type: 'chat.create_tab',
          tabId: 'fixed-tab',
          model: 'default-model',
          planMode: true,
          interfaceMode: 'canopy',
        },
      }),
      expect.any(Object),
    );
    expect(onChatResolved).toHaveBeenCalledWith({
      chatId: 'fixed-tab',
      created: true,
    });
    expect(onChatResolved.mock.invocationCallOrder[0]).toBeLessThan(
      mockBuildPipeline.mock.invocationCallOrder[0],
    );
    expect(sentCommand()).toMatchObject({ commandId: 'fixed-send' });
  });

  it('sends to the tab it already created on a replay instead of creating again', async () => {
    tabs = [{ id: 'fixed-tab', kind: 'chat' }];
    const receipt = await dispatchAgentChatCreation(create, {
      caller: userRun,
      newChatSeed: { planMode: true },
      fixedIds: {
        commandId: 'fixed-send',
        userMessageId: 'fixed-input',
        tabId: 'fixed-tab',
        createTabCommandId: 'fixed-create',
      },
    });
    expect(receipt).toMatchObject({
      chatCreated: true,
      address: { chatId: 'fixed-tab' },
    });
    expect(
      mockDispatch.mock.calls.filter(
        ([envelope]: [ChatCommandEnvelope]) =>
          envelope.command.type === 'chat.create_tab',
      ),
    ).toHaveLength(0);
    expect(sentCommand()).toMatchObject({ chatId: 'fixed-tab' });
  });

  it('refuses a replay into the chat it created once that chat is archived', async () => {
    tabs = [{ id: 'fixed-tab', kind: 'chat', readOnly: true }];
    await expect(
      dispatchAgentChatCreation(create, {
        caller: userRun,
        fixedIds: {
          commandId: 'fixed-send',
          userMessageId: 'fixed-input',
          tabId: 'fixed-tab',
          createTabCommandId: 'fixed-create',
        },
      }),
    ).rejects.toMatchObject({ code: 'target_not_ready' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('stamps no project defaults and refuses project-only settings on bots', async () => {
    tabs = [];
    await dispatchAgentChatCreation(
      {
        type: 'bots.create_task_chat',
        botId: 'app_advisor',
        taskId: 'advisor-task',
        initialMessage: 'Report',
      },
      { caller: userRun, newChatSeed: { planMode: true } },
    );
    expect(mockDefaults).not.toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          type: 'chat.create_tab',
          planMode: true,
        }),
      }),
      expect.any(Object),
    );
    await expect(
      dispatchAgentChatCreation(
        {
          type: 'bots.create_task_chat',
          botId: 'app_advisor',
          taskId: 'advisor-task',
          initialMessage: 'Report',
        },
        { caller: userRun, newChatSeed: { model: 'sonnet' } },
      ),
    ).rejects.toMatchObject({ code: 'unsupported_action' });
  });

  it("starts an agent-originated run's chat within its agent's approvals (D11)", async () => {
    const startAdmission = jest.fn().mockResolvedValue({ approvalMode: 'ask' });
    await expect(
      dispatchAgentChatCreation(create, {
        caller: agentRun,
        startAdmission,
        newChatSeed: { approvalMode: 'full-access' },
      }),
    ).rejects.toMatchObject({ code: 'authorization_conflict' });
    await expect(
      dispatchAgentChatCreation(create, {
        caller: agentRun,
        newChatSeed: {
          pluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'authorization_conflict' });
    expect(mockOriginCheck).toHaveBeenCalledWith(
      agentOrigin,
      pipelineSource.owner,
      target.projectId,
    );
  });

  it("revalidates an agent-originated run's agent before creating anything (D11)", async () => {
    tabs = [];
    mockOriginCheck.mockRejectedValueOnce(
      new AgentChatSendError('authorization_conflict', 'Owner changed.'),
    );
    await expect(
      dispatchAgentChatCreation(
        {
          type: 'projects.create_task_chat',
          projectId: target.projectId,
          taskId: target.taskId,
        },
        { caller: agentRun },
      ),
    ).rejects.toMatchObject({ code: 'authorization_conflict' });
    expect(mockProject).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('refuses a seed that disagrees with the selected model', async () => {
    tabs = [];
    await expect(
      dispatchAgentChatCreation(
        { ...create, model: 'opus' },
        { caller: userRun, newChatSeed: { model: 'sonnet' } },
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    mockDefaults.mockResolvedValue({
      model: 'default-model',
      providerType: 'claude',
    });
    await expect(
      dispatchAgentChatCreation(create, {
        caller: userRun,
        newChatSeed: { providerType: 'codex' },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(
      mockDispatch.mock.calls.some(
        ([envelope]: [ChatCommandEnvelope]) =>
          envelope.command.type === 'chat.create_tab',
      ),
    ).toBe(false);
  });

  it('refuses approvals for an agent-originated run with no start admission (D11)', async () => {
    tabs = [];
    // An Orchestrator-originated run has no project start admission.
    await expect(
      dispatchAgentChatCreation(create, {
        caller: agentRun,
        newChatSeed: { approvalMode: 'full-access' },
      }),
    ).rejects.toMatchObject({ code: 'authorization_conflict' });
    await expect(
      dispatchAgentChatCreation(
        {
          type: 'bots.create_task_chat',
          botId: 'app_advisor',
          taskId: 'advisor-task',
          initialMessage: 'Report',
        },
        { caller: agentRun, newChatSeed: { approvalMode: 'full-access' } },
      ),
    ).rejects.toMatchObject({ code: 'authorization_conflict' });
    expect(mockDispatch).not.toHaveBeenCalled();
    await dispatchAgentChatCreation(
      {
        type: 'bots.create_task_chat',
        botId: 'app_advisor',
        taskId: 'advisor-task',
        initialMessage: 'Report',
      },
      { caller: agentRun, newChatSeed: { planMode: true } },
    );
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          type: 'chat.create_tab',
          planMode: true,
        }),
      }),
      expect.any(Object),
    );
  });

  it('merges the seed onto the project defaults without clearing them', async () => {
    mockDefaults.mockResolvedValue({
      model: 'default-model',
      modelConfig: { thinkingLevel: 'low', speed: 'fast' },
    });
    await dispatchAgentChatCreation(create, {
      caller: userRun,
      newChatSeed: { model: undefined, planMode: undefined },
    });
    // A seed whose fields are all undefined sets nothing.
    expect(
      mockDispatch.mock.calls.some(
        ([envelope]: [ChatCommandEnvelope]) =>
          envelope.command.type === 'chat.create_tab',
      ),
    ).toBe(false);
    tabs = [];
    await dispatchAgentChatCreation(create, {
      caller: userRun,
      newChatSeed: {
        model: undefined,
        modelConfig: { thinkingLevel: 'high' },
      },
    });
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          type: 'chat.create_tab',
          model: 'default-model',
          modelConfig: expect.objectContaining({
            thinkingLevel: 'high',
            speed: 'fast',
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it("checks a seed's model like an explicit model before creating anything", async () => {
    tabs = [];
    mockSelection.mockRejectedValueOnce(
      new AgentChatSendError('validation_failed', 'Blocked by policy.'),
    );
    await expect(
      dispatchAgentChatCreation(create, {
        caller: userRun,
        newChatSeed: { model: 'blocked-model' },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(mockDispatch).not.toHaveBeenCalled();

    mockSelection.mockResolvedValueOnce({ model: 'pinned-model' });
    mockModelSeed.mockResolvedValueOnce({
      model: 'pinned-model',
      providerType: 'claude',
    });
    await dispatchAgentChatCreation(create, {
      caller: userRun,
      newChatSeed: { model: 'sonnet', planMode: true },
    });
    expect(mockSelection).toHaveBeenLastCalledWith(
      'sonnet',
      { projectId: target.projectId, taskId: target.taskId },
      // A pipeline step names an Agent itself, never a route.
      { acceptAgentRoute: false },
    );
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          type: 'chat.create_tab',
          model: 'pinned-model',
          planMode: true,
        }),
      }),
      expect.any(Object),
    );
  });

  it('refuses a turn override on a creation', async () => {
    await expect(
      dispatchAgentChatCreation(create, {
        caller: userRun,
        turnOverride: { version: 1 },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('an automation’s created chats (CAN-5379)', () => {
  const automationRun: Extract<TrustedSendCaller, { kind: 'pipeline' }> = {
    kind: 'pipeline',
    source: {
      kind: 'automation',
      automationId: 'automation-1',
      automationName: 'Build prompt',
      owner: { kind: 'personal' },
    },
  };
  const create = {
    type: 'projects.create_task_chat' as const,
    projectId: target.projectId,
    taskId: target.taskId,
    initialMessage: 'Implement',
  };
  const fixedIds = {
    commandId: 'fixed-send',
    userMessageId: 'fixed-input',
    tabId: 'fixed-tab',
    createTabCommandId: 'fixed-create',
  };
  let closeOutcome: 'applied' | 'rejected';

  function commandsOfType(type: string): ChatCommandEnvelope[] {
    return mockDispatch.mock.calls
      .map(([value]: [ChatCommandEnvelope]) => value)
      .filter((value) => value.command.type === type);
  }

  beforeEach(() => {
    closeOutcome = 'applied';
    const created: ((...args: unknown[]) => unknown) | undefined =
      mockDispatch.getMockImplementation();
    mockDispatch.mockImplementation(
      (envelope: ChatCommandEnvelope, options: object) => {
        const command = envelope.command;
        if (command.type !== 'chat.close_tab')
          return created?.(envelope, options);
        if (closeOutcome !== 'applied')
          return Promise.resolve({
            outcome: closeOutcome,
            reason: 'Only a deliberately blank starter can be discarded',
          });
        tabs = tabs.filter((tab) => tab.id !== command.tabId);
        // The replacement is created only in place of the scope's last tab.
        if (command.replacementTab && tabs.length === 0)
          tabs.push({ id: command.replacementTab.tabId, kind: 'chat' });
        return Promise.resolve({ outcome: 'applied', entityId: command.tabId });
      },
    );
  });

  it('replaces a fresh worktree’s blank starter with its seeded chat, leaving one chat (Review Focus 1)', async () => {
    tabs = [{ id: 'starter', kind: 'chat' }];
    const receipt = await dispatchAgentChatCreation(create, {
      caller: automationRun,
      newChatSeed: { planMode: true, approvalMode: 'full-access' },
      reuseStarterChat: true,
      fixedIds,
    });
    expect(receipt).toMatchObject({
      chatCreated: true,
      address: { chatId: 'fixed-tab' },
    });
    expect(commandsOfType('chat.close_tab')).toEqual([
      expect.objectContaining({
        command: {
          type: 'chat.close_tab',
          tabId: 'starter',
          mode: 'discard_empty',
          replacementTab: {
            type: 'chat.create_tab',
            tabId: 'fixed-tab',
            model: 'default-model',
            planMode: true,
            approvalMode: 'full-access',
          },
        },
      }),
    ]);
    expect(commandsOfType('chat.create_tab')).toHaveLength(0);
    expect(tabs).toEqual([{ id: 'fixed-tab', kind: 'chat' }]);
    expect(sentCommand()).toMatchObject({ chatId: 'fixed-tab' });
  });

  // The starter may hold a person's remembered billing choice, which an
  // automation's native send never took, so even an unseeded send replaces it.
  it('replaces the blank starter for an automation run with no settings', async () => {
    tabs = [{ id: 'starter', kind: 'chat' }];
    const receipt = await dispatchAgentChatCreation(create, {
      caller: automationRun,
      reuseStarterChat: true,
      fixedIds,
    });
    expect(receipt).toMatchObject({
      chatCreated: true,
      address: { chatId: 'fixed-tab' },
    });
    expect(commandsOfType('chat.close_tab')).toEqual([
      expect.objectContaining({
        command: expect.objectContaining({
          tabId: 'starter',
          mode: 'discard_empty',
          replacementTab: expect.objectContaining({ tabId: 'fixed-tab' }),
        }),
      }),
    ]);
    expect(tabs).toEqual([{ id: 'fixed-tab', kind: 'chat' }]);
    expect(sentCommand()).toMatchObject({ chatId: 'fixed-tab' });
  });

  it.each([
    { label: 'no chat yet', before: [], reusable: true },
    {
      label: 'two chats',
      before: [
        { id: 'starter', kind: 'chat' },
        { id: 'draft', kind: 'chat' },
      ],
      reusable: true,
    },
    {
      label: 'a chat with messages',
      before: [{ id: 'starter', kind: 'chat' }],
      reusable: false,
    },
  ])('creates a new chat beside $label', async ({ before, reusable }) => {
    tabs = [...before];
    mockReusable.mockReturnValue(reusable);
    const receipt = await dispatchAgentChatCreation(create, {
      caller: automationRun,
      newChatSeed: { planMode: true },
      reuseStarterChat: true,
      fixedIds,
    });
    expect(receipt).toMatchObject({ address: { chatId: 'fixed-tab' } });
    expect(commandsOfType('chat.close_tab')).toHaveLength(0);
    expect(commandsOfType('chat.create_tab')).toHaveLength(1);
    expect(tabs.map((tab) => tab.id)).toEqual([
      ...before.map((tab) => tab.id),
      'fixed-tab',
    ]);
  });

  // CAN-4551: `new_chat` keeps an existing task's empty tab, which may be a
  // person's draft, as the native send did.
  it('creates a new chat beside an empty tab for new_chat, with no seed', async () => {
    tabs = [{ id: 'draft', kind: 'chat' }];
    mockReusable.mockReturnValue(true);
    const receipt = await dispatchAgentChatCreation(create, {
      caller: automationRun,
      newChat: true,
      fixedIds,
    });
    expect(receipt).toMatchObject({
      chatCreated: true,
      address: { chatId: 'fixed-tab' },
    });
    expect(commandsOfType('chat.create_tab')).toHaveLength(1);
    expect(sentCommand()).toMatchObject({ chatId: 'fixed-tab' });
  });

  it('creates a new chat when the starter stopped being blank before the replacement', async () => {
    tabs = [{ id: 'starter', kind: 'chat' }];
    closeOutcome = 'rejected';
    const receipt = await dispatchAgentChatCreation(create, {
      caller: automationRun,
      newChatSeed: { planMode: true },
      reuseStarterChat: true,
      fixedIds,
    });
    expect(receipt).toMatchObject({
      chatCreated: true,
      address: { chatId: 'fixed-tab' },
    });
    expect(commandsOfType('chat.close_tab')).toHaveLength(1);
    expect(commandsOfType('chat.create_tab')).toEqual([
      expect.objectContaining({
        commandId: 'fixed-create',
        command: expect.objectContaining({ tabId: 'fixed-tab' }),
      }),
    ]);
    expect(tabs.map((tab) => tab.id)).toEqual(['starter', 'fixed-tab']);
  });

  it('never replaces a starter for a step a person or agent started', async () => {
    tabs = [{ id: 'starter', kind: 'chat' }];
    await dispatchAgentChatCreation(create, {
      caller: userRun,
      newChatSeed: { planMode: true },
      reuseStarterChat: true,
      fixedIds,
    });
    expect(commandsOfType('chat.close_tab')).toHaveLength(0);
    expect(commandsOfType('chat.create_tab')).toHaveLength(1);
  });

  // CAN-4551: a converted automation's send step after its entry step.
  it('replaces the starter for a step in a run an automation started', async () => {
    tabs = [{ id: 'starter', kind: 'chat' }];
    await dispatchAgentChatCreation(create, {
      caller: {
        kind: 'pipeline',
        source: {
          ...pipelineSource,
          automation: {
            automationId: 'automation-1',
            automationName: 'Weekly',
          },
        },
      },
      newChatSeed: { planMode: true },
      reuseStarterChat: true,
      fixedIds,
    });
    expect(commandsOfType('chat.close_tab')).toHaveLength(1);
    expect(tabs.map((tab) => tab.id)).toEqual(['fixed-tab']);
  });
});

describe('the pipeline entry’s task creation (CAN-5379)', () => {
  const automationRun: Extract<TrustedSendCaller, { kind: 'pipeline' }> = {
    kind: 'pipeline',
    source: {
      kind: 'automation',
      automationId: 'automation-1',
      automationName: 'Notes prompt',
      owner: { kind: 'personal' },
    },
  };
  const createTask = {
    type: 'projects.create_task' as const,
    projectId: 'cowork-1',
    initialMessage: 'Organize notes',
  };

  beforeEach(() => {
    tabs = [];
    mockProject.mockResolvedValue({
      projectId: 'cowork-1',
      type: 'cowork',
      readiness: 'ready',
    });
    jest.mocked(createWorkEntry).mockImplementation((_projectId, entry) =>
      Promise.resolve({
        entry: {
          id: entry?.id ?? 'unplanned',
          title: '',
          createdAt: entry?.createdAt ?? '2026-10-29T00:00:00.000Z',
          chatCount: 0,
        },
        reusedExistingEmpty: false,
      }),
    );
  });

  it('creates the Work Entry at its planned task and sends its first message there', async () => {
    const receipt = await runPipelineProjectBotAction(
      createTask,
      automationRun,
      {
        plannedTaskId: 'planned-task',
        newChatSeed: { planMode: true },
        fixedIds: {
          commandId: 'fixed-send',
          userMessageId: 'fixed-input',
          createTabCommandId: 'fixed-create',
        },
      },
    );
    expect(receipt).toMatchObject({
      address: {
        projectId: 'cowork-1',
        taskId: 'planned-task',
        chatId: 'planned-task',
      },
      taskCreated: true,
      chatCreated: true,
      input: { disposition: 'started', messageId: 'fixed-input' },
    });
    expect(createWorkEntry).toHaveBeenCalledWith(
      'cowork-1',
      expect.objectContaining({ id: 'planned-task' }),
    );
    expect(sentCommand()).toMatchObject({
      chatId: 'planned-task',
      userMessageId: 'fixed-input',
      text: 'Organize notes',
    });
  });

  it('refuses a task creation with no planned task ID before anything is created', async () => {
    await expect(
      runPipelineProjectBotAction(createTask, automationRun, {}),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(createWorkEntry).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('creates an Orchestrator Work Entry at its planned task and sends there (CAN-5380)', async () => {
    // The created entry, as the bot registry lists it once it is written.
    mockBotEntries.mockResolvedValue([{ id: 'planned-task' }]);
    const receipt = await runPipelineProjectBotAction(
      {
        type: 'bots.create_task',
        botId: 'app_advisor',
        title: 'Weekly review',
        initialMessage: 'Review',
      },
      automationRun,
      {
        plannedTaskId: 'planned-task',
        newChatSeed: { planMode: true },
        fixedIds: {
          commandId: 'fixed-send',
          userMessageId: 'fixed-input',
          createTabCommandId: 'fixed-create',
        },
      },
    );
    expect(receipt).toMatchObject({
      address: {
        botId: 'app_advisor',
        taskId: 'planned-task',
        chatId: 'planned-task',
      },
      taskCreated: true,
      chatCreated: true,
    });
    expect(createWorkEntry).toHaveBeenCalledWith(
      'app-advisor',
      expect.objectContaining({ id: 'planned-task', title: 'Weekly review' }),
    );
    // The first message takes the retained Orchestrator send.
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'app-advisor',
        worktreeId: 'planned-task',
        chatId: 'planned-task',
        text: 'Review',
      }),
      expect.anything(),
    );
  });

  // Task 13 (5c plan, "Bot replay"): a retry within the run, with the entry
  // and chat it already created, reads the first send's receipt.
  it('does not send an Orchestrator creation’s message twice on a replay (CAN-5380)', async () => {
    mockBotEntries.mockResolvedValue([{ id: 'planned-task' }]);
    const create = {
      type: 'bots.create_task',
      botId: 'app_advisor',
      title: 'Weekly review',
      initialMessage: 'Review',
    } as const;
    const options = {
      plannedTaskId: 'planned-task',
      newChatSeed: { planMode: true },
      fixedIds: {
        commandId: 'fixed-send',
        userMessageId: 'fixed-input',
        createTabCommandId: 'fixed-create',
      },
    };
    await runPipelineProjectBotAction(create, automationRun, options);
    expect(mockSend).toHaveBeenCalledTimes(1);

    mockSend.mockClear();
    tabs = [{ id: 'planned-task', kind: 'chat' }];
    mockReceipt.mockResolvedValue({
      commandId: 'fixed-send',
      revision: 1,
      outcome: 'applied',
      agentSendAcceptance: {
        acceptedInputId: 'fixed-input',
        disposition: 'started',
        acceptedAt: '2026-10-26T00:00:00.000Z',
      },
    });
    await expect(
      runPipelineProjectBotAction(create, automationRun, options),
    ).resolves.toMatchObject({
      address: { taskId: 'planned-task', chatId: 'planned-task' },
      input: { messageId: 'fixed-input' },
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses an Orchestrator task creation with no planned task ID', async () => {
    await expect(
      runPipelineProjectBotAction(
        {
          type: 'bots.create_task',
          botId: 'app_advisor',
          initialMessage: 'Review',
        },
        automationRun,
        {},
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(createWorkEntry).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('an automation’s Orchestrator chat settings (CAN-5380)', () => {
  const automationRun: Extract<TrustedSendCaller, { kind: 'pipeline' }> = {
    kind: 'pipeline',
    source: {
      kind: 'automation',
      automationId: 'automation-1',
      automationName: 'Weekly review',
      owner: { kind: 'personal' },
    },
  };
  const botChat = {
    type: 'bots.create_task_chat' as const,
    botId: 'app_advisor',
    taskId: 'advisor-task',
    initialMessage: 'Review',
  };
  const settings = {
    model: 'gpt-5.5',
    providerType: 'codex' as const,
    modelConfig: { thinkingLevel: 'high' as const },
    planMode: true,
    approvalMode: 'full-access' as const,
    pluginSelections: {
      collectionIds: ['c'],
      skillRefs: [],
      pluginRefs: [],
    },
  };

  beforeEach(() => {
    tabs = [];
  });

  it('starts the chat on the settings the automation resolved', async () => {
    await dispatchAgentChatCreation(botChat, {
      caller: automationRun,
      newChatSeed: settings,
    });
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'app-advisor',
        worktreeId: 'advisor-task',
        command: expect.objectContaining({
          type: 'chat.create_tab',
          ...settings,
        }),
      }),
      expect.any(Object),
    );
  });

  it('keeps refusing those settings for a pipeline step or an agent-originated automation', async () => {
    for (const caller of [
      userRun,
      {
        ...automationRun,
        source: { ...automationRun.source, agentOrigin },
      },
    ])
      await expect(
        dispatchAgentChatCreation(botChat, {
          caller,
          newChatSeed: { model: 'gpt-5.5' },
        }),
      ).rejects.toMatchObject({ code: 'unsupported_action' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  // CAN-4551 item 8: a converted automation's send step. The refusals come
  // first: the extension never widens what an agent can do (D11).
  const automationStep: Extract<TrustedSendCaller, { kind: 'pipeline' }> = {
    kind: 'pipeline',
    source: {
      ...pipelineSource,
      automation: { automationId: 'automation-1', automationName: 'Weekly' },
    },
  };

  it('keeps refusing those settings for an agent’s or a person’s step', async () => {
    for (const caller of [
      userRun,
      agentRun,
      {
        ...automationStep,
        source: { ...automationStep.source, agentOrigin },
      },
    ])
      await expect(
        dispatchAgentChatCreation(botChat, {
          caller,
          newChatSeed: { model: 'gpt-5.5' },
        }),
      ).rejects.toMatchObject({ code: 'unsupported_action' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('starts the chat on the settings of a step in a run an automation started', async () => {
    await dispatchAgentChatCreation(botChat, {
      caller: automationStep,
      newChatSeed: settings,
    });
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          type: 'chat.create_tab',
          ...settings,
        }),
      }),
      expect.any(Object),
    );
  });

  it('never sets an Orchestrator chat’s interface mode', async () => {
    await expect(
      dispatchAgentChatCreation(botChat, {
        caller: automationRun,
        newChatSeed: { interfaceMode: 'claude-code' },
      }),
    ).rejects.toMatchObject({ code: 'unsupported_action' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('the pipeline context type', () => {
  it('needs no watcher destination', () => {
    const context: AgentChatSendContext = { caller: userRun };
    expect(context.watcherDestination).toBeUndefined();
  });
});
