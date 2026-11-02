import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  AgentDelegationResult,
  AgentDelegationEvent,
  GetDelegateOutputRequest,
} from '@canopy/protocol/delegation';
import {
  AgentDelegationBroker,
  type StoredDelegation,
} from '@canopy/desktop-shared/node/delegation/broker';
import { AgentRunnerRegistry } from '@canopy/desktop-shared/node/delegation/runner-registry';
import {
  FakeRunner,
  routeFixture,
} from '@canopy/desktop-shared/node/delegation/__tests__/fixtures';
import type { DelegationParentContext } from '@canopy/desktop-shared/node/delegation/types';
import * as hostTools from '@canopy/desktop-shared/node/codex-runtime/host-tools';
import { BRAND } from '@canopy/brand/current';
import { CodexHostToolDispatcher } from '@canopy/desktop-shared/node/codex-runtime/host-tools';
import type { CodexHostToolPolicy } from '@canopy/desktop-shared/node/codex-runtime/thread-handle';
import type { DynamicToolCallResponse } from '@canopy/desktop-shared/node/codex-runtime/generated/v2/DynamicToolCallResponse';
import type { CursorCapabilityProjection } from '@canopy/desktop-shared/lib/cursor-capabilities';
import {
  DelegationParent,
  type DelegationParentBroker,
} from '@canopy/desktop-shared/node/delegation/parent';
import {
  createClaudeChildTools,
  createCodexChildTools,
} from '../agents/delegation/child-tools';
import { createCursorDelegationRunner } from '../agents/delegation/cursor-runner';
import { createCopilotDelegationRunner } from '../agents/delegation/copilot-runner';
import { createOpenCodeDelegationRunner } from '../agents/delegation/opencode-runner';
import { DelegationNativePolicy } from '../agents/delegation/native-policy';
import type { CanopyInjectedToolTextResult } from '../canopy-tools/core';
import type { CanopyWorktreeSessionRoute } from '../mcp/http-proxy-service';
import type {
  CursorTurnGates,
  CursorTurnHost,
  CursorTurnRequest,
  CursorTurnResult,
} from '@canopy/desktop-shared/node/cursor/turn-driver';
import type { CopilotTurnOptions } from '@canopy/desktop-shared/node/copilot/turn-driver';
import type { ManagedOpenCodeRuntime } from '../opencode/connection';
import type {
  OpenCodeTurnHost,
  OpenCodeTurnRequest,
  OpenCodeTurnResult,
} from '@canopy/desktop-shared/node/opencode/turn-driver';
import {
  account as copilotAccount,
  nativeRuntime as createCopilotNativeRuntime,
  request as copilotRequest,
  type FixtureRuntime,
} from './helpers/delegation-runner-fixtures/copilot';
import {
  request as cursorRequest,
  success as cursorSuccess,
} from './helpers/delegation-runner-fixtures/cursor';
import { request as openCodeRequest } from './helpers/delegation-runner-fixtures/opencode';

// Suite-owned; afterAll removes only this directory.
const RUNNER_DIRECTORY = mkdtempSync(
  path.join(tmpdir(), 'canopy-11c2-output-adapter-paging-'),
);
const OUTPUT_TOOL_NAME = 'GetDelegateOutput';
const DELEGATION_ID = '00000000-0000-4000-8000-000000000001';
const CODEX_THREAD_ID = 'native-golden-thread';
const CODEX_TURN_ID = 'native-golden-turn';
const CODEX_LIMIT_BYTES = 65_536;
let callSequence = 0;
interface ClaudeDefinition {
  readonly name: string;
  readonly handler: (
    input: unknown,
    extra?: unknown,
  ) => Promise<{ isError: boolean; content?: { text: string }[] }>;
}

interface MockHttpProxyService {
  registerCanopyWorktreeSessionRoute(
    route: CanopyWorktreeSessionRoute,
  ): Promise<string>;
  unregisterCanopyWorktreeSessionRoute(sessionKey: string): void;
  getCanopyWorktreeMcpUrl(sessionKey: string): string;
  getMcpCapabilityDigests(
    servers: Record<string, unknown>,
  ): Record<string, string>;
}

interface CodexCall {
  readonly params: {
    readonly threadId: string;
    readonly turnId: string;
    readonly callId: string;
    readonly namespace: null;
    readonly tool: string;
    readonly arguments: unknown;
  };
}

