import type {
  ChatHookAction,
  HookChatTabStartedEvent,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import type * as HookChatModule from '../../lib/hook-chat';
import type * as SharedTypes from '@canopy/desktop-shared/types';

const mockTrace: string[] = [];
const mockStartedEvents: HookChatTabStartedEvent[] = [];
const mockDispatches: Array<Record<string, unknown>> = [];
const mockActivityListeners = new Set<() => void>();
let mockActiveTargets = new Set<string>();
let mockRendererAvailable = true;
let mockPreferences: PreferencesData;

jest.mock('../../lib/window-send', () => ({
  sendToWindow: (
    _window: unknown,
    channel: string,
    payload: unknown,
  ): boolean => {
    if (!mockRendererAvailable) return false;
    const event = payload as HookChatTabStartedEvent;
    mockStartedEvents.push(event);
    mockTrace.push(
      `${channel} ${event.worktreeId} ${event.chatId} ${event.queuedMessage ? 'queued' : 'started'}`,
    );
    return true;
  },
}));
jest.mock('../../lib/chat-tab-dispatch-utils', () => ({
  upsertPersistedChatTab: (args: {
    worktreeId: string;
    tab: { id: string };
    activateTab: boolean;
  }): Promise<void> => {
    mockTrace.push(
      `persist ${args.worktreeId} ${args.tab.id} activate=${args.activateTab}`,
    );
    return Promise.resolve();
  },
  removePersistedChatTab: (args: { chatId: string }): Promise<void> => {
    mockTrace.push(`remove ${args.chatId}`);
    return Promise.resolve();
  },
  completePersistedChatTabTurn: (): Promise<void> => Promise.resolve(),
  emitChatDispatchFailure: (): Promise<void> => Promise.resolve(),
  commitProviderChatEvent: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../../lib/worktree-chat-turn', () => ({
  dispatchWorktreeChatTurn: (args: Record<string, unknown>): Promise<void> => {
    mockTrace.push(
      `dispatch ${String(args.worktreeId)} ${String(args.chatId)}`,
    );
    mockDispatches.push(args);
    return Promise.resolve();
  },
}));
jest.mock('../../services/chat-queue-service', () => ({
  runAdmittedDirectDispatch: async (
    _target: unknown,
    _userMessageId: string,
    run: (authorization: unknown) => Promise<boolean>,
  ): Promise<void> => {
    await run(undefined);
  },
}));
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): unknown => ({
    runWithScopeActivity: async <T>(
      _scope: unknown,
      operation: () => Promise<T>,
    ): Promise<T> => operation(),
  }),
}));
jest.mock('../../services/active-chat-input', () => ({
  notifyCanonicalChatStarted: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../../agents/session-manager', () => ({
  hasActiveChatTurnsForWorktree: (
    projectId: string,
    worktreeId: string,
  ): boolean => mockActiveTargets.has(`${projectId}/${worktreeId}`),
  subscribeChatSessionActivity: (listener: () => void): (() => void) => {
    mockActivityListeners.add(listener);
    return (): void => {
      mockActivityListeners.delete(listener);
    };
  },
}));
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFileDetailed: (): Promise<{
    preferences: PreferencesData;
    authority: 'ok';
  }> => Promise.resolve({ preferences: mockPreferences, authority: 'ok' }),
  peekPreferencesLoadError: (): null => null,
  readPreferencesFile: (): Promise<PreferencesData> =>
    Promise.resolve(mockPreferences),
}));
jest.mock('../../lib/approvals-persistence', () => ({
  readWorkspaceApprovals: (): Promise<unknown> =>
    Promise.resolve({ version: 1, rules: [] }),
}));
jest.mock('../../lib/workspace-approvals-manifest', () => ({
  readWorkspaceApprovalsManifest: (): Promise<unknown> =>
    Promise.resolve({ rules: [] }),
}));
jest.mock('../../lib/sidebar-items', () => ({
  readAllSidebarItems: (): Promise<unknown> =>
    Promise.resolve({
      version: 1,
      items: [
        {
          id: 'p',
          name: 'Project',
          repoPath: '/tmp/project',
          color: '#000000',
          worktrees: [],
          collapsed: false,
          order: 0,
          type: 'single-repo',
        },
      ],
    }),
}));
jest.mock('../../lib/configured-prompt-resolution', () => ({
  resolveConfiguredPrompt: (args: { prompt: string }): Promise<unknown> =>
    Promise.resolve({ prompt: args.prompt }),
}));
jest.mock('../../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: (): unknown => ({
    launch: (request: { chatId: string }): Promise<unknown> => {
      mockTrace.push(`terminal ${request.chatId}`);
      return Promise.resolve({});
    },
  }),
}));
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): unknown => ({ isEnabled: (): boolean => true }),
}));
jest.mock('../../observability', () => ({
  getObservabilityService: (): unknown => ({ completeChatTurn: jest.fn() }),
}));

