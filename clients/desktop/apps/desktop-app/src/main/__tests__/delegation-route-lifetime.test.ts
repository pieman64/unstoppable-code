/**
 * CAN-4412: a managed delegate's account-proxy route lives while its
 * invocation is authorized, not for the proxy's 30-minute temporary-route TTL.
 *
 * Real service, broker, route runtime, helper invocation, local runner and
 * loopback proxy. The routing decision is a stub that registers a real
 * loopback route; runners are scripted; only the proxy's 30-minute timers run
 * on a virtual clock. Every request stays on 127.0.0.1.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as ProxyModule from '../agents/codex-gateway-proxy-service';
import type * as ServiceModule from '../agents/delegation/service';
import type * as LifecycleModule from '../agents/delegation/lifecycle';
import type * as StorageModule from '@canopy/desktop-shared/node/delegation/storage';
import type * as LocalRunnerModule from '@canopy/desktop-shared/node/delegation/local-runner';
import type * as SharedTypesModule from '@canopy/desktop-shared/types';
import type {
  LocalDelegationOutcome,
  LocalDelegationRunner,
} from '@canopy/desktop-shared/node/delegation/local-runner';
import type { StoredDelegation } from '@canopy/desktop-shared/node/delegation/broker';
import type {
  DelegationStopReason,
  ResolvedAgentRouteSnapshot,
  RunnerAvailability,
} from '@canopy/desktop-shared/node/delegation/types';
import type { AgentDelegationResult } from '@canopy/protocol/delegation';
import type { DelegationModelRuntimeHost } from '../agents/delegation-model-runtime';
import type * as MainLogModule from '../lib/main-process-logging';
import {
  CLEANUP_CANARY,
  CLEANUP_RESOURCES,
  cleanupRecord,
  cleanupRecords,
  errorFields,
  failure,
} from './helpers/delegation-cleanup-records';

const ROUTE_TTL_MS = 30 * 60_000;
const IDLE_PAST_TTL_MS = 31 * 60_000;
const RUNTIME_MODEL = { claude: 'claude-opus-5', codex: 'gpt-5-codex' };

type Harness = 'claude' | 'codex';
type StopMode = 'confirmed' | 'unconfirmed' | 'throws';

interface ScriptedRun {
  readonly url: string;
  readonly signal: AbortSignal;
  readonly finish: (outcome: LocalDelegationOutcome) => void;
}

interface Gate {
  readonly promise: Promise<void>;
  readonly open: () => void;
}

function gate(): Gate {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const mockHost: {
  proxy?: ProxyModule.CodexGatewayProxyService;
  upstreamUrl: string;
  harness: Harness;
  billing: 'account-proxy' | 'ai-credits';
  e2eMock: boolean;
  routes: string[];
  retains: number;
  releases: number;
  onRetain?: () => void;
  onRouted?: () => void;
  duringRouting?: Promise<void>;
  beforeCapture?: Promise<void>;
  afterCapture?: Promise<void>;
  refuseAfterCapture: boolean;
  waitingBeforeCapture: number;
  captured: number;
  runs: ScriptedRun[];
  cleanup?: () => Promise<void>;
  stopMode: StopMode;
  stopGate?: Promise<void>;
  stopReasons: DelegationStopReason[];
  ignoreAbort: boolean;
  reportNativeSession: boolean;
  blockCommits: boolean;
  heldCommits: Array<() => void>;
  records: Map<string, StoredDelegation>;
  authGenerations: Map<string, number>;
} = {
  upstreamUrl: '',
  harness: 'claude',
  billing: 'account-proxy',
  e2eMock: false,
  routes: [],
  retains: 0,
  releases: 0,
  refuseAfterCapture: false,
  waitingBeforeCapture: 0,
  captured: 0,
  runs: [],
  stopMode: 'confirmed',
  stopReasons: [],
  ignoreAbort: false,
  reportNativeSession: false,
  blockCommits: false,
  heldCommits: [],
  records: new Map(),
  authGenerations: new Map(),
};

function mockActiveProxy(): ProxyModule.CodexGatewayProxyService {
  if (!mockHost.proxy) throw new Error('The test proxy is not running');
  return mockHost.proxy;
}

// Survives the per-test module reset that reloads the delegation service.
const mockLogMainProcessWarn = jest.fn<void, [string, unknown]>();
jest.mock('../lib/main-process-logging', () => ({
  ...jest.requireActual<typeof MainLogModule>('../lib/main-process-logging'),
  logMainProcessWarn: (message: string, context?: unknown): void =>
    mockLogMainProcessWarn(message, context),
}));

jest.mock('../agents/codex-gateway-proxy-service', () => ({
  ...jest.requireActual<typeof ProxyModule>(
    '../agents/codex-gateway-proxy-service',
  ),
  getCodexGatewayProxyService: (): ProxyModule.CodexGatewayProxyService =>
    mockActiveProxy(),
}));

/** The routing decision; it registers a real loopback route on the test proxy. */
async function mockRoutingOverride(
  model: string,
  provider: Harness,
  sessionId: string,
): Promise<{
  provider: Harness;
  model: string;
  env: Record<string, string>;
  accountProxyRouted?: boolean;
  accountProxyAccountKey?: string;
  codexConfig?: Record<string, string>;
}> {
  const lease = await mockActiveProxy().registerRoute({
    sessionId,
    upstreamUrl: mockHost.upstreamUrl,
    resolveToken: () => Promise.resolve('synthetic-token'),
  });
  mockHost.routes.push(lease.baseUrl);
  mockHost.onRouted?.();
  await mockHost.duringRouting;
  const env = {
    ANTHROPIC_BASE_URL: lease.baseUrl,
    ANTHROPIC_AUTH_TOKEN: 'loopback',
  };
  if (mockHost.billing === 'ai-credits')
    return {
      provider,
      model,
      env,
      ...(provider === 'codex'
        ? { codexConfig: { model_provider: 'canopy_ai_credits' } }
        : {}),
    };
  return {
    provider,
    model,
    env,
    accountProxyRouted: true,
    accountProxyAccountKey: 'account-proxy:synthetic-connection',
    ...(provider === 'codex'
      ? { codexConfig: { model_provider: 'canopy_account_proxy' } }
      : {}),
  };
}
jest.mock('../agents/ai-credits-routing', () => ({
  resolveAiCreditsRoutingOverride: (
    model: string,
    provider: Harness,
    _routing: unknown,
    sessionId: string,
  ): ReturnType<typeof mockRoutingOverride> =>
    mockRoutingOverride(model, provider, sessionId),
}));

