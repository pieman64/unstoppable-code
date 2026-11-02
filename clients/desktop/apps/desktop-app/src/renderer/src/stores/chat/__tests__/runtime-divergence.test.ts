import type {
  ChatRuntimeState,
  PersistedChatError,
} from '@canopy/desktop-shared/types';
import type * as InstrumentationClient from '@canopy/desktop-instrumentation/client';
import type * as ChatStoreModule from '../../chatStore';
import type * as RuntimeDivergenceModule from '../runtime-divergence';
import type {
  RuntimeDivergenceDeps,
  RuntimeDivergenceRecord,
} from '../runtime-divergence';
import type { CanonicalTurnConfirmation } from '../turn-confirmation';
import type { ChatTab } from '../types';

jest.mock('@canopy/desktop-instrumentation/client', () => ({
  startClientOperation: jest.fn(),
  succeedClientOperation: jest.fn(),
}));

const SCOPE_KEY = 'p/w';
const TARGET = { projectId: 'p', worktreeId: 'w', chatId: 'chat-1' };

type LoadedModules = {
  chat: typeof ChatStoreModule;
  detector: typeof RuntimeDivergenceModule;
};

let resetDetector: (() => void) | undefined;

function noop(): void {}

function loadModules(): LoadedModules {
  jest.resetModules();
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      location: { search: '' },
      api: {
        chat: {
          sendMessage: jest.fn().mockResolvedValue(undefined),
          cancel: jest.fn().mockResolvedValue({}),
          resumeStoppedTurn: jest.fn().mockResolvedValue({}),
          loadTabs: jest
            .fn()
            .mockResolvedValue({ version: 1, tabs: [], activeTabId: '' }),
          saveTabs: jest.fn().mockResolvedValue(undefined),
          activeSessions: jest
            .fn()
            .mockResolvedValue({ activeChatIds: [], sessions: [] }),
          cancelDeferredToolsReload: noop,
          answerMcpQuestion: noop,
          preparePlanFileSystemInstruction: noop,
        },
        getDiffStatsBatch: jest.fn().mockResolvedValue([]),
        discoverWorktreeEnv: jest.fn().mockResolvedValue(undefined),
        github: {
          setForegroundWorktree: noop,
          requestFastRefresh: noop,
          requestKnownPrFastRefresh: jest.fn().mockResolvedValue(false),
        },
        activity: {
          plans: {
            create: noop,
            update: noop,
            list: jest.fn().mockResolvedValue([]),
            get: jest.fn().mockResolvedValue(null),
          },
        },
        showOsNotification: jest.fn().mockResolvedValue({ shown: false }),
        onOsNotificationClicked: jest.fn(() => (): void => {}),
        onOsNotificationClosed: jest.fn(() => (): void => {}),
        savePreferences: noop,
        loadPreferences: jest.fn().mockResolvedValue({}),
      },
    },
  });

  const chat = jest.requireActual<typeof ChatStoreModule>('../../chatStore');
  const detector = jest.requireActual<typeof RuntimeDivergenceModule>(
    '../runtime-divergence',
  );
  resetDetector = detector.__resetRuntimeDivergenceForTests;
  return { chat, detector };
}

function makeTab(overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    id: TARGET.chatId,
    title: 'Chat',
    messages: [
      {
        id: 'user-1',
        role: 'user',
        blocks: [{ type: 'text', text: 'do the thing' }],
        timestamp: 900,
      },
    ],
    status: 'idle',
    error: null,
    createdAt: '2026-09-23T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: {
      thinkingLevel: 'high',
      speed: 'standard',
      fastMode: false,
    },
    fastModeExplicit: false,
    model: 'claude-sonnet-4-5-20250514',
    providerType: 'claude',
    approvalMode: 'ask',
    sdkSessionId: 'sdk-abc',
    ...overrides,
  };
}

function runtimeFor(
  status: ChatRuntimeState['status'],
  error?: PersistedChatError,
): ChatRuntimeState {
  return {
    status,
    queuedMessageIds: [],
    ...(error ? { error } : {}),
  };
}