const mockClaudeDefinitions: ClaudeDefinition[] = [];
const mockRoutes: CanopyWorktreeSessionRoute[] = [];
const mockRegisterRoute = jest.fn(
  (route: CanopyWorktreeSessionRoute): Promise<string> => {
    mockRoutes.push(route);
    return Promise.resolve(route.sessionKey);
  },
);
const mockCursorTurn = jest.fn<
  Promise<CursorTurnResult>,
  [CursorTurnRequest, CursorTurnHost]
>();
const mockCopilotTurn = jest.fn<
  Promise<{
    sessionId: string;
    text: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
    };
  }>,
  [CopilotTurnOptions]
>();
const mockOpenCodeTurn = jest.fn<
  Promise<OpenCodeTurnResult>,
  [OpenCodeTurnRequest, OpenCodeTurnHost]
>();
const mockCopilotRuntime = jest.fn<Promise<FixtureRuntime>, [unknown]>();
const mockOpenCodeRuntime = jest.fn<
  Promise<ManagedOpenCodeRuntime>,
  [unknown]
>();
const mockCursorRuntime = jest.fn(() =>
  Promise.resolve({
    launch: { command: '/managed/cursor', args: [] },
    env: { PATH: '/usr/bin' },
    target: { hookRuntime: 'node' },
  }),
);
const mockUnregisterRoute = jest.fn();

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (configuration: unknown): unknown => configuration,
  tool: (
    name: string,
    _description: string,
    _schema: unknown,
    handler: ClaudeDefinition['handler'],
  ): ClaudeDefinition => {
    const definition = { name, handler };
    mockClaudeDefinitions.push(definition);
    return definition;
  },
}));

jest.mock('@canopy/desktop-shared/node/cursor/turn-driver', () => ({
  runCursorTurn: (
    request: CursorTurnRequest,
    host: CursorTurnHost,
  ): Promise<CursorTurnResult> => mockCursorTurn(request, host),
}));
jest.mock('../cursor/connection', () => ({
  getManagedCursorRuntime: (): ReturnType<typeof mockCursorRuntime> =>
    mockCursorRuntime(),
}));
jest.mock('../cursor/approval-check', () => ({
  verifyCursorVersion: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../cursor/mcp-servers', () => ({
  buildCursorMcpServers: (): Promise<{
    servers: [];
    notes: [];
    warnings: [];
  }> => Promise.resolve({ servers: [], notes: [], warnings: [] }),
}));
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: (): MockHttpProxyService => ({
    registerCanopyWorktreeSessionRoute: (
      route: CanopyWorktreeSessionRoute,
    ): Promise<string> => mockRegisterRoute(route),
    unregisterCanopyWorktreeSessionRoute: (): void => {
      mockUnregisterRoute();
    },
    getCanopyWorktreeMcpUrl: (): string => 'http://localhost/golden',
    getMcpCapabilityDigests: (): Record<string, string> => ({}),
  }),
}));
jest.mock('../plugins/plugin-resolver', () => ({
  buildCursorCapabilityProjection: (): CursorCapabilityProjection => ({
    skills: [],
    commands: [],
  }),
}));
jest.mock('@canopy/desktop-shared/node/cursor/capability-root', () => ({
  materializeCursorCapabilityRoot: (): Promise<{
    warnings: string[];
    skillIds: string[];
    commandIds: string[];
  }> => Promise.resolve({ warnings: [], skillIds: [], commandIds: [] }),
  materializeSelectedCapabilityRoot: (): Promise<{
    warnings: string[];
    skillIds: string[];
    commandIds: string[];
  }> => Promise.resolve({ warnings: [], skillIds: [], commandIds: [] }),
}));
jest.mock('@canopy/desktop-shared/node/capabilities/file-snapshot', () => ({
  capabilityFiles: (): Promise<[]> => Promise.resolve([]),
  capabilityInstructionIdentity: (): string => '',
}));
jest.mock('../agents/delegation/canopy-tools', () => ({
  delegateAppToolGuidance: (): string => '',
}));
jest.mock('../copilot/connection', () => ({
  openManagedCopilotRuntime: (options: unknown): Promise<FixtureRuntime> =>
    mockCopilotRuntime(options),
  assertCopilotConnectionGeneration: (): void => undefined,
}));
jest.mock('@canopy/desktop-shared/node/copilot/turn-driver', () => ({
  runCopilotTurn: (
    options: CopilotTurnOptions,
  ): ReturnType<typeof mockCopilotTurn> => mockCopilotTurn(options),
}));
jest.mock('../opencode/connection', () => ({
  openManagedOpenCodeRuntime: (
    options: unknown,
  ): Promise<ManagedOpenCodeRuntime> => mockOpenCodeRuntime(options),
  assertOpenCodeConnectionGeneration: (): void => undefined,
  // The runtime checks the requested model before the turn starts.
  assertOpenCodeModelAvailable: (
    model: string | undefined,
  ): Promise<{ id: string; label: string }> =>
    Promise.resolve({ id: model ?? 'opencode-model', label: 'OpenCode' }),
}));
jest.mock('../opencode/capability-snapshot', () => ({
  snapshotOpenCodeMcpTools: (): Promise<[]> => Promise.resolve([]),
}));
jest.mock('../opencode/mcp-servers', () => ({
  buildOpenCodeMcpServers: (): [] => [],
  resolveOpenCodeMcpCall: (): undefined => undefined,
}));
jest.mock('../agents/delegation/opencode-policy', () => ({
  openCodeDelegationPolicyIdentity: (): Promise<unknown> => Promise.resolve({}),
}));
jest.mock('@canopy/desktop-shared/node/opencode/turn-driver', () => ({
  runOpenCodeTurn: (
    request: OpenCodeTurnRequest,
    host: OpenCodeTurnHost,
  ): Promise<OpenCodeTurnResult> => mockOpenCodeTurn(request, host),
}));

