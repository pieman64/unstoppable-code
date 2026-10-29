import { scheduleChatSummary } from '../lib/worktree-chat-turn';
import type { ChatSteeringCapabilities } from '@canopy/protocol/portal';
import type * as os from 'node:os';
import type * as PreferencesStore from '../lib/preferences-store';

const releaseResourceMock = jest.fn();
const reserveChatTurnStartMock = jest.fn(() =>
  Promise.resolve({ release: releaseResourceMock }),
);
const sendMessageMock = jest.fn();
const setPlanModeMock = jest.fn(() => Promise.resolve());
const setApprovalModeMock = jest.fn(() => Promise.resolve());
const setCodexIdleMock = jest.fn(() => Promise.resolve());
const startChatTurnMock = jest.fn<void, [Record<string, unknown>]>();
const ingestProviderEventMock = jest.fn<Promise<boolean>, [unknown]>();
// Delivery reads the outcome; by default it mirrors the boolean commit mock.
const ingestOutcomeFromCommit = async (
  input: unknown,
): Promise<ProviderEventIngestOutcome> =>
  (await ingestProviderEventMock(input)) ? 'applied' : 'not-applied';
const ingestProviderEventWithOutcomeMock = jest.fn(ingestOutcomeFromCommit);
const hasMutationMock = jest.fn<Promise<boolean>, [unknown, string]>();
const sendToWindowDetailedMock = jest.fn(() => ({ delivered: true as const }));
const getSessionExecutionHarnessMock = jest.fn<
  'claude' | 'codex' | undefined,
  []
>(() => undefined);
const readPersistedChatDispatchMetadataMock = jest.fn(() =>
  Promise.resolve({}),
);
const ensureChatForTrustedSendMock = jest.fn(() => Promise.resolve());
const getAgentModelMock = jest.fn();
const requireLaneAwareDefaultSelectionMock = jest.fn<
  Promise<{ model: string; thinkingLevel: string }>,
  [Awaited<ReturnType<typeof PreferencesStore.readPreferencesFile>>]
>((preferences) =>
  Promise.resolve(
    preferences.defaultChatModelByProvider[preferences.defaultChatProvider] ??
      preferences.defaultChatModelByProvider.claude,
  ),
);

const mockCursorAvailable = jest.fn(() => Promise.resolve(true));
const mockReadCursorAccount = jest.fn(() => Promise.resolve({ email: '' }));
jest.mock('../cursor/runtime-availability', () => ({
  isCursorRuntimeAvailable: (): Promise<boolean> => mockCursorAvailable(),
}));
jest.mock('../cursor/connection', () => ({
  readCursorAccount: (): Promise<{ email: string } | null> =>
    mockReadCursorAccount(),
}));

jest.mock('../resource-monitor', () => ({
  getResourceMonitorService: jest.fn(() => ({
    reserveChatTurnStart: reserveChatTurnStartMock,
  })),
}));

jest.mock('../lib/preferences-store', () => {
  const actual = jest.requireActual<typeof PreferencesStore>(
    '../lib/preferences-store',
  );
  return {
    ...actual,
    readPreferencesFile: jest.fn(() =>
      Promise.resolve({
        ...actual.DEFAULT_PREFERENCES,
        defaultChatProvider: 'codex',
        defaultChatModelByProvider: {
          ...actual.DEFAULT_PREFERENCES.defaultChatModelByProvider,
          codex: { model: 'gpt-5.5', thinkingLevel: 'medium' },
        },
      }),
    ),
  };
});
jest.mock('../lib/default-model-lane-resolver', () => ({
  requireLaneAwareDefaultSelection: (
    preferences: Awaited<
      ReturnType<typeof PreferencesStore.readPreferencesFile>
    >,
  ): Promise<unknown> => requireLaneAwareDefaultSelectionMock(preferences),
}));

jest.mock('../lib/paths', () => ({
  getDataDir: jest.fn(() => '/mock/data'),
  getPipelineEditorHomeDir: jest.fn(() =>
    jest.requireActual<typeof os>('node:os').tmpdir(),
  ),
  getWorktreeAttachmentsDir: jest.fn(() => '/mock/attachments'),
}));

jest.mock('../lib/chat-tabs-reader', () => ({
  readPersistedChatDispatchMetadata: readPersistedChatDispatchMetadataMock,
}));

