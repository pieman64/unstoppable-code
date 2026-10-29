import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type {
  ClaudeProcessHostRequest,
  ClaudeProcessHostSpawnRequest,
} from '../agents/claude-process-host-protocol';

class FakeUtilityProcess extends EventEmitter {
  public readonly postMessage = jest.fn<void, [ClaudeProcessHostRequest]>();
  public readonly kill = jest.fn<boolean, []>(() => true);
}

const forkMock = jest.fn<FakeUtilityProcess, unknown[]>();
const killProcessGroupByPidMock = jest.fn<
  Promise<void>,
  [number, NodeJS.Signals]
>();
jest.mock('electron', () => ({
  utilityProcess: {
    fork: (...args: unknown[]): FakeUtilityProcess => forkMock(...args),
  },
}));
jest.mock('@canopy/desktop-shared/node/lib/process-kill', () => ({
  killProcessGroupByPid: (...args: [number, NodeJS.Signals]): Promise<void> =>
    killProcessGroupByPidMock(...args),
}));

import {
  resetClaudeProcessHostForTests,
  runClaudeCliProcessOffMain,
  shutdownClaudeProcessHost,
  spawnClaudeCodeProcessOffMain,
  withholdClaudeProcessStdoutCreditUntil,
} from '../agents/claude-process-host-runner';

function options(controller = new AbortController()): SpawnOptions {
  return {
    command: '/mock/claude',
    args: ['--output-format', 'stream-json'],
    cwd: '/repo',
    env: { PATH: '/bin', SECRET: undefined },
    signal: controller.signal,
  };
}

function spawnRequest(
  child: FakeUtilityProcess | undefined,
  index = 0,
): ClaudeProcessHostSpawnRequest {
  const request = child?.postMessage.mock.calls[index]?.[0];
  if (request?.type !== 'spawn') {
    throw new Error(`Expected spawn request at index ${String(index)}.`);
  }
  return request;
}