function preferences(): PreferencesData {
  const base = {
    defaultWorktreeProvider: 'codex',
    defaultWorktreeModelByProvider: {
      claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
      codex: { model: 'gpt-5.5', thinkingLevel: 'medium' },
      ollama: null,
    },
    approvalDefaults: { worktree: 'ask', cowork: 'ask', appAdvisor: 'ask' },
    defaultChatInterfaceMode: 'canopy',
    scriptTimeoutMinutes: 5,
  };
  return base as unknown as PreferencesData;
}

let hookChat: typeof HookChatModule;

function launch(
  worktreeId: string,
  prompt: string,
  action: Partial<ChatHookAction> = {},
): Promise<void> {
  return hookChat.launchHookChat({
    projectId: 'p',
    worktreeId,
    action: { type: 'chat', prompt, model: 'gpt-5.5', ...action },
    prompt,
    triggerName: 'pr:checks:fail',
    getWindow: () => null,
  });
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function activityCleared(targets: string[] = []): Promise<void> {
  mockActiveTargets = new Set(targets);
  for (const listener of Array.from(mockActivityListeners)) listener();
  return flush();
}

function queueIdAt(index: number): string {
  const queueId = mockStartedEvents[index]?.queuedMessage?.queueId;
  if (!queueId) throw new Error(`no queued event at ${index}`);
  return queueId;
}

beforeEach(() => {
  jest.resetModules();
  jest.spyOn(Date, 'now').mockReturnValue(1000);
  mockTrace.length = 0;
  mockStartedEvents.length = 0;
  mockDispatches.length = 0;
  mockActivityListeners.clear();
  mockActiveTargets = new Set();
  mockRendererAvailable = true;
  mockPreferences = preferences();
  const types = jest.requireActual<typeof SharedTypes>(
    '@canopy/desktop-shared/types',
  );
  types.initClaudeModels([{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }]);
  types.initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
  hookChat = jest.requireActual<typeof HookChatModule>('../../lib/hook-chat');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('CAN-5062 golden: hook chat start and queue', () => {
  it('starts at once on an idle worktree, in the background', async () => {
    await launch('w-1', 'Fix the checks');
    expect(mockTrace).toEqual([
      'persist w-1 chat-hook-1000-1 activate=false',
      'chat:hook-tab-started w-1 chat-hook-1000-1 started',
      'dispatch w-1 chat-hook-1000-1',
    ]);
    expect(mockDispatches[0]).toMatchObject({
      projectId: 'p',
      worktreeId: 'w-1',
      chatId: 'chat-hook-1000-1',
      userMessageId: 'msg-hook-1000-2',
      text: 'Fix the checks',
      executionContext: 'personal',
      planMode: false,
      model: 'gpt-5.5',
      providerType: 'codex',
      executionHarness: 'codex',
      thinkingLevel: 'medium',
      initiationSource: 'hook',
      skipBranchNaming: true,
    });
  });

  it('queues behind an active chat with a placeholder, and starts when activity clears', async () => {
    mockActiveTargets = new Set(['p/w-1']);
    await launch('w-1', `  ${'x'.repeat(450)}  `);
    expect(mockTrace).toEqual([
      'chat:hook-tab-started w-1 chat-hook-1000-1 queued',
    ]);
    const queued = mockStartedEvents[0];
    expect(queued?.activateTab).toBe(false);
    expect(queued?.tab.messages).toEqual([]);
    expect(queued?.queuedMessage).toEqual({
      queueId: 'queued-hook-1000-3',
      text: `${'x'.repeat(400)}...`,
      reason: 'Waiting for active chat sessions to finish.',
      hookInfo: { triggerName: 'pr:checks:fail', timestamp: 1000 },
    });
    expect(
      hookChat.hasQueuedHookChat({
        projectId: 'p',
        worktreeId: 'w-1',
        chatId: 'chat-hook-1000-1',
      }),
    ).toBe(true);

    await activityCleared(['p/w-1']);
    expect(mockTrace).toHaveLength(1);

    await activityCleared();
    expect(mockTrace.slice(1)).toEqual([
      'persist w-1 chat-hook-1000-1 activate=false',
      'chat:hook-tab-started w-1 chat-hook-1000-1 started',
      'dispatch w-1 chat-hook-1000-1',
    ]);
    expect(
      hookChat.hasQueuedHookChat({
        projectId: 'p',
        worktreeId: 'w-1',
        chatId: 'chat-hook-1000-1',
      }),
    ).toBe(false);
  });

  it('keeps per-worktree order, starts one at a time, and never lets one worktree block another', async () => {
    mockActiveTargets = new Set(['p/w-1']);
    await launch('w-1', 'first');
    await launch('w-1', 'second');
    await launch('w-2', 'other');
    expect(mockTrace).toEqual([
      'chat:hook-tab-started w-1 chat-hook-1000-1 queued',
      'chat:hook-tab-started w-1 chat-hook-1000-4 queued',
      'persist w-2 chat-hook-1000-7 activate=false',
      'chat:hook-tab-started w-2 chat-hook-1000-7 started',
      'dispatch w-2 chat-hook-1000-7',
    ]);

    await activityCleared(['p/w-1']);
    expect(mockTrace).toHaveLength(5);

    await activityCleared();
    expect(mockTrace.slice(5)).toEqual([
      'persist w-1 chat-hook-1000-1 activate=false',
      'chat:hook-tab-started w-1 chat-hook-1000-1 started',
      'dispatch w-1 chat-hook-1000-1',
      'persist w-1 chat-hook-1000-4 activate=false',
      'chat:hook-tab-started w-1 chat-hook-1000-4 started',
      'dispatch w-1 chat-hook-1000-4',
    ]);
  });

  it('queues behind an earlier queued chat on an idle worktree, and drains in order at once', async () => {
    mockActiveTargets = new Set(['p/w-1']);
    await launch('w-1', 'first');
    mockActiveTargets = new Set();
    await launch('w-1', 'second');
    await flush();
    expect(mockTrace).toEqual([
      'chat:hook-tab-started w-1 chat-hook-1000-1 queued',
      'chat:hook-tab-started w-1 chat-hook-1000-4 queued',
      'persist w-1 chat-hook-1000-1 activate=false',
      'chat:hook-tab-started w-1 chat-hook-1000-1 started',
      'dispatch w-1 chat-hook-1000-1',
      'persist w-1 chat-hook-1000-4 activate=false',
      'chat:hook-tab-started w-1 chat-hook-1000-4 started',
      'dispatch w-1 chat-hook-1000-4',
    ]);
  });

  it('bypasses the queue when the hook allows chat concurrency', async () => {
    mockActiveTargets = new Set(['p/w-1']);
    await launch('w-1', 'concurrent', { allowChatConcurrency: true });
    expect(mockTrace).toEqual([
      'persist w-1 chat-hook-1000-1 activate=false',
      'chat:hook-tab-started w-1 chat-hook-1000-1 started',
      'dispatch w-1 chat-hook-1000-1',
    ]);
  });

  it('refuses to queue without a renderer window', async () => {
    mockActiveTargets = new Set(['p/w-1']);
    mockRendererAvailable = false;
    await expect(launch('w-1', 'nobody')).rejects.toThrow(
      'Hook chat requires an active renderer window before it can start.',
    );
  });
});

describe('CAN-5062 golden: queued hook chat edits', () => {
  const target = {
    projectId: 'p',
    worktreeId: 'w-1',
    chatId: 'chat-hook-1000-1',
  };

  it('applies plan, approval, thinking, plugin and model edits to the start', async () => {
    mockActiveTargets = new Set(['p/w-1']);
    await launch('w-1', 'Review');

    hookChat.updateQueuedHookChatPlanMode({ ...target, enabled: true });
    hookChat.updateQueuedHookChatApprovalMode({ ...target, mode: 'auto' });
    hookChat.updateQueuedHookChatThinkingLevel({ ...target, level: 'low' });
    hookChat.updateQueuedHookChatCodexFastMode({ ...target, enabled: true });
    hookChat.updateQueuedHookChatPluginSelections({
      ...target,
      pluginSelections: {
        collectionIds: ['bundle'],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      deferredToolsAllowed: false,
    });
    expect(
      hookChat.updateQueuedHookChatInterfaceMode({
        ...target,
        interfaceMode: 'claude-code',
      }),
    ).toBe(false);

    await activityCleared();
    expect(mockDispatches[0]).toMatchObject({
      planMode: true,
      approvalMode: 'auto',
      thinkingLevel: 'low',
      model: 'gpt-5.5',
      providerType: 'codex',
      modelConfig: {
        thinkingLevel: 'low',
        speed: 'fast',
        fastMode: true,
      },
      pluginSelections: {
        collectionIds: ['bundle'],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      deferredToolsAllowed: false,
    });
  });

  it('switches provider on a model edit, takes that provider default thinking, and honors a Claude interface mode', async () => {
    mockActiveTargets = new Set(['p/w-1']);
    await launch('w-1', 'Review');

    await hookChat.updateQueuedHookChatModel({
      ...target,
      model: 'claude-sonnet-4-6',
    });
    expect(
      hookChat.updateQueuedHookChatInterfaceMode({
        ...target,
        interfaceMode: 'claude-code',
      }),
    ).toBe(true);

    await activityCleared();
    expect(mockTrace.slice(-3)).toEqual([
      'persist w-1 chat-hook-1000-1 activate=false',
      'chat:hook-tab-started w-1 chat-hook-1000-1 started',
      'terminal chat-hook-1000-1',
    ]);
    const started = mockStartedEvents.at(-1)?.tab;
    expect(started).toMatchObject({
      model: 'claude-sonnet-4-6',
      providerType: 'claude',
      executionHarness: 'claude',
      thinkingLevel: 'high',
      interfaceMode: 'claude-code',
    });
    expect(mockDispatches).toEqual([]);
  });

  it('ignores edits for a chat that is not queued', async () => {
    const missing = { ...target, chatId: 'unknown' };
    hookChat.updateQueuedHookChatPlanMode({ ...missing, enabled: true });
    hookChat.updateQueuedHookChatApprovalMode({ ...missing, mode: 'auto' });
    hookChat.updateQueuedHookChatThinkingLevel({ ...missing, level: 'low' });
    expect(
      hookChat.updateQueuedHookChatInterfaceMode({
        ...missing,
        interfaceMode: 'claude-code',
      }),
    ).toBe(false);
    await expect(
      hookChat.updateQueuedHookChatModel({ ...missing, model: 'gpt-5.5' }),
    ).resolves.toBeUndefined();
    expect(mockTrace).toEqual([]);
  });
});

describe('CAN-5062 golden: queued hook chat cancel and force', () => {
  it('cancels a queued chat once, and the next queued chat still drains', async () => {
    mockActiveTargets = new Set(['p/w-1']);
    await launch('w-1', 'first');
    await launch('w-1', 'second');
    const first = queueIdAt(0);

    expect(await hookChat.cancelQueuedHookChat(first)).toEqual({
      cancelled: true,
    });
    expect(await hookChat.cancelQueuedHookChat(first)).toEqual({
      cancelled: false,
    });
    expect(await hookChat.cancelQueuedHookChat('unknown')).toEqual({
      cancelled: false,
    });

    await activityCleared();
    expect(mockTrace.slice(2)).toEqual([
      'persist w-1 chat-hook-1000-4 activate=false',
      'chat:hook-tab-started w-1 chat-hook-1000-4 started',
      'dispatch w-1 chat-hook-1000-4',
    ]);
  });

  it('forces a queued chat past active work, once', async () => {
    mockActiveTargets = new Set(['p/w-1']);
    await launch('w-1', 'urgent');
    const queueId = queueIdAt(0);

    expect(await hookChat.forceQueuedHookChat(queueId)).toEqual({
      forced: true,
    });
    expect(mockTrace.slice(1)).toEqual([
      'persist w-1 chat-hook-1000-1 activate=false',
      'chat:hook-tab-started w-1 chat-hook-1000-1 started',
      'dispatch w-1 chat-hook-1000-1',
    ]);
    expect(await hookChat.forceQueuedHookChat(queueId)).toEqual({
      forced: false,
    });
    expect(await hookChat.cancelQueuedHookChat(queueId)).toEqual({
      cancelled: false,
    });

    await activityCleared();
    expect(mockDispatches).toHaveLength(1);
  });
});