interface ClaudeGolden {
  readonly deliveryText: string;
  readonly isError: boolean;
  readonly serializedDelivery: string;
}

interface CodexGolden {
  readonly deliveryText: string;
  readonly success: boolean;
  readonly serializedDelivery: string;
}

interface TextErrorGolden {
  readonly deliveryText: string;
  readonly isError: boolean;
  readonly serializedDelivery: string;
}

interface CopilotGolden {
  readonly deliveryText: string;
  readonly resultType: string;
  readonly serializedDelivery: string;
}

function createParent(
  harness: 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode',
  broker: DelegationParentBroker,
): DelegationParent {
  return new DelegationParent({
    owner: {
      harnessId: harness,
      projectId: 'golden-project',
      worktreeId: 'golden-worktree',
      chatId: 'golden-chat',
      sessionKey: 'golden-session',
      runtimeGeneration: 1,
      depth: 0,
    },
    harness,
    namespace: BRAND.tools.namespace,
    names: {
      spawn: 'DelegateTask',
      output: OUTPUT_TOOL_NAME,
      inspect: 'InspectDelegate',
      list: 'ListDelegates',
      stop: 'StopDelegate',
      manageWorktree: 'ManageDelegateWorktree',
      message: 'MessageDelegate',
      requestSteering: 'RequestSteering',
    },
    broker,
    currentTurn: () => CODEX_TURN_ID,
    removeQueued: () => Promise.resolve(),
    reportError: () => undefined,
    responseBudgetMs: 30_000,
    enableDelegationTools: true,
  });
}

function nativePolicy(signal: AbortSignal): DelegationNativePolicy {
  return new DelegationNativePolicy({
    cwd: '/golden/worktree',
    writePaths: [],
    mcpServerNames: [],
    signal,
    delegationId: DELEGATION_ID,
    mode: () => 'full-access',
    allowed: () => Promise.resolve(true),
    approval: {
      check: jest.fn(
        (): Promise<{ decision: 'allow' }> =>
          Promise.resolve({ decision: 'allow' }),
      ),
      setMode: jest.fn(),
      reevaluatePendingApprovals: (): Promise<void> => Promise.resolve(),
      dispose: jest.fn(),
    },
    emit: (): Promise<void> => Promise.resolve(),
  });
}

function outputToolDefinition(): ClaudeDefinition {
  const definition = mockClaudeDefinitions.find(
    (candidate) => candidate.name === OUTPUT_TOOL_NAME,
  );
  if (!definition) throw new Error('Claude output tool was not registered');
  return definition;
}

function codexPolicy(parent: DelegationParent): CodexHostToolPolicy {
  return createCodexChildTools(parent, CODEX_THREAD_ID).policy;
}

function codexDispatcher(policy: CodexHostToolPolicy): CodexHostToolDispatcher {
  return new CodexHostToolDispatcher(
    CODEX_THREAD_ID,
    () => CODEX_TURN_ID,
    policy,
    new AbortController().signal,
  );
}

