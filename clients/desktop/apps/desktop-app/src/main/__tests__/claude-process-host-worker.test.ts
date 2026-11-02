import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type {
  ClaudeProcessHostResponse,
  ClaudeProcessHostSpawnRequest,
} from '../agents/claude-process-host-protocol';

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly kill = jest.fn<boolean, [NodeJS.Signals]>(() => {
    this.killed = true;
    return true;
  });
}

const spawnMock = jest.fn<FakeChildProcess, unknown[]>();
const killProcessGroupByPidMock = jest.fn<
  Promise<void>,
  [number, NodeJS.Signals, { timeoutMs: number }]
>(() => Promise.resolve());
jest.mock('@canopy/desktop-shared/node/lib/process-kill', () => ({
  killProcessGroupByPid: (
    ...args: [number, NodeJS.Signals, { timeoutMs: number }]
  ): Promise<void> => killProcessGroupByPidMock(...args),
}));
const killChildProcessGroupMock = jest.fn<
  void,
  [FakeChildProcess, NodeJS.Signals]
>();
jest.mock('node:child_process', () => ({
  spawn: (...args: unknown[]): FakeChildProcess => spawnMock(...args),
}));
jest.mock('../lib/process-kill', () => ({
  killChildProcessGroup: (...args: [FakeChildProcess, NodeJS.Signals]): void =>
    killChildProcessGroupMock(...args),
}));

import { startClaudeProcessHost } from '../agents/claude-process-host-worker';
import type { ParentPort } from 'electron';

class FakeParentPort extends EventEmitter implements ParentPort {
  public readonly postMessage = jest.fn<void, [ClaudeProcessHostResponse]>();
}

function request(requestId = 'request-1'): ClaudeProcessHostSpawnRequest {
  return {
    type: 'spawn',
    requestId,
    command: '/mock/claude',
    args: ['--output-format', 'stream-json'],
    cwd: '/repo',
    env: { PATH: '/bin' },
    captureStderr: true,
  };
}