function seed(
  chat: typeof ChatStoreModule,
  tabStatus: ChatTab['status'],
  runtime: ChatRuntimeState | undefined,
  options: {
    phase?: 'hydrating' | 'live' | 'refreshing' | 'refresh_error';
    tab?: Partial<ChatTab>;
  } = {},
): void {
  const tab = makeTab({ status: tabStatus, ...options.tab });
  chat.useChatStore.setState({
    chatStateSync: {
      [SCOPE_KEY]: { phase: options.phase ?? 'live', revision: 3 },
    },
    runtimeByChatId: runtime ? { [TARGET.chatId]: runtime } : {},
    worktreeChats: {
      [SCOPE_KEY]: { activeTabId: tab.id, tabs: [tab] },
    },
  });
}

function readTab(chat: typeof ChatStoreModule): ChatTab {
  const tab = chat.useChatStore
    .getState()
    .worktreeChats[SCOPE_KEY]?.tabs.find((entry) => entry.id === TARGET.chatId);
  if (!tab) throw new Error('tab missing');
  return tab;
}

function writeTab(chat: typeof ChatStoreModule, tab: ChatTab): void {
  const state = chat.useChatStore.getState();
  const scope = state.worktreeChats[SCOPE_KEY];
  if (!scope) throw new Error('scope missing');
  chat.useChatStore.setState({
    worktreeChats: {
      ...state.worktreeChats,
      [SCOPE_KEY]: {
        ...scope,
        tabs: scope.tabs.map((entry) => (entry.id === tab.id ? tab : entry)),
      },
    },
  });
}

function confirmWith(
  result: CanonicalTurnConfirmation,
): RuntimeDivergenceDeps['confirm'] {
  return jest
    .fn<
      ReturnType<RuntimeDivergenceDeps['confirm']>,
      Parameters<RuntimeDivergenceDeps['confirm']>
    >()
    .mockResolvedValue(result);
}

function recordSpy(): jest.Mock<void, [RuntimeDivergenceRecord]> {
  return jest.fn<void, [RuntimeDivergenceRecord]>();
}

