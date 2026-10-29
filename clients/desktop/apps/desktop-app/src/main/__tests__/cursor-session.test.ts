const mockMarkPlanAttention = jest.fn();
jest.mock('../services/attention-tracker', () => ({
  getAttentionTracker: (): { mark: typeof mockMarkPlanAttention } => ({
    mark: mockMarkPlanAttention,
  }),
}));
const mockCursorHarnessEnabled = jest.fn(() => true);
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: () => boolean } => ({
    isEnabled: mockCursorHarnessEnabled,
  }),
}));
import type { CanopyInjectedToolKey } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import type * as Stream from 'node:stream';
import type * as ChildProcess from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import type {
  LoadSessionRequest,
  NewSessionRequest,
  PromptRequest,
} from '@agentclientprotocol/sdk';
import type * as ToolApprovalModule from '../cursor/tool-approval';
import type { CanopyWorktreeSessionRoute } from '../mcp/http-proxy-service';
import { getChatTurnAuditStatus } from '../lib/chat-turn-audit';
import { isUserCancellationTerminal } from '../../renderer/src/stores/chat/turn-events';
import { BRAND } from '@canopy/brand/current';
import {
  CursorProvider,
  resetCursorPreTurnDiscoveryForTests,
} from '../agents/cursor-session';
import * as CursorUsageHook from '@canopy/desktop-shared/node/cursor/usage-hook';
import { CursorEventProjection } from '@canopy/desktop-shared/node/cursor/events';
import type * as CursorEventsModule from '@canopy/desktop-shared/node/cursor/events';
import { parseAgentTranscriptLines } from '@canopy/agent-transcript';
import { getManagedCursorRuntime } from '../cursor/connection';
import { getCursorRuntimeTarget } from '@canopy/desktop-shared/lib/cursor-runtime-targets';
import { verifyCursorVersion } from '../cursor/approval-check';
import {
  drainChatSessionEvents,
  markTurnAwaitingUser,
  markTurnIdle,
} from '../agents/session-manager';
import {
  initCursorModels,
  STANDALONE_CHAT_PROJECT_ID,
  type ChatTabsFile,
  type CursorModelEntry,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
import type { ChatReadSelection } from '../services/chat-state-v2-backend';
import { createApprovalSession } from '../approvals/approval-service';
import { hasTrustedVisualToolUse } from '../services/visual-tool-identity';
import type { AgentSessionOptions } from '../agents/types';

const mockReadChatTabsFile = jest.fn<
  Promise<ChatTabsFile>,
  [string, string, ChatReadSelection?]
>();
jest.mock('../lib/chat-tabs-reader', () => ({
  readChatTabsFile: (
    projectId: string,
    worktreeId: string,
    selection?: ChatReadSelection,
  ): Promise<ChatTabsFile> =>
    mockReadChatTabsFile(projectId, worktreeId, selection),
}));

const mockCommitPendingPlanExit = jest.fn<Promise<void>, [unknown]>(() =>
  Promise.resolve(),
);
jest.mock('../services/chat-state-plan-exit', () => ({
  commitPendingPlanExit: (event: unknown): Promise<void> =>
    mockCommitPendingPlanExit(event),
}));

jest.mock('electron', () => ({ app: { isPackaged: false } }));
const mockPrompt = jest.fn<
  Promise<{ stopReason: string }>,
  [PromptRequest, number, AbortSignal]
>();
const mockLoadSession = jest.fn<
  Promise<{ configOptions: typeof mockConfigOptions }>,
  [LoadSessionRequest]
>(() => Promise.resolve({ configOptions: mockConfigOptions }));
// The parameterized picker the driver negotiates: base ids in the model
// select, then one select per parameter of the selected model. Parameter
// values are remembered per model, like the real CLI.
const mockModels = [
  { base: 'default', name: 'Auto', parameters: [] },
  {
    base: 'gpt-6-luna',
    name: 'GPT-6 Luna',
    parameters: [
      {
        id: 'reasoning',
        category: 'thought_level',
        value: 'medium',
        values: ['none', 'low', 'medium', 'high', 'xhigh'],
      },
    ],
  },
  {
    base: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5 Thinking',
    parameters: [
      {
        id: 'thinking',
        category: 'thought_level',
        value: 'true',
        values: ['false', 'true'],
      },
    ],
  },
  {
    base: 'claude-opus-5',
    name: 'Claude Opus 5',
    parameters: [
      {
        id: 'thinking',
        category: 'thought_level',
        value: 'true',
        values: ['false', 'true'],
      },
      {
        id: 'effort',
        category: 'thought_level',
        value: 'high',
        values: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
    ],
  },
];
let mockSelectedBase = 'default';
const mockParameterValues = new Map<string, string>();
// Live-picker quirks the tests can switch on: a remembered `thinking=false`
// hiding `effort` until thinking is on, and a narrower effort ladder than
// the catalog described.
let mockHideEffortWhileThinkingOff = false;
let mockHideThoughtOptions = false;
let mockEffortValues: string[] = ['low', 'medium', 'high', 'xhigh', 'max'];
function mockConfigOptionsFor(base: string): {
  id: string;
  name: string;
  category?: string;
  type: 'select';
  currentValue: string;
  options: { value: string; name: string }[];
}[] {
  const model = mockModels.find((entry) => entry.base === base);
  return [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: base,
      options: mockModels.map((entry) => ({
        value: entry.base,
        name: entry.name,
      })),
    },
    ...(model?.parameters ?? [])
      .filter(
        (parameter) =>
          (!mockHideThoughtOptions || parameter.category !== 'thought_level') &&
          !(
            mockHideEffortWhileThinkingOff &&
            parameter.id === 'effort' &&
            (mockParameterValues.get(`${base}:thinking`) ?? 'true') === 'false'
          ),
      )
      .map((parameter) => ({
        id: parameter.id,
        name: parameter.id,
        category: parameter.category,
        type: 'select' as const,
        currentValue:
          mockParameterValues.get(`${base}:${parameter.id}`) ?? parameter.value,
        options: (parameter.id === 'effort'
          ? mockEffortValues
          : parameter.values
        ).map((value) => ({ value, name: value })),
      })),
  ];
}
const mockConfigOptions = mockConfigOptionsFor('default');
const mockSetConfig = jest.fn(
  ({ configId, value }: { configId: string; value: string }) => {
    if (configId === 'model') mockSelectedBase = value;
    else {
      mockParameterValues.set(`${mockSelectedBase}:${configId}`, value);
      // Like the pinned CLI: turning the thinking toggle off snaps the graded
      // effort back to its weakest value.
      if (configId === 'thinking' && value === 'false')
        mockParameterValues.set(`${mockSelectedBase}:effort`, 'low');
    }
    return Promise.resolve({
      configOptions: mockConfigOptionsFor(mockSelectedBase),
    });
  },
);
const mockNewSession = jest.fn<
  Promise<{ sessionId: string; configOptions: typeof mockConfigOptions }>,
  [NewSessionRequest]
>(() =>
  Promise.resolve({ sessionId: 'session', configOptions: mockConfigOptions }),
);
type AcpClientCallbacks = {
  onUpdate: (update: unknown) => void;
  onPermission: (args: {
    request: {
      toolCall: { toolCallId: string; title?: string; kind?: string };
    };
    signal: AbortSignal;
  }) => Promise<'allow' | 'deny'>;
};
const mockInitialization: { agentCapabilities?: unknown } = {};
const mockConnectAcp = jest.fn((options: AcpClientCallbacks) => {
  mockAcpCallbacks.current = options;
  return Promise.resolve({
    getInitialization: jest.fn(() => mockInitialization),
    newSession: mockNewSession,
    loadSession: mockLoadSession,
    prompt: mockPrompt,
    setSessionConfigOption: mockSetConfig,
    cancel: jest.fn(() => Promise.resolve()),
    close: jest.fn(),
  });
});
const mockAcpCallbacks: { current?: AcpClientCallbacks } = {};
jest.mock('@canopy/desktop-shared/node/acp', () => ({
  // Deferred so the hoisted factory never touches the mocks before they exist.
  connectAcp: (options: AcpClientCallbacks): Promise<unknown> =>
    mockConnectAcp(options),
}));
jest.mock('node:fs/promises', () => ({
  readFile: jest.fn(() =>
    Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })),
  ),
  mkdir: jest.fn(() => Promise.resolve()),
  mkdtemp: jest.fn(() => Promise.resolve('/mock-hook')),
  writeFile: jest.fn(() => Promise.resolve()),
  rm: jest.fn(() => Promise.resolve()),
  // MCP server commands are validated on disk; only the fixture tool
  // directory exists in these tests.
  stat: jest.fn((target: string) =>
    target.startsWith('/opt/tools/')
      ? Promise.resolve({ isFile: () => true })
      : Promise.reject(new Error('ENOENT')),
  ),
  access: jest.fn(() => Promise.resolve()),
}));
jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof ChildProcess>('node:child_process'),
  spawn: jest.fn(() => {
    const { PassThrough } = jest.requireActual<typeof Stream>('node:stream');
    return {
      pid: 12345,
      stdout: new PassThrough(),
      stdin: new PassThrough(),
      stderr: new PassThrough(),
      once: jest.fn(),
    };
  }),
}));
const mockApprovalCheck = jest.fn<
  Promise<{
    decision: 'allow' | 'deny';
    stopTurn?: boolean;
    message?: string;
  }>,
  [unknown, unknown]
>(() => Promise.resolve({ decision: 'allow' }));
const mockCreateManagedDelegationSession = jest.fn<
  Promise<unknown>,
  [{ currentOptions: () => AgentSessionOptions }]
>();
jest.mock('../agents/delegation/service', () => ({
  createManagedDelegationSession: (options: {
    currentOptions: () => AgentSessionOptions;
  }): Promise<unknown> => mockCreateManagedDelegationSession(options),
}));
jest.mock('../approvals/approval-service', () => ({
  createApprovalSession: jest.fn(() => ({
    check: (check: unknown, display: unknown): Promise<unknown> =>
      mockApprovalCheck(check, display),
    setMode: jest.fn(),
    dispose: jest.fn(),
    invalidatePending: jest.fn(),
  })),
}));
const mockProxy = {
  registerCanopyWorktreeSessionRoute: jest.fn<
    Promise<string>,
    [CanopyWorktreeSessionRoute]
  >(() => Promise.resolve('route')),
  unregisterCanopyWorktreeSessionRoute: jest.fn(),
  unregisterRoutesForSession: jest.fn(),
  setSessionToolCallGate: jest.fn<
    void,
    [
      string,
      (call: {
        proxyUrl: string;
        tool: string;
        args: Record<string, unknown>;
        requestId?: string;
      }) => Promise<boolean>,
    ]
  >(),
  getCanopyWorktreeMcpUrl: jest.fn(() => 'http://127.0.0.1:4/mcp/key'),
  getCanopyWorktreeUiMcpUrl: jest.fn(() => 'http://127.0.0.1:4/mcp/key/ui'),
};
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: (): typeof mockProxy => mockProxy,
}));
const mockResolvePlugins = jest.fn<
  Promise<{
    mcpServers: Record<string, unknown>;
    warnings: string[];
    cursorNotices: string[];
    cursorCapabilities?: { skills: unknown[]; commands: unknown[] };
  }>,
  [unknown, unknown, unknown, unknown, unknown]
>(() => Promise.resolve({ mcpServers: {}, warnings: [] }));
const mockMaterialize = jest.fn<
  Promise<{ skillIds: string[]; commandIds: string[]; warnings: string[] }>,
  [string, unknown]
>(() => Promise.resolve({ skillIds: [], commandIds: [], warnings: [] }));
jest.mock('@canopy/desktop-shared/node/cursor/capability-root', () => ({
  materializeCursorCapabilityRoot: (
    home: string,
    projection: unknown,
  ): Promise<unknown> => mockMaterialize(home, projection),
}));
jest.mock('../plugins/plugin-resolver', () => ({
  resolvePlugins: async (
    selections: unknown,
    projectId: unknown,
    worktreeId: unknown,
    chatId: unknown,
    options: unknown,
  ): Promise<unknown> => {
    // The real resolver always returns a projection; older mocks in this
    // file predate the field.
    const resolved = await mockResolvePlugins(
      selections,
      projectId,
      worktreeId,
      chatId,
      options,
    );
    return { cursorCapabilities: { skills: [], commands: [] }, ...resolved };
  },
}));
const mockOverlayTombstones: {
  current?: { pluginRefs?: { marketplaceId: string; pluginName: string }[] };
} = {};
const mockOverlayCalls: unknown[][] = [];
jest.mock('../plugins/global-plugin-overlay', () => ({
  resolveEffectiveChatPluginContext: (
    local: unknown,
    target: unknown,
    overlay: unknown,
  ): Promise<{ selections: unknown; chatTombstones?: unknown }> =>
    Promise.resolve({
      selections: local ?? {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      ...(mockOverlayTombstones.current
        ? { chatTombstones: mockOverlayTombstones.current }
        : {}),
      ...(mockOverlayCalls.push([local, target, overlay]) ? {} : {}),
    }),
}));
const mockEmptyInherited = (): {
  skills: unknown[];
  commands: unknown[];
  skipped: unknown[];
  fingerprint: string;
} => ({ skills: [], commands: [], skipped: [], fingerprint: 'empty' });
const mockDiscoverInherited = jest.fn<Promise<unknown>, [unknown]>(() =>
  Promise.resolve(mockEmptyInherited()),
);
jest.mock('@canopy/desktop-shared/node/cursor/inherited-capabilities', () => ({
  discoverInheritedCursorCapabilities: (roots: unknown): Promise<unknown> =>
    mockDiscoverInherited(roots),
  emptyInheritedCursorCapabilities: (): unknown => mockEmptyInherited(),
}));
jest.mock('../cursor/inherited-roots', () => ({
  resolveInheritedCursorRoots: (): unknown => ({
    userHome: '/home/user',
    claudeConfigDir: '/home/user/.claude',
    codexHome: '/home/user/.codex',
  }),
}));
const mockLoadMarketplacesCacheOnly = jest.fn<Promise<unknown>, []>(() =>
  Promise.resolve({ success: true, data: { marketplaces: [] } }),
);
jest.mock('../plugins/plugin-service', () => ({
  loadMarketplacesCacheOnly: (): Promise<unknown> =>
    mockLoadMarketplacesCacheOnly(),
}));
const mockRefreshInventory = jest.fn<void, [string]>();
jest.mock('../plugins/invocable-inventory-service', () => ({
  refreshInvocableInventoryAfterMutation: (reason: string): void =>
    mockRefreshInventory(reason),
}));
import type * as ClaudeEnabledPluginsModule from '../plugins/claude-enabled-plugins';
const mockClaudeEnabledPlugins = jest.fn<
  Map<string, string> | null,
  [string, string?]
>(() => new Map());
jest.mock('../plugins/claude-enabled-plugins', () => ({
  // The install-folder check stays real: it is what keeps a vanished folder
  // out of id assignment.
  ...jest.requireActual<typeof ClaudeEnabledPluginsModule>(
    '../plugins/claude-enabled-plugins',
  ),
  readClaudeEnabledPlugins: (
    configDir: string,
    projectPath?: string,
  ): Map<string, string> | null =>
    mockClaudeEnabledPlugins(configDir, projectPath),
}));
type HookAuthorize = (payload: unknown) => Promise<unknown>;
const mockHook: { authorize?: HookAuthorize } = {};
jest.mock('@canopy/desktop-shared/node/cursor/hook-transport', () => ({
  CURSOR_HOOK_SCRIPT: '',
  createCursorHookTransport: (authorize: HookAuthorize): Promise<unknown> => {
    mockHook.authorize = authorize;
    return Promise.resolve({
      url: 'http://fixture',
      token: 'fixture',
      revoke: jest.fn(),
      close: jest.fn(() => Promise.resolve()),
    });
  },
}));
const mockAuthorizeCursorTool = jest.fn(() =>
  Promise.resolve({ decision: 'allow' }),
);
jest.mock('../cursor/tool-approval', () => ({
  authorizeCursorTool: (payload: unknown, context: unknown): Promise<unknown> =>
    mockAuthorizeCursorTool(payload, context),
  // MCP authorization is exercised for real against the mocked approval
  // session so the policy hand-off is verified end to end.
  authorizeCursorMcpTool: (
    call: Parameters<typeof ToolApprovalModule.authorizeCursorMcpTool>[0],
    context: Parameters<typeof ToolApprovalModule.authorizeCursorMcpTool>[1],
  ): Promise<unknown> =>
    jest
      .requireActual<typeof ToolApprovalModule>('../cursor/tool-approval')
      .authorizeCursorMcpTool(call, context),
}));
const mockRewriteCursorShellInput = jest.fn(
  (): Promise<Record<string, unknown> | undefined> =>
    Promise.resolve(undefined),
);
jest.mock('@canopy/desktop-shared/node/cursor/rtk-rewrite', () => ({
  rewriteCursorShellInput: (
    payload: unknown,
    options: unknown,
  ): Promise<Record<string, unknown> | undefined> =>
    mockRewriteCursorShellInput(payload, options),
}));
const mockProjectionNotice = jest.fn<unknown, [string]>(() => ({
  type: 'canopy_assistant_patch',
  role: 'system',
  patches: [],
}));
const mockProjectionUpdate = jest.fn((): unknown => undefined);
const mockProjectionGetTool = jest.fn(
  (): { name: string; input: unknown; kind?: string } | undefined => undefined,
);
const mockProjectionResponseText = jest.fn((): string => '');
const mockRealProjection = { enabled: false };
jest.mock('@canopy/desktop-shared/node/cursor/events', () => ({
  CursorEventProjection: jest.fn(
    (
      limit: string | undefined,
      options: ConstructorParameters<
        typeof CursorEventsModule.CursorEventProjection
      >[1],
    ) =>
      mockRealProjection.enabled
        ? new (jest.requireActual<typeof CursorEventsModule>(
            '@canopy/desktop-shared/node/cursor/events',
          ).CursorEventProjection)(limit, options)
        : {
            getTerminalError: jest.fn(() => undefined),
            update: mockProjectionUpdate,
            notice: mockProjectionNotice,
            getTool: mockProjectionGetTool,
            getResponseText: mockProjectionResponseText,
            // Interactive chat configures no secret values, so the real projection
            // never holds text back and both of these always return nothing.
            takeFlushed: jest.fn((): Record<string, unknown>[] => []),
            finish: jest.fn((): Record<string, unknown>[] => []),
          },
  ),
}));
jest.mock('@canopy/desktop-shared/node/cursor/runtime-process', () => ({
  stopCursorProcessGroup: jest.fn(() => Promise.resolve()),
}));
const mockGetWorktreeDataDir = jest.fn<string, [string, string]>(
  () => '/unused/worktree-data/main',
);
jest.mock('../lib/paths', () => ({
  getWorktreeDataDir: (projectId: string, worktreeId: string): string =>
    mockGetWorktreeDataDir(projectId, worktreeId),
}));
// The real resolver imports the git helper, which this suite's child-process
// mock cannot load. Faithful to it for the two keyings used here: the legacy
// standalone sentinel borrows the Cowork workspace's home slot, every other
// pair is returned unchanged.
jest.mock('../lib/resolve-worktree', () => {
  const { STANDALONE_CHAT_PROJECT_ID } = jest.requireActual<{
    STANDALONE_CHAT_PROJECT_ID: string;
  }>('@canopy/desktop-shared/types');
  return {
    resolveWorktreeTargetIds: (
      projectId: string,
      worktreeId: string,
    ): { projectId: string; worktreeId: string } =>
      projectId === STANDALONE_CHAT_PROJECT_ID
        ? { projectId: worktreeId, worktreeId: 'home' }
        : { projectId, worktreeId },
  };
});
jest.mock('../agents/session-manager', () => ({
  buildSessionKey: (): string => 'cursor-test',
  registerSession: jest.fn(),
  recordSessionEvent: jest.fn(),
  markTurnActive: jest.fn(),
  markTurnAwaitingUser: jest.fn(),
  markTurnIdle: jest.fn(),
  drainChatSessionEvents: jest.fn(() => Promise.resolve()),
}));
jest.mock('../pipelines/config-paths', () => ({
  getEnhancedEnv: (): NodeJS.ProcessEnv => ({ HOME: '/user-home' }),
  getBundledRtkBinaryPath: (): string => '/mock/bin/rtk',
  getRtkManagedEnv: (): Record<string, string> => ({
    RTK_DB_PATH: '/mock/rtk/history.db',
  }),
}));
const mockPreferences = {
  cursorEnabled: false,
  cursorAgentPath: '/diagnostic/cursor-agent',
  localMemoryEnabled: false,
};
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<typeof mockPreferences> =>
    Promise.resolve(mockPreferences),
}));
// The darwin launcher shape: one executable, no interpreter prefix.
const mockCursorTarget = getCursorRuntimeTarget('darwin', 'arm64');
if (!mockCursorTarget) throw new Error('missing darwin-arm64 target');
const mockListCursorModels = jest.fn<Promise<CursorModelEntry[]>, []>(() =>
  Promise.resolve([]),
);
jest.mock('../cursor/models', () => ({
  listCursorModels: (): Promise<CursorModelEntry[]> => mockListCursorModels(),
}));
const mockBroadcastModelRegistryUpdated = jest.fn();
// The session only needs the registry broadcast.
jest.mock('../models/model-registry', () => ({
  broadcastModelRegistryUpdated: (): void => {
    mockBroadcastModelRegistryUpdated();
  },
}));
jest.mock('../cursor/connection', () => ({
  getManagedCursorRuntime: jest.fn(() =>
    Promise.reject(new Error('managed runtime verification')),
  ),
}));
jest.mock('../cursor/approval-check', () => ({
  verifyCursorVersion: jest.fn(() =>
    Promise.reject(new Error('diagnostic binary executed')),
  ),
}));
type MockLedgerTools = {
  systemPrompt: jest.Mock<string, []>;
  assignmentHint: jest.Mock<Promise<string | undefined>, []>;
  execute: jest.Mock;
  dispose: jest.Mock<void, []>;
};
type MockOpenLedgerChatToolsOptions = {
  target: Record<string, unknown>;
  harness: string;
  readSettings: () => Record<string, unknown>;
  selectedRepoId?: string;
};
const mockMayExposeLedgerTools = jest.fn<boolean, [Record<string, unknown>]>(
  () => false,
);
const mockOpenLedgerChatTools = jest.fn<
  Promise<MockLedgerTools | null>,
  [MockOpenLedgerChatToolsOptions]