jest.mock('../agents/session-manager', () => ({
  buildSessionKey: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): string => `${projectId}/${worktreeId}/${chatId}`,
  destroySession: jest.fn(() => Promise.resolve()),
  getOrCreateSession: jest.fn(() => ({
    sendMessage: sendMessageMock,
    setPlanMode: setPlanModeMock,
    setApprovalMode: setApprovalModeMock,
    setCodexAppServerIdleTimeoutMinutes: setCodexIdleMock,
  })),
  shouldRecreateSessionOnNextTurn: jest.fn(() => false),
  isSessionAiCreditsRouted: jest.fn(() => false),
  isSessionAccountProxyRouted: jest.fn(() => false),
  getSessionExecutionHarness: getSessionExecutionHarnessMock,
  subscribeGlobalPluginDefaultsRevision: jest.fn(),
}));

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    observeChatEvent: jest.fn(),
    startChatTurn: startChatTurnMock,
    completeChatTurn: jest.fn(),
    pauseChatTurn: jest.fn(),
    recordSessionDiagnostic: jest.fn(),
    recordInjectedPromptForOpenChatTurn: jest.fn(),
    resumeChatTurn: jest.fn(),
    startObservedTask: jest.fn(),
    finalizeObservedTask: jest.fn(),
  })),
}));

jest.mock('../ipc/standalone-chat', () => ({
  generateChatSummaryForProject: jest.fn(() =>
    Promise.resolve({ text: 'Summary', usage: {} }),
  ),
}));

jest.mock('../lib/worktree-chat-turn', () => ({
  scheduleChatSummary: jest.fn(),
}));

jest.mock('../services/chat-state-service', () => ({
  getChatStateService: jest.fn(() => ({
    ingestProviderEvent: ingestProviderEventMock,
    ingestProviderEventWithOutcome: ingestProviderEventWithOutcomeMock,
    hasMutation: hasMutationMock,
    ensureChatForTrustedSend: ensureChatForTrustedSendMock,
  })),
}));

jest.mock('../agents/agent-model-store', () => ({
  getAgentModel: getAgentModelMock,
}));

jest.mock('../pipeline-editor/runtime', () => ({
  createPipelineEditorToolRuntime: jest.fn(() => ({})),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindowDetailed: sendToWindowDetailedMock,
}));

import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';

