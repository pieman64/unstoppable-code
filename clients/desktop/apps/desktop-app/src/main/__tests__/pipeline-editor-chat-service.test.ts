import { withChatSendAdmission } from '../services/chat-send-admission';
import type { AgentSession } from '../agents/types';
import type {
  ApprovalMode,
  ApprovalRule,
  ChatTabsFile,
} from '@canopy/desktop-shared/types';
import { scheduleChatSummary } from '../lib/worktree-chat-turn';
import type { ChatSteeringCapabilities } from '@canopy/protocol/portal';
import type * as os from 'node:os';
import type * as PreferencesStore from '../lib/preferences-store';
import type { ChatQueueRevivalLease } from '../services/chat-queue-service';
import type {
  ChatPickupVerdict,
  ProviderEventIngestOutcome,
  ProviderEventIngestResult,
} from '../services/chat-state-service';

const releaseResourceMock = jest.fn();
const reserveChatTurnStartMock = jest.fn(() =>
  Promise.resolve({ release: releaseResourceMock }),
);
const sendMessageMock = jest.fn();
const setPlanModeMock = jest.fn(() => Promise.resolve());
const setApprovalModeMock = jest.fn(() => Promise.resolve());
const setCodexIdleMock = jest.fn(() => Promise.resolve());
function getClaudeLiveSteeringCapabilities(): ChatSteeringCapabilities {
  return {
    provider: 'claude',
    generation: 'live',
    steer: true,
    withdraw: true,
    interrupt: true,
  };
}

function createAgentSessionDouble(
  overrides: Partial<
    Pick<
      AgentSession,
      'getSteeringCapabilities' | 'setCodexAppServerIdleTimeoutMinutes'
    >
  > = {},
): AgentSession {
  return {
    sendMessage: sendMessageMock,
    cancel: (): Promise<void> => Promise.resolve(),
    destroy: (): Promise<void> => Promise.resolve(),
    setPlanMode: setPlanModeMock,
    setApprovalMode: setApprovalModeMock,
    setThinkingLevel: (): Promise<void> => Promise.resolve(),
    setModel: (): Promise<void> => Promise.resolve(),
    ...overrides,
  };
}

const startChatTurnMock = jest.fn<void, [Record<string, unknown>]>();
const ingestProviderEventMock = jest.fn<Promise<boolean>, [unknown]>();
// Delivery reads the outcome; by default it mirrors the boolean commit mock.
const ingestOutcomeFromCommit = async (
  input: unknown,
): Promise<ProviderEventIngestOutcome> => {
  return (await ingestProviderEventMock(input)) ? 'applied' : 'not-applied';
};
const ingestProviderEventWithOutcomeMock = jest.fn(ingestOutcomeFromCommit);
function readProviderEventData(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || !('data' in input)) {
    return undefined;
  }
  return input.data;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasProviderEventIngest(
  type: string,
  turnUserMessageId: string,
  expectedData: Record<string, unknown> = {},
): boolean {
  return ingestProviderEventWithResultMock.mock.calls.some(([input]) => {
    if (!isObjectRecord(input)) return false;
    const data = input.data;
    if (!isObjectRecord(data)) return false;
    return (
      data.type === type &&
      input.turnUserMessageId === turnUserMessageId &&
      Object.entries(expectedData).every(([key, value]) => data[key] === value)
    );
  });
}

function hasSentProviderEvent(
  type: string,
  expectedData: Record<string, unknown> = {},
): boolean {
  return sendToWindowDetailedMock.mock.calls.some(([, channel, payload]) => {
    if (!isObjectRecord(payload)) return false;
    const data = payload.data;
    if (!isObjectRecord(data)) return false;
    return (
      channel === IPC_CHANNELS.chatEvent &&
      data.type === type &&
      Object.entries(expectedData).every(([key, value]) => data[key] === value)
    );
  });
}

function isStartingPickup(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    data.type === 'canopy_input_delivery' &&
    'phase' in data &&
    data.phase === 'picked-up' &&
    'startsTurn' in data &&
    data.startsTurn === true
  );
}

const ingestResultFromCommit = async (
  input: unknown,
): Promise<ProviderEventIngestResult> => {
  const outcome = (await ingestProviderEventMock(input))
    ? 'applied'
    : 'not-applied';
  const pickup: ChatPickupVerdict | undefined = isStartingPickup(
    readProviderEventData(input),
  )
    ? outcome === 'applied'
      ? 'accepted'
      : 'rejected'
    : undefined;
  return { outcome, ...(pickup ? { pickup } : {}) };
};
const ingestProviderEventWithResultMock = jest.fn<
  Promise<ProviderEventIngestResult>,
  [unknown]
>(ingestResultFromCommit);
const hasMutationMock = jest.fn<Promise<boolean>, [unknown, string]>();
const sendToWindowDetailedMock = jest.fn<
  { delivered: true },
  [unknown, unknown, unknown]
>(() => ({ delivered: true }));
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
    get reserveChatTurnStart(): typeof reserveChatTurnStartMock {
      return reserveChatTurnStartMock;
    },
  })),
}));

jest.mock('../lib/preferences-store', () => {
  const actual = jest.requireActual<typeof PreferencesStore>(
    '../lib/preferences-store',
  );
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      readPreferencesFile: {
        value: jest.fn(() =>
          Promise.resolve({
            ...actual.DEFAULT_PREFERENCES,
            defaultChatProvider: 'codex',
            defaultChatModelByProvider: {
              ...actual.DEFAULT_PREFERENCES.defaultChatModelByProvider,
              codex: { model: 'gpt-5.5', thinkingLevel: 'medium' },
            },
          }),
        ),
        enumerable: true,
      },
    },
  );
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

const mockReadAuthorityTabs = jest.fn<Promise<ChatTabsFile>, []>();
jest.mock('../lib/approval-mode-resolution', () => ({
  resolvePersistedApprovalMode: (
    _project: string,
    _worktree: string,
    mode?: ApprovalMode,
  ): Promise<ApprovalMode> => Promise.resolve(mode ?? 'auto'),
}));
jest.mock('../lib/chat-tabs-reader', () => ({
  get readPersistedChatDispatchMetadata(): typeof readPersistedChatDispatchMetadataMock {
    return readPersistedChatDispatchMetadataMock;
  },
  readChatTabsFile: (): Promise<ChatTabsFile> => mockReadAuthorityTabs(),
}));