>(() => Promise.resolve(null));
jest.mock('../canopy-tools/ledger-tools-runtime', () => ({
  mayExposeLedgerTools: (target: Record<string, unknown>): boolean =>
    mockMayExposeLedgerTools(target),
  openLedgerChatTools: (
    options: MockOpenLedgerChatToolsOptions,
  ): Promise<MockLedgerTools | null> => mockOpenLedgerChatTools(options),
}));
const mockDataPolicyMessage = jest.fn<
  Promise<string | undefined>,
  [string, NodeJS.ProcessEnv, AbortSignal]
>(() => Promise.resolve(undefined));
jest.mock('../cursor/model-data-policy', () => ({
  cursorDataPolicyMessage: (
    rawModelId: string,
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ): Promise<string | undefined> =>
    mockDataPolicyMessage(rawModelId, env, signal),
}));
const platform = Object.getOwnPropertyDescriptor(process, 'platform');
const arch = Object.getOwnPropertyDescriptor(process, 'arch');
beforeEach(() => {
  jest.clearAllMocks();
  mockRealProjection.enabled = false;
  jest.mocked(drainChatSessionEvents).mockResolvedValue(undefined);
  mockSelectedBase = 'default';
  mockParameterValues.clear();
  mockHideEffortWhileThinkingOff = false;
  mockHideThoughtOptions = false;
  mockEffortValues = ['low', 'medium', 'high', 'xhigh', 'max'];
  mockListCursorModels.mockReset();
  mockListCursorModels.mockResolvedValue([]);
  mockReadChatTabsFile.mockResolvedValue({
    version: 1,
    tabs: [],
    activeTabId: '',
  });
  mockCursorHarnessEnabled.mockReturnValue(true);
  mockApprovalCheck.mockResolvedValue({ decision: 'allow' });
  mockResolvePlugins.mockResolvedValue({
    mcpServers: {},
    warnings: [],
    cursorNotices: [],
  });
  mockMaterialize.mockResolvedValue({
    skillIds: [],
    commandIds: [],
    warnings: [],
  });
  mockInitialization.agentCapabilities = {
    mcpCapabilities: { http: true, sse: true },
  };
  mockPreferences.cursorEnabled = false;
  mockPreferences.localMemoryEnabled = false;
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'darwin',
  });
  Object.defineProperty(process, 'arch', {
    configurable: true,
    value: 'arm64',
  });
});
afterEach(() => {
  if (platform) Object.defineProperty(process, 'platform', platform);
  if (arch) Object.defineProperty(process, 'arch', arch);
});
async function terminalEvent(): Promise<unknown> {
  let finish: (event: unknown) => void = () => {};
  const terminal = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const session = new CursorProvider().createSession(
    {
      cwd: '/unused',
      projectId: 'code',
      worktreeId: 'main',
      chatId: 'cursor',
      model: 'cursor-default',
    },
    (event) => {
      if (
        typeof event === 'object' &&
        event !== null &&
        'type' in event &&
        (event.type === 'error' || event.type === 'result')
      ) {
        finish(event);
      }
    },
    () => null,
  );
  try {
    session.sendMessage('Hello');
    return await terminal;
  } finally {
    await session.destroy();
  }
}
test('normal Cursor chat cannot use the saved developer diagnostic path while disconnected', async () => {
  expect(await terminalEvent()).toMatchObject({
    type: 'error',
    error: 'Connect Cursor in Settings to start chatting.',
  });
  expect(getManagedCursorRuntime).not.toHaveBeenCalled();
  expect(verifyCursorVersion).not.toHaveBeenCalled();
});
test('normal Cursor chat checks the managed runtime before any CLI invocation', async () => {
  mockPreferences.cursorEnabled = true;
  expect(await terminalEvent()).toMatchObject({
    type: 'error',
    error: 'managed runtime verification',
  });
  expect(getManagedCursorRuntime).toHaveBeenCalledTimes(1);
  expect(verifyCursorVersion).not.toHaveBeenCalled();
});
test('normal Cursor chat reaches the managed runtime on Intel Macs', async () => {
  Object.defineProperty(process, 'arch', { configurable: true, value: 'x64' });
  mockPreferences.cursorEnabled = true;
  // darwin-x64 is a pinned target, so the platform gate no longer stops it and
  // the mocked runtime's own rejection is what ends the turn.
  expect(await terminalEvent()).toMatchObject({
    type: 'error',
    error: 'managed runtime verification',
  });
  expect(getManagedCursorRuntime).toHaveBeenCalledTimes(1);
});
test('normal Cursor chat rejects a platform with no pinned runtime before any runtime invocation', async () => {
  Object.defineProperty(process, 'arch', { configurable: true, value: 'ia32' });
  mockPreferences.cursorEnabled = true;
  expect(await terminalEvent()).toMatchObject({
    type: 'error',
    error: 'Cursor chat is not available on this device.',
  });
  expect(getManagedCursorRuntime).not.toHaveBeenCalled();
  expect(verifyCursorVersion).not.toHaveBeenCalled();
});

test.each(['provider-cancelled', 'user-stop', 'completed'] as const)(
  'classifies the actual Cursor terminal event in main and renderer: %s',
  async (outcome) => {
    mockPreferences.cursorEnabled = true;
    jest.mocked(getManagedCursorRuntime).mockResolvedValue({
      launch: { command: '/mock/cursor-agent', prefix: [] },
      env: {},
      target: mockCursorTarget,
    });
    jest.mocked(verifyCursorVersion).mockResolvedValue(undefined);
    let signalPrompt: () => void = () => {};
    const promptStarted = new Promise<void>((resolve) => {
      signalPrompt = resolve;
    });
    mockPrompt.mockImplementation(
      (_params: unknown, _generation: unknown, signal: AbortSignal) => {
        signalPrompt();
        if (outcome !== 'user-stop')
          return Promise.resolve({
            stopReason: outcome === 'completed' ? 'end_turn' : 'cancelled',
          });
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          }),
        );
      },
    );
    let finish: (event: Record<string, unknown>) => void = () => {};
    const terminal = new Promise<Record<string, unknown>>((resolve) => {
      finish = resolve;
    });
    const session = new CursorProvider().createSession(
      {
        cwd: '/mock',
        projectId: 'code',
        worktreeId: 'main',
        chatId: 'cursor',
        model: 'cursor-default',
      },
      (data) => {
        if (
          typeof data === 'object' &&
          data !== null &&
          'type' in data &&
          (data.type === 'result' || data.type === 'error')
        ) {
          finish({ ...data });
        }
      },
      () => null,
    );
    try {
      session.sendMessage('Hello');
      await promptStarted;
      if (outcome === 'user-stop') await session.cancel();
      const event = await terminal;
      expect(event.type).toBe('result');
      expect({
        auditStatus: getChatTurnAuditStatus(event),
        rendererCancellation: isUserCancellationTerminal(event),
      }).toEqual({
        auditStatus: outcome === 'completed' ? 'success' : 'cancelled',
        rendererCancellation: outcome !== 'completed',
      });
    } finally {
      await session.destroy();
    }
  },
);

// The delegation tree belongs to the root chat
// (docs/managed-delegation-tools.md § Ownership): Stop ends only the Cursor
// turn, and destroying the session detaches it from the tree.
test('Cursor Stop retires only its turn delegation bindings and destroy detaches', async () => {
  mockPreferences.cursorEnabled = true;
  jest.mocked(getManagedCursorRuntime).mockResolvedValue({
    launch: { command: '/mock/cursor-agent', prefix: [] },
    env: {},
    target: mockCursorTarget,
  });
  jest.mocked(verifyCursorVersion).mockResolvedValue(undefined);
  const managed = {
    observe: jest.fn(),
    applyPolicyGuidance: jest.fn((text: string) => text),
    updatePolicy: jest.fn(),
    retireTurn: jest.fn(),
    detach: jest.fn(),
    tools: [],
    mcpTools: [],
    systemPromptGuidance: undefined,
  };
  mockCreateManagedDelegationSession.mockResolvedValueOnce(managed);
  let signalPrompt: () => void = () => {};
  const promptStarted = new Promise<void>((resolve) => {
    signalPrompt = resolve;
  });
  mockPrompt.mockImplementation(
    (_params: unknown, _generation: unknown, signal: AbortSignal) => {
      signalPrompt();
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        }),
      );
    },
  );
  let finish: () => void = () => {};
  const terminal = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const session = new CursorProvider().createSession(
    {
      cwd: '/mock',
      projectId: 'code',
      worktreeId: 'main',
      chatId: 'cursor',
      model: 'cursor-default',
      managedDelegationSurface: 'worktree-chat',
      managedDelegationMode: 'explicit-only',
    },
    (data) => {
      if (
        typeof data === 'object' &&
        data !== null &&
        'type' in data &&
        (data.type === 'result' || data.type === 'error')
      )
        finish();
    },
    () => null,
  );
  try {
    session.sendMessage('Hello');
    await promptStarted;
    await session.cancel();
    await terminal;
    expect(managed.retireTurn).toHaveBeenCalledTimes(1);
    expect(managed.detach).not.toHaveBeenCalled();
    // Delegates evaluate their approvals against the chat's one live list.
    const created = mockCreateManagedDelegationSession.mock.calls[0]?.[0];
    expect(created?.currentOptions().sessionApprovalRules).toBe(
      jest.mocked(createApprovalSession).mock.calls[0]?.[0].sessionRules,
    );
  } finally {
    await session.destroy();
  }
  expect(managed.detach).toHaveBeenCalledTimes(1);
});

let promptStopReason = 'end_turn';

test('Cursor stays active until admitted output has finished committing', async () => {
  const turn = startTurn();
  let release = (): void => {};
  const pendingCommit = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await turn.promptStarted;
    jest.mocked(drainChatSessionEvents).mockReturnValue(pendingCommit);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(markTurnIdle).not.toHaveBeenCalled();
    expect(turn.events.some((event) => event.type === 'result')).toBe(false);
    release();
    await turn.terminal;
    expect(markTurnIdle).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await turn.destroy();
  }
});

test('Cursor coalesces a burst of answer tokens without losing text or the terminal tail', async () => {
  const turn = startTurn();
  try {
    await turn.promptStarted;
    const callbacks = mockAcpCallbacks.current;
    if (!callbacks) throw new Error('Missing ACP callbacks');
    for (let revision = 1; revision <= 100; revision += 1) {
      mockProjectionUpdate.mockReturnValueOnce({
        type: 'canopy_assistant_patch',
        provider: 'cursor',
        messageId: 'answer',
        timestamp: 1000,
        revision,
        patches: [
          revision === 1
            ? { index: 0, block: { type: 'text', text: 'word ' } }
            : { index: 0, appendText: 'word ' },
        ],
      });
      callbacks.onUpdate({
        sessionId: 'session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'word ' },
        },
      });
    }
    await turn.terminal;
    const patches = turn.events.filter((event) => event.messageId === 'answer');
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      revision: 100,
      patches: [
        { index: 0, block: { type: 'text', text: 'word '.repeat(100) } },
      ],
    });
    expect(turn.events.at(-1)?.type).toBe('result');
  } finally {
    await turn.destroy();
  }
});

test('real desktop projection preserves concurrent text, tool, and completion updates behind a slow commit', async () => {
  const actual = jest.requireActual<typeof CursorEventsModule>(
    '@canopy/desktop-shared/node/cursor/events',
  );
  const projection = new actual.CursorEventProjection();
  const takeFlushed = jest.spyOn(projection, 'takeFlushed');
  jest.mocked(CursorEventProjection).mockImplementationOnce(() => projection);
  const turn = startTurn();
  let release = (): void => {};
  const commit = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await turn.promptStarted;
    jest.mocked(drainChatSessionEvents).mockReturnValue(commit);
    const callbacks = mockAcpCallbacks.current;
    if (!callbacks) throw new Error('Missing ACP callbacks');
    if (!mockHook.authorize) throw new Error('Missing native hook');
    await mockHook.authorize({
      hook_event_name: 'preToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/a' },
      tool_use_id: 'read',
    });
    for (const update of [
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Before tool.' },
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'read',
        title: 'Read',
        kind: 'read',
        status: 'pending',
        rawInput: { path: '/tmp/a' },
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'read',
        status: 'completed',
        rawOutput: 'file content',
      },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'After tool.' },
      },
    ])
      callbacks.onUpdate({ sessionId: 'session', update });
    // Desktop configures no secretValues: switching to a tool does not
    // release held text or introduce an await ahead of that tool's emit.
    expect(takeFlushed).toHaveBeenCalledTimes(4);
    for (let call = 1; call <= 4; call += 1)
      expect(takeFlushed).toHaveNthReturnedWith(call, []);
    release();
    await turn.terminal;
    const patches = turn.events.filter(
      (event) => event.type === 'canopy_assistant_patch',
    );
    expect(patches.map((event) => event.revision)).toEqual([1, 2, 3, 4]);
    const transcript = parseAgentTranscriptLines(
      patches.map((event) => JSON.stringify(event)),
    );
    expect(
      transcript.messages
        .flatMap((message) => message.blocks ?? [])
        .map((block) => block.type),
    ).toEqual(['text', 'tool_use', 'tool_result', 'text']);
  } finally {
    release();
    await turn.destroy();
  }
});

describe('account action notices from the pinned CLI', () => {
  const gptRaw = 'gpt-6-luna[reasoning=medium]';
  const configCopy =
    "Your Cursor account settings don't allow this request. Check them in your Cursor dashboard, then try again, or choose another model.";
  const policyCopy =
    'To use GPT 6 Luna, accept its data retention policy in your Cursor dashboard, then try again, or choose another model.';
  // The notice is one assistant chunk and a normal end_turn, so the real
  // projection has to classify it; the suite's default projection is a stub.
  async function refusedTurn(text: string): Promise<Record<string, unknown>> {
    const actual = jest.requireActual<typeof CursorEventsModule>(
      '@canopy/desktop-shared/node/cursor/events',
    );
    jest
      .mocked(CursorEventProjection)
      .mockImplementationOnce(() => new actual.CursorEventProjection());
    const turn = startTurn({ model: 'cursor:' + encodeURIComponent(gptRaw) });
    try {
      await turn.promptStarted;
      mockAcpCallbacks.current?.onUpdate({
        sessionId: 'session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        },
      });
      return await turn.terminal;
    } finally {
      await turn.destroy();
    }
  }

  test('a settings notice names the data retention policy when the lookup finds one', async () => {
    mockDataPolicyMessage.mockResolvedValueOnce(policyCopy);
    expect(
      await refusedTurn('\n\nCheck your settings to continue'),
    ).toMatchObject({
      type: 'error',
      error: policyCopy,
    });
    expect(mockDataPolicyMessage).toHaveBeenCalledTimes(1);
    expect(mockDataPolicyMessage).toHaveBeenCalledWith(
      gptRaw,
      expect.objectContaining({ NO_OPEN_BROWSER: '1' }),
      expect.any(AbortSignal),
    );
  });

  test('a settings notice keeps the generic copy when the lookup finds nothing', async () => {
    expect(
      await refusedTurn('\n\nCheck your settings to continue'),
    ).toMatchObject({
      type: 'error',
      error: configCopy,
    });
    expect(mockDataPolicyMessage).toHaveBeenCalledTimes(1);
  });

  test('Stop during the policy lookup finishes as cancelled', async () => {
    let lookupStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    mockDataPolicyMessage.mockImplementationOnce(
      (_model, _env, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve(undefined), {
            once: true,
          });
          lookupStarted();
        }),
    );
    const actual = jest.requireActual<typeof CursorEventsModule>(
      '@canopy/desktop-shared/node/cursor/events',
    );
    jest
      .mocked(CursorEventProjection)
      .mockImplementationOnce(() => new actual.CursorEventProjection());
    const turn = startTurn({ model: 'cursor:' + encodeURIComponent(gptRaw) });
    try {
      await turn.promptStarted;
      mockAcpCallbacks.current?.onUpdate({
        sessionId: 'session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: '\n\nCheck your settings to continue',
          },
        },
      });
      await started;
      await turn.cancel();
      expect(await turn.terminal).toMatchObject({
        type: 'result',
        is_error: false,
        subtype: 'cancelled',
        result: 'Turn cancelled',
      });
      expect(turn.events.filter((event) => event.type === 'error')).toEqual([]);
    } finally {
      await turn.destroy();
    }
  });

  test('other account actions never trigger the lookup', async () => {
    expect(
      await refusedTurn('\n\nUpgrade your plan to continue'),
    ).toMatchObject({
      type: 'error',
      error:
        "Your Cursor plan doesn't include this request. Upgrade your plan or choose another model.",
    });
    expect(mockDataPolicyMessage).not.toHaveBeenCalled();
  });
});

test('getProviderSessionId reflects the live Cursor session id while a turn is in flight, not only after it resolves', async () => {
  mockPreferences.cursorEnabled = true;
  jest.mocked(getManagedCursorRuntime).mockResolvedValue({
    launch: { command: '/mock/cursor-agent', prefix: [] },
    env: {},
    target: mockCursorTarget,
  });
  jest.mocked(verifyCursorVersion).mockResolvedValue(undefined);
  let signalPrompt: () => void = () => {};
  const promptStarted = new Promise<void>((resolve) => {
    signalPrompt = resolve;
  });
  mockPrompt.mockImplementation(
    (_params: unknown, _generation: unknown, signal: AbortSignal) => {
      signalPrompt();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
        setTimeout(() => resolve({ stopReason: 'end_turn' }), 50);
      });
    },
  );
  let finish: (event: Record<string, unknown>) => void = () => {};
  const terminal = new Promise<Record<string, unknown>>((resolve) => {
    finish = resolve;
  });
  const session = new CursorProvider().createSession(
    {
      cwd: '/mock',
      projectId: 'code',
      worktreeId: 'main',
      chatId: 'cursor',
      model: 'cursor-default',
    },
    (data) => {
      if (
        typeof data === 'object' &&
        data !== null &&
        'type' in data &&
        (data.type === 'result' || data.type === 'error')
      ) {
        finish({ ...data });
      }
    },
    () => null,
  );
  try {
    session.sendMessage('Hello');
    await promptStarted;
    // The session was created (mockNewSession resolves 'session') before the
    // prompt was sent — getProviderSessionId() must already report it here,
    // mid-turn, not only after the turn resolves. Three call sites depend on
    // this as an owner-bound fallback specifically to survive renderer-write
    // timing during an in-flight turn.
    expect(session.getProviderSessionId?.()).toBe('session');
    await terminal;
    expect(session.getProviderSessionId?.()).toBe('session');
  } finally {
    await session.destroy();
  }
});

test('Cursor sends the fork snapshot to a new independent session and does not resend it next turn', async () => {
  mockReadChatTabsFile.mockResolvedValue({
    version: 1,
    activeTabId: 'cursor',
    tabs: [
      {
        id: 'cursor',
        title: 'Fork',
        createdAt: '2026-09-15T00:00:00Z',
        model: 'cursor-default',
        providerType: 'cursor',
        forkedFrom: {
          projectId: 'code',
          worktreeId: 'main',
          chatId: 'source',
          atMessageId: 'prior-answer',
        },
        messages: [
          {
            id: 'prior-question',
            role: 'user',
            timestamp: 1,
            blocks: [
              { type: 'text', text: 'Remember the project code: ORCHID-62.' },
            ],
          },
          {
            id: 'prior-answer',
            role: 'assistant',
            timestamp: 2,
            blocks: [{ type: 'text', text: 'I will remember ORCHID-62.' }],
          },
          {
            id: 'new-request',
            role: 'user',
            timestamp: 3,
            blocks: [
              {
                type: 'text',
                text: 'A later message is outside the fork snapshot.',
              },
            ],
          },
        ],
      },
    ],
  });
  const turn = startTurn();
  try {
    expect(await turn.terminal).toMatchObject({
      type: 'result',
      is_error: false,
    });
    const prompt = JSON.stringify(mockPrompt.mock.calls[0]?.[0].prompt);
    expect(prompt).toContain('ORCHID-62');
    expect(prompt).not.toContain('A later message');
    expect(mockLoadSession).not.toHaveBeenCalled();
    await turn.sendNextMessage();
    expect(JSON.stringify(mockPrompt.mock.calls[1]?.[0].prompt)).not.toContain(
      'ORCHID-62',
    );
  } finally {
    await turn.destroy();
  }
});

