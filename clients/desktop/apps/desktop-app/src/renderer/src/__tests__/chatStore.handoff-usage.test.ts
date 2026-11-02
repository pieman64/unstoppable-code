/**
 * CAN-2799 — the composer context-usage meter must survive a model or session
 * switch.
 *
 * Every path that starts a fresh provider session for a chat (continue on the
 * other harness, stale-session replacement) used to leave `usage` undefined,
 * and an in-tab model change kept the OLD model's `contextWindow`. The meter
 * then either went dead until the first turn on the new provider or reported
 * a wrong percentage. Seeding rule under test: a tab whose model is known
 * always carries a `usage` whose `contextWindow` equals
 * `getEffectiveModelContextWindow(tab.model, isTabAiCreditsRouted(tab))`, or a
 * Codex model's listed window until Codex reports its own;
 * counters start at zero on a new session and are kept on a model change.
 */
import type * as DesktopSharedTypes from '@canopy/desktop-shared/types';
import type {
  CanopyApi,
  ChatSendMessageRequest,
  ChatSendMessageResult,
  ChatTabUsage,
  GenerateHandoffSummaryRequest,
  GenerateHandoffSummaryResponse,
} from '@canopy/desktop-shared/types';
import type { PluginsCache } from '@canopy/desktop-shared/types/plugins';
import type * as ChatStoreModule from '../stores/chatStore';

const sendMessageMock = jest.fn<
  Promise<ChatSendMessageResult>,
  [ChatSendMessageRequest]
>();
const generateHandoffSummaryMock = jest.fn<
  Promise<GenerateHandoffSummaryResponse>,
  [GenerateHandoffSummaryRequest]
>();
const changeModelMock = jest.fn<Promise<boolean>, [unknown]>();
const discoverWorktreeEnvMock = jest.fn<Promise<void>, [unknown]>();
const flushScopeMock = jest.fn<Promise<void>, [unknown]>();
const chatCommandMock = jest.fn(() =>
  Promise.resolve({
    commandId: 'renderer-plan-state',
    revision: 2,
    outcome: 'applied' as const,
  }),
);
const loadPreferencesMock = jest.fn<Promise<Record<string, unknown>>, []>();
const savePreferencesMock = jest.fn<Promise<void>, [unknown]>();
const loadMarketplacesMock = jest.fn<
  Promise<{ success: boolean; data: PluginsCache }>,
  []
>();
const claudeTerminalCleanupMock = jest.fn<Promise<void>, [unknown]>();
const claudeTerminalGetStateMock = jest.fn<Promise<unknown>, [unknown]>();
const claudeTerminalSubscribeMock = jest.fn<() => void, [unknown]>();
const terminalWriteMock = jest.fn<Promise<unknown>, [unknown]>();

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface Global {
      window: { api: CanopyApi };
    }
  }
}

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const CLAUDE_CONTEXT_WINDOW = 200_000;
const CLAUDE_LARGE_MODEL = 'opus[1m]';
const CLAUDE_LARGE_CONTEXT_WINDOW = 1_000_000;
const CODEX_MODEL = 'gpt-5.5';
const CODEX_CONTEXT_WINDOW = 400_000;

function initTestModelRegistries(): void {
  const {
    initAgentModels,
    initClaudeModels,
    initCodexModels,
    initModelAliases,
  } = jest.requireActual<typeof DesktopSharedTypes>(
    '@canopy/desktop-shared/types',
  );
  initAgentModels([]);
  initClaudeModels([
    { id: CLAUDE_MODEL, label: 'Sonnet', contextWindow: CLAUDE_CONTEXT_WINDOW },
    {
      id: CLAUDE_LARGE_MODEL,
      label: 'Opus 1M',
      contextWindow: CLAUDE_LARGE_CONTEXT_WINDOW,
    },
  ]);
  initCodexModels([
    { id: CODEX_MODEL, label: 'GPT 5.5', contextWindow: CODEX_CONTEXT_WINDOW },
  ]);
  initModelAliases({});
}

