import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type * as FsPromisesModule from 'node:fs/promises';
import type * as PathsModule from '../lib/paths';
import type * as TranscriptSyncModule from '../integration/claude-terminal-transcript-sync';
import { BRAND } from '@canopy/brand/current';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';

const mockMkdir = jest.fn();
const mockRm = jest.fn();
const mockReadPreferencesFile = jest.fn();
const mockSpawnManagedTerminal = jest.fn();
interface WorkerHookBody {
  hookEventName: string;
  hookPayload: Record<string, unknown>;
}

interface RegisteredCanopyWorktreeSessionRoute {
  sessionKey?: string;
  workerMemoryToolExposure?: string;
  reportStructuredResultSchema?: Record<string, unknown>;
  onReportStructuredResult?: (payload: unknown) => {
    ok: boolean;
    error?: string;
  };
  hookHandler?: (body: WorkerHookBody) => Promise<unknown>;
}

const mockRegisterCanopyWorktreeSessionRoute = jest.fn<
  Promise<void>,
  [RegisteredCanopyWorktreeSessionRoute]
>();
const mockUnregisterCanopyWorktreeSessionRoute = jest.fn();
const mockUnregisterMcpProxyRoutesForSession = jest.fn();
const mockPtyKill = jest.fn();
const mockAddEventListener = jest.fn<
  void,
  [(channel: string, payload: unknown) => void]
>();
const mockEnsureClaudeWorkspaceTrust = jest.fn();
const mockBuildClaudeTerminalLaunchConfig = jest.fn();

/** The config a launch built, as the test inspects it. */
function launchConfigAt(index: number): unknown {
  return mockBuildClaudeTerminalLaunchConfig.mock.calls.map(
    (call: readonly unknown[]): unknown => call[0],
  )[index];
}
const mockGetClaudeWorkerRuntimeDir = jest.fn();
const mockStartObservedTask = jest.fn();
const mockFinalizeObservedTask = jest.fn();
const mockGetCachedClaudeAuthStatusObserved = jest.fn(() =>
  Promise.resolve({
    authenticated: true,
    accountLabel: 'dev@example.com',
    detail: null,
    error: null,
  }),
);
const mockIsClaudeTuiWorkersEnabled = jest.fn(() => true);
const mockApprovalCheck = jest.fn(() =>
  Promise.resolve({ decision: 'allow' as const }),
);
const mockApprovalDispose = jest.fn();
const mockCreateApprovalSession = jest.fn(() => ({
  check: mockApprovalCheck,
  setMode: jest.fn(),
  dispose: mockApprovalDispose,
}));
const mockWorkerRuntimeRoot = join(
  tmpdir(),
  'canopy-claude-worker-session-service-test',
);

jest.mock('node:fs/promises', () => ({
  ...jest.requireActual<typeof FsPromisesModule>('node:fs/promises'),
  mkdir: mockMkdir,
  rm: mockRm,
}));

jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: mockReadPreferencesFile,
}));

jest.mock('../services/terminal-service', () => ({
  spawnManagedTerminal: mockSpawnManagedTerminal,
}));

jest.mock('../integration/claude-workspace-trust', () => ({
  ensureClaudeWorkspaceTrust: mockEnsureClaudeWorkspaceTrust,
}));

jest.mock('../integration/claude-terminal-settings', () => ({
  buildClaudeTerminalLaunchConfig: mockBuildClaudeTerminalLaunchConfig,
}));

jest.mock('../lib/paths', () => ({
  ...jest.requireActual<typeof PathsModule>('../lib/paths'),
  getClaudeWorkerRuntimeDir: mockGetClaudeWorkerRuntimeDir,
}));

jest.mock('../integration/desktop-integration-server', () => ({
  getDesktopIntegrationServer: jest.fn(() => ({
    registerCanopyWorktreeSessionRoute: mockRegisterCanopyWorktreeSessionRoute,
    unregisterCanopyWorktreeSessionRoute:
      mockUnregisterCanopyWorktreeSessionRoute,
    unregisterMcpProxyRoutesForSession: mockUnregisterMcpProxyRoutesForSession,
  })),
}));

const mockSyncClaudeTerminalTranscript = jest.fn();

jest.mock('../integration/claude-terminal-transcript-sync', () => ({
  isAllowedClaudeTerminalTranscriptPath: jest.fn(() => true),
  syncClaudeTerminalTranscript: mockSyncClaudeTerminalTranscript,
}));

jest.mock('../terminal/pty-manager', () => ({
  ptyManager: {
    addEventListener: mockAddEventListener,
    kill: mockPtyKill,
  },
}));

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    startObservedTask: mockStartObservedTask,
    finalizeObservedTask: mockFinalizeObservedTask,
  })),
}));

jest.mock('../auth/provider-auth-state', () => ({
  getCachedClaudeAuthStatusObserved: mockGetCachedClaudeAuthStatusObserved,
}));

jest.mock('../lib/claude-tui-workers', () => ({
  getEffectiveClaudeWorkerConcurrencyLimit: jest.fn(
    (preferences: { workerConcurrencyLimit?: number } | null) =>
      mockIsClaudeTuiWorkersEnabled()
        ? (preferences?.workerConcurrencyLimit ?? 5)
        : 0,
  ),
  isClaudeTuiWorkersEnabled: mockIsClaudeTuiWorkersEnabled,
}));

jest.mock('../approvals/approval-service', () => ({
  createApprovalSession: (...args: unknown[]): unknown =>
    mockCreateApprovalSession(...args),
}));

import { DefaultClaudeWorkerSessionService } from '../integration/claude-worker-session-service';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForMockCalls(
  mockFn: jest.Mock,
  expectedCalls: number,
): Promise<void> {
  await waitForMockCallsWithin(mockFn, expectedCalls, 5_000);
}

