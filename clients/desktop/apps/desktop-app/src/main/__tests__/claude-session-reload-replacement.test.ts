/**
 * The real session registry and the real Claude session, with only the SDK,
 * the process host and I/O mocked: a deferred-tools reload of an active Claude
 * turn (CAN-4833). The interrupted session's query loop ends only once its CLI
 * exits, after the SDK's close grace. When another teardown had already
 * detached its entry, the reload's own `destroySession` returned at once and
 * the resumed session registered first; the late cleanup then unregistered
 * the resumed session, which lost its turn and orphaned its CLI.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import type * as AiCreditsRoutingModule from '../agents/ai-credits-routing';
import type * as WorkOwnerModule from '../agents/work-owner';
import type * as LedgerToolsRuntimeModule from '../canopy-tools/ledger-tools-runtime';
import type * as PreferencesStoreModule from '../lib/preferences-store';

type MockQuery = (params: Parameters<typeof claudeQuery>[0]) => unknown;

const mockQuery: jest.MockedFunction<MockQuery> = jest.fn();
const mockSpawnClaudeCodeProcessOffMain = jest.fn();

jest.mock('electron', () => ({
  BrowserWindow: class MockBrowserWindow {
    public isDestroyed(): boolean {
      return false;
    }
  },
}));
// Wrappers: SWC hoists jest.mock above the mocks' declarations.
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: Parameters<typeof claudeQuery>[0]): unknown =>
    mockQuery(params),
}));
jest.mock('../agents/claude-process-host-runner', () => ({
  spawnClaudeCodeProcessOffMain: (...args: unknown[]): unknown =>
    mockSpawnClaudeCodeProcessOffMain(...args),
  withholdClaudeProcessStdoutCreditUntil: jest.fn(),
}));
jest.mock('../agents/delegation/gate', () => ({
  managedDelegationEnabled: jest.fn(() => false),
}));
jest.mock('../account-proxy/switch-events', () => ({
  watchAccountProxySwitches: jest.fn(() => jest.fn()),
}));
jest.mock('../account-proxy/routing', () => ({
  resolveAccountProxySessionRoute: jest.fn(() => Promise.resolve(null)),
  previewAccountProxySessionRoute: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('../lib/preferences-store', () => {
  const actual = jest.requireActual<typeof PreferencesStoreModule>(
    '../lib/preferences-store',
  );
  return {
    ...actual,
    readLocalMemoryEnabledPreference: jest.fn(() => Promise.resolve(false)),
    readLatestPreferencesFile: jest.fn(() =>
      Promise.resolve(actual.DEFAULT_PREFERENCES),
    ),
  };
});
jest.mock('../pipelines/config-paths', () => ({
  getBundledClaudeBinaryPath: jest.fn(() => '/mock/claude'),
  getBundledRtkBinaryPath: jest.fn(() => '/mock/rtk'),
  getBundledRgBinaryPath: jest.fn(() => '/mock/rg'),
  getEnhancedEnv: jest.fn(() => ({ ...process.env })),
  getRtkManagedEnv: jest.fn(() => ({})),
}));
jest.mock('../plugins/plugin-resolver', () => ({
  cleanupWorktreeChatPluginDirs: jest.fn(),
  resolvePlugins: jest.fn().mockResolvedValue({
    sdkPlugins: [],
    skillPluginDir: null,
    selectedCapabilityRoots: [],
    codexProcessEnv: {},
    codexMcpServers: {},
    mcpServers: {},
    warnings: [],
  }),
}));
jest.mock('../plugins/plugin-cleanup', () => ({
  cleanupChatSkillPluginDir: jest.fn(),
  cleanupWorktreeChatPluginDirs: jest.fn(),
}));
jest.mock('../plugins/invocable-inventory-service', () => ({
  loadCachedInventory: jest.fn(() => Promise.resolve(null)),
}));
jest.mock('../plugins/global-plugin-overlay', () => ({
  resolveEffectiveChatPluginContext: jest.fn(() =>
    Promise.resolve({
      selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    }),
  ),
}));
const mockUnregisterRoutesForSession = jest.fn();
const mockUnregisterCanopyWorktreeSessionRoute = jest.fn();
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: jest.fn(() => ({
    registerCanopyWorktreeSessionRoute: jest.fn(() =>
      Promise.resolve('session-route'),
    ),
    unregisterCanopyWorktreeSessionRoute:
      mockUnregisterCanopyWorktreeSessionRoute,
    unregisterRoutesForSession: mockUnregisterRoutesForSession,
    getCanopyWorktreeMcpUrl: jest.fn(
      (sessionKey: string) => `http://127.0.0.1:4567/mcp/${sessionKey}`,
    ),
    getCanopyWorktreeUiMcpUrl: jest.fn(
      (sessionKey: string) => `http://127.0.0.1:4567/mcp/${sessionKey}/ui`,
    ),
  })),
}));
jest.mock('../agents/codex-gateway-proxy-service', () => ({
  getCodexGatewayProxyService: jest.fn(() => ({
    registerRoute: jest.fn(),
    unregisterRoutesForSession: jest.fn(),
  })),
}));
jest.mock('../mcp/script-output', () => ({
  loadScriptOutputSnapshot: jest.fn(),
}));
jest.mock('../mcp/pending-requests', () => ({
  rejectAllForSession: jest.fn(),
  createPendingRequest: jest.fn(() => new Promise(() => {})),
  resolveRequest: jest.fn(),
  rejectRequest: jest.fn(),
}));
jest.mock('@canopy/desktop-shared/node/code-graph/service', () => ({
  getCodeGraphWorktreeService: (): { hasGraph: jest.Mock } => ({
    hasGraph: jest.fn(() => false),
  }),
}));
jest.mock('../mcp/plan-pending-requests', () => ({
  createPendingPlanExit: jest.fn(),
  rejectAllPlanExitsForSession: jest.fn(),
}));
jest.mock('../services/attention-tracker', () => ({
  getAttentionTracker: (): { mark: jest.Mock; clear: jest.Mock } => ({
    mark: jest.fn(),
    clear: jest.fn(),
  }),
}));
jest.mock('../lib/usage-limited-chats-registry', () => ({
  recordUsageLimitedChat: jest.fn(() => Promise.resolve()),
}));
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): { commitPlanExit: jest.Mock } => ({
    commitPlanExit: jest.fn(() => Promise.resolve()),
  }),
}));
jest.mock('../lib/resolve-workspace-display-name', () => ({
  resolveWorkspaceRecordingSnapshot: jest.fn().mockResolvedValue({
    name: 'Workspace',
    type: 'single-repo',
  }),
}));
jest.mock('../auth/provider-auth-state', () => ({
  isProviderNativelyAuthenticated: jest.fn().mockResolvedValue(true),
  isProviderNativelyAuthenticatedForRouting: jest.fn().mockResolvedValue(true),
  ensureProviderAuthBaselineForSession: jest.fn().mockResolvedValue(true),
  peekProviderNativeAuthAvailability: jest.fn(() => ({})),
}));
jest.mock('../agents/ai-credits-routing', () => ({
  ...jest.requireActual<typeof AiCreditsRoutingModule>(
    '../agents/ai-credits-routing',
  ),
  getAiCreditsRoutingContext: jest.fn(),
  resolveAiCreditsAttribution: jest.fn().mockResolvedValue({}),
  resolveSessionAiCreditsAttribution: jest.fn().mockResolvedValue({}),
  resolveOrgGatewayCredential: jest.fn(),
  markOrgGatewayCredentialRejected: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/plan-persistence', () => ({
  createTrackedPlan: jest.fn(),
  updateTrackedPlan: jest.fn(),
}));
jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
  sendToWindowDetailed: jest.fn(() => ({
    delivered: false,
    reason: 'no_window',
  })),
}));
jest.mock('../approvals/approval-service', () => ({
  createApprovalSession: jest.fn(() => ({
    check: jest.fn(),
    setMode: jest.fn(),
    invalidatePending: jest.fn(),
    dispose: jest.fn(),
  })),
}));
jest.mock('../canopy-tools/ledger-tools-runtime', () => ({
  ...jest.requireActual<typeof LedgerToolsRuntimeModule>(
    '../canopy-tools/ledger-tools-runtime',
  ),
  mayExposeLedgerTools: jest.fn(() => false),
  openLedgerChatTools: jest.fn(() => Promise.resolve(null)),
}));
jest.mock('../lib/model-gateway-state', () => ({
  checkModelGatewayRoute: jest.fn(() =>
    Promise.resolve({ ok: true, orgRoute: false }),
  ),
}));
jest.mock('../agents/work-owner', () => ({
  ...jest.requireActual<typeof WorkOwnerModule>('../agents/work-owner'),
  resolveSessionWorkOwner: jest.fn(() => Promise.resolve({ kind: 'personal' })),
}));
jest.mock('../lib/bg-output-poller', () => ({
  stopAllOutputPolling: jest.fn(),
  flushAndStopOutputPollingForSession: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../lib/session-ended-background-tasks', () => ({
  emitSessionEndedBackgroundTaskNotification: jest.fn(),
}));
jest.mock('../power/wake-lock-service', () => ({
  getWakeLockService: jest.fn(() => ({
    acquire: jest.fn(),
    release: jest.fn(),
  })),
}));

import { ClaudeCodeProvider } from '../agents/claude-session';
import {
  destroySession,
  getActiveChatIds,
  getActiveSessionInfos,
  getSession,
} from '../agents/session-manager';
import { cleanupChatSkillPluginDir } from '../plugins/plugin-cleanup';

class FakeHostedCli extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = jest.fn((signal: NodeJS.Signals): boolean => {
    void signal;
    this.killed = true;
    return true;
  });

  get alive(): boolean {
    return this.exitCode === null && this.signalCode === null;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function flushUntil(done: () => boolean): Promise<void> {
  for (let tick = 0; tick < 40 && !done(); tick += 1) await flush();
}

function eventType(event: unknown): string | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const type: unknown = Reflect.get(event, 'type');
  return typeof type === 'string' ? type : undefined;
}

function spawnThroughSdk(
  params: Parameters<MockQuery>[0],
  cli: FakeHostedCli,
): void {
  mockSpawnClaudeCodeProcessOffMain.mockReturnValueOnce(cli);
  const spawn = params.options?.spawnClaudeCodeProcess;
  if (!spawn) throw new Error('Expected spawnClaudeCodeProcess option');
  spawn({
    command: '/mock/claude',
    args: [],
    cwd: '/tmp/repo',
    env: {},
    signal: new AbortController().signal,
  });
}

describe('deferred-tools reload of an active Claude turn (CAN-4833)', () => {
  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resumes the turn in the replacement while the interrupted loop ends late, leaving one CLI', async () => {
    const scope = {
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'deferred-reload',
    };
    const interruptedCli = new FakeHostedCli();
    const resumedCli = new FakeHostedCli();
    const interruptedCliExit = gate();
    mockQuery
      .mockImplementationOnce((params) => {
        spawnThroughSdk(params, interruptedCli);
        async function* interrupted(): AsyncGenerator<unknown, void> {
          if (typeof params.prompt === 'string')
            throw new Error('Expected streaming prompt');
          await params.prompt[Symbol.asyncIterator]().next();
          yield { type: 'system', subtype: 'init', session_id: 'original' };
          // The LoadDeferredTools result; the CLI goes on with the turn.
          yield {
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'load',
                  content: 'enabled',
                },
              ],
            },
          };
          // The SDK's close() ends stdin and SIGTERMs the busy CLI after its
          // two-second grace; the loop ends only once that CLI exits.
          await interruptedCliExit.wait;
          interruptedCli.exit(null, 'SIGTERM');
          const aborted = new Error('Operation aborted');
          aborted.name = 'AbortError';
          throw aborted;
        }
        return interrupted();
      })
      .mockImplementationOnce((params) => {
        spawnThroughSdk(params, resumedCli);
        async function* resumed(): AsyncGenerator<unknown, void> {
          if (typeof params.prompt === 'string')
            throw new Error('Expected streaming prompt');
          const prompt = await params.prompt[Symbol.asyncIterator]().next();
          yield { type: 'system', subtype: 'init', session_id: 'original' };
          // The CLI reports the prompt it started, which binds the turn.
          const promptUuid: unknown = prompt.done
            ? undefined
            : Reflect.get(prompt.value, 'uuid');
          yield {
            type: 'command_lifecycle',
            parent_tool_use_id: null,
            command_uuid: promptUuid,
            state: 'started',
          };
          yield {
            type: 'assistant',
            message: {
              id: 'continuation',
              role: 'assistant',
              content: [{ type: 'text', text: 'Continuing with the tool.' }],
            },
          };
          await new Promise<void>(() => undefined);
        }
        return resumed();
      });

    const provider = new ClaudeCodeProvider();
    const interruptedEvents = jest.fn();
    const interrupted = provider.createSession(
      scope,
      interruptedEvents,
      () => null,
    );
    interrupted.sendMessage('Load the tool and use it', {
      userMessageId: 'turn',
    });
    await flushUntil(() =>
      interruptedEvents.mock.calls.some(
        ([event]) => eventType(event) === 'user',
      ),
    );
    expect(getActiveSessionInfos('project', 'worktree')).toEqual([
      expect.objectContaining({ chatId: 'deferred-reload', turnActive: true }),
    ]);

    // A first teardown detaches the entry and waits for the old loop; the
    // reload's own destroySession then finds nothing and returns at once.
    const firstTeardown = destroySession(
      'project',
      'worktree',
      'deferred-reload',
      {
        retainDelegations: true,
      },
    );
    await destroySession('project', 'worktree', 'deferred-reload', {
      retainDelegations: true,
      suppressObservabilityInterrupt: true,
    });
    expect(
      getSession('project', 'worktree', 'deferred-reload'),
    ).toBeUndefined();

    // The resume handler recreates the session and continues the same turn.
    const resumedEvents = jest.fn();
    const resumed = provider.createSession(
      { ...scope, sdkSessionId: 'original' },
      resumedEvents,
      () => null,
    );
    resumed.sendMessage('<system_instruction>continue</system_instruction>', {
      userMessageId: 'turn',
    });
    await flushUntil(() =>
      resumedEvents.mock.calls.some(([event]) => eventType(event) === 'system'),
    );
    expect(getSession('project', 'worktree', 'deferred-reload')).toBe(resumed);

    // The interrupted loop ends after the resumed session registered.
    mockUnregisterRoutesForSession.mockClear();
    mockUnregisterCanopyWorktreeSessionRoute.mockClear();
    jest.mocked(cleanupChatSkillPluginDir).mockClear();
    interruptedCliExit.open();
    await firstTeardown;
    await flushUntil(() =>
      resumedEvents.mock.calls.some(
        ([event]) => eventType(event) === 'assistant',
      ),
    );

    expect(getSession('project', 'worktree', 'deferred-reload')).toBe(resumed);
    expect(getActiveSessionInfos('project', 'worktree')).toEqual([
      expect.objectContaining({ chatId: 'deferred-reload', turnActive: true }),
    ]);
    expect(resumed.isDisposed?.()).toBe(false);
    expect(resumedEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'assistant',
        canopy_turn_user_message_id: 'turn',
      }),
    );
    expect(mockUnregisterRoutesForSession).not.toHaveBeenCalled();
    expect(mockUnregisterCanopyWorktreeSessionRoute).not.toHaveBeenCalled();
    // The resumed session keeps the skill plugins the reload just enabled.
    expect(cleanupChatSkillPluginDir).not.toHaveBeenCalled();
    // Restart reconciliation reads this liveness: a chat absent from it with
    // an unfinished runtime is settled as interrupted, and the next turn then
    // abandons the resumed one.
    expect(getActiveChatIds('project', 'worktree')).toEqual([
      'deferred-reload',
    ]);

    jest.advanceTimersByTime(10_000);
    expect(interruptedCli.alive).toBe(false);
    expect(resumedCli.alive).toBe(true);
    expect(resumedCli.kill).not.toHaveBeenCalled();
    expect([interruptedCli, resumedCli].filter((cli) => cli.alive)).toEqual([
      resumedCli,
    ]);

    // The fake resumed CLI never exits, so this teardown is left pending.
    void destroySession('project', 'worktree', 'deferred-reload', {
      retainDelegations: true,
    });
  });
});