function loadChatStore(): typeof ChatStoreModule {
  jest.resetModules();
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      location: { search: '' },
      api: {
        chat: {
          sendMessage: sendMessageMock,
          generateHandoffSummary: generateHandoffSummaryMock,
          changeModel: changeModelMock,
          flushScope: flushScopeMock,
          command: chatCommandMock,
        },
        claudeTerminal: {
          cleanup: claudeTerminalCleanupMock,
          getState: claudeTerminalGetStateMock,
          onStateChanged: claudeTerminalSubscribeMock,
          onSyncCompleted: claudeTerminalSubscribeMock,
          onError: claudeTerminalSubscribeMock,
        },
        terminal: { write: terminalWriteMock },
        discoverWorktreeEnv: discoverWorktreeEnvMock,
        loadPreferences: loadPreferencesMock,
        savePreferences: savePreferencesMock,
      },
      plugins: { loadMarketplaces: loadMarketplacesMock },
    },
  });
  const chatStore = jest.requireActual<typeof ChatStoreModule>(
    '../stores/chatStore',
  );
  // The store module resets the registries on load; seed after requiring so
  // `getProviderForModel` and `getEffectiveModelContextWindow` see the fixture
  // catalog the way a running renderer sees the hydrated registry.
  initTestModelRegistries();
  chatStore.useChatStore.setState({
    approvalDefaultsCache: { project: 'ask' },
  });
  return chatStore;
}

function makeTab(
  overrides?: Partial<ChatStoreModule.ChatTab>,
): ChatStoreModule.ChatTab {
  return {
    id: 'chat',
    title: 'Chat',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-03-19T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
    model: CLAUDE_MODEL,
    providerType: 'claude',
    ...overrides,
  };
}

const SOURCE_USAGE: ChatTabUsage = {
  contextTokens: 64_000,
  contextWindow: CLAUDE_CONTEXT_WINDOW,
  maxOutputTokens: 8_000,
  totalCostUsd: 1.25,
  inputTokens: 120_000,
  outputTokens: 9_000,
  cacheReadInputTokens: 50_000,
  cacheCreationInputTokens: 4_000,
  durationMs: 90_000,
  durationApiMs: 60_000,
  numTurns: 6,
  model: CLAUDE_MODEL,
};

const ZEROED_COUNTERS = {
  contextTokens: 0,
  totalCostUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  durationMs: 0,
  durationApiMs: 0,
  numTurns: 0,
};

function seedWorktree(
  useChatStore: ReturnType<typeof loadChatStore>['useChatStore'],
  tab: ChatStoreModule.ChatTab,
): void {
  useChatStore.setState({
    selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
    worktreeChats: {
      'project/worktree': { activeTabId: tab.id, tabs: [tab] },
    },
  });
}

function findTab(
  useChatStore: ReturnType<typeof loadChatStore>['useChatStore'],
  predicate: (tab: ChatStoreModule.ChatTab) => boolean,
): ChatStoreModule.ChatTab | undefined {
  return useChatStore
    .getState()
    .worktreeChats['project/worktree']?.tabs.find(predicate);
}

beforeEach(() => {
  jest.clearAllMocks();
  sendMessageMock.mockResolvedValue({});
  generateHandoffSummaryMock.mockResolvedValue({
    summary: 'The user asked to fix a flaky archive spec. It now passes.',
  });
  changeModelMock.mockResolvedValue(true);
  discoverWorktreeEnvMock.mockResolvedValue(undefined);
  flushScopeMock.mockResolvedValue(undefined);
  loadPreferencesMock.mockResolvedValue({});
  savePreferencesMock.mockResolvedValue(undefined);
  claudeTerminalCleanupMock.mockResolvedValue(undefined);
  claudeTerminalGetStateMock.mockResolvedValue(null);
  claudeTerminalSubscribeMock.mockReturnValue(() => undefined);
  loadMarketplacesMock.mockResolvedValue({
    success: true,
    data: {
      version: 2,
      lastRefreshed: '2026-03-19T00:00:00.000Z',
      marketplaces: [],
    },
  });
});