function seedForkSnapshot(anchor: string | undefined = 'inherited'): void {
  mockReadChatTabsFile.mockResolvedValue({
    version: 1,
    activeTabId: 'cursor',
    tabs: [
      {
        id: 'cursor',
        title: 'Fork',
        createdAt: '2026-09-15T00:00:00Z',
        model: 'cursor-default',
        providerType: 'cursor',
        forkedFrom: {
          projectId: 'code',
          worktreeId: 'main',
          chatId: 'source',
          atMessageId: anchor,
        },
        messages: [
          {
            id: 'inherited',
            role: 'user',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'Remember ORCHID-62.' }],
          },
        ],
      },
    ],
  });
}

test('Cursor resumes an undelivered fork after restart even when its native session was created', async () => {
  seedForkSnapshot();
  const turn = startTurn({ sdkSessionId: 'created-before-interruption' });
  try {
    expect(await turn.terminal).toMatchObject({
      type: 'result',
      is_error: false,
    });
    expect(JSON.stringify(mockPrompt.mock.calls[0]?.[0].prompt)).toContain(
      'ORCHID-62',
    );
    expect(mockReadChatTabsFile).toHaveBeenCalledWith('code', 'main', {
      chatIds: ['cursor'],
      fullTranscript: true,
    });
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('fork-context-delivered'),
      'created-before-interruption',
      { mode: 0o600 },
    );
  } finally {
    await turn.destroy();
  }
});

test('Cursor preserves a whole-chat fork without an anchor and excludes the current request', async () => {
  seedForkSnapshot();
  const snapshot = await mockReadChatTabsFile('code', 'main');
  const tab = snapshot.tabs[0];
  if (!tab?.forkedFrom) throw new Error('missing test fork');
  delete tab.forkedFrom.atMessageId;
  tab.messages.push({
    id: 'current-turn',
    role: 'user',
    timestamp: 2,
    blocks: [{ type: 'text', text: 'CURRENT_REQUEST_NOT_HISTORY' }],
  });
  const turn = startTurn({}, 'current-turn');
  try {
    expect(await turn.terminal).toMatchObject({
      type: 'result',
      is_error: false,
    });
    const prompt = JSON.stringify(mockPrompt.mock.calls[0]?.[0].prompt);
    expect(prompt).toContain('ORCHID-62');
    expect(prompt).not.toContain('CURRENT_REQUEST_NOT_HISTORY');
  } finally {
    await turn.destroy();
  }
});

test('Cursor retains message-level attachments including attachment-only messages', async () => {
  seedForkSnapshot();
  const snapshot = await mockReadChatTabsFile('code', 'main');
  const tab = snapshot.tabs[0];
  if (!tab?.forkedFrom) throw new Error('missing test fork');
  tab.messages[0].attachmentPaths = ['/tmp/requirements.pdf'];
  tab.messages.push({
    id: 'attachment-only',
    role: 'user',
    timestamp: 2,
    blocks: [],
    attachmentPaths: ['/tmp/architecture.png'],
  });
  tab.forkedFrom.atMessageId = 'attachment-only';
  const turn = startTurn();
  try {
    expect(await turn.terminal).toMatchObject({
      type: 'result',
      is_error: false,
    });
    const prompt = JSON.stringify(mockPrompt.mock.calls[0]?.[0].prompt);
    expect(prompt).toContain('/tmp/requirements.pdf');
    expect(prompt).toContain('/tmp/architecture.png');
  } finally {
    await turn.destroy();
  }
});

test.each(['max_tokens', 'max_turn_requests'])(
  'Cursor does not resend accepted fork history after %s',
  async (stopReason) => {
    seedForkSnapshot();
    promptStopReason = stopReason;
    const turn = startTurn();
    try {
      expect(await turn.terminal).toMatchObject({ type: 'error' });
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining('fork-context-delivered'),
        'session',
        { mode: 0o600 },
      );
      promptStopReason = 'end_turn';
      expect(await turn.sendNextMessage()).toMatchObject({
        type: 'result',
        is_error: false,
      });
      expect(
        JSON.stringify(mockPrompt.mock.calls[1]?.[0].prompt),
      ).not.toContain('ORCHID-62');
    } finally {
      promptStopReason = 'end_turn';
      await turn.destroy();
    }
  },
);

test('Cursor does not replay an already delivered fork after restarting the app', async () => {
  seedForkSnapshot();
  jest.mocked(readFile).mockResolvedValueOnce('persisted-session');
  const turn = startTurn({ sdkSessionId: 'persisted-session' });
  try {
    expect(await turn.terminal).toMatchObject({
      type: 'result',
      is_error: false,
    });
    expect(JSON.stringify(mockPrompt.mock.calls[0]?.[0].prompt)).not.toContain(
      'ORCHID-62',
    );
  } finally {
    await turn.destroy();
  }
});

test('Cursor refuses a fork with a missing snapshot anchor instead of silently forgetting history', async () => {
  seedForkSnapshot('missing');
  const turn = startTurn();
  try {
    const terminal = await turn.terminal;
    expect(terminal.type).toBe('error');
    expect(terminal.error).toContain('forked conversation');
    expect(mockPrompt).not.toHaveBeenCalled();
  } finally {
    await turn.destroy();
  }
});

test('Cursor refuses to replay fork context after an uncertain prompt acknowledgement', async () => {
  seedForkSnapshot();
  const turn = startTurn();
  mockPrompt.mockRejectedValueOnce(new Error('transport closed'));
  try {
    expect(await turn.terminal).toMatchObject({ type: 'error' });
    const retry = await turn.sendNextMessage();
    expect(retry.type).toBe('error');
    expect(retry.error).toContain('could not be confirmed');
    expect(mockPrompt).toHaveBeenCalledTimes(1);
  } finally {
    await turn.destroy();
  }
});

test('Cursor refuses uncertain fork delivery after restart even when the native session changes', async () => {
  seedForkSnapshot();
  jest
    .mocked(readFile)
    .mockRejectedValueOnce(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    )
    .mockResolvedValueOnce('previous-native-session');
  const turn = startTurn({ sdkSessionId: 'replacement-native-session' });
  try {
    const terminal = await turn.terminal;
    expect(terminal.type).toBe('error');
    expect(terminal.error).toContain('could not be confirmed');
    expect(mockPrompt).not.toHaveBeenCalled();
  } finally {
    await turn.destroy();
  }
});

test('Cursor applies the fork size limit to the encoded payload including instructions', async () => {
  seedForkSnapshot();
  const snapshot = await mockReadChatTabsFile('code', 'main');
  const message = snapshot.tabs[0]?.messages[0];
  if (!message) throw new Error('missing snapshot');
  message.blocks = [{ type: 'text', text: 'x'.repeat(1024 * 1024 - 200) }];
  const turn = startTurn();
  try {
    const terminal = await turn.terminal;
    expect(terminal.type).toBe('error');
    expect(terminal.error).toContain('too large');
    expect(mockPrompt).not.toHaveBeenCalled();
  } finally {
    await turn.destroy();
  }
});

test('Cursor bounds oversized fork context without silently truncating it', async () => {
  seedForkSnapshot();
  const snapshot = await mockReadChatTabsFile('code', 'main');
  const inherited = snapshot.tabs[0]?.messages[0];
  if (!inherited) throw new Error('missing test transcript');
  inherited.blocks = [{ type: 'text', text: 'x'.repeat(1024 * 1024 + 1) }];
  const turn = startTurn();
  try {
    const terminal = await turn.terminal;
    expect(terminal.type).toBe('error');
    expect(terminal.error).toContain('too large');
    expect(mockPrompt).not.toHaveBeenCalled();
  } finally {
    await turn.destroy();
  }
});

test('Cursor keeps the existing handoff for a continuation from another provider', async () => {
  seedForkSnapshot();
  const snapshot = await mockReadChatTabsFile('code', 'main');
  const fork = snapshot.tabs[0]?.forkedFrom;
  if (!fork) throw new Error('missing test fork');
  fork.continuedFromProvider = 'claude';
  const turn = startTurn();
  try {
    expect(await turn.terminal).toMatchObject({
      type: 'result',
      is_error: false,
    });
    expect(JSON.stringify(mockPrompt.mock.calls[0]?.[0].prompt)).not.toContain(
      'ORCHID-62',
    );
  } finally {
    await turn.destroy();
  }
});

test('Cursor clears the prior response usage before a new turn fails initialization', async () => {
  const turn = startTurn();
  try {
    expect(await turn.terminal).toMatchObject({
      type: 'result',
      is_error: false,
    });
    turn.events.length = 0;
    jest
      .mocked(verifyCursorVersion)
      .mockRejectedValueOnce(new Error('runtime unavailable'));
    expect(await turn.sendNextMessage()).toMatchObject({ type: 'error' });
    expect(turn.events[0]).toMatchObject({
      type: 'canopy_cursor_usage',
      usage: null,
    });
  } finally {
    await turn.destroy();
  }
});

test('Cursor continues when its optional usage callback cannot start', async () => {
  const failure = jest
    .spyOn(CursorUsageHook, 'createCursorUsageHook')
    .mockRejectedValueOnce(new Error('usage callback unavailable'));
  const turn = startTurn();
  try {
    expect(await turn.terminal).toMatchObject({
      type: 'result',
      is_error: false,
    });
    expect(mockPrompt).toHaveBeenCalledTimes(1);
    const config = jest
      .mocked(writeFile)
      .mock.calls.find(
        ([file]) => typeof file === 'string' && file.endsWith('hooks.json'),
      )?.[1];
    expect(config).not.toContain('usage-hook.cjs');
  } finally {
    failure.mockRestore();
    await turn.destroy();
  }
});

test.each(['usage-hook.cjs', 'usage-connection.json'])(
  'Cursor continues with approvals when optional %s cannot be written',
  async (filename) => {
    const close = jest.fn(() => Promise.resolve());
    const usage = jest
      .spyOn(CursorUsageHook, 'createCursorUsageHook')
      .mockResolvedValueOnce({
        url: 'http://127.0.0.1:1/hook',
        token: 'unused-usage-token',
        revoke: jest.fn(),
        close,
      });
    jest
      .mocked(writeFile)
      .mockImplementation((file) =>
        typeof file === 'string' && file.endsWith(`/${filename}`)
          ? Promise.reject(new Error('usage file is not writable'))
          : Promise.resolve(),
      );
    const turn = startTurn();
    try {
      expect(await turn.terminal).toMatchObject({
        type: 'result',
        is_error: false,
      });
      expect(mockPrompt).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(close.mock.invocationCallOrder[0]).toBeLessThan(
        mockPrompt.mock.invocationCallOrder[0],
      );
      const config = jest
        .mocked(writeFile)
        .mock.calls.find(
          ([file]) => typeof file === 'string' && file.endsWith('/hooks.json'),
        )?.[1];
      if (typeof config !== 'string') throw new Error('Missing hooks config');
      expect(JSON.parse(config)).toEqual({
        version: 1,
        hooks: {
          preToolUse: [
            expect.objectContaining({ failClosed: true, timeout: 75 }),
          ],
        },
      });
    } finally {
      usage.mockRestore();
      jest.mocked(writeFile).mockImplementation(() => Promise.resolve());
      await turn.destroy();
    }
  },
);

test.each(['approval-hook.cjs', 'connection.json'])(
  'Cursor still stops when required %s cannot be written',
  async (filename) => {
    jest
      .mocked(writeFile)
      .mockImplementation((file) =>
        typeof file === 'string' && file.endsWith(`/${filename}`)
          ? Promise.reject(new Error('approval file is not writable'))
          : Promise.resolve(),
      );
    const turn = startTurn();
    try {
      expect(await turn.terminal).toMatchObject({
        type: 'error',
        error: 'approval file is not writable',
      });
      expect(mockPrompt).not.toHaveBeenCalled();
    } finally {
      jest.mocked(writeFile).mockImplementation(() => Promise.resolve());
      await turn.destroy();
    }
  },
);

function startTurn(
  overrides: Partial<Parameters<CursorProvider['createSession']>[0]> = {},
  userMessageId?: string,
  message = 'Hello',
): {
  events: Record<string, unknown>[];
  terminal: Promise<Record<string, unknown>>;
  promptStarted: Promise<void>;
  cancel: () => Promise<void>;
  destroy: () => Promise<void>;
  setRtkEnabled: (enabled: boolean) => Promise<void>;
  setModel: (model: string) => Promise<void>;
  setThinkingLevel: (level: ThinkingLevel) => Promise<void>;
  sendNextMessage: () => Promise<Record<string, unknown>>;
} {
  mockPreferences.cursorEnabled = true;
  jest.mocked(getManagedCursorRuntime).mockResolvedValue({
    launch: { command: '/mock/cursor-agent', prefix: [] },
    env: {},
    target: mockCursorTarget,
  });
  jest.mocked(verifyCursorVersion).mockResolvedValue(undefined);
  let signalPrompt: () => void = () => {};
  const promptStarted = new Promise<void>((resolve) => {
    signalPrompt = resolve;
  });
  mockPrompt.mockImplementation(
    (_params: unknown, _generation: unknown, signal: AbortSignal) => {
      signalPrompt();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
        setTimeout(() => resolve({ stopReason: promptStopReason }), 50);
      });
    },
  );
  let finish: (event: Record<string, unknown>) => void = () => {};
  const terminal = new Promise<Record<string, unknown>>((resolve) => {
    finish = resolve;
  });
  const events: Record<string, unknown>[] = [];
  const session = new CursorProvider().createSession(
    {
      cwd: '/mock',
      projectId: 'code',
      worktreeId: 'main',
      chatId: 'cursor',
      model: 'cursor-default',
      ...overrides,
    },
    (data) => {
      if (typeof data === 'object' && data !== null && 'type' in data) {
        const event: Record<string, unknown> = { ...data };
        events.push(event);
        if (event.type === 'result' || event.type === 'error') finish(event);
      }
    },
    () => null,
  );
  session.sendMessage(message, { userMessageId });
  return {
    events,
    terminal,
    promptStarted,
    cancel: (): Promise<void> => session.cancel(),
    destroy: (): Promise<void> => session.destroy(),
    setModel: (model: string): Promise<void> => session.setModel(model),
    setThinkingLevel: (level: ThinkingLevel): Promise<void> =>
      session.setThinkingLevel(level),
    sendNextMessage: (): Promise<Record<string, unknown>> =>
      new Promise((resolve) => {
        finish = resolve;
        session.sendMessage('Next message');
      }),
    setRtkEnabled: (enabled: boolean): Promise<void> =>
      session.setRtkEnabled
        ? session.setRtkEnabled(enabled)
        : Promise.reject(new Error('Cursor session lacks setRtkEnabled')),
  };
}

test('binds the owning turn signal to the production Cursor MCP route', async () => {
  const turn = startTurn();
  try {
    await turn.promptStarted;
    const route =
      mockProxy.registerCanopyWorktreeSessionRoute.mock.calls[0]?.[0];
    if (!route?.turnSignal) throw new Error('Missing owning turn signal');
    expect(route.turnSignal.aborted).toBe(false);
    await turn.cancel();
    expect(route.turnSignal.aborted).toBe(true);
    await turn.terminal;
  } finally {
    await turn.destroy();
  }
});

function projectedToolUseIds(events: Record<string, unknown>[]): string[] {
  const ids: string[] = [];
  for (const event of events) {
    if (!Array.isArray(event.patches)) continue;
    for (const item of event.patches) {
      const patch: unknown = item;
      if (typeof patch !== 'object' || patch === null || !('block' in patch))
        continue;
      const block = patch.block;
      if (
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'tool_use' &&
        'toolUseId' in block &&
        typeof block.toolUseId === 'string'
      )
        ids.push(block.toolUseId);
    }
  }
  return ids;
}

