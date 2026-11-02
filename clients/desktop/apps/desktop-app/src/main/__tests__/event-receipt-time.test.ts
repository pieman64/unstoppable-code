import type * as LedgerToolsRuntimeModule from '../canopy-tools/ledger-tools-runtime';
import type { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { initCodexModels, type ChatModel } from '@canopy/desktop-shared/types';
import type * as AiCreditsRoutingModule from '../agents/ai-credits-routing';
import type * as PreferencesStoreModule from '../lib/preferences-store';
import {
  recordEventReceiptTime,
  takeEventReceiptTime,
} from '../agents/event-receipt-time';

type MockQuery = (params: Parameters<typeof claudeQuery>[0]) => unknown;

interface CodexClientOptions {
  onEvent: (data: unknown) => void | Promise<void>;
}

const mockQuery: jest.MockedFunction<MockQuery> = jest.fn();
const mockStartTurn = jest.fn<Promise<{ status: 'completed' }>, unknown[]>();
let mockCodexClientOptions: CodexClientOptions | undefined;

jest.mock('electron', () => ({
  BrowserWindow: class MockBrowserWindow {
    public isDestroyed(): boolean {
      return false;
    }
  },
}));

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: Parameters<typeof claudeQuery>[0]): unknown =>
    mockQuery(params),
}));

jest.mock('../codex/app-server-client', () => ({
  CodexAppServerClient: jest.fn((options: CodexClientOptions) => {
    mockCodexClientOptions = options;
    return {
      startTurn: (...args: unknown[]): Promise<{ status: 'completed' }> =>
        mockStartTurn(...args),
      interruptTurn: jest.fn(),
      setApprovalMode: jest.fn(),
      dispose: jest.fn(),
      getThreadId: jest.fn(() => 'receipt-thread'),
      getActiveTurnInterruptTarget: jest.fn(() => ({
        threadId: 'receipt-thread',
        turnId: 'receipt-turn',
      })),
      hasProviderOwnedTurn: jest.fn(() => false),
      hasActiveTurn: jest.fn(() => false),
      hasLiveBackgroundWork: jest.fn(() => false),
      getBackgroundSnapshot: jest.fn(() => ({
        epoch: 'receipt-epoch',
        revision: 0,
        rootThreadId: 'receipt-thread',
        work: [],
        reconciling: false,
      })),
      subscribeBackgroundWork: jest.fn(() => (): void => undefined),
    };
  }),
}));

// The Ledger tools read real Feed storage; these sessions run without them.
jest.mock('../canopy-tools/ledger-tools-runtime', () => ({
  ...jest.requireActual<typeof LedgerToolsRuntimeModule>(
    '../canopy-tools/ledger-tools-runtime',
  ),
  mayExposeLedgerTools: (): boolean => false,
}));
jest.mock('../agents/session-manager', () => ({
  // The session under test is its key's registered instance (CAN-4833).
  getSessionKeyOwnership: (): string => 'registered',
  registerSession: jest.fn(),
  unregisterSession: jest.fn(),
  buildSessionKey: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): string => `${projectId}/${worktreeId}/${chatId}`,
  markSessionTeardownCause: jest.fn(),
  markTurnActive: jest.fn(),
  markTurnIdle: jest.fn(),
  markTurnAwaitingUser: jest.fn(),
  noteSessionMessageQueued: jest.fn(),
  recordSessionEvent: jest.fn(),
  getChildToolLiveness: jest.fn(() => ({ kind: 'no-live-session' })),
  createSessionPhaseTimer: jest.fn(() => jest.fn()),
  isSessionAiCreditsRouted: jest.fn(() => false),
  isSessionAccountProxyRouted: jest.fn(() => false),
  recordSessionAccountProxyRoute: jest.fn(),
  resetSessionLiveBackgroundTasks: jest.fn(),
  getLiveBackgroundTasksForChat: jest.fn(() => undefined),
  registerCodexBackgroundOwner: jest.fn(() => undefined),
  replaceCodexLiveBackgroundTasks: jest.fn(() => false),
  retireCodexLiveBackgroundTasks: jest.fn(() => false),
  SessionUnavailableForTaskStopError: class SessionUnavailableForTaskStopError extends Error {},
}));

jest.mock('../auth/provider-auth-state', () => {
  const isProviderNativelyAuthenticated = jest.fn().mockResolvedValue(true);
  return {
    isProviderNativelyAuthenticated,
    isProviderNativelyAuthenticatedForRouting: isProviderNativelyAuthenticated,
  };
});

jest.mock('../agents/work-owner', () => ({
  captureSessionWorkOwner: jest.fn(),
  resolveSessionWorkOwner: jest.fn(() => Promise.resolve({ kind: 'personal' })),
}));