/** Model resolution as the route runtime's host sees it, with gates around capture. */
async function mockResolveDelegationModel(
  modelId: string,
  host: DelegationModelRuntimeHost,
): Promise<AgentDelegationResult<{ route: ResolvedAgentRouteSnapshot }>> {
  mockHost.waitingBeforeCapture += 1;
  await mockHost.beforeCapture;
  const captured = await host.captureRoute({
    selectedModel: modelId,
    runtimeModel: RUNTIME_MODEL[mockHost.harness],
    providerType: mockHost.harness,
    executionHarness: mockHost.harness,
    systemPromptAppend: undefined,
    pluginSelections: undefined,
  });
  if (!captured.ok) return captured;
  mockHost.captured += 1;
  await mockHost.afterCapture;
  // The real resolver turns any later throw or refusal into this result.
  if (mockHost.refuseAfterCapture)
    return {
      ok: false,
      error: {
        code: 'route_unavailable',
        message: 'The retained delegation model or projection is unavailable.',
        retryable: false,
      },
    };
  const authorized = await host.authorize(captured.value);
  return authorized.ok
    ? { ok: true, value: { route: captured.value } }
    : authorized;
}
jest.mock('../agents/delegation-model-runtime', () => ({
  resolveDelegationModel: (
    modelId: string,
    _thinkingLevel: unknown,
    host: DelegationModelRuntimeHost,
  ): ReturnType<typeof mockResolveDelegationModel> =>
    mockResolveDelegationModel(modelId, host),
  resumeDelegationModel: (): Promise<never> =>
    Promise.reject(new Error('Overlay resume is not part of these tests')),
}));

function mockScriptedRunner(
  harness: Harness,
  runtimeKind: string,
  options: {
    available: (
      route: ResolvedAgentRouteSnapshot,
    ) => Promise<RunnerAvailability>;
    reportError: (error: unknown) => void;
  },
): LocalDelegationRunner {
  const { LocalDelegationRunner: Runner } = jest.requireActual<
    typeof LocalRunnerModule
  >('@canopy/desktop-shared/node/delegation/local-runner');
  const runner = new Runner(
    harness,
    runtimeKind,
    options.available,
    async (context) => {
      if (mockHost.cleanup)
        context.retain(mockHost.cleanup, {
          label: 'native-process',
          phase: 'native',
        });
      // A native session makes the run resumable by a follow-up.
      if (mockHost.reportNativeSession)
        await context.emit({
          type: 'started',
          nativeSessionId: `native-${context.request.delegationId}`,
        });
      return new Promise<LocalDelegationOutcome>((resolve) => {
        mockHost.runs.push({
          url: mockHost.routes.at(-1) ?? '',
          signal: context.signal,
          finish: resolve,
        });
        if (!mockHost.ignoreAbort)
          context.signal.addEventListener(
            'abort',
            () =>
              resolve({
                status: 'cancelled',
                error: {
                  code: 'runtime_error',
                  message: 'The scripted runner was aborted.',
                  retryable: false,
                },
              }),
            { once: true },
          );
      });
    },
    options.reportError,
  );
  const confirmStop = runner.stop.bind(runner);
  runner.stop = async (
    handle,
    reason,
  ): Promise<Awaited<ReturnType<LocalDelegationRunner['stop']>>> => {
    mockHost.stopReasons.push(reason);
    // Holds only the first native stop.
    const held = mockHost.stopGate;
    mockHost.stopGate = undefined;
    await held;
    if (mockHost.stopMode === 'throws')
      throw new Error('The scripted native stop failed.');
    if (mockHost.stopMode === 'unconfirmed')
      return {
        stopped: false,
        error: {
          code: 'launch_uncertain',
          message: 'The delegated runner has not confirmed cancellation.',
          retryable: false,
        },
      };
    return confirmStop(handle, reason);
  };
  return runner;
}
jest.mock('../agents/delegation/claude-runner', () => ({
  createClaudeDelegationRunner: (
    options: Parameters<typeof mockScriptedRunner>[2],
  ): LocalDelegationRunner =>
    mockScriptedRunner('claude', 'claude-sdk', options),
}));
jest.mock('../agents/delegation/codex-runner', () => ({
  createCodexDelegationRunner: (
    options: Parameters<typeof mockScriptedRunner>[2],
  ): LocalDelegationRunner =>
    mockScriptedRunner('codex', 'codex-app-server', options),
}));

jest.mock('@canopy/desktop-shared/node/delegation/storage', () => {
  const actual = jest.requireActual<typeof StorageModule>(
    '@canopy/desktop-shared/node/delegation/storage',
  );
  /** Real file storage whose commits a test can hold. */
  class GatedDelegationStorage extends actual.FileDelegationStorage {
    override async commit(record: StoredDelegation): Promise<void> {
      if (mockHost.blockCommits)
        await new Promise<void>((resolve) =>
          mockHost.heldCommits.push(resolve),
        );
      await super.commit(record);
      mockHost.records.set(record.state.delegationId, structuredClone(record));
    }
  }
  return { ...actual, FileDelegationStorage: GatedDelegationStorage };
});