describe('Cursor visual tool identity', () => {
  const target = { projectId: 'code', worktreeId: 'main', chatId: 'cursor' };
  const main = BRAND.tools.namespace;

  test.each([
    [
      'genuine',
      `${main}: ShowVisual`,
      { providerIdentifier: main, toolName: 'ShowVisual' },
      true,
    ],
    ['title only', `${main}: ShowVisual`, undefined, false],
    [
      'mismatched title',
      `${main}: ShowFiles`,
      { providerIdentifier: main, toolName: 'ShowVisual' },
      false,
    ],
    [
      'another server',
      `${main}: ShowVisual`,
      { providerIdentifier: 'plugin', toolName: 'ShowVisual' },
      false,
    ],
  ])(
    '%s invocation is admitted only with matching structured identity',
    async (_case, title, rawInput, expected) => {
      mockRealProjection.enabled = true;
      const turn = startTurn();
      try {
        await turn.promptStarted;
        mockAcpCallbacks.current?.onUpdate({
          sessionId: 'session',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'visual-1',
            title,
            kind: 'other',
            status: 'in_progress',
            ...(rawInput ? { rawInput } : {}),
          },
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        const id = projectedToolUseIds(turn.events)[0];
        expect(id).toEqual(expect.any(String));
        expect(hasTrustedVisualToolUse(target, id)).toBe(expected);
        await turn.terminal;
        expect(hasTrustedVisualToolUse(target, id)).toBe(false);
      } finally {
        await turn.destroy();
      }
    },
  );

  test('reused ACP call IDs receive independent persisted UUIDs', async () => {
    mockRealProjection.enabled = true;
    const turn = startTurn();
    try {
      await turn.promptStarted;
      for (let index = 0; index < 2; index += 1)
        mockAcpCallbacks.current?.onUpdate({
          sessionId: 'session',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'reused-acp-id',
            title: `${main}: ShowVisual`,
            kind: 'other',
            status: 'in_progress',
            rawInput: { providerIdentifier: main, toolName: 'ShowVisual' },
          },
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const ids = projectedToolUseIds(turn.events);
      expect(ids).toHaveLength(2);
      expect(ids[0]).not.toBe(ids[1]);
      expect(ids.every((id) => hasTrustedVisualToolUse(target, id))).toBe(true);
      await turn.terminal;
    } finally {
      await turn.destroy();
    }
  });

  test('App Advisor cannot record a worktree ShowVisual invocation', async () => {
    mockRealProjection.enabled = true;
    const turn = startTurn({
      assistantMode: 'app-advisor',
      appAdvisorRuntime: {
        watcherDestination: target,
      },
    });
    try {
      await turn.promptStarted;
      mockAcpCallbacks.current?.onUpdate({
        sessionId: 'session',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'advisor-visual',
          title: `${main}: ShowVisual`,
          kind: 'other',
          status: 'in_progress',
          rawInput: { providerIdentifier: main, toolName: 'ShowVisual' },
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const id = projectedToolUseIds(turn.events)[0];
      expect(id).toEqual(expect.any(String));
      expect(hasTrustedVisualToolUse(target, id)).toBe(false);
      await turn.terminal;
    } finally {
      await turn.destroy();
    }
  });

  test('does not trust the main server when HTTP app tools never reached the CLI', async () => {
    mockRealProjection.enabled = true;
    mockInitialization.agentCapabilities = {};
    const turn = startTurn();
    try {
      await turn.promptStarted;
      mockAcpCallbacks.current?.onUpdate({
        sessionId: 'session',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'unavailable-visual',
          title: `${main}: ShowVisual`,
          kind: 'other',
          status: 'in_progress',
          rawInput: { providerIdentifier: main, toolName: 'ShowVisual' },
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const id = projectedToolUseIds(turn.events)[0];
      expect(id).toEqual(expect.any(String));
      expect(hasTrustedVisualToolUse(target, id)).toBe(false);
      await turn.terminal;
    } finally {
      await turn.destroy();
    }
  });

  test('keeps the ledger open through the final chat-event drain', async () => {
    mockRealProjection.enabled = true;
    const seenDuringDrain: boolean[] = [];
    let id = '';
    jest.mocked(drainChatSessionEvents).mockImplementation(() => {
      if (id) seenDuringDrain.push(hasTrustedVisualToolUse(target, id));
      return Promise.resolve();
    });
    const turn = startTurn();
    try {
      await turn.promptStarted;
      mockAcpCallbacks.current?.onUpdate({
        sessionId: 'session',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'drain-visual',
          title: `${main}: ShowVisual`,
          kind: 'other',
          status: 'in_progress',
          rawInput: { providerIdentifier: main, toolName: 'ShowVisual' },
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      id = projectedToolUseIds(turn.events)[0] ?? '';
      expect(hasTrustedVisualToolUse(target, id)).toBe(true);
      await turn.terminal;
      expect(seenDuringDrain.length).toBeGreaterThan(0);
      expect(seenDuringDrain.at(-1)).toBe(true);
      expect(hasTrustedVisualToolUse(target, id)).toBe(false);
    } finally {
      await turn.destroy();
    }
  });

  test('a failed tool result retains identity until its admitted result drains', async () => {
    mockRealProjection.enabled = true;
    mockApprovalCheck.mockResolvedValue({ decision: 'deny' });
    const turn = startTurn();
    try {
      await turn.promptStarted;
      const callbacks = mockAcpCallbacks.current;
      if (!callbacks) throw new Error('ACP callbacks missing');
      callbacks.onUpdate({
        sessionId: 'session',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'failed-visual',
          title: `${main}: ShowVisual`,
          kind: 'other',
          status: 'in_progress',
          rawInput: { providerIdentifier: main, toolName: 'ShowVisual' },
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const id = projectedToolUseIds(turn.events)[0] ?? '';
      expect(hasTrustedVisualToolUse(target, id)).toBe(true);
      expect(
        await callbacks.onPermission({
          request: {
            toolCall: {
              toolCallId: 'failed-visual',
              title: `${main}: ShowVisual`,
              kind: 'other',
            },
          },
          signal: new AbortController().signal,
        }),
      ).toBe('deny');
      callbacks.onUpdate({
        sessionId: 'session',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'failed-visual',
          status: 'failed',
          rawOutput: { isError: true },
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        turn.events.some(
          (event) =>
            Array.isArray(event.patches) &&
            event.patches.some(
              (patch: unknown) =>
                typeof patch === 'object' &&
                patch !== null &&
                'block' in patch &&
                typeof patch.block === 'object' &&
                patch.block !== null &&
                'type' in patch.block &&
                patch.block.type === 'tool_result',
            ),
        ),
      ).toBe(true);
      await turn.terminal;
      expect(hasTrustedVisualToolUse(target, id)).toBe(false);
    } finally {
      await turn.destroy();
    }
  });
});

const shellPayload = {
  hook_event_name: 'preToolUse',
  tool_name: 'Shell',
  tool_input: { command: 'git status', cwd: '/mock' },
  tool_use_id: 'shell-1',
};
const rewrittenShellInput = { command: 'rtk git status', cwd: '/mock' };

test.each(['allow', 'deny', 'rewritten'] as const)(
  'the pinned Shell ACP shape matches a separate hook id after %s',
  async (decision) => {
    mockAuthorizeCursorTool.mockResolvedValueOnce({
      decision: decision === 'deny' ? 'deny' : 'allow',
    });
    if (decision === 'rewritten')
      mockRewriteCursorShellInput.mockResolvedValueOnce(rewrittenShellInput);
    mockProjectionGetTool.mockReturnValue({
      name: '`git status`',
      input: { command: 'git status' },
      kind: 'execute',
    });
    const turn = startTurn();
    try {
      await turn.promptStarted;
      const callbacks = mockAcpCallbacks.current;
      if (!callbacks || !mockHook.authorize)
        throw new Error('callbacks were not captured');
      await mockHook.authorize({
        ...shellPayload,
        tool_input: { ...shellPayload.tool_input, timeout: 30000 },
        tool_use_id: 'native-hook-random-id',
      });
      // Cursor sends completed even when its native hook rejected the tool.
      // Shell ACP omits cwd/timeout and its id differs from the hook id.
      callbacks.onUpdate({
        sessionId: 'session',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'acp-shell-id',
          status: 'completed',
          ...(decision === 'rewritten'
            ? { rawInput: { command: rewrittenShellInput.command } }
            : {}),
        },
      });
      expect(await turn.terminal).toMatchObject({
        type: 'result',
        is_error: false,
      });
    } finally {
      await turn.destroy();
    }
  },
);

test('a Shell observation cannot anchor a second execution of the same command', async () => {
  mockProjectionGetTool.mockReturnValue({
    name: 'Shell',
    input: { command: 'git status' },
    kind: 'execute',
  });
  const turn = startTurn();
  try {
    await turn.promptStarted;
    const callbacks = mockAcpCallbacks.current;
    if (!callbacks || !mockHook.authorize)
      throw new Error('callbacks were not captured');
    await mockHook.authorize(shellPayload);
    callbacks.onUpdate(completion('shell-1', 'execute'));
    callbacks.onUpdate(completion('shell-2', 'execute'));
    expect(mockProjectionUpdate).toHaveBeenCalledTimes(1);
    const failureText: unknown = expect.stringContaining(
      'without reaching the approval hook',
    );
    expect(await turn.terminal).toMatchObject({
      type: 'error',
      error: failureText,
    });
  } finally {
    await turn.destroy();
  }
});

test('a reused hook id cannot anchor a different Shell command', async () => {
  mockProjectionGetTool.mockReturnValue({
    name: 'Shell',
    input: { command: 'rm -rf build' },
    kind: 'execute',
  });
  const turn = startTurn();
  try {
    await turn.promptStarted;
    const callbacks = mockAcpCallbacks.current;
    if (!callbacks || !mockHook.authorize)
      throw new Error('callbacks were not captured');
    await mockHook.authorize(shellPayload);
    callbacks.onUpdate(completion(shellPayload.tool_use_id, 'execute'));
    const failureText: unknown = expect.stringContaining(
      'without reaching the approval hook',
    );
    expect(await turn.terminal).toMatchObject({
      type: 'error',
      error: failureText,
    });
  } finally {
    await turn.destroy();
  }
});

test('an MCP hook payload never anchors a native completion with the same input', async () => {
  // The CLI runs preToolUse for MCP tools as `MCP:<tool>` with the tool's
  // arguments and a hook-only id. Those arguments must not satisfy the
  // anchor's input fallback for a later native tool that skipped the hook.
  mockProjectionGetTool.mockReturnValue({
    name: 'shell',
    input: { command: 'rm -rf build' },
    kind: 'execute',
  });
  const turn = startTurn();
  try {
    await turn.promptStarted;
    if (!mockHook.authorize) throw new Error('hook was not captured');
    expect(
      await mockHook.authorize({
        hook_event_name: 'preToolUse',
        tool_name: 'MCP:run_command',
        tool_input: { command: 'rm -rf build' },
        tool_use_id: 'hook-only-id',
      }),
    ).toMatchObject({ decision: 'allow' });
    const callbacks = mockAcpCallbacks.current;
    if (!callbacks) throw new Error('ACP callbacks were not captured');
    callbacks.onUpdate(completion('tool-1', 'execute'));
    const failureText: unknown = expect.stringContaining(
      'without reaching the approval hook',
    );
    expect(await turn.terminal).toMatchObject({
      type: 'error',
      error: failureText,
    });
  } finally {
    await turn.destroy();
  }
});

test('an allowed Shell command carries the RTK rewrite through the hook', async () => {
  mockRewriteCursorShellInput.mockResolvedValueOnce(rewrittenShellInput);
  const turn = startTurn({ rtkEnabled: true });
  try {
    await turn.promptStarted;
    if (!mockHook.authorize) throw new Error('hook was not captured');
    expect(await mockHook.authorize(shellPayload)).toEqual({
      decision: 'allow',
      updatedInput: rewrittenShellInput,
    });
    const rtkEnv: unknown = expect.objectContaining({
      HOME: '/user-home',
      RTK_DB_PATH: '/mock/rtk/history.db',
    });
    const rtkOptions: unknown = expect.objectContaining({
      rtkBinaryPath: '/mock/bin/rtk',
      env: rtkEnv,
    });
    expect(mockRewriteCursorShellInput).toHaveBeenCalledWith(
      shellPayload,
      rtkOptions,
    );
  } finally {
    await turn.destroy();
  }
});

test('RTK stays out of the hook while the preference is off, and follows the live toggle', async () => {
  mockRewriteCursorShellInput.mockResolvedValue(rewrittenShellInput);
  const turn = startTurn({ rtkEnabled: false });
  try {
    await turn.promptStarted;
    if (!mockHook.authorize) throw new Error('hook was not captured');
    expect(await mockHook.authorize(shellPayload)).toEqual({
      decision: 'allow',
    });
    expect(mockRewriteCursorShellInput).not.toHaveBeenCalled();
    await turn.setRtkEnabled(true);
    expect(await mockHook.authorize(shellPayload)).toEqual({
      decision: 'allow',
      updatedInput: rewrittenShellInput,
    });
  } finally {
    mockRewriteCursorShellInput.mockReset();
    mockRewriteCursorShellInput.mockResolvedValue(undefined);
    await turn.destroy();
  }
});

test('a denied or stopped Shell command never reaches RTK', async () => {
  mockRewriteCursorShellInput.mockResolvedValue(rewrittenShellInput);
  mockAuthorizeCursorTool.mockResolvedValueOnce({ decision: 'deny' });
  const turn = startTurn({ rtkEnabled: true });
  try {
    await turn.promptStarted;
    if (!mockHook.authorize) throw new Error('hook was not captured');
    expect(await mockHook.authorize(shellPayload)).toEqual({
      decision: 'deny',
    });
    mockAuthorizeCursorTool.mockResolvedValueOnce({
      decision: 'allow',
      stopTurn: true,
    });
    expect(await mockHook.authorize(shellPayload)).toEqual({
      decision: 'allow',
      stopTurn: true,
    });
    expect(mockRewriteCursorShellInput).not.toHaveBeenCalled();
  } finally {
    mockRewriteCursorShellInput.mockReset();
    mockRewriteCursorShellInput.mockResolvedValue(undefined);
    await turn.destroy();
  }
});

test('a completion carrying the rewritten command still anchors on the hook', async () => {
  mockRewriteCursorShellInput.mockResolvedValueOnce(rewrittenShellInput);
  mockProjectionGetTool.mockReturnValue({
    name: 'Shell',
    input: rewrittenShellInput,
    kind: 'execute',
  });
  const turn = startTurn({ rtkEnabled: true });
  try {
    await turn.promptStarted;
    const callbacks = mockAcpCallbacks.current;
    if (!callbacks || !mockHook.authorize)
      throw new Error('callbacks were not captured');
    await mockHook.authorize(shellPayload);
    // The CLI reported the rewritten input under a different tool-call id, so
    // only the recorded rewrite can prove the hook saw this execution.
    callbacks.onUpdate(completion('acp-shell-2', 'execute'));
    expect(await turn.terminal).toMatchObject({
      type: 'result',
      is_error: false,
    });
  } finally {
    await turn.destroy();
  }
});

test('a saved session that cannot be loaded falls back to a fresh session and says so', async () => {
  mockLoadSession.mockRejectedValueOnce(new Error('unknown session'));
  const notice = { type: 'canopy_assistant_patch', patches: [] };
  mockProjectionNotice.mockReturnValueOnce(notice);
  const turn = startTurn({ sdkSessionId: 'stale-session' });
  try {
    const event = await turn.terminal;
    expect(event).toMatchObject({ type: 'result', is_error: false });
    expect(mockLoadSession).toHaveBeenCalledTimes(1);
    expect(mockNewSession).toHaveBeenCalledTimes(1);
    const noticeText: unknown = expect.stringContaining(
      'could not be restored',
    );
    expect(mockProjectionNotice).toHaveBeenCalledWith(noticeText);
    expect(turn.events).toContainEqual(expect.objectContaining(notice));
    expect(turn.events).toContainEqual(
      expect.objectContaining({ subtype: 'init', session_id: 'session' }),
    );
  } finally {
    await turn.destroy();
  }
});

function completion(
  toolCallId: string,
  kind?: string,
  status: 'completed' | 'failed' = 'completed',
  sessionUpdate: 'tool_call' | 'tool_call_update' = 'tool_call_update',
): unknown {
  return {
    sessionId: 'session',
    update: {
      sessionUpdate,
      toolCallId,
      title: 'Native tool',
      status,
      ...(kind ? { kind } : {}),
    },
  };
}

test.each([
  ['execute', { command: 'rm -rf build' }],
  ['edit', { file_path: '/mock/result.txt', content: 'x' }],
  ['delete', { file_path: '/mock/result.txt' }],
  [undefined, { file_path: '/mock/result.txt' }],
])(
  'a %s tool that completes without the approval hook stops the session',
  async (kind, input) => {
    mockProjectionGetTool.mockReturnValue({ name: 'tool', input, kind });
    const turn = startTurn();
    try {
      await turn.promptStarted;
      const callbacks = mockAcpCallbacks.current;
      if (!callbacks) throw new Error('ACP callbacks were not captured');
      if (kind === 'execute')
        expect(
          await callbacks.onPermission({
            request: { toolCall: { toolCallId: 'tool-1' } },
            signal: new AbortController().signal,
          }),
        ).toBe('allow');
      callbacks.onUpdate(completion('tool-1'));
      const event = await turn.terminal;
      const failureText: unknown = expect.stringContaining(
        'without reaching the approval hook',
      );
      expect(event).toMatchObject({ type: 'error', error: failureText });
      expect(mockProjectionUpdate).not.toHaveBeenCalled();
    } finally {
      await turn.destroy();
    }
  },
);

test.each([
  ['the same tool id', 'tool-1'],
  ['a different id but the same input', 'cli-internal-7'],
])(
  'a completion the hook authorized under %s passes through',
  async (_label, hookId) => {
    const input = { command: 'ls', cwd: '/mock' };
    mockProjectionGetTool.mockReturnValue({
      name: 'Shell',
      input,
      kind: 'execute',
    });
    const turn = startTurn();
    try {
      await turn.promptStarted;
      const callbacks = mockAcpCallbacks.current;
      if (!callbacks || !mockHook.authorize)
        throw new Error('callbacks were not captured');
      await mockHook.authorize({
        hook_event_name: 'preToolUse',
        tool_name: 'Shell',
        tool_input: { cwd: '/mock', command: 'ls' },
        tool_use_id: hookId,
      });
      callbacks.onUpdate(completion('tool-1', 'execute'));
      const event = await turn.terminal;
      expect(event).toMatchObject({ type: 'result', is_error: false });
      expect(mockProjectionUpdate).toHaveBeenCalledTimes(1);
    } finally {
      await turn.destroy();
    }
  },
);

test('a projection limit failure surfaces its own message', async () => {
  mockProjectionUpdate.mockImplementationOnce(() => {
    throw new Error('Cursor response exceeded the local chat limit.');
  });
  const turn = startTurn();
  try {
    await turn.promptStarted;
    const callbacks = mockAcpCallbacks.current;
    if (!callbacks) throw new Error('ACP callbacks were not captured');
    callbacks.onUpdate({
      sessionId: 'session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'x' },
      },
    });
    expect(await turn.terminal).toMatchObject({
      type: 'error',
      error: 'Cursor response exceeded the local chat limit.',
    });
  } finally {
    await turn.destroy();
  }
});

test.each(
  (
    [
      ['read', 'completed'],
      ['search', 'completed'],
      ['fetch', 'completed'],
      ['read', 'failed'],
      ['search', 'failed'],
      ['fetch', 'failed'],
    ] as const
  ).flatMap(([kind, status]) =>
    (['tool_call', 'tool_call_update'] as const).map(
      (shape) => [kind, status, shape] as const,
    ),
  ),
)(
  'an unhooked %s %s %s completion stops the interactive session',
  async (kind, status, shape) => {
    mockProjectionGetTool.mockReturnValue({
      name: 'Unhooked tool',
      input: { file_path: '/mock/notes.md' },
      kind,
    });
    const turn = startTurn();
    try {
      await turn.promptStarted;
      const callbacks = mockAcpCallbacks.current;
      if (!callbacks) throw new Error('ACP callbacks were not captured');
      callbacks.onUpdate(completion('tool-1', kind, status, shape));
      const terminal = await turn.terminal;
      expect(terminal.type).toBe('error');
      expect(terminal.error).toContain('approval hook');
    } finally {
      await turn.destroy();
    }
  },
);

const emptyGrepStart = {
  sessionId: 'session',
  update: {
    sessionUpdate: 'tool_call',
    toolCallId: 'invalid-grep',
    title: 'grep',
    kind: 'search',
    status: 'pending',
    rawInput: {},
  },
};
const emptyGrepRejection = {
  sessionId: 'session',
  update: {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'invalid-grep',
    status: 'completed',
    rawOutput: { error: 'Invalid arguments:\npattern: Required' },
  },
};

test('a pinned empty Grep validation rejection remains a tool error and allows correction', async () => {
  mockRealProjection.enabled = true;
  const turn = startTurn();
  try {
    await turn.promptStarted;
    const callbacks = mockAcpCallbacks.current;
    if (!callbacks) throw new Error('ACP callbacks missing');
    callbacks.onUpdate(emptyGrepStart);
    callbacks.onUpdate(emptyGrepRejection);
    // A duplicate rejection is still only the same non-executing call.
    callbacks.onUpdate(emptyGrepRejection);
    expect(await turn.terminal).toMatchObject({
      type: 'result',
      is_error: false,
    });
    expect(mockAuthorizeCursorTool).not.toHaveBeenCalled();
    const transcript = JSON.stringify(turn.events);
    expect(transcript).toContain('Invalid arguments');
    expect(transcript).toContain('"isError":true');
  } finally {
    await turn.destroy();
  }
});

test.each([
  'no start',
  'started execution',
  'nonempty input',
  'changed input',
  'wrong tool',
  'wrong kind',
  'different error',
  'extra output',
  'content',
  'locations',
  'failed status',
  'terminal start',
  'successful repeat',
  'reused id',
])('the Grep validation exception rejects %s', async (variant) => {
  mockRealProjection.enabled = true;
  const turn = startTurn();
  try {
    await turn.promptStarted;
    const callbacks = mockAcpCallbacks.current;
    if (!callbacks) throw new Error('ACP callbacks missing');
    if (variant !== 'no start')
      callbacks.onUpdate({
        ...emptyGrepStart,
        update: {
          ...emptyGrepStart.update,
          ...(variant === 'nonempty input'
            ? { rawInput: { pattern: 'needle' } }
            : {}),
          ...(variant === 'wrong tool' ? { title: 'Write' } : {}),
          ...(variant === 'wrong kind' ? { kind: 'edit' } : {}),
        },
      });
    if (variant === 'started execution')
      callbacks.onUpdate({
        sessionId: 'session',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'invalid-grep',
          status: 'in_progress',
        },
      });
    if (variant === 'successful repeat' || variant === 'reused id')
      callbacks.onUpdate(emptyGrepRejection);
    if (variant === 'reused id')
      callbacks.onUpdate({
        ...emptyGrepStart,
        update: { ...emptyGrepStart.update, title: 'Write', kind: 'edit' },
      });
    callbacks.onUpdate({
      ...emptyGrepRejection,
      update: {
        ...emptyGrepRejection.update,
        ...(variant === 'changed input'
          ? { rawInput: { pattern: 'needle' } }
          : {}),
        ...(variant === 'different error'
          ? { rawOutput: { error: 'permission denied' } }
          : {}),
        ...(variant === 'extra output'
          ? {
              rawOutput: {
                ...emptyGrepRejection.update.rawOutput,
                matches: [],
              },
            }
          : {}),
        ...(variant === 'content'
          ? {
              content: [
                { type: 'content', content: { type: 'text', text: 'results' } },
              ],
            }
          : {}),
        ...(variant === 'locations'
          ? { locations: [{ path: '/mock/notes.md' }] }
          : {}),
        ...(variant === 'failed status' ? { status: 'failed' } : {}),
        ...(variant === 'terminal start' ? { sessionUpdate: 'tool_call' } : {}),
        ...(variant === 'successful repeat'
          ? { rawOutput: { totalMatches: 1 } }
          : {}),
      },
    });
    const terminal = await turn.terminal;
    expect(terminal.type).toBe('error');
    expect(terminal.error).toContain('approval hook');
  } finally {
    await turn.destroy();
  }
});

test.each(['think', 'switch_mode'] as const)(
  'a %s notification completes without a tool approval',
  async (kind) => {
    mockProjectionGetTool.mockReturnValue({
      name: 'Notification',
      input: {},
      kind,
    });
    const turn = startTurn();
    try {
      await turn.promptStarted;
      const callbacks = mockAcpCallbacks.current;
      if (!callbacks) throw new Error('ACP callbacks were not captured');
      callbacks.onUpdate(completion('notification-1', kind));
      expect(await turn.terminal).toMatchObject({
        type: 'result',
        is_error: false,
      });
    } finally {
      await turn.destroy();
    }
  },
);

test('an empty hook input cannot satisfy the fallback for an unseen completion', async () => {
  mockProjectionGetTool.mockReturnValue(undefined);
  const turn = startTurn();
  try {
    await turn.promptStarted;
    const callbacks = mockAcpCallbacks.current;
    if (!callbacks || !mockHook.authorize)
      throw new Error('callbacks were not captured');
    await mockHook.authorize({
      hook_event_name: 'preToolUse',
      tool_name: 'Write',
      tool_input: {},
      tool_use_id: '',
    });
    callbacks.onUpdate(completion('unseen-1', 'edit'));
    const failureText: unknown = expect.stringContaining(
      'without reaching the approval hook',
    );
    expect(await turn.terminal).toMatchObject({
      type: 'error',
      error: failureText,
    });
  } finally {
    await turn.destroy();
  }
});

test.each(['max_tokens', 'max_turn_requests'])(
  'a turn the CLI truncates with %s ends with an explicit message',
  async (stopReason) => {
    promptStopReason = stopReason;
    const turn = startTurn();
    try {
      await turn.promptStarted;
      expect(await turn.terminal).toMatchObject({
        type: 'error',
        error:
          'Cursor stopped early after reaching its turn limit. Send a follow-up to continue.',
      });
    } finally {
      promptStopReason = 'end_turn';
      await turn.destroy();
    }
  },
);

describe('MCP over ACP', () => {
  const ns = BRAND.tools.namespace;
  /** Text of the first prompt block Cursor received this turn. */
  function promptText(): string {
    const block = mockPrompt.mock.calls[0]?.[0]?.prompt[0];
    return block && block.type === 'text' ? block.text : '';
  }
  const anyBearer: unknown = expect.stringMatching(/^Bearer .{20,}$/);
  const canopyServers = [
    {
      type: 'http',
      name: ns,
      url: 'http://127.0.0.1:4/mcp/key',
      headers: [{ name: 'Authorization', value: anyBearer }],
    },
    {
      type: 'http',
      name: `${ns}_ui`,
      url: 'http://127.0.0.1:4/mcp/key/ui',
      headers: [{ name: 'Authorization', value: anyBearer }],
    },
  ];

  // App Advisor sessions: the proxy suite registers a partial runtime the
  // same way; only its identity reaches the route here.
  const advisorRuntime = {
    watcherDestination: {
      projectId: 'app-advisor',
      worktreeId: 'entry',
      chatId: 'cursor',
    },
  };
  const advisorSession = (): Partial<
    Parameters<CursorProvider['createSession']>[0]
  > => ({
    projectId: 'app-advisor',
    worktreeId: 'entry',
    assistantMode: 'app-advisor',
    appAdvisorRuntime: advisorRuntime,
    systemPromptAppend: 'APP ADVISOR SYSTEM PROMPT',
  });

  test('an App Advisor session registers the App Advisor route and servers', async () => {
    const turn = startTurn(advisorSession());
    try {
      await turn.promptStarted;
      expect(mockProxy.registerCanopyWorktreeSessionRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'app-advisor',
          worktreeId: 'entry',
          assistantMode: 'app-advisor',
          appAdvisorRuntime: advisorRuntime,
          providerType: 'cursor',
          deferredToolsAllowed: false,
        }),
      );
      const route =
        mockProxy.registerCanopyWorktreeSessionRoute.mock.calls[0]?.[0];
      expect(route?.toolSurface).toBeUndefined();
      const servers = mockNewSession.mock.calls[0]?.[0]?.mcpServers ?? [];
      expect(servers.map((server) => server.name)).toEqual([
        `${ns}_app_advisor`,
        `${ns}_ui`,
      ]);
      const text = promptText();
      expect(text).toContain('APP ADVISOR SYSTEM PROMPT');
      expect(text).toContain(`${ns}_app_advisor and ${ns}_ui`);
      expect(text).not.toContain('Use GetScriptOutput to inspect setup');
      expect(text).not.toContain('SaveMemory');
      // The App Advisor system prompt spells tools for Claude and Codex and
      // points at deferred loading, so Cursor gets its own short note.
      expect(text).toContain(`${ns}_app_advisor: <Name>`);
      expect(text).toContain(`${ns}_ui: AskUserQuestion`);
      expect(text).toContain(
        'SearchDeferredTools and LoadDeferredTools are unavailable',
      );
      await turn.terminal;
    } finally {
      await turn.destroy();
    }
  });

  test('an App Advisor session never opens the worktree Ledger tools', async () => {
    // The App Advisor tool set is its own surface; this worktree gate never
    // runs for it, even when the Ledger would be exposed.
    mockMayExposeLedgerTools.mockReturnValue(true);
    const turn = startTurn(advisorSession());
    try {
      expect(await turn.terminal).toMatchObject({ type: 'result' });
      expect(mockMayExposeLedgerTools).not.toHaveBeenCalled();
      expect(mockOpenLedgerChatTools).not.toHaveBeenCalled();
      const route =
        mockProxy.registerCanopyWorktreeSessionRoute.mock.calls[0]?.[0];
      expect(route).not.toHaveProperty('ledgerTools');
    } finally {
      mockMayExposeLedgerTools.mockReturnValue(false);
      await turn.destroy();
    }
  });

  test('an App Advisor session gates App Advisor tools through the shared approval card', async () => {
    mockApprovalCheck.mockResolvedValue({ decision: 'deny' });
    const turn = startTurn(advisorSession());
    try {
      await turn.promptStarted;
      const route =
        mockProxy.registerCanopyWorktreeSessionRoute.mock.calls[0]?.[0];
      if (!route?.authorizeToolCall) throw new Error('gate was not installed');
      expect(
        await route.authorizeToolCall('dispatch_action', {
          action: { type: 'navigation.open_settings' },
        }),
      ).toBe(false);
      expect(mockApprovalCheck).toHaveBeenCalledWith(
        { kind: 'mcp', server: `${ns}_app_advisor`, tool: 'DispatchAction' },
        expect.objectContaining({
          title: 'Cursor wants to use DispatchAction',
        }),
      );
      mockApprovalCheck.mockResolvedValue({ decision: 'allow' });
      expect(
        await route.authorizeToolCall('ask_user_question', { questions: [] }),
      ).toBe(true);
      expect(mockApprovalCheck).toHaveBeenLastCalledWith(
        { kind: 'mcp', server: `${ns}_ui`, tool: 'AskUserQuestion' },
        expect.anything(),
      );
      await turn.terminal;
    } finally {
      await turn.destroy();
    }
  });

  test('an App Advisor session without HTTP MCP support runs with native tools only', async () => {
    mockInitialization.agentCapabilities = {};
    const turn = startTurn(advisorSession());
    try {
      await turn.promptStarted;
      expect(
        mockProxy.registerCanopyWorktreeSessionRoute,
      ).not.toHaveBeenCalled();
      expect(promptText()).toContain('APP ADVISOR SYSTEM PROMPT');
      expect(await turn.terminal).toMatchObject({
        type: 'result',
        is_error: false,
      });
    } finally {
      await turn.destroy();
    }
  });

  test('other assistant surfaces are still refused', async () => {
    const turn = startTurn({ assistantMode: 'pipeline-editor' });
    try {
      expect(await turn.terminal).toMatchObject({
        type: 'error',
        error: 'Cursor is not available for this assistant surface.',
      });
    } finally {
      await turn.destroy();
    }
  });

  test('keeps the turn identity when the route pauses for a question', async () => {
    const turn = startTurn();
    try {
      await turn.promptStarted;
      const route =
        mockProxy.registerCanopyWorktreeSessionRoute.mock.calls[0]?.[0];
      jest.mocked(markTurnIdle).mockClear();
      route?.onAwaitingUser?.();
      expect(jest.mocked(markTurnAwaitingUser)).toHaveBeenCalledWith(
        'cursor-test',
      );
      expect(jest.mocked(markTurnIdle)).not.toHaveBeenCalled();
      await turn.terminal;
    } finally {
      await turn.destroy();
    }
  });

  test('registers the worktree MCP route for the turn and hands Cursor both app servers', async () => {
    const turn = startTurn();
    try {
      await turn.promptStarted;
      expect(mockProxy.registerCanopyWorktreeSessionRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: 'cursor-test',
          projectId: 'code',
          worktreeId: 'main',
          chatId: 'cursor',
          cwd: '/mock',
          toolSurface: 'cursor-acp',
          providerType: 'cursor',
          deferredToolsAllowed: false,
          codeGraphToolsAdvertised: false,
          model: 'cursor-default',
        }),
      );
      const route =
        mockProxy.registerCanopyWorktreeSessionRoute.mock.calls[0]?.[0];
      expect(route?.authToken).toEqual(expect.any(String));
      const headers = [
        { name: 'Authorization', value: `Bearer ${route?.authToken ?? ''}` },
      ];
      expect(mockNewSession).toHaveBeenCalledWith({
        cwd: '/mock',
        mcpServers: [
          { ...canopyServers[0], headers },
          { ...canopyServers[1], headers },
        ],
      });
      const text = promptText();
      expect(text).toContain(`${ns} and ${ns}_ui`);
      expect(text).not.toContain('MCP, and subagents are unavailable');
      // The injected-tool steering is appended by the session, where it is
      // known that the app servers actually reached Cursor.
      expect(text).toContain('Use GetScriptOutput to inspect setup');
      await turn.terminal;
      expect(
        mockProxy.unregisterCanopyWorktreeSessionRoute,
      ).toHaveBeenCalledWith('cursor-test');
      expect(mockProxy.unregisterRoutesForSession).toHaveBeenCalledWith(
        'cursor-test',
      );
    } finally {
      await turn.destroy();
    }
  });

  test('registers the Cowork surface and steering for a Cowork project', async () => {
    registerWorkspaceTypes(new Map([['cowork-1', 'cowork']]));
    const turn = startTurn({ projectId: 'cowork-1', cwd: '/mock/cowork' });
    try {
      await turn.promptStarted;
      expect(mockProxy.registerCanopyWorktreeSessionRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'cowork-1',
          toolSurface: 'cursor-acp-standalone',
          providerType: 'cursor',
        }),
      );
      const text = promptText();
      expect(text).toContain('cowork project');
      expect(text).toContain('DispatchAction');
      expect(text).toContain('WatchGitHubItems');
      expect(text).not.toMatch(
        /SetBaseBranch|GetGitPreferences|SearchDeferredTools/,
      );
      // The proxy-side gate carries the Cowork surface too: a worktree-only
      // tool is denied by the policy before any approval prompt, even if the
      // proxy's own surface lookup ever let it through.
      const route =
        mockProxy.registerCanopyWorktreeSessionRoute.mock.calls[0]?.[0];
      if (!route?.authorizeToolCall) throw new Error('gate was not installed');
      mockApprovalCheck.mockClear();
      expect(
        await route.authorizeToolCall('set_base_branch', {
          baseBranch: 'main',
        }),
      ).toBe(false);
      expect(mockApprovalCheck).not.toHaveBeenCalled();
    } finally {
      registerWorkspaceTypes(new Map());
      await turn.destroy();
    }
  });

  test('the legacy standalone sentinel selects the Cowork surface too', async () => {
    registerWorkspaceTypes(new Map([['cowork-1', 'cowork']]));
    mockGetWorktreeDataDir.mockClear();
    const turn = startTurn({
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'cowork-1',
    });
    try {
      await turn.promptStarted;
      expect(mockProxy.registerCanopyWorktreeSessionRoute).toHaveBeenCalledWith(
        expect.objectContaining({ toolSurface: 'cursor-acp-standalone' }),
      );
      // The CLI profile is keyed by the Cowork workspace the sentinel borrows,
      // so it lives inside that workspace and is removed with it.
      expect(mockGetWorktreeDataDir).toHaveBeenCalledWith('cowork-1', 'home');
    } finally {
      registerWorkspaceTypes(new Map());
      await turn.destroy();
    }
  });

  test('a saved session is loaded with the complete server list', async () => {
    const turn = startTurn({ sdkSessionId: 'saved' });
    try {
      await turn.promptStarted;
      expect(mockLoadSession).toHaveBeenCalledWith({
        sessionId: 'saved',
        cwd: '/mock',
        mcpServers: canopyServers,
      });
    } finally {
      await turn.destroy();
    }
  });

  test('connects without a fixed prompt deadline so long agentic turns are never cut off', async () => {
    const turn = startTurn();
    try {
      await turn.promptStarted;
      expect(mockConnectAcp).toHaveBeenCalledWith(
        expect.objectContaining({
          timeouts: {
            initializeMs: 15_000,
            requestMs: 30_000,
            promptMs: null,
            permissionMs: 65_000,
            cancelMs: 1000,
          },
        }),
      );
    } finally {
      await turn.destroy();
    }
  });

  test('without HTTP MCP capability the turn still runs but advertises no app tools', async () => {
    mockInitialization.agentCapabilities = {};
    const turn = startTurn();
    try {
      await turn.promptStarted;
      expect(mockNewSession).toHaveBeenCalledWith({
        cwd: '/mock',
        mcpServers: [],
      });
      expect(promptText()).toContain('MCP, and subagents are unavailable');
      expect(promptText()).not.toContain('GetScriptOutput');
      // No route exists for a server that was never handed to the CLI.
      expect(
        mockProxy.registerCanopyWorktreeSessionRoute,
      ).not.toHaveBeenCalled();
      expect(await turn.terminal).toMatchObject({
        type: 'result',
        is_error: false,
      });
    } finally {
      await turn.destroy();
    }
  });

  test('selected plugin MCP servers are resolved once per turn and translated for ACP', async () => {
    const pluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
    };
    mockResolvePlugins.mockResolvedValue({
      mcpServers: {
        linear: { type: 'http', url: 'http://127.0.0.1:37645/route' },
      },
      warnings: [],
      cursorNotices: [],
    });
    const turn = startTurn({
      pluginSelections,
      applyGlobalPluginDefaults: true,
    });
    try {
      await turn.promptStarted;
      expect(mockResolvePlugins).toHaveBeenCalledTimes(1);
      expect(mockResolvePlugins).toHaveBeenCalledWith(
        pluginSelections,
        'code',
        'main',
        'cursor',
        expect.objectContaining({
          purpose: 'cursor-session',
          enableHttpMcpProxy: true,
          installExternalPlugins: true,
          sessionId: 'cursor-test',
        }),
      );
      const sent = mockNewSession.mock.calls[0]?.[0];
      expect(sent?.mcpServers.map((server) => server.name)).toEqual([
        ns,
        `${ns}_ui`,
        'linear',
      ]);
      expect(sent?.mcpServers[2]).toEqual({
        type: 'http',
        name: 'linear',
        url: 'http://127.0.0.1:37645/route',
        headers: [],
      });
    } finally {
      await turn.destroy();
    }
  });

  const chatHome: unknown = expect.stringMatching(
    /^\/unused\/worktree-data\/main\/cursor-sessions\/[0-9a-f]{64}\/home$/,
  );

  test('materializes the selected skills and commands into a per-chat HOME the turn runs against', async () => {
    const cursorCapabilities = {
      skills: [
        {
          id: 'review',
          sourceDir: '/skills/custom/review',
          description: '',
          label: 'review',
        },
      ],
      commands: [
        {
          id: 'ship-it-release',
          markdown: '# Cut a release\n',
          description: 'Cut a release',
          label: 'ship-it:release',
        },
      ],
    };
    mockResolvePlugins.mockResolvedValue({
      mcpServers: {},
      warnings: [],
      cursorNotices: [],
      cursorCapabilities,
    });
    const turn = startTurn({
      pluginSelections: {
        collectionIds: [],
        skillRefs: [{ sourceId: 'custom:local', skillName: 'review' }],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });
    try {
      await turn.promptStarted;
      expect(getManagedCursorRuntime).toHaveBeenCalledWith(
        expect.anything(),
        { runtime: 'agent', workspaceId: 'code' },
        { homeOverlay: chatHome },
      );
      expect(mockMaterialize).toHaveBeenCalledTimes(1);
      expect(mockMaterialize).toHaveBeenCalledWith(
        chatHome,
        cursorCapabilities,
      );
    } finally {
      await turn.destroy();
    }
  });

  test('an empty selection still materializes an empty root so nothing ambient can leak in', async () => {
    const turn = startTurn();
    try {
      await turn.promptStarted;
      expect(mockResolvePlugins).not.toHaveBeenCalled();
      expect(mockMaterialize).toHaveBeenCalledWith(chatHome, {
        skills: [],
        commands: [],
      });
    } finally {
      await turn.destroy();
    }
  });

  test('materializer warnings and ids Cursor did not advertise are reported once per session', async () => {
    mockResolvePlugins.mockResolvedValue({
      mcpServers: {},
      warnings: [],
      cursorNotices: [],
      cursorCapabilities: {
        skills: [
          {
            id: 'review',
            sourceDir: '/s/review',
            description: '',
            label: 'review',
          },
          {
            id: 'big',
            sourceDir: '/s/big',
            description: '',
            label: 'big',
            userInvocable: false,
          },
          {
            id: 'ud-git-branch-naming',
            sourceDir: '/s/branch-naming',
            description: '',
            label: 'ud-git:branch-naming',
            userInvocable: false,
          },
        ],
        commands: [
          {
            id: 'ship-it-release',
            markdown: '# r\n',
            description: '',
            label: 'ship-it:release',
          },
        ],
      },
    });
    mockMaterialize.mockResolvedValue({
      skillIds: ['review', 'ud-git-branch-naming'],
      commandIds: ['ship-it-release'],
      warnings: [
        'Skill "big" is larger than 25 MB or 2000 files and was not loaded.',
      ],
    });
    const advertise = (): void =>
      mockAcpCallbacks.current?.onUpdate({
        sessionId: 'session',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: 'copy-request-id', description: '' },
            { name: 'review', description: '' },
          ],
        },
      });
    const turn = startTurn({
      pluginSelections: {
        collectionIds: [],
        skillRefs: [{ sourceId: 'custom:local', skillName: 'review' }],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });
    try {
      await turn.promptStarted;
      advertise();
      expect(await turn.terminal).toMatchObject({ type: 'result' });
      const notices = (): string[] =>
        mockProjectionNotice.mock.calls.map(([value]) => JSON.stringify(value));
      // The materializer's limit rides the existing once-per-session list.
      expect(
        notices().filter((text) =>
          text.includes('Skill \\"big\\" is larger than 25 MB'),
        ),
      ).toHaveLength(1);
      // The command was materialized but the CLI never listed it.
      const unloaded = (): string[] =>
        notices().filter((text) => text.includes('did not load'));
      expect(unloaded()).toHaveLength(1);
      expect(unloaded()[0]).toContain('ship-it:release');
      expect(unloaded()[0]).not.toContain('review');
      // Model-only skills are loaded but intentionally absent from slash commands.
      expect(unloaded()[0]).not.toContain('ud-git:branch-naming');
      expect(mockMaterialize.mock.calls[0]?.[1]).toHaveProperty(
        'skills',
        expect.arrayContaining([
          expect.objectContaining({ id: 'ud-git-branch-naming' }),
        ]),
      );
      expect(await turn.sendNextMessage()).toMatchObject({ type: 'result' });
      advertise();
      expect(unloaded()).toHaveLength(1);
      // A later turn that misses one more id reports only the new one.
      mockMaterialize.mockResolvedValue({
        skillIds: ['review'],
        commandIds: ['ship-it-release'],
        warnings: [],
      });
      const next = turn.sendNextMessage();
      await new Promise((resolve) => setTimeout(resolve, 100));
      mockAcpCallbacks.current?.onUpdate({
        sessionId: 'session',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'copy-request-id', description: '' }],
        },
      });
      expect(await next).toMatchObject({ type: 'result' });
      expect(unloaded()).toHaveLength(2);
      expect(unloaded()[1]).toContain('review');
      expect(unloaded()[1]).not.toContain('ship-it:release');
    } finally {
      await turn.destroy();
    }
  });

  test('a model-only selection keeps its model guidance without a missing-command notice', async () => {
    mockResolvePlugins.mockResolvedValue({
      mcpServers: {},
      warnings: [],
      cursorNotices: [],
      cursorCapabilities: {
        skills: [
          {
            id: 'branch-naming',
            sourceDir: '/s/branch-naming',
            description: 'Branch guidance',
            label: 'branch-naming',
            userInvocable: false,
          },
        ],
        commands: [],
      },
    });
    mockMaterialize.mockResolvedValue({
      skillIds: ['branch-naming'],
      commandIds: [],
      warnings: [],
    });
    const turn = startTurn({
      pluginSelections: {
        collectionIds: [],
        skillRefs: [{ sourceId: 'custom:local', skillName: 'branch-naming' }],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });
    try {
      await turn.promptStarted;
      mockAcpCallbacks.current?.onUpdate({
        sessionId: 'session',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [],
        },
      });
      expect(await turn.terminal).toMatchObject({ type: 'result' });
      expect(JSON.stringify(mockPrompt.mock.calls[0]?.[0].prompt)).toContain(
        'Selected skills and slash commands are loaded by Cursor itself',
      );
      expect(mockProjectionNotice).not.toHaveBeenCalled();
    } finally {
      await turn.destroy();
    }
  });

  test('inherited home-folder skills and commands reach the resolver even with an empty selection', async () => {
    const inherited = {
      skills: [
        {
          origin: 'claude',
          name: 'review',
          sourceDir: '/home/user/.claude/skills/review',
          description: 'Review',
          userInvocable: true,
        },
      ],
      commands: [
        {
          origin: 'cursor',
          name: 'ship',
          markdown: '# Ship\n',
          description: 'Ship',
        },
      ],
      skipped: [],
      fingerprint: 'turn-1',
    };
    mockDiscoverInherited.mockResolvedValue(inherited);
    const turn = startTurn();
    try {
      await turn.promptStarted;
      expect(mockResolvePlugins).toHaveBeenCalledTimes(1);
      const [selections, , , , options] = mockResolvePlugins.mock.calls[0];
      expect(selections).toEqual({
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      });
      expect(options).toMatchObject({
        purpose: 'cursor-session',
        inheritedCursorCapabilities: inherited,
      });
    } finally {
      mockDiscoverInherited.mockResolvedValue(mockEmptyInherited());
      await turn.destroy();
    }
  });

  test('plugins enabled in Claude Code join the selection unless already selected or turned off for the chat', async () => {
    mockLoadMarketplacesCacheOnly.mockResolvedValue({
      success: true,
      data: {
        marketplaces: [
          {
            id: 'mkt',
            plugins: [
              { name: 'alpha' },
              { name: 'beta' },
              { name: 'gamma' },
              { name: 'delta' },
            ],
          },
        ],
      },
    });
    mockOverlayTombstones.current = {
      pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'delta' }],
    };
    // Claude Code's own report, with each plugin's verified install folder:
    // beta is disabled there.
    mockClaudeEnabledPlugins.mockReturnValue(
      new Map([
        ['alpha@mkt', '/home/user/.claude/plugins/cache/mkt/alpha/1.0.0'],
        ['gamma@mkt', '/home/user/.claude/plugins/cache/mkt/gamma/1.0.0'],
        ['delta@mkt', '/home/user/.claude/plugins/cache/mkt/delta/1.0.0'],
      ]),
    );
    const turn = startTurn({
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'gamma' }],
        mcpServerRefs: [],
      },
    });
    try {
      await turn.promptStarted;
      expect(mockResolvePlugins).toHaveBeenCalledTimes(1);
      const [selections, , , , options] = mockResolvePlugins.mock.calls[0];
      // The chat's own pick stays the selection. The inherited plugin rides
      // as a resolver option so it lands after the selection and its
      // Collections, the same order the inventory numbers ids in; beta is
      // disabled in Claude Code and delta is turned off for this chat.
      expect(selections).toMatchObject({
        pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'gamma' }],
      });
      // The ref carries the folder Claude Code installed, so the resolver
      // reads that version and never looks the plugin up again.
      expect(options).toMatchObject({
        inheritedPluginRefs: [
          {
            marketplaceId: 'mkt',
            pluginName: 'alpha',
            installPath: '/home/user/.claude/plugins/cache/mkt/alpha/1.0.0',
          },
        ],
      });
    } finally {
      mockClaudeEnabledPlugins.mockReturnValue(new Map());
      mockOverlayTombstones.current = undefined;
      mockLoadMarketplacesCacheOnly.mockResolvedValue({
        success: true,
        data: { marketplaces: [] },
      });
      await turn.destroy();
    }
  });

  test('a plugin from a third-party Claude marketplace joins when Claude Code reports it enabled', async () => {
    mockLoadMarketplacesCacheOnly.mockResolvedValue({
      success: true,
      data: {
        marketplaces: [
          {
            id: 'acme-marketplace',
            plugins: [{ name: 'alpha' }, { name: 'beta' }],
          },
        ],
      },
    });
    mockClaudeEnabledPlugins.mockReturnValue(
      new Map([['alpha@acme-marketplace', '/home/user/.claude/acme/alpha']]),
    );
    // The default-plugin overlay is on, as for a worktree chat.
    const turn = startTurn({ applyGlobalPluginDefaults: true });
    try {
      await turn.promptStarted;
      // Claude Code's report is read for this chat's repository, so a plugin
      // installed for another repository is not inherited here.
      expect(mockClaudeEnabledPlugins).toHaveBeenCalledWith(
        '/home/user/.claude',
        '/mock',
      );
      expect(mockResolvePlugins).toHaveBeenCalledTimes(1);
      const [selections, , , , options] = mockResolvePlugins.mock.calls[0];
      expect(selections).toMatchObject({ pluginRefs: [] });
      expect(options).toMatchObject({
        inheritedPluginRefs: [
          {
            marketplaceId: 'acme-marketplace',
            pluginName: 'alpha',
            installPath: '/home/user/.claude/acme/alpha',
          },
        ],
      });
      // The overlay is asked for the chat's tombstones even when no default
      // layer applies, so a plugin turned off for this chat stays off.
      const overlay = mockOverlayCalls[mockOverlayCalls.length - 1]?.[2];
      expect(overlay).toMatchObject({ includeChatTombstones: true });
    } finally {
      mockClaudeEnabledPlugins.mockReturnValue(new Map());
      mockLoadMarketplacesCacheOnly.mockResolvedValue({
        success: true,
        data: { marketplaces: [] },
      });
      await turn.destroy();
    }
  });

  test('entries that could not be inherited are reported once per session, and the turn still runs', async () => {
    mockDiscoverInherited.mockResolvedValue({
      skills: [],
      commands: [],
      skipped: [{ label: '~/.claude/skills/big', reason: 'too large' }],
      fingerprint: 'skipped',
    });
    const turn = startTurn();
    try {
      await turn.promptStarted;
      expect(await turn.terminal).toMatchObject({ type: 'result' });
      const notices = (): string[] =>
        mockProjectionNotice.mock.calls
          .map(([value]) => JSON.stringify(value))
          .filter((text) => text.includes('could not be loaded'));
      expect(notices()).toHaveLength(1);
      expect(notices()[0]).toContain('~/.claude/skills/big');
      expect(await turn.sendNextMessage()).toMatchObject({ type: 'result' });
      expect(notices()).toHaveLength(1);
    } finally {
      mockDiscoverInherited.mockResolvedValue(mockEmptyInherited());
      await turn.destroy();
    }
  });

  test('a changed inherited set refreshes the slash-menu inventory; an unchanged one does not', async () => {
    mockDiscoverInherited.mockResolvedValue({
      skills: [],
      commands: [],
      skipped: [],
      fingerprint: 'fp-a',
    });
    const turn = startTurn();
    try {
      await turn.promptStarted;
      expect(await turn.terminal).toMatchObject({ type: 'result' });
      const after = mockRefreshInventory.mock.calls.length;
      expect(await turn.sendNextMessage()).toMatchObject({ type: 'result' });
      expect(mockRefreshInventory.mock.calls.length).toBe(after);
      mockDiscoverInherited.mockResolvedValue({
        skills: [],
        commands: [],
        skipped: [],
        fingerprint: 'fp-b',
      });
      expect(await turn.sendNextMessage()).toMatchObject({ type: 'result' });
      expect(mockRefreshInventory.mock.calls.length).toBe(after + 1);
      expect(mockRefreshInventory).toHaveBeenLastCalledWith(
        'cursor-inherited-capabilities',
      );
    } finally {
      mockDiscoverInherited.mockResolvedValue(mockEmptyInherited());
      await turn.destroy();
    }
  });

  test('a failed discovery leaves the chat with no inherited entries instead of failing the turn', async () => {
    mockDiscoverInherited.mockRejectedValue(new Error('EACCES'));
    const turn = startTurn();
    try {
      await turn.promptStarted;
      expect(mockResolvePlugins).not.toHaveBeenCalled();
      expect(mockMaterialize).toHaveBeenCalledWith(chatHome, {
        skills: [],
        commands: [],
      });
      expect(await turn.terminal).toMatchObject({ type: 'result' });
    } finally {
      mockDiscoverInherited.mockResolvedValue(mockEmptyInherited());
      await turn.destroy();
    }
  });

  test('a capability root that cannot be prepared fails the turn instead of running without it', async () => {
    mockMaterialize.mockRejectedValue(
      new Error('Cursor private environment is invalid.'),
    );
    const turn = startTurn();
    try {
      expect(await turn.terminal).toMatchObject({
        type: 'error',
        error: 'Cursor private environment is invalid.',
      });
      expect(mockPrompt).not.toHaveBeenCalled();
    } finally {
      await turn.destroy();
    }
  });

  test('a leading slash command is expanded by the host, since the instructions precede the user text', async () => {
    mockResolvePlugins.mockResolvedValue({
      mcpServers: {},
      warnings: [],
      cursorNotices: [],
      cursorCapabilities: {
        skills: [],
        commands: [
          {
            id: 'ship-it-release',
            markdown: '# Cut a release\n\nRelease $ARGUMENTS now.\n',
            description: 'Cut a release',
            label: 'ship-it:release',
          },
        ],
      },
    });
    mockMaterialize.mockResolvedValue({
      skillIds: [],
      commandIds: ['ship-it-release'],
      warnings: [],
    });
    const turn = startTurn(
      {
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [{ marketplaceId: 'market', pluginName: 'ship-it' }],
          mcpServerRefs: [],
        },
      },
      undefined,
      '/ship-it-release v2',
    );
    try {
      await turn.promptStarted;
      expect(promptText()).toContain('Release v2 now.');
      expect(promptText()).not.toContain('/ship-it-release');
    } finally {
      await turn.destroy();
    }
  });

  test('the steering no longer claims skills and slash commands are unavailable', async () => {
    const turn = startTurn();
    try {
      await turn.promptStarted;
      expect(promptText()).not.toContain('Skills, slash commands');
      expect(promptText()).toContain('subagents are unavailable');
    } finally {
      await turn.destroy();
    }
  });

  test('nothing selected means no plugin resolution', async () => {
    const turn = startTurn();
    try {
      await turn.promptStarted;
      expect(mockResolvePlugins).not.toHaveBeenCalled();
    } finally {
      await turn.destroy();
    }
  });

  test('a failed connection registers no app route but still releases plugin proxy routes', async () => {
    mockConnectAcp.mockRejectedValueOnce(new Error('spawn failed'));
    const turn = startTurn(withLinearServer());
    try {
      expect(await turn.terminal).toMatchObject({
        type: 'error',
        error: 'spawn failed',
      });
      // The app route is registered only after initialization confirms HTTP
      // MCP support, which a failed connection never reaches.
      expect(
        mockProxy.registerCanopyWorktreeSessionRoute,
      ).not.toHaveBeenCalled();
      expect(
        mockProxy.unregisterCanopyWorktreeSessionRoute,
      ).not.toHaveBeenCalled();
      expect(mockProxy.unregisterRoutesForSession).toHaveBeenCalledWith(
        'cursor-test',
      );
    } finally {
      await turn.destroy();
    }
  });

  /** A selection whose resolution hands Cursor a `linear` plugin server. */
  function withLinearServer(): Partial<
    Parameters<CursorProvider['createSession']>[0]
  > {
    mockResolvePlugins.mockResolvedValue({
      mcpServers: {
        linear: { type: 'http', url: 'http://127.0.0.1:37645/route' },
      },
      warnings: [],
      cursorNotices: [],
    });
    return {
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
      },
    };
  }

  const mcpPermission = (
    toolCallId: string,
    title: string,
  ): Parameters<AcpClientCallbacks['onPermission']>[0] => ({
    request: { toolCall: { toolCallId, title, kind: 'other' } },
    signal: new AbortController().signal,
  });

  test.each([
    ['allow', { decision: 'allow' as const }],
    ['deny', { decision: 'deny' as const, message: 'Rule denied it.' }],
  ])(
    'a plugin MCP call goes through shared policy and Cursor receives %s',
    async (expected, outcome) => {
      mockApprovalCheck.mockResolvedValue(outcome);
      mockProjectionGetTool.mockReturnValue({
        name: 'linear: create_issue',
        input: {
          providerIdentifier: 'linear',
          toolName: 'create_issue',
          args: { title: 'Fix it' },
        },
        kind: 'other',
      });
      const turn = startTurn(withLinearServer());
      try {
        await turn.promptStarted;
        const callbacks = mockAcpCallbacks.current;
        if (!callbacks) throw new Error('ACP callbacks were not captured');
        expect(
          await callbacks.onPermission(
            mcpPermission('tool-1', 'linear: create_issue'),
          ),
        ).toBe(expected);
        expect(mockApprovalCheck).toHaveBeenCalledWith(
          { kind: 'mcp', server: 'linear', tool: 'create_issue' },
          expect.objectContaining({
            title: 'Cursor wants to use create_issue',
            details: { kind: 'mcp', server: 'linear', tool: 'create_issue' },
            suggestedTarget: {
              kind: 'mcp',
              server: 'linear',
              tool: 'create_issue',
            },
            toolUseId: 'tool-1',
          }),
        );
        // The decided call is exempt from the native-hook anchor either way.
        callbacks.onUpdate({
          sessionId: 'session',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-1',
            status: expected === 'allow' ? 'completed' : 'failed',
            kind: 'other',
          },
        });
        expect(await turn.terminal).toMatchObject({
          type: 'result',
          is_error: false,
        });
        expect(mockProjectionUpdate).toHaveBeenCalledTimes(1);
      } finally {
        await turn.destroy();
      }
    },
  );

  test("a call on the app's own MCP server goes through the same check Claude applies", async () => {
    mockProjectionGetTool.mockReturnValue({
      name: `${ns}: SaveMemory`,
      input: { providerIdentifier: ns, toolName: 'SaveMemory', args: {} },
      kind: 'other',
    });
    const turn = startTurn();
    try {
      await turn.promptStarted;
      const callbacks = mockAcpCallbacks.current;
      if (!callbacks) throw new Error('ACP callbacks were not captured');
      expect(
        await callbacks.onPermission(
          mcpPermission('tool-1', `${ns}: SaveMemory`),
        ),
      ).toBe('allow');
      expect(mockApprovalCheck).toHaveBeenCalledWith(
        { kind: 'mcp', server: ns, tool: 'SaveMemory' },
        expect.objectContaining({ title: 'Cursor wants to use SaveMemory' }),
      );
    } finally {
      await turn.destroy();
    }
  });

  test('a permission request naming a server Cursor was never given is denied and stays anchored', async () => {
    mockProjectionGetTool.mockReturnValue({
      name: 'ghost: run',
      input: { providerIdentifier: 'ghost', toolName: 'run', args: {} },
      kind: 'other',
    });
    const turn = startTurn();
    try {
      await turn.promptStarted;
      const callbacks = mockAcpCallbacks.current;
      if (!callbacks) throw new Error('ACP callbacks were not captured');
      expect(
        await callbacks.onPermission(mcpPermission('tool-1', 'ghost: run')),
      ).toBe('deny');
      expect(mockApprovalCheck).not.toHaveBeenCalled();
      callbacks.onUpdate(completion('tool-1', 'other'));
      const failureText: unknown = expect.stringContaining(
        'without reaching the approval hook',
      );
      expect(await turn.terminal).toMatchObject({
        type: 'error',
        error: failureText,
      });
    } finally {
      await turn.destroy();
    }
  });

  test('servers Cursor cannot run are reported in the transcript, not only the console', async () => {
    mockInitialization.agentCapabilities = { mcpCapabilities: { http: true } };
    mockResolvePlugins.mockResolvedValue({
      mcpServers: {
        events: { type: 'sse', url: 'https://mcp.example.test/sse' },
      },
      warnings: [],
      cursorNotices: [],
    });
    const turn = startTurn({
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [{ serverId: 'events', configId: 'default' }],
      },
    });
    try {
      await turn.promptStarted;
      const noticeText: unknown = expect.stringContaining('"events"');
      expect(mockProjectionNotice).toHaveBeenCalledWith(noticeText);
    } finally {
      await turn.destroy();
    }
  });

  test('plugin-only servers keep the MCP steering when app tools are unavailable', async () => {
    mockInitialization.agentCapabilities = {};
    mockResolvePlugins.mockResolvedValue({
      mcpServers: { local: { type: 'stdio', command: '/opt/tools/mcp' } },
      warnings: [],
      cursorNotices: [],
    });
    const turn = startTurn({
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [{ serverId: 'local', configId: 'default' }],
      },
    });
    try {
      await turn.promptStarted;
      const text = promptText();
      expect(text).toContain('local');
      expect(text).not.toContain('MCP, and subagents are unavailable');
    } finally {
      await turn.destroy();
    }
  });

  test('a Stop decision on an MCP call ends the turn', async () => {
    mockApprovalCheck.mockResolvedValue({ decision: 'deny', stopTurn: true });
    mockProjectionGetTool.mockReturnValue({
      name: 'linear: create_issue',
      input: {
        providerIdentifier: 'linear',
        toolName: 'create_issue',
        args: {},
      },
      kind: 'other',
    });
    const turn = startTurn(withLinearServer());
    try {
      await turn.promptStarted;
      const callbacks = mockAcpCallbacks.current;
      if (!callbacks) throw new Error('ACP callbacks were not captured');
      expect(
        await callbacks.onPermission(
          mcpPermission('tool-1', 'linear: create_issue'),
        ),
      ).toBe('deny');
      expect(await turn.terminal).toMatchObject({
        type: 'result',
        subtype: 'cancelled',
      });
    } finally {
      await turn.destroy();
    }
  });

  test('an MCP completion the host never decided still stops the session', async () => {
    mockProjectionGetTool.mockReturnValue({
      name: 'linear: create_issue',
      input: {
        providerIdentifier: 'linear',
        toolName: 'create_issue',
        args: {},
      },
      kind: 'other',
    });
    const turn = startTurn();
    try {
      await turn.promptStarted;
      const callbacks = mockAcpCallbacks.current;
      if (!callbacks) throw new Error('ACP callbacks were not captured');
      callbacks.onUpdate(completion('tool-1', 'other'));
      const failureText: unknown = expect.stringContaining(
        'without reaching the approval hook',
      );
      expect(await turn.terminal).toMatchObject({
        type: 'error',
        error: failureText,
      });
    } finally {
      await turn.destroy();
    }
  });

  test('a permission request for an unrecognized tool is denied', async () => {
    mockProjectionGetTool.mockReturnValue({
      name: 'Unknown operation',
      input: {},
      kind: 'other',
    });
    const turn = startTurn();
    try {
      await turn.promptStarted;
      const callbacks = mockAcpCallbacks.current;
      if (!callbacks) throw new Error('ACP callbacks were not captured');
      expect(
        await callbacks.onPermission(
          mcpPermission('tool-1', 'Unknown operation'),
        ),
      ).toBe('deny');
      expect(mockApprovalCheck).not.toHaveBeenCalled();
    } finally {
      await turn.destroy();
    }
  });

  test('the local-memory nudge follows the app tools into the session prompt', async () => {
    mockPreferences.localMemoryEnabled = true;
    const turn = startTurn();
    try {
      await turn.promptStarted;
      expect(promptText()).toContain('SaveMemory');
    } finally {
      await turn.destroy();
    }
  });

  test('proxy routes are released even when route registration itself fails', async () => {
    mockProxy.registerCanopyWorktreeSessionRoute.mockRejectedValueOnce(
      new Error('register failed'),
    );
    const turn = startTurn(withLinearServer());
    try {
      expect(await turn.terminal).toMatchObject({
        type: 'error',
        error: 'register failed',
      });
      expect(mockProxy.unregisterRoutesForSession).toHaveBeenCalledWith(
        'cursor-test',
      );
      expect(
        mockProxy.unregisterCanopyWorktreeSessionRoute,
      ).not.toHaveBeenCalled();
    } finally {
      await turn.destroy();
    }
  });

  test('a denied MCP call that still completes stops the session', async () => {
    mockApprovalCheck.mockResolvedValue({ decision: 'deny' });
    mockProjectionGetTool.mockReturnValue({
      name: 'linear: create_issue',
      input: {
        providerIdentifier: 'linear',
        toolName: 'create_issue',
        args: {},
      },
      kind: 'other',
    });
    const turn = startTurn(withLinearServer());
    try {
      await turn.promptStarted;
      const callbacks = mockAcpCallbacks.current;
      if (!callbacks) throw new Error('ACP callbacks were not captured');
      expect(
        await callbacks.onPermission(
          mcpPermission('tool-1', 'linear: create_issue'),
        ),
      ).toBe('deny');
      callbacks.onUpdate(completion('tool-1', 'other'));
      const failureText: unknown = expect.stringContaining(
        'without reaching the approval hook',
      );
      expect(await turn.terminal).toMatchObject({
        type: 'error',
        error: failureText,
      });
    } finally {
      await turn.destroy();
    }
  });

  test('a hook input fingerprint anchors only one completion', async () => {
    const input = { command: 'ls', cwd: '/mock' };
    mockProjectionGetTool.mockReturnValue({
      name: 'Shell',
      input,
      kind: 'execute',
    });
    const turn = startTurn();
    try {
      await turn.promptStarted;
      const callbacks = mockAcpCallbacks.current;
      if (!callbacks || !mockHook.authorize)
        throw new Error('callbacks were not captured');
      await mockHook.authorize({
        hook_event_name: 'preToolUse',
        tool_name: 'Shell',
        tool_input: input,
        tool_use_id: 'cli-internal-1',
      });
      callbacks.onUpdate(completion('tool-1', 'execute'));
      callbacks.onUpdate(completion('tool-2', 'execute'));
      const failureText: unknown = expect.stringContaining(
        'without reaching the approval hook',
      );
      expect(await turn.terminal).toMatchObject({
        type: 'error',
        error: failureText,
      });
      expect(mockProjectionUpdate).toHaveBeenCalledTimes(1);
    } finally {
      await turn.destroy();
    }
  });

  test('generic resolver warnings stay out of the transcript, like Claude and Codex', async () => {
    // `withLinearServer()` installs its own resolver result; override after.
    const overrides = withLinearServer();
    mockResolvePlugins.mockResolvedValue({
      mcpServers: {
        linear: { type: 'http', url: 'http://127.0.0.1:37645/route' },
      },
      warnings: [
        'MCP server "2a996e09-bf39-4fc8-bd8e-155b2e5ffdc4" not found, skipping.',
        'Plugin "role-demo" not found in marketplace "curated/cloud".',
      ],
      cursorNotices: [],
    });
    const turn = startTurn(overrides);
    try {
      await turn.promptStarted;
      const chunks = mockProjectionNotice.mock.calls.map(([value]) =>
        JSON.stringify(value),
      );
      expect(chunks.join('\n')).not.toContain('not found');
      expect(chunks.join('\n')).not.toContain('skipped');
    } finally {
      await turn.destroy();
    }
  });

  test('a Cursor-specific selection notice is shown once per session, not every turn', async () => {
    const overrides = withLinearServer();
    mockResolvePlugins.mockResolvedValue({
      mcpServers: {
        linear: { type: 'http', url: 'http://127.0.0.1:37645/route' },
      },
      warnings: [],
      cursorNotices: [
        'Skill "review" (source: custom:local) is not available in Cursor sessions and was skipped.',
      ],
    });
    const turn = startTurn(overrides);
    try {
      await turn.promptStarted;
      expect(await turn.terminal).toMatchObject({ type: 'result' });
      const noticesSoFar = (): number =>
        mockProjectionNotice.mock.calls.filter(([value]) =>
          JSON.stringify(value).includes('not available in Cursor chats'),
        ).length;
      expect(noticesSoFar()).toBe(1);
      expect(
        mockProjectionNotice.mock.calls.some(([value]) =>
          JSON.stringify(value).includes(
            'Skill \\"review\\" (source: custom:local) is not available in Cursor sessions',
          ),
        ),
      ).toBe(true);
      expect(await turn.sendNextMessage()).toMatchObject({ type: 'result' });
      expect(noticesSoFar()).toBe(1);
    } finally {
      await turn.destroy();
    }
  });

  test('a failed plugin resolution is reported in the transcript', async () => {
    mockResolvePlugins.mockRejectedValueOnce(new Error('marketplace offline'));
    const turn = startTurn({
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
      },
    });
    try {
      await turn.promptStarted;
      const noticeText: unknown = expect.stringContaining(
        'could not be resolved',
      );
      expect(mockProjectionNotice).toHaveBeenCalledWith(noticeText);
    } finally {
      await turn.destroy();
    }
  });

  const watchArgs = { command: 'ls -la', intervalSeconds: 5, maxAttempts: 1 };
  async function registeredToolGate(
    turn: ReturnType<typeof startTurn>,
  ): Promise<
    (
      toolKey: CanopyInjectedToolKey,
      args: Record<string, unknown>,
    ) => Promise<boolean>
  > {
    await turn.promptStarted;
    const route =
      mockProxy.registerCanopyWorktreeSessionRoute.mock.calls[0]?.[0];
    if (!route?.authorizeToolCall)
      throw new Error('route has no authorizeToolCall');
    return route.authorizeToolCall;
  }

  test('the route re-checks an app tool call the CLI never asked permission for', async () => {
    const turn = startTurn();
    try {
      const gate = await registeredToolGate(turn);
      mockApprovalCheck.mockResolvedValue({ decision: 'deny' });
      expect(await gate('watch_command', watchArgs)).toBe(false);
      expect(mockApprovalCheck).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'command', command: 'ls -la' }),
        expect.objectContaining({ title: 'Cursor wants to use WatchCommand' }),
      );
      mockApprovalCheck.mockResolvedValue({ decision: 'allow' });
      expect(await gate('watch_command', watchArgs)).toBe(true);
      // Every app tool is covered, with the same identity Claude's MCP
      // calls use; the ui server's tool checks against the ui server name.
      expect(await gate('dispatch_action', { type: 'pipeline.run' })).toBe(
        true,
      );
      expect(mockApprovalCheck).toHaveBeenLastCalledWith(
        { kind: 'mcp', server: ns, tool: 'DispatchAction' },
        expect.objectContaining({
          title: 'Cursor wants to use DispatchAction',
        }),
      );
      expect(await gate('ask_user_question', { questions: [] })).toBe(true);
      expect(mockApprovalCheck).toHaveBeenLastCalledWith(
        { kind: 'mcp', server: `${ns}_ui`, tool: 'AskUserQuestion' },
        expect.anything(),
      );
    } finally {
      await turn.destroy();
    }
  });

  test('an app tool call the host already allowed over ACP passes the route exactly once', async () => {
    const args = { ...watchArgs, followUpInstruction: 'Report the exit code.' };
    mockProjectionGetTool.mockReturnValue({
      name: `${ns}: WatchCommand`,
      input: { providerIdentifier: ns, toolName: 'WatchCommand', args },
      kind: 'other',
    });
    const turn = startTurn();
    try {
      const gate = await registeredToolGate(turn);
      const callbacks = mockAcpCallbacks.current;
      if (!callbacks) throw new Error('ACP callbacks were not captured');
      expect(
        await callbacks.onPermission(
          mcpPermission('tool-1', `${ns}: WatchCommand`),
        ),
      ).toBe('allow');
      expect(mockApprovalCheck).toHaveBeenCalledTimes(1);
      // Same tool, same raw arguments (follow-up instruction included).
      expect(await gate('watch_command', args)).toBe(true);
      expect(mockApprovalCheck).toHaveBeenCalledTimes(1);
      // The allowance is consumed; a repeat is checked again.
      expect(await gate('watch_command', args)).toBe(true);
      expect(mockApprovalCheck).toHaveBeenCalledTimes(2);
      // Different arguments are not covered by that decision.
      expect(
        await gate('watch_command', { ...args, command: 'rm -rf build' }),
      ).toBe(true);
      expect(mockApprovalCheck).toHaveBeenCalledTimes(3);
    } finally {
      await turn.destroy();
    }
  });

  test('the route denies a state-changing app tool in read-only plan mode without a prompt', async () => {
    const turn = startTurn({ planMode: true });
    try {
      const gate = await registeredToolGate(turn);
      expect(await gate('watch_command', watchArgs)).toBe(false);
      expect(await gate('dispatch_action', { type: 'pipeline.run' })).toBe(
        false,
      );
      expect(await gate('save_memory', { text: 'x', scope: 'user' })).toBe(
        false,
      );
      expect(mockApprovalCheck).not.toHaveBeenCalled();
      // A state-reading tool is still checked normally.
      expect(await gate('search_memory', { query: 'x' })).toBe(true);
      expect(mockApprovalCheck).toHaveBeenCalledTimes(1);
    } finally {
      await turn.destroy();
    }
  });

  test('proxied plugin calls the CLI never asked permission for are checked at the proxy gate', async () => {
    mockResolvePlugins.mockResolvedValue({
      mcpServers: {
        linear: { type: 'http', url: 'http://127.0.0.1:37645/route' },
      },
      warnings: [],
      cursorNotices: [],
    });
    const turn = startTurn({
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
      },
    });
    try {
      await turn.promptStarted;
      const registered = mockProxy.setSessionToolCallGate.mock.calls[0];
      if (!registered) throw new Error('no session tool-call gate');
      expect(registered[0]).toBe('cursor-test');
      const gate = registered[1];
      const call = {
        proxyUrl: 'http://127.0.0.1:37645/route',
        tool: 'create_issue',
        args: { title: 'x' },
        requestId: '7',
      };
      mockApprovalCheck.mockResolvedValue({ decision: 'deny' });
      expect(await gate(call)).toBe(false);
      expect(mockApprovalCheck).toHaveBeenLastCalledWith(
        { kind: 'mcp', server: 'linear', tool: 'create_issue' },
        expect.objectContaining({
          title: 'Cursor wants to use create_issue',
          toolUseId: '7',
        }),
      );
      mockApprovalCheck.mockResolvedValue({ decision: 'allow' });
      expect(await gate(call)).toBe(true);
      // A route the turn never handed the CLI is refused outright.
      expect(
        await gate({ ...call, proxyUrl: 'http://127.0.0.1:37645/other' }),
      ).toBe(false);
      expect(mockApprovalCheck).toHaveBeenCalledTimes(2);
    } finally {
      await turn.destroy();
    }
  });

  test('a proxied plugin call the host allowed over ACP passes the proxy gate exactly once', async () => {
    mockResolvePlugins.mockResolvedValue({
      mcpServers: {
        linear: { type: 'http', url: 'http://127.0.0.1:37645/route' },
      },
      warnings: [],
      cursorNotices: [],
    });
    mockProjectionGetTool.mockReturnValue({
      name: 'linear: create_issue',
      input: {
        providerIdentifier: 'linear',
        toolName: 'create_issue',
        args: { title: 'x' },
      },
      kind: 'other',
    });
    const turn = startTurn({
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
      },
    });
    try {
      await turn.promptStarted;
      const callbacks = mockAcpCallbacks.current;
      if (!callbacks) throw new Error('ACP callbacks were not captured');
      expect(
        await callbacks.onPermission(
          mcpPermission('tool-1', 'linear: create_issue'),
        ),
      ).toBe('allow');
      expect(mockApprovalCheck).toHaveBeenCalledTimes(1);
      const gate = mockProxy.setSessionToolCallGate.mock.calls[0]?.[1];
      if (!gate) throw new Error('no session tool-call gate');
      const call = {
        proxyUrl: 'http://127.0.0.1:37645/route',
        tool: 'create_issue',
        args: { title: 'x' },
      };
      expect(await gate(call)).toBe(true);
      expect(mockApprovalCheck).toHaveBeenCalledTimes(1);
      expect(await gate(call)).toBe(true);
      expect(mockApprovalCheck).toHaveBeenCalledTimes(2);
    } finally {
      await turn.destroy();
    }
  });

  // The pinned CLI has been observed executing an MCP tool without any
  // permission request; the app's gates decide instead, and the anchor must
  // treat their decisions like ACP ones.
  const failedCompletion = (toolCallId: string): unknown => ({
    sessionId: 'session',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'failed',
      kind: 'other',
    },
  });
  const linearCall = {
    proxyUrl: 'http://127.0.0.1:37645/route',
    tool: 'create_issue',
    args: { title: 'x' },
  };
  function expectLinearTool(): void {
    mockProjectionGetTool.mockReturnValue({
      name: 'linear: create_issue',
      input: {
        providerIdentifier: 'linear',
        toolName: 'create_issue',
        args: { title: 'x' },
      },
      kind: 'other',
    });
  }

  test('a plugin MCP call the proxy gate allowed passes the anchor when the CLI never asked', async () => {
    expectLinearTool();
    const turn = startTurn(withLinearServer());
    try {
      await turn.promptStarted;
      const gate = mockProxy.setSessionToolCallGate.mock.calls[0]?.[1];
      const callbacks = mockAcpCallbacks.current;
      if (!gate || !callbacks) throw new Error('gate or callbacks missing');
      expect(await gate(linearCall)).toBe(true);
      callbacks.onUpdate(completion('tool-1', 'other'));
      expect(await turn.terminal).toMatchObject({
        type: 'result',
        is_error: false,
      });
    } finally {
      await turn.destroy();
    }
  });

  test('a plugin MCP call the proxy gate denied passes the anchor only when it then failed', async () => {
    mockApprovalCheck.mockResolvedValue({ decision: 'deny' });
    expectLinearTool();
    const turn = startTurn(withLinearServer());
    try {
      await turn.promptStarted;
      const gate = mockProxy.setSessionToolCallGate.mock.calls[0]?.[1];
      const callbacks = mockAcpCallbacks.current;
      if (!gate || !callbacks) throw new Error('gate or callbacks missing');
      expect(await gate(linearCall)).toBe(false);
      callbacks.onUpdate(failedCompletion('tool-1'));
      // A second denial whose call the CLI completes anyway still stops.
      expect(await gate(linearCall)).toBe(false);
      callbacks.onUpdate(completion('tool-2', 'other'));
      const failureText: unknown = expect.stringContaining(
        'without reaching the approval hook',
      );
      expect(await turn.terminal).toMatchObject({
        type: 'error',
        error: failureText,
      });
    } finally {
      await turn.destroy();
    }
  });

  test('an app tool call the route gate allowed passes the anchor when the CLI never asked', async () => {
    mockProjectionGetTool.mockReturnValue({
      name: `${ns}: SaveMemory`,
      input: {
        providerIdentifier: ns,
        toolName: 'SaveMemory',
        args: { text: 'x', scope: 'user' },
      },
      kind: 'other',
    });
    const turn = startTurn();
    try {
      const gate = await registeredToolGate(turn);
      const callbacks = mockAcpCallbacks.current;
      if (!callbacks) throw new Error('ACP callbacks were not captured');
      expect(await gate('save_memory', { text: 'x', scope: 'user' })).toBe(
        true,
      );
      callbacks.onUpdate(completion('tool-1', 'other'));
      expect(await turn.terminal).toMatchObject({
        type: 'result',
        is_error: false,
      });
    } finally {
      await turn.destroy();
    }
  });
});

