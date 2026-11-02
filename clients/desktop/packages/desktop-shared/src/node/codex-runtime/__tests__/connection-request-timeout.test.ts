// When the app-server misses a request deadline the connection reports it,
// cleans up a thread whose response arrives after its caller gave up, and can
// recycle a worker that has no other live work. See docs/codex-app-server.md,
// "Failures, cancellation, and retries".
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type * as NodeChildProcess from 'node:child_process';
import type { CodexAppServerConnectionOwner } from '../connection';

const spawnMock = jest.fn<
  MockChildProcess,
  [string, readonly string[], NodeChildProcess.SpawnOptions]
>();

jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof NodeChildProcess>('node:child_process'),
  get spawn(): typeof spawnMock {
    return spawnMock;
  },
}));

// Fake PIDs must never reach the host's process-group signal path.
jest.mock('../../lib/process-kill', () => ({
  killChildProcessGroup: (
    child: NodeChildProcess.ChildProcess,
    signal: NodeJS.Signals,
  ): void => {
    child.kill(signal);
  },
}));

jest.mock('../../../pipelines/config-paths', () => ({
  getBundledCodexBinaryPath: jest.fn(() => '/mock/codex'),
  getEnhancedEnv: jest.fn(() => ({ ...process.env })),
}));

import {
  CodexAppServerConnection,
  DEFAULT_CODEX_THREAD_MUTATION_TIMEOUT_MS,
  isCodexAppServerRequestTimeoutError,
} from '../connection';
import {
  configureCodexRuntimeHostHooks,
  resetCodexRuntimeHostHooksForTests,
  type CodexRuntimeDiagnostic,
  type CodexRuntimeResourceRegistrationHandle,
} from '../host-hooks';

const recordDiagnosticMock = jest.fn<void, [CodexRuntimeDiagnostic]>();

const REQUEST_TIMEOUT_DIAGNOSTIC_KIND: string =
  'codex_app_server_request_timeout';
const STOPPED_DIAGNOSTIC_KIND: string = 'resource_codex_app_server_stopped';

class MockChildProcess extends EventEmitter {
  pid = 4293;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  clientOutput = '';
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill = jest.fn().mockImplementation((signal?: NodeJS.Signals): boolean => {
    this.signalCode = signal ?? 'SIGTERM';
    this.emit('exit', null, this.signalCode);
    return true;
  });

  constructor() {
    super();
    this.stdin.on('data', (chunk: unknown) => {
      this.clientOutput += String(chunk);
    });
  }
}

type OwnerMock = CodexAppServerConnectionOwner & {
  markProcessSuspended: jest.Mock<void, []>;
};

function ownerStub(
  overrides: Partial<CodexAppServerConnectionOwner> = {},
): OwnerMock {
  return {
    hasActiveTurn: () => false,
    getActiveTurnInterruptTarget: () => null,
    cancelPendingTurnStart: jest.fn(),
    rejectActiveTurn: jest.fn(),
    markProcessFailed: jest.fn(),
    handleConnectionNotification: jest.fn(),
    handleRequestUserInput: jest.fn(() => Promise.resolve()),
    handleDynamicToolCall: jest.fn(() => Promise.resolve()),
    handleApprovalRequest: jest.fn(() => Promise.resolve()),
    handleMcpElicitation: jest.fn(() => Promise.resolve()),
    ...overrides,
    markProcessSuspended: jest.fn<void, []>(),
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function flushMany(count = 20): Promise<void> {
  for (let attempt = 0; attempt < count; attempt += 1) await flush();
}

function emitServerMessage(proc: MockChildProcess, payload: unknown): void {
  proc.stdout.write(`${JSON.stringify(payload)}\n`);
}

function parseClientMessage(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Expected a Codex client protocol message object');
  }
  return Object.fromEntries(Object.entries(parsed));
}

function clientRequests(
  proc: MockChildProcess,
  method: string,
): Record<string, unknown>[] {
  return proc.clientOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseClientMessage)
    .filter((message) => message.method === method);
}

function lastClientRequest(
  proc: MockChildProcess,
  method: string,
): Record<string, unknown> {
  const request = clientRequests(proc, method).at(-1);
  if (!request) throw new Error(`Missing ${method} request`);
  return request;
}

function diagnosticsOfKind(kind: string): CodexRuntimeDiagnostic[] {
  return recordDiagnosticMock.mock.calls
    .map(([event]) => event)
    .filter((event) => event.kind === kind);
}