jest.mock('@canopy/desktop-shared/types', () => {
  const actual = jest.requireActual<typeof SharedTypesModule>(
    '@canopy/desktop-shared/types',
  );
  const harnessOf = (model: string): Harness | undefined =>
    model === RUNTIME_MODEL.claude
      ? 'claude'
      : model === RUNTIME_MODEL.codex
        ? 'codex'
        : undefined;
  return {
    ...actual,
    getExecutionHarnessForModel: (
      model: string,
      captured?: SharedTypesModule.ModelHarness,
    ): SharedTypesModule.ModelHarness | undefined =>
      captured ?? harnessOf(model) ?? actual.getExecutionHarnessForModel(model),
    getModelSource: (
      model: string,
    ): SharedTypesModule.ModelHarnessSource | undefined => {
      const harness = harnessOf(model);
      return harness ? `${harness}-managed` : actual.getModelSource(model);
    },
  };
});
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
    supportedThinkingLevels: readonly ['low', 'high'];
  } => ({
    id: modelId,
    label: modelId,
    modelSource: `${mockHost.harness}-managed`,
    defaultHarness: mockHost.harness,
    enabled: true,
    selectable: true,
    supportedThinkingLevels: ['low', 'high'],
  }),
}));
jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (): Promise<boolean> => Promise.resolve(false),
}));
jest.mock('../lib/model-gateway-state', () => ({
  resolveHelperModelForEnforcedGateway: (model: string): Promise<string> =>
    Promise.resolve(model),
  checkModelGatewayRoute: (): Promise<{ ok: true; orgRoute: false }> =>
    Promise.resolve({ ok: true, orgRoute: false }),
}));
jest.mock('../account-proxy/quota-wait', () => ({
  createAccountProxyQuotaWait: (): undefined => undefined,
}));
jest.mock('../ollama/claude-compatible', () => ({
  resolveClaudeCompatibleInvocation: (
    model: string,
  ): Promise<{ providerType: 'claude'; sdkModel: string }> =>
    Promise.resolve({ providerType: 'claude', sdkModel: model }),
}));
jest.mock('@canopy/desktop-shared/node/e2e-mock-env', () => ({
  resolveAnthropicMockEnvOverride: ():
    | Record<
        'ANTHROPIC_BASE_URL' | 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY',
        string
      >
    | undefined =>
    mockHost.e2eMock
      ? {
          ANTHROPIC_BASE_URL: mockHost.upstreamUrl,
          ANTHROPIC_AUTH_TOKEN: 'mock',
          ANTHROPIC_API_KEY: 'mock',
        }
      : undefined,
}));
jest.mock('../agents/work-owner', () => ({
  resolveSessionWorkOwner: (): Promise<undefined> => Promise.resolve(undefined),
  resolveInvocationWorkOwner: (): Promise<undefined> =>
    Promise.resolve(undefined),
  resolveBackgroundWorkOwner: (): Promise<undefined> =>
    Promise.resolve(undefined),
}));
jest.mock('../lib/user-environment-runtime', () => ({
  resolveCodexRuntimeEnvironmentProfile: (): {
    environment: Record<string, string>;
    logicalWorkspaceEnvironmentId: string;
    secretVersionFingerprint: string;
  } => ({
    environment: {},
    logicalWorkspaceEnvironmentId: 'workspace-environment',
    secretVersionFingerprint: 'secret-version',
  }),
}));
jest.mock('../auth/provider-auth-state', () => ({
  isProviderNativelyAuthenticatedForRouting: (): Promise<boolean> =>
    Promise.resolve(true),
  peekProviderAccountIdentity: (): { providerAccountKey: string } => ({
    providerAccountKey: 'native-account',
  }),
  peekProviderBillingAccountKind: (): string => 'subscription',
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: (): Promise<null> => Promise.resolve(null),
  subscribeCanopyCloudAccountChanges: (): (() => void) => () => undefined,
}));
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): { subscribe: () => () => void } => ({
    subscribe: () => () => undefined,
  }),
}));
jest.mock('../observability', () => ({
  getObservabilityService: (): { recordSessionDiagnostic: () => void } => ({
    recordSessionDiagnostic: () => undefined,
  }),
}));
jest.mock('../agents/session-manager', () => ({
  getProviderAuthGeneration: (provider: string): number =>
    mockHost.authGenerations.get(provider) ?? 0,
}));
jest.mock('../power/wake-lock-service', () => ({
  getWakeLockService: (): { acquire: () => void; release: () => void } => ({
    acquire: () => undefined,
    release: () => undefined,
  }),
}));

/** Only the proxy's 30-minute route timers run on this virtual clock. */
const ttlTimers = new Map<NodeJS.Timeout, () => void>();
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
function installTtlClock(): void {
  jest.spyOn(global, 'setTimeout').mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ): NodeJS.Timeout => {
    if (delay !== ROUTE_TTL_MS) return realSetTimeout(callback, delay, ...args);
    const handle = realSetTimeout(() => undefined, 2_147_483_647);
    handle.unref();
    ttlTimers.set(handle, () => callback(...args));
    return handle;
  }) as typeof setTimeout);
  jest.spyOn(global, 'clearTimeout').mockImplementation(((
    handle?: NodeJS.Timeout | string | number,
  ): void => {
    if (typeof handle === 'object') ttlTimers.delete(handle);
    realClearTimeout(handle);
  }) as typeof clearTimeout);
}
/** Fires every pending 30-minute timer; any later wait is a new 30 minutes. */
function idlePastRouteTtl(): void {
  expect(IDLE_PAST_TTL_MS).toBeGreaterThan(ROUTE_TTL_MS);
  for (const [handle, fire] of Array.from(ttlTimers)) {
    ttlTimers.delete(handle);
    realClearTimeout(handle);
    fire();
  }
}