async function waitForMockCallsWithin(
  mockFn: jest.Mock,
  expectedCalls: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (mockFn.mock.calls.length < expectedCalls) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${expectedCalls} mock calls`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function registeredSessionKey(callIndex: number): string {
  const sessionKey =
    mockRegisterCanopyWorktreeSessionRoute.mock.calls[callIndex]?.[0]
      ?.sessionKey;
  if (typeof sessionKey !== 'string') {
    throw new Error(`Missing registered session key at call ${callIndex}`);
  }
  return sessionKey;
}

function registeredHookHandler(
  callIndex: number,
): (body: WorkerHookBody) => Promise<unknown> {
  const hookHandler =
    mockRegisterCanopyWorktreeSessionRoute.mock.calls[callIndex]?.[0]
      ?.hookHandler;
  if (typeof hookHandler !== 'function') {
    throw new Error(`Missing registered hook handler at index ${callIndex}`);
  }
  return hookHandler;
}

interface LaunchConfigInputShape {
  approvalHookEnabled?: boolean;
  resumeExistingSession?: boolean;
  sdkSessionId?: string;
  systemPromptAppend?: string;
  initialPrompt?: string;
  preventClaudeNativeCaffeinate?: boolean;
}

function launchConfigInput(callIndex: number): LaunchConfigInputShape {
  const calls = mockBuildClaudeTerminalLaunchConfig.mock.calls as Array<
    [LaunchConfigInputShape]
  >;
  const input = calls[callIndex]?.[0];
  if (!input) {
    throw new Error(`Missing launch-config call at index ${callIndex}`);
  }
  return input;
}

function unregisteredSessionKeys(): string[] {
  const calls = mockUnregisterCanopyWorktreeSessionRoute.mock.calls as Array<
    [unknown]
  >;
  return calls.map(([sessionKey]) => {
    if (typeof sessionKey !== 'string') {
      throw new Error('Expected unregister call to receive a session key');
    }
    return sessionKey;
  });
}

describe('claude-worker-session-service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    mockSyncClaudeTerminalTranscript.mockImplementation(() =>
      Promise.resolve({
        importedMessages: [],
        importedEvents: [],
        importedEventCount: 0,
        transcriptPath: '',
        compactionAppended: false,
      }),
    );
    mockMkdir.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
    mockSpawnManagedTerminal.mockImplementation(() => ({
      id: `term-${mockSpawnManagedTerminal.mock.calls.length}`,
    }));
    mockEnsureClaudeWorkspaceTrust.mockResolvedValue(undefined);
    mockBuildClaudeTerminalLaunchConfig.mockResolvedValue({
      executable: '/bin/claude',
      args: [],
      env: {},
    });
    mockGetCachedClaudeAuthStatusObserved.mockResolvedValue({
      authenticated: true,
      accountLabel: 'dev@example.com',
      detail: null,
      error: null,
    });
    mockIsClaudeTuiWorkersEnabled.mockReturnValue(true);
    mockGetClaudeWorkerRuntimeDir.mockImplementation(
      (_projectId: string, _worktreeId: string, workerId: string) =>
        join(mockWorkerRuntimeRoot, workerId),
    );
    mockRegisterCanopyWorktreeSessionRoute.mockResolvedValue(undefined);
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile
      .mockResolvedValueOnce({ workerConcurrencyLimit: 0 })
      .mockResolvedValue({ workerConcurrencyLimit: 5 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects worker runs when Claude is not authenticated', async () => {
    mockGetCachedClaudeAuthStatusObserved.mockResolvedValueOnce({
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: 'Claude is not authenticated.',
    });
    const service = new DefaultClaudeWorkerSessionService();

    await expect(
      service.runWorker({
        kind: 'test',
        label: 'Test Worker',
        cwd: process.cwd(),
        systemPrompt: '',
        prompt: 'do it',
      }),
    ).rejects.toThrow(
      'Claude is not authenticated. Sign in from Settings before using Claude Workers.',
    );

    expect(mockGetCachedClaudeAuthStatusObserved).toHaveBeenCalledWith(
      'claude-worker-run',
      { forceRefresh: true },
    );
    expect(service.listWorkers()).toEqual([]);
    expect(mockSpawnManagedTerminal).not.toHaveBeenCalled();
  });

  it('rejects worker runs while Claude terminal worker mode is disabled', async () => {
    mockIsClaudeTuiWorkersEnabled.mockReturnValue(false);
    const service = new DefaultClaudeWorkerSessionService();

    await expect(
      service.runWorker({
        kind: 'test',
        label: 'Test Worker',
        cwd: process.cwd(),
        systemPrompt: '',
        prompt: 'do it',
      }),
    ).rejects.toThrow('Claude terminal worker mode is disabled.');

    expect(mockGetCachedClaudeAuthStatusObserved).not.toHaveBeenCalled();
    expect(service.listWorkers()).toEqual([]);
    expect(mockSpawnManagedTerminal).not.toHaveBeenCalled();
  });

  it('reports a missing Claude CLI when worker run auth cannot run', async () => {
    mockGetCachedClaudeAuthStatusObserved.mockResolvedValueOnce({
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: 'Claude CLI is not installed.',
    });
    const service = new DefaultClaudeWorkerSessionService();

    await expect(
      service.runWorker({
        kind: 'test',
        label: 'Test Worker',
        cwd: process.cwd(),
        systemPrompt: '',
        prompt: 'do it',
      }),
    ).rejects.toThrow('Claude CLI is not installed.');

    expect(mockGetCachedClaudeAuthStatusObserved).toHaveBeenCalledWith(
      'claude-worker-run',
      { forceRefresh: true },
    );
    expect(service.listWorkers()).toEqual([]);
    expect(mockSpawnManagedTerminal).not.toHaveBeenCalled();
  });

  it('reports a missing Claude CLI when worker retry auth cannot run', async () => {
    const service = new DefaultClaudeWorkerSessionService();
    const runPromise = service.runWorker({
      kind: 'test',
      label: 'Test Worker',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'do it',
    });
    runPromise.catch(() => undefined);

    await waitForMockCalls(mockReadPreferencesFile, 1);
    await flushPromises();
    const [card] = service.listWorkers();
    expect(card?.status).toBe('queued');

    mockGetCachedClaudeAuthStatusObserved.mockResolvedValueOnce({
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: 'Claude CLI is not installed.',
    });

    await expect(service.retry(card.workerId)).rejects.toThrow(
      'Claude CLI is not installed.',
    );

    expect(mockGetCachedClaudeAuthStatusObserved).toHaveBeenLastCalledWith(
      'claude-worker-retry',
      { forceRefresh: true },
    );

    jest.useFakeTimers();
    await service.shutdown();
    await runPromise;
    jest.runOnlyPendingTimers();
  });

  it('deduplicates queued retry before relaunching under the same worker id', async () => {
    const service = new DefaultClaudeWorkerSessionService();
    const runPromise = service.runWorker({
      kind: 'test',
      label: 'Test Worker',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'do it',
    });
    runPromise.catch(() => undefined);

    await waitForMockCalls(mockReadPreferencesFile, 1);
    await flushPromises();
    const [card] = service.listWorkers();
    expect(card?.status).toBe('queued');

    await service.retry(card.workerId);
    await waitForMockCalls(mockSpawnManagedTerminal, 1);

    expect(mockSpawnManagedTerminal).toHaveBeenCalledTimes(1);
    expect(service.listWorkers()).toEqual([
      expect.objectContaining({ workerId: card.workerId }),
    ]);

    jest.useFakeTimers();
    await service.shutdown();
    await runPromise;
    jest.runOnlyPendingTimers();
  });

  it('registers the MCP route with the exposure derived from the worker permission', async () => {
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });
    const service = new DefaultClaudeWorkerSessionService();
    const runPromise = service.runWorker({
      kind: 'test',
      label: 'Read-Only Worker',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'do it',
      permission: {
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        tools: ['Read', 'Glob', 'Grep', 'NotebookRead'],
        allowedTools: ['Read', 'Glob', 'Grep', 'NotebookRead'],
      },
    });
    runPromise.catch(() => undefined);

    await waitForMockCalls(mockRegisterCanopyWorktreeSessionRoute, 1);
    expect(
      mockRegisterCanopyWorktreeSessionRoute.mock.calls[0]?.[0]
        ?.workerMemoryToolExposure,
    ).toBe('read-only');

    jest.useFakeTimers();
    await service.shutdown();
    await runPromise;
    jest.runOnlyPendingTimers();
  });

  it('blocks concurrent retries while the auth refresh is pending', async () => {
    const service = new DefaultClaudeWorkerSessionService();
    const runPromise = service.runWorker({
      kind: 'test',
      label: 'Test Worker',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'do it',
    });
    runPromise.catch(() => undefined);

    await waitForMockCalls(mockReadPreferencesFile, 1);
    await flushPromises();
    const [card] = service.listWorkers();
    expect(card?.status).toBe('queued');

    const retryAuth = createDeferred<{
      authenticated: true;
      accountLabel: string;
      detail: null;
      error: null;
    }>();
    mockGetCachedClaudeAuthStatusObserved.mockImplementationOnce(
      () => retryAuth.promise,
    );

    const firstRetry = service.retry(card.workerId);
    const secondRetry = service.retry(card.workerId);
    await secondRetry;

    expect(mockGetCachedClaudeAuthStatusObserved).toHaveBeenCalledTimes(2);
    expect(mockSpawnManagedTerminal).not.toHaveBeenCalled();

    retryAuth.resolve({
      authenticated: true,
      accountLabel: 'dev@example.com',
      detail: null,
      error: null,
    });
    await firstRetry;
    await waitForMockCalls(mockSpawnManagedTerminal, 1);

    expect(mockSpawnManagedTerminal).toHaveBeenCalledTimes(1);

    jest.useFakeTimers();
    await service.shutdown();
    await runPromise;
    jest.runOnlyPendingTimers();
  });

  it('keeps an in-flight launch current when retry auth fails', async () => {
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });
    const firstRegisterDeferred = createDeferred<void>();
    const retryAuth = createDeferred<{
      authenticated: false;
      accountLabel: null;
      detail: null;
      error: string;
    }>();
    mockRegisterCanopyWorktreeSessionRoute.mockReturnValueOnce(
      firstRegisterDeferred.promise,
    );

    const service = new DefaultClaudeWorkerSessionService();
    const runPromise = service.runWorker({
      kind: 'test',
      label: 'Test Worker',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'do it',
    });
    runPromise.catch(() => undefined);

    await waitForMockCalls(mockRegisterCanopyWorktreeSessionRoute, 1);
    const [card] = service.listWorkers();
    expect(card?.status).toBe('starting');

    mockGetCachedClaudeAuthStatusObserved.mockImplementationOnce(
      () => retryAuth.promise,
    );
    const retryPromise = service.retry(card.workerId);
    await waitForMockCalls(mockGetCachedClaudeAuthStatusObserved, 2);

    firstRegisterDeferred.resolve(undefined);
    await waitForMockCalls(mockSpawnManagedTerminal, 1);

    retryAuth.resolve({
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: 'Claude is not authenticated.',
    });
    await expect(retryPromise).rejects.toThrow(
      'Claude is not authenticated. Sign in from Settings before using Claude Workers.',
    );

    expect(mockSpawnManagedTerminal).toHaveBeenCalledTimes(1);
    expect(service.listWorkers()).toEqual([
      expect.objectContaining({
        workerId: card.workerId,
        status: 'running',
      }),
    ]);

    jest.useFakeTimers();
    await service.shutdown();
    await runPromise;
    jest.runOnlyPendingTimers();
  });

  it('fires onQueued once when a worker waits on the concurrency cap', async () => {
    const service = new DefaultClaudeWorkerSessionService();
    const onQueued = jest.fn();
    const onStarted = jest.fn();
    const runPromise = service.runWorker({
      kind: 'test',
      label: 'Queued Worker',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'do it',
      onQueued,
      onStarted,
    });
    runPromise.catch(() => undefined);

    await waitForMockCalls(mockReadPreferencesFile, 1);
    await flushPromises();

    const [card] = service.listWorkers();
    expect(card?.status).toBe('queued');
    expect(onQueued).toHaveBeenCalledTimes(1);
    expect(onQueued).toHaveBeenCalledWith(card.workerId);
    expect(onStarted).not.toHaveBeenCalled();

    jest.useFakeTimers();
    await service.shutdown();
    await runPromise;
    jest.runOnlyPendingTimers();
  });

  it('fires onCreated before terminal startup completes', async () => {
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });
    const startup = createDeferred<void>();
    mockRegisterCanopyWorktreeSessionRoute.mockReturnValueOnce(startup.promise);
    const service = new DefaultClaudeWorkerSessionService();
    const onCreated = jest.fn();
    const onStarted = jest.fn();
    const runPromise = service.runWorker({
      kind: 'test',
      label: 'Starting Worker',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'do it',
      onCreated,
      onStarted,
    });
    runPromise.catch(() => undefined);

    await waitForMockCalls(onCreated, 1);
    const [card] = service.listWorkers();
    expect(onCreated).toHaveBeenCalledWith(card?.workerId);
    expect(onStarted).not.toHaveBeenCalled();

    startup.resolve(undefined);
    await waitForMockCalls(onStarted, 1);
    expect(onStarted).toHaveBeenCalledWith(card?.workerId);

    jest.useFakeTimers();
    await service.shutdown();
    await runPromise;
    jest.runOnlyPendingTimers();
  });

  it('fails and kills a worker that never starts its agent session', async () => {
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });
    const service = new DefaultClaudeWorkerSessionService();
    const runPromise = service.runWorker({
      kind: 'pipeline_agent_prompt',
      label: 'Pipeline Agent',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'do it',
      startupTimeoutMs: 20,
      timeoutMs: 0,
    });

    await waitForMockCalls(mockSpawnManagedTerminal, 1);
    await expect(runPromise).resolves.toMatchObject({ status: 'failure' });
    expect(mockPtyKill).toHaveBeenCalledWith('term-1', {
      signalOverride: 'app-managed-cleanup',
    });
  });

  it('clears the startup timer after Claude emits SessionStart', async () => {
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });
    const service = new DefaultClaudeWorkerSessionService();
    const runPromise = service.runWorker({
      kind: 'pipeline_agent_prompt',
      label: 'Pipeline Agent',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'do it',
      startupTimeoutMs: 20,
      timeoutMs: 0,
    });

    await waitForMockCalls(mockSpawnManagedTerminal, 1);
    await registeredHookHandler(0)({
      hookEventName: 'SessionStart',
      hookPayload: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(service.listWorkers()).toEqual([
      expect.objectContaining({ status: 'running' }),
    ]);
    await service.shutdown();
    await expect(runPromise).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('imports real worker transcript events once across consecutive hooks', async () => {
    const fsPromises =
      jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
    const realSync = jest.requireActual<typeof TranscriptSyncModule>(
      '../integration/claude-terminal-transcript-sync',
    );
    const runtimeRoot = await fsPromises.mkdtemp(
      join(tmpdir(), 'canopy-worker-real-transcript-'),
    );
    mockMkdir.mockImplementation(fsPromises.mkdir);
    mockRm.mockImplementation(fsPromises.rm);
    mockGetClaudeWorkerRuntimeDir.mockImplementation(
      (_projectId: string, _worktreeId: string, workerId: string) =>
        join(runtimeRoot, workerId),
    );
    mockSyncClaudeTerminalTranscript.mockImplementation(
      realSync.syncClaudeTerminalTranscript,
    );
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });

    try {
      const service = new DefaultClaudeWorkerSessionService();
      const runPromise = service.runWorker({
        kind: 'test',
        label: 'Real Transcript Worker',
        cwd: process.cwd(),
        systemPrompt: '',
        prompt: 'do it',
      });
      await waitForMockCalls(mockSpawnManagedTerminal, 1);
      const [card] = service.listWorkers();
      if (!card) throw new Error('Expected a running worker');
      const transcriptPath = join(runtimeRoot, card.workerId, 'claude.jsonl');
      await fsPromises.writeFile(
        transcriptPath,
        [
          {
            type: 'user',
            uuid: 'worker-service-user',
            message: { role: 'user', content: 'Worker question' },
          },
          {
            type: 'assistant',
            uuid: 'worker-service-answer',
            message: { role: 'assistant', content: 'Worker answer' },
          },
        ]
          .map((event) => JSON.stringify(event))
          .join('\n') + '\n',
        'utf8',
      );
      const hook = registeredHookHandler(0);
      await hook({
        hookEventName: 'SessionStart',
        hookPayload: { transcript_path: transcriptPath },
      });
      await hook({
        hookEventName: 'PostToolUse',
        hookPayload: { transcript_path: transcriptPath },
      });
      await hook({
        hookEventName: 'Stop',
        hookPayload: { transcript_path: transcriptPath },
      });
      const result = await runPromise;
      expect(result.status).toBe('success');
      expect(result.transcript.map((message) => message.id)).toEqual([
        'worker-service-user',
        'worker-service-answer',
      ]);
      const assistantEvents = result.transcriptJsonl
        .trim()
        .split('\n')
        .map((line) => {
          const value: unknown = JSON.parse(line);
          return value;
        })
        .filter(
          (event) =>
            typeof event === 'object' &&
            event !== null &&
            'type' in event &&
            event.type === 'assistant',
        );
      expect(assistantEvents).toHaveLength(1);
    } finally {
      await fsPromises.rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('imports a worker transcript suffix once when two hooks overlap at cursor write', async () => {
    const fsPromises =
      jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
    const mockedFsPromises =
      jest.requireMock<typeof FsPromisesModule>('node:fs/promises');
    const realSync = jest.requireActual<typeof TranscriptSyncModule>(
      '../integration/claude-terminal-transcript-sync',
    );
    const runtimeRoot = await fsPromises.mkdtemp(
      join(tmpdir(), 'canopy-worker-overlap-'),
    );
    mockMkdir.mockImplementation(fsPromises.mkdir);
    mockRm.mockImplementation(fsPromises.rm);
    mockGetClaudeWorkerRuntimeDir.mockImplementation(
      (_projectId: string, _worktreeId: string, workerId: string) =>
        join(runtimeRoot, workerId),
    );
    mockSyncClaudeTerminalTranscript.mockImplementation(
      realSync.syncClaudeTerminalTranscript,
    );
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });

    const firstCursorWrite = createDeferred<void>();
    const releaseFirstWrite = createDeferred<void>();
    const secondCursorWrite = createDeferred<void>();
    let cursorWrites = 0;
    const originalWriteFile = mockedFsPromises.writeFile;
    let writeSpy: jest.SpyInstance | undefined;
    const service = new DefaultClaudeWorkerSessionService();
    try {
      const runPromise = service.runWorker({
        kind: 'test',
        label: 'Overlapping Transcript Worker',
        cwd: process.cwd(),
        systemPrompt: '',
        prompt: 'do it',
      });
      runPromise.catch(() => undefined);
      await waitForMockCalls(mockSpawnManagedTerminal, 1);
      const [card] = service.listWorkers();
      if (!card) throw new Error('Expected a running worker');
      const transcriptPath = join(runtimeRoot, card.workerId, 'claude.jsonl');
      const cursorPath = join(
        runtimeRoot,
        card.workerId,
        'transcript-cursor.json',
      );
      await fsPromises.writeFile(
        transcriptPath,
        `${JSON.stringify({
          type: 'assistant',
          uuid: 'initial-answer',
          message: { role: 'assistant', content: 'Initial answer' },
        })}\n`,
        'utf8',
      );
      const hook = registeredHookHandler(0);
      await hook({
        hookEventName: 'SessionStart',
        hookPayload: { transcript_path: transcriptPath },
      });
      await fsPromises.appendFile(
        transcriptPath,
        `${JSON.stringify({
          type: 'assistant',
          uuid: 'overlapping-suffix',
          message: { role: 'assistant', content: 'Suffix answer' },
        })}\n`,
        'utf8',
      );
      writeSpy = jest
        .spyOn(mockedFsPromises, 'writeFile')
        .mockImplementation(async (...args) => {
          if (args[0] === cursorPath) {
            cursorWrites += 1;
            if (cursorWrites === 1) {
              firstCursorWrite.resolve();
              await releaseFirstWrite.promise;
            } else if (cursorWrites === 2) {
              secondCursorWrite.resolve();
            }
          }
          return originalWriteFile(...args);
        });
      const first = hook({
        hookEventName: 'PostToolUse',
        hookPayload: { transcript_path: transcriptPath },
      });
      await Promise.race([
        firstCursorWrite.promise,
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error('First cursor write was not reached')),
            1_000,
          ),
        ),
      ]);
      const second = hook({
        hookEventName: 'Notification',
        hookPayload: { transcript_path: transcriptPath },
      });
      // Before the fix, the second import reaches its cursor write while the
      // first is paused, proving both read the same old cursor. A serialized
      // candidate reaches it only after the first is released.
      await Promise.race([
        secondCursorWrite.promise,
        new Promise<void>((resolve) => setTimeout(resolve, 100)),
      ]);
      releaseFirstWrite.resolve();
      await Promise.all([first, second]);
      await hook({ hookEventName: 'Stop', hookPayload: {} });
      const result = await runPromise;
      expect(result.transcript.map((message) => message.id)).toEqual([
        'initial-answer',
        'overlapping-suffix',
      ]);
      expect(
        result.transcriptJsonl
          .trim()
          .split('\n')
          .map((line) => {
            const value: unknown = JSON.parse(line);
            return value;
          })
          .filter(
            (event) =>
              typeof event === 'object' &&
              event !== null &&
              'type' in event &&
              event.type === 'assistant',
          ),
      ).toHaveLength(2);
    } finally {
      releaseFirstWrite.resolve();
      writeSpy?.mockRestore();
      await service.shutdown();
      await fsPromises.rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it.each(['cancel', 'terminal-exit'] as const)(
    'drains admitted transcript sync before %s settles and ignores late hooks',
    async (ending) => {
      mockReadPreferencesFile.mockReset();
      mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });
      const syncStarted = createDeferred<void>();
      const releaseSync = createDeferred<void>();
      mockSyncClaudeTerminalTranscript.mockImplementationOnce(async () => {
        syncStarted.resolve();
        await releaseSync.promise;
        return {
          importedMessages: [
            {
              id: 'accepted-before-cancel',
              role: 'assistant',
              timestamp: 1,
              blocks: [{ type: 'text', text: 'Accepted answer' }],
            },
          ],
          importedEvents: [
            {
              type: 'assistant',
              uuid: 'accepted-before-cancel',
              message: { role: 'assistant', content: 'Accepted answer' },
            },
          ],
          importedEventCount: 1,
          transcriptPath: '',
          replayedFromStart: false,
          compactionAppended: false,
        };
      });
      const service = new DefaultClaudeWorkerSessionService();
      const runPromise = service.runWorker({
        kind: 'test',
        label: 'Cancelled Transcript Worker',
        cwd: process.cwd(),
        systemPrompt: '',
        prompt: 'do it',
      });
      await waitForMockCalls(mockSpawnManagedTerminal, 1);
      const [card] = service.listWorkers();
      if (!card) throw new Error('Missing worker');
      const hook = registeredHookHandler(0);
      let resolved = false;
      void runPromise.then(() => {
        resolved = true;
      });
      const admittedHook = hook({
        hookEventName: 'SessionStart',
        hookPayload: {},
      });
      await syncStarted.promise;
      let cancellation: Promise<void> | undefined;
      if (ending === 'cancel') {
        cancellation = service.cancel(card.workerId);
      } else {
        const listener = mockAddEventListener.mock.calls[0]?.[0];
        if (!listener) {
          throw new Error('Missing terminal exit listener');
        }
        listener(IPC_CHANNELS.terminalExit, {
          terminalId: 'term-1',
          exitCode: 1,
          signal: null,
        });
      }
      await flushPromises();
      expect(resolved).toBe(false);
      releaseSync.resolve();
      await admittedHook;
      if (cancellation) await cancellation;
      const result = await runPromise;
      expect(result.status).toBe(
        ending === 'cancel' ? 'cancelled' : 'interrupted',
      );
      expect(result.transcript.map((message) => message.id)).toEqual([
        'accepted-before-cancel',
      ]);
      const callsBeforeLateHook =
        mockSyncClaudeTerminalTranscript.mock.calls.length;
      await hook({ hookEventName: 'Notification', hookPayload: {} });
      expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalledTimes(
        callsBeforeLateHook,
      );
      await service.shutdown();
    },
  );

  it('drains two hooks admitted before cancellation even when the second waits for sync', async () => {
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });
    const firstSyncStarted = createDeferred<void>();
    const releaseFirstSync = createDeferred<void>();
    const syncResult = (
      id: string,
    ): Awaited<
      ReturnType<typeof TranscriptSyncModule.syncClaudeTerminalTranscript>
    > => ({
      importedMessages: [
        {
          id,
          role: 'assistant' as const,
          timestamp: 1,
          blocks: [{ type: 'text' as const, text: id }],
        },
      ],
      importedEvents: [
        {
          type: 'assistant',
          uuid: id,
          message: { role: 'assistant', content: id },
        },
      ],
      importedEventCount: 1,
      transcriptPath: '',
      replayedFromStart: false,
      compactionAppended: false,
    });
    mockSyncClaudeTerminalTranscript
      .mockImplementationOnce(async () => {
        firstSyncStarted.resolve();
        await releaseFirstSync.promise;
        return syncResult('first-admitted');
      })
      .mockResolvedValueOnce(syncResult('second-admitted'));
    const service = new DefaultClaudeWorkerSessionService();
    const runPromise = service.runWorker({
      kind: 'test',
      label: 'Two Admitted Hooks Worker',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'do it',
    });
    await waitForMockCalls(mockSpawnManagedTerminal, 1);
    const [card] = service.listWorkers();
    if (!card) throw new Error('Missing worker');
    const hook = registeredHookHandler(0);
    const first = hook({ hookEventName: 'SessionStart', hookPayload: {} });
    await firstSyncStarted.promise;
    const second = hook({ hookEventName: 'PostToolUse', hookPayload: {} });
    const cancellation = service.cancel(card.workerId);
    releaseFirstSync.resolve();
    await Promise.all([first, second, cancellation]);
    const result = await runPromise;
    expect(result.status).toBe('cancelled');
    expect(result.transcript.map((message) => message.id)).toEqual([
      'first-admitted',
      'second-admitted',
    ]);
    await service.shutdown();
  });

  it('does not resume a retry after cancellation settles while old sync drains', async () => {
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });
    mockGetCachedClaudeAuthStatusObserved.mockReset();
    mockGetCachedClaudeAuthStatusObserved.mockResolvedValue({
      authenticated: true,
      accountLabel: 'dev@example.com',
      detail: null,
      error: null,
    });
    const syncStarted = createDeferred<void>();
    const releaseSync = createDeferred<void>();
    const retryAuthChecked = createDeferred<void>();
    mockSyncClaudeTerminalTranscript.mockImplementationOnce(async () => {
      syncStarted.resolve();
      await releaseSync.promise;
      return {
        importedMessages: [
          {
            id: 'retry-race-answer',
            role: 'assistant',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'Accepted before cancel' }],
          },
        ],
        importedEvents: [
          {
            type: 'assistant',
            uuid: 'retry-race-answer',
            message: {
              role: 'assistant',
              content: 'Accepted before cancel',
              usage: { input_tokens: 3, output_tokens: 2 },
            },
          },
        ],
        importedEventCount: 1,
        transcriptPath: '',
        replayedFromStart: false,
        compactionAppended: false,
      };
    });
    const service = new DefaultClaudeWorkerSessionService();
    const bounded = async <T>(
      promise: Promise<T>,
      stage: string,
    ): Promise<T> => {
      let timeout: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<T>((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(new Error(`Retry/cancel fixture stalled at ${stage}`)),
              1_000,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };
    const runPromise = service.runWorker({
      kind: 'test',
      label: 'Retry Cancel Race Worker',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'do it',
    });
    runPromise.catch(() => undefined);
    try {
      await bounded(waitForMockCalls(mockSpawnManagedTerminal, 1), 'launch');
      const [card] = service.listWorkers();
      if (!card) throw new Error('Missing worker');
      const hook = registeredHookHandler(0);
      const first = hook({ hookEventName: 'SessionStart', hookPayload: {} });
      await bounded(syncStarted.promise, 'first sync admission');
      mockGetCachedClaudeAuthStatusObserved.mockResolvedValueOnce({
        get authenticated() {
          retryAuthChecked.resolve();
          return true;
        },
        accountLabel: 'dev@example.com',
        detail: null,
        error: null,
      });
      const retry = service.retry(card.workerId);
      let retrySettled = false;
      void retry.then(() => {
        retrySettled = true;
      });
      await bounded(retryAuthChecked.promise, 'retry authentication');
      await Promise.resolve();
      expect(retrySettled).toBe(false);
      const cancellation = service.cancel(card.workerId);
      releaseSync.resolve();
      await bounded(Promise.all([first, retry, cancellation]), 'drain');
      const result = await bounded(runPromise, 'worker result');
      expect(result.status).toBe('cancelled');
      expect(result.transcript.map((message) => message.id)).toEqual([
        'retry-race-answer',
      ]);
      expect(result.finalText).toBe('Accepted before cancel');
      expect(result.usage.outputTokens).toBe(2);
      expect(
        service.listWorkers().find((item) => item.workerId === card.workerId)
          ?.status,
      ).toBe('cancelled');
      expect(mockSpawnManagedTerminal).toHaveBeenCalledTimes(1);
      expect(mockRegisterCanopyWorktreeSessionRoute).toHaveBeenCalledTimes(1);
    } finally {
      releaseSync.resolve();
      await bounded(service.shutdown(), 'cleanup');
    }
  });

  it('waits for a terminal-exit settlement already draining sync before shutdown resolves', async () => {
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });
    const syncStarted = createDeferred<void>();
    const releaseSync = createDeferred<void>();
    mockSyncClaudeTerminalTranscript.mockImplementationOnce(async () => {
      syncStarted.resolve();
      await releaseSync.promise;
      return {
        importedMessages: [
          {
            id: 'exit-drain-answer',
            role: 'assistant',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'Answer before exit' }],
          },
        ],
        importedEvents: [],
        importedEventCount: 1,
        transcriptPath: '',
        replayedFromStart: false,
        compactionAppended: false,
      };
    });
    const service = new DefaultClaudeWorkerSessionService();
    const runPromise = service.runWorker({
      kind: 'test',
      label: 'Terminal Exit Drain Worker',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'do it',
    });
    runPromise.catch(() => undefined);
    try {
      await waitForMockCalls(mockSpawnManagedTerminal, 1);
      const hook = registeredHookHandler(0);
      const admittedHook = hook({
        hookEventName: 'SessionStart',
        hookPayload: {},
      });
      await syncStarted.promise;
      const listener = mockAddEventListener.mock.calls[0]?.[0];
      if (!listener) {
        throw new Error('Missing terminal exit listener');
      }
      listener(IPC_CHANNELS.terminalExit, {
        terminalId: 'term-1',
        exitCode: 1,
        signal: null,
      });
      let shutdownResolved = false;
      const shutdown = service.shutdown().then(() => {
        shutdownResolved = true;
      });
      await flushPromises();
      expect(shutdownResolved).toBe(false);
      releaseSync.resolve();
      await Promise.all([admittedHook, shutdown]);
      const result = await runPromise;
      expect(result.status).toBe('interrupted');
      expect(result.finalText).toBe('Answer before exit');
      expect(mockRm).toHaveBeenCalled();
    } finally {
      releaseSync.resolve();
      await service.shutdown();
    }
  });

  it('deduplicates a rotated worker transcript beyond the cursor ID window', async () => {
    const fsPromises =
      jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
    const realSync = jest.requireActual<typeof TranscriptSyncModule>(
      '../integration/claude-terminal-transcript-sync',
    );
    const runtimeRoot = await fsPromises.mkdtemp(
      join(tmpdir(), 'canopy-worker-rotation-'),
    );
    mockMkdir.mockImplementation(fsPromises.mkdir);
    mockRm.mockImplementation(fsPromises.rm);
    mockGetClaudeWorkerRuntimeDir.mockImplementation(
      (_projectId: string, _worktreeId: string, workerId: string) =>
        join(runtimeRoot, workerId),
    );
    mockSyncClaudeTerminalTranscript.mockImplementation(
      realSync.syncClaudeTerminalTranscript,
    );
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });

    const service = new DefaultClaudeWorkerSessionService();
    const runPromise = service.runWorker({
      kind: 'test',
      label: 'Rotated Transcript Worker',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'do it',
    });
    try {
      await waitForMockCallsWithin(mockSpawnManagedTerminal, 1, 5000);
      const [card] = service.listWorkers();
      if (!card) throw new Error('Expected a running worker');
      const transcriptPath = join(runtimeRoot, card.workerId, 'claude.jsonl');
      const event = (index: number): string =>
        JSON.stringify({
          type: 'assistant',
          uuid: `worker-rotation-${index}`,
          message: {
            role: 'assistant',
            content: `Answer ${index}`,
            usage: { input_tokens: 10, output_tokens: 1 },
          },
        });
      await fsPromises.writeFile(
        transcriptPath,
        `${Array.from({ length: 501 }, (_, index) => event(index)).join('\n')}\n`,
        'utf8',
      );
      const hook = registeredHookHandler(0);
      await hook({
        hookEventName: 'SessionStart',
        hookPayload: { transcript_path: transcriptPath },
      });

      const replacementPath = join(
        runtimeRoot,
        card.workerId,
        'replacement.jsonl',
      );
      await fsPromises.writeFile(
        replacementPath,
        `${event(0)}\n${event(501)}\n`,
        'utf8',
      );
      await fsPromises.rename(replacementPath, transcriptPath);
      await hook({
        hookEventName: 'PostToolUse',
        hookPayload: { transcript_path: transcriptPath },
      });
      await hook({
        hookEventName: 'Stop',
        hookPayload: { transcript_path: transcriptPath },
      });
      const result = await runPromise;
      expect(result.status).toBe('success');
      expect(result.transcript).toHaveLength(502);
      expect(
        result.transcript.filter(
          (message) => message.id === 'worker-rotation-0',
        ),
      ).toHaveLength(1);
      expect(
        result.transcript.filter(
          (message) => message.id === 'worker-rotation-501',
        ),
      ).toHaveLength(1);
      expect(result.usage.outputTokens).toBe(502);
    } finally {
      await service.shutdown();
      await runPromise.catch(() => undefined);
      await fsPromises.rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('retains distinct replay events that share a provider UUID', async () => {
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });
    const firstMessage = {
      id: 'shared-provider-uuid',
      role: 'assistant' as const,
      timestamp: 1,
      blocks: [{ type: 'text' as const, text: 'Initial answer' }],
    };
    const firstEvent = {
      type: 'assistant',
      uuid: 'shared-provider-uuid',
      message: {
        role: 'assistant',
        content: 'Initial answer',
        usage: { input_tokens: 10, output_tokens: 3 },
      },
    };
    const toolResultEvent = {
      type: 'user',
      uuid: 'shared-provider-uuid',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
        ],
      },
    };
    const updatedEvent = {
      type: 'assistant',
      uuid: 'shared-provider-uuid',
      message: {
        role: 'assistant',
        content: 'Updated answer',
        usage: { input_tokens: 12, output_tokens: 2 },
      },
    };
    mockSyncClaudeTerminalTranscript
      .mockResolvedValueOnce({
        importedMessages: [firstMessage],
        importedEvents: [firstEvent],
        importedEventCount: 1,
        transcriptPath: '',
        replayedFromStart: false,
        compactionAppended: false,
      })
      .mockResolvedValueOnce({
        importedMessages: [],
        importedEvents: [toolResultEvent],
        importedEventCount: 0,
        transcriptPath: '',
        replayedFromStart: true,
        compactionAppended: false,
      })
      .mockResolvedValueOnce({
        importedMessages: [
          {
            ...firstMessage,
            timestamp: 2,
            blocks: [{ type: 'text', text: 'Updated answer' }],
          },
        ],
        importedEvents: [updatedEvent],
        importedEventCount: 1,
        transcriptPath: '',
        replayedFromStart: true,
        compactionAppended: false,
      });
    const service = new DefaultClaudeWorkerSessionService();
    const runPromise = service.runWorker({
      kind: 'test',
      label: 'Shared UUID Worker',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'do it',
    });
    await waitForMockCalls(mockSpawnManagedTerminal, 1);
    const hook = registeredHookHandler(0);
    await hook({ hookEventName: 'SessionStart', hookPayload: {} });
    await hook({ hookEventName: 'PostToolUse', hookPayload: {} });
    await hook({ hookEventName: 'Notification', hookPayload: {} });
    await hook({ hookEventName: 'Stop', hookPayload: {} });
    const result = await runPromise;
    const eventTypes = result.transcriptJsonl
      .trim()
      .split('\n')
      .map((line) => {
        const value: unknown = JSON.parse(line);
        if (
          typeof value !== 'object' ||
          value === null ||
          !('type' in value) ||
          typeof value.type !== 'string'
        ) {
          throw new Error('Expected normalized event type');
        }
        return value.type;
      });
    expect(eventTypes).toEqual(['assistant', 'user', 'assistant', 'result']);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.finalText).toBe('Updated answer');
  });

  it('fails queued workers when Claude terminal worker mode is disabled', async () => {
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 1 });
    const service = new DefaultClaudeWorkerSessionService();
    const firstRun = service.runWorker({
      kind: 'test',
      label: 'Running Worker',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'run first',
    });

    await waitForMockCalls(mockSpawnManagedTerminal, 1);
    const secondRun = service.runWorker({
      kind: 'test',
      label: 'Queued Worker',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'run second',
    });
    await flushPromises();
    const runningWorker = service
      .listWorkers()
      .find((worker) => worker.status === 'running');
    const queuedWorker = service
      .listWorkers()
      .find((worker) => worker.status === 'queued');
    if (!runningWorker || !queuedWorker) {
      throw new Error('Expected one running worker and one queued worker.');
    }

    mockIsClaudeTuiWorkersEnabled.mockReturnValue(false);
    jest.useFakeTimers();
    await service.cancel(runningWorker.workerId);

    await expect(firstRun).resolves.toMatchObject({ status: 'cancelled' });
    await expect(secondRun).resolves.toMatchObject({
      workerId: queuedWorker.workerId,
      status: 'failure',
    });
    expect(mockSpawnManagedTerminal).toHaveBeenCalledTimes(1);
    jest.runOnlyPendingTimers();
  });

  it('does not spawn a terminal after cancelling a starting worker', async () => {
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });
    const registerDeferred = createDeferred<void>();
    mockRegisterCanopyWorktreeSessionRoute.mockReturnValueOnce(
      registerDeferred.promise,
    );

    const service = new DefaultClaudeWorkerSessionService();
    const runPromise = service.runWorker({
      kind: 'test',
      label: 'Test Worker',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'do it',
    });

    await waitForMockCalls(mockRegisterCanopyWorktreeSessionRoute, 1);
    const [card] = service.listWorkers();
    expect(card?.status).toBe('starting');

    jest.useFakeTimers();
    await service.cancel(card.workerId);
    registerDeferred.resolve(undefined);
    await flushMicrotasks();

    expect(mockSpawnManagedTerminal).not.toHaveBeenCalled();
    await expect(runPromise).resolves.toMatchObject({ status: 'cancelled' });

    jest.runOnlyPendingTimers();
  });

  it('uses main page link targets for worktree chat worker audit entries', async () => {
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });

    const service = new DefaultClaudeWorkerSessionService();
    const runPromise = service.runWorker({
      kind: 'test',
      label: 'Audited Worker',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'do it',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      auditEventType: 'chat_summary',
    });
    runPromise.catch(() => undefined);

    await waitForMockCalls(mockStartObservedTask, 1);

    expect(mockStartObservedTask).toHaveBeenCalledWith(
      expect.stringMatching(/^worker:/),
      expect.objectContaining({
        linkTarget: {
          page: 'main',
          kind: 'worktree-chat',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        },
      }),
    );

    jest.useFakeTimers();
    await service.shutdown();
    await runPromise;
    jest.runOnlyPendingTimers();
  });

  it('bypasses fail-closed approval parsing for Full Access workers', async () => {
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });

    const service = new DefaultClaudeWorkerSessionService();
    const runPromise = service.runWorker({
      kind: 'test',
      label: 'Fresh Worker',
      cwd: process.cwd(),
      systemPrompt: 'BASE PROMPT',
      prompt: 'do it',
      approvalMode: 'full-access',
    });
    runPromise.catch(() => undefined);

    await waitForMockCalls(mockBuildClaudeTerminalLaunchConfig, 1);
    const input = launchConfigInput(0);
    expect(input.resumeExistingSession).toBe(false);
    expect(input.systemPromptAppend).toContain('BASE PROMPT');
    expect(input.systemPromptAppend).toContain(
      'Handle each user request autonomously and to completion without any additional input.',
    );
    expect(input.initialPrompt).toBe('do it');
    expect(input.approvalHookEnabled).toBe(true);
    expect(mockCreateApprovalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'full-access',
        provider: 'claude',
        workspaceRoot: process.cwd(),
      }),
    );
    await expect(
      registeredHookHandler(0)({
        hookEventName: 'PreToolUse',
        hookPayload: {
          tool_name: 'WebSearch',
          tool_input: { query: 'release notes' },
          tool_use_id: 'tool-1',
        },
      }),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });
    expect(mockApprovalCheck).not.toHaveBeenCalled();

    jest.useFakeTimers();
    await service.shutdown();
    await runPromise;
    jest.runOnlyPendingTimers();
    expect(mockApprovalDispose).toHaveBeenCalled();
  });

  it.each(['stop', 'accepted', 'cancelled', 'provider-failure', 'retry'])(
    'classifies rejected terminal envelopes only on a normal unaccepted Stop: %s',
    async (ending) => {
      mockReadPreferencesFile.mockReset();
      mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });
      const rejected = {
        memoryMd: 42,
        privateField: 'private source contents',
      };
      const onResultRejected = jest.fn();
      const isResult = jest.fn(
        (value: unknown): value is { memoryMd: string } =>
          typeof value === 'object' &&
          value !== null &&
          'memoryMd' in value &&
          typeof value.memoryMd === 'string',
      );
      const service = new DefaultClaudeWorkerSessionService();
      const runPromise = service.runWorker({
        kind: 'test',
        label: 'Consolidation Worker',
        cwd: process.cwd(),
        systemPrompt: '',
        prompt: '',
        schema: {
          type: 'object',
          properties: { memoryMd: { type: 'string' } },
          required: ['memoryMd'],
          additionalProperties: false,
        },
        isResult,
        onResultRejected,
      });
      await waitForMockCalls(mockBuildClaudeTerminalLaunchConfig, 1);
      const report =
        mockRegisterCanopyWorktreeSessionRoute.mock.calls[0]?.[0]
          ?.onReportStructuredResult;
      if (!report) throw new Error('Missing structured report callback');
      expect(report(rejected).ok).toBe(false);
      expect(isResult).not.toHaveBeenCalled();
      const [card] = service.listWorkers();
      if (!card) throw new Error('Missing worker');
      if (ending === 'accepted')
        expect(report({ memoryMd: '# Memory' }).ok).toBe(true);
      if (ending === 'retry') {
        await service.retry(card.workerId);
        await waitForMockCalls(mockBuildClaudeTerminalLaunchConfig, 2);
      }
      if (ending === 'cancelled') await service.cancel(card.workerId);
      else
        await registeredHookHandler(ending === 'retry' ? 1 : 0)({
          hookEventName: ending === 'provider-failure' ? 'StopFailure' : 'Stop',
          hookPayload: {},
        });
      const result = await runPromise;
      expect(onResultRejected).toHaveBeenCalledWith(rejected);
      expect(result).toMatchObject({
        status:
          ending === 'accepted'
            ? 'success'
            : ending === 'cancelled'
              ? 'cancelled'
              : 'failure',
      });
      if (ending === 'stop')
        expect(result).toHaveProperty('invalidOutput', true);
      else expect(result).not.toHaveProperty('invalidOutput');
      expect(JSON.stringify(result)).not.toContain('private source contents');
      await service.shutdown();
    },
  );

  it.each([false, true])(
    'keeps strict generation while terminal result validation opts in: %s',
    async (useEnvelopeValidation) => {
      mockReadPreferencesFile.mockReset();
      mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });
      const schema = {
        type: 'object',
        additionalProperties: false,
        properties: {
          memoryMd: { type: 'string' },
          topicFiles: {
            type: 'array',
            maxItems: 100,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                filename: { type: 'string' },
                content: { type: 'string' },
              },
              required: ['filename', 'content'],
            },
          },
        },
        required: ['memoryMd'],
      };
      const resultValidationSchema = {
        ...schema,
        properties: {
          ...schema.properties,
          topicFiles: { type: 'array', maxItems: 100, items: {} },
        },
      };
      const isResult = jest.fn(
        (value: unknown): value is Record<string, unknown> =>
          typeof value === 'object' &&
          value !== null &&
          'memoryMd' in value &&
          value.memoryMd !== 'reject-by-guard',
      );
      const service = new DefaultClaudeWorkerSessionService();
      const runPromise = service.runWorker({
        kind: 'test',
        label: 'Consolidation Worker',
        cwd: process.cwd(),
        systemPrompt: '',
        prompt: 'report it',
        schema,
        isResult,
        ...(useEnvelopeValidation ? { resultValidationSchema } : {}),
      });
      runPromise.catch(() => undefined);
      await waitForMockCalls(mockBuildClaudeTerminalLaunchConfig, 1);
      const route = mockRegisterCanopyWorktreeSessionRoute.mock.calls[0]?.[0];
      expect(route?.reportStructuredResultSchema).toEqual(schema);
      const report = route?.onReportStructuredResult;
      if (!report) throw new Error('Missing structured report callback');
      const payload = {
        memoryMd: '# Memory',
        topicFiles: [null, { filename: 'good.md', content: 'Fact' }],
      };
      expect(report(payload).ok).toBe(useEnvelopeValidation);
      if (useEnvelopeValidation) expect(isResult).toHaveBeenCalledWith(payload);
      else expect(isResult).not.toHaveBeenCalled();
      for (const invalid of [
        { memoryMd: 42 },
        { memoryMd: '# Memory', topicFiles: 'wrong' },
        { memoryMd: '# Memory', extra: true },
        {
          memoryMd: '# Memory',
          topicFiles: Array.from({ length: 101 }, () => null),
        },
        { memoryMd: 'reject-by-guard' },
      ])
        expect(report(invalid).ok).toBe(false);
      jest.useFakeTimers();
      await service.shutdown();
      await runPromise;
      jest.runOnlyPendingTimers();
    },
  );

  it('allows only the internal structured-result tool for schema workers', async () => {
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });

    const service = new DefaultClaudeWorkerSessionService();
    const runPromise = service.runWorker({
      kind: 'test',
      label: 'Structured Worker',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'report it',
      schema: { type: 'object' },
      approvalMode: 'auto',
    });
    runPromise.catch(() => undefined);

    await waitForMockCalls(mockBuildClaudeTerminalLaunchConfig, 1);
    expect(mockCreateApprovalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'auto',
        sessionRules: [
          expect.objectContaining({
            behavior: 'allow',
            origin: 'settings',
            target: {
              kind: 'mcp',
              server: BRAND.tools.namespace,
              tool: 'ReportStructuredResult',
            },
          }),
        ],
      }),
    );

    await expect(
      registeredHookHandler(0)({
        hookEventName: 'PreToolUse',
        hookPayload: {
          tool_name: `mcp__${BRAND.tools.namespace}__ReportStructuredResult`,
          tool_input: { value: 'done' },
          tool_use_id: 'tool-report',
        },
      }),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });
    expect(mockApprovalCheck).toHaveBeenCalledWith(
      {
        kind: 'mcp',
        server: BRAND.tools.namespace,
        tool: 'ReportStructuredResult',
      },
      expect.objectContaining({ toolUseId: 'tool-report' }),
    );

    jest.useFakeTimers();
    await service.shutdown();
    await runPromise;
    jest.runOnlyPendingTimers();
  });

  it('serves a pipeline agent worker its Ledger tools and allows them', async () => {
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });
    const ledgerTools = {
      execute: jest.fn(() => Promise.resolve({ text: '{}' })),
    };

    const service = new DefaultClaudeWorkerSessionService();
    const runPromise = service.runWorker({
      kind: 'pipeline_agent_prompt',
      label: 'Pipeline Worker',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'do it',
      approvalMode: 'auto',
      permission: {
        tools: ['Read', 'Glob', 'Grep', 'NotebookRead'],
        allowedTools: ['Read', 'Glob', 'Grep', 'NotebookRead'],
      },
      ledgerTools,
    });
    runPromise.catch(() => undefined);

    await waitForMockCalls(mockBuildClaudeTerminalLaunchConfig, 1);
    expect(
      mockRegisterCanopyWorktreeSessionRoute.mock.calls[0]?.[0]?.ledgerTools,
    ).toBe(ledgerTools);
    const ledgerRule = (tool: string): unknown =>
      expect.objectContaining({
        behavior: 'allow',
        target: { kind: 'mcp', server: BRAND.tools.namespace, tool },
      });
    expect(mockCreateApprovalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionRules: [
          ledgerRule('AddFeedEntry'),
          ledgerRule('SearchFeedEntries'),
          ledgerRule('UpdateFeedEntry'),
        ],
      }),
    );
    expect(launchConfigAt(0)).toMatchObject({
      permission: {
        allowedTools: [
          'Read',
          'Glob',
          'Grep',
          'NotebookRead',
          `mcp__${BRAND.tools.namespace}__AddFeedEntry`,
          `mcp__${BRAND.tools.namespace}__SearchFeedEntries`,
          `mcp__${BRAND.tools.namespace}__UpdateFeedEntry`,
        ],
      },
    });

    jest.useFakeTimers();
    await service.shutdown();
    await runPromise;
    jest.runOnlyPendingTimers();
  });

  it('never gives a background helper worker the Ledger tools', async () => {
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });

    const service = new DefaultClaudeWorkerSessionService();
    const runPromise = service.runWorker({
      kind: 'test',
      label: 'Helper Worker',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'summarize it',
      approvalMode: 'auto',
      permission: { tools: [], allowedTools: [] },
    });
    runPromise.catch(() => undefined);

    await waitForMockCalls(mockBuildClaudeTerminalLaunchConfig, 1);
    expect(
      mockRegisterCanopyWorktreeSessionRoute.mock.calls[0]?.[0],
    ).not.toHaveProperty('ledgerTools');
    expect(mockCreateApprovalSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionRules: [] }),
    );
    expect(launchConfigAt(0)).toMatchObject({
      permission: { tools: [], allowedTools: [] },
    });

    jest.useFakeTimers();
    await service.shutdown();
    await runPromise;
    jest.runOnlyPendingTimers();
  });

  it('uses the named Skill title and display in worker approval hooks', async () => {
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });

    const service = new DefaultClaudeWorkerSessionService();
    const runPromise = service.runWorker({
      kind: 'test',
      label: 'Skill Worker',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'use the skill',
      approvalMode: 'ask',
    });
    runPromise.catch(() => undefined);

    await waitForMockCalls(mockBuildClaudeTerminalLaunchConfig, 1);
    await expect(
      registeredHookHandler(0)({
        hookEventName: 'PreToolUse',
        hookPayload: {
          tool_name: 'Skill',
          tool_input: { skill: 'ud-linear:linear-agent-implement' },
          tool_use_id: 'tool-skill',
        },
      }),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });
    expect(mockApprovalCheck).toHaveBeenCalledWith(
      { kind: 'tool', toolName: 'Skill' },
      expect.objectContaining({
        title:
          'Claude Code wants to use skill ud-linear:linear-agent-implement',
        details: {
          kind: 'tool',
          toolName: 'ud-linear:linear-agent-implement',
        },
        suggestedTarget: { kind: 'tool', toolName: 'Skill' },
        toolUseId: 'tool-skill',
      }),
    );

    jest.useFakeTimers();
    await service.shutdown();
    await runPromise;
    jest.runOnlyPendingTimers();
  });

  it('denies write-capable tools for plan-mode workers under full access', async () => {
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });

    const service = new DefaultClaudeWorkerSessionService();
    const runPromise = service.runWorker({
      kind: 'test',
      label: 'Plan Worker',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'make a plan',
      permission: { permissionMode: 'plan' },
      approvalMode: 'full-access',
    });
    runPromise.catch(() => undefined);

    await waitForMockCalls(mockBuildClaudeTerminalLaunchConfig, 1);
    await expect(
      registeredHookHandler(0)({
        hookEventName: 'PreToolUse',
        hookPayload: {
          tool_name: 'Bash',
          tool_input: { command: 'touch changed.txt' },
          tool_use_id: 'tool-plan-write',
        },
      }),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Plan mode permits read-only tools only.',
      },
    });
    expect(mockApprovalCheck).not.toHaveBeenCalled();

    jest.useFakeTimers();
    await service.shutdown();
    await runPromise;
    jest.runOnlyPendingTimers();
  });

  it('passes the native caffeinate preference to worker launch config', async () => {
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile.mockResolvedValue({
      workerConcurrencyLimit: 5,
      preventClaudeNativeCaffeinate: false,
    });

    const service = new DefaultClaudeWorkerSessionService();
    const runPromise = service.runWorker({
      kind: 'test',
      label: 'Fresh Worker',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'do it',
    });
    runPromise.catch(() => undefined);

    await waitForMockCalls(mockBuildClaudeTerminalLaunchConfig, 1);
    expect(launchConfigInput(0).preventClaudeNativeCaffeinate).toBe(false);

    jest.useFakeTimers();
    await service.shutdown();
    await runPromise;
    jest.runOnlyPendingTimers();
  });

  it('resumes an existing session via --resume without re-appending a system prompt', async () => {
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });

    const service = new DefaultClaudeWorkerSessionService();
    const runPromise = service.runWorker({
      kind: 'test',
      label: 'Resume Worker',
      cwd: process.cwd(),
      systemPrompt: 'IGNORED ON RESUME',
      prompt: 'continue the work',
      resumeSessionId: 'prior-session-id',
    });
    runPromise.catch(() => undefined);

    await waitForMockCalls(mockBuildClaudeTerminalLaunchConfig, 1);
    const input = launchConfigInput(0);
    expect(input.resumeExistingSession).toBe(true);
    expect(input.sdkSessionId).toBe('prior-session-id');
    expect(input.systemPromptAppend).toBeUndefined();
    expect(input.initialPrompt).toBe('continue the work');

    jest.useFakeTimers();
    await service.shutdown();
    await runPromise;
    jest.runOnlyPendingTimers();
  });

  it('ignores a stale starting launch when retry starts a fresh launch', async () => {
    mockReadPreferencesFile.mockReset();
    mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });
    const firstRegisterDeferred = createDeferred<void>();
    mockRegisterCanopyWorktreeSessionRoute
      .mockReturnValueOnce(firstRegisterDeferred.promise)
      .mockResolvedValue(undefined);

    const service = new DefaultClaudeWorkerSessionService();
    const runPromise = service.runWorker({
      kind: 'test',
      label: 'Test Worker',
      cwd: process.cwd(),
      systemPrompt: '',
      prompt: 'do it',
    });
    runPromise.catch(() => undefined);

    await waitForMockCalls(mockRegisterCanopyWorktreeSessionRoute, 1);
    const [card] = service.listWorkers();
    expect(card?.status).toBe('starting');
    const staleSessionKey = registeredSessionKey(0);

    await service.retry(card.workerId);
    await waitForMockCalls(mockRegisterCanopyWorktreeSessionRoute, 2);
    await waitForMockCalls(mockSpawnManagedTerminal, 1);
    const freshSessionKey = registeredSessionKey(1);
    expect(freshSessionKey).toEqual(expect.any(String));
    expect(freshSessionKey).not.toBe(staleSessionKey);
    firstRegisterDeferred.resolve(undefined);
    await flushPromises();
    const staleCleanupSessionKeys = unregisteredSessionKeys();

    expect(mockSpawnManagedTerminal).toHaveBeenCalledTimes(1);
    expect(staleCleanupSessionKeys).toContain(staleSessionKey);
    expect(staleCleanupSessionKeys).not.toContain(freshSessionKey);
    expect(service.listWorkers()).toEqual([
      expect.objectContaining({
        workerId: card.workerId,
        status: 'running',
      }),
    ]);

    jest.useFakeTimers();
    await service.shutdown();
    await runPromise;
    jest.runOnlyPendingTimers();
  });
});