describe('Agent Ledger tools', () => {
  const ns = BRAND.tools.namespace;
  const LEDGER_PROMPT = 'LEDGER TOOLS PROMPT BLOCK';
  const HINT =
    '<feed_assignments revision="abc" open="1">You have 1 open Feed entries assigned to you.</feed_assignments>';
  const PLAN_EXCEPTION =
    'Plan mode exception: AddFeedEntry, SearchFeedEntries and UpdateFeedEntry are Feed bookkeeping';
  const target = { projectId: 'code', worktreeId: 'main', chatId: 'cursor' };
  let ledgerTools: MockLedgerTools;

  function promptTextOf(turnIndex: number): string {
    const block = mockPrompt.mock.calls[turnIndex]?.[0]?.prompt[0];
    return block && block.type === 'text' ? block.text : '';
  }

  function routes(): CanopyWorktreeSessionRoute[] {
    return mockProxy.registerCanopyWorktreeSessionRoute.mock.calls.map(
      ([route]) => route,
    );
  }

  async function routeGate(
    turn: ReturnType<typeof startTurn>,
  ): Promise<NonNullable<CanopyWorktreeSessionRoute['authorizeToolCall']>> {
    await turn.promptStarted;
    const gate = routes()[0]?.authorizeToolCall;
    if (!gate) throw new Error('route has no authorizeToolCall');
    return gate;
  }

  beforeEach(() => {
    ledgerTools = {
      systemPrompt: jest.fn(() => LEDGER_PROMPT),
      assignmentHint: jest.fn(() => Promise.resolve(undefined)),
      execute: jest.fn(),
      dispose: jest.fn<void, []>(),
    };
    mockMayExposeLedgerTools.mockReturnValue(true);
    mockOpenLedgerChatTools.mockImplementation(() =>
      Promise.resolve(ledgerTools),
    );
  });

  afterEach(() => {
    mockMayExposeLedgerTools.mockReturnValue(false);
    mockOpenLedgerChatTools.mockImplementation(() => Promise.resolve(null));
  });

  test('opens the chat Ledger tools once per session and binds them to every turn route', async () => {
    const turn = startTurn({ selectedRepoId: 'repo-1' });
    try {
      expect(await turn.terminal).toMatchObject({ type: 'result' });
      expect(await turn.sendNextMessage()).toMatchObject({ type: 'result' });

      expect(mockMayExposeLedgerTools).toHaveBeenCalledTimes(1);
      expect(mockMayExposeLedgerTools).toHaveBeenCalledWith(target);
      expect(mockOpenLedgerChatTools).toHaveBeenCalledTimes(1);
      const options = mockOpenLedgerChatTools.mock.calls[0]?.[0];
      expect(options).toMatchObject({
        target,
        harness: 'cursor',
        selectedRepoId: 'repo-1',
      });
      expect(options?.readSettings()).toEqual({
        model: 'cursor-default',
        thinkingEffort: null,
        planMode: false,
      });
      expect(routes()).toHaveLength(2);
      for (const route of routes()) {
        expect(route).toMatchObject({ toolSurface: 'cursor-acp', ledgerTools });
      }
      expect(promptTextOf(0)).toContain(LEDGER_PROMPT);
      expect(promptTextOf(1)).toContain(LEDGER_PROMPT);
      expect(promptTextOf(0)).not.toContain(PLAN_EXCEPTION);
      expect(ledgerTools.dispose).not.toHaveBeenCalled();
    } finally {
      await turn.destroy();
    }
    expect(ledgerTools.dispose).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['the flag or scope gate is closed', false],
    ['the setting is off or the scope cannot be resolved', true],
  ])('opens no Ledger tools when %s', async (_label, mayExpose: boolean) => {
    mockMayExposeLedgerTools.mockReturnValue(mayExpose);
    mockOpenLedgerChatTools.mockImplementation(() => Promise.resolve(null));
    const turn = startTurn({ planMode: true });
    try {
      expect(await turn.terminal).toMatchObject({ type: 'result' });
      expect(await turn.sendNextMessage()).toMatchObject({ type: 'result' });

      expect(mockMayExposeLedgerTools).toHaveBeenCalledTimes(1);
      expect(mockOpenLedgerChatTools).toHaveBeenCalledTimes(mayExpose ? 1 : 0);
      for (const route of routes()) {
        expect(route).not.toHaveProperty('ledgerTools');
      }
      for (const index of [0, 1]) {
        expect(promptTextOf(index)).not.toContain(LEDGER_PROMPT);
        expect(promptTextOf(index)).not.toContain(PLAN_EXCEPTION);
      }
      expect(ledgerTools.assignmentHint).not.toHaveBeenCalled();
    } finally {
      await turn.destroy();
    }
  });

  test('opens no Ledger tools for a Cowork chat, whose route does not list them', async () => {
    registerWorkspaceTypes(new Map([['cowork-1', 'cowork']]));
    const turn = startTurn({ projectId: 'cowork-1', cwd: '/mock/cowork' });
    try {
      expect(await turn.terminal).toMatchObject({ type: 'result' });

      expect(mockOpenLedgerChatTools).not.toHaveBeenCalled();
      expect(routes()).toHaveLength(1);
      for (const route of routes()) {
        expect(route).toMatchObject({ toolSurface: 'cursor-acp-standalone' });
        expect(route).not.toHaveProperty('ledgerTools');
      }
      expect(promptTextOf(0)).not.toContain(LEDGER_PROMPT);
      expect(ledgerTools.assignmentHint).not.toHaveBeenCalled();
    } finally {
      await turn.destroy();
    }
  });

  test('decides exposure only once a turn can hand Cursor the app tools', async () => {
    mockInitialization.agentCapabilities = {};
    const turn = startTurn();
    try {
      expect(await turn.terminal).toMatchObject({ type: 'result' });
      expect(mockMayExposeLedgerTools).not.toHaveBeenCalled();
      expect(promptTextOf(0)).not.toContain(LEDGER_PROMPT);

      mockInitialization.agentCapabilities = {
        mcpCapabilities: { http: true, sse: true },
      };
      expect(await turn.sendNextMessage()).toMatchObject({ type: 'result' });
      expect(mockOpenLedgerChatTools).toHaveBeenCalledTimes(1);
      expect(routes()).toEqual([expect.objectContaining({ ledgerTools })]);
      expect(promptTextOf(1)).toContain(LEDGER_PROMPT);
    } finally {
      await turn.destroy();
    }
  });

  test('adds the assignment hint to the instructions of the turn it opens', async () => {
    ledgerTools.assignmentHint.mockResolvedValueOnce(HINT);
    const turn = startTurn();
    try {
      expect(await turn.terminal).toMatchObject({ type: 'result' });
      expect(await turn.sendNextMessage()).toMatchObject({ type: 'result' });

      expect(ledgerTools.assignmentHint).toHaveBeenCalledTimes(2);
      expect(promptTextOf(0)).toContain(HINT);
      // The hint precedes the user text, like the native chats prepend it.
      expect(promptTextOf(0).indexOf(HINT)).toBeLessThan(
        promptTextOf(0).indexOf('Hello'),
      );
      expect(promptTextOf(1)).not.toContain(HINT);
    } finally {
      await turn.destroy();
    }
  });

  test('carries the Ledger Plan mode exception and checks Ledger calls with the shared policy in plan mode', async () => {
    const turn = startTurn({ planMode: true });
    try {
      const gate = await routeGate(turn);
      expect(promptTextOf(0)).toContain('Read-only plan mode');
      expect(promptTextOf(0)).toContain(PLAN_EXCEPTION);

      const args = { type: 'TASK', title: 'Plan', content: 'Plan it.' };
      expect(await gate('add_ledger_entry', args)).toBe(true);
      expect(mockApprovalCheck).toHaveBeenLastCalledWith(
        { kind: 'mcp', server: ns, tool: 'AddFeedEntry' },
        expect.objectContaining({
          title: 'Cursor wants to use AddFeedEntry',
        }),
      );
      mockApprovalCheck.mockResolvedValue({ decision: 'deny' });
      expect(await gate('update_ledger_entry', { entryId: 'e' })).toBe(false);
      expect(mockApprovalCheck).toHaveBeenLastCalledWith(
        { kind: 'mcp', server: ns, tool: 'UpdateFeedEntry' },
        expect.anything(),
      );
    } finally {
      await turn.destroy();
    }
  });

  test('a Ledger call the route gate allowed passes the anchor when the CLI never asked', async () => {
    const args = { type: 'TASK', title: 'Plan', content: 'Plan it.' };
    mockProjectionGetTool.mockReturnValue({
      name: `${ns}: AddFeedEntry`,
      input: { providerIdentifier: ns, toolName: 'AddFeedEntry', args },
      kind: 'other',
    });
    const turn = startTurn();
    try {
      const gate = await routeGate(turn);
      const callbacks = mockAcpCallbacks.current;
      if (!callbacks) throw new Error('ACP callbacks were not captured');
      expect(await gate('add_ledger_entry', args)).toBe(true);
      callbacks.onUpdate(completion('tool-1', 'other'));
      expect(await turn.terminal).toMatchObject({
        type: 'result',
        is_error: false,
      });
    } finally {
      await turn.destroy();
    }
  });

  test('disposes Ledger tools that finish opening after the session ended', async () => {
    let finishOpening: (tools: MockLedgerTools) => void = () => {};
    mockOpenLedgerChatTools.mockImplementation(
      () =>
        new Promise<MockLedgerTools>((resolve) => {
          finishOpening = resolve;
        }),
    );
    const turn = startTurn();
    for (
      let attempt = 0;
      mockOpenLedgerChatTools.mock.calls.length === 0;
      attempt += 1
    ) {
      if (attempt > 400) {
        await turn.destroy();
        throw new Error('The session never opened its Ledger tools.');
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const destroyed = turn.destroy();
    finishOpening(ledgerTools);
    await destroyed;

    expect(ledgerTools.dispose).toHaveBeenCalledTimes(1);
    for (const route of routes()) {
      expect(route).not.toHaveProperty('ledgerTools');
    }
  });
});

test('uses a discovered Cursor model for a new chat instead of rejecting it', async () => {
  const turn = startTurn({
    model: 'cursor:' + encodeURIComponent('gpt-6-luna[reasoning=medium]'),
  });
  try {
    expect(await turn.terminal).toMatchObject({
      type: 'result',
      is_error: false,
    });
    expect(mockPrompt).toHaveBeenCalled();
    expect(mockSetConfig).toHaveBeenCalledWith(
      { sessionId: 'session', configId: 'model', value: 'gpt-6-luna' },
      expect.any(AbortSignal),
    );
  } finally {
    await turn.destroy();
  }
});

test('reapplies the requested model after loading a saved Cursor session', async () => {
  const turn = startTurn({
    sdkSessionId: 'saved-cursor',
    model: 'cursor:' + encodeURIComponent('gpt-6-luna[reasoning=medium]'),
  });
  try {
    expect(await turn.terminal).toMatchObject({
      type: 'result',
      is_error: false,
    });
    expect(mockLoadSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'saved-cursor' }),
    );
    expect(mockSetConfig).toHaveBeenCalledWith(
      { sessionId: 'saved-cursor', configId: 'model', value: 'gpt-6-luna' },
      expect.any(AbortSignal),
    );
    expect(mockLoadSession.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetConfig.mock.invocationCallOrder[0],
    );
    expect(mockSetConfig.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrompt.mock.invocationCallOrder[0],
    );
  } finally {
    await turn.destroy();
  }
});
test('does not silently prompt with another model when a saved selection disappears', async () => {
  const turn = startTurn({ model: 'cursor:removed-model' });
  try {
    expect(await turn.terminal).toMatchObject({ type: 'error' });
    expect(mockPrompt).not.toHaveBeenCalled();
  } finally {
    await turn.destroy();
  }
});
test.each(['initializing', 'prompting'])(
  'a model selected while %s applies to the next turn',
  async (stage) => {
    const turn = startTurn();
    const raw = 'gpt-6-luna[reasoning=medium]';
    try {
      if (stage === 'prompting') await turn.promptStarted;
      await expect(
        turn.setModel('cursor:' + encodeURIComponent(raw)),
      ).resolves.toBeUndefined();
      expect(await turn.terminal).toMatchObject({
        type: 'result',
        is_error: false,
      });
      expect(
        turn.events.find(
          (event) => event.type === 'system' && event.subtype === 'init',
        ),
      ).toMatchObject({ model: 'cursor-default' });
      expect(mockSetConfig.mock.calls[0][0]).toMatchObject({
        value: 'default',
      });
      expect(await turn.sendNextMessage()).toMatchObject({
        type: 'result',
        is_error: false,
      });
      expect(mockSetConfig.mock.calls[1][0]).toMatchObject({
        value: 'gpt-6-luna',
      });
    } finally {
      await turn.destroy();
    }
  },
);

