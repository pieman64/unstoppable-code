import { EventEmitter } from 'node:events';
import { BrowserInventoryQueue } from '../inventory-queue';

class Worker extends EventEmitter {
  request?: { profileId: string; storageGeneration: number };
  killed = false;
  postMessage(request: { profileId: string; storageGeneration: number }): void {
    this.request = request;
  }
  kill(): void {
    this.killed = true;
  }
  complete(): void {
    this.emit('message', {
      ...this.request,
      kind: 'complete',
      totals: {
        approximateBytes: 7,
        files: 1,
        directories: 1,
        skippedEntries: 0,
        partial: false,
      },
    });
  }
  exit(code = 0): void {
    this.emit('exit', code);
  }
}

describe('browser inventory worker admission', () => {
  it('retains both slots after result messages and admits the next job only on actual exit', async () => {
    const workers: Worker[] = [];
    const queue = new BrowserInventoryQueue(() => {
      const worker = new Worker();
      workers.push(worker);
      return worker;
    });
    const first = queue.run('first', 1, '/first');
    const second = queue.run('second', 1, '/second');
    const third = queue.run('third', 1, '/third');
    expect(workers).toHaveLength(2);
    workers[0].complete();
    workers[1].complete();
    expect(workers).toHaveLength(2);
    workers[0].exit();
    expect(workers).toHaveLength(3);
    workers[1].exit();
    workers[2].complete();
    workers[2].exit();
    await expect(first.result).resolves.toMatchObject({ approximateBytes: 7 });
    await second.result;
    await third.result;
    await queue.shutdown();
  });

  it('deduplicates the same generation and fences a replacement until the cancelled worker exits', async () => {
    const workers: Worker[] = [];
    const queue = new BrowserInventoryQueue(() => {
      const worker = new Worker();
      workers.push(worker);
      return worker;
    });
    const old = queue.run('profile', 1, '/old');
    expect(queue.run('profile', 1, '/old')).toBe(old);
    const rejected = expect(old.result).rejects.toMatchObject({
      code: 'cancelled',
    });
    const next = queue.run('profile', 2, '/new');
    expect(workers).toHaveLength(1);
    expect(workers[0].killed).toBe(true);
    workers[0].complete();
    expect(workers).toHaveLength(1);
    workers[0].exit();
    expect(workers).toHaveLength(2);
    workers[1].complete();
    workers[1].exit();
    await rejected;
    await next.result;
    await queue.shutdown();
  });

  it('rejects a mismatched generation without freeing the live worker early', async () => {
    const worker = new Worker();
    const queue = new BrowserInventoryQueue(() => worker);
    const result = queue.run('profile', 2, '/native');
    const rejected = expect(result.result).rejects.toMatchObject({
      code: 'storage_unavailable',
    });
    worker.emit('message', {
      profileId: 'profile',
      storageGeneration: 1,
      kind: 'complete',
      totals: {},
    });
    expect(worker.killed).toBe(true);
    worker.exit();
    await rejected;
    await queue.shutdown();
  });

  it('cancels queued work without spawning it and waits for live worker exits on shutdown', async () => {
    const workers: Worker[] = [];
    const queue = new BrowserInventoryQueue(() => {
      const worker = new Worker();
      workers.push(worker);
      return worker;
    });
    const first = queue.run('first', 1, '/first');
    const second = queue.run('second', 1, '/second');
    const third = queue.run('third', 1, '/third');
    const failures = [first, second, third].map((handle) =>
      expect(handle.result).rejects.toMatchObject({ code: 'cancelled' }),
    );
    await third.cancel();
    let stopped = false;
    const shutdown = queue.shutdown().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(workers).toHaveLength(2);
    workers.forEach((worker) => worker.exit());
    await shutdown;
    await Promise.all(failures);
  });
  it('turns a progress publication failure into a job failure without throwing on the main event loop', async () => {
    const worker = new Worker();
    const queue = new BrowserInventoryQueue(() => worker);
    const handle = queue.run('profile', 1, '/native', () => {
      throw new Error('publication failed');
    });
    const rejected = expect(handle.result).rejects.toMatchObject({
      code: 'storage_unavailable',
    });
    let escaped: unknown;
    try {
      worker.emit('message', {
        ...worker.request,
        kind: 'progress',
        totals: {
          approximateBytes: 1,
          files: 1,
          directories: 1,
          skippedEntries: 0,
          partial: false,
        },
      });
    } catch (error) {
      escaped = error;
    }
    worker.exit(1);
    await rejected;
    await queue.shutdown();
    expect(escaped).toBeUndefined();
  });
});