describe('Claude process host runner', () => {
  const children: FakeUtilityProcess[] = [];

  beforeEach(() => {
    resetClaudeProcessHostForTests();
    forkMock.mockReset();
    killProcessGroupByPidMock.mockReset();
    killProcessGroupByPidMock.mockResolvedValue();
    children.length = 0;
    forkMock.mockImplementation(() => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    });
  });

  it('reuses one utility host and forwards independent spawn requests', () => {
    spawnClaudeCodeProcessOffMain(options());
    spawnClaudeCodeProcessOffMain(options());

    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(spawnRequest(children[0], 0)).toMatchObject({
      command: '/mock/claude',
      args: ['--output-format', 'stream-json'],
      cwd: '/repo',
      env: { PATH: '/bin', SECRET: undefined },
      captureStderr: false,
    });
    expect(spawnRequest(children[0], 1).requestId).not.toBe(
      spawnRequest(children[0], 0).requestId,
    );
  });

  it('bridges stdin, stdout, and exit in order without changing bytes', async () => {
    const spawned = spawnClaudeCodeProcessOffMain(options());
    const request = spawnRequest(children[0]);
    const stdout: Buffer[] = [];
    spawned.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    const exit = once(spawned, 'exit');

    spawned.stdin.write(Buffer.from([0, 1, 2, 255]));
    spawned.stdin.end();

    expect(
      children[0]?.postMessage.mock.calls.map(([message]) => message),
    ).toEqual([
      request,
      {
        type: 'stdin',
        requestId: request.requestId,
        dataBase64: Buffer.from([0, 1, 2, 255]).toString('base64'),
      },
      { type: 'stdin-end', requestId: request.requestId },
    ]);

    children[0]?.emit('message', {
      type: 'stdout',
      requestId: request.requestId,
      dataBase64: Buffer.from([255, 2, 1, 0]).toString('base64'),
    });
    children[0]?.emit('message', {
      type: 'exit',
      requestId: request.requestId,
      code: 7,
      signal: null,
    });

    await expect(exit).resolves.toEqual([7, null]);
    expect(Buffer.concat(stdout)).toEqual(Buffer.from([255, 2, 1, 0]));
    expect(spawned.exitCode).toBe(7);
    expect(spawned.signalCode).toBeNull();
  });

  it('withholds stdout acknowledgements until a slow consumer drains', async () => {
    const spawned = spawnClaudeCodeProcessOffMain(options());
    const request = spawnRequest(children[0]);
    const chunk = Buffer.alloc(4 * 1024, 1);

    let forwardedBytes = 0;
    const acknowledgedBytes = (): number =>
      children[0]?.postMessage.mock.calls.reduce(
        (total, [message]) =>
          message.type === 'stdout-ack' ? total + message.bytes : total,
        0,
      ) ?? 0;
    for (let index = 0; index < 100; index += 1) {
      children[0]?.emit('message', {
        type: 'stdout',
        requestId: request.requestId,
        dataBase64: chunk.toString('base64'),
      });
      forwardedBytes += chunk.length;
      if (acknowledgedBytes() < forwardedBytes) break;
    }

    // PassThrough may hold one readable and one writable high-water mark, but
    // the runner must stop returning credit once that bounded window is full.
    expect(forwardedBytes - acknowledgedBytes()).toBeLessThanOrEqual(
      128 * 1024,
    );
    expect(acknowledgedBytes()).toBeLessThan(forwardedBytes);

    spawned.stdout.resume();
    await new Promise((resolve) => setImmediate(resolve));

    expect(acknowledgedBytes()).toBe(forwardedBytes);
  });

  it('withholds SDK stdout credit for an async event admission and restores it on settlement', async () => {
    const spawned = spawnClaudeCodeProcessOffMain(options());
    const request = spawnRequest(children[0]);
    spawned.stdout.on('data', () => undefined);
    let releaseAdmission = (): void => undefined;
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    withholdClaudeProcessStdoutCreditUntil(spawned, admission);
    children[0]?.emit('message', {
      type: 'stdout',
      requestId: request.requestId,
      dataBase64: Buffer.alloc(4096, 1).toString('base64'),
    });
    expect(
      children[0]?.postMessage.mock.calls.filter(
        ([message]) => message.type === 'stdout-ack',
      ),
    ).toHaveLength(0);

    releaseAdmission();
    await admission;
    await Promise.resolve();
    expect(
      children[0]?.postMessage.mock.calls.filter(
        ([message]) => message.type === 'stdout-ack',
      ),
    ).toEqual([
      [{ type: 'stdout-ack', requestId: request.requestId, bytes: 4096 }],
    ]);
  });

  it('does not send deferred stdout credit after the SDK process exits', async () => {
    const spawned = spawnClaudeCodeProcessOffMain(options());
    const request = spawnRequest(children[0]);
    spawned.stdout.on('data', () => undefined);
    let releaseAdmission = (): void => undefined;
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    withholdClaudeProcessStdoutCreditUntil(spawned, admission);
    children[0]?.emit('message', {
      type: 'stdout',
      requestId: request.requestId,
      dataBase64: Buffer.alloc(4096, 1).toString('base64'),
    });
    children[0]?.emit('message', {
      type: 'exit',
      requestId: request.requestId,
      code: null,
      signal: 'SIGTERM',
    });
    releaseAdmission();
    await admission;
    await Promise.resolve();
    expect(
      children[0]?.postMessage.mock.calls.filter(
        ([message]) => message.type === 'stdout-ack',
      ),
    ).toHaveLength(0);
  });

  it('returns stdout credit when a routed admission rejects', async () => {
    const spawned = spawnClaudeCodeProcessOffMain(options());
    const request = spawnRequest(children[0]);
    spawned.stdout.on('data', () => undefined);
    let rejectAdmission: (error: Error) => void = () => undefined;
    const admission = new Promise<void>((_resolve, reject) => {
      rejectAdmission = reject;
    });
    // Observe the rejection separately, as the SDK consumer does.
    const observedFailure = admission.catch(() => undefined);
    withholdClaudeProcessStdoutCreditUntil(spawned, admission);
    children[0]?.emit('message', {
      type: 'stdout',
      requestId: request.requestId,
      dataBase64: Buffer.alloc(4096, 1).toString('base64'),
    });
    rejectAdmission(new Error('canonical sink failed'));
    await observedFailure;
    await Promise.resolve();
    expect(
      children[0]?.postMessage.mock.calls.filter(
        ([message]) => message.type === 'stdout-ack',
      ),
    ).toEqual([
      [{ type: 'stdout-ack', requestId: request.requestId, bytes: 4096 }],
    ]);
  });

  describe('with an in-flight byte bound (group commit)', () => {
    const acknowledgements = (): number[] =>
      children[0]?.postMessage.mock.calls.flatMap(([message]) =>
        message.type === 'stdout-ack' ? [message.bytes] : [],
      ) ?? [];
    const send = (requestId: string, bytes: number): void => {
      children[0]?.emit('message', {
        type: 'stdout',
        requestId,
        dataBase64: Buffer.alloc(bytes, 1).toString('base64'),
      });
    };

    it('keeps granting credit during a pending admission up to the bound, then withholds it', async () => {
      const spawned = spawnClaudeCodeProcessOffMain(options());
      const request = spawnRequest(children[0]);
      spawned.stdout.on('data', () => undefined);
      let releaseAdmission = (): void => undefined;
      const admission = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      withholdClaudeProcessStdoutCreditUntil(spawned, admission, 10_000);
      // Events keep arriving while the admission (a commit) is in flight.
      send(request.requestId, 4096);
      send(request.requestId, 4096);
      expect(acknowledgements()).toEqual([4096, 4096]);
      // 12288 bytes have arrived during the hold: past the bound.
      send(request.requestId, 4096);
      send(request.requestId, 4096);
      expect(acknowledgements()).toEqual([4096, 4096]);

      releaseAdmission();
      await admission;
      await Promise.resolve();
      // The withheld credit returns when the admission settles.
      expect(acknowledgements()).toEqual([4096, 4096, 8192]);
      // With nothing pending, credit flows per chunk again.
      send(request.requestId, 4096);
      expect(acknowledgements()).toEqual([4096, 4096, 8192, 4096]);
    });

    it('counts the bytes of overlapping admissions together until all settle', async () => {
      const spawned = spawnClaudeCodeProcessOffMain(options());
      const request = spawnRequest(children[0]);
      spawned.stdout.on('data', () => undefined);
      let releaseFirst = (): void => undefined;
      const first = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let releaseSecond = (): void => undefined;
      const second = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      withholdClaudeProcessStdoutCreditUntil(spawned, first, 6000);
      send(request.requestId, 4096);
      // A second admission does not restart the count.
      withholdClaudeProcessStdoutCreditUntil(spawned, second, 6000);
      send(request.requestId, 4096);
      expect(acknowledgements()).toEqual([4096]);
      // One of two settling grants nothing: the other is still pending.
      releaseFirst();
      await first;
      await Promise.resolve();
      expect(acknowledgements()).toEqual([4096]);
      releaseSecond();
      await second;
      await Promise.resolve();
      expect(acknowledgements()).toEqual([4096, 4096]);
      // The next admission starts from zero.
      const third = new Promise<void>(() => undefined);
      withholdClaudeProcessStdoutCreditUntil(spawned, third, 6000);
      send(request.requestId, 4096);
      expect(acknowledgements()).toEqual([4096, 4096, 4096]);
    });

    it('withholds all credit during an admission when the bound is zero', async () => {
      const spawned = spawnClaudeCodeProcessOffMain(options());
      const request = spawnRequest(children[0]);
      spawned.stdout.on('data', () => undefined);
      let releaseAdmission = (): void => undefined;
      const admission = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      // The setting-off call: identical to passing no bound.
      withholdClaudeProcessStdoutCreditUntil(spawned, admission, 0);
      send(request.requestId, 1);
      send(request.requestId, 4096);
      expect(acknowledgements()).toEqual([]);
      releaseAdmission();
      await admission;
      await Promise.resolve();
      expect(acknowledgements()).toEqual([4097]);
    });
  });

  it('measures host stdout credit while an asynchronous app sink is held', async () => {
    const spawned = spawnClaudeCodeProcessOffMain(options());
    const request = spawnRequest(children[0]);
    const chunk = Buffer.alloc(4 * 1024, 1);
    const encodedFrameBytes = chunk.toString('base64').length;
    let releaseSink = (): void => undefined;
    const heldSink = new Promise<void>((resolve) => {
      releaseSink = resolve;
    });
    let receivedBytes = 0;
    let completedBytes = 0;
    const completions: Promise<void>[] = [];
    spawned.stdout.on('data', (data: Buffer) => {
      receivedBytes += data.length;
      const completion = heldSink.then(() => {
        completedBytes += data.length;
      });
      completions.push(completion);
      // The direct host fixture must connect the app admission receipt to
      // stdout credit, as the Claude session adapter does in production.
      if (typeof withholdClaudeProcessStdoutCreditUntil === 'function') {
        withholdClaudeProcessStdoutCreditUntil(spawned, completion);
      }
    });
    const acknowledgedBytes = (): number =>
      children[0]?.postMessage.mock.calls.reduce(
        (total, [message]) =>
          message.type === 'stdout-ack' ? total + message.bytes : total,
        0,
      ) ?? 0;
    let sourceCredit = 64 * 1024;
    let forwardedBytes = 0;
    let priorAcknowledged = 0;
    try {
      for (let index = 0; index < 128; index += 1) {
        if (sourceCredit < chunk.length) break;
        children[0]?.emit('message', {
          type: 'stdout',
          requestId: request.requestId,
          dataBase64: chunk.toString('base64'),
        });
        forwardedBytes += chunk.length;
        sourceCredit -= chunk.length;
        const currentAcknowledged = acknowledgedBytes();
        sourceCredit += currentAcknowledged - priorAcknowledged;
        priorAcknowledged = currentAcknowledged;
      }
      expect(completedBytes).toBe(0);
      process.stdout.write(
        `CLAUDE_HOST_PRESSURE_METRIC ${JSON.stringify({
          forwardedBytes,
          receivedBytes,
          acknowledgedBytes: acknowledgedBytes(),
          completedBytes,
          sourceCredit,
          rawFrameBytes: chunk.length,
          encodedFrameBytes,
        })}\n`,
      );
      expect(forwardedBytes - completedBytes).toBeLessThanOrEqual(
        64 * 1024 + chunk.length,
      );
    } finally {
      releaseSink();
      spawned.stdout.resume();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await Promise.all(completions);
      spawned.kill('SIGTERM');
    }
    expect(receivedBytes).toBe(forwardedBytes);
    expect(completedBytes).toBe(forwardedBytes);
  });

  it('forwards the SDK grace-period abort signal and later escalation', () => {
    const controller = new AbortController();
    const spawned = spawnClaudeCodeProcessOffMain(options(controller));
    const request = spawnRequest(children[0]);
    expect(request.captureStderr).toBe(false);

    controller.abort();
    expect(children[0]?.postMessage).toHaveBeenCalledWith({
      type: 'kill',
      requestId: request.requestId,
      signal: 'SIGTERM',
    });
    expect(spawned.killed).toBe(true);
    expect(spawned.kill('SIGKILL')).toBe(true);
    expect(children[0]?.postMessage).toHaveBeenCalledWith({
      type: 'kill',
      requestId: request.requestId,
      signal: 'SIGKILL',
    });
  });

  it('runs a bounded CLI command and preserves stdout plus stderr', async () => {
    const result = runClaudeCliProcessOffMain({
      command: '/mock/claude',
      args: ['plugin', 'marketplace', 'update', 'acme'],
      env: { PATH: '/bin' },
      timeoutMs: 1_000,
    });
    const request = spawnRequest(children[0]);
    expect(request.captureStderr).toBe(true);
    children[0]?.emit('message', {
      type: 'stdout',
      requestId: request.requestId,
      dataBase64: Buffer.from('updated').toString('base64'),
    });
    children[0]?.emit('message', {
      type: 'stderr',
      requestId: request.requestId,
      dataBase64: Buffer.from('warning').toString('base64'),
    });
    children[0]?.emit('message', {
      type: 'exit',
      requestId: request.requestId,
      code: 0,
      signal: null,
    });

    await expect(result).resolves.toEqual({
      stdout: 'updated',
      stderr: 'warning',
    });
  });

  it('rejects a failed CLI command with its stderr diagnostic', async () => {
    const result = runClaudeCliProcessOffMain({
      command: '/mock/claude',
      args: ['plugin', 'marketplace', 'update', 'acme'],
      env: { PATH: '/bin' },
      timeoutMs: 1_000,
    });
    const request = spawnRequest(children[0]);
    children[0]?.emit('message', {
      type: 'stderr',
      requestId: request.requestId,
      dataBase64: Buffer.from('marketplace not found').toString('base64'),
    });
    children[0]?.emit('message', {
      type: 'exit',
      requestId: request.requestId,
      code: 1,
      signal: null,
    });

    await expect(result).rejects.toThrow('marketplace not found');
  });

  it('SIGKILLs a CLI command when combined output exceeds its bound', async () => {
    const result = runClaudeCliProcessOffMain({
      command: '/mock/claude',
      args: ['plugin', 'marketplace', 'update', 'acme'],
      env: { PATH: '/bin' },
      timeoutMs: 1_000,
      maxOutputBytes: 8,
    });
    let rejectionMessage: string | undefined;
    void result.catch((error: unknown) => {
      rejectionMessage = error instanceof Error ? error.message : String(error);
    });
    const request = spawnRequest(children[0]);
    children[0]?.emit('message', {
      type: 'stdout',
      requestId: request.requestId,
      dataBase64: Buffer.from('12345').toString('base64'),
    });
    children[0]?.emit('message', {
      type: 'stderr',
      requestId: request.requestId,
      dataBase64: Buffer.from('6789').toString('base64'),
    });

    expect(children[0]?.postMessage).toHaveBeenCalledWith({
      type: 'kill',
      requestId: request.requestId,
      signal: 'SIGKILL',
    });
    await Promise.resolve();
    expect(rejectionMessage).toContain('8-byte output limit');
    children[0]?.emit('message', {
      type: 'exit',
      requestId: request.requestId,
      code: null,
      signal: 'SIGKILL',
    });
  });

  it('SIGKILLs a CLI command at its timeout', async () => {
    jest.useFakeTimers();
    try {
      const result = runClaudeCliProcessOffMain({
        command: '/mock/claude',
        args: ['plugin', 'marketplace', 'update', 'acme'],
        env: { PATH: '/bin' },
        timeoutMs: 1_000,
      });
      let rejectionMessage: string | undefined;
      void result.catch((error: unknown) => {
        rejectionMessage =
          error instanceof Error ? error.message : String(error);
      });
      const request = spawnRequest(children[0]);

      await jest.advanceTimersByTimeAsync(1_000);
      expect(children[0]?.postMessage).toHaveBeenCalledWith({
        type: 'kill',
        requestId: request.requestId,
        signal: 'SIGKILL',
      });
      expect(rejectionMessage).toContain('1000ms deadline');
      children[0]?.emit('message', {
        type: 'exit',
        requestId: request.requestId,
        code: null,
        signal: 'SIGKILL',
      });
      await jest.advanceTimersByTimeAsync(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('orders spawn before kill when the forwarded signal is already aborted', () => {
    const controller = new AbortController();
    controller.abort();

    spawnClaudeCodeProcessOffMain(options(controller));
    const request = spawnRequest(children[0]);

    expect(
      children[0]?.postMessage.mock.calls.map(([message]) => message),
    ).toEqual([
      request,
      {
        type: 'kill',
        requestId: request.requestId,
        signal: 'SIGTERM',
      },
    ]);
  });

  it('fails active proxies and creates a fresh host after a utility crash', async () => {
    let finishCleanup = (): void => undefined;
    killProcessGroupByPidMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
    );
    const interrupted = spawnClaudeCodeProcessOffMain(options());
    let failureDelivered = false;
    const error = new Promise<Error>((resolve) =>
      interrupted.once('error', (failure) => {
        failureDelivered = true;
        resolve(failure);
      }),
    );
    const exit = new Promise<[number | null, NodeJS.Signals | null]>(
      (resolve) =>
        interrupted.once('exit', (code, signal) => resolve([code, signal])),
    );
    interrupted.stdout.resume();

    children[0]?.emit('message', {
      type: 'started',
      requestId: spawnRequest(children[0]).requestId,
      pid: 4242,
    });

    children[0]?.emit('exit', 9);
    await Promise.resolve();
    expect(killProcessGroupByPidMock).toHaveBeenCalledWith(4242, 'SIGKILL');
    expect(failureDelivered).toBe(false);
    finishCleanup();

    const failure = await error;
    expect(failure.message).toContain('exited before the Claude process');
    await expect(exit).resolves.toEqual([null, 'SIGKILL']);
    expect(interrupted.stdout.readableEnded).toBe(true);

    spawnClaudeCodeProcessOffMain(options());
    expect(forkMock).toHaveBeenCalledTimes(2);
  });

  it('uses bounded host shutdown and waits for the utility exit', async () => {
    spawnClaudeCodeProcessOffMain(options());
    const shutdown = shutdownClaudeProcessHost();

    expect(children[0]?.postMessage).toHaveBeenCalledWith({ type: 'shutdown' });
    children[0]?.emit('exit', 0);

    await expect(shutdown).resolves.toBeUndefined();
  });

  it('waits for crash cleanup after the worker reference is cleared', async () => {
    let finishCleanup = (): void => undefined;
    killProcessGroupByPidMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
    );
    spawnClaudeCodeProcessOffMain(options());
    const request = spawnRequest(children[0]);
    children[0]?.emit('message', {
      type: 'started',
      requestId: request.requestId,
      pid: 4242,
    });
    children[0]?.emit('exit', 9);

    let resolved = false;
    const shutdown = shutdownClaudeProcessHost().then(() => {
      resolved = true;
    });
    await Promise.resolve();

    expect(killProcessGroupByPidMock).toHaveBeenCalledWith(4242, 'SIGKILL');
    expect(resolved).toBe(false);

    finishCleanup();
    await shutdown;
    expect(resolved).toBe(true);
  });

  it('force-kills an unresponsive utility and still bounds cleanup waiting', async () => {
    jest.useFakeTimers();
    try {
      spawnClaudeCodeProcessOffMain(options());
      let resolved = false;
      const shutdown = shutdownClaudeProcessHost().then(() => {
        resolved = true;
      });

      await jest.advanceTimersByTimeAsync(6_000);
      expect(children[0]?.kill).toHaveBeenCalledTimes(1);
      expect(resolved).toBe(false);

      children[0]?.emit('exit', 9);
      await shutdown;
      expect(resolved).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