describe('thinking level', () => {
  const gptRaw = 'gpt-6-luna[reasoning=medium]';
  const claudeRaw = 'claude-sonnet-4-5[thinking=true,context=200k]';
  const opusRaw = 'claude-opus-5[thinking=true,context=300k,effort=high]';
  const gpt = 'cursor:' + encodeURIComponent(gptRaw);
  const opus = 'cursor:' + encodeURIComponent(opusRaw);
  const configCalls = (): { configId: string; value: string }[] =>
    mockSetConfig.mock.calls.map(([params]) => ({
      configId: params.configId,
      value: params.value,
    }));
  // Discovery published each variant's support; the session forwards the
  // chat's level only for variants the registry describes.
  beforeEach(() => {
    resetCursorPreTurnDiscoveryForTests();
    initCursorModels([
      {
        id: 'cursor-default',
        rawModelId: 'default[]',
        label: 'Cursor default',
        supportedThinkingLevels: [],
      },
      {
        id: gpt,
        rawModelId: gptRaw,
        label: 'GPT-6 Luna',
        supportedThinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
      },
      {
        id: 'cursor:' + encodeURIComponent(claudeRaw),
        rawModelId: claudeRaw,
        label: 'Claude Sonnet 4.5 Thinking',
        supportedThinkingLevels: ['off', 'medium'],
      },
      {
        id: opus,
        rawModelId: opusRaw,
        label: 'Claude Opus 5',
        supportedThinkingLevels: [
          'off',
          'low',
          'medium',
          'high',
          'xhigh',
          'max',
        ],
      },
    ]);
  });
  afterEach(() => {
    initCursorModels([]);
  });

  test('discovers before the turn when the catalog has no entry for the variant', async () => {
    // As after a restart: the in-memory catalog is empty, the chat still
    // carries High. The turn discovers first, publishes, and forwards.
    initCursorModels([]);
    mockListCursorModels.mockResolvedValueOnce([
      {
        id: gpt,
        rawModelId: gptRaw,
        label: 'GPT-6 Luna',
        supportedThinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
      },
    ]);
    const turn = startTurn({ model: gpt, thinkingLevel: 'high' });
    try {
      expect(await turn.terminal).toMatchObject({
        type: 'result',
        is_error: false,
      });
      expect(mockListCursorModels).toHaveBeenCalledTimes(1);
      expect(mockBroadcastModelRegistryUpdated).toHaveBeenCalledTimes(1);
      expect(configCalls()).toEqual([
        { configId: 'model', value: 'gpt-6-luna' },
        { configId: 'reasoning', value: 'high' },
      ]);
      // The published catalog serves the next turn without another discovery.
      expect(await turn.sendNextMessage()).toMatchObject({
        type: 'result',
        is_error: false,
      });
      expect(mockListCursorModels).toHaveBeenCalledTimes(1);
    } finally {
      await turn.destroy();
    }
  });

  test('re-plans after turning thinking on reveals the graded effort', async () => {
    mockHideEffortWhileThinkingOff = true;
    mockParameterValues.set('claude-opus-5:thinking', 'false');
    const turn = startTurn({ model: opus, thinkingLevel: 'xhigh' });
    try {
      expect(await turn.terminal).toMatchObject({
        type: 'result',
        is_error: false,
      });
      // The first plan saw only the toggle; the effort appeared once it was
      // on and was applied before prompting.
      expect(configCalls()).toEqual([
        { configId: 'model', value: 'claude-opus-5' },
        { configId: 'thinking', value: 'true' },
        { configId: 'effort', value: 'xhigh' },
      ]);
    } finally {
      await turn.destroy();
    }
  });

  test('fails closed when the runtime offers fewer levels than the catalog described', async () => {
    mockEffortValues = ['low', 'medium', 'high'];
    const turn = startTurn({ model: opus, thinkingLevel: 'max' });
    try {
      const failureText: unknown = expect.stringContaining('thinking level');
      // The composer showed Max (the catalog declares it); the live picker
      // would resolve High, so the turn stops rather than run elsewhere.
      expect(await turn.terminal).toMatchObject({
        type: 'error',
        error: failureText,
      });
      expect(mockPrompt).not.toHaveBeenCalled();
    } finally {
      await turn.destroy();
    }
  });

  test('fails closed when the live picker has no thinking control', async () => {
    mockHideThoughtOptions = true;
    const turn = startTurn({ model: gpt, thinkingLevel: 'high' });
    try {
      const failureText: unknown = expect.stringContaining('thinking level');
      expect(await turn.terminal).toMatchObject({
        type: 'error',
        error: failureText,
      });
      expect(mockPrompt).not.toHaveBeenCalled();
    } finally {
      await turn.destroy();
    }
  });

  test('Stop ends a turn that is still waiting for the pre-turn discovery', async () => {
    initCursorModels([]);
    mockListCursorModels.mockReturnValueOnce(new Promise(() => {}));
    const turn = startTurn({ model: gpt, thinkingLevel: 'high' });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockListCursorModels).toHaveBeenCalledTimes(1);
      await turn.destroy();
      expect(await turn.terminal).toMatchObject({
        type: 'result',
        result: 'Turn cancelled',
      });
      expect(mockPrompt).not.toHaveBeenCalled();
    } finally {
      await turn.destroy();
    }
  });

  test('attempts the pre-turn discovery once per app run', async () => {
    initCursorModels([]);
    mockListCursorModels.mockResolvedValue([
      { id: gpt, rawModelId: gptRaw, label: 'GPT-6 Luna' },
    ]);
    const turn = startTurn({ model: gpt, thinkingLevel: 'high' });
    try {
      expect(await turn.terminal).toMatchObject({
        type: 'result',
        is_error: false,
      });
      expect(await turn.sendNextMessage()).toMatchObject({
        type: 'result',
        is_error: false,
      });
      // A separate chat gets a new CursorProvider. Unknown support must not
      // start another discovery from that provider either.
      const otherChat = startTurn({ model: gpt, thinkingLevel: 'high' });
      try {
        expect(await otherChat.terminal).toMatchObject({
          type: 'result',
          is_error: false,
        });
      } finally {
        await otherChat.destroy();
      }
      expect(mockListCursorModels).toHaveBeenCalledTimes(1);
      expect(configCalls()).toEqual([
        { configId: 'model', value: 'gpt-6-luna' },
        { configId: 'model', value: 'gpt-6-luna' },
        { configId: 'model', value: 'gpt-6-luna' },
      ]);
    } finally {
      await turn.destroy();
    }
  });

  test.each([
    ['describes no support for the variant', 'unknown'],
    ['fails', 'rejects'],
  ] as const)(
    'keeps the variant parameters when discovery %s',
    async (_label, mode) => {
      initCursorModels([]);
      if (mode === 'rejects')
        mockListCursorModels.mockRejectedValueOnce(new Error('offline'));
      else
        mockListCursorModels.mockResolvedValueOnce([
          { id: gpt, rawModelId: gptRaw, label: 'GPT-6 Luna' },
        ]);
      const turn = startTurn({ model: gpt, thinkingLevel: 'high' });
      try {
        expect(await turn.terminal).toMatchObject({
          type: 'result',
          is_error: false,
        });
        // No chip could have shown High, so the variant's own reasoning runs.
        expect(configCalls()).toEqual([
          { configId: 'model', value: 'gpt-6-luna' },
        ]);
      } finally {
        await turn.destroy();
      }
    },
  );

  test('turns thinking off without re-applying the effort the toggle snapped', async () => {
    const turn = startTurn({ model: opus, thinkingLevel: 'off' });
    try {
      expect(await turn.terminal).toMatchObject({
        type: 'result',
        is_error: false,
      });
      // The plan owns every thought-level option: the variant's `effort=high`
      // is neither re-applied after the snap nor reported as unavailable.
      expect(configCalls()).toEqual([
        { configId: 'model', value: 'claude-opus-5' },
        { configId: 'thinking', value: 'false' },
      ]);
      expect(mockParameterValues.get('claude-opus-5:effort')).toBe('low');
    } finally {
      await turn.destroy();
    }
  });

  test('turns thinking on and sets the graded effort for a combined model', async () => {
    const turn = startTurn({ model: opus, thinkingLevel: 'ultra' });
    try {
      expect(await turn.terminal).toMatchObject({
        type: 'result',
        is_error: false,
      });
      expect(configCalls()).toEqual([
        { configId: 'model', value: 'claude-opus-5' },
        { configId: 'effort', value: 'max' },
      ]);
    } finally {
      await turn.destroy();
    }
  });

  test('applies the chat level through the model thought-level option before prompting', async () => {
    const turn = startTurn({ model: gpt, thinkingLevel: 'high' });
    try {
      expect(await turn.terminal).toMatchObject({
        type: 'result',
        is_error: false,
      });
      expect(configCalls()).toEqual([
        { configId: 'model', value: 'gpt-6-luna' },
        { configId: 'reasoning', value: 'high' },
      ]);
      expect(mockSetConfig.mock.invocationCallOrder[1]).toBeLessThan(
        mockPrompt.mock.invocationCallOrder[0],
      );
    } finally {
      await turn.destroy();
    }
  });

  test('re-applies the variant parameters a saved session restored differently', async () => {
    mockParameterValues.set('gpt-6-luna:reasoning', 'xhigh');
    const turn = startTurn({ model: gpt, sdkSessionId: 'saved-cursor' });
    try {
      expect(await turn.terminal).toMatchObject({
        type: 'result',
        is_error: false,
      });
      // No level requested: the persisted variant's own value wins over what
      // the runtime remembered.
      expect(configCalls()).toEqual([
        { configId: 'model', value: 'gpt-6-luna' },
        { configId: 'reasoning', value: 'medium' },
      ]);
    } finally {
      await turn.destroy();
    }
  });

  test('sends nothing when the runtime already holds the requested level', async () => {
    const turn = startTurn({ model: gpt, thinkingLevel: 'medium' });
    try {
      expect(await turn.terminal).toMatchObject({
        type: 'result',
        is_error: false,
      });
      expect(configCalls()).toEqual([
        { configId: 'model', value: 'gpt-6-luna' },
      ]);
    } finally {
      await turn.destroy();
    }
  });

  test('a level changed during a turn applies to the next turn', async () => {
    const turn = startTurn({ model: gpt });
    try {
      await turn.promptStarted;
      await expect(turn.setThinkingLevel('xhigh')).resolves.toBeUndefined();
      expect(await turn.terminal).toMatchObject({
        type: 'result',
        is_error: false,
      });
      expect(configCalls()).toEqual([
        { configId: 'model', value: 'gpt-6-luna' },
      ]);
      expect(await turn.sendNextMessage()).toMatchObject({
        type: 'result',
        is_error: false,
      });
      expect(configCalls().slice(1)).toEqual([
        { configId: 'model', value: 'gpt-6-luna' },
        { configId: 'reasoning', value: 'xhigh' },
      ]);
    } finally {
      await turn.destroy();
    }
  });

  test('clamps to the declared set and turns a thinking toggle off', async () => {
    const claude = 'cursor:' + encodeURIComponent(claudeRaw);
    const turn = startTurn({ model: claude, thinkingLevel: 'off' });
    try {
      expect(await turn.terminal).toMatchObject({
        type: 'result',
        is_error: false,
      });
      expect(configCalls()).toEqual([
        { configId: 'model', value: 'claude-sonnet-4-5' },
        { configId: 'thinking', value: 'false' },
      ]);
    } finally {
      await turn.destroy();
    }
  });

  test('leaves a model without a thinking control at its runtime default', async () => {
    const turn = startTurn({ model: 'cursor-default', thinkingLevel: 'high' });
    try {
      expect(await turn.terminal).toMatchObject({
        type: 'result',
        is_error: false,
      });
      expect(configCalls()).toEqual([{ configId: 'model', value: 'default' }]);
    } finally {
      await turn.destroy();
    }
  });

  test('does not prompt when Cursor acknowledges a different level', async () => {
    mockSetConfig.mockImplementationOnce(({ value }: { value: string }) => {
      mockSelectedBase = value;
      return Promise.resolve({
        configOptions: mockConfigOptionsFor(value),
      });
    });
    mockSetConfig.mockImplementationOnce(() =>
      Promise.resolve({ configOptions: mockConfigOptionsFor('gpt-6-luna') }),
    );
    const turn = startTurn({ model: gpt, thinkingLevel: 'high' });
    try {
      const failureText: unknown = expect.stringContaining('thinking level');
      expect(await turn.terminal).toMatchObject({
        type: 'error',
        error: failureText,
      });
      expect(mockPrompt).not.toHaveBeenCalled();
    } finally {
      await turn.destroy();
    }
  });
});

