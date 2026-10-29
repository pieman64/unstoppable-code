import type { HelperInvocation } from '../ollama/helper-invocation';
import type * as MainLogModule from '../lib/main-process-logging';
const mockCursorAccount = jest.fn(() =>
  Promise.resolve({ email: 'cursor@example.test' }),
);
let mockCursorEnabled = true;
jest.mock('../cursor/connection', () => ({
  readCursorAccount: (): ReturnType<typeof mockCursorAccount> =>
    mockCursorAccount(),
}));
jest.mock('../cursor/feature-flag', () => ({
  assertCursorHarnessEnabled: (): void => undefined,
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<{ cursorEnabled: boolean }> =>
    Promise.resolve({ cursorEnabled: mockCursorEnabled }),
}));
import { buildChatSessionKey } from '../agents/session-key';
import type * as FsPromises from 'node:fs/promises';
import type * as PathModule from 'node:path';
import type * as UrlModule from 'node:url';
import type { AgentCapabilitySnapshot } from '@canopy/desktop-shared/node/delegation/agent-artifacts';
import type {
  DelegatedMcpResolutionOptions,
  DelegatedMcpUnavailable,
} from '../agents/delegation/agent-mcp-capabilities';
import type {
  ApprovalRule,
  CodexSelectedCapabilityRoot,
} from '@canopy/desktop-shared/types';
import type { MaterializedCapabilityOverlay } from '@canopy/desktop-shared/node/delegation/agent-artifacts';

function capturedRoutes(runtime: DelegationRouteRuntime): {
  get: (key: string) => Record<string, unknown> | undefined;
  set: (key: string, value: Record<string, unknown>) => void;
} {
  const value: unknown = Reflect.get(runtime, 'captured');
  if (!(value instanceof Map)) throw new Error('Missing captured route state');
  for (const [key, entry] of value) {
    if (typeof key !== 'string' || typeof entry !== 'object' || entry === null)
      throw new Error('Invalid captured route state');
  }
  return {
    get: (key): Record<string, unknown> | undefined => {
      const entry: unknown = value.get(key);
      return typeof entry === 'object' && entry !== null
        ? Object.fromEntries(Object.entries(entry))
        : undefined;
    },
    set: (key, entry): void => {
      value.set(key, entry);
    },
  };
}
jest.mock('../lib/main-process-logging', () => ({
  ...jest.requireActual<typeof MainLogModule>('../lib/main-process-logging'),
  logMainProcessWarn: jest.fn(),
}));
jest.mock('node:fs/promises', () => ({
  ...jest.requireActual<typeof FsPromises>('node:fs/promises'),
  rm: jest.fn(jest.requireActual<typeof FsPromises>('node:fs/promises').rm),
  lstat: jest.fn(() =>
    Promise.resolve({
      isSymbolicLink: (): boolean => false,
      isFile: (): boolean => false,
      nlink: 1,
    }),
  ),
  realpath: jest.fn((file: string) => Promise.resolve(file)),
}));
const mockIsModelBlockedByStoredPolicy = jest.fn<
  Promise<boolean>,
  [string | undefined]
>(() => Promise.resolve(false));
const mockDisposeInvocation = jest.fn<void, []>();
const mockDelegationWrite = jest.fn(() => Promise.resolve());
const mockApprovalCheck = jest.fn<Promise<{ decision: string }>, [unknown]>(
  () => Promise.resolve({ decision: 'allow' }),
);
/** The session rules the child's approval handle held at its latest check. */
let mockApprovalRules: readonly { id: string }[] = [];
const mockApprovalSetMode = jest.fn<void, [string]>();
const mockApprovalDispose = jest.fn<void, []>();
let mockApprovalPolicyContextKey = 'policy:0:0';
const mockOpenDelegationFiles = jest.fn(() =>
  Promise.resolve({
    read: (): Promise<string> => Promise.resolve(''),
    list: (): Promise<string[]> => Promise.resolve([]),
    search: (): Promise<{
      matches: string[];
      filesRead: number;
      truncated: boolean;
    }> => Promise.resolve({ matches: [], filesRead: 0, truncated: false }),
    write: mockDelegationWrite,
    close: (): Promise<void> => Promise.resolve(),
  }),
);
const mockResolveHelperInvocation = jest.fn<
  Promise<HelperInvocation>,
  unknown[]
>((...args: unknown[]) => {
  void args;
  return Promise.resolve({
    providerType: 'codex' as const,
    source: 'codex-managed' as const,
    harness: 'codex' as const,
    sdkModel: 'gpt-5.6-sol',
    aiCreditsRouted: false,
    dispose: mockDisposeInvocation,
  });
});
const mockSetSessionToolCallGate = jest.fn<
  void,
  [
    string,
    (call: {
      proxyUrl: string;
      tool: string;
      args: Record<string, unknown>;
      requestId: string;
    }) => Promise<boolean>,
  ]
>();
const mockUnregisterRoutesForSession = jest.fn();
const mockRevokeStdioMcpRoutes = jest.fn(() => Promise.resolve());
const mockRecordSessionDiagnostic = jest.fn<void, [SessionDiagnosticRecord]>();
function mockHostPath(...parts: string[]): string {
  const nodePath = jest.requireActual<typeof PathModule>('node:path');
  return nodePath.resolve(nodePath.sep, ...parts);
}
function mockHostUrl(file: string): string {
  return jest.requireActual<typeof UrlModule>('node:url').pathToFileURL(file)
    .href;
}
// A host-native absolute path, so the file URL converts on every platform.
const PUBLISHED_ROOT = mockHostPath('published', 'selected');
const PUBLISHED_ROOT_URL = mockHostUrl(PUBLISHED_ROOT);
const mockPublishSelectedRoots = jest.fn(
  (roots: readonly CodexSelectedCapabilityRoot[]) =>
    Promise.resolve({
      roots: roots.map(() => ({
        id: 'published-root',
        location: {
          type: 'environment' as const,
          environmentId: 'local',
          path: PUBLISHED_ROOT_URL,
        },
      })),
      rootContentIds: ['published-root'],
    }),
);
const mockResolveDelegatedMcpCapabilities = jest.fn(
  (
    capabilities: AgentCapabilitySnapshot,
    options: DelegatedMcpResolutionOptions,
  ) => {
    void capabilities;
    void options;
    return Promise.resolve({
      mcpServers: {},
      codexMcpServers: {},
      serverNameByProxyUrl: {},
      providerGatedServers: [] as string[],
      unavailable: [] as DelegatedMcpUnavailable[],
    });
  },
);

jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (
    modelId: string | undefined,
  ): Promise<boolean> => mockIsModelBlockedByStoredPolicy(modelId),
}));
jest.mock('../lib/model-config', () => ({
  getAuthoritativeConfiguredModel: (
    modelId: string,
  ): {
    id: string;
    label: string;
    modelSource: string;
    defaultHarness: string;
    enabled: boolean;
    selectable: boolean;
    supportedThinkingLevels: readonly ['low'];
  } => ({
    id: modelId === 'cursor-default' ? modelId : 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    modelSource: 'codex-managed',
    defaultHarness: 'codex',
    enabled: true,
    selectable: true,
    supportedThinkingLevels: ['low'],
  }),
}));
jest.mock('../lib/user-environment-runtime', () => ({
  resolveCodexRuntimeEnvironmentProfile: (): {
    environment: Record<string, string>;
  } => ({ environment: {} }),
}));
const mockGetLoginShellPath = jest.fn(() => '/login/bin:/usr/bin:/bin');
jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@canopy/desktop-shared/canopy-paths',
  ),
  getCanopyDataDir: (): string => '/app-data/canopy',
  getCanopySecureDataDir: (): string => '/app-data/canopy-secure',
}));
jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => ({
  getLoginShellPath: (): string => mockGetLoginShellPath(),
}));
let mockChildHarness: 'claude' | 'codex' | 'cursor' = 'codex';
let mockProviderAccountKey = 'account';
let mockNativelyAuthenticated = true;
let mockNativeBillingAccountKind = 'subscription';
let mockAgentDefinition: {
  revision: string;
  instructions: string;
  pluginMarker: string;
} | null = null;
const mockResolveAgentModelRuntime = jest.fn(
  (options: { model: string }): Promise<unknown> => {
    if (options.model === 'agent_model_reviewer') {
      if (!mockAgentDefinition)
        return Promise.reject(new Error('Agent definition was deleted'));
      return Promise.resolve({
        selectedModel: options.model,
        runtimeModel: 'gpt-5.6-sol',
        providerType: 'codex',
        executionHarness: 'codex',
        agent: {
          id: options.model,
          updatedAt: mockAgentDefinition.revision,
          contentHash: createHash('sha256')
            .update(mockAgentDefinition.instructions)
            .digest('hex'),
        },
        systemPromptAppend: mockAgentDefinition.instructions,
        pluginSelections: {
          collectionIds: [],
          skillRefs: [{ sourceId: 'builtin', skillName: 'review' }],
          pluginRefs: [],
        },
      });
    }
    return Promise.resolve({
      selectedModel: options.model,
      runtimeModel:
        mockChildHarness === 'cursor' ? 'cursor-default' : 'gpt-5.6-sol',
      providerType: mockChildHarness,
      executionHarness: mockChildHarness,
      systemPromptAppend: undefined,
      pluginSelections: undefined,
    });
  },
);
jest.mock('../agents/agent-model-runtime', () => ({
  resolveAgentModelRuntime: (options: { model: string }): Promise<unknown> =>
    mockResolveAgentModelRuntime(options),
}));
const mockMaterializeDelegationCapabilities = jest.fn(() =>
  Promise.resolve({
    files: {
      'plugins/selected/.codex-plugin/plugin.json': '{"name":"review"}',
      'plugins/selected/skills/review/SKILL.md':
        mockAgentDefinition?.pluginMarker ?? '',
    },
    toolNames: ['read', 'search'],
    capabilities: {
      claudePluginRoots: [],
      claudeSkillNames: [],
      codexCapabilityRoots: ['plugins/selected'],
      mcpSelections: [],
      mcpHttpAuthPreferences: [],
      hookDeclarations: [],
    },
    provenance: {
      roots: { 'plugins/selected': 'agent' as const },
      mcpSelections: [],
    },
    included: [],
    skipped: [],
    layerWarnings: [],
  }),
);
jest.mock('../agents/delegation/agent-projection', () => ({
  materializeDelegationCapabilities: (
    ...args: unknown[]
  ): ReturnType<typeof mockMaterializeDelegationCapabilities> =>
    mockMaterializeDelegationCapabilities(...args),
}));
jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperInvocation: (
    ...args: unknown[]
  ): ReturnType<typeof mockResolveHelperInvocation> =>
    mockResolveHelperInvocation(...args),
}));
jest.mock('../agents/delegation/file-process', () => ({
  delegationFileBoundaryAvailable: (): Promise<boolean> =>
    Promise.resolve(true),
  openDelegationFiles: (): ReturnType<typeof mockOpenDelegationFiles> =>
    mockOpenDelegationFiles(),
}));
jest.mock('../auth/provider-auth-state', () => ({
  isProviderNativelyAuthenticatedForRouting: (): Promise<boolean> =>
    Promise.resolve(mockNativelyAuthenticated),
  peekProviderAccountIdentity: (): { providerAccountKey: string } => ({
    providerAccountKey: mockProviderAccountKey,
  }),
  peekProviderBillingAccountKind: (): string => mockNativeBillingAccountKind,
}));
jest.mock('../approvals/approval-service', () => ({
  createApprovalSession: (context: {
    sessionRules: readonly { id: string }[];
  }): object => ({
    // The real handle reads its live rule list on every check.
    check: (request: unknown): Promise<{ decision: string }> => {
      mockApprovalRules = structuredClone(context.sessionRules);
      return mockApprovalCheck(request);
    },
    setMode: (mode: string): void => mockApprovalSetMode(mode),
    policyContextKey: (): string => mockApprovalPolicyContextKey,
    dispose: (): void => mockApprovalDispose(),
  }),
}));
jest.mock('@canopy/desktop-shared/node/e2e-mock-env', () => ({
  resolveAnthropicMockEnvOverride: (): undefined => undefined,
}));
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: (): object => ({
    setSessionToolCallGate: mockSetSessionToolCallGate,
    unregisterRoutesForSession: mockUnregisterRoutesForSession,
  }),
}));
jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: (): object => ({
    revokeStdioMcpRoutes: mockRevokeStdioMcpRoutes,
  }),
}));
jest.mock('../codex/capability-store', () => ({
  getDesktopCodexCapabilityStore: (): object => ({
    publishSelectedRoots: mockPublishSelectedRoots,
  }),
}));
jest.mock('../observability', () => ({
  getObservabilityService: (): object => ({
    recordSessionDiagnostic: mockRecordSessionDiagnostic,
  }),
}));
jest.mock('../agents/delegation/agent-mcp-capabilities', () => ({
  resolveDelegatedMcpCapabilities: (
    capabilities: AgentCapabilitySnapshot,
    options: DelegatedMcpResolutionOptions,
  ): ReturnType<typeof mockResolveDelegatedMcpCapabilities> =>
    mockResolveDelegatedMcpCapabilities(capabilities, options),
  delegatedMcpUnavailableGuidance: (
    unavailable: readonly DelegatedMcpUnavailable[],
  ): string =>
    unavailable.length
      ? `UNAVAILABLE_MCP:${unavailable.map((entry) => `${entry.name}=${entry.reason}`).join(',')}`
      : '',
}));
const mockResolveSetupHint = jest.fn(
  (options: {
    projectId: string;
    selectedRepoId?: string;
    delegateCwd: string;
    harness: 'claude' | 'codex';
  }): Promise<string | undefined> => {
    void options;
    return Promise.resolve('ISOLATED_SETUP_HINT');
  },
);
jest.mock('../agents/delegation/setup-hint', () => ({
  resolveIsolatedDelegationSetupHint: (options: {
    projectId: string;
    selectedRepoId?: string;
    delegateCwd: string;
    harness: 'claude' | 'codex';
  }): Promise<string | undefined> => mockResolveSetupHint(options),
}));

import type { ResolvedAgentRouteSnapshot } from '@canopy/desktop-shared/node/delegation';
import {
  LocalDelegationRunner,
  type LocalDelegationContext,
  type LocalDelegationOutcome,
} from '@canopy/desktop-shared/node/delegation/local-runner';
import type { AgentDelegationEvent } from '@canopy/protocol/delegation';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentSessionOptions } from '../agents/types';
import { AgentArtifactStore } from '@canopy/desktop-shared/node/delegation/agent-artifacts';
import type {
  DelegationCapabilityContext,
  DelegationCapabilityExtensionRequest,
  DelegationCapabilityExtensionResult,
  DelegationCapabilityGrant,
} from '@canopy/desktop-shared/node/delegation/capability-grant';
import {
  resolveDelegationCapabilityDiscovery,
  summarizeDelegationCapabilities,
} from '@canopy/desktop-shared/node/delegation/capability-grant';
import {
  captureWindowsClaudeHost,
  delegationCodexConfigArgs,
  delegationProjectionInstructions,
  DelegationRouteRuntime,
  isDelegationRouteAuthorized,
} from '../agents/delegation/route-runtime';
import { DelegationAgentCapabilityError } from '../agents/delegation/agent-capability-error';
import {
  childCapabilityDiscovery,
  prepareDelegationCapabilities,
  type DelegationCallerCapabilities,
} from '../agents/delegation/capability-grant';
import type { MaterializedDelegationCapabilities } from '../agents/delegation/agent-projection';
import type { SessionDiagnosticRecord } from '../observability/service';
import { reportDelegationError } from '../agents/delegation/report-error';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  CLEANUP_CANARY,
  CLEANUP_RESOURCES,
  cleanupRecord,
  cleanupRecords,
  errorFields,
  failure,
  reportedCleanupDiagnostics,
} from './helpers/delegation-cleanup-records';

const route: ResolvedAgentRouteSnapshot = {
  selectedModelId: 'reviewer',
  runtimeModelId: 'gpt-5.6-sol',
  harnessId: 'codex',
  runtimeKind: 'app-server',
  runnerRegistrationId: 'codex',
  runtimeVersion: '1',
  adapterVersion: '1',
  modelSource: 'test',
  providerType: 'openai',
  assignmentRevision: '1',
  billingAuthority: 'native',
  aiCreditsRouted: false,
  capabilities: ['read'],
  supportedThinkingLevels: ['low'],
  capabilitySnapshotHash: 'hash',
  capabilityGeneration: 1,
  policyRevision: 'read-only',
};

function authorize(): Promise<boolean> {
  const owner: AgentSessionOptions = {
    cwd: '/tmp/delegation-route-runtime-test',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
  };
  return isDelegationRouteAuthorized({
    owner,
    route,
    captured: {
      authGeneration: 1,
      environmentFingerprint: createHash('sha256')
        .update(JSON.stringify({ environment: {} }))
        .digest('hex'),
    },
    authGeneration: () => 1,
  });
}

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
if (!platformDescriptor) throw new Error('Expected the platform property');
beforeAll(() => {
  // Simulate macOS on POSIX hosts; a Windows host is itself supported and keeps
  // its own platform so path, mode and ACL checks match the real filesystem.
  Object.defineProperty(process, 'platform', {
    ...platformDescriptor,
    value: platformDescriptor.value === 'win32' ? 'win32' : 'darwin',
  });
});
afterAll(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
});
beforeEach(() => {
  mockChildHarness = 'codex';
  mockCursorEnabled = true;
  mockCursorAccount
    .mockReset()
    .mockResolvedValue({ email: 'cursor@example.test' });
  mockAgentDefinition = null;
  mockResolveAgentModelRuntime.mockClear();
  mockMaterializeDelegationCapabilities.mockClear();
  mockIsModelBlockedByStoredPolicy.mockReset().mockResolvedValue(false);
  mockDisposeInvocation.mockReset();
  mockResolveHelperInvocation.mockClear();
  mockDelegationWrite.mockClear();
  mockOpenDelegationFiles.mockClear();
  mockApprovalCheck.mockReset().mockResolvedValue({ decision: 'allow' });
  mockApprovalSetMode.mockReset();
  mockApprovalDispose.mockReset();
  jest.mocked(logMainProcessWarn).mockClear();
  mockApprovalPolicyContextKey = 'policy:0:0';
  mockResolveDelegatedMcpCapabilities.mockClear();
  mockSetSessionToolCallGate.mockClear();
  mockUnregisterRoutesForSession.mockClear();
  mockRevokeStdioMcpRoutes.mockClear();
  mockPublishSelectedRoots.mockClear();
  mockRecordSessionDiagnostic.mockClear();
});

