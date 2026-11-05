import type { BrowserWindow } from 'electron';
import type * as PlaceholderModule from '../../lib/hook-chat-placeholders';
import type {
  HookChatClaimState,
  HookChatClaim,
  HookChatClaimRequest,
} from '@canopy/core-runtime/node/initiated-work';
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
const mockClaimOutcomes: Array<{
  id: string;
  accepted: boolean;
  reason?: string;
}> = [];
const mockRemovedChatIds = new Set<string>();
const mockDeliveredWindows: unknown[] = [];
let mockDispatchError: Error | undefined;
let mockNativeAccepts = true;
let mockAdmissionError: Error | undefined;
const mockClaimStates = new Map<string, HookChatClaimState>();
let mockBeforePrepare: (() => Promise<void>) | undefined;

jest.mock('../../lib/window-send', () => ({
  sendToWindow: (
    _window: unknown,
    channel: string,
    payload: unknown,
  ): boolean => {
    if (!mockRendererAvailable) return false;
    const event = payload as HookChatTabStartedEvent;
    mockStartedEvents.push(event);
    mockDeliveredWindows.push(_window);
    mockTrace.push(
      `${channel} ${event.worktreeId} ${event.chatId} ${event.queuedMessage ? 'queued' : 'started'}`,
    );
    return true;
  },
}));
jest.mock('../../lib/chat-tab-dispatch-utils', () => ({
  removePersistedChatTab: (args: { chatId: string }): Promise<void> => {
    mockTrace.push(`remove ${args.chatId}`);
    return Promise.resolve();
  },
  completePersistedChatTabTurn: (): Promise<void> => Promise.resolve(),
  emitChatDispatchFailure: (): Promise<void> => Promise.resolve(),
  commitProviderChatEvent: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../../lib/worktree-chat-turn', () => ({
  dispatchWorktreeChatTurn: (
    args: Record<string, unknown> & { onTurnAccepted?: () => void },
  ): Promise<void> => {
    mockTrace.push(
      `dispatch ${String(args.worktreeId)} ${String(args.chatId)}`,
    );
    mockDispatches.push(args);
    if (mockDispatchError) return Promise.reject(mockDispatchError);
    if (mockNativeAccepts) args.onTurnAccepted?.();
    return Promise.resolve();
  },
}));
jest.mock('../../services/chat-queue-service', () => ({
  runAdmittedDirectDispatch: async (
    _target: unknown,
    _userMessageId: string,
    run: (authorization: unknown) => Promise<boolean>,
  ): Promise<void> => {
    if (mockAdmissionError) {
      const error = mockAdmissionError;
      mockAdmissionError = undefined;
      throw error;
    }
    await run(undefined);
  },
}));
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): unknown => ({
    createHookChat: (
      scope: { worktreeId: string },
      tab: { id: string },
    ): Promise<string> => {
      if (mockRemovedChatIds.has(tab.id)) return Promise.resolve('removed');
      mockTrace.push(`persist ${scope.worktreeId} ${tab.id} activate=false`);
      return Promise.resolve('created');
    },
    runWithScopeActivity: async <T>(
      _scope: unknown,
      operation: () => Promise<T>,
    ): Promise<T> => operation(),
  }),
}));
const mockClaims = {
  lookup: ({ chatId }: HookChatClaimRequest): Promise<HookChatClaim | null> =>
    Promise.resolve(
      mockClaimStates.has(chatId)
        ? {
            status: 'already_claimed',
            claimOperationId: `claim-${chatId}`,
            state: mockClaimStates.get(chatId) ?? 'pending',
          }
        : null,
    ),
  claim: ({ chatId }: HookChatClaimRequest): Promise<HookChatClaim> => {
    const state = mockClaimStates.get(chatId);
    if (state)
      return Promise.resolve({
        status: 'already_claimed',
        claimOperationId: `claim-${chatId}`,
        state,
      });
    mockClaimStates.set(chatId, 'pending');
    return Promise.resolve({
      status: 'claimed',
      claimOperationId: `claim-${chatId}`,
    });
  },
  recordAccepted: (id: string): Promise<void> => {
    mockClaimStates.set(id.slice(6), 'accepted');
    mockClaimOutcomes.push({ id, accepted: true });
    return Promise.resolve();
  },
  recordNotAccepted: (
    id: string,
    _ids: unknown,
    reason: string,
  ): Promise<void> => {
    void _ids;
    mockClaimStates.set(id.slice(6), 'not_accepted');
    mockClaimOutcomes.push({ id, accepted: false, reason });
    return Promise.resolve();
  },
  recordFailed: (id: string): Promise<void> => {
    mockClaimStates.set(id.slice(6), 'not_accepted');
    mockClaimOutcomes.push({ id, accepted: false, reason: 'failed' });
    return Promise.resolve();
  },
};
jest.mock('../../lib/hook-initiated-work', () => ({
  getHookChatClaims: (): unknown => mockClaims,
}));
let mockOperationSequence = 0;
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
  readPreferencesFileDetailed: async (): Promise<{
    preferences: PreferencesData;
    authority: 'ok';
  }> => {
    await mockBeforePrepare?.();
    return { preferences: mockPreferences, authority: 'ok' };
  },
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
): Promise<HookChatModule.HookChatLaunchResult> {
  return hookChat.launchHookChat({
    identity: {
      operationId: `op-${(mockOperationSequence += 1)}`,
      actionIndex: 0,
    },
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
  mockOperationSequence = 0;
  mockClaimStates.clear();
  mockClaimOutcomes.length = 0;
  mockRemovedChatIds.clear();
  mockDeliveredWindows.length = 0;
  mockDispatchError = undefined;
  mockNativeAccepts = true;
  mockAdmissionError = undefined;
  mockBeforePrepare = undefined;
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
  const sameIdentity = (): Promise<HookChatModule.HookChatLaunchResult> =>
    hookChat.launchHookChat({
      identity: { operationId: 'op-retry', actionIndex: 0 },
      projectId: 'p',
      worktreeId: 'w-1',
      action: { type: 'chat', prompt: 'Review', model: 'gpt-5.5' },
      prompt: 'Review',
      triggerName: 'pr:checks:fail',
      getWindow: (): null => null,
    });
  it('queues one identity once when concurrent preparation overlaps and cancellation removes it', async () => {
    mockActiveTargets = new Set(['p/w-1']);
    let release: (() => void) | undefined;
    const preparing = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockBeforePrepare = (): Promise<void> => preparing;
    const first = sameIdentity();
    const second = sameIdentity();
    await flush();
    release?.();
    const [one, two] = await Promise.all([first, second]);
    expect(one).toEqual({
      status: 'queued',
      chatId: 'chat-hook-op-retry-0',
      queueId: 'queued-hook-op-retry-0',
    });
    expect(two).toEqual(one);
    expect(mockStartedEvents).toHaveLength(1);
    expect(
      await hookChat.cancelQueuedHookChat('queued-hook-op-retry-0'),
    ).toEqual({ cancelled: true });
    expect(
      hookChat.hasQueuedHookChat({
        projectId: 'p',
        worktreeId: 'w-1',
        chatId: 'chat-hook-op-retry-0',
      }),
    ).toBe(false);
    await activityCleared();
    expect(mockDispatches).toHaveLength(0);
  });
  it('returns removed when a cancelled queued identity is retried', async () => {
    mockActiveTargets = new Set(['p/w-1']);
    const queued = await sameIdentity();
    expect(queued).toEqual({
      status: 'queued',
      chatId: 'chat-hook-op-retry-0',
      queueId: 'queued-hook-op-retry-0',
    });
    expect(
      await hookChat.cancelQueuedHookChat('queued-hook-op-retry-0'),
    ).toEqual({ cancelled: true });
    expect(await sameIdentity()).toEqual({
      status: 'removed',
      chatId: 'chat-hook-op-retry-0',
    });
    expect(mockStartedEvents).toHaveLength(1);
    expect(
      hookChat.hasQueuedHookChat({
        projectId: 'p',
        worktreeId: 'w-1',
        chatId: 'chat-hook-op-retry-0',
      }),
    ).toBe(false);
    await activityCleared();
    expect(mockDispatches).toHaveLength(0);
    expect(mockTrace.some((entry) => entry.startsWith('persist '))).toBe(false);
    expect(mockClaimStates.size).toBe(0);
  });

  it('returns an existing durable claim without queueing a placeholder on a busy worktree', async () => {
    expect(await sameIdentity()).toMatchObject({ status: 'started' });
    mockActiveTargets = new Set(['p/w-1']);
    const events = mockStartedEvents.length;
    expect(await sameIdentity()).toEqual({
      status: 'already_started',
      chatId: 'chat-hook-op-retry-0',
    });
    expect(mockStartedEvents).toHaveLength(events);
    expect(
      hookChat.hasQueuedHookChat({
        projectId: 'p',
        worktreeId: 'w-1',
        chatId: 'chat-hook-op-retry-0',
      }),
    ).toBe(false);
    await activityCleared();
    expect(mockDispatches).toHaveLength(1);
  });

  it('starts one turn and records acceptance for repeated launches of one action', async () => {
    await sameIdentity();
    expect(await sameIdentity()).toEqual({
      status: 'already_started',
      chatId: 'chat-hook-op-retry-0',
    });
    expect(mockDispatches).toHaveLength(1);
    expect(
      mockTrace.filter((entry) => entry.startsWith('persist ')),
    ).toHaveLength(1);
    expect(mockClaimOutcomes).toEqual([
      { id: 'claim-chat-hook-op-retry-0', accepted: true },
    ]);
  });
  it('records a native turn that returned without acceptance and never starts it twice', async () => {
    mockNativeAccepts = false;
    await sameIdentity();
    expect(mockClaimOutcomes).toEqual([
      { id: 'claim-chat-hook-op-retry-0', accepted: false, reason: 'returned' },
    ]);
    expect(await sameIdentity()).toMatchObject({ status: 'already_started' });
    expect(mockDispatches).toHaveLength(1);
  });
  it('keeps a failed start claimed instead of dispatching another turn on retry', async () => {
    mockDispatchError = new Error('provider down');
    await expect(sameIdentity()).rejects.toThrow('provider down');
    expect(mockClaimOutcomes).toEqual([
      { id: 'claim-chat-hook-op-retry-0', accepted: false, reason: 'failed' },
    ]);
    expect(await sameIdentity()).toMatchObject({ status: 'already_started' });
    expect(mockDispatches).toHaveLength(1);
  });
  it('records terminal acceptance and never relaunches a claimed terminal chat', async () => {
    mockPreferences.defaultChatInterfaceMode = 'claude-code';
    await launch('w-1', 'Review', { model: 'claude-sonnet-4-6' });
    mockOperationSequence = 0;
    expect(
      await launch('w-1', 'Review', { model: 'claude-sonnet-4-6' }),
    ).toMatchObject({ status: 'already_started' });
    expect(
      mockTrace.filter((entry) => entry.startsWith('terminal ')),
    ).toHaveLength(1);
    expect(mockClaimOutcomes).toEqual([
      { id: 'claim-chat-hook-op-1-0', accepted: true },
    ]);
  });
  it('does not recreate a removed chat and records its removed outcome', async () => {
    mockRemovedChatIds.add('chat-hook-op-retry-0');
    expect(await sameIdentity()).toMatchObject({ status: 'removed' });
    expect(mockDispatches).toHaveLength(0);
    expect(
      mockTrace.filter((entry) => entry.startsWith('persist ')),
    ).toHaveLength(0);
    expect(mockClaimOutcomes).toEqual([
      { id: 'claim-chat-hook-op-retry-0', accepted: false, reason: 'removed' },
    ]);
  });
  it('takes no claim before ordinary admission succeeds', async () => {
    mockAdmissionError = new Error('Another turn owns this chat.');
    await expect(sameIdentity()).rejects.toThrow(
      'Another turn owns this chat.',
    );
    expect(mockClaimStates.size).toBe(0);
    expect(await sameIdentity()).toMatchObject({ status: 'started' });
  });
  it('replays queued placeholders in order to a window that comes up', async () => {
    mockActiveTargets = new Set(['p/w-1']);
    mockRendererAvailable = false;
    await launch('w-1', 'first');
    await launch('w-1', 'second');
    const window = {} as BrowserWindow;
    mockRendererAvailable = true;
    jest
      .requireActual<
        typeof PlaceholderModule
      >('../../lib/hook-chat-placeholders')
      .replayHookChatPlaceholders(window);
    expect(
      mockStartedEvents.map((event) => event.queuedMessage?.queueId),
    ).toEqual(['queued-hook-op-1-0', 'queued-hook-op-2-0']);
    expect(
      mockStartedEvents.every((event) => event.activateTab === false),
    ).toBe(true);
    expect(mockDeliveredWindows).toEqual([window, window]);
  });

  it('starts at once on an idle worktree, in the background', async () => {
    await launch('w-1', 'Fix the checks');
    expect(mockTrace).toEqual([
      'persist w-1 chat-hook-op-1-0 activate=false',
      'chat:hook-tab-started w-1 chat-hook-op-1-0 started',
      'dispatch w-1 chat-hook-op-1-0',
    ]);
    expect(mockDispatches[0]).toMatchObject({
      projectId: 'p',
      worktreeId: 'w-1',
      chatId: 'chat-hook-op-1-0',
      userMessageId: 'msg-hook-op-1-0',
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
      'chat:hook-tab-started w-1 chat-hook-op-1-0 queued',
    ]);
    const queued = mockStartedEvents[0];
    expect(queued?.activateTab).toBe(false);
    expect(queued?.tab.messages).toEqual([]);
    expect(queued?.queuedMessage).toEqual({
      queueId: 'queued-hook-op-1-0',
      text: `${'x'.repeat(400)}...`,
      reason: 'Waiting for active chat sessions to finish.',
      hookInfo: { triggerName: 'pr:checks:fail', timestamp: 1000 },
    });
    expect(
      hookChat.hasQueuedHookChat({
        projectId: 'p',
        worktreeId: 'w-1',
        chatId: 'chat-hook-op-1-0',
      }),
    ).toBe(true);

    await activityCleared(['p/w-1']);
    expect(mockTrace).toHaveLength(1);

    await activityCleared();
    expect(mockTrace.slice(1)).toEqual([
      'persist w-1 chat-hook-op-1-0 activate=false',
      'chat:hook-tab-started w-1 chat-hook-op-1-0 started',
      'dispatch w-1 chat-hook-op-1-0',
    ]);
    expect(
      hookChat.hasQueuedHookChat({
        projectId: 'p',
        worktreeId: 'w-1',
        chatId: 'chat-hook-op-1-0',
      }),
    ).toBe(false);
  });

  it('keeps per-worktree order, starts one at a time, and never lets one worktree block another', async () => {
    mockActiveTargets = new Set(['p/w-1']);
    await launch('w-1', 'first');
    await launch('w-1', 'second');
    await launch('w-2', 'other');
    expect(mockTrace).toEqual([
      'chat:hook-tab-started w-1 chat-hook-op-1-0 queued',
      'chat:hook-tab-started w-1 chat-hook-op-2-0 queued',
      'persist w-2 chat-hook-op-3-0 activate=false',
      'chat:hook-tab-started w-2 chat-hook-op-3-0 started',
      'dispatch w-2 chat-hook-op-3-0',
    ]);

    await activityCleared(['p/w-1']);
    expect(mockTrace).toHaveLength(5);

    await activityCleared();
    expect(mockTrace.slice(5)).toEqual([
      'persist w-1 chat-hook-op-1-0 activate=false',
      'chat:hook-tab-started w-1 chat-hook-op-1-0 started',
      'dispatch w-1 chat-hook-op-1-0',
      'persist w-1 chat-hook-op-2-0 activate=false',
      'chat:hook-tab-started w-1 chat-hook-op-2-0 started',
      'dispatch w-1 chat-hook-op-2-0',
    ]);
  });

  it('queues behind an earlier queued chat on an idle worktree, and drains in order at once', async () => {
    mockActiveTargets = new Set(['p/w-1']);
    await launch('w-1', 'first');
    mockActiveTargets = new Set();
    await launch('w-1', 'second');
    await flush();
    expect(mockTrace).toEqual([
      'chat:hook-tab-started w-1 chat-hook-op-1-0 queued',
      'chat:hook-tab-started w-1 chat-hook-op-2-0 queued',
      'persist w-1 chat-hook-op-1-0 activate=false',
      'chat:hook-tab-started w-1 chat-hook-op-1-0 started',
      'dispatch w-1 chat-hook-op-1-0',
      'persist w-1 chat-hook-op-2-0 activate=false',
      'chat:hook-tab-started w-1 chat-hook-op-2-0 started',
      'dispatch w-1 chat-hook-op-2-0',
    ]);
  });

  it('bypasses the queue when the hook allows chat concurrency', async () => {
    mockActiveTargets = new Set(['p/w-1']);
    await launch('w-1', 'concurrent', { allowChatConcurrency: true });
    expect(mockTrace).toEqual([
      'persist w-1 chat-hook-op-1-0 activate=false',
      'chat:hook-tab-started w-1 chat-hook-op-1-0 started',
      'dispatch w-1 chat-hook-op-1-0',
    ]);
  });

  it('queues without a renderer window and starts once activity clears', async () => {
    mockActiveTargets = new Set(['p/w-1']);
    mockRendererAvailable = false;
    await expect(launch('w-1', 'nobody')).resolves.toMatchObject({
      status: 'queued',
    });
    expect(mockTrace).toEqual([]);
    await activityCleared();
    expect(mockTrace).toEqual([
      'persist w-1 chat-hook-op-1-0 activate=false',
      'dispatch w-1 chat-hook-op-1-0',
    ]);
  });
  it('starts at once on an idle worktree without a renderer window', async () => {
    mockRendererAvailable = false;
    await launch('w-1', 'nobody');
    expect(mockTrace).toEqual([
      'persist w-1 chat-hook-op-1-0 activate=false',
      'dispatch w-1 chat-hook-op-1-0',
    ]);
  });
});

describe('CAN-5062 golden: queued hook chat edits', () => {
  const target = {
    projectId: 'p',
    worktreeId: 'w-1',
    chatId: 'chat-hook-op-1-0',
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
      'persist w-1 chat-hook-op-1-0 activate=false',
      'chat:hook-tab-started w-1 chat-hook-op-1-0 started',
      'terminal chat-hook-op-1-0',
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
      'persist w-1 chat-hook-op-2-0 activate=false',
      'chat:hook-tab-started w-1 chat-hook-op-2-0 started',
      'dispatch w-1 chat-hook-op-2-0',
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
      'persist w-1 chat-hook-op-1-0 activate=false',
      'chat:hook-tab-started w-1 chat-hook-op-1-0 started',
      'dispatch w-1 chat-hook-op-1-0',
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
