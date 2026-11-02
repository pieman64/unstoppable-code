/** Real provider/session smoke coverage; only SDK query and process stdio are scripted. */
import type { query } from '@anthropic-ai/claude-agent-sdk';
import type * as ApprovalPersistence from '../../lib/approvals-persistence';
import type * as DynamicTools from '../../codex/canopy-dynamic-tools';
import type * as ChildProcess from 'node:child_process';
import type * as Preferences from '../../lib/preferences-store';
import type * as PluginResolver from '../../plugins/plugin-resolver';
import type { PassThrough } from 'node:stream';
import { emptyCursorCapabilityProjection } from '@canopy/desktop-shared/lib/cursor-capabilities';
import type { AgentSession, AgentSessionOptions } from '../../agents/types';
import type {
  PipelineProvider,
  PipelineTraceEvent,
  PipelineTraceInput,
  PipelineTraceRecorder,
  ProviderTraceEvent,
  ScriptedProviderDriver,
  LifecycleFixture,
  LifecycleFrame,
} from './contracts';
import {
  claudeSdkModuleMock,
  createScriptedClaude,
  holdNextScriptedClaudeInterruptReceipt,
  rejectNextScriptedClaudeInterrupt,
} from './scripted-claude';
import {
  createScriptedCodex,
  codexSpawnModuleMock,
  configureScriptedCodexBackgroundTerminals,
  emitScriptedCodexCommand,
  exitScriptedCodexUnexpectedly,
  type ScriptedCodexSpawnProcessLike,
} from './scripted-codex';

jest.setTimeout(15_000);

const mockToolHandler = jest.fn<
  ReturnType<typeof DynamicTools.handleCanopyDynamicToolCall>,
  Parameters<typeof DynamicTools.handleCanopyDynamicToolCall>
>();

jest.mock('../../codex/canopy-dynamic-tools', () => ({
  ...jest.requireActual<typeof DynamicTools>(
    '../../codex/canopy-dynamic-tools',
  ),
  handleCanopyDynamicToolCall: (
    ...args: Parameters<typeof DynamicTools.handleCanopyDynamicToolCall>
  ): ReturnType<typeof DynamicTools.handleCanopyDynamicToolCall> =>
    mockToolHandler(...args),
}));