it('keeps Agent instructions unchanged when no retained files exist', () => {
  expect(
    delegationProjectionInstructions(
      {
        agentDefinitionId: 'agent_model_reviewer',
        agentDefinitionRevision: 1,
        agentDefinitionHash: 'hash',
        systemPromptAppend: 'Read @agent/reference.md',
        pluginFiles: {},
        toolNames: ['read', 'search'],
      },
      [],
    ),
  ).toBe('Read @agent/reference.md');
});

it('fails delegated launch authorization when organization policy blocks the model', async () => {
  mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);
  await expect(authorize()).resolves.toBe(false);
  expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith('gpt-5.6-sol');
});

it('rechecks organization policy when captured route authority changes before launch', async () => {
  await expect(authorize()).resolves.toBe(true);
  mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);
  await expect(authorize()).resolves.toBe(false);
});

const parent = {
  harnessId: 'codex' as const,
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat',
  sessionKey: 'project/worktree/chat',
  turnId: 'turn',
  toolCallId: 'call',
  depth: 0,
  runtimeGeneration: 1,
};
const task = {
  modelId: 'gpt-5.6-sol',
  description: 'Review route lifetime',
  prompt: 'Inspect the delegated route lifetime.',
  executionMode: 'foreground' as const,
  contextPolicy: 'task_only' as const,
  isolation: 'shared_worktree' as const,
};

function runtime(
  owner: AgentSessionOptions = {
    cwd: '/tmp/delegation-route-runtime-test',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
  },
): DelegationRouteRuntime {
  return new DelegationRouteRuntime({
    directory: '/tmp/delegation-route-runtime-test',
    owner: () => owner,
    getWindow: () => null,
    authGeneration: () => 1,
  });
}

function withSelectedMcp(
  routeRuntime: DelegationRouteRuntime,
  resolved: ResolvedAgentRouteSnapshot,
): void {
  if (!resolved.routeId) throw new Error('Expected a captured route');
  const capabilities: MaterializedCapabilityOverlay = {
    version: 3,
    pluginFiles: {},
    capabilities: {
      claudePluginRoots: [],
      claudeSkillNames: [],
      codexCapabilityRoots: [],
      mcpSelections: [
        {
          source: 'standalone',
          serverId: 'review-server',
          configId: 'default',
          configDigest: 'pinned',
        },
      ],
      mcpHttpAuthPreferences: [],
      hookDeclarations: [],
    },
    provenance: {
      roots: {},
      mcpSelections: ['agent'],
    },
    items: [],
  };
  const captured = capturedRoutes(routeRuntime);
  captured.set(resolved.routeId, {
    ...captured.get(resolved.routeId),
    capabilities,
  });
}

function prepareContext(
  route: ResolvedAgentRouteSnapshot,
  signal: AbortSignal,
  retained: Array<() => Promise<void>>,
): LocalDelegationContext {
  return {
    request: {
      delegationId: 'delegation',
      runGeneration: 1,
      launchKey: 'launch',
      parent,
      task,
      route,
      cwd: '/tmp/delegation-route-runtime-test',
      effectivePermission: 'read-only',
      signal,
    },
    signal,
    emit: (): Promise<void> => Promise.resolve(),
    accepted: (): Promise<void> => Promise.resolve(),
    retain: (close): void => {
      retained.push(close);
    },
    setInterrupt: (): void => undefined,
    setSteer: (): void => undefined,
  };
}

interface HeldRun {
  readonly context: LocalDelegationContext;
  /** Every value the runner reported, cleanup errors included. */
  readonly reported: readonly unknown[];
  readonly terminal: Promise<AgentDelegationEvent['event']>;
  finish(
    outcome: LocalDelegationOutcome | Promise<LocalDelegationOutcome>,
  ): void;
  close(): Promise<void>;
}

/**
 * A real Claude runner whose `execute` waits for `finish`, so preparation
 * retains into the runner's own cleanup and diagnostic reporting.
 */
async function heldRunnerContext(
  route: ResolvedAgentRouteSnapshot,
): Promise<HeldRun> {
  let finish: HeldRun['finish'] = () => undefined;
  const outcome = new Promise<LocalDelegationOutcome>((resolve) => {
    finish = resolve;
  });
  let bind: (context: LocalDelegationContext) => void = () => undefined;
  const bound = new Promise<LocalDelegationContext>((resolve) => {
    bind = resolve;
  });
  let end: (event: AgentDelegationEvent['event']) => void = () => undefined;
  const terminal = new Promise<AgentDelegationEvent['event']>((resolve) => {
    end = resolve;
  });
  const reported: unknown[] = [];
  const runner = new LocalDelegationRunner(
    'claude',
    'claude-sdk',
    () => Promise.resolve({ available: true }),
    (context) => {
      bind(context);
      return outcome;
    },
    (error) => {
      reported.push(error);
      reportDelegationError(error);
    },
  );
  const { request } = prepareContext(route, new AbortController().signal, []);
  const handle = await runner.start(request, (envelope) => {
    if (envelope.event.type === 'terminal') end(envelope.event);
    return Promise.resolve();
  });
  return {
    context: await bound,
    reported,
    terminal,
    finish: (value) => finish(value),
    close: () => runner.close(handle),
  };
}

it.each(['edited', 'deleted'] as const)(
  'keeps retained Agent instructions and plugin bytes on follow-up after the definition is %s',
  async (change) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'agent-route-retained-'),
    );
    mockAgentDefinition = {
      revision: 'original',
      instructions: 'ORIGINAL_AGENT_INSTRUCTIONS',
      pluginMarker: 'ORIGINAL_SELECTED_PLUGIN',
    };
    const routeRuntime = new DelegationRouteRuntime({
      directory,
      owner: (): AgentSessionOptions => ({
        cwd: '/tmp/delegation-route-runtime-test',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      }),
      getWindow: (): null => null,
      authGeneration: (): number => 1,
    });
    const agentTask = { ...task, modelId: 'agent_model_reviewer' };
    const mockedLstat = jest.mocked(lstat);
    const priorLstat = mockedLstat.getMockImplementation();
    mockedLstat.mockImplementation(
      jest.requireActual<typeof FsPromises>('node:fs/promises').lstat,
    );
    try {
      const first = await routeRuntime.resolve(
        parent,
        agentTask,
        new AbortController().signal,
      );
      if (!first.ok) throw new Error('Expected initial Agent route');
      routeRuntime.release(first.value);
      mockAgentDefinition =
        change === 'deleted'
          ? null
          : {
              revision: 'edited',
              instructions: 'EDITED_AGENT_INSTRUCTIONS',
              pluginMarker: 'EDITED_SELECTED_PLUGIN',
            };
      if (change === 'edited') {
        await expect(
          routeRuntime.resolve(
            parent,
            agentTask,
            new AbortController().signal,
            { ...first.value, agentOverlay: undefined },
          ),
        ).resolves.toMatchObject({ ok: false });
      }
      const continued = await routeRuntime.resolve(
        parent,
        agentTask,
        new AbortController().signal,
        first.value,
      );
      expect(continued).toMatchObject({
        ok: true,
        value: {
          selectedModelId: 'agent_model_reviewer',
          agentOverlay: {
            artifact: first.value.agentOverlay?.artifact,
            systemPromptAppend: 'ORIGINAL_AGENT_INSTRUCTIONS',
          },
        },
      });
      expect(mockMaterializeDelegationCapabilities).toHaveBeenCalledTimes(1);
      // Phase 1: a continuation never re-materializes and never carries a
      // fresh capability grant — the grant is fixed at spawn (routes never
      // retain it; the broker moves it onto the delegation record instead).
      if (continued.ok)
        expect(continued.value).not.toHaveProperty('capabilityGrant');
      if (!continued.ok || !continued.value.routeId)
        throw new Error('Expected retained follow-up route');
      const captured = capturedRoutes(routeRuntime);
      expect(captured.get(continued.value.routeId)).toMatchObject({
        capabilities: {
          pluginFiles: {
            'plugins/selected/skills/review/SKILL.md':
              'ORIGINAL_SELECTED_PLUGIN',
          },
        },
      });
      expect(
        mockResolveAgentModelRuntime.mock.calls.filter(
          ([options]) => options.model === 'agent_model_reviewer',
        ),
      ).toHaveLength(1);
      expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith(
        'gpt-5.6-sol',
      );
      routeRuntime.release(continued.value);
      mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);
      await expect(
        routeRuntime.resolve(
          parent,
          agentTask,
          new AbortController().signal,
          first.value,
        ),
      ).resolves.toMatchObject({ ok: false });
    } finally {
      if (priorLstat) mockedLstat.mockImplementation(priorLstat);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it('gates selected MCP calls under the resolved server name and revokes the child session', async () => {
  const routeRuntime = runtime();
  const resolved = await routeRuntime.resolve(
    parent,
    task,
    new AbortController().signal,
  );
  if (!resolved.ok) throw new Error('Expected route capture');
  withSelectedMcp(routeRuntime, resolved.value);
  const proxyUrl = 'http://127.0.0.1:1234/proxy';
  mockResolveDelegatedMcpCapabilities.mockResolvedValueOnce({
    mcpServers: {},
    codexMcpServers: { selected_server: { url: proxyUrl } },
    serverNameByProxyUrl: { [proxyUrl]: 'selected_server' },
    providerGatedServers: [],
    unavailable: [],
  });
  const controller = new AbortController();
  const retained: Array<() => Promise<void>> = [];
  const prepared = await routeRuntime.prepareCodex(
    prepareContext(resolved.value, controller.signal, retained),
  );
  expect(prepared.selectedMcpServers).toHaveProperty('selected_server');
  const [sessionId, gate] = mockSetSessionToolCallGate.mock.calls[0];
  await expect(
    gate({ proxyUrl, tool: 'review_evidence', args: {}, requestId: 'mcp-1' }),
  ).resolves.toBe(true);
  expect(mockApprovalCheck).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'mcp',
      server: 'selected_server',
      tool: 'review_evidence',
    }),
  );
  await expect(
    gate({
      proxyUrl: 'http://127.0.0.1:1234/ambient',
      tool: 'review_evidence',
      args: {},
      requestId: 'mcp-2',
    }),
  ).resolves.toBe(false);
  controller.abort();
  await expect(
    gate({ proxyUrl, tool: 'review_evidence', args: {}, requestId: 'mcp-3' }),
  ).resolves.toBe(false);
  for (const close of retained.reverse()) await close();
  expect(mockUnregisterRoutesForSession).toHaveBeenCalledWith(sessionId);
  expect(mockRevokeStdioMcpRoutes).toHaveBeenCalledWith(sessionId);
  routeRuntime.release(resolved.value);
});

it.each(['unchanged', 'mode', 'rules'] as const)(
  'rechecks live policy at Cursor MCP execution after ACP admission: %s',
  async (drift) => {
    mockChildHarness = 'cursor';
    const owner: AgentSessionOptions = {
      cwd: '/tmp/delegation-route-runtime-test',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      planMode: false,
      approvalMode: 'full-access',
    };
    const routeRuntime = runtime(owner);
    const resolved = await routeRuntime.resolve(
      parent,
      { ...task, modelId: 'cursor-default' },
      new AbortController().signal,
    );
    if (!resolved.ok) throw new Error('Expected Cursor route');
    withSelectedMcp(routeRuntime, resolved.value);
    const proxyUrl = 'http://127.0.0.1:1234/cursor-proxy';
    mockResolveDelegatedMcpCapabilities.mockResolvedValueOnce({
      mcpServers: { selected_server: { url: proxyUrl } },
      codexMcpServers: {},
      serverNameByProxyUrl: { [proxyUrl]: 'selected_server' },
      providerGatedServers: [],
      unavailable: [],
    });
    const controller = new AbortController();
    const retained: Array<() => Promise<void>> = [];
    const prepared = await routeRuntime.prepareCursor(
      prepareContext(resolved.value, controller.signal, retained),
    );
    const consumeAllowance = jest.fn(() => true);
    const recordGateDecision = jest.fn();
    prepared.bindMcpGates({
      signal: controller.signal,
      pluginCallIdentity: () => 'approved-call',
      consumeAllowance,
      recordGateDecision,
    } as unknown as Parameters<typeof prepared.bindMcpGates>[0]);
    const [, gate] = mockSetSessionToolCallGate.mock.calls[0];
    const call = {
      proxyUrl,
      tool: 'review_evidence',
      args: {},
      requestId: 'mcp-1',
    };
    owner.planMode = true;
    await expect(gate(call)).resolves.toBe(false);
    expect(consumeAllowance).not.toHaveBeenCalled();
    owner.planMode = false;
    mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);
    await expect(gate(call)).resolves.toBe(false);
    expect(consumeAllowance).not.toHaveBeenCalled();
    mockIsModelBlockedByStoredPolicy.mockResolvedValue(false);
    // The matching ACP receipt was issued before this policy change.
    if (drift === 'mode') owner.approvalMode = 'ask';
    if (drift === 'rules') mockApprovalPolicyContextKey = 'policy:1:0';
    if (drift !== 'unchanged')
      mockApprovalCheck.mockResolvedValueOnce({ decision: 'deny' });
    await expect(gate(call)).resolves.toBe(drift === 'unchanged');
    expect(consumeAllowance).toHaveBeenCalledTimes(1);
    // ACP already supplies completion evidence; do not leave a second receipt
    // that a later call with identical arguments could consume.
    expect(recordGateDecision).not.toHaveBeenCalled();
    expect(mockApprovalCheck).toHaveBeenCalledTimes(1);
    expect(mockApprovalSetMode).toHaveBeenLastCalledWith(owner.approvalMode);
    for (const close of retained.reverse()) await close();
    routeRuntime.release(resolved.value);
  },
);

it('registers MCP cleanup before selected capability resolution can fail', async () => {
  const routeRuntime = runtime();
  const resolved = await routeRuntime.resolve(
    parent,
    task,
    new AbortController().signal,
  );
  if (!resolved.ok) throw new Error('Expected route capture');
  withSelectedMcp(routeRuntime, resolved.value);
  mockResolveDelegatedMcpCapabilities.mockRejectedValueOnce(
    new DelegationAgentCapabilityError('config_changed'),
  );
  const retained: Array<() => Promise<void>> = [];
  await expect(
    routeRuntime.prepareCodex(
      prepareContext(resolved.value, new AbortController().signal, retained),
    ),
  ).rejects.toMatchObject({
    detail: { code: 'capability_unavailable' },
    message:
      'A selected Agent capability changed. Start a new delegation with the current configuration.',
  });
  expect(retained.length).toBeGreaterThan(0);
  for (const close of retained.reverse()) await close();
  expect(mockUnregisterRoutesForSession).toHaveBeenCalledTimes(1);
  expect(mockRevokeStdioMcpRoutes).toHaveBeenCalledTimes(1);
  routeRuntime.release(resolved.value);
});

const LAUNCH_UNCERTAIN = {
  code: 'launch_uncertain',
  message: 'Delegated runner cleanup could not be confirmed.',
  retryable: false,
};

