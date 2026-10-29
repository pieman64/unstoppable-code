// A `thread/resume` that races the app-server's own shutdown of the same thread
// is rejected with "thread <id> is closing; retry thread/resume after the
// thread is closed". The request happens before `turn/start`, so the connection
// retries it instead of failing the caller's turn. See docs/codex-app-server.md,
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
  spawn: spawnMock,
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
  isCodexThreadClosingError,
} from '../connection';
import {
  configureCodexRuntimeHostHooks,
  resetCodexRuntimeHostHooksForTests,
  type CodexRuntimeDiagnostic,
  type CodexRuntimeResourceRegistrationHandle,
} from '../host-hooks';

const recordDiagnosticMock = jest.fn<void, [CodexRuntimeDiagnostic]>();

const THREAD_ID = '01a10835-c5b1-7f53-9a01-68411ee65cc4';
const CLOSING_MESSAGE = `thread ${THREAD_ID} is closing; retry thread/resume after the thread is closed`;
const CLOSE_WAIT_DIAGNOSTIC_KIND: string = 'codex_app_server_thread_close_wait';

class MockChildProcess extends EventEmitter {
  pid = 4291;
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

function ownerStub(): CodexAppServerConnectionOwner {
  return {
    hasActiveTurn: () => false,
    getActiveTurnInterruptTarget: () => null,
    cancelPendingTurnStart: jest.fn(),
    rejectActiveTurn: jest.fn(),
    markProcessSuspended: jest.fn(),
    markProcessFailed: jest.fn(),
    handleConnectionNotification: jest.fn(),
    handleRequestUserInput: jest.fn(() => Promise.resolve()),
    handleDynamicToolCall: jest.fn(() => Promise.resolve()),
    handleApprovalRequest: jest.fn(() => Promise.resolve()),
    handleMcpElicitation: jest.fn(() => Promise.resolve()),
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
  return parsed;
}

function resumeRequests(proc: MockChildProcess): Record<string, unknown>[] {
  return proc.clientOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseClientMessage)
    .filter((message) => message.method === 'thread/resume');
}

function lastResumeRequest(proc: MockChildProcess): Record<string, unknown> {
  const request = resumeRequests(proc).at(-1);
  if (!request) throw new Error('Missing thread/resume request');
  return request;
}

function rejectAsClosing(proc: MockChildProcess): void {
  emitServerMessage(proc, {
    id: lastResumeRequest(proc).id,
    error: { code: -32600, message: CLOSING_MESSAGE },
  });
}

function threadResult(): Record<string, unknown> {
  return { thread: { id: THREAD_ID, turns: [] } };
}

interface Observed {
  state: 'pending' | 'resolved' | 'rejected';
  error: unknown;
}

function observe(promise: Promise<unknown>): Observed {
  const record: Observed = { state: 'pending', error: undefined };
  void promise.then(
    () => {
      record.state = 'resolved';
    },
    (error: unknown) => {
      record.state = 'rejected';
      record.error = error;
    },
  );
  return record;
}

function closeWaitDiagnostics(): CodexRuntimeDiagnostic[] {
  return recordDiagnosticMock.mock.calls
    .map(([event]) => event)
    .filter((event) => event.kind === CLOSE_WAIT_DIAGNOSTIC_KIND);
}

async function startConnection(owner: CodexAppServerConnectionOwner): Promise<{
  proc: MockChildProcess;
  connection: CodexAppServerConnection;
}> {
  const proc = new MockChildProcess();
  spawnMock.mockReturnValue(proc);
  const connection = new CodexAppServerConnection('profile:thread-closing');
  connection.registerOwner(owner, {});
  const initialization = connection.ensureInitialized();
  await flush();
  emitServerMessage(proc, {
    id: 1,
    result: { userAgent: 'test', codexHome: '/tmp/.codex' },
  });
  await initialization;
  return { proc, connection };
}

function resume(
  connection: CodexAppServerConnection,
  owner: CodexAppServerConnectionOwner,
  signal?: AbortSignal,
): Promise<unknown> {
  return connection.request(
    'thread/resume',
    { threadId: THREAD_ID },
    { owner, ...(signal ? { signal } : {}) },
  );
}

describe('CodexAppServerConnection thread/resume while the thread is closing', () => {
  beforeEach(() => {
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
    jest.useRealTimers();
    resetCodexRuntimeHostHooksForTests();
  });

  it('retains independent route identities across release and clears only definitive closures', async () => {
    const owner = ownerStub();
    const { proc, connection } = await startConnection(owner);
    const peer = ownerStub();
    connection.registerOwner(peer, {});
    try {
      connection.registerRootThread('first', owner);
      connection.registerRootThread('second', peer);
      connection.recordLoadedThreadProviderRoute('first', 'route-a');
      connection.recordLoadedThreadProviderRoute('second', 'route-b');
      connection.unregisterThread('first', owner);
      connection.unsubscribeThreadBestEffort('first');
      connection.unregisterOwner(owner);
      expect(connection.loadedThreadProviderRoute('first')).toBe('route-a');
      connection.registerRootThread('first', peer);
      expect(connection.loadedThreadProviderRoute('first')).toBe('route-a');
      connection.unregisterThread('first', peer);
      emitServerMessage(proc, {
        method: 'thread/closed',
        params: { threadId: 'first' },
      });
      await flushMany();
      expect(connection.loadedThreadProviderRoute('first')).toBeUndefined();
      expect(connection.loadedThreadProviderRoute('second')).toBe('route-b');
      // An owner reattachment alone cannot prove a closed thread reopened.
      connection.registerRootThread('first', peer);
      connection.recordLoadedThreadProviderRoute('first', 'late-route');
      expect(connection.loadedThreadProviderRoute('first')).toBeUndefined();
      const unsubscribe = proc.clientOutput
        .split('\n')
        .filter(Boolean)
        .map(parseClientMessage)
        .find((message) => message.method === 'thread/unsubscribe');
      if (!unsubscribe) throw new Error('Expected thread/unsubscribe');
      emitServerMessage(proc, {
        id: unsubscribe.id,
        result: { status: 'unsubscribed' },
      });
      await flushMany();
      expect(connection.suspendIdleProcessIfIdle()).toBe(true);
      expect(connection.loadedThreadProviderRoute('second')).toBeUndefined();
      connection.recordLoadedThreadProviderRoute('second', 'late-route');
      expect(connection.loadedThreadProviderRoute('second')).toBeUndefined();
    } finally {
      await connection.terminateForFinalRelease();
    }
  });

  it('recognizes only the app-server closing rejection', () => {
    expect(isCodexThreadClosingError(new Error(CLOSING_MESSAGE))).toBe(true);
    expect(
      isCodexThreadClosingError(new Error('no rollout found for thread id x')),
    ).toBe(false);
    expect(isCodexThreadClosingError(new Error('thread x not found'))).toBe(
      false,
    );
    expect(isCodexThreadClosingError(CLOSING_MESSAGE)).toBe(false);
  });

  it('retries after a backoff and resolves once the thread can be resumed', async () => {
    const owner = ownerStub();
    const { proc, connection } = await startConnection(owner);

    const outcome = observe(resume(connection, owner));
    await flushMany();
    rejectAsClosing(proc);
    await flushMany();

    expect(outcome.state).toBe('pending');
    expect(resumeRequests(proc)).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(250);
    await flushMany();
    expect(resumeRequests(proc)).toHaveLength(2);

    emitServerMessage(proc, {
      id: lastResumeRequest(proc).id,
      result: threadResult(),
    });
    await flushMany();

    expect(outcome.state).toBe('resolved');
    expect(closeWaitDiagnostics()).toEqual([
      expect.objectContaining({
        closeWaitOutcome: 'resumed',
        closeWaitRetryCount: 1,
        closedNotificationObserved: false,
      }),
    ]);
  });

  it('retries as soon as the app-server reports thread/closed', async () => {
    const handleConnectionNotification = jest.fn();
    const owner = { ...ownerStub(), handleConnectionNotification };
    const { proc, connection } = await startConnection(owner);

    const outcome = observe(resume(connection, owner));
    await flushMany();
    rejectAsClosing(proc);
    await flushMany();
    expect(resumeRequests(proc)).toHaveLength(1);

    emitServerMessage(proc, {
      method: 'thread/closed',
      params: { threadId: THREAD_ID },
    });
    await flushMany();

    // No timer advanced: the notification alone released the wait.
    expect(resumeRequests(proc)).toHaveLength(2);
    emitServerMessage(proc, {
      id: lastResumeRequest(proc).id,
      result: threadResult(),
    });
    await flushMany();

    expect(outcome.state).toBe('resolved');
    expect(handleConnectionNotification).not.toHaveBeenCalledWith(
      'thread/closed',
      expect.anything(),
    );
    expect(closeWaitDiagnostics()).toEqual([
      expect.objectContaining({
        closeWaitOutcome: 'resumed',
        closedNotificationObserved: true,
      }),
    ]);
  });

  it('surfaces the original rejection once the closing budget is spent', async () => {
    const owner = ownerStub();
    const { proc, connection } = await startConnection(owner);

    const outcome = observe(resume(connection, owner));
    await flushMany();
    for (let attempt = 0; attempt < 40 && outcome.state === 'pending'; ) {
      attempt += 1;
      if (resumeRequests(proc).length === attempt) rejectAsClosing(proc);
      await flushMany();
      await jest.advanceTimersByTimeAsync(4_000);
      await flushMany();
    }

    expect(outcome.state).toBe('rejected');
    expect(isCodexThreadClosingError(outcome.error)).toBe(true);
    expect(resumeRequests(proc).length).toBeGreaterThan(1);
    // 250 + 500 + 1000 + 2000 ms, then 4 s steps inside a 30 s budget.
    expect(resumeRequests(proc).length).toBeLessThanOrEqual(12);
    expect(closeWaitDiagnostics()).toEqual([
      expect.objectContaining({ closeWaitOutcome: 'exhausted' }),
    ]);
  });

  it('does not retry an unrelated thread/resume rejection and keeps its code', async () => {
    const owner = ownerStub();
    const { proc, connection } = await startConnection(owner);

    const outcome = observe(resume(connection, owner));
    await flushMany();
    emitServerMessage(proc, {
      id: lastResumeRequest(proc).id,
      error: { code: -32001, message: 'authentication required' },
    });
    await flushMany();
    await jest.advanceTimersByTimeAsync(5_000);

    expect(outcome.state).toBe('rejected');
    expect(outcome.error).toMatchObject({
      message: 'authentication required',
      code: -32001,
      method: 'thread/resume',
    });
    expect(resumeRequests(proc)).toHaveLength(1);
    expect(closeWaitDiagnostics()).toEqual([]);
  });

  it('stops waiting when the caller aborts', async () => {
    const owner = ownerStub();
    const { proc, connection } = await startConnection(owner);
    const controller = new AbortController();

    const outcome = observe(resume(connection, owner, controller.signal));
    await flushMany();
    rejectAsClosing(proc);
    await flushMany();

    controller.abort(new Error('turn_cancelled'));
    await flushMany();

    expect(outcome.state).toBe('rejected');
    expect(outcome.error).toMatchObject({ message: 'turn_cancelled' });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(resumeRequests(proc)).toHaveLength(1);
    expect(closeWaitDiagnostics()).toEqual([
      expect.objectContaining({ closeWaitOutcome: 'aborted' }),
    ]);
  });

  it('does not resume for an owner released during the wait', async () => {
    const owner = ownerStub();
    const { proc, connection } = await startConnection(owner);

    const outcome = observe(resume(connection, owner));
    await flushMany();
    rejectAsClosing(proc);
    await flushMany();

    connection.unregisterOwner(owner);
    await jest.advanceTimersByTimeAsync(250);
    await flushMany();

    expect(outcome.state).toBe('rejected');
    expect(isCodexThreadClosingError(outcome.error)).toBe(true);
    expect(resumeRequests(proc)).toHaveLength(1);
  });
});