it.each([true, false])(
  'Cursor fork drops response counters only when history is truncated: %s',
  (truncated) => {
    const { useChatStore } = loadChatStore();
    const usage = {
      ...SOURCE_USAGE,
      cursorReportedUsage: { inputTokens: 12000, outputTokens: 800 },
    };
    seedWorktree(
      useChatStore,
      makeTab({
        model: 'cursor-default',
        providerType: 'cursor',
        usage,
        messages: ['u1', 'a1', 'u2', 'a2'].map((id, index) => ({
          id,
          role: index % 2 === 0 ? 'user' : 'assistant',
          blocks: [{ type: 'text', text: id }],
          timestamp: index,
        })),
      }),
    );
    useChatStore
      .getState()
      .forkTab(
        'chat',
        undefined,
        truncated ? { forkAfterUserMessageId: 'u1' } : undefined,
      );
    const fork = findTab(useChatStore, (tab) => tab.id !== 'chat');
    expect(fork?.messages).toHaveLength(truncated ? 2 : 4);
    expect(fork?.usage?.cursorReportedUsage).toEqual(
      truncated ? undefined : usage.cursorReportedUsage,
    );
    expect(fork?.usage?.inputTokens).toBe(SOURCE_USAGE.inputTokens);
    expect(
      findTab(useChatStore, (tab) => tab.id === 'chat')?.usage
        ?.cursorReportedUsage,
    ).toEqual(usage.cursorReportedUsage);
  },
);

describe('continue on the other harness keeps the context meter alive', () => {
  it('seeds a zeroed usage sized to the target model on the continued tab', async () => {
    const { useChatStore } = loadChatStore();
    const { getListedModelContextWindow } = jest.requireActual<
      typeof DesktopSharedTypes
    >('@canopy/desktop-shared/types');
    seedWorktree(
      useChatStore,
      makeTab({
        sdkSessionId: 'claude-session-uuid',
        usage: SOURCE_USAGE,
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Fix the archive spec' }],
            timestamp: 1,
          },
          {
            id: 'msg-2',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Done, it passes now.' }],
            timestamp: 2,
          },
        ],
      }),
    );

    const result = await useChatStore
      .getState()
      .continueTabOnProvider('chat', CODEX_MODEL);

    expect(result.status).toBe('created');
    const continued = findTab(useChatStore, (tab) => tab.id !== 'chat');
    expect(continued?.model).toBe(CODEX_MODEL);
    // Counters start fresh — the continued chat is a new session — but the
    // meter is alive: the window is the TARGET model's, not the source's.
    expect(continued?.usage).toMatchObject(ZEROED_COUNTERS);
    expect(continued?.usage?.contextWindow).toBe(CODEX_CONTEXT_WINDOW);
    // A Codex window is the model's listed one; Codex's first report
    // replaces it.
    expect(continued?.usage?.contextWindow).toBe(
      getListedModelContextWindow(CODEX_MODEL),
    );
    expect(continued?.usage?.model).toBe(CODEX_MODEL);
    // The source tab's running total is untouched.
    expect(findTab(useChatStore, (tab) => tab.id === 'chat')?.usage).toEqual(
      SOURCE_USAGE,
    );
  });
});