it('reports each failed cleanup of a partial Claude preparation by resource, never by value', async () => {
  const C = CLEANUP_CANARY;
  mockChildHarness = 'claude';
  mockResolveHelperInvocation.mockResolvedValueOnce({
    providerType: 'claude',
    source: 'claude-managed',
    harness: 'claude',
    sdkModel: 'claude-test',
    aiCreditsRouted: false,
    envOverride: { ANTHROPIC_API_KEY: 'test-key' },
    dispose: mockDisposeInvocation,
  });
  const routeRuntime = runtime();
  const resolved = await routeRuntime.resolve(
    parent,
    task,
    new AbortController().signal,
  );
  if (!resolved.ok) throw new Error('Expected route capture');
  withSelectedMcp(routeRuntime, resolved.value);
  mockResolveDelegatedMcpCapabilities.mockRejectedValueOnce(
    new DelegationAgentCapabilityError('config_changed'),
  );
  const notEmpty = (): Error =>
    Object.assign(new Error(`ENOTEMPTY: rmdir '/Users/someone/${C}'`), {
      code: 'ENOTEMPTY',
      path: `/tmp/${C}`,
    });
  const mockedRm = jest.mocked(rm);
  mockedRm
    .mockClear()
    .mockRejectedValueOnce(notEmpty())
    .mockRejectedValueOnce(notEmpty());
  mockRevokeStdioMcpRoutes.mockRejectedValueOnce(
    Object.assign(
      new Error(`project/worktree/chat:delegated:delegation:1 sk-ant-${C}`),
      { config: { mcpServers: { review: { env: { TOKEN: C } } } } },
    ),
  );
  mockApprovalDispose.mockImplementationOnce(() => {
    throw new TypeError(`sk-ant-${C}`);
  });
  try {
    const held = await heldRunnerContext(resolved.value);
    const preparing = routeRuntime.prepareClaude(held.context);
    held.finish(
      preparing.then(() => {
        throw new Error('Expected the preparation to fail');
      }),
    );
    await expect(preparing).rejects.toMatchObject({
      detail: { code: 'capability_unavailable' },
    });
    await expect(held.terminal).resolves.toEqual({
      type: 'terminal',
      status: 'failed',
      error: LAUNCH_UNCERTAIN,
    });

    // Registration order; the Claude temp dir was never created.
    const notEmptyFields = errorFields('Error', 'ENOTEMPTY');
    const failures = [
      failure(CLEANUP_RESOURCES.approval, 'threw', errorFields('TypeError')),
      failure(CLEANUP_RESOURCES.background, 'rejected', notEmptyFields),
      failure(CLEANUP_RESOURCES.overlay, 'rejected', notEmptyFields),
      failure(CLEANUP_RESOURCES.mcp, 'rejected', errorFields('Error')),
    ];
    expect(reportedCleanupDiagnostics(held.reported)).toEqual([
      expect.objectContaining({ attempt: 1, retained: 4, failures }),
    ]);
    const warn = jest.mocked(logMainProcessWarn);
    expect(cleanupRecords(warn)).toEqual([cleanupRecord({ failures })]);

    // The retry releases everything, so a later close logs nothing more.
    await expect(held.close()).resolves.toBeUndefined();
    await expect(held.close()).resolves.toBeUndefined();
    expect(cleanupRecords(warn)).toHaveLength(1);
    expect(mockedRm).toHaveBeenCalledTimes(4);
    expect(mockApprovalDispose).toHaveBeenCalledTimes(2);
    expect(mockRevokeStdioMcpRoutes).toHaveBeenCalledTimes(2);
    routeRuntime.release(resolved.value);
  } finally {
    mockedRm.mockReset();
    mockedRm.mockImplementation(
      jest.requireActual<typeof FsPromises>('node:fs/promises').rm,
    );
    mockRevokeStdioMcpRoutes.mockReset();
    mockRevokeStdioMcpRoutes.mockImplementation(() => Promise.resolve());
  }
});

it('gives a Codex child the login-shell PATH, read access to its toolchains and a private TMPDIR', async () => {
  const homeBin = path.join(homedir(), 'bin');
  const commandPath = [
    '/tools/node/bin',
    homeBin,
    'relative/bin',
    '/usr/bin',
    '/app-data/canopy/chat-plugins/review/bin',
  ].join(path.delimiter);
  mockGetLoginShellPath.mockReturnValueOnce(commandPath);
  const routeRuntime = runtime();
  const resolved = await routeRuntime.resolve(
    parent,
    task,
    new AbortController().signal,
  );
  if (!resolved.ok) throw new Error('Expected route capture');
  const retained: Array<() => Promise<void>> = [];
  const prepared = await routeRuntime.prepareCodex(
    prepareContext(resolved.value, new AbortController().signal, retained),
  );
  const environment = prepared.commandEnvironment;
  expect(environment?.commandPath).toBe(commandPath);
  expect(environment?.toolchainReadRoots).toEqual(
    expect.arrayContaining(['/tools/node', homeBin, '/usr']),
  );
  // A root inside another granted root adds nothing, so only the outermost
  // is kept.
  expect(environment?.toolchainReadRoots).not.toContain('/tools/node/bin');
  expect(environment?.toolchainReadRoots).not.toContain('/usr/bin');
  // A `bin` directory directly under home grants only itself, never home.
  expect(environment?.toolchainReadRoots).not.toContain(homedir());
  expect(environment?.toolchainReadRoots).not.toContain('relative/bin');
  // Nothing inside the app's data directory, whatever PATH holds.
  expect(
    environment?.toolchainReadRoots.filter((root) =>
      root.startsWith('/app-data'),
    ),
  ).toEqual([]);
  const temporary = environment?.temporaryDirectory ?? '';
  expect(path.isAbsolute(temporary)).toBe(true);
  expect((await stat(temporary)).isDirectory()).toBe(true);
  for (const close of retained.reverse()) await close();
  await expect(stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
  routeRuntime.release(resolved.value);
});

it('grants toolchain reads only at resolved locations, so a PATH symlink cannot alias a private directory', async () => {
  const mockedRealpath = jest.mocked(realpath);
  const priorRealpath = mockedRealpath.getMockImplementation();
  const privateTarget = path.join(homedir(), '.ssh', 'bin');
  mockedRealpath.mockImplementation((file) => {
    const target = String(file);
    if (target === '/aliases/keys/bin') return Promise.resolve(privateTarget);
    if (target === '/missing/bin')
      return Promise.reject(new Error('ENOENT: no such file or directory'));
    return Promise.resolve(target);
  });
  const commandPath = [
    '/aliases/keys/bin',
    '/missing/bin',
    '/tools/node/bin',
  ].join(path.delimiter);
  mockGetLoginShellPath.mockReturnValueOnce(commandPath);
  const routeRuntime = runtime();
  const retained: Array<() => Promise<void>> = [];
  try {
    const resolved = await routeRuntime.resolve(
      parent,
      task,
      new AbortController().signal,
    );
    if (!resolved.ok) throw new Error('Expected route capture');
    const prepared = await routeRuntime.prepareCodex(
      prepareContext(resolved.value, new AbortController().signal, retained),
    );
    const roots = prepared.commandEnvironment?.toolchainReadRoots ?? [];
    expect(roots).toContain('/tools/node');
    // Neither the alias nor its private target, nor an entry that does not
    // resolve, is readable; PATH itself keeps every entry for lookup.
    expect(
      roots.filter(
        (root) =>
          root.startsWith('/aliases') ||
          root.startsWith('/missing') ||
          root.startsWith(path.join(homedir(), '.ssh')),
      ),
    ).toEqual([]);
    expect(prepared.commandEnvironment?.commandPath).toBe(commandPath);
    routeRuntime.release(resolved.value);
  } finally {
    if (priorRealpath) mockedRealpath.mockImplementation(priorRealpath);
    for (const close of retained.reverse()) await close();
  }
});

it('grants a home toolchain only the runtime directories beside it that resolve to themselves', async () => {
  const mockedRealpath = jest.mocked(realpath);
  const priorRealpath = mockedRealpath.getMockImplementation();
  const home = homedir();
  const node = path.join(home, '.nvm', 'versions', 'node', 'v24.21.0');
  const pulumi = path.join(home, '.pulumi');
  const aliased = path.join(home, 'tools', 'aliased');
  const existing = new Set([
    path.join(node, 'bin'),
    path.join(node, 'lib'),
    path.join(node, 'include'),
    path.join(pulumi, 'bin'),
    path.join(aliased, 'bin'),
  ]);
  mockedRealpath.mockImplementation((file) => {
    const target = String(file);
    // A `lib` beside a home toolchain that links to a private directory.
    if (target === path.join(aliased, 'lib'))
      return Promise.resolve(path.join(home, '.ssh'));
    if (existing.has(target) || !target.startsWith(home))
      return Promise.resolve(target);
    return Promise.reject(new Error('ENOENT: no such file or directory'));
  });
  const commandPath = [
    path.join(node, 'bin'),
    path.join(pulumi, 'bin'),
    path.join(aliased, 'bin'),
  ].join(path.delimiter);
  mockGetLoginShellPath.mockReturnValueOnce(commandPath);
  const routeRuntime = runtime();
  const retained: Array<() => Promise<void>> = [];
  try {
    const resolved = await routeRuntime.resolve(
      parent,
      task,
      new AbortController().signal,
    );
    if (!resolved.ok) throw new Error('Expected route capture');
    const prepared = await routeRuntime.prepareCodex(
      prepareContext(resolved.value, new AbortController().signal, retained),
    );
    const roots = prepared.commandEnvironment?.toolchainReadRoots ?? [];
    expect(roots).toEqual(
      expect.arrayContaining([
        path.join(node, 'bin'),
        path.join(node, 'lib'),
        path.join(node, 'include'),
        path.join(pulumi, 'bin'),
        path.join(aliased, 'bin'),
      ]),
    );
    // Never a tool folder that keeps credentials beside its binaries, and
    // nothing beside it that is missing or links elsewhere.
    for (const denied of [
      node,
      pulumi,
      aliased,
      path.join(node, 'libexec'),
      path.join(pulumi, 'lib'),
      path.join(aliased, 'lib'),
      path.join(home, '.ssh'),
    ])
      expect(roots).not.toContain(denied);
    routeRuntime.release(resolved.value);
  } finally {
    if (priorRealpath) mockedRealpath.mockImplementation(priorRealpath);
    for (const close of retained.reverse()) await close();
  }
});

it('stages only retained Claude plugin bytes for the child and removes them on release', async () => {
  mockChildHarness = 'claude';
  mockResolveHelperInvocation.mockResolvedValueOnce({
    providerType: 'claude',
    source: 'claude-managed',
    harness: 'claude',
    sdkModel: 'claude-test',
    aiCreditsRouted: false,
    envOverride: { ANTHROPIC_API_KEY: 'test-key' },
    dispose: mockDisposeInvocation,
  });
  const routeRuntime = runtime();
  const resolved = await routeRuntime.resolve(
    parent,
    task,
    new AbortController().signal,
  );
  if (!resolved.ok || !resolved.value.routeId)
    throw new Error('Expected route capture');
  const captured = capturedRoutes(routeRuntime);
  captured.set(resolved.value.routeId, {
    ...captured.get(resolved.value.routeId),
    capabilities: {
      version: 3,
      pluginFiles: {
        'selected/.claude-plugin/plugin.json': '{"name":"reviewer"}',
        'selected/skills/review/SKILL.md': 'retained marker',
      },
      capabilities: {
        claudePluginRoots: ['selected'],
        claudeSkillNames: ['reviewer:review'],
        codexCapabilityRoots: [],
        mcpSelections: [],
        mcpHttpAuthPreferences: [],
        hookDeclarations: [],
      },
      provenance: {
        roots: { selected: 'agent' },
        mcpSelections: [],
      },
      items: [],
    } satisfies MaterializedCapabilityOverlay,
  });
  const retained: Array<() => Promise<void>> = [];
  const prepared = await routeRuntime.prepareClaude(
    prepareContext(resolved.value, new AbortController().signal, retained),
  );
  const pluginPath = prepared.plugins?.[0]?.path;
  expect(prepared.plugins?.[0]).toMatchObject({ skipMcpDiscovery: true });
  expect(prepared.skillNames).toEqual(['reviewer:review']);
  expect(pluginPath).toBeDefined();
  if (!pluginPath) throw new Error('Expected a staged Claude plugin');
  await expect(
    readFile(`${pluginPath}/skills/review/SKILL.md`, 'utf8'),
  ).resolves.toBe('retained marker');
  expect(mockResolveDelegatedMcpCapabilities).not.toHaveBeenCalled();
  for (const close of retained.reverse()) await close();
  await expect(stat(pluginPath)).rejects.toMatchObject({ code: 'ENOENT' });
  routeRuntime.release(resolved.value);
});

it('grants Codex read access to the exact published selected capability root', async () => {
  const routeRuntime = runtime();
  const resolved = await routeRuntime.resolve(
    parent,
    task,
    new AbortController().signal,
  );
  if (!resolved.ok || !resolved.value.routeId)
    throw new Error('Expected route capture');
  const captured = capturedRoutes(routeRuntime);
  captured.set(resolved.value.routeId, {
    ...captured.get(resolved.value.routeId),
    capabilities: {
      version: 3,
      pluginFiles: {
        'selected/.codex-plugin/plugin.json': '{"name":"reviewer"}',
        'selected/skills/review/SKILL.md': 'retained marker',
      },
      capabilities: {
        claudePluginRoots: [],
        claudeSkillNames: [],
        codexCapabilityRoots: ['selected'],
        mcpSelections: [],
        mcpHttpAuthPreferences: [],
        hookDeclarations: [],
      },
      provenance: {
        roots: { selected: 'agent' },
        mcpSelections: [],
      },
      items: [],
    } satisfies MaterializedCapabilityOverlay,
  });
  const retained: Array<() => Promise<void>> = [];
  const prepared = await routeRuntime.prepareCodex(
    prepareContext(resolved.value, new AbortController().signal, retained),
  );
  expect(mockPublishSelectedRoots).toHaveBeenCalledTimes(1);
  expect(prepared.selectedCapabilityRoots).toEqual([
    {
      id: 'published-root',
      location: {
        type: 'environment',
        environmentId: 'local',
        path: PUBLISHED_ROOT_URL,
      },
    },
  ]);
  expect(prepared.tools.readRoots).toContain(PUBLISHED_ROOT);
  expect(prepared.tools.readRoots).not.toContain(path.dirname(PUBLISHED_ROOT));
  for (const close of retained.reverse()) await close();
  routeRuntime.release(resolved.value);
});

it('uses the retained helper quota waiter in a prepared delegate', async () => {
  const wait = jest
    .fn<Promise<void>, [unknown, AbortSignal?]>()
    .mockResolvedValue(undefined);
  mockResolveHelperInvocation.mockResolvedValueOnce({
    providerType: 'codex',
    source: 'codex-managed',
    harness: 'codex',
    sdkModel: 'gpt-5.6-sol',
    aiCreditsRouted: false,
    waitForQuotaRecovery: wait,
    dispose: mockDisposeInvocation,
  });
  const routeRuntime = runtime();
  const controller = new AbortController();
  const resolved = await routeRuntime.resolve(parent, task, controller.signal);
  if (!resolved.ok) throw new Error('Expected route capture');
  const retained: Array<() => Promise<void>> = [];
  try {
    const prepared = await routeRuntime.prepareCodex(
      prepareContext(resolved.value, controller.signal, retained),
    );
    await prepared.waitForQuotaRecovery?.(
      {
        kind: 'provider_usage_limit',
        code: 'http_429',
        provider: 'codex',
        account_scope: 'native',
        diagnostic_message: 'Pool quota reached',
      },
      controller.signal,
    );
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'provider_usage_limit' }),
      controller.signal,
    );
  } finally {
    for (const close of retained.reverse()) await close();
    routeRuntime.release(resolved.value);
  }
  expect(mockDisposeInvocation).toHaveBeenCalledTimes(1);
});

it('disposes a captured helper route exactly once when released', async () => {
  const routeRuntime = runtime();
  const resolved = await routeRuntime.resolve(
    parent,
    task,
    new AbortController().signal,
  );
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error('Expected route capture');

  routeRuntime.release(resolved.value);
  routeRuntime.release(resolved.value);

  expect(mockDisposeInvocation).toHaveBeenCalledTimes(1);
});

it('captures a Windows Codex route without a Codex sandbox', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!descriptor) throw new Error('Expected the platform property');
  Object.defineProperty(process, 'platform', {
    ...descriptor,
    value: 'win32',
  });
  try {
    const routeRuntime = runtime();
    const resolved = await routeRuntime.resolve(
      parent,
      task,
      new AbortController().signal,
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) routeRuntime.release(resolved.value);
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
});

it('keeps unsupported native targets unavailable', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!descriptor) throw new Error('Expected the platform property');
  Object.defineProperty(process, 'platform', {
    ...descriptor,
    value: 'linux',
  });
  try {
    mockResolveHelperInvocation.mockClear();
    await expect(
      runtime().resolve(parent, task, new AbortController().signal),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'capability_unavailable' },
    });
    expect(mockResolveHelperInvocation).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
});

it('disposes a helper route when resolution aborts after allocation', async () => {
  const controller = new AbortController();
  mockResolveHelperInvocation.mockImplementationOnce(() => {
    controller.abort();
    return Promise.resolve({
      providerType: 'codex',
      source: 'codex-managed',
      harness: 'codex',
      sdkModel: 'gpt-5.6-sol',
      aiCreditsRouted: false,
      dispose: mockDisposeInvocation,
    });
  });

  await expect(
    runtime().resolve(parent, task, controller.signal),
  ).resolves.toMatchObject({
    ok: false,
  });
  expect(mockDisposeInvocation).toHaveBeenCalledTimes(1);
});

async function prepareSharedWriter(
  owner: AgentSessionOptions,
  liveOwner?: () => AgentSessionOptions | undefined,
): Promise<{
  prepared: Awaited<ReturnType<DelegationRouteRuntime['prepareCodex']>>;
  cleanup: () => Promise<void>;
}> {
  const routeRuntime = liveOwner
    ? new DelegationRouteRuntime({
        directory: '/tmp/delegation-route-runtime-test',
        owner: liveOwner,
        getWindow: (): null => null,
        authGeneration: (): number => 1,
      })
    : runtime(owner);
  const resolved = await routeRuntime.resolve(
    parent,
    { ...task, permissions: { writePaths: ['src'] } },
    new AbortController().signal,
  );
  if (!resolved.ok) throw new Error('Expected route capture');
  const controller = new AbortController();
  const retained: Array<() => Promise<void>> = [];
  const context: LocalDelegationContext = {
    request: {
      delegationId: 'delegation',
      runGeneration: 1,
      launchKey: 'launch',
      parent,
      task: { ...task, permissions: { writePaths: ['src'] } },
      route: resolved.value,
      cwd: owner.cwd,
      effectivePermission: 'read-only',
      signal: controller.signal,
    },
    signal: controller.signal,
    emit: (): Promise<void> => Promise.resolve(),
    accepted: (): Promise<void> => Promise.resolve(),
    retain: (close): void => {
      retained.push(close);
    },
    setInterrupt: (): void => undefined,
    setSteer: (): void => undefined,
  };
  const prepared = await routeRuntime.prepareCodex(context);
  return {
    prepared,
    cleanup: async (): Promise<void> => {
      for (const close of retained.reverse()) await close();
      routeRuntime.release(resolved.value);
    },
  };
}