async function settle(rounds = 40): Promise<void> {
  for (let index = 0; index < rounds; index += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}
async function waitUntil(
  condition: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${description}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** The status a model request through the route gets from the proxy. */
async function request(url: string): Promise<number> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  await response.text();
  return response.status;
}

function liveRoutes(): number {
  const routes: unknown = Reflect.get(mockActiveProxy(), 'routes');
  if (!(routes instanceof Map)) throw new Error('Missing proxy route state');
  return routes.size;
}

interface Loaded {
  service: typeof ServiceModule;
  lifecycle: typeof LifecycleModule;
}

let upstream: Server;
let workDirectory: string;
let worktreeSequence = 0;
let loaded: Loaded | undefined;
let target: { projectId: string; worktreeId: string; chatId: string };

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
if (!platformDescriptor) throw new Error('Expected the platform property');

beforeAll(async () => {
  // Delegation runs only on supported desktop platforms.
  Object.defineProperty(process, 'platform', {
    ...platformDescriptor,
    value: platformDescriptor.value === 'win32' ? 'win32' : 'darwin',
  });
  upstream = createServer((incoming, response) => {
    incoming.resume();
    incoming.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', resolve),
  );
  const address = upstream.address();
  if (!address || typeof address === 'string')
    throw new Error('The test upstream did not bind');
  mockHost.upstreamUrl = `http://127.0.0.1:${String(address.port)}`;
  workDirectory = await mkdtemp(path.join(tmpdir(), 'delegation-route-life-'));
});

afterAll(async () => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await rm(workDirectory, { recursive: true, force: true });
});

/** Shutdown is final for the service module, so the next test loads a fresh copy. */
let serviceClosed = true;
/** Module state a test changed for good, such as the delegation policy. */
let reloadService = false;

async function shutDown(): Promise<void> {
  serviceClosed = true;
  await service().shutdownManagedDelegations();
}

beforeEach(async () => {
  if (serviceClosed || reloadService) {
    reloadService = false;
    jest.resetModules();
    loaded = {
      service: await import('../agents/delegation/service'),
      lifecycle: await import('../agents/delegation/lifecycle'),
    };
    serviceClosed = false;
  }
  ttlTimers.clear();
  installTtlClock();
  Object.assign(mockHost, {
    harness: 'claude',
    billing: 'account-proxy',
    e2eMock: false,
    routes: [],
    retains: 0,
    releases: 0,
    onRetain: undefined,
    onRouted: undefined,
    duringRouting: undefined,
    beforeCapture: undefined,
    afterCapture: undefined,
    refuseAfterCapture: false,
    waitingBeforeCapture: 0,
    captured: 0,
    runs: [],
    cleanup: undefined,
    stopMode: 'confirmed',
    stopGate: undefined,
    stopReasons: [],
    ignoreAbort: false,
    reportNativeSession: false,
    blockCommits: false,
    heldCommits: [],
    records: new Map(),
    authGenerations: new Map(),
  });
  const proxyModule = await import('../agents/codex-gateway-proxy-service');
  const proxy = new proxyModule.CodexGatewayProxyService({
    retryDelaysMs: [0, 0, 0],
  });
  const retain = proxy.retainRoutesForSession.bind(proxy);
  proxy.retainRoutesForSession = (sessionId): (() => void) => {
    mockHost.retains += 1;
    const release = retain(sessionId);
    let released = false;
    mockHost.onRetain?.();
    return (): void => {
      if (!released) mockHost.releases += 1;
      released = true;
      release();
    };
  };
  mockHost.proxy = proxy;
  worktreeSequence += 1;
  target = {
    projectId: 'project',
    worktreeId: `worktree-${String(worktreeSequence)}`,
    chatId: 'chat',
  };
});

afterEach(async () => {
  mockHost.blockCommits = false;
  for (const release of mockHost.heldCommits.splice(0)) release();
  for (const run of mockHost.runs)
    run.finish({ status: 'completed', finalText: 'test teardown' });
  try {
    if (!serviceClosed) await loaded?.lifecycle.closeDelegationScope(target);
  } catch {
    // Unconfirmed-stop tests leave their scope's close incomplete on purpose.
  }
  await mockHost.proxy?.shutdown();
  mockHost.proxy = undefined;
  jest.restoreAllMocks();
});

function service(): typeof ServiceModule {
  if (!loaded) throw new Error('The delegation service is not loaded');
  return loaded.service;
}

async function openParent(): Promise<{
  spawn: (callId: string) => Promise<string>;
  followUp: (
    delegationId: string,
    callId: string,
  ) => Promise<AgentDelegationResult<unknown>>;
}> {
  const options = {
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    chatId: target.chatId,
    cwd: workDirectory,
    harness: 'codex' as const,
    model: 'gpt-5',
  };
  const session = await service().createManagedDelegationSession({
    harness: 'codex',
    sessionKey: `${target.projectId}/${target.worktreeId}/${target.chatId}`,
    currentOptions: () => options,
    currentTurn: () => 'turn-1',
    getWindow: () => null,
  });
  const toolNames = session.codexTools.map((tool) => tool.name);
  const spawnName = toolNames.find((name) => /spawn/i.test(name));
  const messageName = toolNames.find((name) => /message_delegate/i.test(name));
  if (!spawnName || !messageName)
    throw new Error(`Missing delegation tools: ${toolNames.join(', ')}`);
  const invoke = (
    name: string,
    input: unknown,
    callId: string,
  ): Promise<AgentDelegationResult<unknown>> =>
    session.parent.invokeCodex(
      name,
      input,
      { callId, turnId: 'turn-1', threadId: 'thread-1' },
      'thread-1',
      'turn-1',
    );
  return {
    spawn: async (callId): Promise<string> => {
      const result = await invoke(
        spawnName,
        {
          model: 'logical-review-model',
          task_name: 'review',
          message: 'Read src/index.ts.',
        },
        callId,
      );
      const match = /"delegationId":"([^"]+)"/.exec(
        JSON.stringify(result.ok ? result.value : result.error),
      );
      if (!match?.[1])
        throw new Error(
          `The spawn returned no delegation: ${JSON.stringify(result)}`,
        );
      return match[1];
    },
    followUp: (delegationId, callId) =>
      invoke(
        messageName,
        { delegationId, operation: 'follow_up', message: 'Keep working.' },
        callId,
      ),
  };
}

function persisted(delegationId: string): {
  status?: string;
  stopReason?: string;
  error?: string;
  message?: string;
} {
  const state = mockHost.records.get(delegationId)?.state;
  return {
    status: state?.status,
    stopReason: state?.stopReason,
    error: state?.error?.code,
    message: state?.error?.message,
  };
}

function stopForUser(
  delegationId: string,
): ReturnType<typeof ServiceModule.stopManagedDelegationForUser> {
  return service().stopManagedDelegationForUser(target, delegationId);
}

async function startRun(harness: Harness): Promise<{
  delegationId: string;
  run: ScriptedRun;
  parent: Awaited<ReturnType<typeof openParent>>;
}> {
  mockHost.harness = harness;
  const parent = await openParent();
  const delegationId = await parent.spawn('call-1');
  await waitUntil(() => mockHost.runs.length > 0, 'the scripted run');
  const run = mockHost.runs[0];
  if (!run) throw new Error('Expected a scripted run');
  return { delegationId, run, parent };
}