import {
  IPC_CHANNELS,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import { PIPELINE_EDITOR_REQUIRED_SKILL_REF } from '@canopy/desktop-shared/lib/pipeline-editor-tools';
import { getOrCreateSession } from '../agents/session-manager';
import type { AgentSessionOptions } from '../agents/types';
import type { ProviderEventIngestOutcome } from '../services/chat-state-service';
import { dispatchPipelineEditorChatMessage } from '../pipeline-editor/chat-service';
import { getChatQueueService } from '../services/chat-queue-service';
import {
  clearLiveApprovalMode,
  setLiveApprovalMode,
} from '../approvals/live-approval-modes';

const getOrCreateSessionMock = jest.mocked(getOrCreateSession);

beforeAll(() => {
  // The cross-lane substitution spec resolves a NATIVE Claude model onto a
  // Codex-locked chat, so the Claude lane needs a registered model or the
  // harness guard trips on the substituted model rather than on the bug.
  initClaudeModels([{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }]);
  initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
  initAiGatewayModels(
    [
      {
        id: 'gateway-reassigned',
        label: 'Gateway Reassigned',
        recommendedHarness: 'claude',
        contextWindow: 100_000,
        supportsPromptCaching: false,
        supportedThinkingLevels: [],
        toolSchemaProfile: 'standard',
      },
    ],
    [
      {
        modelId: 'gateway-reassigned',
        gatewayId: 'provider/gateway-reassigned',
        recommendedHarness: 'claude',
        gatewayOnly: true,
        contextWindow: 100_000,
        supportsPromptCaching: false,
        supportedThinkingLevels: [],
        toolSchemaProfile: 'standard',
      },
    ],
  );
});

beforeEach(() => {
  jest.clearAllMocks();
  ingestProviderEventMock.mockReset();
  ingestProviderEventMock.mockResolvedValue(true);
  ingestProviderEventWithOutcomeMock.mockImplementation(
    ingestOutcomeFromCommit,
  );
  hasMutationMock.mockReset();
  hasMutationMock.mockResolvedValue(false);
  ensureChatForTrustedSendMock.mockClear();
  getAgentModelMock.mockReset();
  clearLiveApprovalMode(
    PIPELINE_EDITOR_PROJECT_ID,
    PIPELINE_EDITOR_WORKTREE_ID,
    'pipeline-editor-chat',
  );
});

describe('dispatchPipelineEditorChatMessage', () => {
  it('dispatches Cursor through the Pipeline Assistant route and retains its saved session', async () => {
    await dispatchPipelineEditorChatMessage(
      {
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
        chatId: 'pipeline-cursor-chat',
        userMessageId: 'cursor-prompt',
        text: 'Edit this pipeline',
        model: 'cursor-default',
        providerType: 'cursor',
        sdkSessionId: 'saved-cursor',
      },
      {
        getMainWindow: () => null,
        toolSurfaces: { getMainWindow: () => null },
      },
    );
    expect(getOrCreateSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        executionHarness: 'cursor',
        assistantMode: 'pipeline-editor',
        sdkSessionId: 'saved-cursor',
        deferredToolsAllowed: false,
      }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(sendMessageMock).toHaveBeenCalled();
  });

  it('retries when the durable prompt exists but provider acceptance does not', async () => {
    ingestProviderEventMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await dispatchPipelineEditorChatMessage(
      {
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
        chatId: 'pipeline-editor-chat',
        userMessageId: 'message-duplicate',
        text: 'Retry the pipeline update',
        providerType: 'codex',
        model: 'gpt-5.5',
      },
      {
        getMainWindow: () => null,
        toolSurfaces: { getMainWindow: () => null },
      },
    );

    expect(hasMutationMock).toHaveBeenCalledWith(
      {
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
      },
      'pipeline-editor-chat:message-duplicate:accepted',
    );
    expect(ingestProviderEventMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mutationId: 'pipeline-editor-chat:message-duplicate:accepted',
      }),
    );
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const acceptanceCallIndex = ingestProviderEventMock.mock.calls.findIndex(
      ([event]) => {
        if (
          typeof event !== 'object' ||
          event === null ||
          !('mutationId' in event)
        ) {
          return false;
        }
        return (
          event.mutationId === 'pipeline-editor-chat:message-duplicate:accepted'
        );
      },
    );
    expect(sendMessageMock.mock.invocationCallOrder[0]).toBeLessThan(
      ingestProviderEventMock.mock.invocationCallOrder[acceptanceCallIndex] ??
        0,
    );
  });

  it('does not dispatch when the provider already accepted the prompt', async () => {
    ingestProviderEventMock.mockResolvedValueOnce(false);
    hasMutationMock.mockResolvedValueOnce(true);

    await dispatchPipelineEditorChatMessage(
      {
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
        chatId: 'pipeline-editor-chat',
        userMessageId: 'message-accepted',
        text: 'Do not dispatch twice',
        providerType: 'codex',
        model: 'gpt-5.5',
      },
      {
        getMainWindow: () => null,
        toolSurfaces: { getMainWindow: () => null },
      },
    );

    expect(hasMutationMock).toHaveBeenCalledWith(
      {
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
      },
      'pipeline-editor-chat:message-accepted:accepted',
    );
    expect(getOrCreateSessionMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('passes the validated user message id to the provider session', async () => {
    await dispatchPipelineEditorChatMessage(
      {
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
        chatId: 'pipeline-editor-chat',
        userMessageId: 'message-1',
        text: 'Update the pipeline',
        providerType: 'codex',
        model: 'gpt-5.5',
        approvalMode: 'auto',
        sessionApprovalRules: [
          {
            id: 'rule-1',
            behavior: 'allow',
            target: { kind: 'command', pattern: 'npm test *' },
            createdAt: '2026-07-23T00:00:00.000Z',
            origin: 'prompt',
          },
        ],
      },
      {
        getMainWindow: () => null,
        toolSurfaces: {
          getMainWindow: () => null,
        },
      },
    );

    expect(sendMessageMock).toHaveBeenCalledWith('Update the pipeline', {
      userMessageId: 'message-1',
    });
    expect(startChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantMode: 'pipeline-editor',
        originalUserText: 'Update the pipeline',
        submittedText: 'Update the pipeline',
      }),
    );
    const sessionOptions: AgentSessionOptions | undefined =
      getOrCreateSessionMock.mock.calls[0]?.[0];
    expect(sessionOptions?.pluginSelections?.skillRefs).toEqual(
      expect.arrayContaining([PIPELINE_EDITOR_REQUIRED_SKILL_REF]),
    );
    expect(sessionOptions).toEqual(
      expect.objectContaining({
        approvalMode: 'auto',
        sessionApprovalRules: [expect.objectContaining({ id: 'rule-1' })],
      }),
    );
  });

  it('persists the selected agent model when trusted send creates the chat', async () => {
    getAgentModelMock.mockResolvedValueOnce({
      id: 'agent_model_pipeline_reviewer',
      name: 'Pipeline reviewer',
      baseModel: 'gpt-5.5',
      instructions: 'Review pipeline changes.',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });

    await dispatchPipelineEditorChatMessage(
      {
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
        chatId: 'pipeline-editor-agent-chat',
        userMessageId: 'message-agent',
        text: 'Review this pipeline',
        providerType: 'codex',
        model: 'agent_model_pipeline_reviewer',
      },
      {
        getMainWindow: () => null,
        toolSurfaces: { getMainWindow: () => null },
      },
    );

    expect(ensureChatForTrustedSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'pipeline-editor-agent-chat',
        model: 'agent_model_pipeline_reviewer',
      }),
    );
    expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        model: 'gpt-5.5',
        selectedModel: 'agent_model_pipeline_reviewer',
      }),
    );
  });

  it('clamps a deferred continuation to the current live approval mode', async () => {
    setLiveApprovalMode(
      PIPELINE_EDITOR_PROJECT_ID,
      PIPELINE_EDITOR_WORKTREE_ID,
      'pipeline-editor-chat',
      'ask',
    );

    await dispatchPipelineEditorChatMessage(
      {
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
        chatId: 'pipeline-editor-chat',
        userMessageId: 'message-reload',
        text: 'Continue after reload',
        providerType: 'codex',
        model: 'gpt-5.5',
        approvalMode: 'full-access',
        deferredToolsReloadEnabledResources: [],
      },
      {
        getMainWindow: () => null,
        toolSurfaces: { getMainWindow: () => null },
      },
    );

    expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ approvalMode: 'ask' }),
    );
    expect(setApprovalModeMock).toHaveBeenCalledWith('ask');
    expect(setApprovalModeMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendMessageMock.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('commits provider events before broadcasting them', async () => {
    let finishCommit: (() => void) | undefined;
    ingestProviderEventMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(
        (): Promise<boolean> =>
          new Promise<boolean>((resolve) => {
            finishCommit = (): void => resolve(true);
          }),
      );
    await dispatchPipelineEditorChatMessage(
      {
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
        chatId: 'pipeline-editor-chat',
        userMessageId: 'message-commit-order',
        text: 'Update the pipeline',
        providerType: 'codex',
        model: 'gpt-5.5',
      },
      {
        getMainWindow: () => null,
        toolSurfaces: { getMainWindow: () => null },
      },
    );

    const eventHandler = getOrCreateSessionMock.mock.calls[0]?.[1];
    void eventHandler?.({
      type: 'codex',
      event: {
        type: 'item.completed',
        item: { id: 'answer-1', type: 'agent_message', text: 'Durable' },
      },
    });
    await Promise.resolve();

    expect(ingestProviderEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
        chatId: 'pipeline-editor-chat',
        mutationId: 'pipeline-editor-chat:message-commit-order:provider:0',
      }),
    );
    expect(sendToWindowDetailedMock).not.toHaveBeenCalled();

    finishCommit?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sendToWindowDetailedMock).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatEvent,
      expect.objectContaining({ chatId: 'pipeline-editor-chat' }),
    );
  });

  it('delivers an activity-only provider event but not a rejected one', async () => {
    await dispatchPipelineEditorChatMessage(
      {
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
        chatId: 'pipeline-editor-chat',
        userMessageId: 'message-activity',
        text: 'Update the pipeline',
        providerType: 'codex',
        model: 'gpt-5.5',
      },
      {
        getMainWindow: () => null,
        toolSurfaces: { getMainWindow: () => null },
      },
    );
    const activity = { type: 'codex', event: { type: 'turn.plan.updated' } };
    const rejected = { type: 'codex', event: { type: 'turn.plan.stale' } };
    // Neither event is a durable commit; only the plan update is live.
    ingestProviderEventMock.mockResolvedValue(false);
    ingestProviderEventWithOutcomeMock.mockImplementation((input) =>
      Promise.resolve(
        JSON.stringify(input).includes('turn.plan.updated')
          ? 'activity-only'
          : 'not-applied',
      ),
    );
    sendToWindowDetailedMock.mockClear();

    const eventHandler = getOrCreateSessionMock.mock.calls[0]?.[1];
    void eventHandler?.(activity);
    void eventHandler?.(rejected);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(sendToWindowDetailedMock).toHaveBeenCalledTimes(1);
    expect(sendToWindowDetailedMock).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatEvent,
      expect.objectContaining({
        chatId: 'pipeline-editor-chat',
        data: activity,
      }),
    );
  });

  it('keeps a requested providerType authoritative when the model comes from lane resolution (round-2 finding 8)', async () => {
    // The mocked resolver returns the CHAT default, which this fixture pins to
    // Codex. Discarding `request.providerType` on the model-less branch made a
    // chat that asked for `codex` dispatch as `claude` and trip the harness
    // guard.
    await dispatchPipelineEditorChatMessage(
      {
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
        chatId: 'pipeline-editor-chat',
        userMessageId: 'message-lane',
        text: 'Update the pipeline',
        providerType: 'codex',
      },
      {
        getMainWindow: () => null,
        toolSurfaces: { getMainWindow: () => null },
      },
    );

    const sessionOptions: AgentSessionOptions | undefined =
      getOrCreateSessionMock.mock.calls[0]?.[0];
    expect(sessionOptions?.providerType).toBe('codex');
  });

  it('reconciles a cross-lane NATIVE substitution and drops the stale session id (round-3 finding 3)', async () => {
    // Lane resolution treats a forced `providerType` as a PREFERENCE, so a
    // Codex-locked Pipeline Editor chat whose Codex lane is unavailable comes
    // back holding a native Claude model. Making `request.providerType`
    // authoritative over that (round-2 finding 8) paired a Claude model with
    // the Codex harness and tripped the guard — the same dead end
    // `worktree-chat-turn.ts` already reconciles.
    requireLaneAwareDefaultSelectionMock.mockResolvedValueOnce({
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'high',
    });
    getSessionExecutionHarnessMock.mockReturnValueOnce('codex');

    await expect(
      dispatchPipelineEditorChatMessage(
        {
          projectId: PIPELINE_EDITOR_PROJECT_ID,
          worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
          chatId: 'pipeline-editor-chat',
          userMessageId: 'message-substituted',
          text: 'Update the pipeline',
          providerType: 'codex',
          executionHarness: 'codex',
          sdkSessionId: 'codex-thread-abc',
        },
        {
          getMainWindow: () => null,
          toolSurfaces: { getMainWindow: () => null },
        },
      ),
    ).resolves.not.toThrow();

    const sessionOptions: AgentSessionOptions | undefined =
      getOrCreateSessionMock.mock.calls[0]?.[0];
    expect(sessionOptions?.providerType).toBe('claude');
    expect(sessionOptions?.executionHarness).toBe('claude');
    expect(sessionOptions?.sdkSessionId).toBeUndefined();
  });

  it('rejects echoed request metadata that conflicts with the active session harness', async () => {
    getSessionExecutionHarnessMock.mockReturnValueOnce('codex');

    await expect(
      dispatchPipelineEditorChatMessage(
        {
          projectId: PIPELINE_EDITOR_PROJECT_ID,
          worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
          chatId: 'pipeline-editor-chat',
          userMessageId: 'message-2',
          text: 'Continue the pipeline edit',
          providerType: 'codex',
          model: 'gpt-5.5',
          executionHarness: 'claude',
        },
        {
          getMainWindow: () => null,
          toolSurfaces: { getMainWindow: () => null },
        },
      ),
    ).rejects.toThrow(/execution harness/i);

    expect(getOrCreateSessionMock).not.toHaveBeenCalled();
  });

  it('keeps the persisted harness authoritative after restart and reassignment', async () => {
    readPersistedChatDispatchMetadataMock.mockResolvedValueOnce({
      model: 'gateway-reassigned',
      providerType: 'codex',
      executionHarness: 'codex',
    });

    await dispatchPipelineEditorChatMessage(
      {
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
        chatId: 'pipeline-editor-chat',
        userMessageId: 'message-3',
        text: 'Continue after restart',
        providerType: 'claude',
        model: 'gateway-reassigned',
        executionHarness: 'codex',
        sdkSessionId: 'persisted-session',
      },
      {
        getMainWindow: () => null,
        toolSurfaces: { getMainWindow: () => null },
      },
    );

    expect(scheduleChatSummary).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'pipeline-editor-chat' }),
    );

    expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ executionHarness: 'codex' }),
    );
  });
});