const allowWrites = {
  id: 'allow-writes',
  description: 'Allow writes for this chat',
  toolPattern: '*',
  action: 'allow' as const,
};

it('keeps delegated approvals when the root chat adds a session rule', async () => {
  const owner: AgentSessionOptions = {
    cwd: '/tmp/delegation-route-runtime-test',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    approvalMode: 'full-access',
    sessionApprovalRules: [],
  };
  const { prepared, cleanup } = await prepareSharedWriter(owner);
  await expect(
    prepared.tools.authorize(
      'Write',
      { path: 'src/before.ts', expected: 'before', text: 'after' },
      'write-before-rule',
    ),
  ).resolves.toBe(true);
  // "Always allow" on a root prompt adds a session rule to the root chat.
  owner.sessionApprovalRules?.push(allowWrites);

  await expect(
    prepared.tools.authorize(
      'Write',
      { path: 'src/file.ts', expected: 'before', text: 'after' },
      'write-after-rule',
    ),
  ).resolves.toBe(true);
  // The child's approval handle evaluates the root chat's live rules.
  expect(mockApprovalRules).toEqual([allowWrites]);
  await cleanup();
});

it('stops applying a session rule the root chat removed', async () => {
  const owner: AgentSessionOptions = {
    cwd: '/tmp/delegation-route-runtime-test',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    approvalMode: 'ask',
    sessionApprovalRules: [allowWrites],
  };
  mockApprovalCheck.mockImplementation(() =>
    Promise.resolve({
      decision: mockApprovalRules.some((rule) => rule.id === allowWrites.id)
        ? 'allow'
        : 'deny',
    }),
  );
  const { prepared, cleanup } = await prepareSharedWriter(owner);
  await expect(
    prepared.tools.authorize(
      'Write',
      { path: 'src/before.ts', expected: 'before', text: 'after' },
      'write-with-rule',
    ),
  ).resolves.toBe(true);
  owner.sessionApprovalRules = [];

  await expect(
    prepared.tools.authorize(
      'Write',
      { path: 'src/file.ts', expected: 'before', text: 'after' },
      'write-without-rule',
    ),
  ).resolves.toBe(false);
  expect(mockDelegationWrite).not.toHaveBeenCalled();
  await cleanup();
});

it('applies a narrowed session rule from the root chat', async () => {
  const owner: AgentSessionOptions = {
    cwd: '/tmp/delegation-route-runtime-test',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    approvalMode: 'ask',
    sessionApprovalRules: [allowWrites],
  };
  const { prepared, cleanup } = await prepareSharedWriter(owner);
  await expect(
    prepared.tools.authorize(
      'Write',
      { path: 'src/before.ts', expected: 'before', text: 'after' },
      'write-with-rule',
    ),
  ).resolves.toBe(true);
  const narrowed = { ...allowWrites, toolPattern: 'Read' };
  owner.sessionApprovalRules = [narrowed];

  await expect(
    prepared.tools.authorize(
      'Write',
      { path: 'src/file.ts', expected: 'before', text: 'after' },
      'write-after-narrowing',
    ),
  ).resolves.toBe(true);
  expect(mockApprovalRules).toEqual([narrowed]);
  await cleanup();
});

it('does not honor an in-flight approval after the root chat removes a session rule', async () => {
  const owner: AgentSessionOptions = {
    cwd: '/tmp/delegation-route-runtime-test',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    approvalMode: 'ask',
    sessionApprovalRules: [allowWrites],
  };
  let finishApproval: ((result: { decision: string }) => void) | undefined;
  mockApprovalCheck.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishApproval = resolve;
      }),
  );
  const { prepared, cleanup } = await prepareSharedWriter(owner);
  const authorizing = prepared.tools.authorize(
    'Write',
    { path: 'src/file.ts', expected: 'before', text: 'after' },
    'write-call',
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(mockApprovalCheck).toHaveBeenCalledTimes(1);
  owner.sessionApprovalRules = [];
  finishApproval?.({ decision: 'allow' });

  await expect(authorizing).resolves.toBe(false);
  expect(mockDelegationWrite).not.toHaveBeenCalled();
  await cleanup();
});

describe('a root session rule added while a child approval is pending', () => {
  const denyWrites: ApprovalRule = {
    id: 'deny-writes',
    behavior: 'deny',
    target: { kind: 'file-write', path: 'src' },
    createdAt: '2026-09-28T00:00:00.000Z',
    origin: 'prompt',
  };
  const allowReadTool: ApprovalRule = {
    id: 'allow-read-tool',
    behavior: 'allow',
    target: { kind: 'tool', toolName: 'Read' },
    createdAt: '2026-09-28T00:00:00.000Z',
    origin: 'prompt',
  };

  async function pendingWrite(owner: AgentSessionOptions): Promise<{
    prepared: Awaited<ReturnType<DelegationRouteRuntime['prepareCodex']>>;
    authorizing: Promise<boolean>;
    finish: (decision: 'allow' | 'deny') => void;
    settled: () => boolean;
    cleanup: () => Promise<void>;
  }> {
    let finishApproval: ((result: { decision: string }) => void) | undefined;
    mockApprovalCheck.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishApproval = resolve;
        }),
    );
    const { prepared, cleanup } = await prepareSharedWriter(owner);
    let done = false;
    const authorizing = prepared.tools
      .authorize(
        'Write',
        { path: 'src/file.ts', expected: 'before', text: 'after' },
        'write-call',
      )
      .finally(() => {
        done = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockApprovalCheck).toHaveBeenCalledTimes(1);
    return {
      prepared,
      authorizing,
      finish: (decision): void => finishApproval?.({ decision }),
      settled: (): boolean => done,
      cleanup,
    };
  }

  function askOwner(): AgentSessionOptions {
    return {
      cwd: '/tmp/delegation-route-runtime-test',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      approvalMode: 'ask',
      sessionApprovalRules: [],
    };
  }

  it('denies the pending request when the rule is a deny rule', async () => {
    const owner = askOwner();
    const pending = await pendingWrite(owner);
    owner.sessionApprovalRules?.push(denyWrites);
    // The prompt was answered under the policy it was shown with.
    pending.finish('allow');

    await expect(pending.authorizing).resolves.toBe(false);
    expect(mockDelegationWrite).not.toHaveBeenCalled();
    // A retry is evaluated against the current rules.
    mockApprovalCheck.mockImplementationOnce(() =>
      Promise.resolve({
        decision: mockApprovalRules.some((rule) => rule.id === denyWrites.id)
          ? 'deny'
          : 'allow',
      }),
    );
    await expect(
      pending.prepared.tools.authorize(
        'Write',
        { path: 'src/file.ts', expected: 'before', text: 'after' },
        'write-retry',
      ),
    ).resolves.toBe(false);
    expect(mockApprovalRules).toEqual([denyWrites]);
    await pending.cleanup();
  });

  it('does not grant the pending request because of an unrelated allow rule', async () => {
    const owner = askOwner();
    const pending = await pendingWrite(owner);
    owner.sessionApprovalRules?.push(allowReadTool);
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The new rule does not decide the request for the user.
    expect(pending.settled()).toBe(false);
    pending.finish('allow');

    // The approval's policy changed while it was pending: fail closed.
    await expect(pending.authorizing).resolves.toBe(false);
    expect(mockDelegationWrite).not.toHaveBeenCalled();
    await pending.cleanup();
  });
});

it('keeps a delegate read-only while its root owner is unavailable', async () => {
  const owner: AgentSessionOptions = {
    cwd: '/tmp/delegation-route-runtime-test',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    approvalMode: 'full-access',
  };
  let available = true;
  const { prepared, cleanup } = await prepareSharedWriter(owner, () =>
    available ? owner : undefined,
  );
  expect(prepared.tools.writable()).toBe(true);
  owner.planMode = true;
  expect(prepared.tools.writable()).toBe(false);
  owner.planMode = false;
  expect(prepared.tools.writable()).toBe(true);
  // An owner that cannot be resolved is treated as planning.
  available = false;
  expect(prepared.tools.writable()).toBe(false);
  await cleanup();
});

it('revokes an in-flight delegated write when the parent approval mode changes', async () => {
  const owner: AgentSessionOptions = {
    cwd: '/tmp/delegation-route-runtime-test',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    approvalMode: 'full-access',
  };
  let finishApproval: ((result: { decision: string }) => void) | undefined;
  mockApprovalCheck.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishApproval = resolve;
      }),
  );
  const routeRuntime = runtime(owner);
  const resolved = await routeRuntime.resolve(
    parent,
    {
      ...task,
      permissions: { writePaths: ['src'] },
    },
    new AbortController().signal,
  );
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error('Expected route capture');
  const controller = new AbortController();
  const retained: Array<() => Promise<void>> = [];
  const prepared = await routeRuntime.prepareCodex({
    request: {
      delegationId: 'delegation',
      runGeneration: 1,
      launchKey: 'launch',
      parent,
      task: {
        ...task,
        permissions: { writePaths: ['src'] },
      },
      route: resolved.value,
      cwd: owner.cwd,
      effectivePermission: 'read-only',
      signal: controller.signal,
    },
    signal: controller.signal,
    emit: (): Promise<void> => Promise.resolve(),
    accepted: (): Promise<void> => Promise.resolve(),
    retain: (close): void => {
      retained.push(close);
    },
    setInterrupt: (): void => undefined,
    setSteer: (): void => undefined,
  });
  const authorizing = prepared.tools.authorize(
    'Write',
    { path: 'src/file.ts', expected: 'before', text: 'after' },
    'write-call',
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(mockApprovalCheck).toHaveBeenCalledTimes(1);
  owner.approvalMode = 'ask';
  finishApproval?.({ decision: 'allow' });

  await expect(authorizing).resolves.toBe(false);
  expect(mockApprovalSetMode).toHaveBeenLastCalledWith('ask');
  expect(mockDelegationWrite).not.toHaveBeenCalled();

  for (const close of retained.reverse()) await close();
  routeRuntime.release(resolved.value);
});

it('rechecks parent policy for each native write after persisted approval rules change', async () => {
  const owner: AgentSessionOptions = {
    cwd: '/tmp/delegation-route-runtime-test',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    approvalMode: 'full-access',
  };
  const routeRuntime = runtime(owner);
  const resolved = await routeRuntime.resolve(
    parent,
    {
      ...task,
      permissions: { writePaths: ['src'] },
    },
    new AbortController().signal,
  );
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error('Expected route capture');
  const controller = new AbortController();
  const retained: Array<() => Promise<void>> = [];
  const prepared = await routeRuntime.prepareCodex({
    request: {
      delegationId: 'delegation',
      runGeneration: 1,
      launchKey: 'launch',
      parent,
      task: {
        ...task,
        permissions: { writePaths: ['src'] },
      },
      route: resolved.value,
      cwd: owner.cwd,
      effectivePermission: 'read-only',
      signal: controller.signal,
    },
    signal: controller.signal,
    emit: (): Promise<void> => Promise.resolve(),
    accepted: (): Promise<void> => Promise.resolve(),
    retain: (close): void => {
      retained.push(close);
    },
    setInterrupt: (): void => undefined,
    setSteer: (): void => undefined,
  });
  const edit = {
    path: 'src/file.ts',
    expected: 'before',
    text: 'after',
  };
  await expect(
    prepared.tools.authorize('Write', edit, 'write-call'),
  ).resolves.toBe(true);
  mockApprovalPolicyContextKey = 'policy:1:0';
  mockApprovalCheck.mockResolvedValueOnce({ decision: 'deny' });

  await expect(
    prepared.tools.authorize('Write', edit, 'next-write-call'),
  ).resolves.toBe(false);
  expect(mockDelegationWrite).not.toHaveBeenCalled();

  for (const close of retained.reverse()) await close();
  routeRuntime.release(resolved.value);
});

it('rejects fast mode for a Claude child before acquiring an invocation', async () => {
  mockChildHarness = 'claude';
  const before = mockResolveHelperInvocation.mock.calls.length;
  await expect(
    runtime().resolve(
      parent,
      { ...task, fastMode: true },
      new AbortController().signal,
    ),
  ).resolves.toMatchObject({
    ok: false,
    error: { code: 'capability_unavailable' },
  });
  expect(mockResolveHelperInvocation.mock.calls).toHaveLength(before);
});

it('never selects a Windows sandbox level for the Codex worker', () => {
  expect(delegationCodexConfigArgs()).toEqual([
    '-c',
    'features.hooks=false',
    '-c',
    'features.apps=false',
  ]);
});

it('captures Windows Claude host inputs from the fixed profile allowlist', () => {
  const resolveGitBash = jest.fn(() => 'C:\\Program Files\\Git\\bin\\bash.exe');
  const environment = {
    APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
    USERNAME: 'dev',
    CANOPY_GIT_EXECUTABLE: 'C:\\Program Files\\Git\\cmd\\git.exe',
    SECRET_TOKEN: 'never-forwarded',
  };
  expect(captureWindowsClaudeHost(environment, resolveGitBash)).toEqual({
    gitBashPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
    windowsProfile: {
      APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
      LOCALAPPDATA: undefined,
      ProgramData: undefined,
      USERNAME: 'dev',
      PROCESSOR_ARCHITECTURE: undefined,
    },
  });
  expect(resolveGitBash).toHaveBeenCalledWith(environment);
  expect(
    captureWindowsClaudeHost(environment, () => null).gitBashPath,
  ).toBeUndefined();
});

it('keeps a gateway-routed Claude child off inline tool definitions (CAN-4647)', async () => {
  mockChildHarness = 'claude';
  mockResolveHelperInvocation.mockResolvedValueOnce({
    providerType: 'claude',
    source: 'claude-managed',
    harness: 'claude',
    sdkModel: 'claude-test',
    aiCreditsRouted: true,
    envOverride: {
      ANTHROPIC_BASE_URL: 'https://cloud.invalid/api/v1/llm-proxy/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'csk_test',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_INLINE_TOOLS: 'false',
    },
    dispose: mockDisposeInvocation,
  });
  const routeRuntime = runtime();
  const resolved = await routeRuntime.resolve(
    parent,
    task,
    new AbortController().signal,
  );
  if (!resolved.ok) throw new Error('Expected route capture');
  const retained: Array<() => Promise<void>> = [];
  const controller = new AbortController();
  const prepared = await routeRuntime.prepareClaude({
    request: {
      delegationId: 'delegation',
      runGeneration: 1,
      launchKey: 'launch',
      parent,
      task,
      route: resolved.value,
      cwd: '/tmp/delegation-route-runtime-test',
      effectivePermission: 'read-only',
      signal: controller.signal,
    },
    signal: controller.signal,
    emit: (): Promise<void> => Promise.resolve(),
    retain: (close): void => {
      retained.push(close);
    },
    setInterrupt: (): void => undefined,
    setSteer: (): void => undefined,
  });
  expect(prepared.environment.CLAUDE_CODE_INLINE_TOOLS).toBe('false');
  for (const close of retained.reverse()) await close();
  routeRuntime.release(resolved.value);
});

