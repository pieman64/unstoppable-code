import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IndexWorkerRequest } from '../chat-search/index-worker-contract';

const mockAsyncRm = jest.fn<
  Promise<void>,
  [string, { recursive: boolean; force: boolean }]
>();
interface FsPromisesModule {
  rm: typeof mockAsyncRm;
}
jest.mock('node:fs/promises', () => ({
  rm: (
    path: string,
    options: { recursive: boolean; force: boolean },
  ): Promise<void> => mockAsyncRm(path, options),
}));
const realAsyncRm = jest.requireActual<FsPromisesModule>('node:fs/promises').rm;

class FakeWorker extends EventEmitter {
  readonly postMessage = jest.fn<void, [IndexWorkerRequest]>();
  readonly unref = jest.fn();
  readonly terminate = jest.fn((): Promise<number> => Promise.resolve(0));
}
const workerFactory = jest.fn<FakeWorker, unknown[]>();
jest.mock('node:worker_threads', () => ({
  Worker: function (...args: unknown[]): FakeWorker {
    return workerFactory(...args);
  },
}));
import { ChatSearchIndexWorkerRunner } from '../chat-search/index-worker-runner';

describe('ChatSearchIndexWorkerRunner', () => {
  let worker: FakeWorker;
  let runner: ChatSearchIndexWorkerRunner;
  let log: jest.SpyInstance;
  beforeEach(() => {
    mockAsyncRm.mockReset().mockImplementation(realAsyncRm);
    worker = new FakeWorker();
    workerFactory.mockReturnValue(worker);
    log = jest
      .spyOn(console, 'error')
      .mockImplementation((): void => undefined);
    runner = new ChatSearchIndexWorkerRunner('/tmp/derived.sqlite');
  });
  afterEach(async () => {
    worker.emit('error', new Error('test cleanup'));
    await runner.close();
    log.mockRestore();
  });
  function ready(): void {
    worker.emit('message', { kind: 'ready', dbPath: '/tmp/derived.sqlite' });
  }
  function complete(value?: unknown): void {
    const request = worker.postMessage.mock.calls.at(-1)?.[0];
    worker.emit('message', {
      kind: 'result',
      id: request?.id,
      ok: true,
      value,
    });
  }
  it('waits for readiness and serializes writes and barriers in FIFO order', async () => {
    const first = runner.run('setMetadata', ['a', '1']);
    const second = runner.run('barrier');
    expect(worker.postMessage).not.toHaveBeenCalled();
    ready();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    complete();
    await first;
    expect(worker.postMessage.mock.calls[1]?.[0].method).toBe('barrier');
    complete();
    await second;
  });
  it('bounds the waiting queue without discarding already accepted writes', async () => {
    ready();
    const accepted = Array.from({ length: 257 }, () => runner.run('barrier'));
    await expect(runner.run('barrier')).rejects.toThrow('queue is full');
    for (const promise of accepted) {
      complete();
      await promise;
    }
  });
  it('rejects current and waiting work after a worker crash, with no fallback', async () => {
    ready();
    const first = runner.run('barrier');
    const second = runner.run('barrier');
    worker.emit('exit', 1);
    await expect(first).rejects.toThrow('exited');
    await expect(second).rejects.toThrow('exited');
    await expect(runner.run('barrier')).rejects.toThrow('exited');
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
  });
  it('removes a temporary fallback index after an abnormal worker exit', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'canopy-search-index-'));
    try {
      worker.emit('message', {
        kind: 'ready',
        dbPath: join(directory, 'index.sqlite'),
      });
      const pending = runner.run('barrier');
      worker.emit('exit', 1);
      await expect(pending).rejects.toThrow('exited');
      await runner.close();
      expect(existsSync(directory)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('uses non-blocking temporary cleanup and awaits it during close', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'canopy-search-index-'));
    let releaseRemoval: (() => void) | undefined;
    mockAsyncRm.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseRemoval = resolve;
        }),
    );
    try {
      worker.emit('message', {
        kind: 'ready',
        dbPath: join(directory, 'index.sqlite'),
      });
      worker.emit('exit', 0);
      const closing = runner.close();
      let closed = false;
      void closing.then(() => {
        closed = true;
      });
      await Promise.resolve();

      expect(mockAsyncRm).toHaveBeenCalledWith(directory, {
        recursive: true,
        force: true,
      });
      expect(closed).toBe(false);

      releaseRemoval?.();
      await closing;
    } finally {
      releaseRemoval?.();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('flushes accepted writes before closing and rejects new work during shutdown', async () => {
    ready();
    const write = runner.run('setMetadata', ['a', '1']);
    const closing = runner.close();
    await expect(runner.run('barrier')).rejects.toThrow('closing');
    complete();
    await write;
    expect(worker.postMessage.mock.calls.at(-1)?.[0].method).toBe('close');
    complete();
    await closing;
    expect(worker.terminate).toHaveBeenCalled();
  });
  it('reserves shutdown control capacity after the waiting queue is full', async () => {
    ready();
    const accepted = Array.from({ length: 257 }, () => runner.run('barrier'));
    const closing = runner.close();
    for (const promise of accepted) {
      complete();
      await promise;
    }
    expect(worker.postMessage.mock.calls.at(-1)?.[0].method).toBe('close');
    complete();
    await expect(closing).resolves.toBeUndefined();
  });
  it('bounds shutdown even when the worker never acknowledges or terminates', async () => {
    jest.useFakeTimers();
    ready();
    worker.terminate.mockImplementation(
      () => new Promise<number>(() => undefined),
    );
    const closing = runner.close();
    await jest.advanceTimersByTimeAsync(6000);
    await expect(closing).resolves.toBeUndefined();
    jest.useRealTimers();
  });
  it('fails closed on mismatched replies rather than acknowledging the wrong write', async () => {
    ready();
    const write = runner.run('barrier');
    worker.emit('message', { kind: 'result', id: 99, ok: true });
    await expect(write).rejects.toThrow('Unexpected');
  });
});