describe('stale-session replacement keeps the context meter alive', () => {
  it('handleStaleSessionStartNew seeds a zeroed usage sized to the model', async () => {
    const { useChatStore } = loadChatStore();
    seedWorktree(
      useChatStore,
      makeTab({
        model: CLAUDE_LARGE_MODEL,
        usage: { ...SOURCE_USAGE, contextWindow: CLAUDE_LARGE_CONTEXT_WINDOW },
        staleSessionDetected: {
          droppedMessageText: 'Retry this change',
          droppedFileReferences: [],
        },
      }),
    );

    await useChatStore.getState().handleStaleSessionStartNew();

    const replacement = findTab(useChatStore, (tab) => tab.id !== 'chat');
    expect(replacement?.model).toBe(CLAUDE_LARGE_MODEL);
    expect(replacement?.usage).toMatchObject(ZEROED_COUNTERS);
    expect(replacement?.usage?.contextWindow).toBe(CLAUDE_LARGE_CONTEXT_WINDOW);
  });

  it('sizes the replacement window to the replacement route, not the source route', async () => {
    const { useChatStore } = loadChatStore();
    // After `loadChatStore` reset the module registry: the gateway advertises
    // a smaller window for the same model.
    const { initAiGatewayModels } = jest.requireActual<
      typeof DesktopSharedTypes
    >('@canopy/desktop-shared/types');
    initAiGatewayModels(
      [],
      [
        {
          modelId: CLAUDE_MODEL,
          gatewayId: `anthropic/${CLAUDE_MODEL}`,
          family: 'anthropic',
          recommendedHarness: 'claude',
          gatewayOnly: false,
          contextWindow: 100_000,
          supportsPromptCaching: true,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
    );
    seedWorktree(
      useChatStore,
      makeTab({
        aiCreditsRouted: true,
        usage: { ...SOURCE_USAGE, contextWindow: 100_000 },
        staleSessionDetected: {
          droppedMessageText: 'Retry this change',
          droppedFileReferences: [],
        },
      }),
    );

    await useChatStore.getState().handleStaleSessionStartNew();

    // `createEmptyTab` does not inherit the source's routing, so the
    // replacement executes on the native route and its meter must say so.
    const replacement = findTab(useChatStore, (tab) => tab.id !== 'chat');
    expect(replacement?.aiCreditsRouted).toBeUndefined();
    expect(replacement?.usage?.contextWindow).toBe(CLAUDE_CONTEXT_WINDOW);
  });

  it('handleStaleSessionHandOff seeds a zeroed usage sized to the model', async () => {
    const { useChatStore } = loadChatStore();
    seedWorktree(
      useChatStore,
      makeTab({
        usage: SOURCE_USAGE,
        staleSessionDetected: {
          droppedMessageText: 'Retry this change',
          droppedFileReferences: [],
        },
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Fix the archive spec' }],
            timestamp: 1,
          },
          {
            id: 'msg-2',
            role: 'user',
            blocks: [{ type: 'text', text: 'Retry this change' }],
            timestamp: 2,
          },
        ],
      }),
    );

    await useChatStore.getState().handleStaleSessionHandOff();

    const replacement = findTab(useChatStore, (tab) => tab.id !== 'chat');
    expect(replacement).toBeDefined();
    expect(replacement?.usage).toMatchObject(ZEROED_COUNTERS);
    expect(replacement?.usage?.contextWindow).toBe(CLAUDE_CONTEXT_WINDOW);
  });
});