it('uses the prewarmed login-shell PATH for a delegated Claude child', async () => {
  mockChildHarness = 'claude';
  mockResolveHelperInvocation.mockResolvedValueOnce({
    providerType: 'claude',
    source: 'claude-managed',
    harness: 'claude',
    sdkModel: 'claude-test',
    aiCreditsRouted: false,
    envOverride: { ANTHROPIC_API_KEY: 'test-key' },
    dispose: mockDisposeInvocation,
  });
  const routeRuntime = runtime();
  const resolved = await routeRuntime.resolve(
    parent,
    task,
    new AbortController().signal,
  );
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error('Expected route capture');
  const retained: Array<() => Promise<void>> = [];
  const controller = new AbortController();
  // The host's Claude config directory reaches the child, as it reaches a
  // parent chat, so both read the same user settings.
  const priorConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '/isolated/claude-config';
  const prepared = await routeRuntime.prepareClaude({
    request: {
      delegationId: 'delegation',
      runGeneration: 1,
      launchKey: 'launch',
      parent,
      task,
      route: resolved.value,
      cwd: '/tmp/delegation-route-runtime-test',
      effectivePermission: 'read-only',
      signal: controller.signal,
    },
    signal: controller.signal,
    emit: (): Promise<void> => Promise.resolve(),
    retain: (close): void => {
      retained.push(close);
    },
    setInterrupt: (): void => undefined,
    setSteer: (): void => undefined,
  });
  if (priorConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = priorConfigDir;
  expect(prepared.environment.CLAUDE_CONFIG_DIR).toBe(
    '/isolated/claude-config',
  );
  expect(prepared.environment.PATH).toBe('/login/bin:/usr/bin:/bin');
  expect(mockGetLoginShellPath).toHaveBeenCalled();
  // Background task output lands in a private directory the child may read.
  // It is not announced as retained Agent files and ends with the run.
  const tasks = prepared.environment.CLAUDE_CODE_TMPDIR;
  if (!tasks) throw new Error('Expected a background task directory');
  expect(prepared.tools.readRoots).toContain(tasks);
  expect(prepared.tools.instructions()).not.toContain(tasks);
  expect((await stat(tasks)).isDirectory()).toBe(true);
  for (const close of retained.reverse()) await close();
  await expect(stat(tasks)).rejects.toThrow();
  routeRuntime.release(resolved.value);
});

it.each(['codex', 'claude'] as const)(
  'adds the setup-script hint only to an isolated %s delegate',
  async (harness) => {
    mockChildHarness = harness;
    if (harness === 'claude')
      mockResolveHelperInvocation.mockResolvedValue({
        providerType: 'claude',
        source: 'claude-managed',
        harness: 'claude',
        sdkModel: 'claude-test',
        aiCreditsRouted: false,
        envOverride: { ANTHROPIC_API_KEY: 'test-key' },
        dispose: mockDisposeInvocation,
      });
    mockResolveSetupHint.mockClear();
    const routeRuntime = runtime({
      cwd: '/tmp/delegation-route-runtime-test',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      selectedRepoId: 'api',
    });
    const instructionsFor = async (
      isolation: 'shared_worktree' | 'worktree',
    ): Promise<string> => {
      const scopedTask = { ...task, isolation };
      const resolved = await routeRuntime.resolve(
        parent,
        scopedTask,
        new AbortController().signal,
      );
      if (!resolved.ok) throw new Error('Expected route capture');
      const retained: Array<() => Promise<void>> = [];
      const context = prepareContext(
        resolved.value,
        new AbortController().signal,
        retained,
      );
      const scopedContext: LocalDelegationContext = {
        ...context,
        request: { ...context.request, task: scopedTask },
      };
      const prepared =
        harness === 'codex'
          ? await routeRuntime.prepareCodex(scopedContext)
          : await routeRuntime.prepareClaude(scopedContext);
      const instructions = prepared.tools.instructions();
      for (const close of retained.reverse()) await close();
      routeRuntime.release(resolved.value);
      return instructions;
    };
    try {
      expect(await instructionsFor('shared_worktree')).not.toContain(
        'ISOLATED_SETUP_HINT',
      );
      expect(mockResolveSetupHint).not.toHaveBeenCalled();
      expect(await instructionsFor('worktree')).toContain(
        'ISOLATED_SETUP_HINT',
      );
      expect(mockResolveSetupHint).toHaveBeenCalledWith({
        projectId: 'project',
        selectedRepoId: 'api',
        delegateCwd: '/tmp/delegation-route-runtime-test',
        harness,
      });
    } finally {
      mockResolveHelperInvocation.mockReset().mockResolvedValue({
        providerType: 'codex' as const,
        source: 'codex-managed' as const,
        harness: 'codex' as const,
        sdkModel: 'gpt-5.6-sol',
        aiCreditsRouted: false,
        dispose: mockDisposeInvocation,
      });
    }
  },
);

it.each(['codex', 'claude'] as const)(
  'prepares app-owned tools for a %s delegate and withholds parent script actions from isolated checkouts',
  async (harness) => {
    mockChildHarness = harness;
    if (harness === 'claude')
      mockResolveHelperInvocation.mockResolvedValue({
        providerType: 'claude',
        source: 'claude-managed',
        harness: 'claude',
        sdkModel: 'claude-test',
        aiCreditsRouted: false,
        envOverride: { ANTHROPIC_API_KEY: 'test-key' },
        dispose: mockDisposeInvocation,
      });
    const routeRuntime = runtime();
    const appToolKeys = async (
      isolation: 'shared_worktree' | 'worktree',
    ): Promise<string[]> => {
      const scopedTask = { ...task, isolation };
      const resolved = await routeRuntime.resolve(
        parent,
        scopedTask,
        new AbortController().signal,
      );
      if (!resolved.ok) throw new Error('Expected route capture');
      const retained: Array<() => Promise<void>> = [];
      const context = prepareContext(
        resolved.value,
        new AbortController().signal,
        retained,
      );
      const scopedContext: LocalDelegationContext = {
        ...context,
        request: { ...context.request, task: scopedTask },
      };
      const prepared =
        harness === 'codex'
          ? await routeRuntime.prepareCodex(scopedContext)
          : await routeRuntime.prepareClaude(scopedContext);
      if (harness === 'claude')
        expect(prepared).toHaveProperty('ambientPluginIds', expect.any(Array));
      const keys = prepared.appTools?.tools.map((tool) => tool.key) ?? [];
      for (const close of retained.reverse()) await close();
      routeRuntime.release(resolved.value);
      return keys;
    };
    try {
      const shared = await appToolKeys('shared_worktree');
      expect(shared).toEqual(
        expect.arrayContaining([
          'get_script_output',
          'search_memory',
          'save_memory',
        ]),
      );
      // Both harnesses run the parent worktree's scripts, approved per command.
      expect(shared).toEqual(
        expect.arrayContaining([
          'search_actions',
          'dispatch_action',
          'watch_command',
        ]),
      );
      const isolated = await appToolKeys('worktree');
      expect(isolated).toContain('search_memory');
      expect(isolated).not.toContain('dispatch_action');
      expect(isolated).not.toContain('search_actions');
    } finally {
      mockResolveHelperInvocation.mockReset().mockResolvedValue({
        providerType: 'codex' as const,
        source: 'codex-managed' as const,
        harness: 'codex' as const,
        sdkModel: 'gpt-5.6-sol',
        aiCreditsRouted: false,
        dispose: mockDisposeInvocation,
      });
    }
  },
);

// Phase 1 (docs/planning/2026-09-25-delegation-capabilities/02-capability-grant.md
// §"Where inheritance comes from"): a nested child inherits from its parent
// delegate's retained grant/overlay via capabilityContext, never from the
// root chat's own live selections.
it("inherits a nested child's capabilities from its parent delegate's grant/overlay, not the root chat", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'nested-capability-context-'),
  );
  const mockedLstat = jest.mocked(lstat);
  const priorLstat = mockedLstat.getMockImplementation();
  mockedLstat.mockImplementation(
    jest.requireActual<typeof FsPromises>('node:fs/promises').lstat,
  );
  try {
    const artifacts = new AgentArtifactStore(path.join(directory, 'artifacts'));
    const parentOverlay = await artifacts.retainCapabilityOverlay({
      pluginFiles: {},
      capabilities: {
        claudePluginRoots: [],
        claudeSkillNames: [],
        codexCapabilityRoots: [],
        mcpSelections: [],
        mcpHttpAuthPreferences: [],
        hookDeclarations: [],
      },
      provenance: { roots: {}, mcpSelections: [] },
      items: [
        {
          id: `deferred:v1:${'a'.repeat(43)}`,
          name: 'Delegate skill',
          source: 'inherited',
          ref: {
            kind: 'skill',
            sourceId: 'builtin',
            skillName: 'delegate-only',
          },
        },
      ],
    });
    const parentGrant: DelegationCapabilityGrant = {
      inherit: true,
      explicit: [],
      discovery: false,
      loaded: [],
      skipped: [],
      overlayHash: parentOverlay.capabilityProjectionHash,
      summary: {
        inherit: true,
        discovery: false,
        items: [{ kind: 'skill', name: 'Delegate skill', source: 'inherited' }],
        skipped: [],
      },
    };
    // The root chat's own live selections must never reach this nested child.
    const nestedOwner: AgentSessionOptions = {
      cwd: '/tmp/delegation-route-runtime-test',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [{ sourceId: 'builtin', skillName: 'root-only-skill' }],
        pluginRefs: [],
      },
    };
    const routeRuntime = new DelegationRouteRuntime({
      directory,
      owner: (): AgentSessionOptions => nestedOwner,
      getWindow: (): null => null,
      authGeneration: (): number => 1,
      capabilityContext: (
        delegationId: string,
      ): DelegationCapabilityContext | undefined =>
        delegationId === 'parent-delegate'
          ? {
              delegationId,
              runGeneration: 1,
              grant: parentGrant,
              route: {
                ...route,
                routeId: 'parent-route',
                capabilityOverlay: parentOverlay,
              },
            }
          : undefined,
    });

    mockMaterializeDelegationCapabilities.mockClear();
    const resolved = await routeRuntime.resolve(
      { ...parent, depth: 1, parentDelegationId: 'parent-delegate' },
      task,
      new AbortController().signal,
    );

    expect(resolved.ok).toBe(true);
    expect(mockMaterializeDelegationCapabilities).toHaveBeenCalledWith(
      [
        {
          source: 'inherited',
          selections: {
            collectionIds: [],
            skillRefs: [{ sourceId: 'builtin', skillName: 'delegate-only' }],
            pluginRefs: [],
            mcpServerRefs: [],
          },
        },
      ],
      expect.any(Function),
      'codex',
      expect.any(Object),
    );
    if (resolved.ok) routeRuntime.release(resolved.value);
  } finally {
    if (priorLstat) mockedLstat.mockImplementation(priorLstat);
    await rm(directory, { recursive: true, force: true });
  }
});

// Slice R (docs/planning/2026-09-25-delegation-capabilities): Phase 3 delegate
// MCP parity and Phase 4 child capability discovery with in-run reload.

function buildReloadGrant(discovery: boolean): DelegationCapabilityGrant {
  return {
    inherit: true,
    explicit: [],
    discovery,
    loaded: [],
    skipped: [],
    overlayHash: '0'.repeat(64),
    summary: { inherit: true, discovery, items: [], skipped: [] },
  };
}

/**
 * A resolved route may carry a one-shot `capabilityGrant` (recordable spawn
 * discovery/explicit/inherited state). "The broker moves the grant onto the
 * new record; routes never retain it" (route-runtime.ts) — a real caller
 * persists it separately and never feeds it back into `context.request.route`
 * for launch/prepare. `capabilityGrant: undefined` drops the key entirely
 * because `JSON.stringify` omits `undefined` values, matching the captured
 * route's own fingerprint.
 */
function launchRoute(
  route: ResolvedAgentRouteSnapshot,
): ResolvedAgentRouteSnapshot {
  return { ...route, capabilityGrant: undefined };
}

const RELOAD_INITIAL_ITEM_ID = `deferred:v1:${'a'.repeat(43)}`;
const RELOAD_LOADED_ITEM_ID = `deferred:v1:${'b'.repeat(43)}`;

/** A retained overlay with one already-granted MCP server, so a reload has a
 * previous MCP session to revoke. */
function buildInitialReloadOverlay(): MaterializedCapabilityOverlay {
  return {
    version: 3,
    pluginFiles: {},
    capabilities: {
      claudePluginRoots: [],
      claudeSkillNames: [],
      codexCapabilityRoots: [],
      mcpSelections: [
        {
          source: 'standalone',
          serverId: 'review-server',
          configId: 'default',
          configDigest: 'a'.repeat(64),
        },
      ],
      mcpHttpAuthPreferences: [],
      hookDeclarations: [],
    },
    provenance: { roots: {}, mcpSelections: ['agent'] },
    items: [
      {
        id: RELOAD_INITIAL_ITEM_ID,
        name: 'Review server',
        source: 'agent',
        ref: { kind: 'mcp', serverId: 'review-server', configId: 'default' },
      },
    ],
  };
}

/** The mocked `materializeDelegationCapabilities` result for a reload that
 * keeps the retained MCP server and adds one skill root. */
function buildLoadedReloadMaterialization(
  harness: 'claude' | 'codex',
): MaterializedDelegationCapabilities {
  return {
    files: { 'skills/loaded-review/SKILL.md': 'LOADED_SKILL_CONTENT' },
    toolNames: ['read', 'search'],
    capabilities: {
      claudePluginRoots: harness === 'claude' ? ['skills/loaded-review'] : [],
      claudeSkillNames: harness === 'claude' ? ['loaded-review:reviewer'] : [],
      codexCapabilityRoots: harness === 'codex' ? ['skills/loaded-review'] : [],
      mcpSelections: [
        {
          source: 'standalone',
          serverId: 'review-server',
          configId: 'default',
          configDigest: 'a'.repeat(64),
        },
      ],
      mcpHttpAuthPreferences: [],
      hookDeclarations: [],
    },
    provenance: {
      roots: { 'skills/loaded-review': 'loaded' },
      mcpSelections: ['agent'],
    },
    included: [
      {
        id: RELOAD_INITIAL_ITEM_ID,
        kind: 'mcp',
        name: 'Review server',
        source: 'agent',
        ref: { kind: 'mcp', serverId: 'review-server', configId: 'default' },
      },
      {
        id: RELOAD_LOADED_ITEM_ID,
        kind: 'skill',
        name: 'Loaded review',
        source: 'loaded',
        ref: { kind: 'skill', sourceId: 'builtin', skillName: 'loaded-review' },
      },
    ],
    skipped: [],
    layerWarnings: [],
  };
}

const RELOAD_SKIPPED_ITEM_ID = `deferred:v1:${'c'.repeat(43)}`;

/** A reload that enables one requested item and skips another. */
function buildMixedReloadMaterialization(): MaterializedDelegationCapabilities {
  const loaded = buildLoadedReloadMaterialization('codex');
  return {
    ...loaded,
    skipped: [
      {
        id: RELOAD_SKIPPED_ITEM_ID,
        kind: 'skill',
        name: 'Unavailable skill',
        source: 'loaded',
        ref: { kind: 'skill', sourceId: 'builtin', skillName: 'missing' },
        reason: 'missing_selection',
      },
    ],
  };
}

/** A reload materialization whose only requested item is skipped, so the
 * host never has anything new to commit. */
function buildSkippedReloadMaterialization(): MaterializedDelegationCapabilities {
  return {
    files: {},
    toolNames: ['read', 'search'],
    capabilities: {
      claudePluginRoots: [],
      claudeSkillNames: [],
      codexCapabilityRoots: [],
      mcpSelections: [],
      mcpHttpAuthPreferences: [],
      hookDeclarations: [],
    },
    provenance: { roots: {}, mcpSelections: [] },
    included: [],
    skipped: [
      {
        id: RELOAD_LOADED_ITEM_ID,
        kind: 'skill',
        name: 'Unavailable skill',
        source: 'loaded',
        ref: { kind: 'skill', sourceId: 'builtin', skillName: 'missing' },
        reason: 'missing_selection',
      },
    ],
    layerWarnings: [],
  };
}

it('never asks the child provider to prompt for MCP server launch or a proxy operation timeout', async () => {
  const routeRuntime = runtime();
  const resolved = await routeRuntime.resolve(
    parent,
    task,
    new AbortController().signal,
  );
  if (!resolved.ok) throw new Error('Expected route capture');
  withSelectedMcp(routeRuntime, resolved.value);
  const retained: Array<() => Promise<void>> = [];
  await routeRuntime.prepareCodex(
    prepareContext(resolved.value, new AbortController().signal, retained),
  );
  expect(mockResolveDelegatedMcpCapabilities).toHaveBeenCalledTimes(1);
  const [, options] = mockResolveDelegatedMcpCapabilities.mock.calls[0];
  expect(options).not.toHaveProperty('authorizeServerLaunch');
  expect(options).not.toHaveProperty('proxyOperationTimeoutMs');
  for (const close of retained.reverse()) await close();
  routeRuntime.release(resolved.value);
});

it('guides the child and records a content-free diagnostic when a resolved MCP server is unavailable', async () => {
  const routeRuntime = runtime();
  const resolved = await routeRuntime.resolve(
    parent,
    task,
    new AbortController().signal,
  );
  if (!resolved.ok) throw new Error('Expected route capture');
  withSelectedMcp(routeRuntime, resolved.value);
  mockResolveDelegatedMcpCapabilities.mockResolvedValueOnce({
    mcpServers: {},
    codexMcpServers: {},
    serverNameByProxyUrl: {},
    providerGatedServers: [],
    unavailable: [{ name: 'Linear', reason: 'sign_in_required' }],
  });
  const retained: Array<() => Promise<void>> = [];
  const prepared = await routeRuntime.prepareCodex(
    prepareContext(resolved.value, new AbortController().signal, retained),
  );
  expect(prepared.tools.instructions()).toContain(
    'UNAVAILABLE_MCP:Linear=sign_in_required',
  );
  expect(mockRecordSessionDiagnostic).toHaveBeenCalledTimes(1);
  const [diagnostic] = mockRecordSessionDiagnostic.mock.calls[0];
  expect(typeof diagnostic.timestamp).toBe('string');
  // Strict equality (not objectContaining) so an accidentally added server
  // name would fail this test, not just pass silently alongside it.
  expect(diagnostic).toEqual({
    version: 1,
    timestamp: diagnostic.timestamp,
    kind: 'managed_delegation',
    sessionKey: 'project/worktree/chat',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    providerType: 'codex',
    lastEventType: 'delegated_mcp_unavailable:sign_in_required',
  });
  for (const close of retained.reverse()) await close();
  routeRuntime.release(resolved.value);
});

// Case G: an inherited MCP server that passes materialization but fails
// per-run preparation is dropped at launch, not silently — the run still
// prepares and both the instructions and a diagnostic name the drop.
it('drops an inherited MCP server whose per-run preparation fails, while the rest of the run still prepares', async () => {
  const routeRuntime = runtime();
  const resolved = await routeRuntime.resolve(
    parent,
    task,
    new AbortController().signal,
  );
  if (!resolved.ok || !resolved.value.routeId)
    throw new Error('Expected route capture');
  const overlay: MaterializedCapabilityOverlay = {
    version: 3,
    pluginFiles: {},
    capabilities: {
      claudePluginRoots: [],
      claudeSkillNames: [],
      codexCapabilityRoots: [],
      mcpSelections: [
        {
          source: 'standalone',
          serverId: 'inherited-server',
          configId: 'default',
          configDigest: 'pinned',
        },
      ],
      mcpHttpAuthPreferences: [],
      hookDeclarations: [],
    },
    provenance: { roots: {}, mcpSelections: ['inherited'] },
    items: [],
  };
  const captured = capturedRoutes(routeRuntime);
  captured.set(resolved.value.routeId, {
    ...captured.get(resolved.value.routeId),
    capabilities: overlay,
  });
  mockResolveDelegatedMcpCapabilities
    .mockResolvedValueOnce({
      mcpServers: {},
      codexMcpServers: {},
      serverNameByProxyUrl: {},
      providerGatedServers: [],
      unavailable: [],
    })
    .mockRejectedValueOnce(
      new DelegationAgentCapabilityError('config_changed'),
    );
  const retained: Array<() => Promise<void>> = [];
  const prepared = await routeRuntime.prepareCodex(
    prepareContext(resolved.value, new AbortController().signal, retained),
  );
  expect(mockResolveDelegatedMcpCapabilities).toHaveBeenCalledTimes(2);
  expect(prepared.selectedMcpServers ?? {}).toEqual({});
  expect(prepared.tools.instructions()).toContain('=unavailable');
  expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'managed_delegation',
      lastEventType: 'delegated_mcp_unavailable:unavailable',
    }),
  );
  for (const close of retained.reverse()) await close();
  routeRuntime.release(resolved.value);
});