jest.mock('../agents/session-manager', () => ({
  buildSessionKey: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): string => `${projectId}/${worktreeId}/${chatId}`,
  destroySession: jest.fn(() => Promise.resolve()),
  restrictSessionApprovalRules: jest.fn(),
  getOrCreateSession: jest.fn(() => ({
    sendMessage: sendMessageMock,
    setPlanMode: setPlanModeMock,
    setApprovalMode: setApprovalModeMock,
    setCodexAppServerIdleTimeoutMinutes: setCodexIdleMock,
  })),
  shouldRecreateSessionOnNextTurn: jest.fn(() => false),
  isSessionAiCreditsRouted: jest.fn(() => false),
  isSessionAccountProxyRouted: jest.fn(() => false),
  get getSessionExecutionHarness(): typeof getSessionExecutionHarnessMock {
    return getSessionExecutionHarnessMock;
  },
  subscribeGlobalPluginDefaultsRevision: jest.fn(),
  subscribeChatSessionActivity: jest.fn((): (() => void) => () => undefined),
  subscribeLiveBackgroundTasks: jest.fn((): (() => void) => () => undefined),
  hasPendingCodexContinuation: jest.fn(() => false),
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
    get ingestProviderEvent(): typeof ingestProviderEventMock {
      return ingestProviderEventMock;
    },
    get ingestProviderEventWithOutcome(): typeof ingestProviderEventWithOutcomeMock {
      return ingestProviderEventWithOutcomeMock;
    },
    get ingestProviderEventWithResult(): typeof ingestProviderEventWithResultMock {
      return ingestProviderEventWithResultMock;
    },
    get hasMutation(): typeof hasMutationMock {
      return hasMutationMock;
    },
    get ensureChatForTrustedSend(): typeof ensureChatForTrustedSendMock {
      return ensureChatForTrustedSendMock;
    },
  })),
}));

jest.mock('../agents/agent-model-store', () => ({
  get getAgentModel(): typeof getAgentModelMock {
    return getAgentModelMock;
  },
}));

jest.mock('../pipeline-editor/runtime', () => ({
  createPipelineEditorToolRuntime: jest.fn(() => ({})),
}));

jest.mock('../lib/window-send', () => ({
  get sendToWindowDetailed(): typeof sendToWindowDetailedMock {
    return sendToWindowDetailedMock;
  },
}));