describe('runtime divergence detector', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000);
    jest.clearAllMocks();
  });

  afterEach(() => {
    resetDetector?.();
    resetDetector = undefined;
    jest.useRealTimers();
  });

  it('confirms and repairs a tagged stale streaming status after the grace period', async () => {
    const { chat, detector } = loadModules();
    seed(chat, 'idle', runtimeFor('completed'));
    const confirm = confirmWith({ state: 'inactive' });
    const record = recordSpy();
    detector.installRuntimeDivergenceDetector({
      confirm,
      record,
      now: () => Date.now(),
    });

    detector.tagStatusWrite(TARGET.chatId, 'keep-streaming');
    writeTab(chat, { ...readTab(chat), status: 'streaming' });

    await jest.advanceTimersByTimeAsync(2_999);
    expect(confirm).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(TARGET);
    expect(readTab(chat).status).toBe('idle');
    expect(record).toHaveBeenCalledTimes(1);
    const recorded = record.mock.calls[0]?.[0];
    expect(recorded).toMatchObject({
      writer: 'keep-streaming',
      tabStatus: 'streaming',
      runtimeStatus: 'completed',
    });
    expect(recorded?.divergedMs).toBeGreaterThanOrEqual(3_000);
  }, 15_000);

  it('records untagged divergence as unknown writer', async () => {
    const { chat, detector } = loadModules();
    seed(chat, 'streaming', runtimeFor('completed'));
    const confirm = confirmWith({ state: 'inactive' });
    const record = recordSpy();
    detector.installRuntimeDivergenceDetector({
      confirm,
      record,
      now: () => Date.now(),
    });

    await jest.advanceTimersByTimeAsync(3_000);

    expect(readTab(chat).status).toBe('idle');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ writer: 'unknown' }),
    );
  });

  it('repairs a failed runtime to error with its cached error message', async () => {
    const { chat, detector } = loadModules();
    const error: PersistedChatError = {
      code: 'provider_error',
      message: 'Provider failed',
      retryable: true,
      occurredAt: '2026-09-23T00:00:00.000Z',
    };
    seed(chat, 'streaming', runtimeFor('failed', error));
    const record = recordSpy();
    detector.installRuntimeDivergenceDetector({
      confirm: confirmWith({ state: 'inactive' }),
      record,
      now: () => Date.now(),
    });

    await jest.advanceTimersByTimeAsync(3_000);

    expect(readTab(chat)).toEqual(
      expect.objectContaining({ status: 'error', error: 'Provider failed' }),
    );
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('repairs a stale idle tab to streaming when main confirms an active turn', async () => {
    const { chat, detector } = loadModules();
    seed(chat, 'idle', runtimeFor('streaming'));
    const record = recordSpy();
    detector.installRuntimeDivergenceDetector({
      confirm: confirmWith({ state: 'active' }),
      record,
      now: () => Date.now(),
    });

    await jest.advanceTimersByTimeAsync(3_000);

    expect(readTab(chat)).toEqual(
      expect.objectContaining({ status: 'streaming', error: null }),
    );
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        tabStatus: 'idle',
        runtimeStatus: 'streaming',
      }),
    );
  });

  it('retries an unknown confirmation with exponential backoff and records nothing', async () => {
    const { chat, detector } = loadModules();
    seed(chat, 'streaming', runtimeFor('completed'));
    const confirm = jest
      .fn<
        ReturnType<RuntimeDivergenceDeps['confirm']>,
        Parameters<RuntimeDivergenceDeps['confirm']>
      >()
      .mockResolvedValueOnce({ state: 'unknown' })
      .mockResolvedValueOnce({ state: 'inactive' });
    const record = recordSpy();
    detector.installRuntimeDivergenceDetector({
      confirm,
      record,
      now: () => Date.now(),
    });

    await jest.advanceTimersByTimeAsync(3_000);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(readTab(chat).status).toBe('streaming');
    expect(record).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(5_999);
    expect(confirm).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(readTab(chat).status).toBe('idle');
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('restarts the grace period when a newer runtime reference still disagrees', async () => {
    const { chat, detector } = loadModules();
    seed(chat, 'streaming', runtimeFor('completed'));
    const confirm = confirmWith({ state: 'inactive' });
    detector.installRuntimeDivergenceDetector({
      confirm,
      record: jest.fn(),
      now: () => Date.now(),
    });

    await jest.advanceTimersByTimeAsync(2_000);
    chat.useChatStore.setState({
      runtimeByChatId: { [TARGET.chatId]: runtimeFor('failed') },
    });
    await jest.advanceTimersByTimeAsync(2_999);
    expect(confirm).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);

    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('does not confirm when a runtime patch resolves the divergence before grace', async () => {
    const { chat, detector } = loadModules();
    seed(chat, 'streaming', runtimeFor('completed'));
    const confirm = confirmWith({ state: 'active' });
    const record = recordSpy();
    detector.installRuntimeDivergenceDetector({
      confirm,
      record,
      now: () => Date.now(),
    });

    await jest.advanceTimersByTimeAsync(2_000);
    chat.useChatStore.setState({
      runtimeByChatId: { [TARGET.chatId]: runtimeFor('streaming') },
    });
    await jest.advanceTimersByTimeAsync(3_000);

    expect(confirm).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('uses an override after a missed revision and re-enables on a new runtime reference', async () => {
    const { chat, detector } = loadModules();
    seed(chat, 'idle', runtimeFor('streaming'));
    const confirm = confirmWith({ state: 'inactive' });
    const record = recordSpy();
    detector.installRuntimeDivergenceDetector({
      confirm,
      record,
      now: () => Date.now(),
    });

    await jest.advanceTimersByTimeAsync(3_000);
    expect(readTab(chat).status).toBe('idle');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(3_000);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();

    chat.useChatStore.setState({
      runtimeByChatId: { [TARGET.chatId]: runtimeFor('streaming') },
    });
    await jest.advanceTimersByTimeAsync(3_000);

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(record).not.toHaveBeenCalled();
  });

  it.each(['hydrating', 'refreshing'] as const)(
    'skips a %s scope',
    async (phase) => {
      const { chat, detector } = loadModules();
      seed(chat, 'streaming', runtimeFor('completed'), { phase });
      const confirm = confirmWith({ state: 'inactive' });
      const record = recordSpy();
      detector.installRuntimeDivergenceDetector({
        confirm,
        record,
        now: () => Date.now(),
      });

      await jest.advanceTimersByTimeAsync(6_000);

      expect(confirm).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    },
  );

  it('skips chats with no canonical runtime entry', async () => {
    const { chat, detector } = loadModules();
    seed(chat, 'streaming', undefined);
    const confirm = confirmWith({ state: 'inactive' });
    detector.installRuntimeDivergenceDetector({
      confirm,
      record: jest.fn(),
      now: () => Date.now(),
    });

    await jest.advanceTimersByTimeAsync(6_000);

    expect(confirm).not.toHaveBeenCalled();
  });

  it('skips terminal-backed Claude tabs', async () => {
    const { chat, detector } = loadModules();
    seed(chat, 'streaming', runtimeFor('completed'), {
      tab: { claudeTerminal: { turnState: 'idle' } },
    });
    const confirm = confirmWith({ state: 'inactive' });
    detector.installRuntimeDivergenceDetector({
      confirm,
      record: jest.fn(),
      now: () => Date.now(),
    });

    await jest.advanceTimersByTimeAsync(6_000);

    expect(confirm).not.toHaveBeenCalled();
  });

  it('skips file tabs', async () => {
    const { chat, detector } = loadModules();
    seed(chat, 'streaming', runtimeFor('completed'), {
      tab: { kind: 'file' },
    });
    const confirm = confirmWith({ state: 'inactive' });
    detector.installRuntimeDivergenceDetector({
      confirm,
      record: jest.fn(),
      now: () => Date.now(),
    });

    await jest.advanceTimersByTimeAsync(6_000);

    expect(confirm).not.toHaveBeenCalled();
  });

  it('records repairs through the diagnostic instrumentation operation by default', async () => {
    const { chat, detector } = loadModules();
    seed(chat, 'streaming', runtimeFor('completed'));
    detector.installRuntimeDivergenceDetector({
      confirm: confirmWith({ state: 'inactive' }),
      now: () => Date.now(),
    });

    await jest.advanceTimersByTimeAsync(3_000);

    const instrumentation = jest.requireMock<
      jest.Mocked<typeof InstrumentationClient>
    >('@canopy/desktop-instrumentation/client');
    const startCall = instrumentation.startClientOperation.mock.calls[0];
    const succeedCall = instrumentation.succeedClientOperation.mock.calls[0];
    expect(startCall?.[0]).toBe('canopy.app_diagnostic');
    expect(startCall?.[1]?.operationKey).toMatch(
      /^renderer_runtime_divergence:/,
    );
    expect(startCall?.[1]?.context).toMatchObject({
      kind: 'renderer_runtime_divergence',
      writer: 'unknown',
      tabStatus: 'streaming',
      runtimeStatus: 'completed',
    });
    expect(typeof startCall?.[1]?.context?.divergedMs).toBe('number');
    expect(succeedCall?.[0]).toBe('canopy.app_diagnostic');
    expect(succeedCall?.[1]?.context).toEqual(startCall?.[1]?.context);
  });

  it('uninstalls and clears pending timers when reset', async () => {
    const { chat, detector } = loadModules();
    seed(chat, 'streaming', runtimeFor('completed'));
    const confirm = confirmWith({ state: 'inactive' });
    detector.installRuntimeDivergenceDetector({
      confirm,
      record: recordSpy(),
      now: () => Date.now(),
    });

    detector.__resetRuntimeDivergenceForTests();
    await jest.advanceTimersByTimeAsync(6_000);

    expect(confirm).not.toHaveBeenCalled();
  });
});
