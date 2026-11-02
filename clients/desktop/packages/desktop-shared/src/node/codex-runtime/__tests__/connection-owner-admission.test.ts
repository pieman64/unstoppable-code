// Per-owner notification admission on a pooled Codex app-server connection.
// One owner's pending admission (for example a slow durable chat commit) must
// not stop the shared stdout for other owners, while each owner still sees its
// own frames in pipe order. See docs/codex-app-server.md, "Per-owner
// notification admission".
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type * as NodeChildProcess from 'node:child_process';
import type * as ProcessKill from '../../lib/process-kill';
import type {
  CodexAppServerConnectionOwner,
  CodexIngestionLagChange,
} from '../connection';
import type {
  CodexIngestionLagSample,
  CodexInteractiveOwner,
} from '../runtime-service';

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

// Signal the mock child directly: never send a real signal to its fake pid.
jest.mock('../../lib/process-kill', () => ({
  ...jest.requireActual<typeof ProcessKill>('../../lib/process-kill'),
  killChildProcessGroup: jest.fn(
    (
      child: { kill(signal?: NodeJS.Signals): boolean },
      signal?: NodeJS.Signals,
    ): void => {
      child.kill(signal);
    },
  ),
}));

jest.mock('../../../pipelines/config-paths', () => ({
  getBundledCodexBinaryPath: jest.fn(() => '/mock/codex'),
  getEnhancedEnv: jest.fn(() => ({ ...process.env })),
}));

import { CodexAppServerConnection } from '../connection';
import { CodexCapabilityStore } from '../capability-store';
import { createCodexRuntimeService } from '../runtime-service';
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