// A plugin resolves as a whole: the resolver returns every server the plugin
// declares and rejects any it was not given, so a plugin's inherited servers
// must resolve together.
it('resolves inherited servers from one plugin together, so a multi-server plugin keeps them all', async () => {
  const routeRuntime = runtime();
  const resolved = await routeRuntime.resolve(
    parent,
    task,
    new AbortController().signal,
  );
  if (!resolved.ok || !resolved.value.routeId)
    throw new Error('Expected route capture');
  const pluginServer = (
    serverName: string,
  ): AgentCapabilitySnapshot['mcpSelections'][number] => ({
    source: 'plugin',
    marketplaceId: 'market',
    pluginName: 'multi',
    serverName,
    root: 'plugins/multi',
    configDigest: 'pinned',
  });
  const overlay: MaterializedCapabilityOverlay = {
    version: 3,
    pluginFiles: {},
    capabilities: {
      claudePluginRoots: [],
      claudeSkillNames: [],
      codexCapabilityRoots: [],
      mcpSelections: [
        pluginServer('alpha'),
        {
          source: 'standalone',
          serverId: 'solo',
          configId: 'default',
          configDigest: 'pinned',
        },
        pluginServer('beta'),
      ],
      mcpHttpAuthPreferences: [],
      hookDeclarations: [],
    },
    provenance: {
      roots: {},
      mcpSelections: ['inherited', 'inherited', 'inherited'],
    },
    items: [],
  };
  const captured = capturedRoutes(routeRuntime);
  captured.set(resolved.value.routeId, {
    ...captured.get(resolved.value.routeId),
    capabilities: overlay,
  });
  const empty = {
    mcpServers: {},
    codexMcpServers: {},
    serverNameByProxyUrl: {},
    providerGatedServers: [],
    unavailable: [],
  };
  mockResolveDelegatedMcpCapabilities.mockImplementation((capabilities) => {
    const names = capabilities.mcpSelections.map((selection) =>
      selection.source === 'plugin' || selection.source === 'inherited-plugin'
        ? selection.serverName
        : selection.serverId,
    );
    const pluginNames = capabilities.mcpSelections.flatMap((selection) =>
      selection.source === 'plugin' ? [selection.serverName] : [],
    );
    if (
      pluginNames.length > 0 &&
      !['alpha', 'beta'].every((name) => pluginNames.includes(name))
    )
      return Promise.reject(
        new DelegationAgentCapabilityError('invalid_projection'),
      );
    return Promise.resolve({
      ...empty,
      codexMcpServers: Object.fromEntries(
        names.map((name) => [
          name,
          { url: `http://127.0.0.1:1/${name}`, required: false },
        ]),
      ),
    });
  });
  const retained: Array<() => Promise<void>> = [];
  try {
    const prepared = await routeRuntime.prepareCodex(
      prepareContext(resolved.value, new AbortController().signal, retained),
    );
    expect(Object.keys(prepared.selectedMcpServers ?? {}).sort()).toEqual([
      'alpha',
      'beta',
      'solo',
    ]);
    expect(prepared.tools.instructions()).not.toContain('=unavailable');
  } finally {
    mockResolveDelegatedMcpCapabilities.mockImplementation(() =>
      Promise.resolve(empty),
    );
    for (const close of retained.reverse()) await close();
    routeRuntime.release(resolved.value);
  }
});

interface DiscoveryCase {
  readonly label: string;
  readonly callerDepth: number;
  readonly rootDeferredToolsAllowed: boolean | undefined;
  readonly parentGrantDiscovery: boolean | undefined;
  readonly requested: boolean | undefined;
  readonly expected: boolean;
}

const DISCOVERY_CASES: readonly DiscoveryCase[] = [
  {
    label: 'root allows, parameter omitted',
    callerDepth: 0,
    rootDeferredToolsAllowed: true,
    parentGrantDiscovery: undefined,
    requested: undefined,
    expected: true,
  },
  {
    label: 'root allows, parameter true',
    callerDepth: 0,
    rootDeferredToolsAllowed: true,
    parentGrantDiscovery: undefined,
    requested: true,
    expected: true,
  },
  {
    label: 'root allows, parameter false',
    callerDepth: 0,
    rootDeferredToolsAllowed: true,
    parentGrantDiscovery: undefined,
    requested: false,
    expected: false,
  },
  {
    label: 'root disallows, parameter omitted',
    callerDepth: 0,
    rootDeferredToolsAllowed: false,
    parentGrantDiscovery: undefined,
    requested: undefined,
    expected: false,
  },
  {
    label: 'root disallows, parameter true never overrides the root',
    callerDepth: 0,
    rootDeferredToolsAllowed: false,
    parentGrantDiscovery: undefined,
    requested: true,
    expected: false,
  },
  {
    label: 'root setting undefined, parameter true',
    callerDepth: 0,
    rootDeferredToolsAllowed: undefined,
    parentGrantDiscovery: undefined,
    requested: true,
    expected: false,
  },
  {
    label: 'nested, parent allows, parameter omitted',
    callerDepth: 1,
    rootDeferredToolsAllowed: true,
    parentGrantDiscovery: true,
    requested: undefined,
    expected: true,
  },
  {
    label: 'nested, parent allows, parameter false',
    callerDepth: 1,
    rootDeferredToolsAllowed: true,
    parentGrantDiscovery: true,
    requested: false,
    expected: false,
  },
  {
    label: 'nested, parent disallows, parameter true never exceeds the parent',
    callerDepth: 1,
    rootDeferredToolsAllowed: true,
    parentGrantDiscovery: false,
    requested: true,
    expected: false,
  },
  {
    label: 'nested, no parent grant, parameter true',
    callerDepth: 1,
    rootDeferredToolsAllowed: true,
    parentGrantDiscovery: undefined,
    requested: true,
    expected: false,
  },
  {
    label:
      'nested, root disallows but parent allows: the direct parent is the ceiling',
    callerDepth: 1,
    rootDeferredToolsAllowed: false,
    parentGrantDiscovery: true,
    requested: undefined,
    expected: true,
  },
];

it.each(DISCOVERY_CASES)(
  'resolves spawn-time capability discovery ($label)',
  ({
    callerDepth,
    rootDeferredToolsAllowed,
    parentGrantDiscovery,
    requested,
    expected,
  }) => {
    expect(
      resolveDelegationCapabilityDiscovery({
        callerDepth,
        rootDeferredToolsAllowed,
        parentGrant:
          parentGrantDiscovery === undefined
            ? undefined
            : { discovery: parentGrantDiscovery },
        requested,
      }),
    ).toBe(expected);
  },
);

it("records a grant when a configured Agent's own selections are the child's only capabilities", async () => {
  const caller: DelegationCallerCapabilities = {
    depth: 0,
    selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    effectiveKeys: new Set(),
    mayDiscover: false,
    rootDeferredToolsAllowed: false,
  };
  const agentItem = {
    id: RELOAD_INITIAL_ITEM_ID,
    kind: 'skill' as const,
    name: 'review',
    source: 'agent' as const,
    ref: {
      kind: 'skill' as const,
      sourceId: 'agent-source',
      skillName: 'review',
    },
  };
  const materialized: MaterializedDelegationCapabilities = {
    files: {},
    toolNames: [],
    capabilities: {
      claudePluginRoots: [],
      claudeSkillNames: [],
      codexCapabilityRoots: [],
      mcpSelections: [],
      mcpHttpAuthPreferences: [],
      hookDeclarations: [],
    },
    provenance: { roots: {}, mcpSelections: [] },
    included: [agentItem],
    skipped: [],
    layerWarnings: [],
  };
  const prepared = await prepareDelegationCapabilities({
    task,
    caller,
    agentSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    harness: 'claude',
    materialize: () => Promise.resolve(materialized),
    loadCatalog: () => Promise.reject(new Error('No catalog lookup expected')),
  });
  // Without it the card has no Capabilities row for the Agent's selections.
  expect(prepared.grant(undefined)?.summary.items).toEqual([
    expect.objectContaining({ kind: 'skill', name: 'review', source: 'agent' }),
  ]);
});

it('forwards the caller capability shape into the spawn-time discovery gate', () => {
  const rootCaller: DelegationCallerCapabilities = {
    depth: 0,
    selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    effectiveKeys: new Set(),
    mayDiscover: true,
    rootDeferredToolsAllowed: true,
  };
  expect(
    childCapabilityDiscovery(rootCaller, {
      allowCapabilityDiscovery: undefined,
    }),
  ).toBe(true);
  expect(
    childCapabilityDiscovery(rootCaller, { allowCapabilityDiscovery: false }),
  ).toBe(false);

  const nestedCaller: DelegationCallerCapabilities = {
    depth: 1,
    selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    effectiveKeys: new Set(),
    mayDiscover: false,
    rootDeferredToolsAllowed: true,
    parentGrant: buildReloadGrant(false),
  };
  expect(
    childCapabilityDiscovery(nestedCaller, { allowCapabilityDiscovery: true }),
  ).toBe(false);
});

interface DeferredToolsGateCase {
  readonly rootAllowed: boolean;
  readonly grantDiscovery: boolean;
  readonly expectPresent: boolean;
}

const DEFERRED_TOOLS_GATE_CASES: readonly DeferredToolsGateCase[] = [
  { rootAllowed: true, grantDiscovery: true, expectPresent: true },
  { rootAllowed: true, grantDiscovery: false, expectPresent: false },
  { rootAllowed: false, grantDiscovery: true, expectPresent: false },
  { rootAllowed: false, grantDiscovery: false, expectPresent: false },
];

it.each(DEFERRED_TOOLS_GATE_CASES)(
  'includes deferred-tools discovery only when the root chat allows it ($rootAllowed) and the grant permits discovery ($grantDiscovery)',
  async ({ rootAllowed, grantDiscovery, expectPresent }) => {
    const owner: AgentSessionOptions = {
      cwd: '/tmp/delegation-route-runtime-test',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      deferredToolsAllowed: rootAllowed,
    };
    const grant = buildReloadGrant(grantDiscovery);
    const routeRuntime = new DelegationRouteRuntime({
      directory: '/tmp/delegation-route-runtime-test',
      owner: (): AgentSessionOptions => owner,
      getWindow: (): null => null,
      authGeneration: (): number => 1,
      capabilityContext: (id): DelegationCapabilityContext | undefined =>
        id === 'delegation'
          ? { delegationId: 'delegation', runGeneration: 1, grant }
          : undefined,
      extendCapabilityGrant: jest.fn(),
    });
    const resolved = await routeRuntime.resolve(
      parent,
      task,
      new AbortController().signal,
    );
    if (!resolved.ok) throw new Error('Expected route capture');
    const retained: Array<() => Promise<void>> = [];
    const prepared = await routeRuntime.prepareCodex(
      prepareContext(
        launchRoute(resolved.value),
        new AbortController().signal,
        retained,
      ),
    );
    const keys = prepared.appTools?.tools.map((tool) => tool.key) ?? [];
    if (expectPresent) {
      expect(keys).toEqual(
        expect.arrayContaining([
          'search_deferred_tools',
          'load_deferred_tools',
        ]),
      );
    } else {
      expect(keys).not.toEqual(
        expect.arrayContaining(['search_deferred_tools']),
      );
      expect(keys).not.toEqual(expect.arrayContaining(['load_deferred_tools']));
    }
    for (const close of retained.reverse()) await close();
    routeRuntime.release(resolved.value);
  },
);

it('omits deferred-tools discovery entirely when the reload grant extension is not wired', async () => {
  const owner: AgentSessionOptions = {
    cwd: '/tmp/delegation-route-runtime-test',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    deferredToolsAllowed: true,
  };
  const routeRuntime = runtime(owner);
  const resolved = await routeRuntime.resolve(
    parent,
    task,
    new AbortController().signal,
  );
  if (!resolved.ok) throw new Error('Expected route capture');
  const retained: Array<() => Promise<void>> = [];
  const prepared = await routeRuntime.prepareCodex(
    prepareContext(
      launchRoute(resolved.value),
      new AbortController().signal,
      retained,
    ),
  );
  const keys = prepared.appTools?.tools.map((tool) => tool.key) ?? [];
  expect(keys).not.toEqual(expect.arrayContaining(['search_deferred_tools']));
  expect(keys).not.toEqual(expect.arrayContaining(['load_deferred_tools']));
  expect(prepared.capabilityReload).toBeUndefined();
  for (const close of retained.reverse()) await close();
  routeRuntime.release(resolved.value);
});

it('omits deferred-tools discovery entirely when the delegation has no capability grant', async () => {
  const owner: AgentSessionOptions = {
    cwd: '/tmp/delegation-route-runtime-test',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    deferredToolsAllowed: true,
  };
  const routeRuntime = new DelegationRouteRuntime({
    directory: '/tmp/delegation-route-runtime-test',
    owner: (): AgentSessionOptions => owner,
    getWindow: (): null => null,
    authGeneration: (): number => 1,
    capabilityContext: (): DelegationCapabilityContext | undefined => undefined,
    extendCapabilityGrant: jest.fn(),
  });
  const resolved = await routeRuntime.resolve(
    parent,
    task,
    new AbortController().signal,
  );
  if (!resolved.ok) throw new Error('Expected route capture');
  const retained: Array<() => Promise<void>> = [];
  const prepared = await routeRuntime.prepareCodex(
    prepareContext(
      launchRoute(resolved.value),
      new AbortController().signal,
      retained,
    ),
  );
  const keys = prepared.appTools?.tools.map((tool) => tool.key) ?? [];
  expect(keys).not.toEqual(expect.arrayContaining(['search_deferred_tools']));
  expect(keys).not.toEqual(expect.arrayContaining(['load_deferred_tools']));
  expect(prepared.capabilityReload).toBeUndefined();
  for (const close of retained.reverse()) await close();
  routeRuntime.release(resolved.value);
});

it('refuses a live Load Deferred Tools call once the root chat turns off discovery, and a fresh preparation omits both tools', async () => {
  const owner: AgentSessionOptions = {
    cwd: '/tmp/delegation-route-runtime-test',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    deferredToolsAllowed: true,
  };
  const grant = buildReloadGrant(true);
  const routeRuntime = new DelegationRouteRuntime({
    directory: '/tmp/delegation-route-runtime-test',
    owner: (): AgentSessionOptions => owner,
    getWindow: (): null => null,
    authGeneration: (): number => 1,
    capabilityContext: (id): DelegationCapabilityContext | undefined =>
      id === 'delegation'
        ? { delegationId: 'delegation', runGeneration: 1, grant }
        : undefined,
    extendCapabilityGrant: jest.fn(),
  });
  const resolved = await routeRuntime.resolve(
    parent,
    task,
    new AbortController().signal,
  );
  if (!resolved.ok) throw new Error('Expected route capture');
  const retained: Array<() => Promise<void>> = [];
  const prepared = await routeRuntime.prepareCodex(
    prepareContext(
      launchRoute(resolved.value),
      new AbortController().signal,
      retained,
    ),
  );
  const loadTool = prepared.appTools?.tools.find(
    (tool) => tool.key === 'load_deferred_tools',
  );
  if (!loadTool)
    throw new Error(
      'Expected Load Deferred Tools to be available at prepare time',
    );
  owner.deferredToolsAllowed = false;
  const result = await prepared.appTools?.execute(
    loadTool,
    { items: [{ ref: 'x' }] },
    { callId: 'c' },
  );
  expect(result?.isError).toBe(true);
  expect(result?.text).toContain('not available');
  for (const close of retained.reverse()) await close();

  const secondRetained: Array<() => Promise<void>> = [];
  const secondPrepared = await routeRuntime.prepareCodex(
    prepareContext(
      launchRoute(resolved.value),
      new AbortController().signal,
      secondRetained,
    ),
  );
  const keys = secondPrepared.appTools?.tools.map((tool) => tool.key) ?? [];
  expect(keys).not.toEqual(expect.arrayContaining(['search_deferred_tools']));
  expect(keys).not.toEqual(expect.arrayContaining(['load_deferred_tools']));
  for (const close of secondRetained.reverse()) await close();
  routeRuntime.release(resolved.value);
});