/** Holds every storage commit from now until {@link releaseCommits}. */
function holdCommits(): void {
  mockHost.blockCommits = true;
}
function releaseCommits(): void {
  mockHost.blockCommits = false;
  for (const release of mockHost.heldCommits.splice(0)) release();
}

function holdCounts(): { retains: number; releases: number } {
  return { retains: mockHost.retains, releases: mockHost.releases };
}

/** Spawns and holds its preparation at `gateName` until the gate opens. */
async function spawnHeld(
  harness: Harness,
  gateName: 'duringRouting' | 'beforeCapture' | 'afterCapture',
): Promise<{
  delegationId: string;
  spawned: Promise<string>;
  open: () => void;
}> {
  mockHost.harness = harness;
  const held = gate();
  mockHost[gateName] = held.promise;
  const parent = await openParent();
  const spawned = parent.spawn('call-1');
  await waitUntil(
    () =>
      gateName === 'duringRouting'
        ? mockHost.routes.length > 0
        : gateName === 'beforeCapture'
          ? mockHost.waitingBeforeCapture > 0
          : mockHost.captured > 0,
    'the held preparation',
  );
  const delegationId = Array.from(mockHost.records.keys())[0];
  if (!delegationId) throw new Error('Expected a reserved delegation');
  return {
    delegationId,
    spawned,
    open: (): void => {
      mockHost[gateName] = undefined;
      held.open();
    },
  };
}

const runnerFailure = 'There is an issue with the selected model.';