let mockClaude: ReturnType<typeof createScriptedClaude>;
let mockCodex: ReturnType<typeof createScriptedCodex>;
let additionalCodexDrivers: Array<ReturnType<typeof createScriptedCodex>>;

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (
    options: Parameters<typeof query>[0],
  ): ReturnType<ReturnType<typeof claudeSdkModuleMock>['query']> =>
    claudeSdkModuleMock(mockClaude).query(options),
}));
jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof ChildProcess>('node:child_process'),
  spawn: (
    ...args: Parameters<ReturnType<typeof codexSpawnModuleMock>['spawn']>
  ): ReturnType<ReturnType<typeof codexSpawnModuleMock>['spawn']> =>
    codexSpawnModuleMock(mockCodex).spawn(...args),
}));
// Host adapters: no binary lookup, environment injection, sockets, cloud or credentials.
jest.mock('../../pipelines/config-paths', () => ({
  getBundledClaudeBinaryPath: (): string => '/scripted/claude',
  getBundledRtkBinaryPath: (): null => null,
  getBundledRgBinaryPath: (): null => null,
  getEnhancedEnv: (): NodeJS.ProcessEnv => ({}),
  getRtkManagedEnv: (): Record<string, string> => ({}),
}));
jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => ({
  getBundledCodexBinaryPath: (): string => '/scripted/codex',
  getEnhancedEnv: (): NodeJS.ProcessEnv => ({}),
}));
jest.mock('../../auth/provider-auth-state', () => ({
  isProviderNativelyAuthenticated: (): Promise<boolean> =>
    Promise.resolve(true),
  isProviderNativelyAuthenticatedForRouting: (): Promise<boolean> =>
    Promise.resolve(true),
  peekProviderNativeAuthAvailability: (): string => 'available',
}));
jest.mock('../../agents/ai-credits-routing', () => ({
  resolveGatewayModelEntry: (): undefined => undefined,
  isAiCreditsChosenOverAccountProxy: (): boolean => false,
  emitAiCreditsRoutingStatus: (): void => {},
  resolveAiCreditsRoutingAttempt: (): Promise<null> => Promise.resolve(null),
  resolveSessionAiCreditsAttribution: (): Promise<object> =>
    Promise.resolve({}),
}));
jest.mock('../../agents/work-owner', () => ({
  captureSessionWorkOwner: (): void => {},
  resolveSessionWorkOwner: (): Promise<{ kind: 'personal' }> =>
    Promise.resolve({ kind: 'personal' }),
  resolveEnforcementOwner: (): undefined => undefined,
  peekSessionWorkOwner: (): undefined => undefined,
}));
jest.mock('../../lib/user-environment-runtime', () => ({
  resolveCodexRuntimeEnvironmentProfile: (): {
    environment: Record<string, string>;
    logicalWorkspaceEnvironmentId: string;
  } => ({
    environment: {},
    logicalWorkspaceEnvironmentId: 'scripted-environment',
  }),
}));
jest.mock('../../codex/fork-thread', () => ({
  waitForPendingCodexFork: (): Promise<undefined> => Promise.resolve(undefined),
}));
jest.mock('../../codex/transcript-seed', () => ({
  loadCodexForkContinuation: (): Promise<undefined> =>
    Promise.resolve(undefined),
  loadPersistedCodexFallbackSeedItems: (): Promise<[]> => Promise.resolve([]),
}));
jest.mock('../../lib/model-gateway-state', () => ({
  checkModelGatewayRoute: (): Promise<{ ok: true; orgRoute: false }> =>
    Promise.resolve({ ok: true, orgRoute: false }),
}));
jest.mock('../../lib/approvals-persistence', () => ({
  ...jest.requireActual<typeof ApprovalPersistence>(
    '../../lib/approvals-persistence',
  ),
  readWorkspaceApprovalsResult:
    (): Promise<ApprovalPersistence.WorkspaceApprovalsReadResult> =>
      Promise.resolve({ status: 'missing', file: { version: 1, rules: [] } }),
}));
jest.mock('../../lib/workspace-approvals-manifest', () => ({
  readWorkspaceApprovalsManifest: (): Promise<{ rules: [] }> =>
    Promise.resolve({ rules: [] }),
}));
jest.mock('../../lib/preferences-store', () => {
  const actual = jest.requireActual<typeof Preferences>(
    '../../lib/preferences-store',
  );
  return {
    ...actual,
    readPreferencesFile: (): Promise<typeof actual.DEFAULT_PREFERENCES> =>
      Promise.resolve(actual.DEFAULT_PREFERENCES),
    peekPreferencesLoadError: (): null => null,
    readLocalMemoryEnabledPreference: (): Promise<boolean> =>
      Promise.resolve(false),
    readLatestPreferencesFile: (): Promise<typeof actual.DEFAULT_PREFERENCES> =>
      Promise.resolve(actual.DEFAULT_PREFERENCES),
  };
});
jest.mock('../../plugins/plugin-resolver', () => ({
  resolvePlugins: (): Promise<PluginResolver.ResolvedPlugins> =>
    Promise.resolve({
      sdkPlugins: [],
      skillPluginDir: null,
      selectedCapabilityRoots: [],
      mcpServerBindings: {},
      cursorNotices: [],
      cursorCapabilities: emptyCursorCapabilityProjection(),
      codexMcpServers: {},
      mcpServers: {},
      warnings: [],
    }),
  resolveEffectivePluginSelectionRefs: (): Promise<[]> => Promise.resolve([]),
  codexAggregateSkillInvocationNamesForRefs: (): string[] => [],
}));
jest.mock('../../plugins/global-plugin-overlay', () => ({
  resolveEffectiveChatPluginContext: (
    selections: unknown,
  ): Promise<{ selections: unknown }> =>
    Promise.resolve({
      selections: selections ?? {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    }),
}));
jest.mock('../../plugins/invocable-inventory-service', () => ({
  loadCachedInventory: (): Promise<null> => Promise.resolve(null),
}));
jest.mock('../../mcp/http-proxy-service', () => {
  const proxy = {
    registerCanopyWorktreeSessionRoute: (): Promise<string> =>
      Promise.resolve('scripted-token'),
    unregisterCanopyWorktreeSessionRoute: (): void => {},
    unregisterRoutesForSession: (): void => {},
    getCodexCapabilityAuthorityIds: (): string[] => [],
    getCanopyWorktreeMcpUrl: (): string => 'http://scripted.invalid/mcp',
    getCanopyWorktreeUiMcpUrl: (): string => 'http://scripted.invalid/ui',
  };
  return { getMcpHttpProxyService: (): typeof proxy => proxy };
});
// Every observability call is a no-op here, including ones added later.
jest.mock('../../observability', () => ({
  getObservabilityService: (): Record<string, () => void> =>
    new Proxy(
      {},
      {
        get: (_target, property) =>
          property === 'then' ? undefined : (): void => undefined,
      },
    ),
}));
jest.mock('../../services/telemetry-sync-service', () => {
  const service = { flushWorktreeNow: (): Promise<void> => Promise.resolve() };
  return { getTelemetrySyncService: (): typeof service => service };
});
jest.mock('../../lib/resolve-workspace-display-name', () => ({
  resolveWorkspaceRecordingSnapshot: (): Promise<{
    name: string;
    type: string;
  }> => Promise.resolve({ name: 'Scripted', type: 'single-repo' }),
}));
jest.mock('../../lib/code-graph-availability', () => ({
  isCodeGraphAvailableForWorkspace: (): boolean => false,
}));

import { ClaudeCodeProvider } from '../../agents/claude-session';
import { CodexProvider } from '../../agents/codex-session';
import { resetCodexRuntimeServiceForTests } from '../../codex/runtime-service';
import { disposeResourceMonitorService } from '../../resource-monitor';
import {
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';

class Recorder implements PipelineTraceRecorder {
  readonly events: PipelineTraceEvent[] = [];
  record(event: PipelineTraceInput): void {
    this.events.push({
      ...event,
      seq: this.events.length + 1,
      at: performance.now(),
      logicalAt: 0,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function field(event: unknown, key: string): unknown {
  return isRecord(event) ? event[key] : undefined;
}
async function until(
  description: string,
  predicate: () => boolean,
): Promise<void> {
  const deadline = performance.now() + 4000;
  while (!predicate()) {
    if (performance.now() > deadline)
      throw new Error(
        `Timed out waiting for ${description}; events: ${JSON.stringify(events)}`,
      );
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

const target = {
  projectId: 'scripted-project',
  worktreeId: 'scripted-worktree',
  chatId: 'scripted-chat',
};
let recorder: Recorder;
let session: AgentSession | undefined;
let events: unknown[];

beforeAll(() => {
  initClaudeModels([{ id: 'claude-sonnet-4-5', label: 'Scripted Claude' }]);
  initCodexModels([{ id: 'gpt-6-sol', label: 'Scripted Codex' }]);
});
beforeEach(() => {
  recorder = new Recorder();
  events = [];
  additionalCodexDrivers = [];
  mockToolHandler
    .mockReset()
    .mockResolvedValue({ success: true, contentItems: [] });
  mockClaude = createScriptedClaude(recorder, { target });
  mockCodex = createScriptedCodex(recorder, { target });
});
afterEach(async () => {
  for (const driver of additionalCodexDrivers) await driver.dispose();
  additionalCodexDrivers = [];
  await mockClaude.dispose();
  await mockCodex.dispose();
  await session?.destroy();
  session = undefined;
  await resetCodexRuntimeServiceForTests();
  disposeResourceMonitorService();
});
function open(provider: PipelineProvider): ScriptedProviderDriver {
  const options: AgentSessionOptions = {
    ...target,
    cwd: process.cwd(),
    providerType: provider,
    model: provider === 'claude' ? 'claude-sonnet-4-5' : 'gpt-6-sol',
    rtkEnabled: false,
    approvalMode: 'full-access',
  };
  session = (
    provider === 'claude' ? new ClaudeCodeProvider() : new CodexProvider()
  ).createSession(
    options,
    (event) => {
      events.push(event);
    },
    () => null,
  );
  return provider === 'claude' ? mockClaude : mockCodex;
}
function textContaining(text: string): unknown {
  return expect.stringContaining(text);
}
function anyObject(): unknown {
  return expect.any(Object);
}
function objectContaining(value: Record<string, unknown>): unknown {
  return expect.objectContaining(value);
}
function trace(provider: PipelineProvider): ProviderTraceEvent[] {
  return recorder.events.filter(
    (event): event is ProviderTraceEvent =>
      event.kind === 'provider' && event.provider === provider,
  );
}

class JsonRpcFrameReader {
  private buffer = '';
  private readonly frames: string[] = [];
  private readonly waiters: Array<{
    resolve(frame: Record<string, unknown>): void;
    reject(error: Error): void;
  }> = [];

  constructor(stream: PassThrough) {
    stream.on('data', (chunk: Buffer) => this.receive(chunk.toString()));
    stream.on('error', (error: Error) => {
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    });
  }

  next(): Promise<Record<string, unknown>> {
    const frame = this.frames.shift();
    if (frame !== undefined) return Promise.resolve(this.parse(frame));
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const frame = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(this.parse(frame));
      else this.frames.push(frame);
      newline = this.buffer.indexOf('\n');
    }
  }

  private parse(frame: string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(frame);
    if (!isRecord(parsed))
      throw new Error('Scripted Codex wrote a non-object frame');
    return parsed;
  }
}

function rawCodexTransport(): {
  driver: ReturnType<typeof createScriptedCodex>;
  process: ScriptedCodexSpawnProcessLike;
  output: JsonRpcFrameReader;
} {
  const driver = createScriptedCodex(new Recorder(), { target });
  additionalCodexDrivers.push(driver);
  const process = codexSpawnModuleMock(driver).spawn('/scripted/codex', [], {});
  return { driver, process, output: new JsonRpcFrameReader(process.stdout) };
}

function sendClientFrame(
  process: ScriptedCodexSpawnProcessLike,
  frame: Record<string, unknown>,
): void {
  process.stdin.write(`${JSON.stringify(frame)}\n`);
}

async function initializeRawCodexProcess(
  process: ScriptedCodexSpawnProcessLike,
  output: JsonRpcFrameReader,
): Promise<void> {
  sendClientFrame(process, {
    jsonrpc: '2.0',
    id: 'initialize',
    method: 'initialize',
    params: {},
  });
  expect(await output.next()).toMatchObject({ id: 'initialize' });
}

async function startRawCodexThread(
  process: ScriptedCodexSpawnProcessLike,
  output: JsonRpcFrameReader,
  threadId: string,
  method: 'thread/start' | 'thread/resume',
  id: string,
): Promise<Record<string, unknown>> {
  sendClientFrame(process, {
    jsonrpc: '2.0',
    id,
    method,
    params: { threadId },
  });
  const response = await output.next();
  const started = await output.next();
  expect(response).toMatchObject({ id });
  expect(started).toMatchObject({
    method: 'thread/started',
    params: { thread: { id: threadId } },
  });
  return response;
}

async function startRawCodexTurn(
  driver: ReturnType<typeof createScriptedCodex>,
  process: ScriptedCodexSpawnProcessLike,
  output: JsonRpcFrameReader,
  threadId: string,
  id: string,
): Promise<Awaited<ReturnType<typeof driver.nextTurn>>> {
  const waitingForTurn = driver.nextTurn({ timeoutMs: 2000 });
  sendClientFrame(process, {
    jsonrpc: '2.0',
    id,
    method: 'turn/start',
    params: { threadId, input: [{ text: `prompt for ${threadId}` }] },
  });
  expect(await output.next()).toMatchObject({
    id,
    result: { turn: { status: 'inProgress' } },
  });
  expect(await output.next()).toMatchObject({ method: 'turn/started' });
  return waitingForTurn;
}

async function listRawCodexBackgroundTerminals(
  process: ScriptedCodexSpawnProcessLike,
  output: JsonRpcFrameReader,
  threadId: string,
  id: string,
  cursor?: string,
): Promise<Record<string, unknown>> {
  sendClientFrame(process, {
    jsonrpc: '2.0',
    id,
    method: 'thread/backgroundTerminals/list',
    params: { threadId, ...(cursor === undefined ? {} : { cursor }) },
  });
  return output.next();
}

async function nextRawFrameWithin(
  output: JsonRpcFrameReader,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      output.next(),
      new Promise<Record<string, unknown>>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`Timed out after ${timeoutMs}ms for Codex frame`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function codexReplayFixture(): LifecycleFixture {
  return {
    schemaVersion: 1,
    scenario: 'background-terminal-list',
    provider: 'codex',
    tier: 'fast',
    profile: 'scripted',
    provenance: { binaryVersion: 'scripted' },
    semantics: [],
    steps: [],
  };
}

function replayCommandItemFrame(): LifecycleFrame {
  return {
    kind: 'frame',
    lane: 'root',
    type: 'notification:item/started',
    template: 'codex.notification',
    ids: {
      thread: 'terminal-thread',
      turn: 'terminal-turn',
      item: 'terminal-item',
    },
    shape: ['commandExecution', 'inProgress'],
    fields: { command: 'npm test', cwd: '/tmp/fixture-worktree' },
  };
}

function objectField(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

function arrayField(
  value: Record<string, unknown>,
  key: string,
): readonly unknown[] | undefined {
  const nested = value[key];
  return Array.isArray(nested) ? nested : undefined;
}

for (const provider of ['claude', 'codex'] as const) {
  describe(`${provider} scripted raw boundary`, () => {
    it('delivers assistant text and a root result with correlated trace', async () => {
      const driver = open(provider);
      session?.sendMessage('root prompt', { userMessageId: 'root-user' });
      const turn = await driver.nextTurn().catch((error: unknown) => {
        throw new Error(
          `${String(error)}; chat events: ${JSON.stringify(events)}`,
        );
      });
      expect(turn.prompt).toContain('root prompt');
      await turn.emitText('scripted answer');
      await turn.complete();
      await until(
        'assistant and result events',
        () =>
          events.some(
            (event) =>
              field(event, 'type') === 'assistant' ||
              field(event, 'type') === 'codex',
          ) && events.some((event) => field(event, 'type') === 'result'),
      );
      expect(JSON.stringify(events)).toContain('scripted answer');
      expect(trace(provider)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            direction: 'to-provider',
            target,
            text: textContaining('root prompt'),
            turnKey: turn.turnKey,
          }),
          expect.objectContaining({
            direction: 'to-canopy',
            target,
            turnKey: turn.turnKey,
          }),
        ]),
      );
    });
    it.each(['acknowledge', 'refuse'] as const)(
      '%s a steer through the real adapter',
      async (outcome) => {
        const driver = open(provider);
        session?.sendMessage('root');
        const turn = await driver.nextTurn().catch((error: unknown) => {
          throw new Error(
            `${String(error)}; chat events: ${JSON.stringify(events)}`,
          );
        });
        await turn.emitText('before steer');
        await until(
          'steering availability',
          () => session?.getSteeringCapabilities?.().steer === true,
        );
        const submission = session?.submitSteeringInput?.(
          'steer text',
          'steer-attempt',
          'steer-user',
        );
        if (!submission)
          throw new Error('Real provider did not expose steering');
        const steer = await turn.nextSteer();
        expect(steer.text).toContain('steer text');
        await steer[outcome]();
        await expect(submission).resolves.toEqual(
          expect.objectContaining({
            kind: outcome === 'acknowledge' ? 'accepted' : 'rejected',
          }),
        );
        await turn.complete();
        await until('steer terminal event', () =>
          events.some((event) => field(event, 'type') === 'result'),
        );
        if (outcome === 'acknowledge')
          expect(
            events.some(
              (event) => field(event, 'type') === 'canopy_input_delivery',
            ),
          ).toBe(true);
        expect(trace(provider)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              direction: 'to-provider',
              text: textContaining('steer text'),
              turnKey: turn.turnKey,
              ids: anyObject(),
            }),
          ]),
        );
      },
    );
    it('acknowledges a delayed steer and records its receipt', async () => {
      const driver = open(provider);
      session?.sendMessage('late root');
      const turn = await driver.nextTurn();
      await turn.emitText('before late steer');
      await until(
        'late steering availability',
        () => session?.getSteeringCapabilities?.().steer === true,
      );
      const submission = session?.submitSteeringInput?.(
        'late steer',
        'late-attempt',
        'late-user',
      );
      if (!submission) throw new Error('Missing real provider steering');
      const steer = await turn.nextSteer();
      await steer.acknowledgeLate(10);
      await expect(submission).resolves.toEqual(
        expect.objectContaining({ kind: 'accepted' }),
      );
      await turn.complete();
      await until('late delivery event', () =>
        events.some(
          (event) => field(event, 'type') === 'canopy_input_delivery',
        ),
      );
      expect(trace(provider)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            direction: 'to-provider',
            text: textContaining('late steer'),
            ids: anyObject(),
          }),
        ]),
      );
    });
    it('can emit a late steer receipt after the root terminal', async () => {
      const driver = open(provider);
      session?.sendMessage('receipt root');
      const turn = await driver.nextTurn();
      await turn.emitText('receipt prefix');
      await until(
        'receipt steering availability',
        () => session?.getSteeringCapabilities?.().steer === true,
      );
      const submission = session?.submitSteeringInput?.(
        'late receipt',
        'receipt-attempt',
        'receipt-user',
      );
      if (!submission) throw new Error('Missing receipt steering');
      const steer = await turn.nextSteer();
      const receipt = steer.acknowledgeLate(30).then(
        () => undefined,
        (error: unknown) => error,
      );
      await turn.complete();
      expect(await receipt).toBeUndefined();
      await submission;
      await until('receipt root terminal', () =>
        events.some((event) => field(event, 'type') === 'result'),
      );
      const terminalType =
        provider === 'claude'
          ? 'sdk:result:success'
          : 'notification:turn/completed';
      const receiptType =
        provider === 'claude' ? 'sdk:command_lifecycle' : 'response:turn/steer';
      const terminal = trace(provider).find(
        (event) => event.type === terminalType,
      );
      const received = trace(provider).find(
        (event) => event.type === receiptType,
      );
      expect(terminal).toBeDefined();
      expect(received).toBeDefined();
      expect(received?.seq).toBeGreaterThan(terminal?.seq ?? Infinity);
      expect(received?.turnKey).toBe(turn.turnKey);
    });
    it('cancels a scheduled steer acknowledgement during disposal', async () => {
      const driver = open(provider);
      session?.sendMessage('dispose root');
      const turn = await driver.nextTurn();
      await turn.emitText('before dispose');
      await until(
        'disposal steering availability',
        () => session?.getSteeringCapabilities?.().steer === true,
      );
      const submission = session?.submitSteeringInput?.(
        'dispose steer',
        'dispose-attempt',
        'dispose-user',
      );
      const steer = await turn.nextSteer();
      const receipt = steer.acknowledgeLate(5000).then(
        () => '',
        (error: unknown) => String(error),
      );
      await driver.dispose();
      expect(await receipt).toMatch(/disposed|closed/);
      await session?.destroy();
      await submission;
      expect(events.length).toBeGreaterThan(0);
      expect(trace(provider)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            direction: 'to-provider',
            text: textContaining('dispose steer'),
          }),
        ]),
      );
    });
    it('emits typed tool and native-task lifecycles', async () => {
      const driver = open(provider);
      session?.sendMessage('tool root');
      const turn = await driver.nextTurn();
      await turn.emitToolCall({
        callId: 'scripted-tool',
        name: 'scripted_test_tool',
        input: { value: 'input' },
      });
      await turn.emitToolResult('scripted-tool', 'tool output');
      await turn.startNativeTask({
        taskId: 'native-task',
        toolUseId: 'native-tool',
        kind: 'agent',
      });
      await turn.endNativeTask('native-task');
      await turn.complete();
      await until(
        'native task and tool events',
        () =>
          JSON.stringify(events).includes('native-task') &&
          JSON.stringify(events).includes('tool output'),
      );
      expect(trace(provider)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            direction: 'to-canopy',
            turnKey: turn.turnKey,
            ids: objectContaining({
              taskId: 'native-task',
              toolUseId: 'native-tool',
            }),
          }),
        ]),
      );
      expect(JSON.stringify(trace(provider))).toContain('scripted-tool');
    });
    it('finishes native background work after the root result', async () => {
      const driver = open(provider);
      session?.sendMessage('background root');
      const turn = await driver.nextTurn();
      await turn.startNativeTask({
        taskId: 'surviving-task',
        toolUseId: 'surviving-tool',
        kind: 'agent',
      });
      await turn.complete();
      await until('background root terminal', () =>
        events.some((event) => field(event, 'type') === 'result'),
      );
      const before = events.length;
      await turn.endNativeTask('surviving-task');
      await until(
        'background completion after terminal',
        () =>
          events.length > before &&
          JSON.stringify(events.slice(before)).includes('surviving-task'),
      );
      expect(trace(provider)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            direction: 'to-canopy',
            turnKey: turn.turnKey,
            ids: objectContaining({
              taskId: 'surviving-task',
              toolUseId: 'surviving-tool',
            }),
          }),
        ]),
      );
    });
    it('consumes another root prompt after a completed turn', async () => {
      const driver = open(provider);
      session?.sendMessage('first root');
      const first = await driver.nextTurn();
      await first.complete();
      await until('first root terminal', () =>
        events.some((event) => field(event, 'type') === 'result'),
      );
      session?.sendMessage('second root');
      const second = await driver.nextTurn();
      expect(second.turnKey).not.toBe(first.turnKey);
      expect(second.prompt).toContain('second root');
      await second.emitText('second answer');
      await second.complete();
      await until('second answer', () =>
        JSON.stringify(events).includes('second answer'),
      );
      expect(trace(provider)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            direction: 'to-provider',
            turnKey: second.turnKey,
            text: textContaining('second root'),
          }),
        ]),
      );
    });
    it('bounds a missing prompt wait', async () => {
      const driver = open(provider);
      await expect(driver.nextTurn({ timeoutMs: 5 })).rejects.toThrow(
        /timed out/i,
      );
      expect(events).toEqual([]);
      expect(trace(provider)).toEqual([]);
    });
    it('holds later frames until release', async () => {
      const driver = open(provider);
      session?.sendMessage('held root');
      const turn = await driver.nextTurn().catch((error: unknown) => {
        throw new Error(
          `${String(error)}; chat events: ${JSON.stringify(events)}`,
        );
      });
      turn.hold();
      const held = turn.emitText('held answer');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(JSON.stringify(events)).not.toContain('held answer');
      const count = trace(provider).length;
      await turn.release();
      await held;
      await turn.complete();
      await until('released assistant', () =>
        JSON.stringify(events).includes('held answer'),
      );
      expect(trace(provider).length).toBeGreaterThan(count);
    });
    it('observes a real session interrupt', async () => {
      const driver = open(provider);
      session?.sendMessage('interrupt root');
      const turn = await driver.nextTurn().catch((error: unknown) => {
        throw new Error(
          `${String(error)}; chat events: ${JSON.stringify(events)}`,
        );
      });
      await turn.emitText('before interrupt');
      const interrupted = driver.nextInterrupt();
      const canceled =
        provider === 'claude'
          ? session?.interruptWithPendingSweep?.()
          : session?.cancel();
      await interrupted;
      await turn.complete();
      await canceled;
      await until('interrupted terminal event', () =>
        events.some((event) => field(event, 'type') === 'result'),
      );
      expect(trace(provider)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            direction: 'to-provider',
            type: provider === 'claude' ? 'interrupt' : 'client:turn/interrupt',
            turnKey: turn.turnKey,
          }),
        ]),
      );
    });
    it('delivers a self-started turn without another prompt', async () => {
      const driver = open(provider);
      session?.sendMessage('initial root');
      const first = await driver.nextTurn();
      await first.complete();
      await until('initial result', () =>
        events.some((event) => field(event, 'type') === 'result'),
      );
      const promptCount = trace(provider).filter((event) => event.text).length;
      const turn = await driver.startTurnByItself({ text: 'wake prefix' });
      expect(turn.prompt).toBe('');
      await expect(driver.nextTurn({ timeoutMs: 5 })).rejects.toThrow(
        /timed out/i,
      );
      await turn.emitText('autonomous answer');
      await turn.complete();
      await until('autonomous answer', () =>
        JSON.stringify(events).includes('autonomous answer'),
      );
      expect(trace(provider).filter((event) => event.text)).toHaveLength(
        promptCount,
      );
      expect(trace(provider)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            direction: 'to-canopy',
            turnKey: turn.turnKey,
          }),
        ]),
      );
    });
  });
}