function codexCall(scenario: string, request: unknown): CodexCall {
  return {
    params: {
      threadId: CODEX_THREAD_ID,
      turnId: CODEX_TURN_ID,
      callId: `call-${scenario}`,
      namespace: null,
      tool: OUTPUT_TOOL_NAME,
      arguments: request,
    },
  };
}

async function claudeDelivery(
  parent: DelegationParent,
  request: unknown,
): Promise<ClaudeGolden> {
  mockClaudeDefinitions.length = 0;
  createClaudeChildTools(parent);
  const definition = outputToolDefinition();
  const bound = parent.bindClaude(
    OUTPUT_TOOL_NAME,
    request,
    `claude-call-${++callSequence}`,
  );
  if (!bound.ok) throw new Error('Could not bind Claude golden call');
  const response = await definition.handler(bound.value);
  const deliveryText = response.content?.[0]?.text;
  if (deliveryText === undefined)
    throw new Error('Claude output adapter returned no serialized content');
  return {
    deliveryText,
    isError: response.isError,
    serializedDelivery: JSON.stringify(response),
  };
}

async function codexDelivery(
  parent: DelegationParent,
  scenario: string,
  request: unknown,
): Promise<CodexGolden> {
  const response = await codexDispatcher(codexPolicy(parent)).run(
    codexCall(scenario, request),
  );
  const item = response.contentItems[0];
  if (!item || item.type !== 'inputText')
    throw new Error('Codex output adapter returned no text item');
  return {
    deliveryText: item.text,
    success: response.success,
    serializedDelivery: JSON.stringify(response),
  };
}

function lastRoute(
  providerType: 'cursor' | 'opencode',
): CanopyWorktreeSessionRoute | undefined {
  for (let index = mockRoutes.length - 1; index >= 0; index--) {
    const route = mockRoutes[index];
    if (route?.providerType === providerType) return route;
  }
  return undefined;
}

function cursorGates(signal: AbortSignal): CursorTurnGates {
  return {
    consumeAllowance: () => true,
    recordGateDecision: () => undefined,
    appToolCallIdentity: (_key, args) => JSON.stringify(args) ?? '',
    pluginCallIdentity: (server, tool, args) =>
      JSON.stringify([server, tool, args]) ?? '',
    abort: () => undefined,
    signal,
  };
}

async function cursorDelivery(
  parent: DelegationParent,
  scenario: string,
  request: unknown,
): Promise<TextErrorGolden> {
  mockRoutes.length = 0;
  mockCursorTurn.mockReset();
  const signal = new AbortController().signal;
  const policy = nativePolicy(signal);
  let delivery: CanopyInjectedToolTextResult | undefined;
  mockCursorTurn.mockImplementation(async (_turnRequest, host) => {
    await host.prepareMcp({ http: true }, cursorGates(signal));
    const route = lastRoute('cursor');
    const managed = route?.managedDelegation;
    if (!managed) throw new Error('Cursor delegation route was not registered');
    delivery = await managed.invoke(OUTPUT_TOOL_NAME, request, {
      requestId: `cursor-${scenario}`,
    });
    return cursorSuccess;
  });
  const runner = createCursorDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'golden-cursor',
        profileDir: path.join(RUNNER_DIRECTORY, 'cursor'),
        tools: policy,
        plugins: [],
        mcpServers: {},
        bindMcpGates: () => undefined,
      }),
    delegation: () => parent,
    reportError: () => undefined,
  });
  const runRequest = cursorRequest({ cwd: '/golden/worktree', signal });
  let finish: () => void = () => undefined;
  const terminal = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const handle = await runner.start(runRequest, ({ event }) => {
    if (event.type === 'terminal') finish();
    return Promise.resolve();
  });
  await terminal;
  await runner.close(handle);
  if (!delivery) throw new Error('Cursor adapter did not deliver output');
  return {
    deliveryText: delivery.text,
    isError: delivery.isError ?? false,
    serializedDelivery: JSON.stringify(delivery),
  };
}

