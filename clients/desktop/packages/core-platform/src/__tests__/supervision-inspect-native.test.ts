import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { PlatformProcessInspection } from '@canopy/core-runtime';
import { createProcessInspector } from '../supervision/inspect';
import { windowsProcessObserver } from '../supervision/windows-process';
import { NODE_SUPERVISION } from '../supervision/shared';

const os =
  process.platform === 'win32'
    ? 'win32'
    : process.platform === 'darwin'
      ? 'darwin'
      : 'linux';
const fresh = (): ReturnType<typeof createProcessInspector> => {
  const inspect = createProcessInspector(os, {
    ...NODE_SUPERVISION,
    windowsProcess: windowsProcessObserver(
      resolve(
        __dirname,
        '../../../..',
        '.cache/bin/win32-x64/canopy-process-identity.exe',
      ),
    ),
  });
  return async (request) => {
    const started = performance.now();
    const result = await inspect(request);
    if (os === 'win32' && result.state === 'running')
      expect(performance.now() - started).toBeLessThan(4000);
    return result;
  };
};

async function bounded<T>(promise: Promise<T>, ms = 12_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Observer deadline exceeded')),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function nextMessage(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Observer reply deadline exceeded'));
    }, 12_000);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off('message', message);
      child.off('error', error);
      child.off('close', close);
    };
    const message = (value: unknown): void => {
      cleanup();
      resolve(value);
    };
    const error = (value: Error): void => {
      cleanup();
      reject(value);
    };
    const close = (): void => {
      cleanup();
      reject(new Error('Observer closed before reply'));
    };
    child.once('message', message);
    child.once('error', error);
    child.once('close', close);
  });
}

function forkObserver(): ChildProcess {
  // fork forwards spawn options, but its types omit windowsHide.
  const options: ForkOptions & { windowsHide: boolean } = {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  };
  return fork(
    join(__dirname, 'fixtures/process-inspection-observer.ts'),
    [],
    options,
  );
}

function requireRunning(
  result: PlatformProcessInspection,
  pid: number,
  createdAfter = 0,
): void {
  expect(result).toMatchObject({ state: 'running' });
  if (result.state !== 'running')
    throw new Error(`PID ${pid} has no running identity`);
  const identity = result.startIdentity;
  if (os === 'win32') {
    expect(identity).toMatch(new RegExp(`^win32:v1:${pid}:\\d{20}$`));
    const digits = identity.split(':')[3] ?? '';
    const iso = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}.${digits.slice(14, 17)}Z`;
    const started = Date.parse(iso);
    expect(Number.isFinite(started)).toBe(true);
    expect(new Date(started).toISOString()).toBe(iso);
    expect(started).toBeGreaterThan(Date.UTC(2000, 0));
    expect(started).toBeGreaterThanOrEqual(createdAfter);
    expect(started).toBeLessThanOrEqual(Date.now());
  } else if (os === 'darwin') {
    expect(identity).toMatch(new RegExp(`^darwin:v1:${pid}:\\d+$`));
    const started = Number(identity.split(':')[3]) * 1000;
    expect(started).toBeGreaterThanOrEqual(
      Math.floor(createdAfter / 1000) * 1000,
    );
    expect(started).toBeLessThanOrEqual(Date.now());
  } else {
    expect(identity).toMatch(
      new RegExp(
        `^linux:v1:${pid}:[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}:\\d+$`,
      ),
    );
  }
}

describe('native process incarnation identity', () => {
  it('executes the source-relative observer in a fresh tsx ESM process', async () => {
    const child = forkObserver();
    child.on('error', () => {});
    const closed = new Promise<void>((resolve) =>
      child.once('close', () => resolve()),
    );
    try {
      await expect(nextMessage(child)).resolves.toEqual({
        kind: 'ready',
        pid: child.pid,
      });
      const reply = nextMessage(child);
      child.send({ kind: 'observe', pids: [] });
      await expect(reply).resolves.toEqual({ kind: 'observed', results: [] });
      child.send('exit');
      await bounded(closed, 3000);
      expect(child.exitCode).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await bounded(closed, 3000);
    }
  }, 20_000);

  it('self is running and repeated fresh inspectors agree', async () => {
    const inspect = fresh();
    const self = await inspect({ pid: process.pid });
    requireRunning(self, process.pid);
    await expect(inspect({ pid: process.pid })).resolves.toEqual(self);
    await expect(fresh()({ pid: process.pid })).resolves.toEqual(self);
  }, 20_000);

  it('independently live child, child self and separate observer agree; closed child is absent', async () => {
    const children: Array<{ child: ChildProcess; closed: Promise<void> }> = [];
    const start = async (): Promise<{
      child: ChildProcess;
      createdAfter: number;
    }> => {
      const createdAfter = Date.now();
      const child = forkObserver();
      child.on('error', () => {});
      const closed = new Promise<void>((resolve) =>
        child.once('close', () => resolve()),
      );
      children.push({ child, closed });
      await expect(nextMessage(child)).resolves.toEqual({
        kind: 'ready',
        pid: child.pid,
      });
      return { child, createdAfter };
    };
    const observe = async (
      child: ChildProcess,
      pids: number[],
    ): Promise<unknown> => {
      const reply = nextMessage(child);
      child.send({ kind: 'observe', pids });
      return reply;
    };
    try {
      const { child, createdAfter } = await start();
      const pid = child.pid ?? 0;
      const inspect = fresh();
      const self = await inspect({ pid: process.pid });
      const external = await inspect({ pid });
      requireRunning(self, process.pid);
      requireRunning(external, pid, createdAfter);
      expect(external).not.toEqual(self);
      await expect(inspect({ pid })).resolves.toEqual(external);
      await expect(fresh()({ pid })).resolves.toEqual(external);
      await expect(observe(child, [pid, process.pid])).resolves.toEqual({
        kind: 'observed',
        results: [external, self],
      });
      const { child: observer } = await start();
      await expect(observe(observer, [pid, process.pid])).resolves.toEqual({
        kind: 'observed',
        results: [external, self],
      });
      // Both IPC replies establish liveness independently of process inspection.
      expect(child.connected).toBe(true);
      expect(child.exitCode).toBeNull();
      child.send('exit');
      await bounded(
        children[0]?.closed ?? Promise.reject(new Error('Missing child')),
        3000,
      );
      expect(child.exitCode).toBe(0);
      await expect(inspect({ pid })).resolves.toEqual({ state: 'absent' });
    } finally {
      await Promise.all(
        children.map(async ({ child, closed }) => {
          if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGKILL');
          await bounded(closed, 3000);
        }),
      );
    }
  }, 60_000);
});