describe('CAN-2835 Pipeline Assistant event ownership', () => {
  it('follows a committed Claude pickup into its new root turn', async () => {
    getOrCreateSessionMock.mockImplementationOnce(() => ({
      sendMessage: sendMessageMock,
      setPlanMode: setPlanModeMock,
      setApprovalMode: setApprovalModeMock,
      getSteeringCapabilities: (): ChatSteeringCapabilities => ({
        provider: 'claude',
        generation: 'live',
        steer: true,
        withdraw: true,
        interrupt: true,
      }),
    }));
    await dispatchPipelineEditorChatMessage(
      {
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
        chatId: 'steered-pipeline',
        userMessageId: 'original',
        text: 'Original',
        providerType: 'claude',
        model: 'claude-sonnet-4-6',
      },
      {
        getMainWindow: () => null,
        toolSurfaces: { getMainWindow: () => null },
      },
    );
    const call = getOrCreateSessionMock.mock.calls[0];
    if (!call) throw new Error('Expected pipeline route');
    void call[1]({
      type: 'canopy_input_delivery',
      provider: 'claude',
      phase: 'picked-up',
      generation: 'live',
      attemptId: 'attempt',
      startsTurn: true,
      userMessageId: 'selected',
    });
    void call[1]({
      type: 'assistant',
      canopy_turn_user_message_id: 'selected',
    });
    await call[3]?.drainEventsBeforeRemoval?.();
    expect(ingestProviderEventMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ turnUserMessageId: 'selected' }),
    );
  });

  it('preserves the current root when queue ownership rejects a late pickup', async () => {
    const onTurnRevived = jest
      .spyOn(getChatQueueService(), 'onTurnRevived')
      .mockReturnValue(false);
    getOrCreateSessionMock.mockImplementationOnce(() => ({
      sendMessage: sendMessageMock,
      setPlanMode: setPlanModeMock,
      setApprovalMode: setApprovalModeMock,
      getSteeringCapabilities: (): ChatSteeringCapabilities => ({
        provider: 'claude',
        generation: 'live',
        steer: true,
        withdraw: true,
        interrupt: true,
      }),
    }));

    try {
      await dispatchPipelineEditorChatMessage(
        {
          projectId: PIPELINE_EDITOR_PROJECT_ID,
          worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
          chatId: 'rejected-steer-pipeline',
          userMessageId: 'current',
          text: 'Current turn',
          providerType: 'claude',
          model: 'claude-sonnet-4-6',
        },
        {
          getMainWindow: () => null,
          toolSurfaces: { getMainWindow: () => null },
        },
      );
      const call = getOrCreateSessionMock.mock.calls[0];
      if (!call) throw new Error('Expected pipeline route');
      // The embedded surface must enforce the ownership result independently
      // of outer-route correlation. An unmatched generation is deliberately
      // passed through by the route and exercises that local invariant.
      void call[1]({
        type: 'canopy_input_delivery',
        provider: 'claude',
        phase: 'picked-up',
        generation: 'older-generation',
        attemptId: 'late-attempt',
        startsTurn: true,
        userMessageId: 'stale',
      });
      void call[1]({ type: 'assistant', message: 'still current' });
      await call[3]?.drainEventsBeforeRemoval?.();

      expect(onTurnRevived).toHaveBeenCalledWith(
        expect.objectContaining({ userMessageId: 'current' }),
        'stale',
      );
      expect(ingestProviderEventMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ turnUserMessageId: 'current' }),
      );
    } finally {
      onTurnRevived.mockRestore();
    }
  });

  it('honors a stamped rejected pickup without re-arbitrating the root', async () => {
    const onTurnRevived = jest
      .spyOn(getChatQueueService(), 'onTurnRevived')
      .mockReturnValue(true);
    getOrCreateSessionMock.mockImplementationOnce(() => ({
      sendMessage: sendMessageMock,
      setPlanMode: setPlanModeMock,
      setApprovalMode: setApprovalModeMock,
      getSteeringCapabilities: (): ChatSteeringCapabilities => ({
        provider: 'claude',
        generation: 'live',
        steer: true,
        withdraw: true,
        interrupt: true,
      }),
    }));

    try {
      await dispatchPipelineEditorChatMessage(
        {
          projectId: PIPELINE_EDITOR_PROJECT_ID,
          worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
          chatId: 'stamped-rejected-steer-pipeline',
          userMessageId: 'current',
          text: 'Current turn',
          providerType: 'claude',
          model: 'claude-sonnet-4-6',
        },
        {
          getMainWindow: () => null,
          toolSurfaces: { getMainWindow: () => null },
        },
      );
      const call = getOrCreateSessionMock.mock.calls[0];
      if (!call) throw new Error('Expected pipeline route');
      void call[1]({
        type: 'canopy_input_delivery',
        provider: 'claude',
        phase: 'picked-up',
        generation: 'older-generation',
        attemptId: 'late-attempt',
        startsTurn: true,
        userMessageId: 'stale',
        turnRootAccepted: false,
      });
      await call[3]?.drainEventsBeforeRemoval?.();

      expect(onTurnRevived).not.toHaveBeenCalled();
      expect(ingestProviderEventMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ turnUserMessageId: 'current' }),
      );
    } finally {
      onTurnRevived.mockRestore();
    }
  });

  it.each(['claude', 'codex'] as const)(
    'routes retained %s callbacks to the latest turn',
    async (providerType) => {
      let retained: ((data: unknown) => void) | undefined;
      const shared = {
        sendMessage: sendMessageMock,
        setPlanMode: setPlanModeMock,
        setApprovalMode: setApprovalModeMock,
      };
      getOrCreateSessionMock.mockImplementation((_opts, onEvent) => {
        retained ??= onEvent;
        return shared;
      });
      ingestProviderEventMock.mockResolvedValue(true);
      for (const userMessageId of ['first', 'second']) {
        await dispatchPipelineEditorChatMessage(
          {
            projectId: PIPELINE_EDITOR_PROJECT_ID,
            worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
            chatId: 'reuse-pipeline',
            userMessageId,
            text: 'testing',
            providerType,
            model: providerType === 'claude' ? 'claude-sonnet-4-6' : 'gpt-5.5',
          },
          {
            getMainWindow: (): null => null,
            toolSurfaces: { getMainWindow: (): null => null },
          },
        );
        retained?.({
          type: 'assistant',
          canopy_turn_user_message_id: userMessageId,
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(ingestProviderEventMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ turnUserMessageId: userMessageId }),
        );
      }
      ingestProviderEventMock.mockClear();
      retained?.({ type: 'result', canopy_turn_user_message_id: 'first' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(ingestProviderEventMock).not.toHaveBeenCalled();
    },
  );
});

