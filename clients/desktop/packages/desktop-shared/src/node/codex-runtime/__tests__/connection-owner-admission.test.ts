// Per-owner notification admission on a pooled Codex app-server connection.
// One owner's pending admission (for example a slow durable chat commit) must
// not stop the shared stdout for other owners, while each owner still sees its
// own frames in pipe order. See docs/codex-app-server.md, "Per-owner
// notification admission".
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

import { CodexAppServerConnection } from '../connection';
import {
  configureCodexRuntimeHostHooks,
  resetCodexRuntimeHostHooksForTests,
  type CodexRuntimeDiagnostic,
  type CodexRuntimeResourceRegistrationHandle,
} from '../host-hooks';

const recordDiagnosticMock = jest.fn<void, [CodexRuntimeDiagnostic]>();

const STDOUT_HOLD_DIAGNOSTIC_KIND: string = 'codex_app_server_stdout_hold';

function isStdoutHoldDiagnostic(event: CodexRuntimeDiagnostic): boolean {
  return event.kind === STDOUT_HOLD_DIAGNOSTIC_KIND;
}

class MockChildProcess extends EventEmitter {
  pid = 4290;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function collectClientMessages(
  proc: MockChildProcess,
): Array<Record<string, unknown>> {
  return proc.clientOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseClientMessage);
}