import {
  IPC_CHANNELS,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import { PIPELINE_EDITOR_REQUIRED_SKILL_REF } from '@canopy/desktop-shared/lib/pipeline-editor-tools';
import {
  getOrCreateSession,
  restrictSessionApprovalRules,
} from '../agents/session-manager';
import type { AgentSessionOptions } from '../agents/types';
import { dispatchPipelineEditorChatMessage } from '../pipeline-editor/chat-service';
import { getChatQueueService } from '../services/chat-queue-service';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import {
  clearLiveApprovalMode,
  getLiveApprovalMode,
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
        family: 'claude',
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
  for (const [options] of jest.mocked(getOrCreateSession).mock.calls) {
    clearLiveApprovalMode(
      options.projectId,
      options.worktreeId,
      options.chatId,
    );
  }
  const authorityTabs: ChatTabsFile = {
    version: 1,
    activeTabId: '',
    tabs: [],
  };
  // Keep this null active-tab legacy input unchanged at the mock boundary.
  Reflect.set(authorityTabs, 'activeTabId', null);
  mockReadAuthorityTabs.mockReset().mockResolvedValue(authorityTabs);
  jest.clearAllMocks();
  ingestProviderEventMock.mockReset();
  ingestProviderEventMock.mockResolvedValue(true);
  ingestProviderEventWithOutcomeMock.mockImplementation(
    ingestOutcomeFromCommit,
  );
  ingestProviderEventWithResultMock.mockReset();
  ingestProviderEventWithResultMock.mockImplementation(ingestResultFromCommit);
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

  it('asks to connect Cursor for Workflow Assistant when Cursor is unavailable', async () => {
    mockCursorAvailable.mockResolvedValueOnce(false);

    await expect(
      dispatchPipelineEditorChatMessage(
        {
          projectId: PIPELINE_EDITOR_PROJECT_ID,
          worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
          chatId: 'pipeline-cursor-chat',
          userMessageId: 'cursor-unavailable',
          text: 'Edit this pipeline',
          model: 'cursor-default',
          providerType: 'cursor',
        },
        {
          getMainWindow: () => null,
          toolSurfaces: { getMainWindow: () => null },
        },
      ),
    ).rejects.toThrow('Connect Cursor in Settings to use Workflow Assistant.');
    expect(sendMessageMock).not.toHaveBeenCalled();
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
    mockReadAuthorityTabs.mockResolvedValue({
      version: 1,
      activeTabId: 'pipeline-editor-chat',
      tabs: [
        {
          id: 'pipeline-editor-chat',
          title: 'Chat',
          createdAt: '2026-07-23T00:00:00.000Z',
          messages: [],
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
      ],
    });

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

  it('routes a large Codex MCP result to shared ingest without truncation', async () => {
    const body = `start-${'x'.repeat(65_536)}-end`;
    const event = {
      type: 'codex',
      event: {
        type: 'item.completed',
        item: {
          id: 'mcp-call-large',
          type: 'mcp_tool_call',
          status: 'completed',
          result: { content: [{ type: 'text', text: body }] },
        },
      },
    };
    await dispatchPipelineEditorChatMessage(
      {
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
        chatId: 'pipeline-large-mcp-chat',
        userMessageId: 'large-mcp-message',
        text: 'Inspect the result',
        providerType: 'codex',
        model: 'gpt-5.5',
      },
      {
        getMainWindow: () => null,
        toolSurfaces: { getMainWindow: () => null },
      },
    );

    const eventHandler = getOrCreateSessionMock.mock.calls.at(-1)?.[1];
    await eventHandler?.(event);

    expect(ingestProviderEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: event,
      }),
    );
    expect(body).toHaveLength(65_546);
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
    ingestProviderEventWithResultMock.mockImplementation((input) =>
      Promise.resolve({
        outcome: JSON.stringify(input).includes('turn.plan.updated')
          ? 'activity-only'
          : 'not-applied',
      }),
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
    const queue = getChatQueueService();
    const lease: ChatQueueRevivalLease = { rootId: 'selected', epoch: 9 };
    const acceptTurnRevival = jest
      .spyOn(queue, 'acceptTurnRevival')
      .mockReturnValue({ accepted: true, lease });
    const confirmTurnRevival = jest
      .spyOn(queue, 'confirmTurnRevival')
      .mockReturnValue(true);
    const legacyConfirmTurnRevived = jest.spyOn(queue, 'confirmTurnRevived');
    const onTurnTerminal = jest.spyOn(queue, 'onTurnTerminal');
    ingestProviderEventWithResultMock.mockImplementation((input) =>
      Promise.resolve(
        isStartingPickup(readProviderEventData(input))
          ? { outcome: 'applied', pickup: 'accepted' }
          : { outcome: 'applied' },
      ),
    );
    getOrCreateSessionMock.mockImplementationOnce(() =>
      Promise.resolve(
        createAgentSessionDouble({
          getSteeringCapabilities: getClaudeLiveSteeringCapabilities,
        }),
      ),
    );
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
    try {
      await call[1]({
        type: 'canopy_input_delivery',
        provider: 'claude',
        phase: 'picked-up',
        generation: 'live',
        attemptId: 'attempt',
        startsTurn: true,
        userMessageId: 'selected',
      });
      await call[1]({
        type: 'assistant',
        canopy_turn_user_message_id: 'selected',
      });
      await call[1]({
        type: 'result',
        result: 'Done',
        canopy_turn_user_message_id: 'selected',
      });
      await call[3]?.drainEventsBeforeRemoval?.();

      expect(acceptTurnRevival).toHaveBeenCalledWith(
        expect.objectContaining({ userMessageId: 'original' }),
        'selected',
      );
      expect(confirmTurnRevival).toHaveBeenCalledWith(
        expect.objectContaining({ userMessageId: 'original' }),
        lease,
      );
      expect(legacyConfirmTurnRevived).not.toHaveBeenCalled();
      expect(hasProviderEventIngest('assistant', 'selected')).toBe(true);
      expect(hasProviderEventIngest('result', 'selected')).toBe(true);
      expect(onTurnTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ userMessageId: 'original' }),
        'complete',
        'selected',
      );
    } finally {
      acceptTurnRevival.mockRestore();
      confirmTurnRevival.mockRestore();
      legacyConfirmTurnRevived.mockRestore();
      onTurnTerminal.mockRestore();
    }
  });

  it('keeps a previously confirmed same-root pickup after a later rejected duplicate', async () => {
    const queue = getChatQueueService();
    const firstLease: ChatQueueRevivalLease = {
      rootId: 'adopted-root',
      epoch: 31,
    };
    const duplicateLease: ChatQueueRevivalLease = {
      rootId: 'adopted-root',
      epoch: 32,
    };
    const acceptTurnRevival = jest
      .spyOn(queue, 'acceptTurnRevival')
      .mockReturnValueOnce({ accepted: true, lease: firstLease })
      .mockReturnValueOnce({ accepted: true, lease: duplicateLease });
    const confirmTurnRevival = jest
      .spyOn(queue, 'confirmTurnRevival')
      .mockReturnValue(true);
    const rollbackTurnRevival = jest.spyOn(queue, 'rollbackTurnRevival');
    const onTurnTerminal = jest.spyOn(queue, 'onTurnTerminal');
    let pickupCount = 0;
    ingestProviderEventWithResultMock.mockImplementation((input) => {
      if (!isStartingPickup(readProviderEventData(input))) {
        return Promise.resolve({ outcome: 'applied' });
      }
      pickupCount += 1;
      return Promise.resolve(
        pickupCount === 1
          ? { outcome: 'applied', pickup: 'accepted' }
          : { outcome: 'not-applied', pickup: 'rejected' },
      );
    });
    getOrCreateSessionMock.mockImplementationOnce(() =>
      Promise.resolve(
        createAgentSessionDouble({
          getSteeringCapabilities: getClaudeLiveSteeringCapabilities,
        }),
      ),
    );

    try {
      await dispatchPipelineEditorChatMessage(
        {
          projectId: PIPELINE_EDITOR_PROJECT_ID,
          worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
          chatId: 'confirmed-duplicate-pipeline',
          userMessageId: 'initial-root',
          text: 'Initial turn',
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
      await call[1]({
        type: 'canopy_input_delivery',
        provider: 'claude',
        phase: 'picked-up',
        generation: 'live',
        attemptId: 'first-attempt',
        startsTurn: true,
        userMessageId: 'adopted-root',
      });
      await call[1]({
        type: 'canopy_input_delivery',
        provider: 'claude',
        phase: 'picked-up',
        generation: 'live',
        attemptId: 'repeat-attempt',
        startsTurn: true,
        userMessageId: 'adopted-root',
      });
      await call[1]({
        type: 'assistant',
        canopy_turn_user_message_id: 'adopted-root',
      });
      await call[1]({
        type: 'result',
        result: 'Adopted turn complete',
        canopy_turn_user_message_id: 'adopted-root',
      });
      await call[3]?.drainEventsBeforeRemoval?.();

      expect(acceptTurnRevival).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ userMessageId: 'initial-root' }),
        'adopted-root',
      );
      expect(acceptTurnRevival).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ userMessageId: 'initial-root' }),
        'adopted-root',
      );
      expect(confirmTurnRevival).toHaveBeenCalledTimes(1);
      expect(confirmTurnRevival).toHaveBeenCalledWith(
        expect.objectContaining({ userMessageId: 'initial-root' }),
        firstLease,
      );
      expect(rollbackTurnRevival).not.toHaveBeenCalled();
      expect(
        hasProviderEventIngest('assistant', 'adopted-root', {
          canopy_turn_user_message_id: 'adopted-root',
        }),
      ).toBe(true);
      expect(
        hasProviderEventIngest('result', 'adopted-root', {
          canopy_turn_user_message_id: 'adopted-root',
        }),
      ).toBe(true);
      expect(onTurnTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ userMessageId: 'initial-root' }),
        'complete',
        'adopted-root',
      );
    } finally {
      acceptTurnRevival.mockRestore();
      confirmTurnRevival.mockRestore();
      rollbackTurnRevival.mockRestore();
      onTurnTerminal.mockRestore();
    }
  });

  it('does not roll back a rejected unknown-attempt pickup for the initial root', async () => {
    const queue = getChatQueueService();
    const lease: ChatQueueRevivalLease = {
      rootId: 'initial-root',
      epoch: 33,
    };
    const acceptTurnRevival = jest
      .spyOn(queue, 'acceptTurnRevival')
      .mockReturnValue({ accepted: true, lease });
    const confirmTurnRevival = jest.spyOn(queue, 'confirmTurnRevival');
    const rollbackTurnRevival = jest.spyOn(queue, 'rollbackTurnRevival');
    const onTurnTerminal = jest.spyOn(queue, 'onTurnTerminal');
    ingestProviderEventWithResultMock.mockImplementation((input) =>
      Promise.resolve(
        isStartingPickup(readProviderEventData(input))
          ? { outcome: 'not-applied', pickup: 'rejected' }
          : { outcome: 'applied' },
      ),
    );
    getOrCreateSessionMock.mockImplementationOnce(() =>
      Promise.resolve(
        createAgentSessionDouble({
          getSteeringCapabilities: getClaudeLiveSteeringCapabilities,
        }),
      ),
    );

    try {
      await dispatchPipelineEditorChatMessage(
        {
          projectId: PIPELINE_EDITOR_PROJECT_ID,
          worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
          chatId: 'initial-root-rejected-pickup-pipeline',
          userMessageId: 'initial-root',
          text: 'Initial turn',
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
      await call[1]({
        type: 'canopy_input_delivery',
        provider: 'claude',
        phase: 'picked-up',
        generation: 'live',
        attemptId: 'unknown-attempt',
        startsTurn: true,
        userMessageId: 'initial-root',
      });
      await call[1]({
        type: 'assistant',
        canopy_turn_user_message_id: 'initial-root',
        message: 'The initial turn continues',
      });
      await call[1]({
        type: 'result',
        result: 'Initial turn complete',
        canopy_turn_user_message_id: 'initial-root',
      });
      await call[3]?.drainEventsBeforeRemoval?.();

      expect(acceptTurnRevival).toHaveBeenCalledWith(
        expect.objectContaining({ userMessageId: 'initial-root' }),
        'initial-root',
      );
      expect(confirmTurnRevival).not.toHaveBeenCalled();
      expect(rollbackTurnRevival).not.toHaveBeenCalled();
      expect(
        hasProviderEventIngest('canopy_input_delivery', 'initial-root', {
          turnRootAccepted: true,
        }),
      ).toBe(true);
      expect(
        hasProviderEventIngest('assistant', 'initial-root', {
          canopy_turn_user_message_id: 'initial-root',
        }),
      ).toBe(true);
      expect(
        hasProviderEventIngest('result', 'initial-root', {
          canopy_turn_user_message_id: 'initial-root',
        }),
      ).toBe(true);
      expect(onTurnTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ userMessageId: 'initial-root' }),
        'complete',
        'initial-root',
      );
      expect(
        hasSentProviderEvent('result', {
          canopy_turn_user_message_id: 'initial-root',
        }),
      ).toBe(true);
    } finally {
      acceptTurnRevival.mockRestore();
      confirmTurnRevival.mockRestore();
      rollbackTurnRevival.mockRestore();
      onTurnTerminal.mockRestore();
    }
  });

  it('switches to an already-accepted duplicate when its queue lease is confirmed', async () => {
    const queue = getChatQueueService();
    const lease: ChatQueueRevivalLease = {
      rootId: 'selected-duplicate',
      epoch: 11,
    };
    const acceptTurnRevival = jest
      .spyOn(queue, 'acceptTurnRevival')
      .mockReturnValue({ accepted: true, lease });
    const confirmTurnRevival = jest
      .spyOn(queue, 'confirmTurnRevival')
      .mockReturnValue(true);
    const rollbackTurnRevival = jest.spyOn(queue, 'rollbackTurnRevival');
    ingestProviderEventWithResultMock.mockImplementation((input) =>
      Promise.resolve(
        isStartingPickup(readProviderEventData(input))
          ? { outcome: 'not-applied', pickup: 'already-accepted' }
          : { outcome: 'applied' },
      ),
    );
    getOrCreateSessionMock.mockImplementationOnce(() =>
      Promise.resolve(
        createAgentSessionDouble({
          getSteeringCapabilities: getClaudeLiveSteeringCapabilities,
        }),
      ),
    );

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
      await call[1]({
        type: 'canopy_input_delivery',
        provider: 'claude',
        phase: 'picked-up',
        generation: 'live',
        attemptId: 'duplicate-attempt',
        startsTurn: true,
        userMessageId: 'selected-duplicate',
      });
      await call[1]({
        type: 'assistant',
        canopy_turn_user_message_id: 'selected-duplicate',
      });
      await call[3]?.drainEventsBeforeRemoval?.();

      expect(confirmTurnRevival).toHaveBeenCalledWith(
        expect.objectContaining({ userMessageId: 'current' }),
        lease,
      );
      expect(rollbackTurnRevival).not.toHaveBeenCalled();
      expect(hasProviderEventIngest('assistant', 'selected-duplicate')).toBe(
        true,
      );
    } finally {
      acceptTurnRevival.mockRestore();
      confirmTurnRevival.mockRestore();
      rollbackTurnRevival.mockRestore();
    }
  });

  it('rolls back a canonically rejected pickup before output can revive the old root', async () => {
    const queue = getChatQueueService();
    const lease: ChatQueueRevivalLease = { rootId: 'rejected-root', epoch: 14 };
    const acceptTurnRevival = jest
      .spyOn(queue, 'acceptTurnRevival')
      .mockReturnValue({ accepted: true, lease });
    const confirmTurnRevival = jest.spyOn(queue, 'confirmTurnRevival');
    const rollbackTurnRevival = jest
      .spyOn(queue, 'rollbackTurnRevival')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const onTurnTerminal = jest.spyOn(queue, 'onTurnTerminal');
    const reconcileSessionActivity = jest.spyOn(
      queue,
      'reconcileSessionActivity',
    );
    ingestProviderEventWithResultMock.mockImplementation((input) =>
      Promise.resolve(
        isStartingPickup(readProviderEventData(input))
          ? { outcome: 'not-applied', pickup: 'rejected' }
          : { outcome: 'applied' },
      ),
    );
    getOrCreateSessionMock.mockImplementationOnce(() =>
      Promise.resolve(
        createAgentSessionDouble({
          getSteeringCapabilities: getClaudeLiveSteeringCapabilities,
        }),
      ),
    );

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
      await call[1]({
        type: 'canopy_input_delivery',
        provider: 'claude',
        phase: 'picked-up',
        generation: 'live',
        attemptId: 'rejected-attempt',
        startsTurn: true,
        userMessageId: 'rejected-root',
      });
      await call[1]({
        type: 'assistant',
        canopy_turn_user_message_id: 'rejected-root',
        canopy_turn_revival: true,
        message: 'Must not enter canonical state',
      });
      await call[1]({
        type: 'system',
        subtype: 'status',
        status: 'idle',
        canopy_turn_revival: true,
      });
      await call[1]({
        type: 'result',
        result: 'Done',
        canopy_turn_user_message_id: 'rejected-root',
        canopy_turn_revival: true,
      });
      await call[1]({
        type: 'assistant',
        canopy_turn_user_message_id: 'rejected-root',
        canopy_turn_revival: true,
        message: 'Late rejected output stays discarded after terminal',
      });
      await call[3]?.drainEventsBeforeRemoval?.();

      expect(rollbackTurnRevival).toHaveBeenCalledTimes(2);
      expect(rollbackTurnRevival).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ userMessageId: 'current' }),
        lease,
      );
      expect(rollbackTurnRevival).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ userMessageId: 'current' }),
        lease,
      );
      expect(confirmTurnRevival).not.toHaveBeenCalled();
      expect(
        hasProviderEventIngest('canopy_input_delivery', 'current', {
          phase: 'picked-up',
        }),
      ).toBe(true);
      expect(reconcileSessionActivity).toHaveBeenCalled();
      expect(
        hasProviderEventIngest('system', 'current', { status: 'idle' }),
      ).toBe(false);
      expect(
        hasProviderEventIngest('result', 'current', {
          canopy_turn_user_message_id: 'rejected-root',
        }),
      ).toBe(false);
      expect(
        hasProviderEventIngest('assistant', 'current', {
          canopy_turn_revival: true,
        }),
      ).toBe(false);
      expect(onTurnTerminal).not.toHaveBeenCalled();
      expect(
        hasSentProviderEvent('assistant', {
          canopy_turn_user_message_id: 'rejected-root',
        }),
      ).toBe(false);
      expect(hasSentProviderEvent('system', { status: 'idle' })).toBe(false);
      expect(
        hasSentProviderEvent('result', {
          canopy_turn_user_message_id: 'rejected-root',
        }),
      ).toBe(false);
    } finally {
      acceptTurnRevival.mockRestore();
      confirmTurnRevival.mockRestore();
      rollbackTurnRevival.mockRestore();
      onTurnTerminal.mockRestore();
      reconcileSessionActivity.mockRestore();
    }
  });

  it('ingests an owned delegation snapshot tagged with a rejected root', async () => {
    const queue = getChatQueueService();
    const lease: ChatQueueRevivalLease = { rootId: 'rejected-root', epoch: 15 };
    const acceptTurnRevival = jest
      .spyOn(queue, 'acceptTurnRevival')
      .mockReturnValue({ accepted: true, lease });
    const rollbackTurnRevival = jest
      .spyOn(queue, 'rollbackTurnRevival')
      .mockReturnValue(true);
    ingestProviderEventWithResultMock.mockImplementation((input) =>
      Promise.resolve(
        isStartingPickup(readProviderEventData(input))
          ? { outcome: 'not-applied', pickup: 'rejected' }
          : { outcome: 'applied' },
      ),
    );
    getOrCreateSessionMock.mockImplementationOnce(() =>
      Promise.resolve(
        createAgentSessionDouble({
          getSteeringCapabilities: getClaudeLiveSteeringCapabilities,
        }),
      ),
    );

    try {
      await dispatchPipelineEditorChatMessage(
        {
          projectId: PIPELINE_EDITOR_PROJECT_ID,
          worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
          chatId: 'delegation-rejected-pipeline',
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
      await call[1]({
        type: 'canopy_input_delivery',
        provider: 'claude',
        phase: 'picked-up',
        generation: 'live',
        attemptId: 'rejected-attempt',
        startsTurn: true,
        userMessageId: 'rejected-root',
      });
      // A delegate started by the rejected turn keeps that turn's tag.
      await call[1]({
        type: 'canopy_delegation',
        canopy_turn_user_message_id: 'rejected-root',
        delegation: {
          delegationId: 'child',
          runGeneration: 1,
          sequence: 2,
          parentHarnessId: 'claude',
          parentTurnId: 'rejected-root',
          parentToolCallId: 'call',
          createdAt: 1,
          task: {
            description: 'Review',
            prompt: 'Read',
            executionMode: 'background',
          },
          snapshot: {
            delegationId: 'child',
            status: 'completed',
            outputTruncated: false,
            routeSnapshot: {
              selectedModelId: 'reviewer',
              runtimeModelId: 'runtime',
              harnessId: 'claude',
            },
          },
          transcript: [],
        },
      });
      await call[3]?.drainEventsBeforeRemoval?.();

      expect(rollbackTurnRevival).toHaveBeenCalledWith(
        expect.objectContaining({ userMessageId: 'current' }),
        lease,
      );
      expect(
        hasProviderEventIngest('canopy_delegation', 'current', {
          canopy_turn_user_message_id: 'rejected-root',
        }),
      ).toBe(true);
      expect(
        hasSentProviderEvent('canopy_delegation', {
          canopy_turn_user_message_id: 'rejected-root',
        }),
      ).toBe(true);
    } finally {
      acceptTurnRevival.mockRestore();
      rollbackTurnRevival.mockRestore();
    }
  });

  it('does not release a newer same-id lease when queue confirmation is superseded', async () => {
    const queue = getChatQueueService();
    const lease: ChatQueueRevivalLease = { rootId: 'same-id', epoch: 17 };
    const acceptTurnRevival = jest
      .spyOn(queue, 'acceptTurnRevival')
      .mockReturnValue({ accepted: true, lease });
    const confirmTurnRevival = jest
      .spyOn(queue, 'confirmTurnRevival')
      .mockReturnValue(false);
    const rollbackTurnRevival = jest
      .spyOn(queue, 'rollbackTurnRevival')
      .mockReturnValue(false);
    const onTurnTerminal = jest.spyOn(queue, 'onTurnTerminal');
    ingestProviderEventWithResultMock.mockImplementation((input) =>
      Promise.resolve(
        isStartingPickup(readProviderEventData(input))
          ? { outcome: 'applied', pickup: 'accepted' }
          : { outcome: 'applied' },
      ),
    );
    getOrCreateSessionMock.mockImplementationOnce(() =>
      Promise.resolve(
        createAgentSessionDouble({
          getSteeringCapabilities: getClaudeLiveSteeringCapabilities,
        }),
      ),
    );

    try {
      await dispatchPipelineEditorChatMessage(
        {
          projectId: PIPELINE_EDITOR_PROJECT_ID,
          worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
          chatId: 'superseded-same-id-pipeline',
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
      await call[1]({
        type: 'canopy_input_delivery',
        provider: 'claude',
        phase: 'picked-up',
        generation: 'live',
        attemptId: 'superseded-attempt',
        startsTurn: true,
        userMessageId: 'same-id',
      });
      await call[1]({
        type: 'assistant',
        canopy_turn_user_message_id: 'same-id',
      });
      await call[1]({
        type: 'result',
        result: 'Done',
        canopy_turn_user_message_id: 'same-id',
      });
      await call[3]?.drainEventsBeforeRemoval?.();

      expect(confirmTurnRevival).toHaveBeenCalledWith(
        expect.objectContaining({ userMessageId: 'current' }),
        lease,
      );
      expect(rollbackTurnRevival).toHaveBeenCalledWith(
        expect.objectContaining({ userMessageId: 'current' }),
        lease,
      );
      expect(ingestProviderEventWithResultMock).toHaveBeenCalledTimes(1);
      expect(onTurnTerminal).not.toHaveBeenCalled();
    } finally {
      acceptTurnRevival.mockRestore();
      confirmTurnRevival.mockRestore();
      rollbackTurnRevival.mockRestore();
      onTurnTerminal.mockRestore();
    }
  });

  it('keeps router-refused pickup presentation without claiming a queue lease', async () => {
    const queue = getChatQueueService();
    const acceptTurnRevival = jest
      .spyOn(queue, 'acceptTurnRevival')
      .mockReturnValue({ accepted: false });
    const confirmTurnRevival = jest.spyOn(queue, 'confirmTurnRevival');
    const rollbackTurnRevival = jest.spyOn(queue, 'rollbackTurnRevival');
    ingestProviderEventWithResultMock.mockImplementation((input) =>
      Promise.resolve(
        isStartingPickup(readProviderEventData(input))
          ? { outcome: 'applied', pickup: 'rejected' }
          : { outcome: 'applied' },
      ),
    );
    getOrCreateSessionMock.mockImplementationOnce(() =>
      Promise.resolve(
        createAgentSessionDouble({
          getSteeringCapabilities: getClaudeLiveSteeringCapabilities,
        }),
      ),
    );

    try {
      await dispatchPipelineEditorChatMessage(
        {
          projectId: PIPELINE_EDITOR_PROJECT_ID,
          worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
          chatId: 'refused-pipeline',
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
      await call[1]({
        type: 'canopy_input_delivery',
        provider: 'claude',
        phase: 'picked-up',
        generation: 'live',
        attemptId: 'refused-attempt',
        startsTurn: true,
        userMessageId: 'refused-root',
      });
      await call[3]?.drainEventsBeforeRemoval?.();

      expect(acceptTurnRevival).toHaveBeenCalledWith(
        expect.objectContaining({ userMessageId: 'current' }),
        'refused-root',
      );
      expect(confirmTurnRevival).not.toHaveBeenCalled();
      expect(rollbackTurnRevival).not.toHaveBeenCalled();
      expect(
        hasSentProviderEvent('canopy_input_delivery', {
          turnRootAccepted: false,
        }),
      ).toBe(true);
      expect(
        hasProviderEventIngest('canopy_input_delivery', 'current', {
          turnRootAccepted: false,
        }),
      ).toBe(true);
    } finally {
      acceptTurnRevival.mockRestore();
      confirmTurnRevival.mockRestore();
      rollbackTurnRevival.mockRestore();
    }
  });

  it('waits for an earlier terminal commit and queue release before accepting a pickup', async () => {
    const queue = getChatQueueService();
    const lease: ChatQueueRevivalLease = { rootId: 'next-root', epoch: 23 };
    const acceptTurnRevival = jest
      .spyOn(queue, 'acceptTurnRevival')
      .mockReturnValue({ accepted: true, lease });
    const onTurnTerminal = jest.spyOn(queue, 'onTurnTerminal');
    let finishTerminalCommit:
      | ((result: ProviderEventIngestResult) => void)
      | undefined;
    const heldTerminalCommit = new Promise<ProviderEventIngestResult>(
      (resolve) => {
        finishTerminalCommit = resolve;
      },
    );
    ingestProviderEventWithResultMock.mockImplementation((input) => {
      const data = readProviderEventData(input);
      if (
        typeof data === 'object' &&
        data !== null &&
        'type' in data &&
        data.type === 'result'
      ) {
        return heldTerminalCommit;
      }
      return Promise.resolve(
        isStartingPickup(data)
          ? { outcome: 'applied', pickup: 'accepted' }
          : { outcome: 'applied' },
      );
    });
    getOrCreateSessionMock.mockImplementationOnce(() =>
      Promise.resolve(
        createAgentSessionDouble({
          getSteeringCapabilities: getClaudeLiveSteeringCapabilities,
        }),
      ),
    );

    try {
      await dispatchPipelineEditorChatMessage(
        {
          projectId: PIPELINE_EDITOR_PROJECT_ID,
          worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
          chatId: 'terminal-order-pipeline',
          userMessageId: 'previous-root',
          text: 'Previous turn',
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
        type: 'result',
        result: 'Previous turn complete',
        canopy_turn_user_message_id: 'previous-root',
      });
      void call[1]({
        type: 'canopy_input_delivery',
        provider: 'claude',
        phase: 'picked-up',
        generation: 'live',
        attemptId: 'next-attempt',
        startsTurn: true,
        userMessageId: 'next-root',
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(acceptTurnRevival).not.toHaveBeenCalled();
      finishTerminalCommit?.({ outcome: 'applied' });
      await call[3]?.drainEventsBeforeRemoval?.();

      const terminalCallOrder = onTurnTerminal.mock.invocationCallOrder[0];
      const revivalCallOrder = acceptTurnRevival.mock.invocationCallOrder[0];
      expect(terminalCallOrder).toBeDefined();
      expect(revivalCallOrder).toBeDefined();
      expect(terminalCallOrder).toBeLessThan(
        revivalCallOrder ?? Number.MAX_SAFE_INTEGER,
      );
    } finally {
      finishTerminalCommit?.({ outcome: 'applied' });
      acceptTurnRevival.mockRestore();
      onTurnTerminal.mockRestore();
    }
  });

  it.each(['claude', 'codex'] as const)(
    'routes retained %s callbacks to the latest turn',
    async (providerType) => {
      let retained: ((data: unknown) => void) | undefined;
      const shared = createAgentSessionDouble();
      getOrCreateSessionMock.mockImplementation((_opts, onEvent) => {
        retained ??= onEvent;
        return Promise.resolve(shared);
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
  getOrCreateSessionMock.mockImplementation(() =>
    Promise.resolve(createAgentSessionDouble()),
  );
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
    if (!isObjectRecord(second)) {
      throw new Error('Expected a committed provider event');
    }
    expect(second.mutationId).toContain('reload-id');
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
    getOrCreateSessionMock.mockImplementationOnce(() =>
      Promise.resolve({
        sendMessage: sendMessageMock,
        setPlanMode: setPlanModeMock,
        setApprovalMode: setApprovalModeMock,
        setModel: jest.fn(),
        setThinkingLevel: jest.fn(),
        cancel: jest.fn(),
        destroy: jest.fn(),
        setSpeed: setSpeedMock,
        setFastMode: setFastModeMock,
      }),
    );

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
    getOrCreateSessionMock.mockImplementationOnce(() =>
      Promise.resolve({
        sendMessage: sendMessageMock,
        setPlanMode: setPlanModeMock,
        setApprovalMode: setApprovalModeMock,
        setModel: jest.fn(),
        setThinkingLevel: jest.fn(),
        cancel: jest.fn(),
        destroy: jest.fn(),
        setFastMode: setFastModeMock,
      }),
    );

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

describe('pipeline-editor turn-start authority (CAN-4940)', () => {
  const target = {
    projectId: PIPELINE_EDITOR_PROJECT_ID,
    worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
    chatId: 'pipeline-editor-authority',
    userMessageId: 'authority-message',
  };
  const grant: ApprovalRule = {
    id: 'grant',
    behavior: 'allow',
    target: { kind: 'command', pattern: 'npm test *' },
    createdAt: '2026-10-24T00:00:00.000Z',
    origin: 'prompt',
  };
  const deny: ApprovalRule = {
    ...grant,
    id: 'deny',
    behavior: 'deny',
    target: { kind: 'command', pattern: 'rm *' },
  };
  function savedAuthority(
    approvalMode: ApprovalMode,
    sessionApprovalRules: ApprovalRule[] = [],
  ): ChatTabsFile {
    return {
      version: 1,
      activeTabId: target.chatId,
      tabs: [
        {
          id: target.chatId,
          title: 'Authority',
          messages: [],
          createdAt: grant.createdAt,
          approvalMode,
          sessionApprovalRules,
        },
      ],
    };
  }
  beforeEach(() =>
    clearLiveApprovalMode(target.projectId, target.worktreeId, target.chatId),
  );
  afterEach(() =>
    clearLiveApprovalMode(target.projectId, target.worktreeId, target.chatId),
  );
  it.each([
    { saved: 'ask', requested: 'full-access', expected: 'ask', grants: false },
    { saved: 'full-access', requested: 'ask', expected: 'ask', grants: false },
    {
      saved: 'full-access',
      requested: 'full-access',
      expected: 'full-access',
      grants: true,
    },
  ] as const)(
    'uses saved $saved narrowed by $requested',
    async ({ saved, requested, expected, grants }) => {
      const savedRules = grants ? [grant] : [];
      const expectedRules = [...savedRules, deny];
      mockReadAuthorityTabs.mockResolvedValue(
        savedAuthority(saved, savedRules),
      );
      await dispatchPipelineEditorChatMessage(
        {
          ...target,
          text: 'npm test',
          providerType: 'codex',
          model: 'gpt-5.5',
          approvalMode: requested,
          sessionApprovalRules: [grant, deny],
        },
        {
          getMainWindow: () => null,
          toolSurfaces: { getMainWindow: () => null },
        },
      );
      expect(jest.mocked(getOrCreateSession).mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({
          approvalMode: expected,
          sessionApprovalRules: expectedRules,
        }),
      );
      expect(setApprovalModeMock).toHaveBeenLastCalledWith(expected);
      expect(
        getLiveApprovalMode(target.projectId, target.worktreeId, target.chatId),
      ).toBe(expected);
    },
  );
  it.each(['missing', 'unreadable', 'admitted'] as const)(
    'fails closed or narrows with %s authority',
    async (state) => {
      if (state === 'unreadable')
        mockReadAuthorityTabs.mockRejectedValue(new Error('unreadable'));
      if (state === 'admitted')
        mockReadAuthorityTabs.mockResolvedValue(
          savedAuthority('full-access', [grant]),
        );
      await dispatchPipelineEditorChatMessage(
        {
          ...target,
          text: 'Continue',
          model: 'gpt-5.5',
          providerType: 'codex',
          approvalMode: 'full-access',
          sessionApprovalRules: [grant, deny],
          ...(state === 'admitted'
            ? {
                admittedApproval: {
                  approvalMode: 'ask',
                  sessionApprovalRules: [],
                },
              }
            : {}),
        },
        {
          getMainWindow: () => null,
          toolSurfaces: { getMainWindow: () => null },
        },
      );
      expect(jest.mocked(getOrCreateSession).mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({
          approvalMode: state === 'missing' ? 'auto' : 'ask',
          sessionApprovalRules: [deny],
        }),
      );
      if (state === 'admitted')
        expect(
          getLiveApprovalMode(
            target.projectId,
            target.worktreeId,
            target.chatId,
          ),
        ).toBe('full-access');
      expect(ensureChatForTrustedSendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalMode:
            state === 'admitted'
              ? 'full-access'
              : state === 'missing'
                ? 'auto'
                : 'ask',
        }),
      );
    },
  );

  it('rereads a grant removed during session creation before sending', async () => {
    mockReadAuthorityTabs
      .mockResolvedValueOnce(savedAuthority('full-access', [grant]))
      .mockResolvedValue(savedAuthority('ask', [deny]));
    await dispatchPipelineEditorChatMessage(
      { ...target, text: 'Continue', model: 'gpt-5.5', providerType: 'codex' },
      {
        getMainWindow: () => null,
        toolSurfaces: { getMainWindow: () => null },
      },
    );
    expect(setApprovalModeMock).toHaveBeenLastCalledWith('ask');
    expect(jest.mocked(restrictSessionApprovalRules)).toHaveBeenLastCalledWith(
      target.projectId,
      target.worktreeId,
      target.chatId,
      [deny],
    );
  });

  it('rechecks authority after asynchronous provider configuration', async () => {
    getOrCreateSessionMock.mockImplementationOnce(() =>
      Promise.resolve(
        createAgentSessionDouble({
          setCodexAppServerIdleTimeoutMinutes: setCodexIdleMock,
        }),
      ),
    );
    mockReadAuthorityTabs.mockResolvedValue(
      savedAuthority('full-access', [grant]),
    );
    setCodexIdleMock.mockImplementationOnce(() => {
      mockReadAuthorityTabs.mockResolvedValue(savedAuthority('ask', [deny]));
      return Promise.resolve();
    });
    await dispatchPipelineEditorChatMessage(
      { ...target, text: 'npm test', model: 'gpt-5.5', providerType: 'codex' },
      {
        getMainWindow: () => null,
        toolSurfaces: { getMainWindow: () => null },
      },
    );
    expect(setCodexIdleMock).toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalled();
    expect(setApprovalModeMock).toHaveBeenLastCalledWith('ask');
    expect(jest.mocked(restrictSessionApprovalRules)).toHaveBeenLastCalledWith(
      target.projectId,
      target.worktreeId,
      target.chatId,
      [deny],
    );
  });

  it('rechecks saved authority through its deferred-tools resume handler', async () => {
    const registration = jest.spyOn(
      deferredToolsReloadCoordinator,
      'registerResumeHandler',
    );
    mockReadAuthorityTabs.mockResolvedValue(
      savedAuthority('full-access', [grant]),
    );
    try {
      await dispatchPipelineEditorChatMessage(
        {
          ...target,
          text: 'Start',
          model: 'gpt-5.5',
          providerType: 'codex',
          approvalMode: 'full-access',
          sessionApprovalRules: [grant],
        },
        {
          getMainWindow: () => null,
          toolSurfaces: { getMainWindow: () => null },
        },
      );
      const resume = registration.mock.calls.find(
        ([scope]) => scope.chatId === target.chatId,
      )?.[1];
      if (!resume) throw new Error('Missing deferred-tools resume handler');
      mockReadAuthorityTabs.mockResolvedValue(savedAuthority('ask'));
      setLiveApprovalMode(
        target.projectId,
        target.worktreeId,
        target.chatId,
        'full-access',
      );
      await resume({
        scope: target,
        requestId: 'reload-authority',
        toolCallId: 'tool',
        userMessageId: target.userMessageId,
        continuationText: 'Continue',
        enabledResources: [],
        sdkSessionId: undefined,
        providerType: 'codex',
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
        signal: new AbortController().signal,
      });
      expect(jest.mocked(getOrCreateSession).mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({
          approvalMode: 'ask',
          sessionApprovalRules: [],
        }),
      );
      expect(setApprovalModeMock).toHaveBeenLastCalledWith('ask');
    } finally {
      registration.mockRestore();
    }
  });

  it('rechecks registered send admission before creating a provider session', async () => {
    mockReadAuthorityTabs.mockResolvedValue(savedAuthority('ask'));
    await expect(
      withChatSendAdmission(
        target,
        () => 'Authority changed',
        () =>
          dispatchPipelineEditorChatMessage(
            {
              ...target,
              text: 'Start',
              model: 'gpt-5.5',
              providerType: 'codex',
            },
            {
              getMainWindow: () => null,
              toolSurfaces: { getMainWindow: () => null },
            },
          ),
      ),
    ).rejects.toThrow('Authority changed');
    expect(getOrCreateSession).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