async function copilotDelivery(
  parent: DelegationParent,
  scenario: string,
  request: unknown,
): Promise<CopilotGolden> {
  mockCopilotTurn.mockReset();
  const signal = new AbortController().signal;
  const policy = nativePolicy(signal);
  const runtimeFixture = createCopilotNativeRuntime({
    account: copilotAccount,
  });
  mockCopilotRuntime.mockReset();
  mockCopilotRuntime.mockResolvedValue(runtimeFixture.runtime);
  let delivery: unknown;
  mockCopilotTurn.mockImplementation(async (options) => {
    const tool = options.tools?.find(
      (candidate) => candidate.name === OUTPUT_TOOL_NAME,
    );
    if (!tool?.handler)
      throw new Error('Copilot output tool was not registered');
    await options.onToolsReady?.(
      {
        version: 1,
        digest:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      [],
    );
    await options.onSession?.('native-golden');
    delivery = await tool.handler(request, {
      sessionId: 'native-golden',
      toolCallId: `copilot-${scenario}`,
      toolName: OUTPUT_TOOL_NAME,
      arguments: request,
      signal,
    });
    return {
      sessionId: 'native-golden',
      text: 'Provider turn complete.',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
  });
  const runner = createCopilotDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'golden-copilot',
        profileDir: path.join(RUNNER_DIRECTORY, 'copilot'),
        tools: policy,
        plugins: [],
        retainedReadRoots: [],
        mcpServers: {},
      }),
    delegation: () => parent,
    reportError: () => undefined,
  });
  const runRequest = copilotRequest({
    cwd: '/golden/worktree',
    signal,
    account: copilotAccount,
  });
  let finish: () => void = () => undefined;
  const terminal = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const handle = await runner.start(runRequest, ({ event }) => {
    if (event.type === 'terminal') finish();
    return Promise.resolve();
  });
  await terminal;
  await runner.close(handle);
  if (!isRecord(delivery))
    throw new Error('Copilot adapter did not return a result object');
  if (
    typeof delivery.textResultForLlm !== 'string' ||
    typeof delivery.resultType !== 'string'
  )
    throw new Error('Copilot adapter returned an invalid result object');
  return {
    deliveryText: delivery.textResultForLlm,
    resultType: delivery.resultType,
    serializedDelivery: JSON.stringify(delivery),
  };
}

async function openCodeDelivery(
  parent: DelegationParent,
  scenario: string,
  request: unknown,
): Promise<TextErrorGolden> {
  mockRoutes.length = 0;
  mockOpenCodeTurn.mockReset();
  const signal = new AbortController().signal;
  const policy = nativePolicy(signal);
  let delivery: CanopyInjectedToolTextResult | undefined;
  mockOpenCodeTurn.mockImplementation(async () => {
    const route = lastRoute('opencode');
    const managed = route?.managedDelegation;
    if (!managed)
      throw new Error('OpenCode delegation route was not registered');
    delivery = await managed.invoke(OUTPUT_TOOL_NAME, request, {
      requestId: `opencode-${scenario}`,
    });
    return {
      sessionId: 'native-golden',
      responseText: 'Provider turn complete.',
      isError: false,
      cancelled: false,
      message: '',
    };
  });
  mockOpenCodeRuntime.mockReset();
  mockOpenCodeRuntime.mockResolvedValue({
    runtimeIdentity: { version: 'golden', platform: 'test' },
    executable: '/usr/bin/node',
    env: { PATH: '/usr/bin' },
    providerConfig: {},
    generation: 1,
    signal,
    close: () => Promise.resolve(),
  });
  const runner = createOpenCodeDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'golden-opencode',
        profileDir: path.join(RUNNER_DIRECTORY, 'opencode'),
        tools: policy,
        plugins: [],
        mcpServers: {},
      }),
    delegation: () => parent,
    reportError: () => undefined,
  });
  const runRequest = openCodeRequest({ cwd: '/golden/worktree', signal });
  let finish: () => void = () => undefined;
  const terminal = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const handle = await runner.start(runRequest, ({ event }) => {
    if (event.type === 'terminal') finish();
    return Promise.resolve();
  });
  await terminal;
  await runner.close(handle);
  if (!delivery) throw new Error('OpenCode adapter did not deliver output');
  return {
    deliveryText: delivery.text,
    isError: delivery.isError ?? false,
    serializedDelivery: JSON.stringify(delivery),
  };
}