test('does not prompt when Cursor acknowledges a different model', async () => {
  mockSetConfig.mockResolvedValueOnce({
    configOptions: [{ id: 'model', currentValue: 'wrong-model' }],
  });
  const turn = startTurn();
  try {
    expect(await turn.terminal).toMatchObject({ type: 'error' });
    expect(mockPrompt).not.toHaveBeenCalled();
  } finally {
    await turn.destroy();
  }
});

test('Cursor flag blocks a saved connected model before runtime work', async () => {
  mockPreferences.cursorEnabled = true;
  mockCursorHarnessEnabled.mockReturnValue(false);
  expect(await terminalEvent()).toMatchObject({
    type: 'error',
    error:
      'This Cursor model is unavailable. Choose another Cursor model and try again.',
  });
  expect(getManagedCursorRuntime).not.toHaveBeenCalled();
  expect(verifyCursorVersion).not.toHaveBeenCalled();
});

describe('Cursor plan proposals', () => {
  test.each([true, false])(
    'commits a successful proposal only in plan mode %s',
    async (planMode) => {
      mockRealProjection.enabled = true;
      const turn = startTurn({ planMode });
      try {
        await turn.promptStarted;
        mockAcpCallbacks.current?.onUpdate({
          sessionId: 'session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: '<proposed_plan># Cursor plan\nImplement it.</proposed_plan>',
            },
          },
        });
        expect(await turn.terminal).toMatchObject({ is_error: false });
        if (planMode) {
          expect(mockCommitPendingPlanExit).toHaveBeenCalledWith(
            expect.objectContaining({
              source: 'cursor',
              reviewMode: 'proposal',
              toolInput: {
                plan: '# Cursor plan\nImplement it.',
                source: 'cursor',
                reviewMode: 'proposal',
              },
            }),
          );
          expect(
            JSON.stringify(mockPrompt.mock.calls[0]?.[0].prompt),
          ).toContain('<proposed_plan>');
          expect(mockMarkPlanAttention).toHaveBeenCalledWith(
            expect.objectContaining({ reason: 'plan_review' }),
          );
          expect(
            mockCommitPendingPlanExit.mock.invocationCallOrder[0],
          ).toBeLessThan(mockMarkPlanAttention.mock.invocationCallOrder[0]);
        } else expect(mockCommitPendingPlanExit).not.toHaveBeenCalled();
      } finally {
        await turn.destroy();
      }
    },
  );

  test('reports commit failure without a successful result', async () => {
    mockCommitPendingPlanExit.mockRejectedValueOnce(
      new Error('journal fsync failed'),
    );
    mockRealProjection.enabled = true;
    const turn = startTurn({ planMode: true });
    try {
      await turn.promptStarted;
      mockAcpCallbacks.current?.onUpdate({
        sessionId: 'session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: '<proposed_plan>Plan</proposed_plan>',
          },
        },
      });
      expect(await turn.terminal).toMatchObject({
        type: 'error',
        error: 'journal fsync failed',
      });
    } finally {
      await turn.destroy();
    }
  });
});

