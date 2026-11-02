/**
 * The real session registry and the real Copilot session, with the turn
 * driver and I/O mocked (CAN-4833). A registration that displaces a live
 * session destroys it without waiting; its aborted turn ends later, after the
 * successor started its own turn under the same key. That late terminal path
 * must not idle the successor, drop its wake lock or remove its tool routes.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCopilotTurn } from '@canopy/desktop-shared/node/copilot/turn-driver';

jest.mock('electron', () => ({
  BrowserWindow: class MockBrowserWindow {
    public isDestroyed(): boolean {
      return false;
    }
  },
}));
jest.mock('../lib/chat-tabs-reader', () => ({
  readChatTabsFile: jest.fn(() =>
    Promise.resolve({ version: 1, tabs: [], activeTabId: null }),
  ),
}));
jest.mock('../agents/delegation/gate', () => ({
  managedDelegationEnabled: jest.fn(() => false),
}));
const mockWorkspace = { directory: '' };
const mockProxy = {
  getMcpCapabilityDigests: jest.fn(() => ({})),
  getCanopyCapabilityDefinitions: jest.fn(() => []),
  registerCanopyWorktreeSessionRoute: jest.fn(() => Promise.resolve('route')),
  getCanopyWorktreeMcpUrl: jest.fn(() => 'http://localhost:1234/main'),
  getCanopyWorktreeUiMcpUrl: jest.fn(() => 'http://localhost:1234/ui'),
  setSessionToolCallGate: jest.fn(),
  unregisterRoutesForSession: jest.fn(),
  unregisterCanopyWorktreeSessionRoute: jest.fn(),
};
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: (): typeof mockProxy => mockProxy,
}));
jest.mock('../copilot/connection', () => ({
  assertCopilotModelAvailable: jest.fn((model: string) =>
    Promise.resolve({ id: model, supportedThinkingLevels: [] }),
  ),
  openManagedCopilotRuntime: jest.fn(() =>
    Promise.resolve({
      account: { login: 'test-account' },
      generation: 1,
      close: jest.fn(),
      auth: {
        token: (): Promise<string> => Promise.resolve('ghu_test'),
        tokenProvider: jest.fn(),
      },
      // The handle runs the turn; the turn driver itself is mocked below.
      runTurn: (request: unknown): Promise<unknown> =>
        jest
          .requireMock<{
            runCopilotTurn: (request: unknown) => Promise<unknown>;
          }>('@canopy/desktop-shared/node/copilot/turn-driver')
          .runCopilotTurn(request),
    }),
  ),
  assertCopilotConnectionGeneration: jest.fn(),
  listCopilotModels: jest.fn(),
}));
jest.mock('@canopy/desktop-shared/node/copilot/turn-driver', () => ({
  runCopilotTurn: jest.fn(),
}));
jest.mock('../approvals/approval-service', () => ({
  createApprovalSession: jest.fn(() => ({
    dispose: jest.fn(),
    invalidatePending: jest.fn(),
  })),
}));
jest.mock('../copilot/tool-approval', () => ({
  authorizeCopilotNativeTool: jest.fn(),
}));
jest.mock('../cursor/tool-approval', () => ({
  authorizeCursorMcpTool: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getWorktreeDataDir: (): string => mockWorkspace.directory,
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeTargetIds: jest.fn(),
}));
jest.mock('../lib/workspace-registry', () => ({
  isCoworkWorkspace: (): boolean => false,
}));
jest.mock('../memory/local/policy', () => ({
  resolveLocalMemoryPolicy: (): Promise<{ kind: 'disabled' }> =>
    Promise.resolve({ kind: 'disabled' }),
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({ localMemoryEnabled: false }),
  ),
}));
jest.mock('@canopy/desktop-shared/node/cursor/inherited-capabilities', () => ({
  discoverInheritedCursorCapabilities: jest.fn(() =>
    Promise.resolve({ skills: [], commands: [], skipped: [], fingerprint: '' }),
  ),
  emptyInheritedCursorCapabilities: (): unknown => ({
    skills: [],
    commands: [],
    skipped: [],
    fingerprint: '',
  }),
}));
jest.mock('../cursor/inherited-roots', () => ({
  resolveInheritedCursorRoots: (): unknown => ({
    userHome: '/home/user',
    claudeConfigDir: '/home/user/.claude',
    codexHome: '/home/user/.codex',
  }),
}));
jest.mock('../plugins/claude-enabled-plugins', () => ({
  readClaudeDisabledInstalledPlugins: (): string[] => [],
  readClaudeEnabledPlugins: (): null => null,
}));
jest.mock('../plugins/inherited-cursor-plugins', () => ({
  inheritedClaudePluginRefs: (): unknown[] => [],
}));
jest.mock('../plugins/plugin-service', () => ({
  loadMarketplacesCacheOnly: jest.fn(() =>
    Promise.resolve({ success: true, data: { marketplaces: [] } }),
  ),
}));
jest.mock('../plugins/invocable-inventory-service', () => ({
  refreshInvocableInventoryAfterMutation: jest.fn(),
}));
jest.mock('../plugins/request-chat-tombstones', () => ({
  requestChatTombstones: (apply: unknown): unknown => apply,
}));
jest.mock('../plugins/global-plugin-overlay', () => ({
  resolveEffectiveChatPluginContext: jest.fn(() =>
    Promise.resolve({
      selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    }),
  ),
}));
jest.mock('../plugins/plugin-resolver', () => ({
  resolvePlugins: jest.fn(() =>
    Promise.resolve({
      mcpServers: {},
      cursorCapabilities: { skills: [], commands: [] },
    }),
  ),
}));
jest.mock('../plugins/plugin-cleanup', () => ({
  cleanupChatSkillPluginDir: jest.fn(),
  cleanupWorktreeChatPluginDirs: jest.fn(),
}));
jest.mock('@canopy/desktop-shared/node/cursor/capability-root', () => ({
  materializeSelectedCapabilityRoot: jest.fn(() =>
    Promise.resolve({ warnings: [], commandIds: [], skillIds: [] }),
  ),
}));
jest.mock('../pipelines/config-paths', () => ({ getEnhancedEnv: jest.fn() }));
jest.mock('../canopy-tools/session-runtime', () => ({
  requestAnswersFromRenderer: jest.fn(),
}));
jest.mock('../mcp/pending-requests', () => ({
  rejectAllForSession: jest.fn(),
}));
jest.mock('../lib/bg-output-poller', () => ({
  stopAllOutputPolling: jest.fn(),
  flushAndStopOutputPollingForSession: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../lib/session-ended-background-tasks', () => ({
  emitSessionEndedBackgroundTaskNotification: jest.fn(),
}));
jest.mock('../observability', () => ({
  getObservabilityService: (): unknown => ({
    recordSessionDiagnostic: jest.fn(),
    interruptMatchingEntries: jest.fn(),
    setChatTurnAccountProxyRouted: jest.fn(),
  }),
}));
// Stop-time sign-in recovery imports these lazily; under Jest that loads the
// whole queue and provider graph synchronously, for seconds, mid-test.
jest.mock('../services/chat-queue-service', () => ({
  getChatQueueService: (): unknown => ({
    releaseAuthenticationPause: jest.fn(),
    releaseAuthenticationPauseForStop: jest.fn(),
  }),
}));
jest.mock('../lib/usage-limited-chats-registry', () => ({
  clearAuthenticationInterruptedChat: jest.fn(),
  recordInterruptedChats: jest.fn(),
}));
const mockWakeLock = { acquire: jest.fn(), release: jest.fn() };
jest.mock('../power/wake-lock-service', () => ({
  getWakeLockService: (): typeof mockWakeLock => mockWakeLock,
}));

import { CopilotProvider } from '../agents/copilot-session';
import {
  buildSessionKey,
  cancelActiveChatTurn,
  destroySession,
  getActiveSessionInfos,
  getSession,
} from '../agents/session-manager';

function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

// Turn preparation does real file I/O, so wait on events, not a tick count.
const WAIT_MS = 15_000;
jest.setTimeout(4 * WAIT_MS);

async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${what}`)),
          WAIT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isTerminal(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) return false;
  const type: unknown = Reflect.get(event, 'type');
  return type === 'result' || type === 'error';
}

describe('a displaced session ending after its successor started a turn (CAN-4833)', () => {
  beforeEach(async () => {
    mockWorkspace.directory = await mkdtemp(
      join(tmpdir(), 'displaced-session-successor-'),
    );
  });

  afterEach(async () => {
    await rm(mockWorkspace.directory, { recursive: true, force: true });
  });

  it('leaves the successor turn, wake lock and routes in place', async () => {
    const scope = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      cwd: mockWorkspace.directory,
      model: 'copilot:model' as const,
    };
    const key = buildSessionKey('project', 'worktree', 'chat');
    const displacedTurnStarted = gate();
    const displacedTurnEnds = gate();
    const successorTurnStarted = gate();
    const displacedTerminal = gate();
    jest
      .mocked(runCopilotTurn)
      // The displaced turn notices its abort only once the test lets it.
      .mockImplementationOnce(async () => {
        displacedTurnStarted.open();
        await displacedTurnEnds.wait;
        throw new Error('Turn aborted');
      })
      .mockImplementationOnce(
        (config) =>
          new Promise((_resolve, reject) => {
            config.signal?.addEventListener('abort', () =>
              reject(new Error('Turn aborted')),
            );
            successorTurnStarted.open();
          }),
      );

    const provider = new CopilotProvider();
    const displacedEvents = jest.fn((event: unknown) => {
      if (isTerminal(event)) displacedTerminal.open();
    });
    const displaced = provider.createSession(
      scope,
      displacedEvents,
      () => null,
    );
    const displacedDestroyed = gate();
    const destroy = displaced.destroy.bind(displaced);
    const destroyDisplaced = jest
      .spyOn(displaced, 'destroy')
      .mockImplementation(() => destroy().finally(displacedDestroyed.open));
    displaced.sendMessage('First', { userMessageId: 'first' });
    await within(displacedTurnStarted.wait, 'the displaced turn to start');

    // A concurrent creation registers under the same key and displaces it.
    const successor = provider.createSession(scope, jest.fn(), () => null);
    expect(displaced.isDisposed?.()).toBe(true);
    expect(destroyDisplaced).toHaveBeenCalledTimes(1);
    successor.sendMessage('Second', { userMessageId: 'second' });
    await within(successorTurnStarted.wait, 'the successor turn to start');
    expect(mockWakeLock.acquire).toHaveBeenLastCalledWith(
      `chat:${key}`,
      'agent chat turn',
    );
    mockWakeLock.release.mockClear();
    mockProxy.unregisterRoutesForSession.mockClear();
    mockProxy.unregisterCanopyWorktreeSessionRoute.mockClear();

    displacedTurnEnds.open();
    await within(displacedTerminal.wait, 'the displaced terminal event');
    await within(displacedDestroyed.wait, 'the displaced session to end');
    // The registry's removal step chains onto destroy(); let it run too.
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      displacedEvents.mock.calls.some(([event]) => isTerminal(event)),
    ).toBe(true);

    expect(getSession('project', 'worktree', 'chat')).toBe(successor);
    expect(getActiveSessionInfos('project', 'worktree')).toEqual([
      expect.objectContaining({ chatId: 'chat', turnActive: true }),
    ]);
    expect(mockWakeLock.release).not.toHaveBeenCalled();
    expect(mockProxy.unregisterRoutesForSession).not.toHaveBeenCalled();
    expect(
      mockProxy.unregisterCanopyWorktreeSessionRoute,
    ).not.toHaveBeenCalled();
    // Exact-turn cancellation still finds the successor's turn.
    expect(cancelActiveChatTurn(key, 'second')).toBe(true);

    await destroySession('project', 'worktree', 'chat');
  });
});