function findClientRequest(
  proc: MockChildProcess,
  method: string,
): Record<string, unknown> {
  const request = collectClientMessages(proc)
    .filter((message) => message.method === method)
    .at(-1);
  if (!request) throw new Error(`Missing ${method} request`);
  return request;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function sequenceOf(notification: Record<string, unknown>): number | null {
  const params = notification.params;
  if (
    typeof params !== 'object' ||
    params === null ||
    !('sequence' in params) ||
    typeof params.sequence !== 'number'
  ) {
    return null;
  }
  return params.sequence;
}

interface Observed<T> {
  readonly state: 'pending' | 'resolved' | 'rejected';
  readonly value: T | undefined;
  readonly error: unknown;
}

function observe<T>(promise: Promise<T>): Observed<T> {
  const record: {
    state: 'pending' | 'resolved' | 'rejected';
    value: T | undefined;
    error: unknown;
  } = { state: 'pending', value: undefined, error: undefined };
  void promise.then(
    (value) => {
      record.state = 'resolved';
      record.value = value;
    },
    (error: unknown) => {
      record.state = 'rejected';
      record.error = error;
    },
  );
  return record;
}

/**
 * Test-only queue and diagnostic thresholds. Declared as a non-literal
 * variable so the red phase compiled before these options existed.
 */
interface TestConnectionOptions {
  allowOwnerlessStartup?: boolean;
  stdoutQueueHighWaterBytes?: number;
  stdoutQueueLowWaterBytes?: number;
  longStdoutHoldThresholdMs?: number;
}

async function startSharedConnection(
  owners: Array<[CodexAppServerConnectionOwner, string]>,
  testOptions: TestConnectionOptions = {},
): Promise<{
  proc: MockChildProcess;
  connection: CodexAppServerConnection;
}> {
  const proc = new MockChildProcess();
  spawnMock.mockReturnValue(proc);
  const options: TestConnectionOptions = {
    allowOwnerlessStartup: false,
    ...testOptions,
  };
  const connection = new CodexAppServerConnection(
    'profile:owner-lanes',
    undefined,
    undefined,
    options,
  );
  for (const [owner, threadId] of owners) {
    connection.registerOwner(owner, {});
    connection.registerRootThread(threadId, owner);
  }
  const initialization = connection.ensureInitialized();
  await flush();
  emitServerMessage(proc, {
    id: 1,
    result: { userAgent: 'test', codexHome: '/tmp/.codex' },
  });
  await initialization;
  return { proc, connection };
}

function notify(
  proc: MockChildProcess,
  threadId: string,
  sequence: number,
  extra: Record<string, unknown> = {},
): void {
  emitServerMessage(proc, {
    method: 'item/started',
    params: { threadId, sequence, ...extra },
  });
}

describe('CodexAppServerConnection per-owner notification admission', () => {
  beforeEach(() => {
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

  it('delivers a peer owner thread/resume response while another owner admission is held', async () => {
    const heldOwner = ownerStub();
    const peerOwner = ownerStub();
    const hold = deferred();
    const heldReceived: Array<number | null> = [];
    const peerReceived: Array<number | null> = [];
    heldOwner.handleConnectionNotification = (
      _method,
      notification,
    ): Promise<void> | undefined => {
      const sequence = sequenceOf(notification);
      heldReceived.push(sequence);
      return sequence === 1 ? hold.promise : undefined;
    };
    peerOwner.handleConnectionNotification = (_method, notification): void => {
      peerReceived.push(sequenceOf(notification));
    };
    const { proc, connection } = await startSharedConnection([
      [heldOwner, 'held-thread'],
      [peerOwner, 'peer-thread'],
    ]);
    try {
      notify(proc, 'held-thread', 1);
      await flush();
      expect(heldReceived).toEqual([1]);

      const resume = observe(
        connection.request(
          'thread/resume',
          { threadId: 'peer-thread' },
          { owner: peerOwner },
        ),
      );
      await flush();
      const resumeRequest = findClientRequest(proc, 'thread/resume');
      notify(proc, 'held-thread', 2);
      emitServerMessage(proc, {
        id: resumeRequest.id,
        result: { thread: { id: 'peer-thread' } },
      });
      notify(proc, 'peer-thread', 3);
      await flushMany(4);

      expect(resume.state).toBe('resolved');
      expect(resume.value).toEqual({ thread: { id: 'peer-thread' } });
      expect(peerReceived).toEqual([3]);
      // The held owner's own later frame waits behind its admission.
      expect(heldReceived).toEqual([1]);

      hold.resolve();
      await flushMany(4);
      expect(heldReceived).toEqual([1, 2]);
    } finally {
      hold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it('does not time out a response that was read but is queued behind its own owner admission', async () => {
    const owner = ownerStub();
    const hold = deferred();
    owner.handleConnectionNotification = (
      _method,
      notification,
    ): Promise<void> | undefined =>
      sequenceOf(notification) === 1 ? hold.promise : undefined;
    const { proc, connection } = await startSharedConnection([
      [owner, 'own-thread'],
    ]);
    try {
      const request = observe(
        connection.request(
          'account/read',
          { refreshToken: false },
          { owner, timeoutMs: 100 },
        ),
      );
      await flush();
      const accountRequest = findClientRequest(proc, 'account/read');
      notify(proc, 'own-thread', 1);
      emitServerMessage(proc, {
        id: accountRequest.id,
        result: { account: null },
      });
      await flush();
      await delay(250);
      // The app-server answered within the deadline; Canopy-side admission
      // must not turn that into a timeout.
      expect(request.state).toBe('pending');

      hold.resolve();
      await flushMany(4);
      expect(request.state).toBe('resolved');
      expect(request.value).toEqual({ account: null });
    } finally {
      hold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it('preserves per-owner pipe order for notifications, responses, and fan-out', async () => {
    const heldOwner = ownerStub();
    const peerOwner = ownerStub();
    const firstHold = deferred();
    const secondHold = deferred();
    const heldLog: string[] = [];
    const peerLog: string[] = [];
    const label = (
      method: string,
      notification: Record<string, unknown>,
    ): string =>
      method === 'account/updated'
        ? 'account'
        : `n${String(sequenceOf(notification))}`;
    heldOwner.handleConnectionNotification = (
      method,
      notification,
    ): Promise<void> | undefined => {
      heldLog.push(label(method, notification));
      const sequence = sequenceOf(notification);
      if (sequence === 1) return firstHold.promise;
      if (sequence === 4) return secondHold.promise;
      return undefined;
    };
    peerOwner.handleConnectionNotification = (method, notification): void => {
      peerLog.push(label(method, notification));
    };
    const { proc, connection } = await startSharedConnection([
      [heldOwner, 'held-thread'],
      [peerOwner, 'peer-thread'],
    ]);
    try {
      const heldRequest = connection.request(
        'account/read',
        { refreshToken: false },
        { owner: heldOwner },
      );
      void heldRequest.then(
        () => heldLog.push('response'),
        () => heldLog.push('rejected'),
      );
      await flush();
      const accountRequest = findClientRequest(proc, 'account/read');
      notify(proc, 'held-thread', 1);
      notify(proc, 'held-thread', 2);
      notify(proc, 'peer-thread', 3);
      emitServerMessage(proc, {
        method: 'account/updated',
        params: { authMode: null },
      });
      notify(proc, 'held-thread', 4);
      emitServerMessage(proc, {
        id: accountRequest.id,
        result: { account: null },
      });
      notify(proc, 'held-thread', 5);
      notify(proc, 'peer-thread', 6);
      await flushMany(4);

      expect(peerLog).toEqual(['n3', 'account', 'n6']);
      expect(heldLog).toEqual(['n1']);

      firstHold.resolve();
      await flushMany(4);
      // The response was read after n4, so it must wait for n4's admission.
      expect(heldLog).toEqual(['n1', 'n2', 'account', 'n4']);

      secondHold.resolve();
      await flushMany(4);
      // The response is delivered (resolved) before n5 in the synchronous
      // drain; its promise continuation necessarily runs after that drain.
      // The ordering guarantee is the absence of 'response' above.
      expect(heldLog).toEqual(['n1', 'n2', 'account', 'n4', 'n5', 'response']);
      expect(peerLog).toEqual(['n3', 'account', 'n6']);
    } finally {
      firstHold.resolve();
      secondHold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it('pauses shared stdout above the retained-byte high-water mark and resumes below low water', async () => {
    const heldOwner = ownerStub();
    const peerOwner = ownerStub();
    const hold = deferred();
    let heldReceived = 0;
    const peerReceived: Array<number | null> = [];
    heldOwner.handleConnectionNotification = (): Promise<void> => {
      heldReceived += 1;
      return heldReceived === 1 ? hold.promise : Promise.resolve();
    };
    peerOwner.handleConnectionNotification = (_method, notification): void => {
      peerReceived.push(sequenceOf(notification));
    };
    const { proc, connection } = await startSharedConnection(
      [
        [heldOwner, 'held-thread'],
        [peerOwner, 'peer-thread'],
      ],
      {
        stdoutQueueHighWaterBytes: 8 * 1024,
        stdoutQueueLowWaterBytes: 4 * 1024,
      },
    );
    try {
      notify(proc, 'held-thread', 0);
      await flush();
      // Below the cap the peer is unaffected by the held owner.
      notify(proc, 'peer-thread', 100);
      await flushMany(2);
      expect(peerReceived).toEqual([100]);

      for (let sequence = 1; sequence <= 12; sequence += 1) {
        notify(proc, 'held-thread', sequence, { payload: 'x'.repeat(1024) });
      }
      await flushMany(2);
      // More than 8 KiB is now retained for the held owner, so the pipe is
      // globally paused and the peer frame behind it stays unread.
      notify(proc, 'peer-thread', 101);
      await flushMany(4);
      expect(peerReceived).toEqual([100]);
      expect(heldReceived).toBe(1);

      hold.resolve();
      await flushMany();
      expect(heldReceived).toBe(13);
      expect(peerReceived).toEqual([100, 101]);
    } finally {
      hold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it('does not expire request timeouts while stdout is paused by the byte cap', async () => {
    const heldOwner = ownerStub();
    const peerOwner = ownerStub();
    const hold = deferred();
    let heldReceived = 0;
    heldOwner.handleConnectionNotification = (): Promise<void> => {
      heldReceived += 1;
      return heldReceived === 1 ? hold.promise : Promise.resolve();
    };
    const { proc, connection } = await startSharedConnection(
      [
        [heldOwner, 'held-thread'],
        [peerOwner, 'peer-thread'],
      ],
      {
        stdoutQueueHighWaterBytes: 4 * 1024,
        stdoutQueueLowWaterBytes: 2 * 1024,
      },
    );
    try {
      const peerRequest = observe(
        connection.request(
          'account/read',
          { refreshToken: false },
          { owner: peerOwner, timeoutMs: 100 },
        ),
      );
      await flush();
      const accountRequest = findClientRequest(proc, 'account/read');
      for (let sequence = 0; sequence <= 8; sequence += 1) {
        notify(proc, 'held-thread', sequence, { payload: 'x'.repeat(1024) });
      }
      await flushMany(2);
      // The reply sits unread behind the global pause.
      emitServerMessage(proc, {
        id: accountRequest.id,
        result: { account: null },
      });
      await delay(250);
      expect(peerRequest.state).toBe('pending');

      hold.resolve();
      await flushMany();
      expect(peerRequest.state).toBe('resolved');
      expect(peerRequest.value).toEqual({ account: null });
    } finally {
      hold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it('reports one content-free diagnostic and one warning for a long owner admission hold', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const heldOwner = ownerStub();
    const peerOwner = ownerStub();
    const hold = deferred();
    heldOwner.handleConnectionNotification = (
      _method,
      notification,
    ): Promise<void> | undefined =>
      sequenceOf(notification) === 1 ? hold.promise : undefined;
    const { proc, connection } = await startSharedConnection(
      [
        [heldOwner, 'held-thread'],
        [peerOwner, 'peer-thread'],
      ],
      { longStdoutHoldThresholdMs: 50 },
    );
    try {
      const heldRequest = connection.request(
        'account/read',
        { refreshToken: false },
        { owner: heldOwner },
      );
      await flush();
      const accountRequest = findClientRequest(proc, 'account/read');
      notify(proc, 'held-thread', 1, { secret: 'PROMPT-TEXT-MUST-NOT-LEAK' });
      notify(proc, 'held-thread', 2, { secret: 'PROMPT-TEXT-MUST-NOT-LEAK' });
      emitServerMessage(proc, {
        id: accountRequest.id,
        result: { account: null },
      });
      await flush();
      await delay(200);
      hold.resolve();
      await heldRequest;
      await flushMany(2);

      const holdDiagnostics = recordDiagnosticMock.mock.calls
        .map(([event]) => event)
        .filter((event) => isStdoutHoldDiagnostic(event));
      expect(holdDiagnostics).toHaveLength(1);
      const [diagnostic] = holdDiagnostics;
      expect(diagnostic).toMatchObject({
        version: 1,
        kind: 'codex_app_server_stdout_hold',
        holdKind: 'owner-admission',
        holdOutcome: 'released',
        queuedFrameCount: 2,
        responseQueued: true,
        appProcessId: process.pid,
        codexAppServerProcessId: proc.pid,
      });
      // Exactly these content-free fields; nothing else is recorded.
      expect(Object.keys(diagnostic ?? {}).sort()).toEqual(
        [
          'appProcessId',
          'codexAppServerProcessId',
          'holdDurationMs',
          'holdKind',
          'holdOutcome',
          'kind',
          'queuedFrameBytes',
          'queuedFrameCount',
          'responseQueued',
          'timestamp',
          'version',
        ].sort(),
      );
      expect(typeof Reflect.get(diagnostic ?? {}, 'timestamp')).toBe('string');
      const serialized = JSON.stringify(diagnostic);
      expect(serialized).not.toContain('PROMPT-TEXT');
      expect(serialized).not.toContain('held-thread');
      const durationMs: unknown = Reflect.get(
        holdDiagnostics[0] ?? {},
        'holdDurationMs',
      );
      const queuedBytes: unknown = Reflect.get(
        holdDiagnostics[0] ?? {},
        'queuedFrameBytes',
      );
      expect(durationMs).toBeGreaterThanOrEqual(50);
      expect(queuedBytes).toBeGreaterThan(0);

      const holdWarnings = warn.mock.calls.filter((call) =>
        call.map(String).join(' ').includes('admission held'),
      );
      expect(holdWarnings).toHaveLength(1);
      expect(JSON.stringify(holdWarnings)).not.toContain('PROMPT-TEXT');
      expect(JSON.stringify(holdWarnings)).not.toContain('held-thread');
    } finally {
      hold.resolve();
      warn.mockRestore();
      await connection.terminateForFinalRelease();
    }
  });

  it('does not report a diagnostic for a short admission hold', async () => {
    const owner = ownerStub();
    owner.handleConnectionNotification = (): Promise<void> => delay(5);
    const { proc, connection } = await startSharedConnection([
      [owner, 'own-thread'],
    ]);
    try {
      notify(proc, 'own-thread', 1);
      notify(proc, 'own-thread', 2);
      await delay(50);
      await flushMany(2);
      expect(
        recordDiagnosticMock.mock.calls.filter(([event]) =>
          isStdoutHoldDiagnostic(event),
        ),
      ).toHaveLength(0);
    } finally {
      await connection.terminateForFinalRelease();
    }
  });

  it('fails closed for a server request queued behind a retired owner', async () => {
    const retiredOwner = ownerStub();
    const peerOwner = ownerStub();
    const hold = deferred();
    retiredOwner.handleConnectionNotification = (): Promise<void> =>
      hold.promise;
    const approvalHandler = jest.fn(() => Promise.resolve());
    retiredOwner.handleApprovalRequest = approvalHandler;
    const { proc, connection } = await startSharedConnection([
      [retiredOwner, 'retired-thread'],
      [peerOwner, 'peer-thread'],
    ]);
    try {
      notify(proc, 'retired-thread', 1);
      emitServerMessage(proc, {
        id: 'approval-1',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'retired-thread', turnId: 't', itemId: 'i' },
      });
      await flushMany(2);
      expect(approvalHandler).not.toHaveBeenCalled();

      connection.unregisterThread('retired-thread', retiredOwner);
      connection.unregisterOwner(retiredOwner);
      await flushMany(4);
      expect(approvalHandler).not.toHaveBeenCalled();
      expect(
        collectClientMessages(proc).find(
          (message) => message.id === 'approval-1',
        ),
      ).toEqual({ id: 'approval-1', result: { decision: 'decline' } });
    } finally {
      hold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it('delivers a server request in order after its owner admission settles', async () => {
    const owner = ownerStub();
    const hold = deferred();
    const log: string[] = [];
    owner.handleConnectionNotification = (
      _method,
      notification,
    ): Promise<void> | undefined => {
      log.push(`n${String(sequenceOf(notification))}`);
      return sequenceOf(notification) === 1 ? hold.promise : undefined;
    };
    owner.handleApprovalRequest = (): Promise<void> => {
      log.push('approval');
      return Promise.resolve();
    };
    const { proc, connection } = await startSharedConnection([
      [owner, 'own-thread'],
    ]);
    try {
      notify(proc, 'own-thread', 1);
      emitServerMessage(proc, {
        id: 'approval-2',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'own-thread', turnId: 't', itemId: 'i' },
      });
      notify(proc, 'own-thread', 2);
      await flushMany(2);
      expect(log).toEqual(['n1']);
      hold.resolve();
      await flushMany(4);
      expect(log).toEqual(['n1', 'approval', 'n2']);
    } finally {
      hold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it('rejects a queued response when the app-server exits while its owner is held', async () => {
    const owner = ownerStub();
    const hold = deferred();
    owner.handleConnectionNotification = (): Promise<void> => hold.promise;
    const { proc, connection } = await startSharedConnection([
      [owner, 'own-thread'],
    ]);
    try {
      const request = observe(
        connection.request('account/read', { refreshToken: false }, { owner }),
      );
      await flush();
      const accountRequest = findClientRequest(proc, 'account/read');
      notify(proc, 'own-thread', 1);
      emitServerMessage(proc, {
        id: accountRequest.id,
        result: { account: null },
      });
      await flushMany(2);
      expect(request.state).toBe('pending');
      proc.emit('exit', 1, null);
      await flushMany(2);
      expect(request.state).toBe('rejected');
      hold.resolve();
      await flushMany(2);
      expect(request.state).toBe('rejected');
    } finally {
      hold.resolve();
      await connection.terminateForFinalRelease();
    }
  });
});