describe('scripted Codex raw transport extensions', () => {
  it('writes protocol-shaped errors and root/child thread status notifications', async () => {
    const { driver, process, output } = rawCodexTransport();
    await initializeRawCodexProcess(process, output);
    await startRawCodexThread(
      process,
      output,
      'scripted-thread',
      'thread/start',
      'thread-start',
    );

    const waitingForTurn = driver.nextTurn({ timeoutMs: 2000 });
    sendClientFrame(process, {
      jsonrpc: '2.0',
      id: 'turn-start',
      method: 'turn/start',
      params: { threadId: 'scripted-thread', input: [{ text: 'raw prompt' }] },
    });
    const turnStartResponse = await output.next();
    const turnStarted = await output.next();
    expect(turnStartResponse).toMatchObject({
      id: 'turn-start',
      result: { turn: { status: 'inProgress' } },
    });
    expect(turnStarted).toMatchObject({ method: 'turn/started' });
    const turn = await waitingForTurn;

    await turn.emitError?.({
      message: 'synthetic transient error',
      willRetry: true,
    });
    expect(await output.next()).toMatchObject({
      method: 'error',
      params: {
        error: {
          message: 'synthetic transient error',
          codexErrorInfo: null,
          additionalDetails: null,
          misalignment: null,
        },
        willRetry: true,
        threadId: 'scripted-thread',
        turnId: turn.turnKey,
      },
    });
    await turn.emitError?.({
      message: 'synthetic terminal error',
      willRetry: false,
    });
    expect(await output.next()).toMatchObject({
      method: 'error',
      params: {
        error: { message: 'synthetic terminal error' },
        willRetry: false,
        threadId: 'scripted-thread',
        turnId: turn.turnKey,
      },
    });

    await turn.emitThreadStatus?.({ status: 'active' });
    const activeStatus = await output.next();
    const activeParams = objectField(activeStatus, 'params');
    expect(field(activeStatus, 'method')).toBe('thread/status/changed');
    expect(activeParams?.threadId).toBe('scripted-thread');
    expect(activeParams?.status).toEqual({ type: 'active', activeFlags: [] });

    await turn.emitThreadStatus?.({ status: 'waitingOnApproval' });
    const approvalStatus = await output.next();
    const approvalParams = objectField(approvalStatus, 'params');
    expect(approvalParams?.threadId).toBe('scripted-thread');
    expect(approvalParams?.status).toEqual({
      type: 'active',
      activeFlags: ['waitingOnApproval'],
    });

    await turn.emitThreadStatus?.({ status: 'idle' });
    const idleStatus = await output.next();
    const idleParams = objectField(idleStatus, 'params');
    expect(idleParams?.threadId).toBe('scripted-thread');
    expect(idleParams?.status).toEqual({ type: 'idle' });

    await turn.startNativeTask({
      taskId: 'scripted-child-thread',
      toolUseId: 'scripted-child-call',
      kind: 'agent',
    });
    expect(await output.next()).toMatchObject({ method: 'item/started' });
    expect(await output.next()).toMatchObject({
      method: 'thread/status/changed',
      params: {
        threadId: 'scripted-child-thread',
        status: { type: 'active', activeFlags: [] },
      },
    });
    expect(await output.next()).toMatchObject({
      method: 'turn/started',
      params: {
        threadId: 'scripted-child-thread',
        turn: { status: 'inProgress' },
      },
    });
    expect(await output.next()).toMatchObject({
      method: 'item/started',
      params: {
        item: {
          type: 'subAgentActivity',
          kind: 'started',
          agentThreadId: 'scripted-child-thread',
        },
      },
    });
    expect(await output.next()).toMatchObject({
      method: 'item/completed',
      params: {
        item: {
          type: 'subAgentActivity',
          kind: 'started',
          agentThreadId: 'scripted-child-thread',
        },
      },
    });
    await turn.emitThreadStatus?.({ status: 'active', child: true });
    const childStatus = await output.next();
    const childParams = objectField(childStatus, 'params');
    expect(field(childStatus, 'method')).toBe('thread/status/changed');
    expect(childParams?.threadId).toBe('scripted-child-thread');
    expect(childParams?.status).toEqual({ type: 'active', activeFlags: [] });
    await turn.complete();
    expect(await output.next()).toMatchObject({
      method: 'turn/completed',
      params: { turn: { id: turn.turnKey, status: 'completed' } },
    });
  });

  it('emits matching child-agent thread, turn, and activity frames at start and completion', async () => {
    const { driver, process, output } = rawCodexTransport();
    await initializeRawCodexProcess(process, output);
    await startRawCodexThread(
      process,
      output,
      'parent-thread',
      'thread/start',
      'thread-start',
    );
    const turn = await startRawCodexTurn(
      driver,
      process,
      output,
      'parent-thread',
      'turn-start',
    );

    await turn.startNativeTask({
      taskId: 'child-thread',
      toolUseId: 'child-tool',
      kind: 'agent',
    });
    expect(await output.next()).toMatchObject({
      method: 'item/started',
      params: {
        threadId: 'parent-thread',
        item: { type: 'collabAgentToolCall', id: 'child-tool' },
      },
    });
    expect(await output.next()).toMatchObject({
      method: 'thread/status/changed',
      params: {
        threadId: 'child-thread',
        status: { type: 'active', activeFlags: [] },
      },
    });
    const childTurnStarted = await output.next();
    expect(childTurnStarted).toMatchObject({
      method: 'turn/started',
      params: {
        threadId: 'child-thread',
        turn: { status: 'inProgress' },
      },
    });
    const childTurn = objectField(
      objectField(childTurnStarted, 'params') ?? {},
      'turn',
    );
    const childTurnId = childTurn?.id;
    expect(typeof childTurnId).toBe('string');

    const startedActivity = await output.next();
    const startedActivityItem = objectField(
      objectField(startedActivity, 'params') ?? {},
      'item',
    );
    expect(startedActivity).toMatchObject({
      method: 'item/started',
      params: { threadId: 'parent-thread' },
    });
    expect(startedActivityItem).toMatchObject({
      type: 'subAgentActivity',
      kind: 'started',
      agentThreadId: 'child-thread',
    });
    const startedActivityId = startedActivityItem?.id;
    expect(await output.next()).toMatchObject({
      method: 'item/completed',
      params: {
        threadId: 'parent-thread',
        item: {
          type: 'subAgentActivity',
          id: startedActivityId,
          kind: 'started',
          agentThreadId: 'child-thread',
        },
      },
    });

    await turn.endNativeTask('child-thread');
    expect(await output.next()).toMatchObject({
      method: 'thread/status/changed',
      params: {
        threadId: 'child-thread',
        status: { type: 'idle' },
      },
    });
    expect(await output.next()).toMatchObject({
      method: 'turn/completed',
      params: {
        threadId: 'child-thread',
        turn: { id: childTurnId, status: 'completed' },
      },
    });
    const completedActivity = await output.next();
    const completedActivityItem = objectField(
      objectField(completedActivity, 'params') ?? {},
      'item',
    );
    expect(completedActivity).toMatchObject({
      method: 'item/started',
      params: { threadId: 'parent-thread' },
    });
    expect(completedActivityItem).toMatchObject({
      type: 'subAgentActivity',
      kind: 'completed',
      agentThreadId: 'child-thread',
    });
    const completedActivityId = completedActivityItem?.id;
    expect(completedActivityId).not.toBe(startedActivityId);
    expect(await output.next()).toMatchObject({
      method: 'item/completed',
      params: {
        threadId: 'parent-thread',
        item: {
          type: 'subAgentActivity',
          id: completedActivityId,
          kind: 'completed',
          agentThreadId: 'child-thread',
        },
      },
    });
    expect(await output.next()).toMatchObject({
      method: 'item/completed',
      params: {
        threadId: 'parent-thread',
        item: {
          type: 'collabAgentToolCall',
          id: 'child-tool',
          agentsStates: {
            'child-thread': { status: 'completed', message: null },
          },
        },
      },
    });
  });

  it.each(['response-first', 'started-first'] as const)(
    'resumes an in-progress turn id on a new process with %s ordering',
    async (startOrder) => {
      const firstTransport = rawCodexTransport();
      await initializeRawCodexProcess(
        firstTransport.process,
        firstTransport.output,
      );
      await startRawCodexThread(
        firstTransport.process,
        firstTransport.output,
        'resumed-thread',
        'thread/start',
        'thread-start',
      );
      const waitingForFirstTurn = firstTransport.driver.nextTurn({
        timeoutMs: 2000,
      });
      sendClientFrame(firstTransport.process, {
        jsonrpc: '2.0',
        id: 'first-turn-start',
        method: 'turn/start',
        params: {
          threadId: 'resumed-thread',
          input: [{ text: 'first prompt' }],
        },
      });
      const firstStartResponse = await firstTransport.output.next();
      const firstStarted = await firstTransport.output.next();
      expect(firstStartResponse).toMatchObject({
        id: 'first-turn-start',
        result: { turn: { status: 'inProgress' } },
      });
      expect(firstStarted).toMatchObject({ method: 'turn/started' });
      const firstTurn = await waitingForFirstTurn;

      firstTransport.process.kill('SIGTERM');
      firstTransport.driver.configureNextResume?.({
        status: 'inProgress',
        turnId: firstTurn.turnKey,
        startOrder,
      });
      const resumedProcess = codexSpawnModuleMock(firstTransport.driver).spawn(
        '/scripted/codex',
        [],
        {},
      );
      const resumedOutput = new JsonRpcFrameReader(resumedProcess.stdout);
      await initializeRawCodexProcess(resumedProcess, resumedOutput);
      const resumeResponse = await startRawCodexThread(
        resumedProcess,
        resumedOutput,
        'resumed-thread',
        'thread/resume',
        'thread-resume',
      );
      const resumeResult = objectField(resumeResponse, 'result');
      const resumedThread = resumeResult
        ? objectField(resumeResult, 'thread')
        : undefined;
      const resumedTurns = resumedThread
        ? arrayField(resumedThread, 'turns')
        : undefined;
      expect(resumedTurns).toEqual([
        expect.objectContaining({
          id: firstTurn.turnKey,
          status: 'inProgress',
        }),
      ]);

      const waitingForResumedTurn = firstTransport.driver.nextTurn({
        timeoutMs: 2000,
      });
      sendClientFrame(resumedProcess, {
        jsonrpc: '2.0',
        id: 'second-turn-start',
        method: 'turn/start',
        params: {
          threadId: 'resumed-thread',
          input: [{ text: 'second prompt' }],
        },
      });
      const firstSecondStartFrame = await resumedOutput.next();
      const secondSecondStartFrame = await resumedOutput.next();
      const orderedFrames = [firstSecondStartFrame, secondSecondStartFrame];
      expect(
        orderedFrames.map((frame) =>
          field(frame, 'method') === 'turn/started'
            ? 'started'
            : field(frame, 'id') === 'second-turn-start'
              ? 'response'
              : 'unexpected',
        ),
      ).toEqual(
        startOrder === 'response-first'
          ? ['response', 'started']
          : ['started', 'response'],
      );
      const turnStartResponse = orderedFrames.find(
        (frame) => field(frame, 'id') === 'second-turn-start',
      );
      expect(turnStartResponse).toMatchObject({
        id: 'second-turn-start',
        result: { turn: { id: firstTurn.turnKey, status: 'inProgress' } },
      });

      const resumedTurn = await waitingForResumedTurn;
      expect(resumedTurn.turnKey).toBe(firstTurn.turnKey);
      expect(resumedTurn).not.toBe(firstTurn);
      await resumedTurn.emitText('resumed process output');
      expect(await resumedOutput.next()).toMatchObject({
        method: 'item/started',
      });
      expect(await resumedOutput.next()).toMatchObject({
        method: 'item/agentMessage/delta',
        params: { turnId: firstTurn.turnKey, delta: 'resumed process output' },
      });
      await resumedTurn.complete();
      expect(await resumedOutput.next()).toMatchObject({
        method: 'turn/completed',
        params: { turn: { id: firstTurn.turnKey, status: 'completed' } },
      });
    },
  );

  it('returns a completed resume id on turn/start without auto-completing its new handle', async () => {
    const firstTransport = rawCodexTransport();
    await initializeRawCodexProcess(
      firstTransport.process,
      firstTransport.output,
    );
    await startRawCodexThread(
      firstTransport.process,
      firstTransport.output,
      'completed-thread',
      'thread/start',
      'thread-start',
    );
    const waitingForFirstTurn = firstTransport.driver.nextTurn({
      timeoutMs: 2000,
    });
    sendClientFrame(firstTransport.process, {
      jsonrpc: '2.0',
      id: 'first-turn-start',
      method: 'turn/start',
      params: {
        threadId: 'completed-thread',
        input: [{ text: 'first prompt' }],
      },
    });
    await firstTransport.output.next();
    await firstTransport.output.next();
    const firstTurn = await waitingForFirstTurn;
    await firstTurn.complete();
    expect(await firstTransport.output.next()).toMatchObject({
      method: 'turn/completed',
      params: { turn: { id: firstTurn.turnKey, status: 'completed' } },
    });

    firstTransport.process.kill('SIGTERM');
    firstTransport.driver.configureNextResume?.({
      status: 'completed',
      turnId: firstTurn.turnKey,
      startOrder: 'response-first',
    });
    const resumedProcess = codexSpawnModuleMock(firstTransport.driver).spawn(
      '/scripted/codex',
      [],
      {},
    );
    const resumedOutput = new JsonRpcFrameReader(resumedProcess.stdout);
    await initializeRawCodexProcess(resumedProcess, resumedOutput);
    const resumeResponse = await startRawCodexThread(
      resumedProcess,
      resumedOutput,
      'completed-thread',
      'thread/resume',
      'thread-resume',
    );
    const resumeResult = objectField(resumeResponse, 'result');
    const resumedThread = resumeResult
      ? objectField(resumeResult, 'thread')
      : undefined;
    const resumedTurns = resumedThread
      ? arrayField(resumedThread, 'turns')
      : undefined;
    expect(resumedTurns).toEqual([
      expect.objectContaining({ id: firstTurn.turnKey, status: 'completed' }),
    ]);

    const waitingForResumedTurn = firstTransport.driver.nextTurn({
      timeoutMs: 2000,
    });
    sendClientFrame(resumedProcess, {
      jsonrpc: '2.0',
      id: 'second-turn-start',
      method: 'turn/start',
      params: {
        threadId: 'completed-thread',
        input: [{ text: 'second prompt' }],
      },
    });
    const turnStartResponse = await resumedOutput.next();
    expect(await resumedOutput.next()).toMatchObject({
      method: 'turn/started',
    });
    expect(turnStartResponse).toMatchObject({
      id: 'second-turn-start',
      result: { turn: { id: firstTurn.turnKey, status: 'inProgress' } },
    });
    const resumedTurn = await waitingForResumedTurn;
    expect(resumedTurn.turnKey).toBe(firstTurn.turnKey);
    expect(resumedTurn).not.toBe(firstTurn);
    await resumedTurn.emitText('completed-id new start output');
    expect(await resumedOutput.next()).toMatchObject({
      method: 'item/started',
    });
    expect(await resumedOutput.next()).toMatchObject({
      method: 'item/agentMessage/delta',
      params: {
        turnId: firstTurn.turnKey,
        delta: 'completed-id new start output',
      },
    });
    await resumedTurn.complete();
    expect(await resumedOutput.next()).toMatchObject({
      method: 'turn/completed',
      params: { turn: { id: firstTurn.turnKey, status: 'completed' } },
    });
  });
});