// Provider runtimes and route registration are faked; every adapter, projection,
// broker read, byte-range helper and Codex dispatcher below is production code.
type Harness = 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode';
const HARNESSES: Harness[] = [
  'claude',
  'codex',
  'cursor',
  'copilot',
  'opencode',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function fixture(
  harness: Harness,
  body: {
    finalText?: string;
    partialText?: string;
    error?: { code: 'runtime_error'; message: string; retryable: false };
  },
): Promise<{
  broker: AgentDelegationBroker;
  parent: DelegationParent;
  context: DelegationParentContext;
  id: string;
}> {
  const runner = new FakeRunner('local-sdk');
  const registry = new AgentRunnerRegistry();
  registry.register({
    apiVersion: 1,
    registrationId: 'third-local',
    adapter: runner,
  });
  const broker = new AgentDelegationBroker({
    registry,
    capacity: 2,
    cwd: '/golden/worktree',
    storage: {
      load: (): Promise<readonly StoredDelegation[]> => Promise.resolve([]),
      commit: (): Promise<void> => Promise.resolve(),
    },
    resolveRoute: (): Promise<
      AgentDelegationResult<ReturnType<typeof routeFixture>>
    > => Promise.resolve({ ok: true, value: routeFixture() }),
    authorize: (): Promise<AgentDelegationResult<undefined>> =>
      Promise.resolve({ ok: true, value: undefined }),
  });
  await broker.initialize();
  const parent = createParent(harness, broker);
  const context = parent.context(CODEX_TURN_ID, 'fixture-spawn');
  if (!context) throw new Error('Missing fixture parent context');
  const spawned = await broker.spawn(context, {
    modelId: 'logical-review-model',
    description: 'Adapter evidence',
    prompt: 'Read fixed output.',
    executionMode: 'background',
    contextPolicy: 'task_only',
    isolation: 'shared_worktree',
  });
  if (!spawned.ok) throw new Error(spawned.error.message);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const id = spawned.value.delegationId;
  const sink = runner.sinks.get(id);
  if (!sink) throw new Error('Missing fixture event sink');
  let sequence = 0;
  const emit = (event: AgentDelegationEvent['event']): Promise<void> =>
    sink({
      delegationId: id,
      runGeneration: 1,
      sequence: ++sequence,
      occurredAt: sequence * 10,
      event,
    });
  await emit({ type: 'started', nativeSessionId: 'native-paging' });
  if (body.partialText !== undefined)
    await emit({ type: 'progress', text: body.partialText });
  await emit({
    type: 'terminal',
    status: body.error ? 'failed' : 'completed',
    ...(body.finalText === undefined ? {} : { finalText: body.finalText }),
    ...(body.error === undefined ? {} : { error: body.error }),
  });
  return { broker, parent, context, id };
}

async function delivery(
  harness: Harness,
  parent: DelegationParent,
  request: unknown,
  ok = true,
): Promise<{ deliveryText: string; serializedDelivery: string }> {
  const scenario = `paging-${++callSequence}`;
  switch (harness) {
    case 'claude': {
      const reply = await claudeDelivery(parent, request);
      expect(reply.isError).toBe(!ok);
      expect(reply.serializedDelivery).toBe(
        JSON.stringify({
          content: [{ type: 'text', text: reply.deliveryText }],
          isError: !ok,
        }),
      );
      return reply;
    }
    case 'codex': {
      const reply = await codexDelivery(parent, scenario, request);
      expect(reply.success).toBe(ok);
      expect(reply.serializedDelivery).toBe(
        JSON.stringify({
          success: ok,
          contentItems: [{ type: 'inputText', text: reply.deliveryText }],
        }),
      );
      expect(
        Buffer.byteLength(reply.serializedDelivery, 'utf8'),
      ).toBeLessThanOrEqual(CODEX_LIMIT_BYTES);
      return reply;
    }
    case 'cursor': {
      const reply = await cursorDelivery(parent, scenario, request);
      expect(reply.isError).toBe(!ok);
      expect(reply.serializedDelivery).toBe(
        JSON.stringify({ text: reply.deliveryText, isError: !ok }),
      );
      return reply;
    }
    case 'copilot': {
      const reply = await copilotDelivery(parent, scenario, request);
      expect(reply.resultType).toBe(ok ? 'success' : 'failure');
      expect(reply.serializedDelivery).toBe(
        JSON.stringify({
          textResultForLlm: reply.deliveryText,
          resultType: ok ? 'success' : 'failure',
        }),
      );
      return reply;
    }
    case 'opencode': {
      const reply = await openCodeDelivery(parent, scenario, request);
      expect(reply.isError).toBe(!ok);
      expect(reply.serializedDelivery).toBe(
        JSON.stringify({ text: reply.deliveryText, isError: !ok }),
      );
      return reply;
    }
  }
}

function deliveredResult(text: string): Record<string, unknown> {
  const reply: unknown = JSON.parse(text);
  if (
    !isRecord(reply) ||
    reply.ok !== true ||
    !isRecord(reply.value) ||
    !isRecord(reply.value.result)
  )
    throw new Error('Missing delivered result');
  return reply.value.result;
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
  mockClaudeDefinitions.length = 0;
  mockRoutes.length = 0;
  mockCursorTurn.mockReset();
  mockCopilotTurn.mockReset();
  mockOpenCodeTurn.mockReset();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => rmSync(RUNNER_DIRECTORY, { recursive: true, force: true }));

const RANGE_CASES = [
  {
    name: 'UTF-8 final',
    body: { finalText: 'a😀bc' },
    answer: {
      role: 'final',
      text: 'a😀',
      encoding: 'utf8',
      byteLength: 7,
      offset: 0,
      nextOffset: 5,
    },
  },
  {
    name: 'UTF-16 partial',
    body: { partialText: 'a\uD800😀bc' },
    answer: {
      role: 'partial',
      text: 'a\uD800',
      encoding: 'utf16le',
      byteLength: 12,
      offset: 0,
      nextOffset: 4,
    },
  },
  {
    name: 'empty final wins',
    body: { finalText: '', partialText: 'retained' },
    answer: {
      role: 'final',
      text: '',
      encoding: 'utf8',
      byteLength: 0,
      offset: 0,
    },
  },
  { name: 'absent body', body: {}, answer: undefined },
];

describe.each(HARNESSES)('%s real output adapter', (harness) => {
  it.each(RANGE_CASES)(
    'serializes an explicitly ranged $name with its wrapper flags',
    async ({ body, answer }) => {
      const f = await fixture(harness, body);
      try {
        const request = { delegationId: f.id, offset: 0, limit: 5 };
        const expected = await f.broker.getOutput(f.context, request);
        const reply = await delivery(harness, f.parent, request);
        expect(reply.deliveryText).toBe(JSON.stringify(expected));
        const result = deliveredResult(reply.deliveryText);
        expect(result).not.toHaveProperty('finalText');
        expect(result).not.toHaveProperty('partialText');
        if (answer === undefined) expect(result).not.toHaveProperty('answer');
        else {
          expect(result.answer).toMatchObject(answer);
          if (!('nextOffset' in answer))
            expect(result.answer).not.toHaveProperty('nextOffset');
          else
            expect(result.answer).toHaveProperty(
              'notice',
              'The answer continues. Call Get Delegate Output again with this resultIndex and offset set to nextOffset.',
            );
        }
        if (answer && 'nextOffset' in answer) {
          const continuation = {
            delegationId: f.id,
            resultIndex: 1,
            offset: answer.nextOffset,
            limit: 5,
          };
          // Runner close retires its native parent; a later native session has
          // the same authorized owner and reads the explicitly pinned index.
          const continued = await delivery(
            harness,
            createParent(harness, f.broker),
            continuation,
          );
          expect(continued.deliveryText).toBe(
            JSON.stringify(await f.broker.getOutput(f.context, continuation)),
          );
          expect(deliveredResult(continued.deliveryText).answer).toMatchObject({
            offset: answer.nextOffset,
          });
        }
      } finally {
        await f.broker.close();
      }
    },
  );

  it('preserves failure wrapper flags for an unpinned continuation', async () => {
    const f = await fixture(harness, { finalText: 'abcdef' });
    try {
      const reply = await delivery(
        harness,
        f.parent,
        { delegationId: f.id, offset: 1, limit: 4 },
        false,
      );
      const value: unknown = JSON.parse(reply.deliveryText);
      expect(value).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });
    } finally {
      await f.broker.close();
    }
  });
});