jest.mock('../agents/ai-credits-routing', () => ({
  ...jest.requireActual<typeof AiCreditsRoutingModule>(
    '../agents/ai-credits-routing',
  ),
  getAiCreditsRoutingContext: jest.fn(() => Promise.resolve(null)),
  resolveSessionAiCreditsAttribution: jest.fn(() => Promise.resolve({})),
}));

jest.mock('../lib/model-gateway-state', () => ({
  checkModelGatewayRoute: jest.fn(() =>
    Promise.resolve({ ok: true, orgRoute: false }),
  ),
}));

jest.mock('../lib/preferences-store', () => ({
  ...jest.requireActual<typeof PreferencesStoreModule>(
    '../lib/preferences-store',
  ),
  readLocalMemoryEnabledPreference: jest.fn(() => Promise.resolve(false)),
  // No preferences-file I/O, so session start reaches the SDK query promptly
  // (as in the Claude session suite).
  readLatestPreferencesFile: jest.fn(() =>
    Promise.resolve(
      jest.requireActual<typeof PreferencesStoreModule>(
        '../lib/preferences-store',
      ).DEFAULT_PREFERENCES,
    ),
  ),
}));

jest.mock('../lib/user-environment-runtime', () => ({
  resolveCodexRuntimeEnvironmentProfile: jest.fn(() => ({
    environment: {},
    logicalWorkspaceEnvironmentId: 'receipt-test',
  })),
}));

jest.mock('../agents/delegation/gate', () => ({
  managedDelegationEnabled: jest.fn(() => false),
}));

jest.mock('../approvals/approval-service', () => ({
  createApprovalSession: jest.fn(() => ({
    check: jest.fn(() => Promise.resolve({ decision: 'allow' })),
    setMode: jest.fn(),
    reevaluatePendingApprovals: jest.fn(),
    invalidatePending: jest.fn(),
    dispose: jest.fn(),
  })),
}));

jest.mock('../services/attention-tracker', () => ({
  getAttentionTracker: jest.fn(() => ({
    mark: jest.fn(),
    clear: jest.fn(),
  })),
}));

jest.mock('../lib/resolve-workspace-display-name', () => ({
  resolveWorkspaceRecordingSnapshot: jest.fn(() =>
    Promise.resolve({ name: 'Workspace', type: 'single-repo' }),
  ),
}));

jest.mock('../plugins/plugin-resolver', () => ({
  cleanupWorktreeChatPluginDirs: jest.fn(),
  resolvePlugins: jest.fn(() =>
    Promise.resolve({
      sdkPlugins: [],
      skillPluginDir: null,
      selectedCapabilityRoots: [],
      codexProcessEnv: {},
      codexMcpServers: {},
      mcpServers: {},
      warnings: [],
    }),
  ),
}));

jest.mock('../plugins/global-plugin-overlay', () => ({
  resolveEffectiveChatPluginContext: jest.fn((selections?: unknown) =>
    Promise.resolve({
      selections: selections ?? {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
      },
    }),
  ),
}));

jest.mock('../plugins/invocable-inventory-service', () => ({
  loadCachedInventory: jest.fn(() => Promise.resolve(null)),
}));

jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(() => ({
    registerStdioMcpRoute: jest.fn(() => Promise.resolve()),
    revokeStdioMcpRoutes: jest.fn(() => Promise.resolve()),
  })),
}));

jest.mock('../codex/capability-store', () => ({
  getDesktopCodexCapabilityStore: jest.fn(() => ({})),
}));

jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: jest.fn(() => ({
    registerCanopyWorktreeSessionRoute: jest.fn(() => Promise.resolve('route')),
    unregisterCanopyWorktreeSessionRoute: jest.fn(),
    unregisterRoutesForSession: jest.fn(),
    getCanopyWorktreeMcpUrl: jest.fn(() => 'http://localhost/mcp'),
    getCanopyWorktreeUiMcpUrl: jest.fn(() => 'http://localhost/mcp/ui'),
    getCodexCapabilityAuthorityIds: jest.fn(() => []),
    getSessionMcpRoute: jest.fn(() => undefined),
  })),
}));

jest.mock('../lib/code-graph-availability', () => ({
  isCodeGraphAvailableForWorkspace: jest.fn(() => false),
}));

jest.mock('../lib/workspace-registry', () => ({
  isCoworkWorkspace: jest.fn(() => false),
}));

import { ClaudeCodeProvider } from '../agents/claude-session';
import { CodexProvider } from '../agents/codex-session';

interface RouterReceiptCapture {
  onEvent: (data: unknown) => void;
  receipt: Promise<{
    type: string | undefined;
    monotonicMs: number | undefined;
  }>;
}