describe.each(['claude', 'codex'] as const)(
  '%s account-proxy delegate',
  (harness) => {
    it('keeps its route through a model-free gap past the route TTL and withdraws it at completion', async () => {
      const { delegationId, run } = await startRun(harness);
      expect(await request(run.url)).toBe(200);

      idlePastRouteTtl();

      expect(await request(run.url)).toBe(200);
      expect(ttlTimers.size).toBe(0);
      run.finish({ status: 'completed', finalText: 'done' });
      await waitUntil(
        () => persisted(delegationId).status === 'completed',
        'completion',
      );
      await waitUntil(() => mockHost.releases === 1, 'the hold release');
      expect(await request(run.url)).toBe(404);
      expect(liveRoutes()).toBe(0);
      expect(holdCounts()).toEqual({ retains: 1, releases: 1 });
    });

    it('withdraws the route when the provider fails, after a gap past the route TTL', async () => {
      const { delegationId, run } = await startRun(harness);
      idlePastRouteTtl();
      expect(await request(run.url)).toBe(200);

      run.finish({
        status: 'failed',
        error: {
          code: 'runtime_error',
          message: runnerFailure,
          retryable: false,
        },
      });
      await waitUntil(
        () => persisted(delegationId).status === 'failed',
        'the failure record',
      );
      await waitUntil(() => mockHost.releases === 1, 'the hold release');

      expect(await request(run.url)).toBe(404);
      expect(liveRoutes()).toBe(0);
      expect(holdCounts()).toEqual({ retains: 1, releases: 1 });
      expect(persisted(delegationId)).toMatchObject({
        status: 'failed',
        error: 'runtime_error',
        message: runnerFailure,
      });
    });

    it('withdraws the route when a stop is accepted, before the stop commits', async () => {
      const { delegationId, run } = await startRun(harness);
      holdCommits();
      const stopping = stopForUser(delegationId);
      await waitUntil(() => mockHost.heldCommits.length > 0, 'a held commit');

      expect(await request(run.url)).toBe(404);

      releaseCommits();
      await expect(stopping).resolves.toMatchObject({ ok: true });
      expect(persisted(delegationId)).toMatchObject({
        status: 'cancelled',
        stopReason: 'user_cancelled',
      });
      expect(holdCounts()).toEqual({ retains: 1, releases: 1 });
    });

    describe.each(['confirmed', 'unconfirmed', 'throws'] as const)(
      'when the native stop is %s',
      (stopMode) => {
        it('keeps an unrelated runner failure that lands during the stop as failed', async () => {
          const { delegationId, run } = await startRun(harness);
          mockHost.stopMode = stopMode;
          holdCommits();
          const stopping = stopForUser(delegationId);
          await waitUntil(
            () => mockHost.heldCommits.length > 0,
            'a held commit',
          );
          run.finish({
            status: 'failed',
            error: {
              code: 'runtime_error',
              message: runnerFailure,
              retryable: false,
            },
          });
          await settle();
          releaseCommits();
          await stopping;
          await waitUntil(
            () => persisted(delegationId).status === 'failed',
            'the failure record',
          );
          expect(persisted(delegationId)).toMatchObject({
            status: 'failed',
            error: 'runtime_error',
            message: runnerFailure,
          });
        });

        it('keeps a failure caused by the withdrawn route as failed', async () => {
          const { delegationId, run } = await startRun(harness);
          mockHost.stopMode = stopMode;
          holdCommits();
          const stopping = stopForUser(delegationId);
          await waitUntil(
            () => mockHost.heldCommits.length > 0,
            'a held commit',
          );
          const status = await request(run.url);
          expect(status).toBe(404);
          const message = `The model request failed with status ${String(status)}.`;
          run.finish({
            status: 'failed',
            error: { code: 'runtime_error', message, retryable: false },
          });
          await settle();
          releaseCommits();
          await stopping;
          await waitUntil(
            () => persisted(delegationId).status === 'failed',
            'the failure record',
          );
          expect(persisted(delegationId)).toMatchObject({
            status: 'failed',
            error: 'runtime_error',
            message,
          });
        });
      },
    );

    it('reports an unconfirmed stop without terminal evidence as uncertain, not ended', async () => {
      mockHost.ignoreAbort = true;
      mockHost.stopMode = 'unconfirmed';
      const { delegationId, run } = await startRun(harness);

      const result = await stopForUser(delegationId);

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'runtime_error',
          message: 'The delegation subtree could not confirm cancellation.',
        },
      });
      expect(persisted(delegationId)).toMatchObject({
        status: 'interrupted',
        error: 'launch_uncertain',
      });
      expect(await request(run.url)).toBe(404);
      await expect(shutDown()).rejects.toThrow(
        'Delegation shutdown was incomplete',
      );
      expect(persisted(delegationId)).toMatchObject({ status: 'interrupted' });
    }, 60_000);

    it('drops the hold at capture when the harness was revoked after admission without a generation change', async () => {
      const held = await spawnHeld(harness, 'beforeCapture');
      const after = gate();
      mockHost.afterCapture = after.promise;
      await service().revokeManagedDelegations(harness);
      expect(mockHost.routes).toHaveLength(0);

      held.open();
      await waitUntil(() => mockHost.captured > 0, 'the late capture');

      const [url] = mockHost.routes;
      if (!url) throw new Error('Expected a captured route');
      expect(await request(url)).toBe(404);
      expect(holdCounts()).toEqual({ retains: 1, releases: 1 });
      expect(ttlTimers.size).toBe(0);
      mockHost.afterCapture = undefined;
      after.open();
      await held.spawned;
      await waitUntil(
        () => persisted(held.delegationId).status === 'cancelled',
        'the revoked record',
      );
      expect(persisted(held.delegationId)).toMatchObject({
        status: 'cancelled',
        stopReason: 'policy_revoked',
      });
    });

    it.each([
      ['a user stop', 'user_cancelled'],
      ['a harness revocation', 'policy_revoked'],
      ['shutdown', 'shutdown'],
    ] as const)(
      'disposes a route captured after %s while preparation was held',
      async (action, stopReason) => {
        const held = await spawnHeld(harness, 'beforeCapture');
        const acting =
          action === 'a user stop'
            ? stopForUser(held.delegationId)
            : action === 'a harness revocation'
              ? service().revokeManagedDelegations(harness)
              : shutDown();
        await settle();
        expect(mockHost.routes).toHaveLength(0);

        held.open();
        await held.spawned.catch(() => undefined);
        await acting;
        await settle();

        for (const url of mockHost.routes) expect(await request(url)).toBe(404);
        expect(liveRoutes()).toBe(0);
        expect(ttlTimers.size).toBe(0);
        expect(mockHost.retains).toBe(mockHost.releases);
        await waitUntil(
          () => persisted(held.delegationId).status !== 'pending',
          'the settled record',
        );
        expect(persisted(held.delegationId)).toMatchObject({
          status: 'cancelled',
          stopReason,
        });
      },
    );

    it.each([
      ['a user stop', 'user_cancelled'],
      ['a harness revocation', 'policy_revoked'],
    ] as const)(
      'disposes a route still registering when %s is accepted',
      async (action, stopReason) => {
        const held = await spawnHeld(harness, 'duringRouting');
        const acting =
          action === 'a user stop'
            ? stopForUser(held.delegationId)
            : service().revokeManagedDelegations(harness);
        await settle();

        held.open();
        await acting;
        await waitUntil(
          () => persisted(held.delegationId).status === 'cancelled',
          'the stopped record',
        );

        for (const url of mockHost.routes) expect(await request(url)).toBe(404);
        expect(liveRoutes()).toBe(0);
        expect(ttlTimers.size).toBe(0);
        expect(mockHost.retains).toBe(mockHost.releases);
        expect(persisted(held.delegationId)).toMatchObject({
          status: 'cancelled',
          stopReason,
        });
      },
    );

    it('withdraws a preparing route at a stop accepted after capture', async () => {
      const held = await spawnHeld(harness, 'afterCapture');
      const [url] = mockHost.routes;
      if (!url) throw new Error('Expected a captured route');
      expect(ttlTimers.size).toBe(0);
      holdCommits();
      const stopping = stopForUser(held.delegationId);
      await waitUntil(() => mockHost.heldCommits.length > 0, 'a held commit');

      expect(await request(url)).toBe(404);

      releaseCommits();
      held.open();
      await held.spawned.catch(() => undefined);
      await stopping;
      expect(persisted(held.delegationId)).toMatchObject({
        status: 'cancelled',
        stopReason: 'user_cancelled',
      });
      expect(holdCounts()).toEqual({ retains: 1, releases: 1 });
    });

    it('holds a continuation route and withdraws it at a stop with a held commit', async () => {
      mockHost.reportNativeSession = true;
      const { delegationId, run, parent } = await startRun(harness);
      run.finish({ status: 'completed', finalText: 'done' });
      await waitUntil(
        () => persisted(delegationId).status === 'completed',
        'completion',
      );
      const after = gate();
      mockHost.afterCapture = after.promise;
      const captured = mockHost.captured;
      // The follow-up is accepted at once and prepares in the background.
      await expect(
        parent.followUp(delegationId, 'call-continue'),
      ).resolves.toMatchObject({ ok: true });
      await waitUntil(
        () => mockHost.captured > captured,
        'the continuation capture',
      );
      const url = mockHost.routes.at(-1);
      if (!url) throw new Error('Expected a continuation route');
      expect(ttlTimers.size).toBe(0);
      expect(await request(url)).toBe(200);

      holdCommits();
      const stopping = stopForUser(delegationId);
      await waitUntil(() => mockHost.heldCommits.length > 0, 'a held commit');
      expect(await request(url)).toBe(404);

      releaseCommits();
      mockHost.afterCapture = undefined;
      after.open();
      await stopping;
      await waitUntil(
        () => persisted(delegationId).status === 'cancelled',
        'the stopped continuation',
      );
      expect(persisted(delegationId)).toMatchObject({
        status: 'cancelled',
        stopReason: 'user_cancelled',
      });
      expect(holdCounts()).toEqual({ retains: 2, releases: 2 });
    });

    it.each(['running', 'preparing'] as const)(
      'withdraws the route when the parent chat closes while %s',
      async (phase) => {
        let url: string | undefined;
        let delegationId: string;
        let finishPreparation: (() => Promise<unknown>) | undefined;
        if (phase === 'running') {
          const started = await startRun(harness);
          url = started.run.url;
          delegationId = started.delegationId;
        } else {
          const held = await spawnHeld(harness, 'afterCapture');
          url = mockHost.routes[0];
          delegationId = held.delegationId;
          finishPreparation = (): Promise<unknown> => {
            held.open();
            return held.spawned.catch(() => undefined);
          };
        }
        if (!url) throw new Error('Expected a route');
        expect(await request(url)).toBe(200);
        const closing = loaded?.lifecycle.closeDelegationScope(target);
        await settle();

        expect(await request(url)).toBe(404);

        await finishPreparation?.();
        await closing;
        await waitUntil(
          () => persisted(delegationId).status === 'cancelled',
          'the closed record',
        );
        expect(persisted(delegationId)).toMatchObject({
          status: 'cancelled',
          stopReason: 'parent_cancelled',
        });
        expect(holdCounts()).toEqual({ retains: 1, releases: 1 });
      },
    );

    it.each(['parent closure', 'shutdown'] as const)(
      'withdraws the route at %s even when the native stop is unconfirmed',
      async (action) => {
        mockHost.ignoreAbort = true;
        mockHost.stopMode = 'unconfirmed';
        const { delegationId, run } = await startRun(harness);
        expect(await request(run.url)).toBe(200);

        const closing =
          action === 'parent closure'
            ? loaded?.lifecycle.closeDelegationScope(target)
            : shutDown();
        await expect(closing).rejects.toThrow();

        expect(await request(run.url)).toBe(404);
        idlePastRouteTtl();
        expect(await request(run.url)).toBe(404);
        expect(liveRoutes()).toBe(0);
        expect(holdCounts()).toEqual({ retains: 1, releases: 1 });
        expect(persisted(delegationId)).toMatchObject({
          status: 'interrupted',
          error: 'launch_uncertain',
        });
      },
      60_000,
    );

    it('withdraws the route when delegation policy turns off', async () => {
      reloadService = true;
      const { delegationId, run } = await startRun(harness);
      holdCommits();
      const revoking = service().updateManagedDelegationPolicy('off');
      await waitUntil(() => mockHost.heldCommits.length > 0, 'a held commit');

      expect(await request(run.url)).toBe(404);

      releaseCommits();
      await revoking;
      await waitUntil(
        () => persisted(delegationId).status === 'cancelled',
        'the revoked record',
      );
      expect(persisted(delegationId)).toMatchObject({
        status: 'cancelled',
        stopReason: 'policy_revoked',
      });
    });

    it('releases each hold once across revocation, a late release and shutdown', async () => {
      const { delegationId, run } = await startRun(harness);
      await service().revokeManagedDelegations(harness);
      await settle();
      expect(await request(run.url)).toBe(404);
      expect(persisted(delegationId)).toMatchObject({
        status: 'cancelled',
        stopReason: 'policy_revoked',
      });

      await service().revokeManagedDelegations(harness);
      await shutDown();

      expect(await request(run.url)).toBe(404);
      expect(holdCounts()).toEqual({ retains: 1, releases: 1 });
      expect(liveRoutes()).toBe(0);
      expect(ttlTimers.size).toBe(0);
    });

    it('withdraws the route at shutdown', async () => {
      const { delegationId, run } = await startRun(harness);
      await shutDown();

      expect(await request(run.url)).toBe(404);
      expect(persisted(delegationId)).toMatchObject({ status: 'cancelled' });
      expect(holdCounts()).toEqual({ retains: 1, releases: 1 });
    });

    it('disposes the held route when preparation is refused after capture', async () => {
      mockHost.refuseAfterCapture = true;
      mockHost.harness = harness;
      const parent = await openParent();
      await parent.spawn('call-1').catch(() => undefined);
      await settle();

      expect(mockHost.routes).toHaveLength(1);
      for (const url of mockHost.routes) expect(await request(url)).toBe(404);
      expect(holdCounts()).toEqual({ retains: 1, releases: 1 });
      expect(ttlTimers.size).toBe(0);
    });

    it.each(['stop first', 'revocation first'] as const)(
      'keeps first-claim attribution for competing stop and revocation (%s)',
      async (order) => {
        const { delegationId, run } = await startRun(harness);
        const nativeStop = gate();
        mockHost.stopGate = nativeStop.promise;
        const stop = (): Promise<unknown> => stopForUser(delegationId);
        const revoke = (): Promise<unknown> =>
          service().revokeManagedDelegations(harness);
        const first = order === 'stop first' ? stop() : revoke();
        await waitUntil(
          () => mockHost.stopReasons.length > 0,
          'the held native stop',
        );
        expect(await request(run.url)).toBe(404);
        const second = order === 'stop first' ? revoke() : stop();
        await settle();
        nativeStop.open();
        await Promise.allSettled([first, second]);
        await waitUntil(
          () => persisted(delegationId).status === 'cancelled',
          'the stopped record',
        );
        expect(persisted(delegationId)).toMatchObject({
          status: 'cancelled',
          stopReason:
            order === 'stop first' ? 'user_cancelled' : 'policy_revoked',
        });
      },
    );
  },
);