describe('Codex background terminal list protocol', () => {
  it('defaults to a fake-view snapshot of started commands that have a process id', async () => {
    const { driver, process, output } = rawCodexTransport();
    await initializeRawCodexProcess(process, output);
    await startRawCodexThread(
      process,
      output,
      'snapshot-thread',
      'thread/start',
      'thread-start',
    );
    const turn = await startRawCodexTurn(
      driver,
      process,
      output,
      'snapshot-thread',
      'turn-start',
    );

    await emitScriptedCodexCommand(driver, turn.turnKey, {
      itemId: 'without-process-id',
      output: '',
    });
    const withoutProcessId = await output.next();
    expect(objectField(withoutProcessId, 'params')?.item).toMatchObject({
      type: 'commandExecution',
      id: 'without-process-id',
      processId: null,
    });
    expect(await output.next()).toMatchObject({
      method: 'item/commandExecution/outputDelta',
    });
    expect(
      await listRawCodexBackgroundTerminals(
        process,
        output,
        'snapshot-thread',
        'empty-list',
      ),
    ).toMatchObject({
      id: 'empty-list',
      result: { data: [], nextCursor: null },
    });

    await emitScriptedCodexCommand(driver, turn.turnKey, {
      itemId: 'live-command',
      processId: 'scripted-process-1',
      output: '',
    });
    await output.next();
    await output.next();
    expect(
      await listRawCodexBackgroundTerminals(
        process,
        output,
        'snapshot-thread',
        'live-list',
      ),
    ).toMatchObject({
      id: 'live-list',
      result: {
        data: [
          {
            itemId: 'live-command',
            processId: 'scripted-process-1',
            command: 'synthetic lifecycle command',
            cwd: '/tmp/scripted-codex',
            osPid: null,
            cpuPercent: null,
            rssKb: null,
          },
        ],
        nextCursor: null,
      },
    });
  });

  it('isolates the default fake-view snapshot by requested thread', async () => {
    const { driver, process, output } = rawCodexTransport();
    await initializeRawCodexProcess(process, output);
    await startRawCodexThread(
      process,
      output,
      'thread-a',
      'thread/start',
      'thread-start-a',
    );
    const turnA = await startRawCodexTurn(
      driver,
      process,
      output,
      'thread-a',
      'turn-start-a',
    );
    await emitScriptedCodexCommand(driver, turnA.turnKey, {
      itemId: 'command-a',
      processId: 'process-a',
      output: '',
    });
    await output.next();
    await output.next();

    await startRawCodexThread(
      process,
      output,
      'thread-b',
      'thread/start',
      'thread-start-b',
    );
    const turnB = await startRawCodexTurn(
      driver,
      process,
      output,
      'thread-b',
      'turn-start-b',
    );
    await emitScriptedCodexCommand(driver, turnB.turnKey, {
      itemId: 'command-b',
      processId: 'process-b',
      output: '',
    });
    await output.next();
    await output.next();

    expect(
      await listRawCodexBackgroundTerminals(
        process,
        output,
        'thread-a',
        'list-a',
      ),
    ).toMatchObject({
      id: 'list-a',
      result: { data: [expect.objectContaining({ itemId: 'command-a' })] },
    });
    expect(
      await listRawCodexBackgroundTerminals(
        process,
        output,
        'thread-b',
        'list-b',
      ),
    ).toMatchObject({
      id: 'list-b',
      result: { data: [expect.objectContaining({ itemId: 'command-b' })] },
    });
  });

  it('drains completed commands from the default fake-view snapshot', async () => {
    const { driver, process, output } = rawCodexTransport();
    await initializeRawCodexProcess(process, output);
    await startRawCodexThread(
      process,
      output,
      'drain-thread',
      'thread/start',
      'thread-start',
    );
    const turn = await startRawCodexTurn(
      driver,
      process,
      output,
      'drain-thread',
      'turn-start',
    );
    await emitScriptedCodexCommand(driver, turn.turnKey, {
      itemId: 'finished-command',
      processId: 'finished-process',
      output: 'complete',
    });
    await output.next();
    await output.next();

    await emitScriptedCodexCommand(driver, turn.turnKey, {
      itemId: 'finished-command',
      processId: 'finished-process',
      output: 'complete',
      completed: true,
    });
    expect(await output.next()).toMatchObject({ method: 'item/completed' });
    expect(
      await listRawCodexBackgroundTerminals(
        process,
        output,
        'drain-thread',
        'after-completion',
      ),
    ).toMatchObject({
      id: 'after-completion',
      result: { data: [], nextCursor: null },
    });
  });

  it('serves explicitly configured cursor pages and errors for an unconfigured cursor', async () => {
    const { driver, process, output } = rawCodexTransport();
    configureScriptedCodexBackgroundTerminals(driver, {
      listPages: [
        {
          cursor: null,
          data: [
            {
              itemId: 'page-one-item',
              processId: 'page-one-process',
              command: 'echo one',
              cwd: '/tmp/one',
              osPid: 101,
              cpuPercent: 1.5,
              rssKb: 10,
            },
          ],
          nextCursor: 'page-two',
        },
        {
          cursor: 'page-two',
          data: [
            {
              itemId: 'page-two-item',
              processId: 'page-two-process',
              command: 'echo two',
              cwd: '/tmp/two',
              osPid: null,
              cpuPercent: null,
              rssKb: null,
            },
          ],
          nextCursor: null,
        },
      ],
    });

    expect(
      await listRawCodexBackgroundTerminals(
        process,
        output,
        'page-thread',
        'page-one',
      ),
    ).toMatchObject({
      id: 'page-one',
      result: {
        data: [expect.objectContaining({ itemId: 'page-one-item' })],
        nextCursor: 'page-two',
      },
    });
    expect(
      await listRawCodexBackgroundTerminals(
        process,
        output,
        'page-thread',
        'page-two',
        'page-two',
      ),
    ).toMatchObject({
      id: 'page-two',
      result: {
        data: [expect.objectContaining({ itemId: 'page-two-item' })],
        nextCursor: null,
      },
    });
    const missingPage = await listRawCodexBackgroundTerminals(
      process,
      output,
      'page-thread',
      'missing-page',
      'missing',
    );
    expect(missingPage).toHaveProperty('id', 'missing-page');
    const missingPageError = objectField(missingPage, 'error');
    expect(missingPageError?.code).toBe(-32602);
    expect(missingPageError?.message).toContain('missing');
  });

  it('gives a scoped list failure precedence over pages', async () => {
    const { driver, process, output } = rawCodexTransport();
    configureScriptedCodexBackgroundTerminals(driver, {
      threadId: 'configured-thread',
      listPages: [{ cursor: null, data: [], nextCursor: null }],
      listFailure: { code: -32044, message: 'synthetic terminal list failure' },
    });

    expect(
      await listRawCodexBackgroundTerminals(
        process,
        output,
        'other-thread',
        'other-thread-list',
      ),
    ).toMatchObject({
      id: 'other-thread-list',
      result: { data: [], nextCursor: null },
    });
    expect(
      await listRawCodexBackgroundTerminals(
        process,
        output,
        'configured-thread',
        'failed-list',
      ),
    ).toMatchObject({
      id: 'failed-list',
      error: {
        code: -32044,
        message: 'synthetic terminal list failure',
      },
    });
  });

  it('answers an unanswered fixture-replay list request with an empty page', async () => {
    const { driver, process, output } = rawCodexTransport();
    driver.enableReplay?.(codexReplayFixture());
    sendClientFrame(process, {
      jsonrpc: '2.0',
      id: 'unanswered-list',
      method: 'thread/backgroundTerminals/list',
      params: { threadId: 'replay-thread' },
    });
    expect(await nextRawFrameWithin(output)).toMatchObject({
      id: 'unanswered-list',
      result: { data: [], nextCursor: null },
    });
  });

  it('synthesizes a replay terminal process id only when opted in without mutating the skeleton', async () => {
    const recordedSkeleton = replayCommandItemFrame();

    const defaultTransport = rawCodexTransport();
    const defaultReplay =
      defaultTransport.driver.enableReplay?.(codexReplayFixture());
    if (!defaultReplay) throw new Error('Codex replay API missing');
    await defaultReplay.emit(recordedSkeleton);
    await defaultTransport.output.next();
    const defaultThreadId = defaultReplay.liveId?.('thread', 'terminal-thread');
    if (!defaultThreadId) throw new Error('Replay thread id was unavailable');
    expect(
      await listRawCodexBackgroundTerminals(
        defaultTransport.process,
        defaultTransport.output,
        defaultThreadId,
        'default-replay-list',
      ),
    ).toMatchObject({
      id: 'default-replay-list',
      result: { data: [], nextCursor: null },
    });

    const optedInTransport = rawCodexTransport();
    configureScriptedCodexBackgroundTerminals(optedInTransport.driver, {
      syntheticProcessId: 'fixture-process',
    });
    const optedInReplay =
      optedInTransport.driver.enableReplay?.(codexReplayFixture());
    if (!optedInReplay) throw new Error('Codex replay API missing');
    const skeletonCopy = structuredClone(recordedSkeleton);
    await optedInReplay.emit(skeletonCopy);
    await optedInTransport.output.next();
    expect(skeletonCopy).toEqual(recordedSkeleton);
    expect(skeletonCopy.fields).not.toHaveProperty('processId');
    const optedInThreadId = optedInReplay.liveId?.('thread', 'terminal-thread');
    const optedInItemId = optedInReplay.liveId?.('item', 'terminal-item');
    if (!optedInThreadId || !optedInItemId)
      throw new Error('Replay terminal ids were unavailable');
    expect(
      await listRawCodexBackgroundTerminals(
        optedInTransport.process,
        optedInTransport.output,
        optedInThreadId,
        'opted-in-replay-list',
      ),
    ).toMatchObject({
      id: 'opted-in-replay-list',
      result: {
        data: [
          {
            itemId: optedInItemId,
            processId: 'fixture-process',
            command: 'npm test',
            cwd: '/tmp/fixture-worktree',
            osPid: null,
            cpuPercent: null,
            rssKb: null,
          },
        ],
        nextCursor: null,
      },
    });
  });

  it('exits the live scripted Codex process unexpectedly and rejects when none is live', async () => {
    const { driver, process } = rawCodexTransport();
    const exitObserved = new Promise<NodeJS.Signals | null>((resolve) => {
      process.once(
        'exit',
        (_code: number | null, signal: NodeJS.Signals | null) =>
          resolve(signal),
      );
    });
    await exitScriptedCodexUnexpectedly(driver);
    await expect(exitObserved).resolves.toBe('SIGKILL');
    await expect(exitScriptedCodexUnexpectedly(driver)).rejects.toThrow(
      /no live scripted Codex process/i,
    );
  });
});

