import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type * as NodeChildProcess from 'node:child_process';
import type {
  CodexAppServerConnectionOwner,
  CodexAppServerLateResponse,
} from '../connection';

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

jest.mock('../../../pipelines/config-paths', () => ({
  getBundledCodexBinaryPath: jest.fn(() => '/mock/codex'),
  getEnhancedEnv: jest.fn(() => ({ ...process.env })),
}));

import {
  CodexAppServerConnection,
  CodexRecoverableProcessExitError,
} from '../connection';

class MockChildProcess extends EventEmitter {
  pid = 4288;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  clientOutput = '';
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill = jest.fn().mockImplementation((signal?: NodeJS.Signals): boolean => {
    const nextSignal = signal ?? 'SIGTERM';
    this.signalCode = nextSignal;
    this.emit('exit', null, nextSignal);
    return true;
  });

  constructor() {
    super();
    this.stdin.on('data', (chunk: unknown) => {
      this.clientOutput += String(chunk);
    });
  }
}

function ownerStub(active = false): CodexAppServerConnectionOwner {
  return {
    hasActiveTurn: () => active,
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

function emitServerMessage(proc: MockChildProcess, payload: unknown): void {
  proc.stdout.write(`${JSON.stringify(payload)}\n`);
}

function findRequest(proc: MockChildProcess, method: string): number | string {
  const request = proc.clientOutput
    .split('\n')
    .filter(Boolean)
    .map((line): unknown => JSON.parse(line))
    .filter(
      (message): message is Record<string, unknown> =>
        typeof message === 'object' &&
        message !== null &&
        !Array.isArray(message),
    )
    .find((message) => message.method === method);
  if (
    !request ||
    (typeof request.id !== 'number' && typeof request.id !== 'string')
  )
    throw new Error(`Missing request ${method}`);
  return request.id;
}

async function startConnection(
  owner = ownerStub(),
): Promise<{ connection: CodexAppServerConnection; proc: MockChildProcess }> {
  const proc = new MockChildProcess();
  spawnMock.mockReturnValue(proc);
  const connection = new CodexAppServerConnection('profile:soft-deadline');
  connection.registerOwner(owner, {});
  const initialized = connection.ensureInitialized();
  await flush();
  emitServerMessage(proc, {
    id: 1,
    result: { userAgent: 'test', codexHome: '/tmp/.codex' },
  });
  await initialized;
  return { connection, proc };
}

describe('Codex app-server soft request deadlines', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps a timed-out request correlated until one late success arrives', async () => {
    const { connection, proc } = await startConnection();
    try {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const onLateResponse = jest.fn<void, [CodexAppServerLateResponse]>();
      const request = connection.request(
        'account/read',
        { refreshToken: false },
        { timeoutMs: 10, softTimeout: { onLateResponse } },
      );
      const rejected = request.catch((error: unknown) => error);
      await flush();
      const requestId = findRequest(proc, 'account/read');
      await jest.advanceTimersByTimeAsync(10);
      expect(await rejected).toMatchObject({
        name: 'CodexAppServerRequestTimeoutError',
      });
      expect(onLateResponse).not.toHaveBeenCalled();

      const result = { account: null };
      emitServerMessage(proc, { id: requestId, result });
      await flush();
      emitServerMessage(proc, {
        id: requestId,
        result: { account: 'duplicate' },
      });
      await flush();
      expect(onLateResponse).toHaveBeenCalledTimes(1);
      expect(onLateResponse).toHaveBeenCalledWith({
        kind: 'success',
        value: result,
      });
    } finally {
      await connection.terminateForFinalRelease();
    }
  });

  it('delivers a late RPC error and expires retained requests', async () => {
    const { connection, proc } = await startConnection(ownerStub(true));
    try {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const onLateResponse = jest.fn<void, [CodexAppServerLateResponse]>();
      const request = connection.request(
        'account/read',
        { refreshToken: false },
        { timeoutMs: 10, softTimeout: { onLateResponse } },
      );
      void request.catch(() => undefined);
      await flush();
      const requestId = findRequest(proc, 'account/read');
      await jest.advanceTimersByTimeAsync(10);
      emitServerMessage(proc, {
        id: requestId,
        error: { code: -32600, message: 'no active turn to steer' },
      });
      await flush();
      expect(onLateResponse).toHaveBeenCalledWith({
        kind: 'error',
        error: new Error('no active turn to steer'),
      });

      const expiryCallback = jest.fn<void, [CodexAppServerLateResponse]>();
      const expiryRequest = connection.request(
        'account/read',
        { refreshToken: false },
        { timeoutMs: 10, softTimeout: { onLateResponse: expiryCallback } },
      );
      void expiryRequest.catch(() => undefined);
      await flush();
      await jest.advanceTimersByTimeAsync(10);
      expect(expiryCallback).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(600_000);
      expect(expiryCallback).toHaveBeenCalledTimes(1);
      expect(expiryCallback.mock.calls[0]?.[0]).toMatchObject({
        kind: 'error',
        error: { name: 'CodexAppServerRequestTimeoutError' },
      });
    } finally {
      await connection.terminateForFinalRelease();
    }
  });

  it('evicts the oldest of 32 retained requests with a timeout', async () => {
    const { connection } = await startConnection();
    try {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const callbacks = Array.from({ length: 33 }, () =>
        jest.fn<void, [CodexAppServerLateResponse]>(),
      );
      for (const callback of callbacks) {
        const request = connection.request(
          'account/read',
          { refreshToken: false },
          { timeoutMs: 10, softTimeout: { onLateResponse: callback } },
        );
        void request.catch(() => undefined);
        await flush();
        await jest.advanceTimersByTimeAsync(10);
      }
      expect(callbacks[0]).toHaveBeenCalledTimes(1);
      expect(callbacks[0].mock.calls[0]?.[0]).toMatchObject({
        kind: 'error',
        error: { name: 'CodexAppServerRequestTimeoutError' },
      });
      expect(
        callbacks
          .slice(1)
          .every((callback) => callback.mock.calls.length === 0),
      ).toBe(true);
    } finally {
      await connection.terminateForFinalRelease();
    }
  });

  it('settles retained requests on connection disposal with the disposal error', async () => {
    const { connection } = await startConnection();
    try {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const onLateResponse = jest.fn<void, [CodexAppServerLateResponse]>();
      const request = connection.request(
        'account/read',
        { refreshToken: false },
        { timeoutMs: 10, softTimeout: { onLateResponse } },
      );
      void request.catch(() => undefined);
      await flush();
      await jest.advanceTimersByTimeAsync(10);
      const otherPending = connection.request('account/read', {
        refreshToken: false,
      });
      const otherPendingError = otherPending.catch((error: unknown) => error);
      await flush();
      await connection.terminateForFinalRelease();
      const deliveredError = await otherPendingError;
      expect(onLateResponse).toHaveBeenCalledTimes(1);
      const outcome = onLateResponse.mock.calls[0]?.[0];
      expect(outcome?.kind).toBe('error');
      if (outcome?.kind !== 'error')
        throw new Error('Expected a connection disposal error');
      expect(outcome.error).toBe(deliveredError);
    } finally {
      await connection.terminateForFinalRelease();
    }
  });

  it('reports a recoverable process exit to retained requests', async () => {
    const { connection, proc } = await startConnection(ownerStub(true));
    try {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const onLateResponse = jest.fn<void, [CodexAppServerLateResponse]>();
      const request = connection.request(
        'account/read',
        { refreshToken: false },
        { timeoutMs: 10, softTimeout: { onLateResponse } },
      );
      void request.catch(() => undefined);
      await flush();
      await jest.advanceTimersByTimeAsync(10);
      proc.emit('exit', 0, null);
      expect(onLateResponse).toHaveBeenCalledTimes(1);
      const outcome = onLateResponse.mock.calls[0]?.[0];
      expect(outcome?.kind).toBe('error');
      if (outcome?.kind !== 'error')
        throw new Error('Expected a recoverable process exit error');
      expect(outcome.error).toBeInstanceOf(CodexRecoverableProcessExitError);
    } finally {
      await connection.terminateForFinalRelease();
    }
  });

  it('keeps ordinary request timeout behavior and allows idle suspension after retention', async () => {
    const { connection, proc } = await startConnection();
    try {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const ordinary = connection.request(
        'account/read',
        { refreshToken: false },
        { timeoutMs: 10 },
      );
      const ordinaryOutcome = ordinary.catch((error: unknown) => error);
      await flush();
      const ordinaryId = findRequest(proc, 'account/read');
      await jest.advanceTimersByTimeAsync(10);
      expect(await ordinaryOutcome).toMatchObject({
        name: 'CodexAppServerRequestTimeoutError',
      });
      emitServerMessage(proc, { id: ordinaryId, result: {} });
      await flush();

      const onLateResponse = jest.fn<void, [CodexAppServerLateResponse]>();
      const soft = connection.request(
        'account/read',
        { refreshToken: false },
        { timeoutMs: 10, softTimeout: { onLateResponse } },
      );
      void soft.catch(() => undefined);
      await flush();
      await jest.advanceTimersByTimeAsync(10);
      expect(connection.suspendIdleProcessIfIdle()).toBe(true);
    } finally {
      await connection.terminateForFinalRelease();
    }
  });

  it.each([
    ['idle-timeout', 0],
    ['critical-pressure', 120_000],
  ] as const)(
    'settles retained requests as process-exit errors when %s suspension begins',
    async (trigger, additionalWaitMs) => {
      const { connection, proc } = await startConnection();
      try {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
        const onLateResponse = jest.fn<void, [CodexAppServerLateResponse]>();
        const request = connection.request(
          'account/read',
          { refreshToken: false },
          { timeoutMs: 10, softTimeout: { onLateResponse } },
        );
        void request.catch(() => undefined);
        await flush();
        const requestId = findRequest(proc, 'account/read');
        await jest.advanceTimersByTimeAsync(10);
        expect(onLateResponse).not.toHaveBeenCalled();

        if (additionalWaitMs > 0)
          await jest.advanceTimersByTimeAsync(additionalWaitMs);
        expect(connection.suspendIdleProcessIfIdle(trigger)).toBe(true);
        expect(onLateResponse).toHaveBeenCalledTimes(1);
        const outcome = onLateResponse.mock.calls[0]?.[0];
        expect(outcome?.kind).toBe('error');
        if (outcome?.kind !== 'error')
          throw new Error('Expected idle suspension to settle as process exit');
        expect(outcome.error).toBeInstanceOf(CodexRecoverableProcessExitError);

        emitServerMessage(proc, { id: requestId, result: { account: null } });
        await flush();
        await jest.advanceTimersByTimeAsync(600_000);
        expect(onLateResponse).toHaveBeenCalledTimes(1);
      } finally {
        await connection.terminateForFinalRelease();
      }
    },
  );

  it('suspends an opted-in deadline while the stdout byte cap pauses reads', async () => {
    const heldOwner = ownerStub();
    const peerOwner = ownerStub();
    let releaseHold = (): void => undefined;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let heldReceived = 0;
    heldOwner.handleConnectionNotification = (): Promise<void> => {
      heldReceived += 1;
      return heldReceived === 1 ? hold : Promise.resolve();
    };

    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const connection = new CodexAppServerConnection(
      'profile:soft-deadline-byte-cap',
      undefined,
      undefined,
      {
        stdoutQueueHighWaterBytes: 4 * 1024,
        stdoutQueueLowWaterBytes: 2 * 1024,
        stdoutOwnerHardLimitBytes: 8 * 1024,
      },
    );
    connection.registerOwner(heldOwner, {});
    connection.registerOwner(peerOwner, {});
    connection.registerRootThread('held-thread', heldOwner);
    connection.registerRootThread('peer-thread', peerOwner);
    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;

    try {
      const onLateResponse = jest.fn<void, [CodexAppServerLateResponse]>();
      const request = connection.request(
        'account/read',
        { refreshToken: false },
        {
          owner: peerOwner,
          timeoutMs: 100,
          softTimeout: { onLateResponse },
        },
      );
      const requestOutcome = request.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await flush();
      const requestId = findRequest(proc, 'account/read');
      for (let sequence = 0; sequence <= 4; sequence += 1) {
        emitServerMessage(proc, {
          method: 'item/started',
          params: {
            threadId: 'held-thread',
            sequence,
            payload: 'x'.repeat(1024),
          },
        });
      }
      await flush();
      emitServerMessage(proc, { id: requestId, result: { account: null } });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(onLateResponse).not.toHaveBeenCalled();

      releaseHold();
      await flush();
      await expect(requestOutcome).resolves.toEqual({
        value: { account: null },
      });
      expect(onLateResponse).not.toHaveBeenCalled();
    } finally {
      releaseHold();
      await connection.terminateForFinalRelease();
    }
  });
});