it('reloads a Codex delegate mid-run, revoking the previous MCP session before the new one registers', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'delegation-reload-codex-'),
  );
  // The reload commits a real capability overlay artifact; restore the real
  // lstat so AgentArtifactStore's write/read-back verification is genuine.
  const mockedLstat = jest.mocked(lstat);
  const priorLstat = mockedLstat.getMockImplementation();
  mockedLstat.mockImplementation(
    jest.requireActual<typeof FsPromises>('node:fs/promises').lstat,
  );
  try {
    const grant = buildReloadGrant(true);
    const routeHolder: { current?: ResolvedAgentRouteSnapshot } = {};
    let lastExtensionResult: DelegationCapabilityExtensionResult | undefined;
    const mockExtendCapabilityGrant = jest.fn(
      (
        request: DelegationCapabilityExtensionRequest,
      ): Promise<DelegationCapabilityExtensionResult> => {
        if (!routeHolder.current)
          throw new Error('Expected a captured route before extending');
        const result: DelegationCapabilityExtensionResult = {
          ok: true,
          grant,
          route: {
            ...routeHolder.current,
            capabilityOverlay: request.capabilityOverlay,
          },
          extensions: 1,
        };
        lastExtensionResult = result;
        return Promise.resolve(result);
      },
    );
    const routeRuntime = new DelegationRouteRuntime({
      directory,
      owner: (): AgentSessionOptions => ({
        cwd: '/tmp/delegation-route-runtime-test',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      }),
      getWindow: (): null => null,
      authGeneration: (): number => 1,
      capabilityContext: (id): DelegationCapabilityContext | undefined =>
        id === 'delegation'
          ? { delegationId: 'delegation', runGeneration: 1, grant }
          : undefined,
      extendCapabilityGrant: mockExtendCapabilityGrant,
    });
    const resolved = await routeRuntime.resolve(
      parent,
      task,
      new AbortController().signal,
    );
    if (!resolved.ok || !resolved.value.routeId)
      throw new Error('Expected route capture');
    routeHolder.current = resolved.value;
    const captured = capturedRoutes(routeRuntime);
    captured.set(resolved.value.routeId, {
      ...captured.get(resolved.value.routeId),
      capabilities: buildInitialReloadOverlay(),
    });
    const retained: Array<() => Promise<void>> = [];
    const prepared = await routeRuntime.prepareCodex(
      prepareContext(resolved.value, new AbortController().signal, retained),
    );
    if (!prepared.capabilityReload)
      throw new Error('Expected a capability reload host');
    const baseSessionId = 'project/worktree/chat:delegated:delegation:1';
    expect(mockSetSessionToolCallGate).toHaveBeenCalledWith(
      baseSessionId,
      expect.any(Function),
    );
    const setGateCallsBeforeReload =
      mockSetSessionToolCallGate.mock.calls.length;
    const controller = prepared.capabilityReload.controller;
    const admission = controller.request({
      toolCallId: 'load-1',
      refs: [RELOAD_LOADED_ITEM_ID],
      additions: {
        skillRefs: [{ sourceId: 'builtin', skillName: 'loaded-review' }],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      enabledResources: [
        { ref: RELOAD_LOADED_ITEM_ID, kind: 'skill', name: 'Loaded review' },
      ],
    });
    if (!admission.accepted)
      throw new Error('Expected the reload admission to be accepted');
    controller.markDelivered();
    mockMaterializeDelegationCapabilities.mockResolvedValueOnce(
      buildLoadedReloadMaterialization('codex'),
    );
    const signal = new AbortController().signal;
    const result = await controller.perform(
      prepared.capabilityReload.host,
      signal,
    );

    expect(mockMaterializeDelegationCapabilities).toHaveBeenCalledTimes(1);
    expect(mockMaterializeDelegationCapabilities).toHaveBeenCalledWith(
      [
        {
          source: 'agent',
          selections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [{ serverId: 'review-server', configId: 'default' }],
          },
        },
        {
          source: 'loaded',
          selections: {
            collectionIds: [],
            skillRefs: [{ sourceId: 'builtin', skillName: 'loaded-review' }],
            pluginRefs: [],
            mcpServerRefs: [],
          },
        },
      ],
      expect.any(Function),
      'codex',
      expect.any(Object),
    );

    expect(mockExtendCapabilityGrant).toHaveBeenCalledTimes(1);
    const [extendRequest] = mockExtendCapabilityGrant.mock.calls[0];
    expect(extendRequest.delegationId).toBe('delegation');
    expect(extendRequest.runGeneration).toBe(1);
    expect(extendRequest.loaded).toEqual([RELOAD_LOADED_ITEM_ID]);
    expect(extendRequest.overlayHash).toBe(
      extendRequest.capabilityOverlay?.capabilityProjectionHash,
    );
    expect(extendRequest.summary).toEqual(
      summarizeDelegationCapabilities({
        inherit: grant.inherit,
        discovery: grant.discovery,
        items: [
          { kind: 'mcp', name: 'Review server', source: 'agent' },
          { kind: 'skill', name: 'Loaded review', source: 'loaded' },
        ],
        skipped: grant.summary.skipped,
      }),
    );

    if (result.status !== 'loaded')
      throw new Error('Expected the reload to succeed');
    expect(result.prepared.selectedCapabilityRoots).toEqual([
      {
        id: 'published-root',
        location: {
          type: 'environment',
          environmentId: 'local',
          path: PUBLISHED_ROOT_URL,
        },
      },
    ]);

    expect(mockUnregisterRoutesForSession).toHaveBeenCalledWith(baseSessionId);
    expect(mockRevokeStdioMcpRoutes).toHaveBeenCalledWith(baseSessionId);
    expect(mockSetSessionToolCallGate).toHaveBeenCalledTimes(
      setGateCallsBeforeReload + 1,
    );
    const [reloadSessionId] =
      mockSetSessionToolCallGate.mock.calls[setGateCallsBeforeReload];
    expect(reloadSessionId).toBe(`${baseSessionId}:reload-1`);
    const unregisterOrder =
      mockUnregisterRoutesForSession.mock.invocationCallOrder[
        mockUnregisterRoutesForSession.mock.invocationCallOrder.length - 1
      ];
    const revokeOrder =
      mockRevokeStdioMcpRoutes.mock.invocationCallOrder[
        mockRevokeStdioMcpRoutes.mock.invocationCallOrder.length - 1
      ];
    const newGateOrder =
      mockSetSessionToolCallGate.mock.invocationCallOrder[
        setGateCallsBeforeReload
      ];
    expect(unregisterOrder).toBeLessThan(newGateOrder);
    expect(revokeOrder).toBeLessThan(newGateOrder);

    if (!lastExtensionResult || !lastExtensionResult.ok)
      throw new Error('Expected a successful extension result');
    await expect(
      routeRuntime.available(lastExtensionResult.route),
    ).resolves.toEqual({ available: true });

    for (const close of retained.reverse()) await close();
    routeRuntime.release(resolved.value);
  } finally {
    if (priorLstat) mockedLstat.mockImplementation(priorLstat);
    await rm(directory, { recursive: true, force: true });
  }
});

it('reports a requested item a reload skipped instead of claiming it is enabled', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'delegation-reload-mixed-'),
  );
  const mockedLstat = jest.mocked(lstat);
  const priorLstat = mockedLstat.getMockImplementation();
  mockedLstat.mockImplementation(
    jest.requireActual<typeof FsPromises>('node:fs/promises').lstat,
  );
  try {
    const grant = buildReloadGrant(true);
    const routeHolder: { current?: ResolvedAgentRouteSnapshot } = {};
    const mockExtendCapabilityGrant = jest.fn(
      (
        request: DelegationCapabilityExtensionRequest,
      ): Promise<DelegationCapabilityExtensionResult> => {
        if (!routeHolder.current)
          throw new Error('Expected a captured route before extending');
        return Promise.resolve({
          ok: true,
          grant,
          route: {
            ...routeHolder.current,
            capabilityOverlay: request.capabilityOverlay,
          },
          extensions: 1,
        });
      },
    );
    const routeRuntime = new DelegationRouteRuntime({
      directory,
      owner: (): AgentSessionOptions => ({
        cwd: '/tmp/delegation-route-runtime-test',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      }),
      getWindow: (): null => null,
      authGeneration: (): number => 1,
      capabilityContext: (id): DelegationCapabilityContext | undefined =>
        id === 'delegation'
          ? { delegationId: 'delegation', runGeneration: 1, grant }
          : undefined,
      extendCapabilityGrant: mockExtendCapabilityGrant,
    });
    const resolved = await routeRuntime.resolve(
      parent,
      task,
      new AbortController().signal,
    );
    if (!resolved.ok || !resolved.value.routeId)
      throw new Error('Expected route capture');
    routeHolder.current = resolved.value;
    const captured = capturedRoutes(routeRuntime);
    captured.set(resolved.value.routeId, {
      ...captured.get(resolved.value.routeId),
      capabilities: buildInitialReloadOverlay(),
    });
    const retained: Array<() => Promise<void>> = [];
    const prepared = await routeRuntime.prepareCodex(
      prepareContext(resolved.value, new AbortController().signal, retained),
    );
    if (!prepared.capabilityReload)
      throw new Error('Expected a capability reload host');
    const controller = prepared.capabilityReload.controller;
    const admission = controller.request({
      toolCallId: 'load-1',
      refs: [RELOAD_LOADED_ITEM_ID, RELOAD_SKIPPED_ITEM_ID],
      additions: {
        skillRefs: [
          { sourceId: 'builtin', skillName: 'loaded-review' },
          { sourceId: 'builtin', skillName: 'missing' },
        ],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      enabledResources: [
        { ref: RELOAD_LOADED_ITEM_ID, kind: 'skill', name: 'Loaded review' },
        {
          ref: RELOAD_SKIPPED_ITEM_ID,
          kind: 'skill',
          name: 'Unavailable skill',
        },
      ],
    });
    if (!admission.accepted)
      throw new Error('Expected the reload admission to be accepted');
    controller.markDelivered();
    mockMaterializeDelegationCapabilities.mockResolvedValueOnce(
      buildMixedReloadMaterialization(),
    );
    const result = await controller.perform(
      prepared.capabilityReload.host,
      new AbortController().signal,
    );

    if (result.status !== 'loaded')
      throw new Error('Expected the enabled item to load');
    const [extendRequest] = mockExtendCapabilityGrant.mock.calls[0];
    expect(extendRequest.loaded).toEqual([RELOAD_LOADED_ITEM_ID]);
    // The card lists the skipped item with its reason.
    expect(extendRequest.summary.skipped).toEqual([
      { kind: 'skill', name: 'Unavailable skill', reason: 'missing_selection' },
    ]);
    // The child is told which item could not be enabled.
    expect(result.continuation).toContain('Unavailable skill');
    expect(result.skipped).toEqual([
      expect.stringContaining('Unavailable skill'),
    ]);

    for (const close of retained.reverse()) await close();
    routeRuntime.release(resolved.value);
  } finally {
    if (priorLstat) mockedLstat.mockImplementation(priorLstat);
    await rm(directory, { recursive: true, force: true });
  }
});

it('reloads a Claude delegate mid-run and stages the newly loaded skill root', async () => {
  mockChildHarness = 'claude';
  mockResolveHelperInvocation.mockResolvedValueOnce({
    providerType: 'claude',
    source: 'claude-managed',
    harness: 'claude',
    sdkModel: 'claude-test',
    aiCreditsRouted: false,
    envOverride: { ANTHROPIC_API_KEY: 'test-key' },
    dispose: mockDisposeInvocation,
  });
  const directory = await mkdtemp(
    path.join(tmpdir(), 'delegation-reload-claude-'),
  );
  const mockedLstat = jest.mocked(lstat);
  const priorLstat = mockedLstat.getMockImplementation();
  mockedLstat.mockImplementation(
    jest.requireActual<typeof FsPromises>('node:fs/promises').lstat,
  );
  try {
    const grant = buildReloadGrant(true);
    const routeHolder: { current?: ResolvedAgentRouteSnapshot } = {};
    const mockExtendCapabilityGrant = jest.fn(
      (
        request: DelegationCapabilityExtensionRequest,
      ): Promise<DelegationCapabilityExtensionResult> => {
        if (!routeHolder.current)
          throw new Error('Expected a captured route before extending');
        return Promise.resolve({
          ok: true,
          grant,
          route: {
            ...routeHolder.current,
            capabilityOverlay: request.capabilityOverlay,
          },
          extensions: 1,
        });
      },
    );
    const routeRuntime = new DelegationRouteRuntime({
      directory,
      owner: (): AgentSessionOptions => ({
        cwd: '/tmp/delegation-route-runtime-test',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      }),
      getWindow: (): null => null,
      authGeneration: (): number => 1,
      capabilityContext: (id): DelegationCapabilityContext | undefined =>
        id === 'delegation'
          ? { delegationId: 'delegation', runGeneration: 1, grant }
          : undefined,
      extendCapabilityGrant: mockExtendCapabilityGrant,
    });
    const resolved = await routeRuntime.resolve(
      parent,
      task,
      new AbortController().signal,
    );
    if (!resolved.ok || !resolved.value.routeId)
      throw new Error('Expected route capture');
    routeHolder.current = resolved.value;
    const captured = capturedRoutes(routeRuntime);
    captured.set(resolved.value.routeId, {
      ...captured.get(resolved.value.routeId),
      capabilities: buildInitialReloadOverlay(),
    });
    const held = await heldRunnerContext(resolved.value);
    const prepared = await routeRuntime.prepareClaude(held.context);
    if (!prepared.capabilityReload)
      throw new Error('Expected a capability reload host');
    const controller = prepared.capabilityReload.controller;
    const admission = controller.request({
      toolCallId: 'load-1',
      refs: [RELOAD_LOADED_ITEM_ID],
      additions: {
        skillRefs: [{ sourceId: 'builtin', skillName: 'loaded-review' }],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      enabledResources: [
        { ref: RELOAD_LOADED_ITEM_ID, kind: 'skill', name: 'Loaded review' },
      ],
    });
    if (!admission.accepted)
      throw new Error('Expected the reload admission to be accepted');
    controller.markDelivered();
    mockMaterializeDelegationCapabilities.mockResolvedValueOnce(
      buildLoadedReloadMaterialization('claude'),
    );
    const signal = new AbortController().signal;
    const result = await controller.perform(
      prepared.capabilityReload.host,
      signal,
    );

    expect(mockMaterializeDelegationCapabilities).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Function),
      'claude',
      expect.any(Object),
    );
    expect(mockExtendCapabilityGrant).toHaveBeenCalledTimes(1);
    if (result.status !== 'loaded')
      throw new Error('Expected the reload to succeed');
    const pluginPath = result.prepared.plugins?.[0]?.path;
    expect(result.prepared.plugins?.[0]).toMatchObject({
      skipMcpDiscovery: true,
    });
    expect(result.prepared.skillNames).toEqual(['loaded-review:reviewer']);
    if (!pluginPath) throw new Error('Expected a staged Claude plugin');
    await expect(readFile(`${pluginPath}/SKILL.md`, 'utf8')).resolves.toBe(
      'LOADED_SKILL_CONTENT',
    );

    // The launch session and reload 1 each keep their own MCP callback.
    const C = CLEANUP_CANARY;
    const baseSessionId = 'project/worktree/chat:delegated:delegation:1';
    const reloadSessionId = `${baseSessionId}:reload-1`;
    mockRevokeStdioMcpRoutes
      .mockRejectedValueOnce(new Error(`${reloadSessionId} sk-ant-${C}`))
      .mockRejectedValueOnce(`reload-1 sk-ant-${C}`);
    // Newest first: reload 1's staged overlay, then the Claude temp dir.
    jest
      .mocked(rm)
      .mockRejectedValueOnce(
        Object.assign(new Error(`ENOTEMPTY: rmdir '/tmp/${C}'`), {
          code: 'ENOTEMPTY',
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error(`EBUSY: rmdir '/var/${C}'`), { code: 'EBUSY' }),
      );
    const revokesBeforeClose = mockRevokeStdioMcpRoutes.mock.calls.length;
    held.finish({
      status: 'completed',
      finalText: 'Reloaded',
      usage: { inputTokens: 3 },
    });
    await expect(held.terminal).resolves.toEqual({
      type: 'terminal',
      status: 'failed',
      finalText: 'Reloaded',
      usage: { inputTokens: 3 },
      error: LAUNCH_UNCERTAIN,
    });
    const failures = [
      failure(CLEANUP_RESOURCES.mcp, 'rejected', { valueType: 'string' }),
      failure(
        CLEANUP_RESOURCES.temporary,
        'rejected',
        errorFields('Error', 'EBUSY'),
      ),
      failure(
        { ...CLEANUP_RESOURCES.overlay, preparation: 1 },
        'rejected',
        errorFields('Error', 'ENOTEMPTY'),
      ),
      failure(
        { ...CLEANUP_RESOURCES.mcp, preparation: 1 },
        'rejected',
        errorFields('Error'),
      ),
    ];
    expect(reportedCleanupDiagnostics(held.reported)).toEqual([
      expect.objectContaining({ retained: 4, failures }),
    ]);
    const warn = jest.mocked(logMainProcessWarn);
    expect(cleanupRecords(warn)).toEqual([cleanupRecord({ failures })]);
    await expect(held.close()).resolves.toBeUndefined();
    expect(cleanupRecords(warn)).toHaveLength(1);
    // Cleanup runs newest first: reload 1 got the Error, the launch the string.
    expect(
      mockRevokeStdioMcpRoutes.mock.calls.slice(revokesBeforeClose),
    ).toEqual([
      [reloadSessionId],
      [baseSessionId],
      [reloadSessionId],
      [baseSessionId],
    ]);
    routeRuntime.release(resolved.value);
  } finally {
    if (priorLstat) mockedLstat.mockImplementation(priorLstat);
    mockRevokeStdioMcpRoutes.mockReset();
    mockRevokeStdioMcpRoutes.mockImplementation(() => Promise.resolve());
    jest.mocked(rm).mockReset();
    jest
      .mocked(rm)
      .mockImplementation(
        jest.requireActual<typeof FsPromises>('node:fs/promises').rm,
      );
    await rm(directory, { recursive: true, force: true });
  }
});