describe('Claude process host worker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('drains SDK stderr without forwarding it when capture is disabled', () => {
    const parent = new FakeParentPort();
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    startClaudeProcessHost(parent);

    parent.emit('message', {
      data: { ...request(), captureStderr: false },
    });
    child.stderr.write(Buffer.from('verbose SDK diagnostic'));

    expect(parent.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stderr' }),
    );
  });

  it('spawns detached in the utility and preserves stdin/stdout/stderr bytes', async () => {
    const parent = new FakeParentPort();
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    startClaudeProcessHost(parent);
    const stdin: Buffer[] = [];
    child.stdin.on('data', (chunk: Buffer) => stdin.push(chunk));

    parent.emit('message', { data: request() });
    expect(spawnMock).toHaveBeenCalledWith(
      '/mock/claude',
      ['--output-format', 'stream-json'],
      expect.objectContaining({
        cwd: '/repo',
        env: { PATH: '/bin' },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      }),
    );
    const started = parent.postMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === 'started');
    if (started?.type !== 'started') throw new Error('Expected started.');
    expect(started).toEqual({
      type: 'started',
      requestId: 'request-1',
      pid: 4242,
      startedAtMs: started.startedAtMs,
    });
    expect(Number.isFinite(started.startedAtMs)).toBe(true);

    parent.emit('message', {
      data: {
        type: 'stdin',
        requestId: 'request-1',
        dataBase64: Buffer.from([0, 1, 255]).toString('base64'),
      },
    });
    parent.emit('message', {
      data: { type: 'stdin-end', requestId: 'request-1' },
    });
    child.stdout.write(Buffer.from([255, 1]));
    child.stderr.write(Buffer.from('marketplace warning'));
    child.exitCode = 0;
    child.emit('exit', 0, null);
    child.stdout.write(Buffer.from([0]));
    expect(parent.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'exit', requestId: 'request-1' }),
    );
    child.stdout.end();
    child.emit('close', 0, null);
    await new Promise((resolve) => setImmediate(resolve));

    expect(Buffer.concat(stdin)).toEqual(Buffer.from([0, 1, 255]));
    const responses = parent.postMessage.mock.calls.map(
      ([response]) => response,
    );
    const stdout = responses.filter((response) => response.type === 'stdout');
    const stderr = responses.filter(
      (response) => (response as { type?: string }).type === 'stderr',
    ) as Array<{ type: 'stderr'; requestId: string; dataBase64: string }>;
    expect(
      Buffer.concat(
        stdout.map((response) => Buffer.from(response.dataBase64, 'base64')),
      ),
    ).toEqual(Buffer.from([255, 1, 0]));
    expect(
      Buffer.concat(
        stderr.map((response) => Buffer.from(response.dataBase64, 'base64')),
      ).toString('utf8'),
    ).toBe('marketplace warning');
    expect(responses.map((response) => response.type)).toEqual([
      'started',
      'stdout',
      'stderr',
      'stdout',
      'exit',
    ]);
    expect(parent.postMessage).toHaveBeenCalledWith({
      type: 'exit',
      requestId: 'request-1',
      code: 0,
      signal: null,
    });
  });

  it('kills only the addressed process group', () => {
    const parent = new FakeParentPort();
    const first = new FakeChildProcess();
    const second = new FakeChildProcess();
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    startClaudeProcessHost(parent);
    parent.emit('message', { data: request('first') });
    parent.emit('message', { data: request('second') });

    parent.emit('message', {
      data: { type: 'kill', requestId: 'first', signal: 'SIGTERM' },
    });

    expect(killChildProcessGroupMock).toHaveBeenCalledWith(first, 'SIGTERM');
    expect(killChildProcessGroupMock).not.toHaveBeenCalledWith(
      second,
      expect.anything(),
    );
    // Exit as a real child would, so no SIGKILL escalation reaches a later test.
    first.emit('exit', null, 'SIGTERM');
  });

  it('tracks stdout credit independently for each child', () => {
    const parent = new FakeParentPort();
    const first = new FakeChildProcess();
    const second = new FakeChildProcess();
    const firstPause = jest.spyOn(first.stdout, 'pause');
    const secondPause = jest.spyOn(second.stdout, 'pause');
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    startClaudeProcessHost(parent);
    parent.emit('message', { data: request('first') });
    parent.emit('message', { data: request('second') });
    firstPause.mockClear();
    secondPause.mockClear();
    parent.postMessage.mockClear();

    first.stdout.write(Buffer.alloc(64 * 1024, 1));
    second.stdout.write(Buffer.from('independent'));

    expect(firstPause).toHaveBeenCalledTimes(1);
    expect(secondPause).not.toHaveBeenCalled();
    expect(parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'stdout',
        requestId: 'second',
      }),
    );
  });

  it('bounds stdout bytes forwarded without runner acknowledgements', async () => {
    const parent = new FakeParentPort();
    const child = new FakeChildProcess();
    const pause = jest.spyOn(child.stdout, 'pause');
    spawnMock.mockReturnValue(child);
    startClaudeProcessHost(parent);
    parent.emit('message', { data: request() });
    pause.mockClear();
    parent.postMessage.mockClear();

    const chunk = Buffer.alloc(4 * 1024, 1);
    for (let index = 0; index < 40; index += 1) {
      child.stdout.write(chunk);
    }
    child.stdout.end();
    child.emit('close', 0, null);

    const forwardedBytes = (): number =>
      parent.postMessage.mock.calls.reduce(
        (total, [response]) =>
          response.type === 'stdout'
            ? total + Buffer.from(response.dataBase64, 'base64').length
            : total,
        0,
      );
    expect(forwardedBytes()).toBeLessThanOrEqual(64 * 1024);
    expect(pause).toHaveBeenCalled();
    expect(parent.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'exit' }),
    );

    let acknowledgedBytes = 0;
    while (acknowledgedBytes < 40 * chunk.length) {
      for (
        let attempt = 0;
        forwardedBytes() === acknowledgedBytes && attempt < 10;
        attempt += 1
      ) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const availableBytes = forwardedBytes() - acknowledgedBytes;
      expect(availableBytes).toBeGreaterThan(0);
      expect(availableBytes).toBeLessThanOrEqual(64 * 1024);
      acknowledgedBytes += availableBytes;
      parent.emit('message', {
        data: {
          type: 'stdout-ack',
          requestId: 'request-1',
          bytes: availableBytes,
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(forwardedBytes()).toBe(40 * chunk.length);
    await new Promise((resolve) => setImmediate(resolve));
    expect(parent.postMessage).toHaveBeenCalledWith({
      type: 'exit',
      requestId: 'request-1',
      code: 0,
      signal: null,
    });
  });

  it('releases a killed child whose stdout is blocked on credit', async () => {
    const parent = new FakeParentPort();
    const child = new FakeChildProcess();
    const pause = jest.spyOn(child.stdout, 'pause');
    const resume = jest.spyOn(child.stdout, 'resume');
    spawnMock.mockReturnValue(child);
    startClaudeProcessHost(parent);
    parent.emit('message', { data: request() });
    pause.mockClear();
    resume.mockClear();
    parent.postMessage.mockClear();

    child.stdout.write(Buffer.alloc(64 * 1024, 1));
    child.stdout.write(Buffer.alloc(4 * 1024, 2));
    expect(pause).toHaveBeenCalled();

    parent.emit('message', {
      data: { type: 'kill', requestId: 'request-1', signal: 'SIGTERM' },
    });
    child.emit('exit', null, 'SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));

    expect(resume).toHaveBeenCalled();
    expect(parent.postMessage).toHaveBeenCalledWith({
      type: 'exit',
      requestId: 'request-1',
      code: null,
      signal: 'SIGTERM',
    });

    parent.emit('message', { data: request() });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('releases a credit-blocked child killed after it already exited', async () => {
    const parent = new FakeParentPort();
    const child = new FakeChildProcess();
    const resume = jest.spyOn(child.stdout, 'resume');
    spawnMock.mockReturnValue(child);
    startClaudeProcessHost(parent);
    parent.emit('message', { data: request() });
    resume.mockClear();
    parent.postMessage.mockClear();

    child.stdout.write(Buffer.alloc(64 * 1024, 1));
    child.stdout.write(Buffer.alloc(4 * 1024, 2));
    child.emit('exit', 0, null);
    expect(parent.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'exit' }),
    );

    parent.emit('message', {
      data: { type: 'kill', requestId: 'request-1', signal: 'SIGTERM' },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(resume).toHaveBeenCalled();
    expect(killChildProcessGroupMock).not.toHaveBeenCalled();
    expect(parent.postMessage).toHaveBeenCalledWith({
      type: 'exit',
      requestId: 'request-1',
      code: 0,
      signal: null,
    });

    parent.emit('message', { data: request() });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('finishes and releases a child whose stdout errors before end', async () => {
    const parent = new FakeParentPort();
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    startClaudeProcessHost(parent);

    parent.emit('message', { data: request() });

    expect(() => child.stdin.emit('error', new Error('EPIPE'))).not.toThrow();
    expect(() =>
      child.stdout.emit('error', new Error('ERR_STREAM_DESTROYED')),
    ).not.toThrow();
    expect(() =>
      child.stderr.emit('error', new Error('ERR_STREAM_DESTROYED')),
    ).not.toThrow();

    child.emit('close', 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    expect(parent.postMessage).toHaveBeenCalledWith({
      type: 'exit',
      requestId: 'request-1',
      code: 0,
      signal: null,
    });

    parent.emit('message', { data: request() });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('kills every active child before shutdown completes', async () => {
    const parent = new FakeParentPort();
    const exitProcess = jest.fn<void, [number]>();
    const first = new FakeChildProcess();
    const second = new FakeChildProcess();
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    startClaudeProcessHost(parent, exitProcess);
    parent.emit('message', { data: request('first') });
    parent.emit('message', { data: request('second') });

    parent.emit('message', { data: { type: 'shutdown' } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(killProcessGroupByPidMock).toHaveBeenCalledTimes(2);
    expect(parent.postMessage).toHaveBeenCalledWith({
      type: 'shutdown-complete',
    });
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it.each(['win32', 'linux', 'darwin'])(
    'waits for every %s tree kill before acknowledging shutdown and exiting',
    async (hostPlatform) => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: hostPlatform,
      });
      try {
        const parent = new FakeParentPort();
        const exitProcess = jest.fn<void, [number]>();
        const first = new FakeChildProcess();
        const second = new FakeChildProcess();
        second.pid = 4243;
        let finishFirst = (): void => undefined;
        let finishSecond = (): void => undefined;
        killProcessGroupByPidMock
          .mockImplementationOnce(
            () =>
              new Promise<void>((resolve) => {
                finishFirst = resolve;
              }),
          )
          .mockImplementationOnce(
            () =>
              new Promise<void>((resolve) => {
                finishSecond = resolve;
              }),
          );
        spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
        startClaudeProcessHost(parent, exitProcess);
        parent.emit('message', { data: request('first') });
        parent.emit('message', { data: request('second') });

        parent.emit('message', { data: { type: 'shutdown' } });
        parent.emit('message', { data: { type: 'shutdown' } });
        expect(exitProcess).not.toHaveBeenCalled();
        expect(parent.postMessage).not.toHaveBeenCalledWith({
          type: 'shutdown-complete',
        });
        expect(killProcessGroupByPidMock).toHaveBeenCalledWith(
          4242,
          'SIGKILL',
          {
            timeoutMs: 5_000,
          },
        );
        expect(killProcessGroupByPidMock).toHaveBeenCalledWith(
          4243,
          'SIGKILL',
          {
            timeoutMs: 5_000,
          },
        );
        finishFirst();
        await new Promise((resolve) => setImmediate(resolve));
        expect(exitProcess).not.toHaveBeenCalled();
        finishSecond();
        await new Promise((resolve) => setImmediate(resolve));
        expect(parent.postMessage).toHaveBeenCalledWith({
          type: 'shutdown-complete',
        });
        expect(exitProcess).toHaveBeenCalledTimes(1);
        expect(exitProcess).toHaveBeenCalledWith(0);
        expect(killProcessGroupByPidMock).toHaveBeenCalledTimes(2);
      } finally {
        if (platform) Object.defineProperty(process, 'platform', platform);
      }
    },
  );

  it('keeps a child that errors after spawning tracked until it exits', async () => {
    const parent = new FakeParentPort();
    const exitProcess = jest.fn<void, [number]>();
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    startClaudeProcessHost(parent, exitProcess);
    parent.emit('message', { data: request() });

    // A spawned child (it has a pid) can still emit 'error', for example when
    // a signal cannot be delivered. That error does not mean it exited.
    child.emit('error', new Error('kill EPERM'));
    expect(parent.postMessage).toHaveBeenCalledWith({
      type: 'error',
      requestId: 'request-1',
      message: 'kill EPERM',
      exitPending: true,
    });

    parent.emit('message', {
      data: { type: 'kill', requestId: 'request-1', signal: 'SIGKILL' },
    });
    expect(killChildProcessGroupMock).toHaveBeenCalledWith(child, 'SIGKILL');

    parent.emit('message', { data: { type: 'shutdown' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(killProcessGroupByPidMock).toHaveBeenCalledWith(4242, 'SIGKILL', {
      timeoutMs: 5_000,
    });
  });

  it('reports one error and survives a spawned child that errors twice', () => {
    const parent = new FakeParentPort();
    const exitProcess = jest.fn<void, [number]>();
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    startClaudeProcessHost(parent, exitProcess);
    parent.emit('message', { data: request() });

    child.emit('error', new Error('kill EPERM'));
    // An unhandled second 'error' would throw and take every child down with
    // the host.
    expect(() => child.emit('error', new Error('kill ESRCH'))).not.toThrow();
    const errors = parent.postMessage.mock.calls.filter(
      ([response]) => response.type === 'error',
    );
    expect(errors).toHaveLength(1);
  });

  it('reports the exit of a child that errored after spawning', async () => {
    const parent = new FakeParentPort();
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    startClaudeProcessHost(parent);
    parent.emit('message', { data: request() });

    child.emit('error', new Error('kill EPERM'));
    child.stdout.end();
    child.emit('exit', null, 'SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await new Promise((resolve) => setImmediate(resolve));

    expect(parent.postMessage).toHaveBeenCalledWith({
      type: 'exit',
      requestId: 'request-1',
      code: null,
      signal: 'SIGKILL',
    });
  });

  it('releases a child whose spawn failed asynchronously', () => {
    const parent = new FakeParentPort();
    const child = new FakeChildProcess();
    child.pid = undefined;
    spawnMock.mockReturnValue(child);
    startClaudeProcessHost(parent);
    parent.emit('message', { data: request() });

    child.emit('error', new Error('spawn ENOENT'));
    expect(parent.postMessage).toHaveBeenCalledWith({
      type: 'error',
      requestId: 'request-1',
      message: 'spawn ENOENT',
    });

    parent.emit('message', { data: request() });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  describe('SIGTERM escalation', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('SIGKILLs the process group of a child that ignores SIGTERM', () => {
      const parent = new FakeParentPort();
      const child = new FakeChildProcess();
      spawnMock.mockReturnValue(child);
      startClaudeProcessHost(parent);
      parent.emit('message', { data: request() });

      parent.emit('message', {
        data: { type: 'kill', requestId: 'request-1', signal: 'SIGTERM' },
      });
      expect(killChildProcessGroupMock).toHaveBeenCalledWith(child, 'SIGTERM');
      expect(killChildProcessGroupMock).not.toHaveBeenCalledWith(
        child,
        'SIGKILL',
      );

      jest.advanceTimersByTime(5_000);
      expect(killChildProcessGroupMock).toHaveBeenCalledWith(child, 'SIGKILL');
    });

    it('does not SIGKILL a child that exits after SIGTERM', () => {
      const parent = new FakeParentPort();
      const child = new FakeChildProcess();
      spawnMock.mockReturnValue(child);
      startClaudeProcessHost(parent);
      parent.emit('message', { data: request() });

      parent.emit('message', {
        data: { type: 'kill', requestId: 'request-1', signal: 'SIGTERM' },
      });
      child.emit('exit', null, 'SIGTERM');
      jest.advanceTimersByTime(5_000);

      expect(killChildProcessGroupMock).toHaveBeenCalledTimes(1);
      expect(killChildProcessGroupMock).toHaveBeenCalledWith(child, 'SIGTERM');
    });
  });

  it('reports spawn failures without affecting later requests', () => {
    const parent = new FakeParentPort();
    spawnMock
      .mockImplementationOnce(() => {
        throw new Error('spawn failed');
      })
      .mockReturnValueOnce(new FakeChildProcess());
    startClaudeProcessHost(parent);

    parent.emit('message', { data: request('broken') });
    parent.emit('message', { data: request('healthy') });

    expect(parent.postMessage).toHaveBeenCalledWith({
      type: 'error',
      requestId: 'broken',
      message: 'spawn failed',
    });
    expect(parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'started', requestId: 'healthy' }),
    );
  });

  it('reports the wall-clock time taken just before the spawn with the pid (CAN-4835)', () => {
    const parent = new FakeParentPort();
    let spawnedAt = 0;
    spawnMock.mockImplementation(() => {
      spawnedAt = Date.now();
      return new FakeChildProcess();
    });
    startClaudeProcessHost(parent);
    const before = Date.now();

    parent.emit('message', { data: request() });

    const started = parent.postMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === 'started');
    if (started?.type !== 'started') throw new Error('Expected started.');
    expect(started.pid).toBe(4242);
    expect(started.startedAtMs).toBeGreaterThanOrEqual(before);
    expect(started.startedAtMs).toBeLessThanOrEqual(spawnedAt);
  });
});