function settled(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

async function startConnection(
  owners: CodexAppServerConnectionOwner[],
): Promise<{ proc: MockChildProcess; connection: CodexAppServerConnection }> {
  const proc = new MockChildProcess();
  spawnMock.mockReturnValue(proc);
  const connection = new CodexAppServerConnection('profile:request-timeout');
  for (const owner of owners) connection.registerOwner(owner, {});
  const initialization = connection.ensureInitialized();
  await flush();
  emitServerMessage(proc, {
    id: 1,
    result: { userAgent: 'test', codexHome: '/tmp/.codex' },
  });
  await initialization;
  return { proc, connection };
}

describe('CodexAppServerConnection request timeouts', () => {
  let processKillSpy: jest.SpiedFunction<typeof process.kill>;

  beforeEach(() => {
    // Model a host where the fake PID happens to identify a live group.
    processKillSpy = jest.spyOn(process, 'kill').mockReturnValue(true);
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    recordDiagnosticMock.mockReset();
    configureCodexRuntimeHostHooks({
      clientInfo: () => ({
        name: 'test-runtime',
        title: 'Test Runtime',
        version: '0.0.0',
      }),
      registerProcess: (): CodexRuntimeResourceRegistrationHandle => ({
        update: (): void => {},
        unregister: (): void => {},
      }),
      registerProcessOwner: (): void => {},
      unregisterProcessOwner: (): void => {},
      recordDiagnostic: recordDiagnosticMock,
      productDisplayName: () => 'Test Runtime',
    });
  });

  afterEach(() => {
    expect(processKillSpy).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    jest.useRealTimers();
    resetCodexRuntimeHostHooksForTests();
  });

  it('rejects with a typed timeout and records a content-free diagnostic', async () => {
    const owner = ownerStub();
    const busyPeer = ownerStub({ hasActiveTurn: () => true });
    const { connection } = await startConnection([owner, busyPeer]);

    const failure = settled(
      connection.request(
        'thread/resume',
        { threadId: 'thread-slow' },
        { owner },
      ),
    );
    await flushMany();
    await jest.advanceTimersByTimeAsync(
      DEFAULT_CODEX_THREAD_MUTATION_TIMEOUT_MS,
    );

    const error = await failure;
    expect(isCodexAppServerRequestTimeoutError(error)).toBe(true);
    expect(error).toMatchObject({
      method: 'thread/resume',
      timeoutMs: DEFAULT_CODEX_THREAD_MUTATION_TIMEOUT_MS,
      message: 'Codex app-server did not respond to thread/resume within 120s',
    });
    expect(diagnosticsOfKind(REQUEST_TIMEOUT_DIAGNOSTIC_KIND)).toEqual([
      expect.objectContaining({
        requestMethod: 'thread/resume',
        requestTimeoutMs: DEFAULT_CODEX_THREAD_MUTATION_TIMEOUT_MS,
        busyPeerCount: 1,
        pendingRequestCount: 0,
        stdoutPaused: false,
      }),
    ]);
    expect(
      JSON.stringify(diagnosticsOfKind(REQUEST_TIMEOUT_DIAGNOSTIC_KIND)),
    ).not.toContain('thread-slow');
  });

  it('deletes a thread whose thread/start response arrives after the timeout', async () => {
    const owner = ownerStub();
    const { proc, connection } = await startConnection([owner]);

    const failure = settled(
      connection.request('thread/start', { cwd: '/tmp/repo' }, { owner }),
    );
    await flushMany();
    const startRequest = lastClientRequest(proc, 'thread/start');
    await jest.advanceTimersByTimeAsync(
      DEFAULT_CODEX_THREAD_MUTATION_TIMEOUT_MS,
    );
    expect(isCodexAppServerRequestTimeoutError(await failure)).toBe(true);

    emitServerMessage(proc, {
      id: startRequest.id,
      result: { thread: { id: 'thread-late', turns: [] } },
    });
    await flushMany();

    expect(lastClientRequest(proc, 'thread/delete').params).toEqual({
      threadId: 'thread-late',
    });
    expect(connection.resolveOwnerForThread('thread-late')).toBeNull();
  });

  it('unsubscribes a thread whose thread/resume response arrives after the timeout', async () => {
    const owner = ownerStub();
    const { proc, connection } = await startConnection([owner]);

    const failure = settled(
      connection.request('thread/resume', { threadId: 'thread-1' }, { owner }),
    );
    await flushMany();
    const resumeRequest = lastClientRequest(proc, 'thread/resume');
    await jest.advanceTimersByTimeAsync(
      DEFAULT_CODEX_THREAD_MUTATION_TIMEOUT_MS,
    );
    await failure;

    emitServerMessage(proc, {
      id: resumeRequest.id,
      result: { thread: { id: 'thread-1', turns: [] } },
    });
    await flushMany();

    expect(lastClientRequest(proc, 'thread/unsubscribe').params).toEqual({
      threadId: 'thread-1',
    });
    expect(clientRequests(proc, 'thread/delete')).toEqual([]);
    expect(connection.resolveOwnerForThread('thread-1')).toBeNull();
  });

  it('leaves a late thread/resume response alone once an owner has resumed the thread', async () => {
    const owner = ownerStub();
    const { proc, connection } = await startConnection([owner]);

    const failure = settled(
      connection.request('thread/resume', { threadId: 'thread-1' }, { owner }),
    );
    await flushMany();
    const timedOutRequest = lastClientRequest(proc, 'thread/resume');
    await jest.advanceTimersByTimeAsync(
      DEFAULT_CODEX_THREAD_MUTATION_TIMEOUT_MS,
    );
    await failure;

    const retried = connection.request(
      'thread/resume',
      { threadId: 'thread-1' },
      { owner },
    );
    await flushMany();
    emitServerMessage(proc, {
      id: lastClientRequest(proc, 'thread/resume').id,
      result: { thread: { id: 'thread-1', turns: [] } },
    });
    await retried;
    emitServerMessage(proc, {
      id: timedOutRequest.id,
      result: { thread: { id: 'thread-1', turns: [] } },
    });
    await flushMany();

    expect(clientRequests(proc, 'thread/unsubscribe')).toEqual([]);
    expect(connection.resolveOwnerForThread('thread-1')).toBe(owner);
  });

  it('keeps the subscription a pending retry is about to claim when a late reply arrives first', async () => {
    const handleConnectionNotification = jest.fn();
    const owner = { ...ownerStub(), handleConnectionNotification };
    const { proc, connection } = await startConnection([owner]);

    const failure = settled(
      connection.request('thread/resume', { threadId: 'thread-1' }, { owner }),
    );
    await flushMany();
    const timedOutRequest = lastClientRequest(proc, 'thread/resume');
    await jest.advanceTimersByTimeAsync(
      DEFAULT_CODEX_THREAD_MUTATION_TIMEOUT_MS,
    );
    await failure;

    const retried = connection.request(
      'thread/resume',
      { threadId: 'thread-1' },
      { owner },
    );
    await flushMany();
    const retryRequest = lastClientRequest(proc, 'thread/resume');
    // The timed-out request's reply lands before the retry's.
    emitServerMessage(proc, {
      id: timedOutRequest.id,
      result: { thread: { id: 'thread-1', turns: [] } },
    });
    await flushMany();
    expect(clientRequests(proc, 'thread/unsubscribe')).toEqual([]);

    emitServerMessage(proc, {
      id: retryRequest.id,
      result: { thread: { id: 'thread-1', turns: [] } },
    });
    await retried;
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', items: [], status: 'completed', error: null },
      },
    });
    await flushMany();

    expect(clientRequests(proc, 'thread/unsubscribe')).toEqual([]);
    expect(connection.resolveOwnerForThread('thread-1')).toBe(owner);
    expect(handleConnectionNotification).toHaveBeenCalledWith(
      'turn/completed',
      expect.anything(),
      undefined,
    );
  });

  it('recycles an unresponsive worker when no other owner has live work', async () => {
    const owner = ownerStub();
    const idlePeer = ownerStub();
    const { proc, connection } = await startConnection([owner, idlePeer]);

    expect(connection.recycleUnresponsiveProcess(owner)).toBe(true);

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(connection.isInitialized()).toBe(false);
    expect(owner.markProcessSuspended).toHaveBeenCalledTimes(1);
    expect(idlePeer.markProcessSuspended).toHaveBeenCalledTimes(1);
    expect(diagnosticsOfKind(STOPPED_DIAGNOSTIC_KIND)).toEqual([
      expect.objectContaining({ trigger: 'unresponsive-thread-request' }),
    ]);

    const replacement = new MockChildProcess();
    spawnMock.mockReturnValue(replacement);
    const reinitialization = connection.ensureInitialized();
    await flushMany();
    emitServerMessage(replacement, {
      id: lastClientRequest(replacement, 'initialize').id,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await reinitialization;
    expect(connection.isInitialized()).toBe(true);
  });

  it('does not recycle a worker another owner is using', async () => {
    const owner = ownerStub();
    const busyPeer = ownerStub({ hasActiveTurn: () => true });
    const { proc, connection } = await startConnection([owner, busyPeer]);

    expect(connection.recycleUnresponsiveProcess(owner)).toBe(false);

    expect(proc.kill).not.toHaveBeenCalled();
    expect(connection.isInitialized()).toBe(true);
    expect(busyPeer.markProcessSuspended).not.toHaveBeenCalled();
  });

  it('fails ownerless requests left on a recycled worker', async () => {
    const owner = ownerStub();
    const { connection } = await startConnection([owner]);
    const ownerless = settled(connection.request('account/read', {}));
    await flushMany();

    expect(connection.recycleUnresponsiveProcess(owner)).toBe(true);

    const failure = await ownerless;
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('restarted');
  });
});