it('fails a reload when the grant extension refuses it, and restores the previous overlay under a fresh session id', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'delegation-reload-limit-'),
  );
  const mockedLstat = jest.mocked(lstat);
  const priorLstat = mockedLstat.getMockImplementation();
  mockedLstat.mockImplementation(
    jest.requireActual<typeof FsPromises>('node:fs/promises').lstat,
  );
  try {
    const grant = buildReloadGrant(true);
    const mockExtendCapabilityGrant = jest.fn(
      (): Promise<DelegationCapabilityExtensionResult> =>
        Promise.resolve({ ok: false, reason: 'reload_limit' }),
    );
    const routeRuntime = new DelegationRouteRuntime({
      directory,
      owner: (): AgentSessionOptions => ({
        cwd: '/tmp/delegation-route-runtime-test',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      }),
      getWindow: (): null => null,
      authGeneration: (): number => 1,
      capabilityContext: (id): DelegationCapabilityContext | undefined =>
        id === 'delegation'
          ? { delegationId: 'delegation', runGeneration: 1, grant }
          : undefined,
      extendCapabilityGrant: mockExtendCapabilityGrant,
    });
    const resolved = await routeRuntime.resolve(
      parent,
      task,
      new AbortController().signal,
    );
    if (!resolved.ok || !resolved.value.routeId)
      throw new Error('Expected route capture');
    const captured = capturedRoutes(routeRuntime);
    captured.set(resolved.value.routeId, {
      ...captured.get(resolved.value.routeId),
      capabilities: buildInitialReloadOverlay(),
    });
    const retained: Array<() => Promise<void>> = [];
    const prepared = await routeRuntime.prepareCodex(
      prepareContext(resolved.value, new AbortController().signal, retained),
    );
    if (!prepared.capabilityReload)
      throw new Error('Expected a capability reload host');
    const baseSessionId = 'project/worktree/chat:delegated:delegation:1';
    const controller = prepared.capabilityReload.controller;
    const admission = controller.request({
      toolCallId: 'load-1',
      refs: [RELOAD_LOADED_ITEM_ID],
      additions: {
        skillRefs: [{ sourceId: 'builtin', skillName: 'loaded-review' }],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      enabledResources: [
        { ref: RELOAD_LOADED_ITEM_ID, kind: 'skill', name: 'Loaded review' },
      ],
    });
    if (!admission.accepted)
      throw new Error('Expected the reload admission to be accepted');
    controller.markDelivered();
    mockMaterializeDelegationCapabilities.mockResolvedValueOnce(
      buildLoadedReloadMaterialization('codex'),
    );
    const signal = new AbortController().signal;
    const result = await controller.perform(
      prepared.capabilityReload.host,
      signal,
    );

    if (result.status !== 'failed')
      throw new Error('Expected the reload to fail');
    expect(result.continuation).toContain('could not be enabled');
    expect(result.message).toBe(
      'This delegated task already loaded capabilities three times in this run.',
    );
    expect(result.prepared.selectedCapabilityRoots ?? []).toEqual([]);
    expect(mockExtendCapabilityGrant).toHaveBeenCalledTimes(1);
    // Staging (reload-1) ran and was revoked before restore (reload-2) took over.
    expect(mockSetSessionToolCallGate).toHaveBeenLastCalledWith(
      `${baseSessionId}:reload-2`,
      expect.any(Function),
    );

    await expect(routeRuntime.available(resolved.value)).resolves.toEqual({
      available: true,
    });

    for (const close of retained.reverse()) await close();
    routeRuntime.release(resolved.value);
  } finally {
    if (priorLstat) mockedLstat.mockImplementation(priorLstat);
    await rm(directory, { recursive: true, force: true });
  }
});

it('fails a reload without recording an extension when the loaded item is skipped', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'delegation-reload-skipped-'),
  );
  const mockedLstat = jest.mocked(lstat);
  const priorLstat = mockedLstat.getMockImplementation();
  mockedLstat.mockImplementation(
    jest.requireActual<typeof FsPromises>('node:fs/promises').lstat,
  );
  try {
    const grant = buildReloadGrant(true);
    const mockExtendCapabilityGrant = jest.fn(
      (): Promise<DelegationCapabilityExtensionResult> =>
        Promise.reject(new Error('extendCapabilityGrant must not be called')),
    );
    const routeRuntime = new DelegationRouteRuntime({
      directory,
      owner: (): AgentSessionOptions => ({
        cwd: '/tmp/delegation-route-runtime-test',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      }),
      getWindow: (): null => null,
      authGeneration: (): number => 1,
      capabilityContext: (id): DelegationCapabilityContext | undefined =>
        id === 'delegation'
          ? { delegationId: 'delegation', runGeneration: 1, grant }
          : undefined,
      extendCapabilityGrant: mockExtendCapabilityGrant,
    });
    const resolved = await routeRuntime.resolve(
      parent,
      task,
      new AbortController().signal,
    );
    if (!resolved.ok) throw new Error('Expected route capture');
    const retained: Array<() => Promise<void>> = [];
    const prepared = await routeRuntime.prepareCodex(
      prepareContext(resolved.value, new AbortController().signal, retained),
    );
    if (!prepared.capabilityReload)
      throw new Error('Expected a capability reload host');
    const controller = prepared.capabilityReload.controller;
    const admission = controller.request({
      toolCallId: 'load-1',
      refs: [RELOAD_LOADED_ITEM_ID],
      additions: {
        skillRefs: [{ sourceId: 'builtin', skillName: 'missing' }],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      enabledResources: [
        {
          ref: RELOAD_LOADED_ITEM_ID,
          kind: 'skill',
          name: 'Unavailable skill',
        },
      ],
    });
    if (!admission.accepted)
      throw new Error('Expected the reload admission to be accepted');
    controller.markDelivered();
    mockMaterializeDelegationCapabilities.mockResolvedValueOnce(
      buildSkippedReloadMaterialization(),
    );
    const signal = new AbortController().signal;
    const result = await controller.perform(
      prepared.capabilityReload.host,
      signal,
    );

    if (result.status !== 'failed')
      throw new Error('Expected the reload to fail');
    expect(result.continuation).toContain('could not be enabled');
    expect(result.message).toBe(
      new DelegationAgentCapabilityError('missing_selection', {
        kind: 'skill',
        name: 'Unavailable skill',
      }).publicMessage,
    );
    expect(result.prepared.selectedCapabilityRoots ?? []).toEqual([]);
    expect(mockExtendCapabilityGrant).not.toHaveBeenCalled();

    for (const close of retained.reverse()) await close();
    routeRuntime.release(resolved.value);
  } finally {
    if (priorLstat) mockedLstat.mockImplementation(priorLstat);
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(['codex', 'claude'] as const)(
  'bills a %s delegate the account proxy serves to the proxy',
  async (harness) => {
    mockChildHarness = harness;
    // The proxy brings its own route, so no native login is needed.
    mockNativelyAuthenticated = false;
    mockResolveHelperInvocation.mockResolvedValue(
      harness === 'codex'
        ? {
            providerType: 'codex',
            source: 'codex-managed',
            harness: 'codex',
            sdkModel: 'gpt-5.6-sol',
            aiCreditsRouted: false,
            accountProxyRouted: true,
            codexConfig: { model_provider: 'canopy_account_proxy' },
            dispose: mockDisposeInvocation,
          }
        : {
            providerType: 'claude',
            source: 'claude-managed',
            harness: 'claude',
            sdkModel: 'claude-test',
            aiCreditsRouted: false,
            accountProxyRouted: true,
            envOverride: {
              ANTHROPIC_BASE_URL: 'http://127.0.0.1:4100/codex-gateway/r',
              ANTHROPIC_AUTH_TOKEN: 'canopy-loopback-broker',
              ANTHROPIC_API_KEY: '',
            },
            dispose: mockDisposeInvocation,
          },
    );
    const routeRuntime = runtime();
    try {
      const resolved = await routeRuntime.resolve(
        parent,
        task,
        new AbortController().signal,
      );
      expect(resolved).toMatchObject({
        ok: true,
        value: {
          harnessId: harness,
          billingAuthority: 'account-proxy',
          aiCreditsRouted: false,
        },
      });
      // The child asks the proxy to keep it on its parent chat's account.
      expect(mockResolveHelperInvocation).toHaveBeenCalledWith(
        expect.anything(),
        undefined,
        expect.objectContaining({
          accountProxyParentSessionId: buildChatSessionKey(
            'project',
            'worktree',
            'chat',
          ),
        }),
      );
      if (resolved.ok) routeRuntime.release(resolved.value);
    } finally {
      mockNativelyAuthenticated = true;
      mockResolveHelperInvocation.mockReset().mockResolvedValue({
        providerType: 'codex' as const,
        source: 'codex-managed' as const,
        harness: 'codex' as const,
        sdkModel: 'gpt-5.6-sol',
        aiCreditsRouted: false,
        dispose: mockDisposeInvocation,
      });
    }
  },
);

it('keeps a proxy-served Claude delegate on the same account key across resolutions', async () => {
  mockChildHarness = 'claude';
  mockNativelyAuthenticated = false;
  // Every resolution registers a new loopback route; the proxy connection is
  // the same, so a follow-up must still match the child's stored key.
  const proxyInvocation = (route: string): unknown => ({
    providerType: 'claude',
    source: 'claude-managed',
    harness: 'claude',
    sdkModel: 'claude-test',
    aiCreditsRouted: false,
    accountProxyRouted: true,
    accountProxyAccountKey: 'account-proxy:connection-1',
    envOverride: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:4100/codex-gateway/${route}`,
      ANTHROPIC_AUTH_TOKEN: 'canopy-loopback-broker',
      ANTHROPIC_API_KEY: '',
    },
    dispose: mockDisposeInvocation,
  });
  mockResolveHelperInvocation
    .mockResolvedValueOnce(proxyInvocation('route-a'))
    .mockResolvedValueOnce(proxyInvocation('route-b'));
  const routeRuntime = runtime();
  try {
    const first = await routeRuntime.resolve(
      parent,
      task,
      new AbortController().signal,
    );
    const second = await routeRuntime.resolve(
      parent,
      task,
      new AbortController().signal,
    );
    if (!first.ok || !second.ok) throw new Error('Expected both to resolve');
    expect(first.value.authAccountKey).toBeDefined();
    expect(second.value.authAccountKey).toBe(first.value.authAccountKey);
    routeRuntime.release(first.value);
    routeRuntime.release(second.value);
  } finally {
    mockNativelyAuthenticated = true;
  }
});

it('keeps a native Codex API-key route bound to the provider account', async () => {
  mockChildHarness = 'codex';
  // How the account is billed must not change who the route belongs to.
  mockNativeBillingAccountKind = 'api_key';
  mockProviderAccountKey = 'codex-key-a';
  const routeRuntime = runtime();
  try {
    const first = await routeRuntime.resolve(
      parent,
      task,
      new AbortController().signal,
    );
    expect(first).toMatchObject({
      ok: true,
      value: {
        harnessId: 'codex',
        billingAuthority: 'native',
        authAccountKey: 'codex-key-a',
      },
    });

    mockProviderAccountKey = 'codex-key-b';
    const second = await routeRuntime.resolve(
      parent,
      task,
      new AbortController().signal,
    );
    expect(second).toMatchObject({
      ok: true,
      value: { billingAuthority: 'native', authAccountKey: 'codex-key-b' },
    });
    if (first.ok) routeRuntime.release(first.value);
    if (second.ok) routeRuntime.release(second.value);
  } finally {
    mockNativeBillingAccountKind = 'subscription';
    mockProviderAccountKey = 'account';
  }
});

it('captures native Cursor billing without a credits route and revokes it on disconnect', async () => {
  mockChildHarness = 'cursor';
  const routeRuntime = runtime();
  const selected = await routeRuntime.resolve(
    parent,
    { ...task, modelId: 'cursor-default' },
    new AbortController().signal,
  );
  expect(selected).toMatchObject({
    ok: true,
    value: {
      harnessId: 'cursor',
      runtimeKind: 'cursor-acp',
      runnerRegistrationId: 'local-delegation-cursor-v1',
      billingAuthority: 'native',
      aiCreditsRouted: false,
    },
  });
  expect(mockResolveHelperInvocation).not.toHaveBeenCalled();
  if (!selected.ok || !selected.value.routeId)
    throw new Error('Expected Cursor route');
  expect(
    capturedRoutes(routeRuntime).get(selected.value.routeId),
  ).toMatchObject({ model: 'default[]' });
  mockCursorEnabled = false;
  expect(
    await routeRuntime.authorize(
      parent,
      selected.value,
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: false });
  routeRuntime.release(selected.value);
});

it.each(['home-only', 'mixed'] as const)(
  'preserves captured home content during a %s capability reload',
  async (kind) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'delegation-home-reload-'),
    );
    const mockedLstat = jest.mocked(lstat);
    const priorLstat = mockedLstat.getMockImplementation();
    mockedLstat.mockImplementation(
      jest.requireActual<typeof FsPromises>('node:fs/promises').lstat,
    );
    const retained: Array<() => Promise<void>> = [];
    try {
      const grant = buildReloadGrant(true);
      const extend = jest.fn(
        (
          request: DelegationCapabilityExtensionRequest,
        ): Promise<DelegationCapabilityExtensionResult> => {
          if (!capturedRoute) throw new Error('Expected captured route');
          return Promise.resolve({
            ok: true,
            grant,
            route: {
              ...capturedRoute,
              capabilityOverlay: request.capabilityOverlay,
            },
            extensions: 1,
          });
        },
      );
      const runtime = new DelegationRouteRuntime({
        directory,
        owner: (): AgentSessionOptions => ({
          cwd: '/tmp/delegation-route-runtime-test',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
        }),
        getWindow: (): null => null,
        authGeneration: (): number => 1,
        capabilityContext: (): DelegationCapabilityContext => ({
          delegationId: 'delegation',
          runGeneration: 1,
          grant,
        }),
        extendCapabilityGrant: extend,
      });
      const resolved = await runtime.resolve(
        parent,
        task,
        new AbortController().signal,
      );
      if (!resolved.ok || !resolved.value.routeId)
        throw new Error('Expected route capture');
      const capturedRoute: ResolvedAgentRouteSnapshot = resolved.value;
      const initial = buildInitialReloadOverlay();
      const homeEntries = [
        {
          root: 'home/reviewer',
          kind: 'skill',
          name: 'reviewer',
          origin: 'agents',
        },
      ] as const;
      const initialWithHome = {
        ...initial,
        pluginFiles: {
          'home/reviewer/skills/reviewer/SKILL.md': 'FROZEN_HOME_SKILL',
        },
        capabilities: {
          ...initial.capabilities,
          claudePluginRoots: ['home/reviewer'],
          codexCapabilityRoots: ['home/reviewer'],
          claudeSkillNames: ['reviewer:reviewer'],
          mcpSelections:
            kind === 'mixed' ? initial.capabilities.mcpSelections : [],
        },
        provenance: {
          roots: { 'home/reviewer': 'inherited' as const },
          mcpSelections:
            kind === 'mixed' ? initial.provenance.mcpSelections : [],
        },
        items: kind === 'mixed' ? initial.items : [],
        homeEntries,
      };
      const captured = capturedRoutes(runtime);
      captured.set(resolved.value.routeId, {
        ...captured.get(resolved.value.routeId),
        capabilities: initialWithHome,
      });
      const prepared = await runtime.prepareCodex(
        prepareContext(resolved.value, new AbortController().signal, retained),
      );
      if (!prepared.capabilityReload) throw new Error('Expected reload host');
      const { controller, host } = prepared.capabilityReload;
      const admission = controller.request({
        toolCallId: 'load-home',
        refs: [RELOAD_LOADED_ITEM_ID],
        additions: {
          skillRefs: [{ sourceId: 'builtin', skillName: 'loaded-review' }],
          pluginRefs: [],
          mcpServerRefs: [],
        },
        enabledResources: [
          { ref: RELOAD_LOADED_ITEM_ID, kind: 'skill', name: 'Loaded review' },
        ],
      });
      expect(admission.accepted).toBe(true);
      controller.markDelivered();
      const loaded = buildLoadedReloadMaterialization('codex');
      mockMaterializeDelegationCapabilities.mockResolvedValueOnce(
        kind === 'mixed'
          ? loaded
          : {
              ...loaded,
              capabilities: { ...loaded.capabilities, mcpSelections: [] },
              provenance: { ...loaded.provenance, mcpSelections: [] },
              included: loaded.included.filter(
                (item) => item.source === 'loaded',
              ),
            },
      );
      const result = await controller.perform(
        host,
        new AbortController().signal,
      );
      expect(result.status).toBe('loaded');
      const request = extend.mock.calls[0]?.[0];
      if (!request?.capabilityOverlay)
        throw new Error('Expected retained extension');
      const artifact = await new AgentArtifactStore(
        path.join(directory, 'artifacts'),
      ).loadCapabilityOverlay(request.capabilityOverlay);
      expect(artifact).toMatchObject({
        homeEntries,
        pluginFiles: {
          'home/reviewer/skills/reviewer/SKILL.md': 'FROZEN_HOME_SKILL',
        },
      });
      expect(artifact.capabilities.codexCapabilityRoots).toContain(
        'home/reviewer',
      );
      expect(request.summary.items).toEqual(
        expect.arrayContaining([
          { kind: 'skill', name: 'reviewer', source: 'inherited' },
        ]),
      );
      runtime.release(resolved.value);
    } finally {
      for (const close of retained.reverse()) await close();
      mockedLstat.mockImplementation(priorLstat);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
