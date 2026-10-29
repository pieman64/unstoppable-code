import { BrowserProfileError } from '@canopy/desktop-shared/browser-profile-error';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { isProfileRecord } from '@canopy/protocol/browser-profiles';
import { BrowserDataJobs } from '../data-jobs';
import { BrowserInventoryQueue } from '../inventory-queue';
import { BrowserObservedSites } from '../observed-sites';
import { BrowserProfileInventoryService } from '../inventory-service';
class Worker extends EventEmitter {
  request?: Record<string, unknown>;
  killed = false;
  ack = false;
  postMessage(value: unknown): void {
    if (!isProfileRecord(value)) throw new Error('Invalid worker request');
    if (value.kind === 'ack') this.ack = true;
    else this.request = value;
  }
  kill(): void {
    this.killed = true;
  }
  complete(): void {
    this.emit('message', {
      ...this.request,
      kind: 'complete',
      totals: {
        approximateBytes: 777,
        files: 7,
        directories: 1,
        skippedEntries: 0,
        partial: false,
      },
    });
  }
}
const until = async (test: () => Promise<boolean> | boolean): Promise<void> => {
  for (let i = 0; i < 1000; i++) {
    if (await test()) return;
    await delay(1);
  }
  throw new Error('Inventory fixture timed out');
};
async function fixture(
  action: (value: {
    service: BrowserProfileInventoryService;
    jobs: BrowserDataJobs;
    workers: Worker[];
    id: string;
    root: string;
    advance: () => void;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'browser-inventory-service-test-')),
    id = randomUUID();
  let currentGeneration = 1;
  const withGeneration = async <T>(
    profileId: string,
    generation: number,
    action: () => Promise<T>,
  ): Promise<T> => {
    if (profileId !== id || generation !== currentGeneration)
      throw new BrowserProfileError(
        'profile_unavailable',
        'Generation changed',
      );
    return action();
  };
  const jobs = new BrowserDataJobs(join(root, 'jobs')),
    observations = new BrowserObservedSites(
      join(root, 'sites'),
      withGeneration,
    );
  const workers: Worker[] = [];
  const queue = new BrowserInventoryQueue(() => {
    const worker = new Worker();
    workers.push(worker);
    return worker;
  });
  const service = new BrowserProfileInventoryService(
    join(root, 'inventory'),
    {
      withGeneration,
      directory: (): Promise<string> => Promise.resolve(join(root, 'native')),
      assertAvailable: (): void => {},
      cookies: (): Promise<{
        domains: { domain: string; count: number; value: string }[];
        measured: boolean;
        truncated: boolean;
      }> =>
        Promise.resolve({
          domains: [
            { domain: '.example.test', count: 3, value: 'MUST_NOT_PERSIST' },
          ],
          measured: true,
          truncated: false,
        }),
    },
    queue,
    observations,
    jobs,
  );
  try {
    await action({
      service,
      jobs,
      workers,
      id,
      root,
      advance: () => {
        currentGeneration++;
      },
    });
  } finally {
    for (const worker of workers) worker.emit('exit', 1);
    await service.shutdown();
    await queue.shutdown();
    await observations.close();
    await rm(root, { recursive: true, force: true });
  }
}
describe('browser inventory publication', () => {
  it('publishes counts only after the result handoff and completed receipt', async () =>
    fixture(async ({ service, jobs, workers, id, root }) => {
      const job = await service.start(randomUUID(), id, 1);
      await until(() => workers.length === 1);
      workers[0].complete();
      expect(workers[0].ack).toBe(true);
      expect((await service.get(id, 1)).approximateBytes).toBeNull();
      workers[0].emit('exit', 0);
      await until(
        async () =>
          (await jobs.get(job.jobId, { kind: 'user' })).status === 'complete',
      );
      expect(await service.get(id, 1)).toMatchObject({
        approximateBytes: 777,
        coverage: 'partial',
        cookieDomains: [{ domain: '.example.test', count: 3 }],
        classBytes: { cache: null, indexedDB: null, opfs: null },
      });
      expect(
        await readFile(join(root, 'inventory', `${id}-g1.json`), 'utf8'),
      ).not.toContain('MUST_NOT_PERSIST');
    }));
  it('serializes simultaneous starts and returns one active job for the same generation', async () =>
    fixture(async ({ service, workers, id }) => {
      const [first, second] = await Promise.all([
        service.start(randomUUID(), id, 1),
        service.start(randomUUID(), id, 1),
      ]);
      expect(first.jobId).toBe(second.jobId);
      await until(() => workers.length === 1);
      const stop = service.cancelProfile(id);
      workers[0].emit('exit', 1);
      await stop;
    }));
  it('does not publish after cancellation between result and actual worker exit', async () =>
    fixture(async ({ service, jobs, workers, id }) => {
      const job = await service.start(randomUUID(), id, 1);
      await until(() => workers.length === 1);
      workers[0].complete();
      await jobs.cancel(job.jobId, { kind: 'user' });
      const stop = service.cancelJob(job.jobId);
      workers[0].emit('exit', 0);
      await stop;
      expect((await service.get(id, 1)).approximateBytes).toBeNull();
      expect((await jobs.get(job.jobId, { kind: 'user' })).status).toBe(
        'cancelled',
      );
    }));
  it('rejects a generation change during measurement without overwriting the newer generation', async () =>
    fixture(async ({ service, jobs, workers, id, root, advance }) => {
      const job = await service.start(randomUUID(), id, 1);
      await until(() => workers.length === 1);
      advance();
      workers[0].complete();
      workers[0].emit('exit', 0);
      await until(
        async () =>
          (await jobs.get(job.jobId, { kind: 'user' })).status === 'failed',
      );
      await expect(
        readFile(join(root, 'inventory', `${id}-g1.json`)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await service.get(id, 2)).approximateBytes).toBeNull();
    }));
});