describe('a delegate whose local cleanup fails', () => {
  it('logs one sanitized record per attempt through the real service and broker', async () => {
    const leaked = path.join(workDirectory, CLEANUP_CANARY);
    const cleanup = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(
        Object.assign(new Error(`ENOTEMPTY: rmdir '${leaked}'`), {
          code: 'ENOTEMPTY',
          path: leaked,
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error(CLEANUP_CANARY), {
          name: CLEANUP_CANARY,
          code: CLEANUP_CANARY,
        }),
      );
    mockHost.cleanup = cleanup;
    mockLogMainProcessWarn.mockClear();
    // The broker's real UUID passes the record's identity check.
    const { delegationId, run } = await startRun('claude');

    run.finish({ status: 'completed', finalText: 'done' });
    await waitUntil(
      () => persisted(delegationId).status === 'failed',
      'the cleanup failure',
    );
    await waitUntil(() => cleanup.mock.calls.length === 2, 'the broker close');
    await settle();
    await shutDown();

    // The broker forgets the run after one failed close and never retries it.
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(persisted(delegationId)).toMatchObject({
      status: 'failed',
      error: 'launch_uncertain',
    });
    const native = (
      name: string,
      code: string,
    ): ReturnType<typeof failure>[] => [
      failure(CLEANUP_RESOURCES.native, 'rejected', errorFields(name, code)),
    ];
    expect(cleanupRecords(mockLogMainProcessWarn)).toEqual([
      cleanupRecord({ delegationId, failures: native('Error', 'ENOTEMPTY') }),
      cleanupRecord({
        delegationId,
        attempt: 2,
        failures: native('other', 'other'),
      }),
    ]);
  });
});

describe('routes the delegate does not hold', () => {
  it.each(['claude', 'codex'] as const)(
    'keep their normal expiry for AI Credits on %s',
    async (harness) => {
      mockHost.billing = 'ai-credits';
      const { run } = await startRun(harness);
      expect(mockHost.retains).toBe(0);
      expect(ttlTimers.size).toBe(1);
      expect(await request(run.url)).toBe(200);

      idlePastRouteTtl();

      expect(await request(run.url)).toBe(404);
    },
  );

  it.each(['claude', 'codex'] as const)(
    'keep their normal expiry under the E2E model mock on %s',
    async (harness) => {
      mockHost.e2eMock = true;
      const { run } = await startRun(harness);
      expect(mockHost.retains).toBe(0);
      expect(ttlTimers.size).toBe(1);

      idlePastRouteTtl();

      expect(await request(run.url)).toBe(404);
    },
  );
});

describe('a revocation while routing is still in progress', () => {
  it('refuses the spawn as before when the provider generation changes before the hold', async () => {
    mockHost.harness = 'claude';
    let invalidating: Promise<void> | undefined;
    mockHost.onRouted = (): void => {
      mockHost.onRouted = undefined;
      mockHost.authGenerations.set('claude', 1);
      invalidating = loaded?.lifecycle.revokeDelegationLifecycle('claude');
    };
    const parent = await openParent();
    const delegationId = await parent.spawn('call-1');
    await invalidating;
    await waitUntil(
      () => persisted(delegationId).status !== 'pending',
      'the refused preparation',
    );

    const [url] = mockHost.routes;
    if (!url) throw new Error('Expected a captured route');
    expect(await request(url)).toBe(404);
    expect(mockHost.retains).toBe(mockHost.releases);
    expect(ttlTimers.size).toBe(0);
    expect(persisted(delegationId)).toMatchObject({
      status: 'failed',
      error: 'route_unavailable',
    });
  });

  it('cancels the spawn as before when the harness is revoked before the hold', async () => {
    mockHost.harness = 'claude';
    let revoking: Promise<void> | undefined;
    mockHost.onRouted = (): void => {
      mockHost.onRouted = undefined;
      revoking = service().revokeManagedDelegations('claude');
    };
    const parent = await openParent();
    const delegationId = await parent.spawn('call-1');
    await revoking;
    await waitUntil(
      () => persisted(delegationId).status !== 'pending',
      'the refused preparation',
    );

    const [url] = mockHost.routes;
    if (!url) throw new Error('Expected a captured route');
    expect(await request(url)).toBe(404);
    expect(mockHost.retains).toBe(mockHost.releases);
    expect(ttlTimers.size).toBe(0);
    expect(persisted(delegationId)).toMatchObject({
      status: 'cancelled',
      stopReason: 'policy_revoked',
    });
  });
});

describe('a provider generation change before revocation reaches delegation', () => {
  it.each([
    ['during routing', 'onRouted'],
    ['after the hold', 'onRetain'],
  ] as const)(
    'drops the route at capture when it lands %s',
    async (_when, hook) => {
      mockHost.harness = 'claude';
      const after = gate();
      mockHost.afterCapture = after.promise;
      mockHost[hook] = (): void => {
        mockHost[hook] = undefined;
        mockHost.authGenerations.set('claude', 1);
      };
      const parent = await openParent();
      const delegationId = await parent.spawn('call-1');
      await waitUntil(() => mockHost.captured > 0, 'the capture');

      const [url] = mockHost.routes;
      if (!url) throw new Error('Expected a captured route');
      expect(await request(url)).toBe(404);
      expect(mockHost.retains).toBe(mockHost.releases);
      expect(ttlTimers.size).toBe(0);

      mockHost.afterCapture = undefined;
      after.open();
      await waitUntil(
        () => persisted(delegationId).status !== 'pending',
        'the refused preparation',
      );
      expect(persisted(delegationId)).toMatchObject({
        status: 'failed',
        error: 'route_unavailable',
      });
    },
  );
});

describe('a hold taken while routing is still in progress', () => {
  it('is dropped when the provider generation changes after the hold', async () => {
    mockHost.harness = 'claude';
    let invalidating: Promise<void> | undefined;
    mockHost.onRetain = (): void => {
      mockHost.onRetain = undefined;
      // What a provider sign-out does to delegation: a new generation, then revocation.
      mockHost.authGenerations.set('claude', 1);
      invalidating = loaded?.lifecycle.revokeDelegationLifecycle('claude');
    };
    const parent = await openParent();
    const delegationId = await parent.spawn('call-1');
    await invalidating;
    await waitUntil(
      () => persisted(delegationId).status !== 'pending',
      'the refused preparation',
    );

    const [url] = mockHost.routes;
    if (!url) throw new Error('Expected a captured route');
    expect(await request(url)).toBe(404);
    expect(holdCounts()).toEqual({ retains: 1, releases: 1 });
    expect(ttlTimers.size).toBe(0);
    expect(persisted(delegationId)).toMatchObject({
      status: 'failed',
      error: 'route_unavailable',
    });
  });

  it('is dropped when the harness is revoked after the hold', async () => {
    mockHost.harness = 'claude';
    let revoking: Promise<void> | undefined;
    mockHost.onRetain = (): void => {
      mockHost.onRetain = undefined;
      revoking = service().revokeManagedDelegations('claude');
    };
    const parent = await openParent();
    const delegationId = await parent.spawn('call-1');
    await revoking;
    await waitUntil(
      () => persisted(delegationId).status !== 'pending',
      'the refused preparation',
    );

    const [url] = mockHost.routes;
    if (!url) throw new Error('Expected a captured route');
    expect(await request(url)).toBe(404);
    expect(holdCounts()).toEqual({ retains: 1, releases: 1 });
    expect(ttlTimers.size).toBe(0);
    expect(persisted(delegationId)).toMatchObject({
      status: 'cancelled',
      stopReason: 'policy_revoked',
    });
  });
});