function createRouterReceiptCapture(
  expectedType?: string,
): RouterReceiptCapture {
  let resolveReceipt: (value: {
    type: string | undefined;
    monotonicMs: number | undefined;
  }) => void = () => undefined;
  let captured = false;
  const receipt = new Promise<{
    type: string | undefined;
    monotonicMs: number | undefined;
  }>((resolve) => {
    resolveReceipt = resolve;
  });
  return {
    receipt,
    onEvent(data: unknown): void {
      if (typeof data !== 'object' || data === null) {
        return;
      }
      const type: unknown = Reflect.get(data, 'type');
      if (captured || (expectedType !== undefined && type !== expectedType))
        return;
      captured = true;
      resolveReceipt({
        type: typeof type === 'string' ? type : undefined,
        monotonicMs: takeEventReceiptTime(data),
      });
    },
  };
}

function createClaudeQueryResult(): AsyncGenerator<unknown, void> & {
  applyFlagSettings: () => Promise<void>;
  setPermissionMode: () => Promise<void>;
  setModel: () => Promise<void>;
} {
  async function* events(): AsyncGenerator<unknown, void> {
    await Promise.resolve();
    yield { type: 'system', subtype: 'init', session_id: 'receipt-session' };
    yield { type: 'result', is_error: false, result: 'done' };
  }

  return Object.assign(events(), {
    applyFlagSettings: (): Promise<void> => Promise.resolve(),
    setPermissionMode: (): Promise<void> => Promise.resolve(),
    setModel: (): Promise<void> => Promise.resolve(),
  });
}

// Session start takes a variable number of turns; poll instead of counting.
async function waitForCall(
  mock: { mock: { calls: readonly unknown[][] } },
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (mock.mock.calls.length === 0) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for the provider call');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('event receipt time sidechannel', () => {
  it('records receipt time without mutating the event payload and consumes it once', () => {
    const event = { type: 'message', content: 'unchanged' };
    const eventBeforeRecording = { ...event };

    recordEventReceiptTime(event, 12.5);

    expect(event).toEqual(eventBeforeRecording);
    expect(takeEventReceiptTime(event)).toBe(12.5);
    expect(takeEventReceiptTime(event)).toBeUndefined();
  });

  it('keeps receipt times tied to the final event object identity', () => {
    const event = { type: 'message' };
    const clonedEvent = { ...event };

    recordEventReceiptTime(event, 24);

    expect(takeEventReceiptTime(clonedEvent)).toBeUndefined();
    expect(takeEventReceiptTime(event)).toBe(24);
  });

  it('delivers the final Claude event with its receipt to the router callback', async () => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(() => createClaudeQueryResult());
    const router = createRouterReceiptCapture('result');
    const session = new ClaudeCodeProvider({
      prepareInvocation: (
        model: ChatModel | undefined,
      ): Promise<{ providerType: 'claude'; sdkModel?: ChatModel }> =>
        Promise.resolve({
          providerType: 'claude',
          ...(model ? { sdkModel: model } : {}),
        }),
    }).createSession(
      {
        cwd: '/tmp/receipt-test',
        projectId: 'receipt-project',
        worktreeId: 'receipt-worktree',
        chatId: 'claude-receipt',
      },
      router.onEvent,
      () => null,
    );

    session.sendMessage('receipt test');
    try {
      await waitForCall(mockQuery);
      const receipt = await router.receipt;
      expect(receipt.type).toBe('result');
      expect(typeof receipt.monotonicMs).toBe('number');
    } finally {
      await session.destroy();
    }
  });

  it('delivers the final Codex event with its receipt to the router callback', async () => {
    initCodexModels([{ id: 'gpt-6-sol', label: 'GPT-6-sol' }]);
    mockCodexClientOptions = undefined;
    mockStartTurn.mockReset();
    mockStartTurn.mockImplementation(async () => {
      const clientOptions = mockCodexClientOptions;
      if (!clientOptions) {
        throw new Error('Codex client callback was not registered');
      }
      await clientOptions.onEvent({
        type: 'codex',
        event: { type: 'turn.completed' },
      });
      return { status: 'completed' };
    });
    const router = createRouterReceiptCapture('codex');
    const session = new CodexProvider().createSession(
      {
        cwd: '/tmp/receipt-test',
        projectId: 'receipt-project',
        worktreeId: 'receipt-worktree',
        chatId: 'codex-receipt',
        sdkSessionId: 'receipt-thread',
        model: 'gpt-6-sol',
        codeGraphToolsAdvertised: false,
      },
      router.onEvent,
      () => null,
    );

    session.sendMessage('receipt test');
    try {
      await waitForCall(mockStartTurn);
      const receipt = await router.receipt;
      expect(receipt.type).toBe('codex');
      expect(typeof receipt.monotonicMs).toBe('number');
    } finally {
      await session.destroy();
    }
  });
});
