// A thread can stay loaded, with its writer, in the app-server process that
// last owned it: `thread/unsubscribe` does not unload it (verified live against
// codex-cli 0.159.0 with scripts/probes/codex-thread-lifecycle/probe.mjs).
// Another profile's worker then cannot resume it ("already has an active
// writer") until the first process exits. When that process belongs to this
// pool and has no live work, the pool stops it and the resume is retried. See
// docs/codex-app-server.md, "Writer handoff between workers".
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

import type { CodexAppServerConnection } from '../connection';
import {
  CodexAppServerPool,
  isCodexThreadWriterConflictError,
} from '../connection';
import {
  configureCodexRuntimeHostHooks,
  resetCodexRuntimeHostHooksForTests,
  type CodexRuntimeDiagnostic,
  type CodexRuntimeResourceRegistrationHandle,
} from '../host-hooks';

const recordDiagnosticMock = jest.fn<void, [CodexRuntimeDiagnostic]>();

const THREAD_ID = '01a116b7-c424-7bd3-bdf9-677cba268a2e';
const WRITER_MESSAGE = `thread ${THREAD_ID} already has an active writer`;
const HANDOFF_DIAGNOSTIC_KIND: string = 'codex_app_server_writer_handoff';
const STOPPED_DIAGNOSTIC_KIND: string = 'resource_codex_app_server_stopped';

class MockChildProcess extends EventEmitter {
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

  constructor(readonly pid: number) {
    super();
    this.stdin.on('data', (chunk: unknown) => {
      this.clientOutput += String(chunk);
    });
  }
}