describe('model change keeps the context meter accurate', () => {
  it('setModelAndWait updates contextWindow immediately and keeps the counters', async () => {
    const { useChatStore } = loadChatStore();
    seedWorktree(useChatStore, makeTab({ usage: SOURCE_USAGE }));

    const accepted = await useChatStore
      .getState()
      .setModelAndWait(CLAUDE_LARGE_MODEL);

    expect(accepted).toBe(true);
    const tab = findTab(useChatStore, (candidate) => candidate.id === 'chat');
    expect(tab?.model).toBe(CLAUDE_LARGE_MODEL);
    expect(tab?.usage?.contextWindow).toBe(CLAUDE_LARGE_CONTEXT_WINDOW);
    // Token counts are the chat's own running total; a model change does not
    // reset them.
    expect(tab?.usage).toMatchObject({
      contextTokens: SOURCE_USAGE.contextTokens,
      inputTokens: SOURCE_USAGE.inputTokens,
      outputTokens: SOURCE_USAGE.outputTokens,
      numTurns: SOURCE_USAGE.numTurns,
      totalCostUsd: SOURCE_USAGE.totalCostUsd,
    });
  });

  it('setModelAndWait sizes a switch to Codex by its listed window', async () => {
    const { useChatStore } = loadChatStore();
    seedWorktree(useChatStore, makeTab({ usage: SOURCE_USAGE }));

    await useChatStore.getState().setModelAndWait(CODEX_MODEL);

    const tab = findTab(useChatStore, (candidate) => candidate.id === 'chat');
    expect(tab?.model).toBe(CODEX_MODEL);
    expect(tab?.usage?.contextWindow).toBe(CODEX_CONTEXT_WINDOW);
    expect(tab?.usage?.numTurns).toBe(SOURCE_USAGE.numTurns);
  });

  it('setModelAndWait seeds a usage on a tab that had none yet', async () => {
    const { useChatStore } = loadChatStore();
    seedWorktree(useChatStore, makeTab({ usage: undefined }));

    await useChatStore.getState().setModelAndWait(CODEX_MODEL);

    const tab = findTab(useChatStore, (candidate) => candidate.id === 'chat');
    expect(tab?.model).toBe(CODEX_MODEL);
    expect(tab?.usage).toMatchObject(ZEROED_COUNTERS);
    expect(tab?.usage?.contextWindow).toBe(CODEX_CONTEXT_WINDOW);
  });

  it('does not repin an OpenCode chat when its model becomes policy-blocked', () => {
    const { useChatStore } = loadChatStore();
    seedWorktree(
      useChatStore,
      makeTab({
        usage: SOURCE_USAGE,
        sdkSessionId: 'opencode-sdk',
        providerType: 'opencode',
        executionHarness: 'opencode',
      }),
    );
    useChatStore.getState().reconcileModelRegistry(
      {
        claude: [
          { id: CLAUDE_MODEL, label: 'Sonnet' },
          { id: CLAUDE_LARGE_MODEL, label: 'Opus' },
        ],
        codex: [],
        ollama: [],
        aliases: {},
      },
      new Set([CLAUDE_MODEL]),
    );
    expect(
      findTab(useChatStore, (candidate) => candidate.id === 'chat'),
    ).toMatchObject({
      model: CLAUDE_MODEL,
      providerType: 'opencode',
      executionHarness: 'opencode',
      sdkSessionId: 'opencode-sdk',
    });
    expect(changeModelMock).not.toHaveBeenCalled();
  });

  it('a policy-forced model replacement updates contextWindow as well', () => {
    const { useChatStore } = loadChatStore();
    seedWorktree(
      useChatStore,
      makeTab({ usage: SOURCE_USAGE, sdkSessionId: 'sdk-1' }),
    );

    useChatStore.getState().reconcileModelRegistry(
      {
        claude: [
          {
            id: CLAUDE_MODEL,
            label: 'Sonnet',
            contextWindow: CLAUDE_CONTEXT_WINDOW,
          },
          {
            id: CLAUDE_LARGE_MODEL,
            label: 'Opus 1M',
            contextWindow: CLAUDE_LARGE_CONTEXT_WINDOW,
          },
        ],
        codex: [],
        ollama: [],
        aliases: {},
      },
      new Set<string>([CLAUDE_MODEL]),
    );

    const tab = findTab(useChatStore, (candidate) => candidate.id === 'chat');
    expect(tab?.model).toBe(CLAUDE_LARGE_MODEL);
    expect(tab?.usage?.contextWindow).toBe(CLAUDE_LARGE_CONTEXT_WINDOW);
    expect(tab?.usage?.numTurns).toBe(SOURCE_USAGE.numTurns);
  });
});
