import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import type * as NodeChildProcess from 'node:child_process';
import type { CodexAppServerConnectionOwner } from '../connection';
import { getEnhancedEnv } from '../../../pipelines/config-paths';

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

import { CodexAuthenticationSession } from '../managed-auth';
import {
  CODEX_APP_SERVER_THREAD_LOAD_BUDGET,
  CodexAppServerConnection,
  CodexAppServerPool,
  DEFAULT_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS,
  DEFAULT_CODEX_THREAD_MUTATION_TIMEOUT_MS,
  DEFAULT_CODEX_TURN_START_TIMEOUT_MS,
} from '../connection';
import {
  configureCodexRuntimeHostHooks,
  resetCodexRuntimeHostHooksForTests,
  type CodexRuntimeDiagnostic,
  type CodexRuntimeResourceRegistrationHandle,
} from '../host-hooks';
import { createJsonLineStream } from '../json-lines';

const recordDiagnosticMock = jest.fn<void, [CodexRuntimeDiagnostic]>();

class MockChildProcess extends EventEmitter {
  pid = 4288;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  clientOutput = '';
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  autoExitSignals = new Set<NodeJS.Signals>(['SIGTERM', 'SIGKILL']);

  kill = jest.fn().mockImplementation((signal?: NodeJS.Signals): boolean => {
    const nextSignal = signal ?? 'SIGTERM';
    if (!this.autoExitSignals.has(nextSignal)) {
      return true;
    }
    this.signalCode = nextSignal;
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

describe('CodexAppServerConnection release safety', () => {
  it('reopens admission when authentication readiness rejects', async () => {
    const pool = new CodexAppServerPool();
    jest
      .spyOn(pool, 'suspendConnectionsForExternalAuthChange')
      .mockRejectedValueOnce(new Error('transition failed'))
      .mockResolvedValue(0);

    const failedLease = pool.beginAuthentication();
    await expect(failedLease.ready).rejects.toThrow('transition failed');
    await expect(failedLease.close()).resolves.toBeUndefined();

    const replacementLease = pool.beginAuthentication();
    await replacementLease.ready;
    await replacementLease.close();
  });

  it('verifies the unchanged account and closes after sign-in readiness rejects', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const pool = new CodexAppServerPool();
    jest
      .spyOn(pool, 'suspendConnectionsForExternalAuthChange')
      .mockRejectedValueOnce(
        new Error('Timed out waiting for active Codex turns to finish'),
      )
      .mockResolvedValue(0);
    const onClosed = jest.fn();
    const auth = new CodexAuthenticationSession(
      pool.beginAuthentication(),
      onClosed,
    );
    await expect(auth.ready).rejects.toThrow('Timed out waiting');

    const account = { account: null, requiresOpenaiAuth: true };
    const outcome = auth.verifyAccount().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await flush();
    const request = collectClientMessages(proc).find(
      (message) => message.method === 'account/read',
    );
    emitServerMessage(proc, { id: request?.id, result: account });
    expect(await outcome).toEqual({ value: account });

    // A second close must also settle: a rejected readiness is permanent.
    await expect(auth.close()).resolves.toBeUndefined();
    expect(onClosed).toHaveBeenCalledTimes(1);
    const replacementLease = pool.beginAuthentication();
    await replacementLease.ready;
    await replacementLease.close();
  });

  it('keeps a managed authentication session retryable when lease close rejects', async () => {
    const onClosed = jest.fn();
    const close = jest
      .fn()
      .mockRejectedValueOnce(new Error('lease close failed'))
      .mockResolvedValueOnce(undefined);
    const auth = new CodexAuthenticationSession(
      {
        ready: Promise.resolve(),
        close,
      },
      onClosed,
    );

    await expect(auth.close()).rejects.toThrow('lease close failed');
    expect(onClosed).not.toHaveBeenCalled();
    await expect(auth.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('keeps the user agent the process reported to initialize (turn-state phase 43b)', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const pool = new CodexAppServerPool();
    const connection = pool.acquire({
      profileKey: 'user-agent',
      owner: ownerStub(),
      processCallbacks: {},
    });
    expect(connection.harnessUserAgent()).toBeUndefined();
    const initialized = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'canopy/0.50.0 (Mac OS)', codexHome: '/tmp/.codex' },
    });
    await initialized;
    expect(connection.harnessUserAgent()).toBe('canopy/0.50.0 (Mac OS)');
    await pool.shutdown();
  });

  it('gives every pooled owner an unknown notification no owner claims (turn-state phase 43b)', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const pool = new CodexAppServerPool();
    const owners = [ownerStub(), ownerStub()].map((owner) => ({
      ...owner,
      handleUnroutedUnknownNotification: jest.fn<void, [string]>(),
    }));
    const [first, second] = owners.map((owner) =>
      pool.acquire({ profileKey: 'pooled', owner, processCallbacks: {} }),
    );
    expect(second).toBe(first);
    const initialized = first?.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'canopy/0.50.0', codexHome: '/tmp/.codex' },
    });
    await initialized;

    emitServerMessage(proc, { method: 'thread/brandNew', params: {} });
    emitServerMessage(proc, { method: 'future/withoutParams' });
    // A known method no owner claims is not drift.
    emitServerMessage(proc, { method: 'thread/name/updated', params: {} });
    await flush();