function dispatchIngestionLagSample(
  connection: CodexAppServerConnection,
  owner: CodexInteractiveOwner,
  sample: CodexIngestionLagSample,
): boolean {
  const ownerLanes: unknown = Reflect.get(connection, 'ownerLanes');
  if (typeof ownerLanes !== 'object' || ownerLanes === null) return false;
  const host: unknown = Reflect.get(ownerLanes, 'host');
  if (typeof host !== 'object' || host === null) return false;
  const report: unknown = Reflect.get(host, 'onIngestionLagSample');
  if (typeof report !== 'function') return false;
  Reflect.apply(report, host, [owner, sample]);
  return true;
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
  return Object.fromEntries(Object.entries(parsed));
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

function itemIdOf(notification: Record<string, unknown>): string {
  const params = notification.params;
  if (typeof params !== 'object' || params === null || !('item' in params))
    return '-';
  const item = params.item;
  if (
    typeof item !== 'object' ||
    item === null ||
    !('id' in item) ||
    typeof item.id !== 'string'
  )
    return '-';
  return item.id;
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
  stdoutOwnerHardLimitBytes?: number;
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

  it('extracts lifecycle timestamps, forwards lag transitions, and reads the current owner lag', async () => {
    const owner = ownerStub();
    const hold = deferred();
    const notifications: string[] = [];
    owner.handleConnectionNotification = (method): void | Promise<void> => {
      notifications.push(method);
      return method === 'item/started' ? hold.promise : undefined;
    };
    const lagChanges: CodexIngestionLagChange[] = [];
    owner.handleIngestionLagChange = (change): void => {
      lagChanges.push(change);
    };
    const startedAtMs = Date.now() - 6_000;
    const { proc, connection } = await startSharedConnection([
      [owner, 'lag-thread'],
    ]);
    try {
      emitServerMessage(proc, {
        method: 'item/started',
        params: {
          threadId: 'lag-thread',
          turnId: 'turn-1',
          startedAtMs,
          item: { id: 'started-item' },
        },
      });
      await flushMany(2);

      expect(lagChanges[0]).toMatchObject({
        outcome: 'entered',
        thresholdMs: 5_000,
        source: 'provider',
      });
      expect(lagChanges[0]?.lagMs).toBeGreaterThan(5_000);
      expect(connection.ingestionLag(owner)).toMatchObject({
        catchingUp: true,
        source: 'provider',
      });
      expect(connection.ingestionLag(owner)?.lagMs).toBeGreaterThan(5_000);

      const completedAtMs = Date.now() - 100;
      emitServerMessage(proc, {
        method: 'item/completed',
        params: {
          threadId: 'lag-thread',
          turnId: 'turn-1',
          completedAtMs,
          item: { id: 'completed-item' },
        },
      });
      await flushMany(2);
      hold.resolve();
      await flushMany(2);

      expect(notifications).toEqual(['item/started', 'item/completed']);
      expect(connection.ingestionLag(owner)).toEqual({
        lagMs: 0,
        catchingUp: false,
        source: 'receipt',
      });
      expect(lagChanges.map((change) => change.outcome)).toEqual([
        'entered',
        'drained',
      ]);
      expect(lagChanges[1]).toMatchObject({
        lagMs: 0,
        thresholdMs: 5_000,
        source: 'provider',
      });
    } finally {
      hold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it('delivers normally when an owner does not implement the optional lag hook', async () => {
    const owner = ownerStub();
    const hold = deferred();
    const handleNotification = jest.fn(() => hold.promise);
    owner.handleConnectionNotification = handleNotification;
    const startedAtMs = Date.now() - 6_000;
    const { proc, connection } = await startSharedConnection([
      [owner, 'optional-lag-thread'],
    ]);
    try {
      emitServerMessage(proc, {
        method: 'item/started',
        params: {
          threadId: 'optional-lag-thread',
          turnId: 'turn-1',
          startedAtMs,
          item: { id: 'started-item' },
        },
      });
      await flushMany(2);

      expect(handleNotification).toHaveBeenCalledTimes(1);
      expect(connection.ingestionLag(owner)?.catchingUp).toBe(true);
      expect(proc.exitCode).toBeNull();
    } finally {
      hold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it('ignores a throwing owner lag hook without interrupting transcript delivery', async () => {
    const owner = ownerStub();
    const hold = deferred();
    const handleNotification = jest.fn(() => hold.promise);
    owner.handleConnectionNotification = handleNotification;
    const throwingHook = jest.fn((): void => {
      throw new Error('lag observer failed');
    });
    owner.handleIngestionLagChange = throwingHook;
    const startedAtMs = Date.now() - 6_000;
    const { proc, connection } = await startSharedConnection([
      [owner, 'throwing-lag-thread'],
    ]);
    try {
      emitServerMessage(proc, {
        method: 'item/started',
        params: {
          threadId: 'throwing-lag-thread',
          turnId: 'turn-1',
          startedAtMs,
          item: { id: 'started-item' },
        },
      });
      await flushMany(2);

      expect(handleNotification).toHaveBeenCalledTimes(1);
      expect(throwingHook).toHaveBeenCalledTimes(1);
      expect(connection.ingestionLag(owner)?.catchingUp).toBe(true);
      expect(proc.exitCode).toBeNull();
    } finally {
      hold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it('forwards runtime-owner lag samples on a microtask while admission is pending', async () => {
    const owner: CodexInteractiveOwner = ownerStub();
    const hold = deferred();
    const notifications: string[] = [];
    const observedSamples: CodexIngestionLagSample[] = [];
    owner.handleConnectionNotification = (method): Promise<void> => {
      notifications.push(method);
      return hold.promise;
    };
    owner.handleIngestionLagSample = (sample): void => {
      observedSamples.push(sample);
    };
    const { proc, connection } = await startSharedConnection([
      [owner, 'sample-thread'],
    ]);

    try {
      notify(proc, 'sample-thread', 1);
      await flushMany(2);
      expect(notifications).toEqual(['item/started']);

      const firstSample: CodexIngestionLagSample = {
        lagMs: 5_100,
        source: 'receipt',
        sampledAtMs: Date.now(),
        catchingUp: true,
      };
      const secondSample: CodexIngestionLagSample = {
        ...firstSample,
        lagMs: 5_200,
        sampledAtMs: firstSample.sampledAtMs + 100,
      };

      expect(dispatchIngestionLagSample(connection, owner, firstSample)).toBe(
        true,
      );
      expect(dispatchIngestionLagSample(connection, owner, secondSample)).toBe(
        true,
      );
      expect(observedSamples).toEqual([]);

      await flush();

      expect(observedSamples).toEqual([firstSample, secondSample]);
      expect(notifications).toEqual(['item/started']);
    } finally {
      hold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it('isolates throwing and rejecting lag-sample observers from owner admission', async () => {
    const owner: CodexInteractiveOwner = ownerStub();
    const hold = deferred();
    let notificationCount = 0;
    let sampleCount = 0;
    owner.handleConnectionNotification = (): Promise<void> => {
      notificationCount += 1;
      return notificationCount === 1 ? hold.promise : Promise.resolve();
    };
    owner.handleIngestionLagSample = (): void | Promise<void> => {
      sampleCount += 1;
      if (sampleCount === 1) throw new Error('synchronous observer failure');
      return Promise.reject(new Error('asynchronous observer failure'));
    };
    const { proc, connection } = await startSharedConnection([
      [owner, 'sample-error-thread'],
    ]);

    try {
      notify(proc, 'sample-error-thread', 1);
      await flushMany(2);
      notify(proc, 'sample-error-thread', 2);

      const sample: CodexIngestionLagSample = {
        lagMs: 5_100,
        source: 'receipt',
        sampledAtMs: Date.now(),
        catchingUp: true,
      };
      expect(dispatchIngestionLagSample(connection, owner, sample)).toBe(true);
      expect(
        dispatchIngestionLagSample(connection, owner, {
          ...sample,
          sampledAtMs: sample.sampledAtMs + 1,
        }),
      ).toBe(true);

      await flushMany(2);
      expect(sampleCount).toBe(2);
      expect(notificationCount).toBe(1);
      expect(proc.exitCode).toBeNull();

      hold.resolve();
      await flushMany(2);
      expect(notificationCount).toBe(2);
      expect(proc.exitCode).toBeNull();
    } finally {
      hold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it.each(['turn/completed', 'error'])(
    'noninteractive %s waits for admitted transcript frames without delaying a peer turn',
    async (terminalMethod) => {
      const proc = new MockChildProcess();
      spawnMock.mockReturnValue(proc);
      const store = new CodexCapabilityStore('/unused/capabilities');
      jest
        .spyOn(store, 'publishSelectedRoots')
        .mockResolvedValue({ roots: [], rootContentIds: [] });
      jest.spyOn(store, 'writeLease').mockResolvedValue(undefined);
      jest.spyOn(store, 'releaseLease').mockResolvedValue(undefined);
      const service = createCodexRuntimeService({ capabilityStore: store });
      const hold = deferred();
      const finalAdmission = deferred();
      const events: string[] = [];
      const outcomes: Promise<unknown>[] = [];
      try {
        const firstHandle = service.startThread({
          params: { cwd: '/tmp/repo', selectedCapabilityRoots: [] },
          capabilitySnapshotId: 'snapshot',
        });
        await flushMany(2);
        emitServerMessage(proc, {
          id: findClientRequest(proc, 'initialize').id,
          result: { userAgent: 'test', codexHome: '/tmp/.codex' },
        });
        await flushMany(2);
        const answerThread = (id: unknown, threadId: string): void =>
          emitServerMessage(proc, {
            id,
            result: {
              thread: { id: threadId, turns: [] },
              model: 'test',
              modelProvider: 'openai',
            },
          });
        // Ambient MCP exclusion reads the effective config before each start.
        const answerConfigRead = async (): Promise<void> => {
          emitServerMessage(proc, {
            id: findClientRequest(proc, 'config/read').id,
            result: { config: {} },
          });
          await flushMany(2);
        };
        await answerConfigRead();
        answerThread(findClientRequest(proc, 'thread/start').id, 'first');
        const first = await firstHandle;
        const secondHandle = service.startThread({
          params: { cwd: '/tmp/repo', selectedCapabilityRoots: [] },
          capabilitySnapshotId: 'snapshot',
        });
        await flushMany(2);
        await answerConfigRead();
        answerThread(findClientRequest(proc, 'thread/start').id, 'second');
        const second = await secondHandle;
        const firstOutcome = first.runTurn({
          input: [],
          onEvent: (event): Promise<void> | undefined => {
            events.push(event.method);
            return event.method === 'item/started'
              ? hold.promise
              : event.method === 'item/completed'
                ? finalAdmission.promise
                : undefined;
          },
        });
        outcomes.push(firstOutcome);
        const secondOutcome = second.runTurn({ input: [] });
        outcomes.push(secondOutcome);
        let firstSettled = false;
        void firstOutcome.then(
          () => {
            firstSettled = true;
          },
          () => {
            firstSettled = true;
          },
        );
        await flushMany(2);
        const starts = collectClientMessages(proc).filter(
          (message) => message.method === 'turn/start',
        );
        starts.forEach((request, index): void => {
          emitServerMessage(proc, {
            id: request.id,
            result: {
              turn: {
                id: index === 0 ? 'first-turn' : 'second-turn',
                status: 'inProgress',
                items: [],
                error: null,
              },
            },
          });
        });
        await flushMany(2);
        emitServerMessage(proc, {
          method: 'item/started',
          params: {
            threadId: 'first',
            turnId: 'first-turn',
            item: { id: 'held' },
          },
        });
        emitServerMessage(proc, {
          method: 'item/completed',
          params: {
            threadId: 'first',
            turnId: 'first-turn',
            item: {
              id: 'message',
              type: 'agentMessage',
              text: 'Retained answer',
              phase: 'final_answer',
            },
          },
        });
        if (terminalMethod === 'error')
          emitServerMessage(proc, {
            method: 'error',
            params: {
              threadId: 'first',
              turnId: 'first-turn',
              willRetry: false,
              error: {
                message: 'terminal failure',
                codexErrorInfo: 'usageLimitExceeded',
              },
            },
          });
        // A non-retrying error settles the turn with its own details; the
        // failed turn's completion may still follow it.
        emitServerMessage(proc, {
          method: 'turn/completed',
          params: {
            threadId: 'first',
            turn: {
              id: 'first-turn',
              status: terminalMethod === 'error' ? 'failed' : 'completed',
              items: [],
              error:
                terminalMethod === 'error'
                  ? {
                      message: 'terminal failure',
                      codexErrorInfo: 'usageLimitExceeded',
                    }
                  : null,
            },
          },
        });
        emitServerMessage(proc, {
          method: 'turn/completed',
          params: {
            threadId: 'second',
            turn: {
              id: 'second-turn',
              status: 'completed',
              items: [],
              error: null,
            },
          },
        });
        const startedAt = Date.now();
        await expect(secondOutcome).resolves.toMatchObject({
          status: 'completed',
        });
        await flushMany(2);
        expect(Date.now() - startedAt).toBeLessThan(1000);
        expect(firstSettled).toBe(false);
        hold.resolve();
        await flushMany(2);
        // Delivery of the last queued frame is not enough: its receipt must
        // also settle before terminal callbacks or runTurn finalization.
        expect(events).toEqual(['item/started', 'item/completed']);
        expect(firstSettled).toBe(false);
        finalAdmission.resolve();
        await flushMany(2);
        expect(firstSettled).toBe(true);
        await expect(firstOutcome).resolves.toMatchObject(
          terminalMethod === 'error'
            ? {
                status: 'failed',
                finalText: 'Retained answer',
                error: 'terminal failure',
                // Failure classification reads the terminal error's info.
                errorInfo: 'usageLimitExceeded',
              }
            : { status: 'completed', finalText: 'Retained answer' },
        );
        expect(events).toEqual(
          terminalMethod === 'error'
            ? ['item/started', 'item/completed', 'error', 'turn/completed']
            : ['item/started', 'item/completed', 'turn/completed'],
        );
      } finally {
        hold.resolve();
        finalAdmission.resolve();
        await service.shutdown();
        await Promise.allSettled(outcomes);
      }
    },
  );

  it('delivers peer turn/start responses and both owners tool calls within 1 s at the owner soft cap', async () => {
    const owner = ownerStub();
    const peer = ownerStub();
    const ownerTool = jest.fn((): Promise<void> => Promise.resolve());
    const peerTool = jest.fn((): Promise<void> => Promise.resolve());
    owner.handleDynamicToolCall = ownerTool;
    peer.handleDynamicToolCall = peerTool;
    const hold = deferred();
    owner.handleConnectionNotification = (): Promise<void> => hold.promise;
    const { proc, connection } = await startSharedConnection([
      [owner, 'held-thread'],
      [peer, 'peer-thread'],
    ]);
    try {
      notify(proc, 'held-thread', 0);
      for (let sequence = 1; sequence <= 12; sequence += 1)
        notify(proc, 'held-thread', sequence, {
          payload: 'x'.repeat(1024 * 1024),
        });
      const response = observe(
        connection.request(
          'turn/start',
          {
            threadId: 'peer-thread',
            input: [],
          },
          { owner: peer, timeoutMs: 900 },
        ),
      );
      await flush();
      const startedAt = Date.now();
      emitServerMessage(proc, {
        id: findClientRequest(proc, 'turn/start').id,
        result: { turn: { id: 'peer-turn' } },
      });
      for (const threadId of ['held-thread', 'peer-thread'])
        emitServerMessage(proc, {
          id: `tool-${threadId}`,
          method: 'item/tool/call',
          params: {
            threadId,
            turnId: 't',
            callId: `call-${threadId}`,
            tool: 'test',
            arguments: {},
          },
        });
      await flushMany(2);
      expect(response.state).toBe('resolved');
      expect(ownerTool).toHaveBeenCalledTimes(1);
      expect(peerTool).toHaveBeenCalledTimes(1);
      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(proc.stdout.isPaused()).toBe(false);
    } finally {
      hold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it('handles every lifecycle control immediately without making its admission a transcript barrier', async () => {
    const owner = ownerStub();
    const hold = deferred();
    const controls = [
      'turn/started',
      'turn/completed',
      'thread/status/changed',
      'error',
      'serverRequest/resolved',
    ];
    const received: string[] = [];
    owner.handleConnectionNotification = (method): Promise<void> => {
      received.push(method);
      return hold.promise;
    };
    const { proc, connection } = await startSharedConnection([
      [owner, 'thread'],
    ]);
    try {
      notify(proc, 'thread', 1);
      notify(proc, 'thread', 2);
      for (const method of controls)
        emitServerMessage(proc, { method, params: { threadId: 'thread' } });
      await flushMany(2);
      expect(received).toEqual(['item/started', ...controls]);
      hold.resolve();
      await flushMany();
      expect(received).toEqual(['item/started', ...controls, 'item/started']);
    } finally {
      hold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it('coalesces each turn diff to its newest snapshot at its latest pipe position, with soft-cap hysteresis', async () => {
    const owner = ownerStub();
    const hold = deferred();
    const received: Array<number | null> = [];
    owner.handleConnectionNotification = (
      _method,
      frame,
    ): Promise<void> | undefined => {
      received.push(sequenceOf(frame));
      return received.length === 1 ? hold.promise : undefined;
    };
    const { proc, connection } = await startSharedConnection(
      [[owner, 'thread']],
      {
        stdoutQueueHighWaterBytes: 4096,
        stdoutQueueLowWaterBytes: 2048,
      },
    );
    const diff = (turnId: string, sequence: number): void =>
      emitServerMessage(proc, {
        method: 'turn/diff/updated',
        params: {
          threadId: 'thread',
          turnId,
          sequence,
          diff: 'x'.repeat(1024),
        },
      });
    try {
      notify(proc, 'thread', 0);
      diff('turn-a', 1);
      diff('turn-a', 2);
      diff('turn-b', 3);
      diff('turn-a', 4); // crosses the soft cap; diffs 1 and 2 are obsolete
      notify(proc, 'thread', 5); // other transcript frames are never folded
      diff('turn-b', 6); // still coalescing above low water; 3 is obsolete
      await flushMany(2);
      expect(proc.stdout.isPaused()).toBe(false);
      hold.resolve();
      await flushMany();
      expect(received).toEqual([0, 4, 5, 6]);
      diff('turn-a', 7);
      diff('turn-a', 8); // the lane drained: ordinary delivery again
      await flush();
      expect(received).toEqual([0, 4, 5, 6, 7, 8]);
    } finally {
      hold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it('uses a hard per-owner fallback, not a sum across owners, and diagnoses even a short pause', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const owner = ownerStub();
    const peer = ownerStub();
    const hold = deferred();
    const peerHold = deferred();
    owner.handleConnectionNotification = (): Promise<void> => hold.promise;
    const peerControls: string[] = [];
    peer.handleConnectionNotification = (method): Promise<void> | undefined => {
      if (method === 'turn/started') {
        peerControls.push(method);
        return;
      }
      return peerHold.promise;
    };
    const { proc, connection } = await startSharedConnection(
      [
        [owner, 'thread'],
        [peer, 'peer'],
      ],
      {
        stdoutQueueHighWaterBytes: 2048,
        stdoutQueueLowWaterBytes: 1024,
        stdoutOwnerHardLimitBytes: 8192,
      },
    );
    try {
      notify(proc, 'thread', 0);
      notify(proc, 'peer', 0);
      for (let i = 1; i <= 5; i += 1) {
        notify(proc, 'thread', i, { payload: 'x'.repeat(1024) });
        notify(proc, 'peer', i, { payload: 'x'.repeat(1024) });
      }
      await flushMany(2);
      expect(proc.stdout.isPaused()).toBe(false);
      emitServerMessage(proc, {
        method: 'turn/started',
        params: { threadId: 'peer' },
      });
      await flushMany(2);
      expect(peerControls).toEqual(['turn/started']);
      for (let i = 6; i <= 9; i += 1)
        notify(proc, 'thread', i, { payload: 'x'.repeat(1024) });
      await flushMany(2);
      emitServerMessage(proc, {
        method: 'turn/started',
        params: { threadId: 'peer' },
      });
      await flushMany(2);
      // The JSON-line reader (not the raw pipe) is paused only at hard limit.
      expect(peerControls).toEqual(['turn/started']);
      hold.resolve();
      await flushMany();
      // The triggering owner drained; the peer remains above soft cap.
      expect(peerControls).toEqual(['turn/started', 'turn/started']);
      expect(
        recordDiagnosticMock.mock.calls.some(
          ([event]) =>
            isStdoutHoldDiagnostic(event) &&
            'holdKind' in event &&
            event.holdKind === 'stdout-byte-cap',
        ),
      ).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        '[codex-app-server]',
        expect.stringContaining('hard per-owner'),
      );
    } finally {
      hold.resolve();
      peerHold.resolve();
      warn.mockRestore();
      await connection.terminateForFinalRelease();
    }
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

  it('stops the deadline and delivers a response as soon as read despite owner admission', async () => {
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
      expect(request.state).toBe('resolved');

      hold.resolve();
      await flushMany(4);
      expect(request.state).toBe('resolved');
      expect(request.value).toEqual({ account: null });
    } finally {
      hold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it('preserves transcript pipe order while responses and account controls overtake admission', async () => {
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
      expect(heldLog).toEqual(['n1', 'account', 'response']);

      firstHold.resolve();
      await flushMany(4);
      expect(heldLog).toEqual(['n1', 'account', 'response', 'n2', 'n4']);

      secondHold.resolve();
      await flushMany(4);
      expect(heldLog).toEqual(['n1', 'account', 'response', 'n2', 'n4', 'n5']);
      expect(peerLog).toEqual(['n3', 'account', 'n6']);
    } finally {
      firstHold.resolve();
      secondHold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it('pauses shared stdout only at the hard owner limit and resumes below owner low water', async () => {
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
        stdoutOwnerHardLimitBytes: 8 * 1024,
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
        stdoutOwnerHardLimitBytes: 8 * 1024,
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
        queuedFrameCount: 1,
        responseQueued: false,
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

  it('fails closed for a server request read after owner retirement', async () => {
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
      connection.unregisterThread('retired-thread', retiredOwner);
      connection.unregisterOwner(retiredOwner);
      emitServerMessage(proc, {
        id: 'approval-1',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'retired-thread', turnId: 't', itemId: 'i' },
      });
      await flushMany(2);
      expect(approvalHandler).not.toHaveBeenCalled();

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

  it('decides a file-change approval only after the transcript read before it is admitted', async () => {
    const owner = ownerStub();
    const hold = deferred();
    const order: string[] = [];
    owner.handleConnectionNotification = (
      method,
      frame,
    ): Promise<void> | undefined => {
      order.push(`${method}:${itemIdOf(frame)}`);
      return order.length === 1 ? hold.promise : undefined;
    };
    owner.handleApprovalRequest = jest.fn((): Promise<void> => {
      order.push('approval');
      return Promise.resolve();
    });
    const { proc, connection } = await startSharedConnection([
      [owner, 'thread'],
    ]);
    try {
      emitServerMessage(proc, {
        method: 'item/started',
        params: { threadId: 'thread', turnId: 'turn', item: { id: 'held' } },
      });
      // The changed paths arrive on the item, which waits behind the held
      // admission; the approval that names it must not be decided first.
      emitServerMessage(proc, {
        method: 'item/started',
        params: {
          threadId: 'thread',
          turnId: 'turn',
          item: {
            id: 'patch',
            type: 'fileChange',
            changes: [{ path: '/repo/private/secret.txt', kind: 'update' }],
          },
        },
      });
      emitServerMessage(proc, {
        id: 'file-approval',
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'thread',
          turnId: 'turn',
          itemId: 'patch',
          grantRoot: '/repo/public',
        },
      });
      await flushMany(2);
      expect(order).toEqual(['item/started:held']);

      hold.resolve();
      await flushMany();
      expect(order).toEqual([
        'item/started:held',
        'item/started:patch',
        'approval',
      ]);
    } finally {
      hold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it('decides a fallback MCP approval only after the transcript read before it is admitted', async () => {
    const owner = ownerStub();
    const hold = deferred();
    const order: string[] = [];
    owner.handleConnectionNotification = (
      method,
      frame,
    ): Promise<void> | undefined => {
      order.push(`${method}:${itemIdOf(frame)}`);
      return order.length === 1 ? hold.promise : undefined;
    };
    owner.handleApprovalRequest = jest.fn((): Promise<void> => {
      order.push('approval');
      return Promise.resolve();
    });
    const { proc, connection } = await startSharedConnection([
      [owner, 'thread'],
    ]);
    try {
      emitServerMessage(proc, {
        method: 'item/started',
        params: { threadId: 'thread', turnId: 'turn', item: { id: 'held' } },
      });
      emitServerMessage(proc, {
        method: 'item/started',
        params: {
          threadId: 'thread',
          turnId: 'turn',
          item: {
            id: 'mcp-call',
            type: 'mcpToolCall',
            server: 'docs',
            tool: 'search',
            status: 'inProgress',
            arguments: {},
          },
        },
      });
      emitServerMessage(proc, {
        id: 'mcp-approval',
        method: 'item/tool/requestUserInput',
        params: {
          threadId: 'thread',
          turnId: 'turn',
          itemId: 'mcp-call',
          questions: [
            {
              id: 'mcp_tool_call_approval_mcp-call',
              header: 'Approve tool call',
              question: 'Allow docs/search?',
              options: [],
            },
          ],
        },
      });
      await flushMany(2);
      expect(order).toEqual(['item/started:held']);

      hold.resolve();
      await flushMany();
      expect(order).toEqual([
        'item/started:held',
        'item/started:mcp-call',
        'approval',
      ]);
    } finally {
      hold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it('does not fail the connection when its own restart discards a held terminal frame', async () => {
    const owner = ownerStub();
    const rejectActiveTurn = jest.fn();
    owner.rejectActiveTurn = rejectActiveTurn;
    const hold = deferred();
    owner.handleConnectionNotification = (
      method,
      _frame,
      transcriptDrain,
    ): Promise<void> | undefined => {
      // Like the desktop client: finalize the turn after the drain.
      if (transcriptDrain) return transcriptDrain.then(() => undefined);
      return method === 'item/started' ? hold.promise : undefined;
    };
    const { proc, connection } = await startSharedConnection([
      [owner, 'thread'],
    ]);
    // The worker exits later, as a real process does after a signal.
    proc.kill.mockImplementation((): boolean => true);
    try {
      notify(proc, 'thread', 0);
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread',
          turn: { id: 'turn', status: 'completed', items: [], error: null },
        },
      });
      await flushMany(2);
      connection.triggerSharedRestart(
        owner,
        new Error('turn_cancelled'),
        undefined,
        true,
      );
      await flushMany(2);
      expect(rejectActiveTurn).not.toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Codex transcript admission discarded',
        }),
      );
    } finally {
      proc.signalCode = 'SIGTERM';
      proc.emit('exit', null, 'SIGTERM');
      hold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it('delivers a server request immediately while transcript frames retain their order', async () => {
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
      expect(log).toEqual(['n1', 'approval']);
      hold.resolve();
      await flushMany(4);
      expect(log).toEqual(['n1', 'approval', 'n2']);
    } finally {
      hold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it('rejects an unanswered request when the app-server exits while its owner is held', async () => {
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
      notify(proc, 'own-thread', 1);
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