test('Cursor Pipeline Assistant registers only its own tool route', async () => {
  const runtime = {
    requestUserAnswers: jest.fn(),
    loadScriptOutput: jest.fn(),
    dispatchEditorAction: jest.fn(),
    requestEditorState: jest.fn(),
    listPipelines: jest.fn(),
    getBuiltinActionDefinition: jest.fn(),
  };
  const turn = startTurn({
    assistantMode: 'pipeline-editor',
    pipelineEditorRuntime: runtime,
    sdkSessionId: 'persisted-assistant-session',
  });
  try {
    expect(await turn.terminal).toMatchObject({
      type: 'result',
      is_error: false,
    });
    expect(mockProxy.registerCanopyWorktreeSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantMode: 'pipeline-editor',
        pipelineEditorRuntime: runtime,
      }),
    );
    expect(
      mockNewSession.mock.calls[0]?.[0].mcpServers.map((server) => server.name),
    ).toContain(`${BRAND.tools.namespace}_pipeline_editor`);
    // Like Codex Pipeline Assistant, reopening starts a fresh native session.
    // Persisted chat history and the editor context remain owned by the host.
    expect(mockLoadSession).not.toHaveBeenCalled();
    await turn.sendNextMessage();
    expect(mockLoadSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session' }),
    );
  } finally {
    await turn.destroy();
  }
});

test('Cursor code review keeps the review tool route in the owning chat', async () => {
  const turn = startTurn({
    projectId: 'code-review-chat',
    worktreeId: 'owning-worktree-review',
  });
  try {
    expect(await turn.terminal).toMatchObject({
      type: 'result',
      is_error: false,
    });
    expect(mockProxy.registerCanopyWorktreeSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'code-review-chat',
        worktreeId: 'owning-worktree-review',
        isCodeReview: true,
      }),
    );
  } finally {
    await turn.destroy();
  }
});