it.each<Harness>(['claude', 'cursor', 'copilot', 'opencode'])(
  '%s still delivers the whole 1 MiB without a range',
  async (harness) => {
    const text = 'x'.repeat(1_048_576);
    const f = await fixture(harness, { finalText: text });
    try {
      const request = { delegationId: f.id };
      const reply = await delivery(harness, f.parent, request);
      expect(reply.deliveryText).toBe(
        JSON.stringify(await f.broker.getOutput(f.context, request)),
      );
      const result = deliveredResult(reply.deliveryText);
      expect(result.finalText).toBe(text);
      expect(result).not.toHaveProperty('answer');
    } finally {
      await f.broker.close();
    }
  },
);

it.each([
  { name: '1 MiB ASCII', finalText: 'x'.repeat(1_048_576) },
  { name: '64 KiB UTF-8 below code-unit cap', finalText: 'é'.repeat(32_768) },
  {
    name: 'empty final beside 1 MiB partial',
    finalText: '',
    partialText: 'p'.repeat(1_048_576),
  },
])(
  'Codex accepts $name and every pinned continuation through the real dispatcher',
  async (body) => {
    const f = await fixture('codex', body);
    try {
      let request: GetDelegateOutputRequest = { delegationId: f.id };
      let joined = '';
      let offset = 0;
      let pages = 0;
      while (true) {
        const reply = await delivery('codex', f.parent, request);
        const result = deliveredResult(reply.deliveryText);
        expect(result).not.toHaveProperty('finalText');
        expect(result).not.toHaveProperty('partialText');
        const answer = result.answer;
        if (!isRecord(answer) || typeof answer.text !== 'string')
          throw new Error('Missing Codex answer page');
        expect(answer).toMatchObject({
          role: 'final',
          encoding: 'utf8',
          byteLength: Buffer.byteLength(body.finalText, 'utf8'),
          offset,
        });
        joined += answer.text;
        expect(++pages).toBeLessThan(40);
        if (answer.nextOffset === undefined) break;
        if (typeof answer.nextOffset !== 'number')
          throw new Error('Invalid nextOffset');
        expect(answer.nextOffset).toBe(
          offset + Buffer.byteLength(answer.text, 'utf8'),
        );
        expect(answer.nextOffset).toBeGreaterThan(offset);
        offset = answer.nextOffset;
        request = { delegationId: f.id, resultIndex: 1, offset };
      }
      expect(joined).toBe(body.finalText);
      if (body.finalText.length === 0) expect(pages).toBe(1);
      else expect(pages).toBeGreaterThan(1);
    } finally {
      await f.broker.close();
    }
  },
);