it('starts a fresh Claude query after destroying a session mid-turn', async () => {
  const driver = open('claude');
  session?.sendMessage('aborted root');
  const first = await driver.nextTurn();
  await first.emitText('before session destroy');
  const previousSession = session;
  if (!previousSession) throw new Error('Claude session was not created');

  const destroyed = await Promise.race([
    previousSession.destroy().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
  ]);
  expect(destroyed).toBe(true);

  const replacementDriver = open('claude');
  session?.sendMessage('replacement root');
  const replacement = await replacementDriver.nextTurn({ timeoutMs: 2000 });
  expect(replacement.turnKey).not.toBe(first.turnKey);
  expect(replacement.prompt).toContain('replacement root');
  await replacement.emitText('replacement answer');
  await replacement.complete();
  await until('replacement Claude result', () =>
    trace('claude').some(
      (event) =>
        event.direction === 'to-canopy' &&
        event.type === 'sdk:result:success' &&
        event.turnKey === replacement.turnKey,
    ),
  );
  expect(
    trace('claude').filter(
      (event) =>
        event.direction === 'to-provider' &&
        event.type === 'prompt' &&
        event.turnKey === replacement.turnKey &&
        event.text?.includes('replacement root'),
    ),
  ).toHaveLength(1);
});

it('holds a real pending-steer SDK interrupt receipt until released', async () => {
  const driver = open('claude');
  session?.sendMessage('held receipt root');
  const turn = await driver.nextTurn();
  await turn.emitText('before held receipt');
  await until(
    'held receipt steering availability',
    () => session?.getSteeringCapabilities?.().steer === true,
  );
  const submission = session?.submitSteeringInput?.(
    'pending steer before held receipt',
    'held-receipt-attempt',
    'held-receipt-user',
  );
  if (!submission) throw new Error('Real Claude steer was unavailable');
  const steer = await turn.nextSteer();
  expect(steer.text).toContain('pending steer before held receipt');

  const receipt = holdNextScriptedClaudeInterruptReceipt(driver);
  const interrupting = session?.interruptWithPendingSweep?.();
  if (!interrupting)
    throw new Error('Real Claude pending-input sweep was unavailable');
  try {
    await receipt.entered;
    await turn.complete();
    await until('held receipt root terminal', () =>
      trace('claude').some(
        (event) =>
          event.direction === 'to-canopy' &&
          event.type === 'sdk:result:success' &&
          event.turnKey === turn.turnKey,
      ),
    );

    let interruptionSettled = false;
    void interrupting.then(() => {
      interruptionSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(interruptionSettled).toBe(false);
    expect(trace('claude')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: 'to-provider',
          type: 'interrupt',
          turnKey: turn.turnKey,
        }),
      ]),
    );
  } finally {
    receipt.release();
  }
  await interrupting;
  await expect(submission).resolves.toEqual(
    expect.objectContaining({ kind: 'rejected' }),
  );
});