function ownerStub(
  overrides: Partial<CodexAppServerConnectionOwner> = {},
): CodexAppServerConnectionOwner {
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
    ...overrides,
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

function isWriterConflictRejection(outcome: unknown): boolean {
  return isCodexThreadWriterConflictError(
    Reflect.get(Object(outcome), 'error'),
  );
}

function settled(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value: unknown) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

async function initialize(
  connection: CodexAppServerConnection,
  proc: MockChildProcess,
): Promise<void> {
  const initialization = connection.ensureInitialized();
  await flushMany();
  emitServerMessage(proc, {
    id: lastClientRequest(proc, 'initialize').id,
    result: { userAgent: 'test', codexHome: '/tmp/.codex' },
  });
  await initialization;
}

/**
 * The first profile's worker loads the thread for an owner and then
 * unsubscribes it, as a released idle chat does. It stays loaded there.
 */
async function leaveIdleWriter(
  pool: CodexAppServerPool,
  holderOwner: CodexAppServerConnectionOwner,
): Promise<{ holder: CodexAppServerConnection; holderProc: MockChildProcess }> {
  const holderProc = new MockChildProcess(5001);
  spawnMock.mockReturnValueOnce(holderProc);
  const holder = pool.acquire({
    profileKey: 'profile-a',
    owner: holderOwner,
    processCallbacks: {},
  });
  await initialize(holder, holderProc);
  holder.registerRootThread(THREAD_ID, holderOwner);
  // Released idle client: unsubscribe is sent, then the owner's routes are
  // removed before the reply arrives.
  holder.unsubscribeThreadBestEffort(THREAD_ID);
  holder.unregisterThread(THREAD_ID, holderOwner);
  await flushMany();
  emitServerMessage(holderProc, {
    id: lastClientRequest(holderProc, 'thread/unsubscribe').id,
    result: { status: 'unsubscribed' },
  });
  await flushMany();
  return { holder, holderProc };
}

async function acquireResumer(
  pool: CodexAppServerPool,
  owner: CodexAppServerConnectionOwner,
): Promise<{
  resumer: CodexAppServerConnection;
  resumerProc: MockChildProcess;
}> {
  const resumerProc = new MockChildProcess(5002);
  spawnMock.mockReturnValueOnce(resumerProc);
  const resumer = pool.acquire({
    profileKey: 'profile-b',
    owner,
    processCallbacks: {},
  });
  await initialize(resumer, resumerProc);
  return { resumer, resumerProc };
}

function rejectAsWriterConflict(proc: MockChildProcess): void {
  emitServerMessage(proc, {
    id: lastClientRequest(proc, 'thread/resume').id,
    error: { code: -32600, message: WRITER_MESSAGE },
  });
}

describe('CodexAppServerPool writer handoff', () => {
  beforeEach(() => {
    spawnMock.mockReset();
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
    resetCodexRuntimeHostHooksForTests();
  });

  it('recognizes only the app-server writer conflict', () => {
    expect(isCodexThreadWriterConflictError(new Error(WRITER_MESSAGE))).toBe(
      true,
    );
    expect(
      isCodexThreadWriterConflictError(new Error('thread x not found')),
    ).toBe(false);
    expect(isCodexThreadWriterConflictError(WRITER_MESSAGE)).toBe(false);
  });

  it('stops an idle worker that still holds the thread and retries the resume', async () => {
    const pool = new CodexAppServerPool();
    const markProcessSuspended = jest.fn();
    const holderOwner = ownerStub({ markProcessSuspended });
    const { holder, holderProc } = await leaveIdleWriter(pool, holderOwner);
    const owner = ownerStub();
    const { resumer, resumerProc } = await acquireResumer(pool, owner);

    const outcome = settled(
      resumer.request('thread/resume', { threadId: THREAD_ID }, { owner }),
    );
    await flushMany();
    rejectAsWriterConflict(resumerProc);
    await flushMany();

    expect(holderProc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(holder.isInitialized()).toBe(false);
    expect(markProcessSuspended).toHaveBeenCalled();
    expect(clientRequests(resumerProc, 'thread/resume')).toHaveLength(2);
    emitServerMessage(resumerProc, {
      id: lastClientRequest(resumerProc, 'thread/resume').id,
      result: { thread: { id: THREAD_ID, turns: [] } },
    });
    expect(await outcome).toEqual({
      value: { thread: { id: THREAD_ID, turns: [] } },
    });
    expect(diagnosticsOfKind(HANDOFF_DIAGNOSTIC_KIND)).toEqual([
      expect.objectContaining({ writerHandoffOutcome: 'released' }),
    ]);
    expect(diagnosticsOfKind(STOPPED_DIAGNOSTIC_KIND)).toEqual([
      expect.objectContaining({ trigger: 'writer-handoff' }),
    ]);
    expect(JSON.stringify(recordDiagnosticMock.mock.calls)).not.toContain(
      THREAD_ID,
    );
  });

  it('does not stop a worker that another owner is using', async () => {
    const pool = new CodexAppServerPool();
    const holderOwner = ownerStub();
    const { holderProc } = await leaveIdleWriter(pool, holderOwner);
    const busyOwner = ownerStub({ hasActiveTurn: () => true });
    pool.acquire({
      profileKey: 'profile-a',
      owner: busyOwner,
      processCallbacks: {},
    });
    const owner = ownerStub();
    const { resumer, resumerProc } = await acquireResumer(pool, owner);

    const outcome = settled(
      resumer.request('thread/resume', { threadId: THREAD_ID }, { owner }),
    );
    await flushMany();
    rejectAsWriterConflict(resumerProc);
    await flushMany();

    expect(holderProc.kill).not.toHaveBeenCalled();
    expect(clientRequests(resumerProc, 'thread/resume')).toHaveLength(1);
    expect(isWriterConflictRejection(await outcome)).toBe(true);
    expect(diagnosticsOfKind(HANDOFF_DIAGNOSTIC_KIND)).toEqual([
      expect.objectContaining({ writerHandoffOutcome: 'holder-busy' }),
    ]);
  });

  it('does not stop a worker that has since resumed the thread', async () => {
    const pool = new CodexAppServerPool();
    const holderOwner = ownerStub();
    const { holder, holderProc } = await leaveIdleWriter(pool, holderOwner);
    holder.registerRootThread(THREAD_ID, holderOwner);
    const owner = ownerStub();
    const { resumer, resumerProc } = await acquireResumer(pool, owner);

    const outcome = settled(
      resumer.request('thread/resume', { threadId: THREAD_ID }, { owner }),
    );
    await flushMany();
    rejectAsWriterConflict(resumerProc);
    await flushMany();

    expect(holderProc.kill).not.toHaveBeenCalled();
    expect(isWriterConflictRejection(await outcome)).toBe(true);
    expect(diagnosticsOfKind(HANDOFF_DIAGNOSTIC_KIND)).toEqual([
      expect.objectContaining({ writerHandoffOutcome: 'no-local-holder' }),
    ]);
  });

  it('surfaces a writer held outside the pool without stopping anything', async () => {
    const pool = new CodexAppServerPool();
    const idlePeerProc = new MockChildProcess(5003);
    spawnMock.mockReturnValueOnce(idlePeerProc);
    const idlePeer = pool.acquire({
      profileKey: 'profile-a',
      owner: ownerStub(),
      processCallbacks: {},
    });
    await initialize(idlePeer, idlePeerProc);
    const owner = ownerStub();
    const { resumer, resumerProc } = await acquireResumer(pool, owner);

    const outcome = settled(
      resumer.request('thread/resume', { threadId: THREAD_ID }, { owner }),
    );
    await flushMany();
    rejectAsWriterConflict(resumerProc);
    await flushMany();

    expect(idlePeerProc.kill).not.toHaveBeenCalled();
    expect(clientRequests(resumerProc, 'thread/resume')).toHaveLength(1);
    expect(isWriterConflictRejection(await outcome)).toBe(true);
  });

  it('retries the handoff only once', async () => {
    const pool = new CodexAppServerPool();
    const { holderProc } = await leaveIdleWriter(pool, ownerStub());
    const owner = ownerStub();
    const { resumer, resumerProc } = await acquireResumer(pool, owner);

    const outcome = settled(
      resumer.request('thread/resume', { threadId: THREAD_ID }, { owner }),
    );
    await flushMany();
    rejectAsWriterConflict(resumerProc);
    await flushMany();
    expect(holderProc.kill).toHaveBeenCalled();
    rejectAsWriterConflict(resumerProc);
    await flushMany();

    expect(clientRequests(resumerProc, 'thread/resume')).toHaveLength(2);
    expect(isWriterConflictRejection(await outcome)).toBe(true);
  });
});