it('CAN-2835 gives Pipeline Assistant reload events distinct mutation ids and drains teardown', async () => {
  const register = jest.spyOn(
    deferredToolsReloadCoordinator,
    'registerResumeHandler',
  );
  const options = {
    getMainWindow: (): null => null,
    toolSurfaces: { getMainWindow: (): null => null },
  };
  const request = {
    projectId: PIPELINE_EDITOR_PROJECT_ID,
    worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
    chatId: 'pipeline-reload',
    userMessageId: 'same-turn',
    text: 'testing',
    providerType: 'codex' as const,
    model: 'gpt-5.5',
  };
  getOrCreateSessionMock.mockImplementation(() => ({
    sendMessage: sendMessageMock,
    setPlanMode: setPlanModeMock,
    setApprovalMode: setApprovalModeMock,
  }));
  ingestProviderEventMock.mockResolvedValue(true);
  try {
    await dispatchPipelineEditorChatMessage(request, options);
    void getOrCreateSessionMock.mock.calls[0]?.[1]({
      type: 'assistant',
      canopy_turn_user_message_id: request.userMessageId,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const first =
      ingestProviderEventMock.mock.calls[
        ingestProviderEventMock.mock.calls.length - 1
      ]?.[0];
    const resume = register.mock.calls[register.mock.calls.length - 1]?.[1];
    if (!resume) throw new Error('Missing continuation');
    await resume({
      scope: request,
      requestId: 'reload-id',
      toolCallId: 'load-id',
      userMessageId: request.userMessageId,
      continuationText: 'continue',
      enabledResources: [],
      providerType: 'codex',
      signal: new AbortController().signal,
    });
    const resumed =
      getOrCreateSessionMock.mock.calls[
        getOrCreateSessionMock.mock.calls.length - 1
      ];
    void resumed?.[1]({
      type: 'assistant',
      canopy_turn_user_message_id: request.userMessageId,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second =
      ingestProviderEventMock.mock.calls[
        ingestProviderEventMock.mock.calls.length - 1
      ]?.[0];
    expect(second?.mutationId).toContain('reload-id');
    expect(second).not.toEqual(first);
    expect(resumed?.[3]?.drainEventsBeforeRemoval).toEqual(
      expect.any(Function),
    );
  } finally {
    register.mockRestore();
  }
});

it('CAN-2835 durably starts each Pipeline Assistant turn before obtaining its provider', async () => {
  ingestProviderEventMock.mockResolvedValue(true);
  await dispatchPipelineEditorChatMessage(
    {
      projectId: PIPELINE_EDITOR_PROJECT_ID,
      worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
      chatId: 'prompt-chat',
      userMessageId: 'next-turn',
      text: 'Next task',
      model: 'gpt-5.5',
      providerType: 'codex',
    },
    { getMainWindow: () => null, toolSurfaces: { getMainWindow: () => null } },
  );
  expect(ingestProviderEventMock).toHaveBeenCalledWith(
    expect.objectContaining({
      turnUserMessageId: 'next-turn',
      mutationId: 'prompt-chat:next-turn:user-prompt',
    }),
  );
  expect(ingestProviderEventMock.mock.invocationCallOrder[0]).toBeLessThan(
    getOrCreateSessionMock.mock.invocationCallOrder[0] ?? 0,
  );
});

describe('Pipeline Assistant Codex speed', () => {
  const speedOptions = {
    getMainWindow: (): null => null,
    toolSurfaces: { getMainWindow: (): null => null },
  };
  const ultraFastRequest = {
    projectId: PIPELINE_EDITOR_PROJECT_ID,
    worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
    chatId: 'pipeline-speed-chat',
    userMessageId: 'speed-turn',
    text: 'Edit quickly',
    model: 'gpt-5.5',
    providerType: 'codex' as const,
    modelConfig: { speed: 'ultrafast' as const },
  };

  it('applies the exact Ultra fast speed to the session and never a boolean downgrade', async () => {
    const setSpeedMock = jest.fn(() => Promise.resolve());
    const setFastModeMock = jest.fn(() => Promise.resolve());
    getOrCreateSessionMock.mockImplementationOnce(() => ({
      sendMessage: sendMessageMock,
      setPlanMode: setPlanModeMock,
      setApprovalMode: setApprovalModeMock,
      setModel: jest.fn(),
      setThinkingLevel: jest.fn(),
      cancel: jest.fn(),
      destroy: jest.fn(),
      setSpeed: setSpeedMock,
      setFastMode: setFastModeMock,
    }));

    await dispatchPipelineEditorChatMessage(ultraFastRequest, speedOptions);

    expect(setSpeedMock).toHaveBeenCalledWith('ultrafast');
    expect(setFastModeMock).not.toHaveBeenCalled();
    expect(getOrCreateSessionMock.mock.calls[0]?.[0]?.modelConfig).toEqual(
      expect.objectContaining({ speed: 'ultrafast', fastMode: false }),
    );
    expect(startChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        executionHarness: 'codex',
        serviceTier: 'ultrafast',
      }),
    );
    expect(setSpeedMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendMessageMock.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('rejects Ultra fast visibly before the turn starts when the session cannot receive an exact speed', async () => {
    const setFastModeMock = jest.fn(() => Promise.resolve());
    getOrCreateSessionMock.mockImplementationOnce(() => ({
      sendMessage: sendMessageMock,
      setPlanMode: setPlanModeMock,
      setApprovalMode: setApprovalModeMock,
      setModel: jest.fn(),
      setThinkingLevel: jest.fn(),
      cancel: jest.fn(),
      destroy: jest.fn(),
      setFastMode: setFastModeMock,
    }));

    await expect(
      dispatchPipelineEditorChatMessage(ultraFastRequest, speedOptions),
    ).rejects.toMatchObject({
      name: 'CodexSpeedUnsupportedError',
      speed: 'ultrafast',
    });

    expect(setFastModeMock).not.toHaveBeenCalled();
    expect(startChatTurnMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(ingestProviderEventMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        mutationId: 'pipeline-speed-chat:speed-turn:accepted',
      }),
    );
    expect(releaseResourceMock).toHaveBeenCalled();
  });
});