it('can reject the next SDK interrupt at the scripted provider boundary', async () => {
  const driver = open('claude');
  session?.sendMessage('interrupt rejection root');
  const turn = await driver.nextTurn();
  await turn.emitText('ready to reject interrupt');

  const rejection = new Error('scripted SDK interrupt rejection');
  rejectNextScriptedClaudeInterrupt(driver, rejection);

  await expect(session?.interruptWithPendingSweep?.()).rejects.toBe(rejection);
});

it('Codex receives a server request then provider-side resolution over real stdio', async () => {
  const driver = open('codex');
  session?.sendMessage('server request root');
  const turn = await driver.nextTurn().catch((error: unknown) => {
    throw new Error(`${String(error)}; chat events: ${JSON.stringify(events)}`);
  });
  if (!driver.sendServerRequest || !driver.resolveServerRequest)
    throw new Error('Codex server request API missing');
  let callSignal: AbortSignal | undefined;
  mockToolHandler.mockImplementationOnce(
    (_params, _runtime, context) =>
      new Promise((resolve, reject) => {
        callSignal = context?.signal;
        const timer = setTimeout(
          () => reject(new Error('Scripted tool cancellation timed out')),
          4000,
        );
        callSignal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve({ success: false, contentItems: [] });
          },
          { once: true },
        );
      }),
  );
  await driver.sendServerRequest({
    method: 'item/tool/call',
    callId: 'server-call',
    params: { tool: 'unknown_scripted_tool', arguments: {}, namespace: null },
  });
  await until('real dynamic tool dispatch', () => callSignal !== undefined);
  await driver.resolveServerRequest('server-call');
  await until('real dynamic tool aborted', () => callSignal?.aborted === true);
  await turn.emitText('after resolution');
  await turn.complete();
  await until('server request terminal', () =>
    events.some((event) => field(event, 'type') === 'result'),
  );
  expect(JSON.stringify(events)).toContain('after resolution');
  expect(trace('codex')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        direction: 'to-canopy',
        type: 'request:item/tool/call',
        ids: objectContaining({ callId: 'server-call' }),
      }),
      expect.objectContaining({
        direction: 'to-canopy',
        type: 'notification:serverRequest/resolved',
        ids: objectContaining({ callId: 'server-call' }),
      }),
    ]),
  );
});