    for (const owner of owners)
      expect(owner.handleUnroutedUnknownNotification.mock.calls).toEqual([
        ['thread/brandNew'],
        ['future/withoutParams'],
      ]);
    await pool.shutdown();
  });

  it('holds admission after old workers exit until the managed sign-in lease closes', async () => {
    const staleProc = new MockChildProcess();
    const freshProc = new MockChildProcess();
    spawnMock.mockReturnValueOnce(staleProc).mockReturnValue(freshProc);
    const pool = new CodexAppServerPool();
    const owner = ownerStub();
    const connection = pool.acquire({
      profileKey: 'sign-in',
      owner,
      processCallbacks: {},
    });
    const initialized = connection.ensureInitialized();
    await flush();
    emitServerMessage(staleProc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialized;
    const lease = pool.beginAuthentication();
    await lease.ready;
    expect(staleProc.kill).toHaveBeenCalled();
    const controller = new AbortController();
    const pending = connection.request(
      'account/read',
      { refreshToken: false },
      { owner, signal: controller.signal },
    );
    const outcome = pending.catch((error: unknown) => error);
    await flush();
    expect(freshProc.clientOutput).toBe('');
    expect(() => pool.beginAuthentication()).toThrow('already');
    controller.abort();
    await outcome;
    await lease.close();
    const replacement = connection.ensureInitialized();
    await flush();
    emitServerMessage(freshProc, {
      id: 2,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await replacement;
    await pool.shutdown();
  });

  it('drains shared-owner notifications and a control response after sink release', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const firstOwner = ownerStub();
    const secondOwner = ownerStub();
    const received: number[] = [];
    const completed: number[] = [];
    const firstReceived: number[] = [];
    const secondReceived: number[] = [];
    let releaseSink = (): void => undefined;
    const heldSink = new Promise<void>((resolve) => {
      releaseSink = resolve;
    });
    const completions: Promise<void>[] = [];
    [firstOwner, secondOwner].forEach((owner, ownerIndex): void => {
      owner.handleConnectionNotification = (
        _method,
        notification,
      ): Promise<void> | undefined => {
        const params = notification.params;
        if (
          typeof params !== 'object' ||
          params === null ||
          !('sequence' in params) ||
          typeof params.sequence !== 'number'
        ) {
          return undefined;
        }
        const sequence = params.sequence;
        received.push(sequence);
        (ownerIndex === 0 ? firstReceived : secondReceived).push(sequence);
        const completion = heldSink.then(() => {
          completed.push(sequence);
        });
        completions.push(completion);
        return completion;
      };
    });
    // A small retained-frame cap keeps the producer bound measurable. Each
    // owner's first frame is held, so every later frame is retained.
    const retainedHighWaterBytes = 64 * 1024;
    const connection = new CodexAppServerConnection(
      'profile:pressure',
      undefined,
      undefined,
      {
        stdoutQueueHighWaterBytes: retainedHighWaterBytes,
        stdoutQueueLowWaterBytes: retainedHighWaterBytes / 2,
      },
    );
    connection.registerOwner(firstOwner, {});
    connection.registerOwner(secondOwner, {});
    connection.registerRootThread('pressure-first', firstOwner);
    connection.registerRootThread('pressure-second', secondOwner);
    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;
    const controlResponse = connection.request(
      'account/read',
      { refreshToken: false },
      { owner: secondOwner },
    );
    const controlOutcome = controlResponse.then(
      (value) => ({ ok: true, value }),
      (error: unknown) => ({ ok: false, error }),
    );
    let responseObservedWhileHeld = false;
    void controlOutcome.then(() => {
      responseObservedWhileHeld = true;
    });
    await flush();
    const controlRequest = collectClientMessages(proc).find(
      (message) => message.method === 'account/read',
    );
    if (!controlRequest) throw new Error('Missing control request');
    const frames = Array.from({ length: 512 }, (_, sequence) => ({
      method: 'item/started',
      params: {
        threadId: sequence % 2 === 0 ? 'pressure-first' : 'pressure-second',
        sequence,
        payload: 'x'.repeat(2048),
      },
    }));
    const largestFrameBytes = Math.max(
      ...frames.map((frame) => Buffer.byteLength(`${JSON.stringify(frame)}\n`)),
    );
    const parserInput = new PassThrough();
    const parser = createJsonLineStream(parserInput);
    // Frames for held owners are retained up to the cap, plus the one frame
    // that crosses it, before stdout pauses. This fake source is itself a
    // PassThrough. Its readable and writable buffers, the parser's writable
    // bytes, and its readable object frames can then fill before the producer
    // stops. Each of the three byte buffers can cross high water by one frame;
    // the fourth frame covers the transform callback currently in flight.
    // Real child/OS pipe buffering is a separate floor and is not inferred
    // from this mock.
    const pressureBoundBytes =
      retainedHighWaterBytes +
      largestFrameBytes +
      proc.stdout.readableHighWaterMark +
      proc.stdout.writableHighWaterMark +
      parser.writableHighWaterMark +
      (parser.readableHighWaterMark + 4) * largestFrameBytes;
    expect(proc.stdout.readableHighWaterMark).toBeLessThanOrEqual(64 * 1024);
    expect(proc.stdout.writableHighWaterMark).toBeLessThanOrEqual(64 * 1024);
    expect(parser.writableHighWaterMark).toBeLessThanOrEqual(64 * 1024);
    expect(parser.readableHighWaterMark).toBeLessThanOrEqual(16);
    parser.destroy();
    parserInput.destroy();
    let produced = 0;
    let producedBytes = 0;
    let producerFinished = false;
    const producer = (async (): Promise<void> => {
      try {
        for (const frame of frames) {
          const line = `${JSON.stringify(frame)}\n`;
          const accepted = proc.stdout.write(line);
          produced += 1;
          producedBytes += Buffer.byteLength(line);
          if (!accepted) await once(proc.stdout, 'drain');
        }
      } finally {
        producerFinished = true;
      }
    })();
    try {
      try {
        await flush();
        expect(completed).toHaveLength(0);
        emitServerMessage(proc, {
          id: controlRequest.id,
          result: { ok: true },
        });
        await flush();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const firstHeldBytes = producedBytes;
        await new Promise((resolve) => setTimeout(resolve, 100));
        process.stdout.write(
          `CODEX_SHARED_PRESSURE_METRIC ${JSON.stringify({
            produced,
            producedBytes,
            firstHeldBytes,
            producerFinished,
            pressureBoundBytes,
            sourceReadableHighWaterMark: proc.stdout.readableHighWaterMark,
            sourceWritableHighWaterMark: proc.stdout.writableHighWaterMark,
            parserWritableHighWaterMark: parser.writableHighWaterMark,
            parserReadableFrameHighWaterMark: parser.readableHighWaterMark,
            received: received.length,
            completed: completed.length,
            largestFrameBytes,
            owners: 2,
            responseObservedWhileHeld,
          })}\n`,
        );
        expect(producedBytes).toBe(firstHeldBytes);
        // Soft per-owner watermarks do not stop the shared producer.
        // This bounded fixture is below either owner's 64 MiB hard cap.
        expect(producedBytes).toBe(
          frames.reduce(
            (bytes, frame) =>
              bytes + Buffer.byteLength(`${JSON.stringify(frame)}\n`),
            0,
          ),
        );
        // Each owner receives its first transcript frame, retaining the rest
        // in order. The control response bypasses either held admission.
        expect(received).toEqual([0, 1]);
        expect(responseObservedWhileHeld).toBe(true);
        expect(producerFinished).toBe(true);
      } finally {
        releaseSink();
        await producer;
        for (
          let attempt = 0;
          received.length < frames.length && attempt < 10_000;
          attempt += 1
        ) {
          await flush();
        }
        await Promise.all(completions);
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcome = await Promise.race([
          controlOutcome,
          new Promise<{ ok: false; error: Error }>((resolve) => {
            timeout = setTimeout(
              () =>
                resolve({
                  ok: false,
                  error: new Error('Control response stalled'),
                }),
              2000,
            );
          }),
        ]);
        expect(outcome).toEqual({ ok: true, value: { ok: true } });
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      // Order is guaranteed per owner, not across owners.
      expect([...received].sort((left, right) => left - right)).toEqual(
        frames.map((frame) => frame.params.sequence),
      );
      expect(firstReceived).toEqual(
        frames
          .filter((frame) => frame.params.sequence % 2 === 0)
          .map((frame) => frame.params.sequence),
      );
      expect(secondReceived).toEqual(
        frames
          .filter((frame) => frame.params.sequence % 2 === 1)
          .map((frame) => frame.params.sequence),
      );
      expect(completed).toEqual(received);
    } finally {
      await connection.terminateForFinalRelease();
    }
  });

  it('terminates a shared connection while an owner notification sink is held', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const owner = ownerStub();
    let releaseSink = (): void => undefined;
    const heldSink = new Promise<void>((resolve) => {
      releaseSink = resolve;
    });
    let received = 0;
    const completions: Promise<void>[] = [];
    owner.handleConnectionNotification = (): void => {
      received += 1;
      completions.push(heldSink);
    };
    const connection = new CodexAppServerConnection('profile:pressure-stop');
    connection.registerOwner(owner, {});
    connection.registerRootThread('pressure-stop-thread', owner);
    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;
    emitServerMessage(proc, {
      method: 'item/started',
      params: { threadId: 'pressure-stop-thread', sequence: 1 },
    });
    await flush();
    expect(received).toBe(1);
    const termination = connection.terminateForFinalRelease();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        termination.then(() => 'terminated'),
        new Promise<'stalled'>((resolve) => {
          timeout = setTimeout(() => resolve('stalled'), 2000);
        }),
      ]);
      expect(outcome).toBe('terminated');
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      if (timeout) clearTimeout(timeout);
      releaseSink();
      await Promise.all(completions);
    }
  });

  it('releases a retired owner notification hold so a shared peer can progress', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const retiredOwner = ownerStub();
    const peerOwner = ownerStub();
    let releaseSink = (): void => undefined;
    const heldSink = new Promise<void>((resolve) => {
      releaseSink = resolve;
    });
    let retiredReceived = 0;
    let peerReceived = 0;
    retiredOwner.handleConnectionNotification = (): Promise<void> => {
      retiredReceived += 1;
      return heldSink;
    };
    peerOwner.handleConnectionNotification = (): void => {
      peerReceived += 1;
    };
    const connection = new CodexAppServerConnection('profile:retired-pressure');
    connection.registerOwner(retiredOwner, {});
    connection.registerOwner(peerOwner, {});
    connection.registerRootThread('retired-thread', retiredOwner);
    connection.registerRootThread('peer-thread', peerOwner);
    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;
    try {
      emitServerMessage(proc, {
        method: 'item/started',
        params: { threadId: 'retired-thread', sequence: 1 },
      });
      await flush();
      expect(retiredReceived).toBe(1);
      connection.unregisterThread('retired-thread', retiredOwner);
      connection.unregisterOwner(retiredOwner);

      const peerResponse = connection.request(
        'account/read',
        { refreshToken: false },
        { owner: peerOwner },
      );
      const peerOutcome = peerResponse.then(
        (value) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error }),
      );
      await flush();
      const peerRequest = collectClientMessages(proc).find(
        (message) => message.method === 'account/read',
      );
      if (!peerRequest) throw new Error('Missing peer control request');
      emitServerMessage(proc, {
        method: 'item/started',
        params: { threadId: 'peer-thread', sequence: 2 },
      });
      emitServerMessage(proc, {
        id: peerRequest.id,
        result: { account: null },
      });
      await flush();
      await flush();
      expect(peerReceived).toBe(1);
      await expect(peerOutcome).resolves.toEqual({
        ok: true,
        value: { account: null },
      });
    } finally {
      releaseSink();
      await connection.terminateForFinalRelease();
    }
  });

  it.each([false, true])(
    'retires only one account-notification receipt while peer held=%s',
    async (holdPeer) => {
      const proc = new MockChildProcess();
      spawnMock.mockReturnValue(proc);
      const retiredOwner = ownerStub();
      const peerOwner = ownerStub();
      let releaseRetired = (): void => undefined;
      const retiredAdmission = new Promise<void>((resolve) => {
        releaseRetired = resolve;
      });
      let releasePeer = (): void => undefined;
      const peerAdmission = new Promise<void>((resolve) => {
        releasePeer = resolve;
      });
      let peerReceived = 0;
      retiredOwner.handleConnectionNotification = (): Promise<void> =>
        retiredAdmission;
      peerOwner.handleConnectionNotification = (
        method,
      ): Promise<void> | undefined => {
        if (method === 'account/updated') {
          return holdPeer ? peerAdmission : undefined;
        }
        peerReceived += 1;
      };
      const connection = new CodexAppServerConnection(
        `profile:fanout-retire-${String(holdPeer)}`,
      );
      connection.registerOwner(retiredOwner, {});
      connection.registerOwner(peerOwner, {});
      connection.registerRootThread('fanout-peer', peerOwner);
      const initialization = connection.ensureInitialized();
      await flush();
      emitServerMessage(proc, {
        id: 1,
        result: { userAgent: 'test', codexHome: '/tmp/.codex' },
      });
      await initialization;
      try {
        emitServerMessage(proc, {
          method: 'account/updated',
          params: { account: null },
        });
        await flush();
        connection.unregisterOwner(retiredOwner);
        emitServerMessage(proc, {
          method: 'item/started',
          params: { threadId: 'fanout-peer', sequence: 2 },
        });
        await flush();
        expect(peerReceived).toBe(1);
        releasePeer();
        await flush();
        expect(peerReceived).toBe(1);
      } finally {
        releaseRetired();
        releasePeer();
        await connection.terminateForFinalRelease();
      }
    },
  );

  it('keeps quarantine routing while releasing a disposed owner notification hold', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const retiredOwner = ownerStub();
    const peerOwner = ownerStub();
    let releaseSink = (): void => undefined;
    const heldSink = new Promise<void>((resolve) => {
      releaseSink = resolve;
    });
    retiredOwner.handleConnectionNotification = (): Promise<void> => heldSink;
    let peerReceived = 0;
    peerOwner.handleConnectionNotification = (): void => {
      peerReceived += 1;
    };
    const connection = new CodexAppServerConnection(
      'profile:quarantine-pressure',
    );
    connection.registerOwner(retiredOwner, {});
    connection.registerOwner(peerOwner, {});
    connection.registerRootThread('disposed-thread', retiredOwner);
    connection.registerRootThread('quarantine-peer', peerOwner);
    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;
    try {
      emitServerMessage(proc, {
        method: 'item/started',
        params: { threadId: 'disposed-thread', sequence: 1 },
      });
      await flush();
      connection.disposeOwnerActiveTurn(retiredOwner, {
        threadId: 'disposed-thread',
        turnId: 'disposed-turn',
      });
      connection.unregisterOwner(retiredOwner);
      expect(connection.resolveOwnerForThread('disposed-thread')).toBe(
        retiredOwner,
      );
      const interrupt = collectClientMessages(proc).find(
        (message) => message.method === 'turn/interrupt',
      );
      if (!interrupt) throw new Error('Missing disposed turn interrupt');
      emitServerMessage(proc, { id: interrupt.id, result: {} });
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'disposed-thread',
          turn: {
            id: 'disposed-turn',
            status: 'interrupted',
            items: [],
            error: null,
          },
        },
      });
      emitServerMessage(proc, {
        method: 'item/started',
        params: { threadId: 'quarantine-peer', sequence: 2 },
      });
      await flush();
      await flush();
      expect(peerReceived).toBe(1);
      expect(connection.resolveOwnerForThread('disposed-thread')).toBeNull();
    } finally {
      releaseSink();
      await connection.terminateForFinalRelease();
    }
  });

  it('allows cleanup during managed sign-in without starting a replacement worker', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const pool = new CodexAppServerPool();
    const owner = ownerStub();
    const connection = pool.acquire({
      profileKey: 'sign-in-cleanup',
      owner,
      processCallbacks: {},
    });
    const initialized = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialized;
    const lease = pool.beginAuthentication();
    await lease.ready;
    const spawns = spawnMock.mock.calls.length;
    await connection.request(
      'thread/unsubscribe',
      { threadId: 'retired' },
      { owner },
    );
    expect(spawnMock.mock.calls.length).toBe(spawns);
    await lease.close();
    await pool.shutdown();
  });

  it('correlates login completion that arrives before the start response and verifies with a fresh worker', async () => {
    const loginProc = new MockChildProcess();
    const verifyProc = new MockChildProcess();
    spawnMock.mockReturnValueOnce(loginProc).mockReturnValue(verifyProc);
    const release = jest.fn(async (): Promise<void> => {});
    const auth = new CodexAuthenticationSession(
      { ready: Promise.resolve(), close: release },
      () => {},
    );
    const completed = jest.fn();
    const started = auth.start('chatgpt', completed);
    await flush();
    emitServerMessage(loginProc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(loginProc, {
      method: 'account/login/completed',
      params: { loginId: 'mine', success: true },
    });
    emitServerMessage(loginProc, {
      id: 2,
      result: {
        type: 'chatgpt',
        loginId: 'mine',
        authUrl: 'https://auth.openai.com/authorize',
      },
    });
    await started;
    await flush();
    expect(completed).toHaveBeenCalledWith({ loginId: 'mine', success: true });
    const verification = auth.verifyAccount();
    await flush();
    emitServerMessage(loginProc, { id: 3, result: { status: 'canceled' } });
    await flush();
    expect(loginProc.kill).toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    emitServerMessage(verifyProc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await flush();
    const account = {
      account: {
        type: 'chatgpt',
        email: 'current@example.test',
        planType: 'plus',
      },
      requiresOpenaiAuth: true,
    };
    emitServerMessage(verifyProc, { id: 2, result: account });
    await expect(verification).resolves.toEqual(account);
    const closing = auth.close();
    await flush();
    emitServerMessage(verifyProc, { id: 3, result: { status: 'canceled' } });
    await closing;
    expect(verifyProc.kill).toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending login start and awaits teardown without retaining a late auth worker', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const auth = new CodexAuthenticationSession(
      { ready: Promise.resolve(), close: async (): Promise<void> => {} },
      () => {},
    );
    const started = auth.start('chatgpt', jest.fn());
    const result = started.catch((error: unknown) => error);
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await flush();
    await auth.close();
    expect(await result).toBeInstanceOf(Error);
    expect(proc.kill).toHaveBeenCalled();
  });

  it('preserves Unicode line separators inside chunked JSON resume responses', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const connection = new CodexAppServerConnection('profile:unicode-json');
    connection.registerOwner(ownerStub(), {});
    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;
    const result = {
      thread: {
        id: 'thread-unicode',
        preview: 'before\u2028middle\u2029after 🐍',
      },
    };
    const resumed = connection.request(
      'thread/resume',
      { threadId: 'thread-unicode' },
      { timeoutMs: 100 },
    );
    const outcome = resumed.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await flush();
    const request = collectClientMessages(proc).find(
      (message) => message.method === 'thread/resume',
    );
    const bytes = Buffer.from(
      JSON.stringify({ id: request?.id, result }) + '\r\n',
    );
    // Split inside the multibyte separator and send a CRLF frame boundary.
    const split = bytes.indexOf(Buffer.from('\u2028')) + 1;
    proc.stdout.write(bytes.subarray(0, split));
    proc.stdout.write(bytes.subarray(split));
    try {
      expect(await outcome).toEqual({ value: result });
    } finally {
      await connection.terminateForFinalRelease();
    }
  });

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

  it('spawns a restricted worker with exactly its captured profile environment', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockClear();
    spawnMock.mockReturnValue(proc);
    jest.mocked(getEnhancedEnv).mockClear();
    const environment = { LANG: 'en_US.UTF-8', PATH: '' };
    const options = {
      environmentPolicy: 'restricted' as const,
      includeCanopySecrets: false,
    };
    const connection = new CodexAppServerConnection(
      'profile:restricted',
      environment,
      [],
      options,
    );
    connection.registerOwner(ownerStub(), {});
    try {
      const initialization = connection.ensureInitialized();
      await flush();
      emitServerMessage(proc, {
        id: 1,
        result: { userAgent: 'test', codexHome: '/tmp/.codex' },
      });
      await initialization;
      const captured =
        spawnMock.mock.calls[spawnMock.mock.calls.length - 1]?.[2]?.env;
      // Compare keys first so a failing assertion never prints inherited secrets.
      expect(Object.keys(captured ?? {}).sort()).toEqual(
        Object.keys(environment).sort(),
      );
      expect(captured?.LANG).toBe(environment.LANG);
      expect(captured?.PATH).toBe(environment.PATH);
      expect(getEnhancedEnv).not.toHaveBeenCalled();
    } finally {
      await connection.terminateForFinalRelease();
    }
  });

  it.each(['EOF', 'EPIPE', 'ERR_STREAM_DESTROYED'])(
    'contains stdin %s, settles requests, and ignores errors from the replaced worker',
    async (code) => {
      const proc = new MockChildProcess();
      spawnMock.mockReturnValue(proc);
      const markProcessFailed = jest.fn();
      const owner = { ...ownerStub(), markProcessFailed };
      const onProcessError = jest.fn();
      const connection = new CodexAppServerConnection('profile:pipe-error');
      connection.registerOwner(owner, { onProcessError });
      const initialization = connection.ensureInitialized();
      await flush();
      emitServerMessage(proc, {
        id: 1,
        result: { userAgent: 'test', codexHome: '/tmp/.codex' },
      });
      await initialization;
      const pending = connection.request(
        'account/read',
        { refreshToken: false },
        { owner },
      );
      void pending.catch(() => {});
      const error = Object.assign(new Error(`write ${code}`), {
        code,
        syscall: 'write',
      });
      try {
        expect(() => proc.stdin.emit('error', error)).not.toThrow();
        await expect(pending).rejects.toThrow(code);
        expect(markProcessFailed).toHaveBeenCalledTimes(1);
        expect(onProcessError).toHaveBeenCalledTimes(1);
        expect(proc.kill).toHaveBeenCalled();
        const replacement = new MockChildProcess();
        replacement.pid += 1;
        spawnMock.mockReturnValue(replacement);
        const ready = connection.ensureInitialized();
        await flush();
        const request = collectClientMessages(replacement).find(
          (message) => message.method === 'initialize',
        );
        emitServerMessage(replacement, {
          id: request?.id,
          result: { userAgent: 'test', codexHome: '/tmp/.codex' },
        });
        await ready;
        expect(() => proc.stdin.emit('error', error)).not.toThrow();
        expect(markProcessFailed).toHaveBeenCalledTimes(1);
        expect(replacement.kill).not.toHaveBeenCalled();
      } finally {
        await connection.terminateForFinalRelease();
      }
    },
  );

  it('routes stdout read failures through process recovery', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const markProcessFailed = jest.fn();
    const owner = { ...ownerStub(), markProcessFailed };
    const onProcessError = jest.fn();
    const connection = new CodexAppServerConnection('profile:stdout-error');
    connection.registerOwner(owner, { onProcessError });
    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;

    const error = Object.assign(new Error('read ERR_STREAM_DESTROYED'), {
      code: 'ERR_STREAM_DESTROYED',
      syscall: 'read',
    });
    try {
      expect(() => proc.stdout.emit('error', error)).not.toThrow();
      await flush();
      expect(markProcessFailed).toHaveBeenCalledTimes(1);
      expect(onProcessError).toHaveBeenCalledTimes(1);
      expect(proc.kill).toHaveBeenCalled();
    } finally {
      await connection.terminateForFinalRelease();
    }
  });

  it('rejects stale admin reads when suspending for an external auth change', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const markProcessSuspended = jest.fn();
    const owner = { ...ownerStub(), markProcessSuspended };
    const connection = new CodexAppServerConnection('profile:auth-change');
    connection.registerOwner(owner, {});
    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;

    const staleRead = connection.request(
      'account/read',
      { refreshToken: false },
      { owner, timeoutMs: 1_000 },
    );

    const cutover = connection.suspendProcessForExternalAuthChange();
    await expect(staleRead).rejects.toThrow(
      'Codex authentication credentials refreshed while an administrative request was in progress',
    );
    await expect(cutover).resolves.toBe(true);
    expect(markProcessSuspended).toHaveBeenCalled();
    expect(recordDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        kind: 'resource_codex_app_server_stopped',
        trigger: 'external-auth-change',
        appProcessId: process.pid,
        codexAppServerProcessId: proc.pid,
        stoppedCodexAppServerCount: 1,
      }),
    );
    expect(typeof recordDiagnosticMock.mock.calls[0]?.[0].timestamp).toBe(
      'string',
    );

    await connection.terminateForFinalRelease();
  });

  it('holds new work through repeated auth changes until an active pooled worker finishes and fully terminates', async () => {
    const initialSpawnCount = spawnMock.mock.calls.length;
    const staleProc = new MockChildProcess();
    staleProc.autoExitSignals.clear();
    const replacementProc = new MockChildProcess();
    replacementProc.pid = 4289;
    spawnMock
      .mockReturnValueOnce(staleProc)
      .mockReturnValueOnce(replacementProc);

    let active = true;
    const owner = {
      ...ownerStub(),
      hasActiveTurn: (): boolean => active,
      handleConnectionNotification: jest.fn((method: string) => {
        if (method === 'turn/completed') {
          // RuntimeThreadHandle clears activeTurn in the promise continuation
          // scheduled by the terminal notification, after routing returns.
          queueMicrotask(() => {
            active = false;
          });
        }
      }),
    };
    const pool = new CodexAppServerPool();
    const connection = pool.acquire({
      profileKey: 'profile:auth-cutover',
      owner,
      processCallbacks: {},
    });
    connection.registerRootThread('thread-active', owner);

    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(staleProc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;

    const cutover = pool.suspendConnectionsForExternalAuthChange();
    const repeatedCutover = pool.suspendConnectionsForExternalAuthChange();
    const nextInitialization = connection.ensureInitialized();
    let nextInitializationSettled = false;
    void nextInitialization.finally(() => {
      nextInitializationSettled = true;
    });

    await flush();
    expect(staleProc.kill).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(initialSpawnCount + 1);
    expect(nextInitializationSettled).toBe(false);

    emitServerMessage(staleProc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-active',
        turn: {
          id: 'turn-active',
          items: [],
          status: 'completed',
          error: null,
        },
      },
    });
    await flush();

    expect(staleProc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(spawnMock).toHaveBeenCalledTimes(initialSpawnCount + 1);
    expect(nextInitializationSettled).toBe(false);

    staleProc.signalCode = 'SIGTERM';
    staleProc.emit('exit', null, 'SIGTERM');
    await expect(cutover).resolves.toBe(1);
    await expect(repeatedCutover).resolves.toBe(1);
    await flush();

    expect(spawnMock).toHaveBeenCalledTimes(initialSpawnCount + 2);
    emitServerMessage(replacementProc, {
      id: 2,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await expect(nextInitialization).resolves.toBeUndefined();

    pool.release(connection, owner);
    await pool.shutdown();
  });

  it('snapshots active owners before work can enter the cutover scheduling gap', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    let active = false;
    const owner = {
      ...ownerStub(),
      hasActiveTurn: (): boolean => active,
    };
    const pool = new CodexAppServerPool();
    const connection = pool.acquire({
      profileKey: 'profile:auth-cutover-scheduling-gap',
      owner,
      processCallbacks: {},
    });

    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;

    const cutover = pool.suspendConnectionsForExternalAuthChange();
    active = true;
    await flush();

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(cutover).resolves.toBe(1);
    pool.release(connection, owner);
    await pool.shutdown();
  });

  it('keeps a waiter behind a newer auth cutover barrier', async () => {
    const initialSpawnCount = spawnMock.mock.calls.length;
    let resolveFirst: () => void = (): void => {};
    const firstBarrier = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let resolveSecond: () => void = (): void => {};
    const secondBarrier = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    let currentBarrier: Promise<void> | null = firstBarrier;
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const connection = new CodexAppServerConnection(
      'profile:auth-cutover-newer-barrier',
      undefined,
      undefined,
      {
        externalAuthTransitionBarrier: (): Promise<void> | null =>
          currentBarrier,
      },
    );
    connection.registerOwner(ownerStub(), {});

    const initialization = connection.ensureInitialized();
    await flush();
    expect(spawnMock).toHaveBeenCalledTimes(initialSpawnCount);

    currentBarrier = secondBarrier;
    resolveFirst();
    await flush();
    expect(spawnMock).toHaveBeenCalledTimes(initialSpawnCount);

    currentBarrier = null;
    resolveSecond();
    await flush();
    await flush();
    expect(spawnMock).toHaveBeenCalledTimes(initialSpawnCount + 1);
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;
    await connection.terminateForFinalRelease();
  });

  it('allows an active turn to be interrupted while an auth cutover is parked', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const owner = {
      ...ownerStub(),
      hasActiveTurn: (): boolean => true,
    };
    const connection = new CodexAppServerConnection(
      'profile:auth-cutover-interrupt',
    );
    connection.registerOwner(owner, {});

    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;

    const cutover = connection.suspendProcessForExternalAuthChange();
    const interrupt = connection.request(
      'turn/interrupt',
      { threadId: 'thread-active', turnId: 'turn-active' },
      { owner, timeoutMs: 1_000 },
    );
    await flush();

    const messages = collectClientMessages(proc);
    expect(messages).toContainEqual(
      expect.objectContaining({
        method: 'turn/interrupt',
        params: { threadId: 'thread-active', turnId: 'turn-active' },
      }),
    );
    const interruptRequest = messages.find(
      (message) => message.method === 'turn/interrupt',
    );
    emitServerMessage(proc, { id: interruptRequest?.id, result: {} });
    await interrupt;
    await connection.terminateForFinalRelease();
    await expect(cutover).resolves.toBe(false);
  });

  it('allows a snapshotted owner to finish dispatching through the auth barrier', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const owner = {
      ...ownerStub(),
      hasActiveTurn: (): boolean => true,
      hasDispatchedTurn: (): boolean => true,
    };
    const connection = new CodexAppServerConnection(
      'profile:auth-cutover-owner-drain',
    );
    connection.registerOwner(owner, {});

    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;

    const cutover = connection.suspendProcessForExternalAuthChange();
    const resume = connection.request(
      'thread/resume',
      { threadId: 'thread-preparing' },
      { owner, timeoutMs: 1_000 },
    );
    void resume.catch(() => {});
    await flush();

    const resumeRequest = collectClientMessages(proc).find(
      (message) => message.method === 'thread/resume',
    );
    if (resumeRequest) {
      emitServerMessage(proc, {
        id: resumeRequest.id,
        result: { thread: { id: 'thread-preparing', turns: [] } },
      });
      await resume;
    }
    connection.unregisterOwner(owner);
    await cutover;

    expect(resumeRequest).toBeDefined();
  });

  it('does not dispatch a request cancelled while waiting on an auth barrier', async () => {
    let resolveBarrier: () => void = (): void => {};
    const barrier = new Promise<void>((resolve) => {
      resolveBarrier = resolve;
    });
    let currentBarrier: Promise<void> | null = null;
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const connection = new CodexAppServerConnection(
      'profile:auth-cutover-cancelled-request',
      undefined,
      undefined,
      {
        externalAuthTransitionBarrier: (): Promise<void> | null =>
          currentBarrier,
      },
    );
    const owner = ownerStub();
    connection.registerOwner(owner, {});

    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;
    collectClientMessages(proc);

    currentBarrier = barrier;
    const controller = new AbortController();
    const requestOptions = { owner, signal: controller.signal };
    const request = connection.request(
      'turn/start',
      { threadId: 'thread-cancelled', input: [] },
      requestOptions,
    );
    void request.catch(() => {});
    await flush();
    controller.abort(new Error('turn_cancelled'));
    currentBarrier = null;
    resolveBarrier();
    await flush();

    const turnStartRequest = collectClientMessages(proc).find(
      (message) => message.method === 'turn/start',
    );
    if (turnStartRequest) {
      emitServerMessage(proc, {
        id: turnStartRequest.id,
        result: { turn: { id: 'turn-cancelled' } },
      });
      await request;
    } else {
      await expect(request).rejects.toThrow('turn_cancelled');
    }
    await connection.terminateForFinalRelease();

    expect(turnStartRequest).toBeUndefined();
  });

  it('does not let work started after an auth cutover keep the stale worker alive', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const activeOwner = {
      ...ownerStub(),
      hasActiveTurn: (): boolean => true,
    };
    const queuedOwner = {
      ...ownerStub(),
      hasActiveTurn: (): boolean => true,
    };
    const connection = new CodexAppServerConnection(
      'profile:auth-cutover-new-work',
    );
    connection.registerOwner(activeOwner, {});

    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;

    const cutover = connection.suspendProcessForExternalAuthChange();
    connection.registerOwner(queuedOwner, {});
    connection.unregisterOwner(activeOwner);
    await flush();

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(cutover).resolves.toBe(true);
  });

  it('does not park an auth cutover for a turn that has not been dispatched', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const owner = {
      ...ownerStub(),
      hasActiveTurn: (): boolean => true,
      hasDispatchedTurn: (): boolean => false,
    };
    const connection = new CodexAppServerConnection(
      'profile:auth-cutover-pending-turn-start',
    );
    connection.registerOwner(owner, {});

    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;

    const cutover = connection.suspendProcessForExternalAuthChange();
    await flush();
    const terminationStarted = proc.kill.mock.calls.some(
      ([signal]) => signal === 'SIGTERM',
    );

    await connection.terminateForFinalRelease();
    await cutover;
    expect(terminationStarted).toBe(true);
  });

  it('continues an auth cutover when an owner clears its turn in a finally path', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    let active = true;
    const owner = {
      ...ownerStub(),
      hasActiveTurn: (): boolean => active,
    };
    const connection = new CodexAppServerConnection(
      'profile:auth-cutover-turn-finally',
    );
    connection.registerOwner(owner, {});

    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;

    const cutover = connection.suspendProcessForExternalAuthChange();
    active = false;
    connection.notifyOwnerTurnSettled(owner);

    await expect(cutover).resolves.toBe(true);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('continues an auth cutover when a retained owner is unregistered', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const owner = {
      ...ownerStub(),
      hasActiveTurn: (): boolean => true,
      hasDispatchedTurn: (): boolean => true,
      getActiveTurnInterruptTarget: (): {
        threadId: string;
        turnId: string;
      } => ({ threadId: 'thread-disposed', turnId: 'turn-disposed' }),
    };
    const peer = {
      ...ownerStub(),
      hasActiveTurn: (): boolean => true,
      hasDispatchedTurn: (): boolean => true,
    };
    const connection = new CodexAppServerConnection(
      'profile:auth-cutover-retained-owner',
    );
    connection.registerOwner(owner, {});
    connection.registerOwner(peer, {});

    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;

    connection.disposeOwnerActiveTurn(owner, {
      threadId: 'thread-disposed',
      turnId: 'turn-disposed',
    });
    const cutover = connection.suspendProcessForExternalAuthChange();
    connection.unregisterOwner(peer);
    connection.unregisterOwner(owner);
    await flush();
    const terminationStarted = proc.kill.mock.calls.some(
      ([signal]) => signal === 'SIGTERM',
    );

    await connection.terminateForFinalRelease();
    await cutover;
    expect(terminationStarted).toBe(true);
  });

  it('settles a parked auth cutover when the app-server crashes', async () => {
    const proc = new MockChildProcess();
    proc.autoExitSignals.clear();
    spawnMock.mockReturnValue(proc);
    let active = true;
    const owner = {
      ...ownerStub(),
      hasActiveTurn: (): boolean => active,
      rejectActiveTurn: jest.fn(() => {
        active = false;
      }),
    };
    const connection = new CodexAppServerConnection(
      'profile:auth-cutover-crash',
    );
    connection.registerOwner(owner, {});

    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;

    const cutover = connection.suspendProcessForExternalAuthChange();
    let settled = false;
    void cutover.finally(() => {
      settled = true;
    });
    proc.emit('exit', 1, null);
    await flush();

    expect(settled).toBe(true);
    await expect(cutover).resolves.toBe(false);
  });

  it('settles a parked auth cutover when the final owner is released', async () => {
    const proc = new MockChildProcess();
    proc.autoExitSignals.clear();
    spawnMock.mockReturnValue(proc);
    let active = true;
    const owner = {
      ...ownerStub(),
      hasActiveTurn: (): boolean => active,
      rejectActiveTurn: jest.fn(() => {
        active = false;
      }),
    };
    const connection = new CodexAppServerConnection(
      'profile:auth-cutover-release',
    );
    connection.registerOwner(owner, {});

    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;

    const cutover = connection.suspendProcessForExternalAuthChange();
    let settled = false;
    void cutover.finally(() => {
      settled = true;
    });
    const release = connection.terminateForFinalRelease();
    proc.signalCode = 'SIGTERM';
    proc.emit('exit', null, 'SIGTERM');
    await release;
    await flush();

    expect(settled).toBe(true);
    await expect(cutover).resolves.toBe(false);
  });

  it('fails closed when an active turn never releases the auth cutover', async () => {
    jest.useFakeTimers();
    try {
      const proc = new MockChildProcess();
      spawnMock.mockReturnValue(proc);
      const owner = {
        ...ownerStub(),
        hasActiveTurn: (): boolean => true,
      };
      const connection = new CodexAppServerConnection(
        'profile:auth-cutover-timeout',
      );
      connection.registerOwner(owner, {});

      const initialization = connection.ensureInitialized();
      await jest.advanceTimersByTimeAsync(0);
      emitServerMessage(proc, {
        id: 1,
        result: { userAgent: 'test', codexHome: '/tmp/.codex' },
      });
      await initialization;

      const cutover = connection.suspendProcessForExternalAuthChange();
      let cutoverError: unknown;
      void cutover.catch((error: unknown) => {
        cutoverError = error;
      });
      await jest.advanceTimersByTimeAsync(5 * 60_000);

      expect(cutoverError).toEqual(
        expect.objectContaining({
          message:
            'Timed out waiting for active Codex turns to finish before refreshing authentication credentials; retry the request.',
        }),
      );
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a newly started app-server alive through critical pressure', async () => {
    jest.useFakeTimers();
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    secondProc.pid = 4289;
    spawnMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);
    const owner = ownerStub();
    const connection = new CodexAppServerConnection('profile:idle-trigger');
    connection.registerOwner(owner, {});

    try {
      const firstInitialization = connection.ensureInitialized();
      await jest.advanceTimersByTimeAsync(0);
      emitServerMessage(firstProc, {
        id: 1,
        result: { userAgent: 'test', codexHome: '/tmp/.codex' },
      });
      await firstInitialization;
      expect(connection.suspendIdleProcessIfIdle()).toBe(true);

      const secondInitialization = connection.ensureInitialized();
      await jest.advanceTimersByTimeAsync(0);
      emitServerMessage(secondProc, {
        id: 2,
        result: { userAgent: 'test', codexHome: '/tmp/.codex' },
      });
      await secondInitialization;

      await jest.advanceTimersByTimeAsync(5_000);
      expect(connection.suspendIdleProcessIfIdle('critical-pressure')).toBe(
        false,
      );
      expect(recordDiagnosticMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'resource_codex_app_server_suspend_skipped',
          skippedReason: 'minimum-process-lifetime',
          codexAppServerProcessId: secondProc.pid,
        }),
      );

      await jest.advanceTimersByTimeAsync(115_000);
      expect(connection.suspendIdleProcessIfIdle('critical-pressure')).toBe(
        true,
      );

      expect(recordDiagnosticMock.mock.calls.map(([event]) => event)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            trigger: 'idle-timeout',
            appProcessId: process.pid,
            codexAppServerProcessId: firstProc.pid,
          }),
          expect.objectContaining({
            trigger: 'critical-pressure',
            appProcessId: process.pid,
            codexAppServerProcessId: secondProc.pid,
          }),
        ]),
      );

      await connection.terminateForFinalRelease();
    } finally {
      jest.useRealTimers();
    }
  });

  it('backs off repeated critical-pressure suspensions for the same pool', async () => {
    jest.useFakeTimers();
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    const thirdProc = new MockChildProcess();
    secondProc.pid = 4289;
    thirdProc.pid = 4290;
    spawnMock
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc)
      .mockReturnValueOnce(thirdProc);
    const owner = ownerStub();
    const pool = new CodexAppServerPool();
    const connection = pool.acquire({
      profileKey: 'backoff',
      owner,
      processCallbacks: {},
    });

    try {
      const initializeFirst = connection.ensureInitialized();
      await jest.advanceTimersByTimeAsync(0);
      emitServerMessage(firstProc, {
        id: 1,
        result: { userAgent: 'test', codexHome: '/tmp/.codex' },
      });
      await initializeFirst;
      await jest.advanceTimersByTimeAsync(120_000);
      expect(pool.suspendIdleConnectionsForMemoryPressure()).toBe(1);

      const initializeSecond = connection.ensureInitialized();
      await jest.advanceTimersByTimeAsync(0);
      emitServerMessage(secondProc, {
        id: 2,
        result: { userAgent: 'test', codexHome: '/tmp/.codex' },
      });
      await initializeSecond;
      await jest.advanceTimersByTimeAsync(120_000);
      expect(pool.suspendIdleConnectionsForMemoryPressure()).toBe(1);

      const initializeThird = connection.ensureInitialized();
      await jest.advanceTimersByTimeAsync(0);
      emitServerMessage(thirdProc, {
        id: 3,
        result: { userAgent: 'test', codexHome: '/tmp/.codex' },
      });
      await initializeThird;
      await jest.advanceTimersByTimeAsync(120_000);
      expect(pool.suspendIdleConnectionsForMemoryPressure()).toBe(0);
      expect(recordDiagnosticMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'resource_codex_app_server_suspend_skipped',
          skippedReason: 'pressure-backoff',
          codexAppServerProcessId: thirdProc.pid,
        }),
      );

      const dispatchedTurn = connection.request('turn/start', {
        threadId: 'thread-pressure-backoff',
        input: [],
      });
      emitServerMessage(thirdProc, { id: 4, result: {} });
      await dispatchedTurn;
      expect(pool.suspendIdleConnectionsForMemoryPressure()).toBe(1);
      await pool.shutdown();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not clear replacement initialization when suspended startup settles', async () => {
    const initialSpawnCount = spawnMock.mock.calls.length;
    const firstProc = new MockChildProcess();
    const replacementProc = new MockChildProcess();
    spawnMock
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(replacementProc);
    const owner = ownerStub();
    const connection = new CodexAppServerConnection(
      'profile:auth-change-initialization',
    );
    connection.registerOwner(owner, {});

    const staleInitialization = connection.ensureInitialized();
    await flush();
    const cutover = connection.suspendProcessForExternalAuthChange();

    const replacementInitialization = connection.ensureInitialized();
    await expect(staleInitialization).rejects.toThrow(
      'Codex authentication credentials refreshed while an administrative request was in progress',
    );
    await expect(cutover).resolves.toBe(true);
    await flush();

    const concurrentInitialization = connection.ensureInitialized();
    await flush();
    expect(spawnMock).toHaveBeenCalledTimes(initialSpawnCount + 2);

    emitServerMessage(replacementProc, {
      id: 2,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await expect(replacementInitialization).resolves.toBeUndefined();
    await expect(concurrentInitialization).resolves.toBeUndefined();

    await connection.terminateForFinalRelease();
  });

  it('rate-limits repeated unrouted notification warnings on a shared connection', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const firstOwner = ownerStub();
    const secondOwner = ownerStub();
    const connection = new CodexAppServerConnection('profile:test');
    connection.registerOwner(firstOwner, {});
    connection.registerOwner(secondOwner, {});
    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;

    const emitWarning = jest
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const emitUnrouted = (threadId: string): void => {
      emitServerMessage(proc, {
        method: 'turn/started',
        params: { threadId, turn: { id: `turn-${threadId}` } },
      });
    };

    emitUnrouted('missing-child-1');
    emitUnrouted('missing-child-1');
    emitUnrouted('missing-child-2');
    await flush();
    expect(emitWarning).toHaveBeenCalledTimes(1);

    now.mockReturnValue(31_001);
    emitUnrouted('missing-child-3');
    await flush();
    expect(emitWarning).toHaveBeenCalledTimes(2);
    expect(emitWarning.mock.calls[1]?.[0]).toContain(
      'suppressed 2 additional unrouted notifications',
    );

    connection.registerRootThread('disposed-thread', firstOwner);
    connection.unregisterThread('disposed-thread', firstOwner);
    now.mockReturnValue(62_002);
    emitUnrouted('disposed-thread');
    await flush();
    expect(emitWarning).toHaveBeenCalledTimes(2);

    now.mockRestore();
    emitWarning.mockRestore();
    await connection.terminateForFinalRelease();
  });

  it('routes thread startup notifications before and alongside the thread/start response', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const owner = ownerStub();
    const notifications: Array<{
      method: string;
      notification: Record<string, unknown>;
    }> = [];
    owner.handleConnectionNotification = (method, notification): void => {
      notifications.push({ method, notification });
    };
    const connection = new CodexAppServerConnection('profile:test');
    connection.registerOwner(owner, {});
    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;

    const startRequest = connection.request(
      'thread/start',
      { cwd: '/tmp/repo', experimentalRawEvents: false },
      { owner },
    );
    emitServerMessage(proc, {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'thread-new',
        name: 'selected',
        status: 'starting',
        error: null,
        failureReason: null,
      },
    });
    emitServerMessage(proc, {
      id: 2,
      result: {
        thread: { id: 'thread-new' },
      },
    });
    emitServerMessage(proc, {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'thread-new',
        name: 'selected',
        status: 'failed',
        error: 'MCP handshake exited with code 23',
        failureReason: null,
      },
    });

    await startRequest;
    await flush();
    expect(notifications).toHaveLength(2);
    const routedNotification = notifications[1];
    expect(routedNotification?.method).toBe('mcpServer/startupStatus/updated');
    const routedParams = routedNotification?.notification.params;
    expect(routedParams).toEqual({
      threadId: 'thread-new',
      name: 'selected',
      status: 'failed',
      error: 'MCP handshake exited with code 23',
      failureReason: null,
    });

    connection.unregisterThread('thread-new', owner);
    await connection.terminateForFinalRelease();
  });

  it('buffers concurrent thread startup notifications until ownership is known', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const firstOwner = ownerStub();
    const secondOwner = ownerStub();
    const firstNotifications: Array<{
      method: string;
      notification: Record<string, unknown>;
    }> = [];
    const secondNotifications: Array<{
      method: string;
      notification: Record<string, unknown>;
    }> = [];
    firstOwner.handleConnectionNotification = (method, notification): void => {
      firstNotifications.push({ method, notification });
    };
    secondOwner.handleConnectionNotification = (method, notification): void => {
      secondNotifications.push({ method, notification });
    };
    const connection = new CodexAppServerConnection('profile:test');
    connection.registerOwner(firstOwner, {});
    connection.registerOwner(secondOwner, {});
    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;

    const firstStart = connection.request(
      'thread/start',
      { cwd: '/tmp/first', experimentalRawEvents: false },
      { owner: firstOwner },
    );
    const secondStart = connection.request(
      'thread/start',
      { cwd: '/tmp/second', experimentalRawEvents: false },
      { owner: secondOwner },
    );
    emitServerMessage(proc, {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'thread-first',
        name: 'selected',
        status: 'ready',
        error: null,
        failureReason: null,
      },
    });
    emitServerMessage(proc, {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'thread-second',
        name: 'selected',
        status: 'ready',
        error: null,
        failureReason: null,
      },
    });
    await flush();
    expect(firstNotifications).toHaveLength(0);
    expect(secondNotifications).toHaveLength(0);

    emitServerMessage(proc, {
      id: 2,
      result: { thread: { id: 'thread-first' } },
    });
    emitServerMessage(proc, {
      id: 3,
      result: { thread: { id: 'thread-second' } },
    });
    await Promise.all([firstStart, secondStart]);
    await flush();

    expect(firstNotifications).toEqual([
      {
        method: 'mcpServer/startupStatus/updated',
        notification: {
          method: 'mcpServer/startupStatus/updated',
          params: {
            threadId: 'thread-first',
            name: 'selected',
            status: 'ready',
            error: null,
            failureReason: null,
          },
        },
      },
    ]);
    expect(secondNotifications).toEqual([
      {
        method: 'mcpServer/startupStatus/updated',
        notification: {
          method: 'mcpServer/startupStatus/updated',
          params: {
            threadId: 'thread-second',
            name: 'selected',
            status: 'ready',
            error: null,
            failureReason: null,
          },
        },
      },
    ]);

    connection.unregisterThread('thread-first', firstOwner);
    connection.unregisterThread('thread-second', secondOwner);
    await connection.terminateForFinalRelease();
  });

  it('routes subagent startup through its parent before a pending root owner', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const parentNotifications: Array<{
      method: string;
      notification: Record<string, unknown>;
    }> = [];
    const pendingRootNotifications: Array<{
      method: string;
      notification: Record<string, unknown>;
    }> = [];
    const parentOwner = ownerStub();
    const pendingRootOwner = ownerStub();
    parentOwner.handleConnectionNotification = (method, notification): void => {
      parentNotifications.push({ method, notification });
    };
    pendingRootOwner.handleConnectionNotification = (
      method,
      notification,
    ): void => {
      pendingRootNotifications.push({ method, notification });
    };
    const connection = new CodexAppServerConnection('profile:test');
    connection.registerOwner(parentOwner, {});
    connection.registerOwner(pendingRootOwner, {});
    connection.registerRootThread('parent-thread', parentOwner);
    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;

    const startRequest = connection.request(
      'thread/start',
      { cwd: '/tmp/pending-root', experimentalRawEvents: false },
      { owner: pendingRootOwner },
    );
    const childStartedNotification = {
      method: 'thread/started',
      params: {
        thread: {
          id: 'child-thread',
          source: {
            subAgent: {
              parentThreadId: 'parent-thread',
            },
          },
        },
      },
    };
    emitServerMessage(proc, childStartedNotification);
    await flush();

    const childTurnStartedNotification = {
      method: 'turn/started',
      params: {
        threadId: 'child-thread',
        turn: { id: 'child-turn' },
      },
    };
    emitServerMessage(proc, childTurnStartedNotification);
    await flush();

    expect(parentNotifications).toEqual([
      {
        method: 'thread/started',
        notification: childStartedNotification,
      },
      {
        method: 'turn/started',
        notification: childTurnStartedNotification,
      },
    ]);
    expect(pendingRootNotifications).toEqual([]);

    emitServerMessage(proc, {
      id: 2,
      result: {
        thread: { id: 'pending-root-thread' },
      },
    });
    await startRequest;
    await connection.terminateForFinalRelease();
  });

  it('routes a subagent thread from its parent activity before child notifications', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const parentNotifications: Array<{
      method: string;
      notification: Record<string, unknown>;
    }> = [];
    const pendingRootNotifications: Array<{
      method: string;
      notification: Record<string, unknown>;
    }> = [];
    const parentOwner = ownerStub();
    const pendingRootOwner = ownerStub();
    parentOwner.handleConnectionNotification = (method, notification): void => {
      parentNotifications.push({ method, notification });
    };
    pendingRootOwner.handleConnectionNotification = (
      method,
      notification,
    ): void => {
      pendingRootNotifications.push({ method, notification });
    };
    const connection = new CodexAppServerConnection('profile:test');
    connection.registerOwner(parentOwner, {});
    connection.registerOwner(pendingRootOwner, {});
    connection.registerRootThread('parent-thread', parentOwner);
    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;

    const startRequest = connection.request(
      'thread/start',
      { cwd: '/tmp/pending-root', experimentalRawEvents: false },
      { owner: pendingRootOwner },
    );
    const activityNotification = {
      method: 'item/started',
      params: {
        threadId: 'parent-thread',
        turnId: 'parent-turn',
        item: {
          id: 'activity-1',
          type: 'subAgentActivity',
          kind: 'started',
          agentThreadId: 'child-thread',
          agentPath: '/root/child',
        },
      },
    };
    emitServerMessage(proc, activityNotification);
    await flush();

    const childTurnStartedNotification = {
      method: 'turn/started',
      params: {
        threadId: 'child-thread',
        turn: { id: 'child-turn' },
      },
    };
    emitServerMessage(proc, childTurnStartedNotification);
    await flush();

    expect(parentNotifications).toEqual([
      {
        method: 'item/started',
        notification: activityNotification,
      },
      {
        method: 'turn/started',
        notification: childTurnStartedNotification,
      },
    ]);
    expect(pendingRootNotifications).toEqual([]);

    emitServerMessage(proc, {
      id: 2,
      result: {
        thread: { id: 'pending-root-thread' },
      },
    });
    await startRequest;
    await connection.terminateForFinalRelease();
  });

  it('blocks anchor eviction during initialization and rejects the pending RPC on release', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const owner = ownerStub();
    const connection = new CodexAppServerConnection('profile:test');
    connection.registerOwner(owner, {});

    expect(connection.canEvictOwner(owner)).toBe(true);

    const initialization = connection.ensureInitialized();
    await flush();

    expect(connection.canEvictOwner(owner)).toBe(false);

    const initializationRejection = expect(initialization).rejects.toThrow(
      'connection closed after its final owner was released',
    );
    await connection.terminateForFinalRelease();
    await initializationRejection;
  });

  it('applies bounded defaults to thread mutations and turn startup', async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    const owner = ownerStub();
    const connection = new CodexAppServerConnection('profile:test');
    connection.registerOwner(owner, {});
    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;

    const timeoutSpy = jest.spyOn(global, 'setTimeout');
    const startRequest = connection.request(
      'thread/start',
      { cwd: '/tmp/repo', experimentalRawEvents: false },
      { owner },
    );
    const turnRequest = connection.request(
      'turn/start',
      {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'hello', text_elements: [] }],
      },
      { owner },
    );
    const accountRequest = connection.request(
      'account/read',
      { refreshToken: false },
      { owner },
    );

    expect(timeoutSpy).toHaveBeenCalledWith(
      expect.any(Function),
      DEFAULT_CODEX_THREAD_MUTATION_TIMEOUT_MS,
    );
    expect(timeoutSpy).toHaveBeenCalledWith(
      expect.any(Function),
      DEFAULT_CODEX_TURN_START_TIMEOUT_MS,
    );
    expect(timeoutSpy).toHaveBeenCalledWith(
      expect.any(Function),
      DEFAULT_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS,
    );

    const startRejection = expect(startRequest).rejects.toThrow(
      'connection closed after its final owner was released',
    );
    const turnRejection = expect(turnRequest).rejects.toThrow(
      'connection closed after its final owner was released',
    );
    const accountRejection = expect(accountRequest).rejects.toThrow(
      'connection closed after its final owner was released',
    );
    await connection.terminateForFinalRelease();
    await startRejection;
    await turnRejection;
    await accountRejection;
    timeoutSpy.mockRestore();
  });

  it('awaits SIGKILL escalation before final release resolves', async () => {
    const proc = new MockChildProcess();
    proc.autoExitSignals.delete('SIGTERM');
    spawnMock.mockReturnValue(proc);
    const owner = ownerStub();
    const connection = new CodexAppServerConnection('profile:test');
    connection.registerOwner(owner, {});
    const initialization = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;

    jest.useFakeTimers();
    try {
      let settled = false;
      const termination = connection.terminateForFinalRelease().then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(recordDiagnosticMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'resource_codex_app_server_stopped',
          trigger: 'final-owner-release',
          appProcessId: process.pid,
          codexAppServerProcessId: proc.pid,
        }),
      );
      expect(settled).toBe(false);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

      await jest.advanceTimersByTimeAsync(5_000);
      await termination;

      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
      expect(settled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  describe('thread load budget', () => {
    async function initializedConnection(
      proc: MockChildProcess,
      keeper: CodexAppServerConnectionOwner,
    ): Promise<CodexAppServerConnection> {
      spawnMock.mockReturnValueOnce(proc);
      const connection = new CodexAppServerConnection('profile:thread-budget');
      connection.registerOwner(keeper, {});
      const initialization = connection.ensureInitialized();
      await flush();
      const initialize = collectClientMessages(proc).find(
        (message) => message.method === 'initialize',
      );
      emitServerMessage(proc, {
        id: initialize?.id,
        result: { userAgent: 'test', codexHome: '/tmp/.codex' },
      });
      await initialization;
      return connection;
    }

    function loadThreads(
      connection: CodexAppServerConnection,
      count: number,
      prefix: string,
    ): void {
      for (let index = 0; index < count; index += 1) {
        const owner = ownerStub();
        connection.registerOwner(owner, {});
        connection.registerRootThread(`${prefix}-${index}`, owner);
        connection.unregisterOwner(owner);
      }
    }

    it('recycles a busy shared worker once it has loaded its thread budget', async () => {
      const proc = new MockChildProcess();
      const markProcessSuspended = jest.fn();
      const keeper = { ...ownerStub(), markProcessSuspended };
      const connection = await initializedConnection(proc, keeper);
      try {
        loadThreads(connection, CODEX_APP_SERVER_THREAD_LOAD_BUDGET - 1, 'a');
        await flush();
        expect(proc.kill).not.toHaveBeenCalled();

        loadThreads(connection, 1, 'b');
        await flush();
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
        expect(markProcessSuspended).toHaveBeenCalled();
        expect(recordDiagnosticMock).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: 'resource_codex_app_server_stopped',
            trigger: 'thread-budget',
            codexAppServerProcessId: proc.pid,
          }),
        );
      } finally {
        await connection.terminateForFinalRelease();
      }
    });

    it('waits for active turns and in-flight thread creation before recycling', async () => {
      const proc = new MockChildProcess();
      let turnActive = true;
      let creating = false;
      const keeper = {
        ...ownerStub(),
        hasActiveTurn: (): boolean => turnActive,
        hasInFlightOperation: (): boolean => creating,
      };
      const connection = await initializedConnection(proc, keeper);
      try {
        loadThreads(connection, CODEX_APP_SERVER_THREAD_LOAD_BUDGET, 'a');
        await flush();
        expect(proc.kill).not.toHaveBeenCalled();

        turnActive = false;
        creating = true;
        loadThreads(connection, 1, 'b');
        await flush();
        expect(proc.kill).not.toHaveBeenCalled();

        creating = false;
        loadThreads(connection, 1, 'c');
        await flush();
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      } finally {
        await connection.terminateForFinalRelease();
      }
    });

    it('starts the next worker with a fresh budget', async () => {
      const firstProc = new MockChildProcess();
      const secondProc = new MockChildProcess();
      secondProc.pid = 4290;
      const keeper = ownerStub();
      const connection = await initializedConnection(firstProc, keeper);
      try {
        loadThreads(connection, CODEX_APP_SERVER_THREAD_LOAD_BUDGET, 'a');
        await flush();
        expect(firstProc.kill).toHaveBeenCalled();

        spawnMock.mockReturnValueOnce(secondProc);
        const reinitialization = connection.ensureInitialized();
        await flush();
        const initialize = secondProc.clientOutput
          .split('\n')
          .filter(Boolean)
          .map(parseClientMessage)
          .find((message) => message.method === 'initialize');
        emitServerMessage(secondProc, {
          id: initialize?.id,
          result: { userAgent: 'test', codexHome: '/tmp/.codex' },
        });
        await reinitialization;

        loadThreads(connection, CODEX_APP_SERVER_THREAD_LOAD_BUDGET - 1, 'b');
        await flush();
        expect(secondProc.kill).not.toHaveBeenCalled();
      } finally {
        await connection.terminateForFinalRelease();
      }
    });
  });
});