it.each([
  { name: 'fitting', text: 'Small unchanged reply.' },
  { name: 'paged', text: 'x'.repeat(1_048_576) },
])(
  'ties the projection-classified $name envelope byte-for-byte to real Codex execute',
  async ({ text }) => {
    const f = await fixture('codex', { finalText: text });
    try {
      const classify = jest.spyOn(hostTools, 'classifyCodexDynamicToolResult');
      const policy = codexPolicy(f.parent);
      const call = codexCall('tie', { delegationId: f.id });
      const response = await policy.execute(
        { ...call.params, arguments: { delegationId: f.id } },
        new AbortController().signal,
      );
      const classified = classify.mock.calls.map(([candidate]) =>
        JSON.stringify(candidate),
      );
      expect(classified).toContain(JSON.stringify(response));
      if (text.length < CODEX_LIMIT_BYTES)
        expect(classified).toEqual([JSON.stringify(response)]);
      else
        expect(
          deliveredResult(
            response.contentItems[0]?.type === 'inputText'
              ? response.contentItems[0].text
              : '',
          ).answer,
        ).toBeDefined();
      const bounded = await codexDispatcher(policy).run(call);
      expect(bounded.success).toBe(true);
      expect(JSON.stringify(bounded)).toBe(JSON.stringify(response));
    } finally {
      await f.broker.close();
    }
  },
);

it("keeps today's exact denial for metadata-only oversized Codex output", async () => {
  const f = await fixture('codex', {
    error: {
      code: 'runtime_error',
      message: 'm'.repeat(1_048_576),
      retryable: false,
    },
  });
  try {
    const request = { delegationId: f.id };
    const whole = await f.broker.getOutput(f.context, request);
    const raw: DynamicToolCallResponse = {
      success: whole.ok,
      contentItems: [{ type: 'inputText', text: JSON.stringify(whole) }],
    };
    const policy = codexPolicy(f.parent);
    const oldDelivery = await codexDispatcher({
      ...policy,
      execute: (): Promise<DynamicToolCallResponse> => Promise.resolve(raw),
    }).run(codexCall('old-fallback', request));
    const response = await codexDispatcher(policy).run(
      codexCall('fallback', request),
    );
    expect(response).toEqual({
      success: false,
      contentItems: [
        { type: 'inputText', text: 'Invalid or oversized host tool result.' },
      ],
    });
    expect(JSON.stringify(response)).toBe(JSON.stringify(oldDelivery));
  } finally {
    await f.broker.close();
  }
});
