import { REPOSITORY_CLONE_FAILURE_MESSAGE } from '@canopy/protocol/portal';
import type { CloneJobSnapshot } from '@canopy/desktop-shared/types';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserveUniqueDestination } from '../lib/workspace-service';
import {
  CloneCancelledError,
  CloneJobRegistry,
  type CloneJobContext,
} from '../services/clone-jobs';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  registry: CloneJobRegistry;
  broadcasts: CloneJobSnapshot[][];
  removed: string[];
}

function createHarness(): Harness {
  const broadcasts: CloneJobSnapshot[][] = [];
  const removed: string[] = [];
  const registry = new CloneJobRegistry({
    changed: (jobs): void => {
      broadcasts.push(jobs);
    },
    removeDirectory: (path): Promise<void> => {
      removed.push(path);
      return Promise.resolve();
    },
    now: (): number => 1_000,
    progressThrottleMs: 0,
  });
  return { registry, broadcasts, removed };
}

const INPUT = {
  id: 'job-1',
  remoteUrl: 'https://user:secret@github.com/org/big-repo.git',
};

/**
 * Starts a job whose work waits on `gate` after reporting a destination, and
 * hands the live context back to the test.
 */
function startJob(
  registry: CloneJobRegistry,
  gate: Deferred<{ id: string; name: string }>,
): {
  result: Promise<{ id: string; name: string }>;
  context: Promise<CloneJobContext>;
} {
  const contextReady = deferred<CloneJobContext>();
  const result = registry.run(INPUT, async (context) => {
    context.setDestination('/clones/big-repo');
    contextReady.resolve(context);
    context.signal.addEventListener('abort', () =>
      gate.reject(new Error('Clone cancelled or timed out')),
    );
    return gate.promise;
  });
  return { result, context: contextReady.promise };
}

describe('CloneJobRegistry', () => {
  it('never broadcasts URL credentials as a repository name', async () => {
    const { registry, broadcasts } = createHarness();
    const result = registry.run(
      { id: 'missing-path', remoteUrl: 'https://user:secret@github.com/' },
      () => Promise.resolve({ id: 'repo', name: 'repo' }),
    );
    await result;
    expect(broadcasts[0][0].repoName).toBe('repository');
    expect(JSON.stringify(broadcasts)).not.toContain('secret');
  });

  it('tracks progress with credentials removed from the remote URL', async () => {
    const { registry } = createHarness();
    const gate = deferred<{ id: string; name: string }>();
    const { result, context } = startJob(registry, gate);
    const live = await context;

    live.progress({
      phase: 'receiving',
      percent: 50,
      processed: 5,
      total: 10,
      received: '1.00 MiB',
      throughput: '512.00 KiB/s',
    });

    const [job] = registry.list();
    expect(job).toMatchObject({
      id: 'job-1',
      repoName: 'big-repo',
      remoteUrl: 'https://github.com/org/big-repo.git',
      destinationPath: '/clones/big-repo',
      status: 'running',
      phase: 'receiving',
      phasePercent: 50,
      processedCount: 5,
      totalCount: 10,
      received: '1.00 MiB',
      throughput: '512.00 KiB/s',
      background: false,
      cancellable: true,
    });
    expect(job.percent).toBeGreaterThan(0);

    gate.resolve({ id: 'big-repo', name: 'big-repo' });
    await expect(result).resolves.toEqual({ id: 'big-repo', name: 'big-repo' });
  });

  it('never moves the overall percentage backwards', async () => {
    const { registry } = createHarness();
    const gate = deferred<{ id: string; name: string }>();
    const { result, context } = startJob(registry, gate);
    const live = await context;
    const base = {
      processed: null,
      total: null,
      received: null,
      throughput: null,
    };
    live.progress({ ...base, phase: 'resolving', percent: 50 });
    const high = registry.list()[0].percent;
    live.progress({ ...base, phase: 'receiving', percent: 10 });
    expect(registry.list()[0].percent).toBe(high);
    gate.resolve({ id: 'x', name: 'x' });
    await result;
  });

  it('drops a foreground job once it finishes', async () => {
    const { registry } = createHarness();
    const gate = deferred<{ id: string; name: string }>();
    const { result } = startJob(registry, gate);
    gate.resolve({ id: 'big-repo', name: 'big-repo' });
    await result;
    expect(registry.list()).toEqual([]);
  });

  it('keeps a finished background job until it is dismissed', async () => {
    const { registry } = createHarness();
    const gate = deferred<{ id: string; name: string }>();
    const { result, context } = startJob(registry, gate);
    await context;

    expect(registry.background('job-1')).toBe(true);
    expect(registry.list()[0].background).toBe(true);

    gate.resolve({ id: 'big-repo-ws', name: 'big-repo' });
    await result;
    expect(registry.list()[0]).toMatchObject({
      status: 'succeeded',
      percent: 100,
      workspaceId: 'big-repo-ws',
      workspaceName: 'big-repo',
      cancellable: false,
    });

    registry.dismiss('job-1');
    expect(registry.list()).toEqual([]);
  });

  it('keeps a failed background job with its error and removes the partial checkout', async () => {
    const { registry, removed } = createHarness();
    const gate = deferred<{ id: string; name: string }>();
    const { result, context } = startJob(registry, gate);
    await context;
    registry.background('job-1');

    gate.reject(new Error("fatal: repository 'x' not found"));
    await expect(result).rejects.toThrow('not found');

    expect(registry.list()[0]).toMatchObject({
      status: 'failed',
      error: REPOSITORY_CLONE_FAILURE_MESSAGE,
      cancellable: false,
    });
    expect(removed).toEqual(['/clones/big-repo']);
  });

  it.each([
    'This change was saved but did not finish and needs recovery.',
    'This request was saved but did not finish and needs recovery.',
    'An earlier attempt of this request was interrupted and needs recovery.',
  ])(
    'preserves a finishing background job recovery outcome: %s',
    async (message) => {
      const { registry, removed, broadcasts } = createHarness();
      const gate = deferred<{ id: string; name: string }>();
      const { result, context } = startJob(registry, gate);
      const live = await context;
      registry.background('job-1');
      live.finishing();
      const failure = new Error(message);
      gate.reject(failure);
      await expect(result).rejects.toBe(failure);
      expect(registry.list()[0]).toMatchObject({
        status: 'failed',
        phase: 'finishing',
        error: message,
        cancellable: false,
      });
      expect(broadcasts.at(-1)?.[0].error).toBe(message);
      expect(removed).toEqual([]);
    },
  );

  it('never publishes credentials from a background job error', async () => {
    const { registry, broadcasts } = createHarness();
    const gate = deferred<{ id: string; name: string }>();
    const { result, context } = startJob(registry, gate);
    await context;
    registry.background('job-1');
    gate.reject(
      new Error(
        "fatal: repository 'https://user:secret@github.com/org/big-repo.git' not found",
      ),
    );
    await expect(result).rejects.toThrow('not found');
    expect(registry.list()[0].error).toBe(REPOSITORY_CLONE_FAILURE_MESSAGE);
    expect(JSON.stringify(broadcasts)).not.toContain('secret');
  });

  it('cancels a running clone, removes its checkout, and forgets it', async () => {
    const { registry, removed, broadcasts } = createHarness();
    const gate = deferred<{ id: string; name: string }>();
    const { result, context } = startJob(registry, gate);
    await context;
    registry.background('job-1');
    const settled = result.catch((error: unknown) => error);

    await registry.cancel('job-1');

    expect(await settled).toBeInstanceOf(CloneCancelledError);
    expect(removed).toEqual(['/clones/big-repo']);
    expect(registry.list()).toEqual([]);
    expect(broadcasts.some((jobs) => jobs[0]?.status === 'cancelling')).toBe(
      true,
    );
  });

  it('stops the clone and reports a cleanup failure on the job, not by failing the cancel', async () => {
    const registry = new CloneJobRegistry({
      changed: (): void => undefined,
      removeDirectory: (): Promise<void> =>
        Promise.reject(
          new Error(
            'permission denied /private/internal-diagnostics synthetic-secret',
          ),
        ),
      now: (): number => 1_000,
    });
    const gate = deferred<{ id: string; name: string }>();
    const { result, context } = startJob(registry, gate);
    const live = await context;
    const settled = result.catch((error: unknown) => error);
    await expect(registry.cancel('job-1')).resolves.toBeUndefined();
    expect(live.signal.aborted).toBe(true);
    expect(await settled).toBeInstanceOf(Error);
    expect(registry.list()[0]).toMatchObject({
      status: 'failed',
      background: true,
      destinationPath: '/clones/big-repo',
    });
    expect(registry.list()[0].error).toBe(
      "Couldn't remove the incomplete clone at /clones/big-repo. Remove it manually.",
    );
    expect(JSON.stringify(registry.list())).not.toContain(
      'internal-diagnostics',
    );
    expect(JSON.stringify(registry.list())).not.toContain('synthetic-secret');
  });

  it('refuses to cancel once the project is being added', async () => {
    const { registry, removed } = createHarness();
    const gate = deferred<{ id: string; name: string }>();
    const { result, context } = startJob(registry, gate);
    const live = await context;
    live.finishing();

    expect(registry.list()[0]).toMatchObject({
      phase: 'finishing',
      cancellable: false,
    });
    await registry.cancel('job-1');
    expect(registry.list()[0].status).toBe('running');

    gate.resolve({ id: 'x', name: 'x' });
    await result;
    expect(removed).toEqual([]);
  });

  it('keeps the checkout when adding the cloned project fails', async () => {
    const { registry, removed } = createHarness();
    const gate = deferred<{ id: string; name: string }>();
    const { result, context } = startJob(registry, gate);
    const live = await context;
    live.finishing();
    gate.reject(new Error('This repository is already tracked'));
    await expect(result).rejects.toThrow('already tracked');
    expect(removed).toEqual([]);
  });

  it('does not background a job that already finished', async () => {
    const { registry } = createHarness();
    const gate = deferred<{ id: string; name: string }>();
    const { result } = startJob(registry, gate);
    gate.resolve({ id: 'x', name: 'x' });
    await result;
    expect(registry.background('job-1')).toBe(false);
  });

  it('rejects a duplicate job id', async () => {
    const { registry } = createHarness();
    const gate = deferred<{ id: string; name: string }>();
    const { result } = startJob(registry, gate);
    await expect(
      registry.run(INPUT, () => Promise.resolve({ id: 'y', name: 'y' })),
    ).rejects.toThrow('already running');
    gate.resolve({ id: 'x', name: 'x' });
    await result;
  });

  it('stops every running clone on shutdown', async () => {
    const { registry, removed } = createHarness();
    const gate = deferred<{ id: string; name: string }>();
    const { result, context } = startJob(registry, gate);
    await context;
    const settled = result.catch((error: unknown) => error);

    await registry.shutdown();

    expect(await settled).toBeInstanceOf(CloneCancelledError);
    expect(removed).toEqual(['/clones/big-repo']);
  });

  it('waits for a clone already cancelling when shutdown begins', async () => {
    const cleanup = deferred<void>();
    const cleanupStarted = deferred<void>();
    const started = deferred<void>();
    const registry = new CloneJobRegistry({
      changed: (): void => undefined,
      removeDirectory: async (): Promise<void> => {
        cleanupStarted.resolve();
        await cleanup.promise;
      },
      now: (): number => 1_000,
    });
    const result = registry.run(INPUT, async ({ signal, setDestination }) => {
      setDestination('/clones/big-repo');
      started.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      throw new Error('cancelled');
    });
    await started.promise;
    const cancelling = registry.cancel('job-1');
    const settled = result.catch(() => undefined);
    await cleanupStarted.promise;
    let finished = false;
    const shutdown = registry.shutdown().then(() => {
      finished = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    try {
      expect(finished).toBe(false);
    } finally {
      cleanup.resolve();
    }
    await Promise.all([cancelling, settled, shutdown]);
  });

  describe('when the caller preserves partial checkouts for recovery', () => {
    function startPreservingJob(
      registry: CloneJobRegistry,
      gate: Deferred<{ id: string; name: string }>,
      events: string[],
    ): { settled: Promise<unknown>; ready: Promise<void> } {
      const ready = deferred<void>();
      const result = registry.run(
        { ...INPUT, preserveDestinationOnFailure: true },
        async (context) => {
          context.setDestination('/clones/big-repo', async () => {
            events.push('released');
            await Promise.resolve();
          });
          context.signal.addEventListener('abort', () =>
            gate.reject(new Error('Clone cancelled or timed out')),
          );
          ready.resolve();
          return gate.promise;
        },
      );
      return {
        settled: result.catch((error: unknown) => error),
        ready: ready.promise,
      };
    }

    function preservingHarness(
      events: string[],
      removeDirectory: (path: string) => Promise<void> = (
        path,
      ): Promise<void> => {
        events.push(`removed ${path}`);
        return Promise.resolve();
      },
    ): CloneJobRegistry {
      return new CloneJobRegistry({
        changed: (): void => undefined,
        removeDirectory,
        now: (): number => 1_000,
        progressThrottleMs: 0,
      });
    }

    it('removes the partial checkout on Cancel, then releases its reservation', async () => {
      const events: string[] = [];
      const registry = preservingHarness(events);
      const gate = deferred<{ id: string; name: string }>();
      const { settled, ready } = startPreservingJob(registry, gate, events);
      await ready;

      await registry.cancel('job-1');

      expect(await settled).toBeInstanceOf(CloneCancelledError);
      expect(events).toEqual(['removed /clones/big-repo', 'released']);
      expect(registry.list()).toEqual([]);
    });

    it('keeps the checkout and its reservation, asking for manual removal, when Cancel cleanup fails', async () => {
      const events: string[] = [];
      const registry = preservingHarness(events, () =>
        Promise.reject(new Error('permission denied')),
      );
      const gate = deferred<{ id: string; name: string }>();
      const { settled, ready } = startPreservingJob(registry, gate, events);
      await ready;

      await expect(registry.cancel('job-1')).resolves.toBeUndefined();

      expect(await settled).toBeInstanceOf(Error);
      expect(events).toEqual([]);
      expect(registry.list()[0]).toMatchObject({
        status: 'failed',
        background: true,
        destinationPath: '/clones/big-repo',
      });
      expect(registry.list()[0].error).toBe(
        "Couldn't remove the incomplete clone at /clones/big-repo. Remove it manually.",
      );
    });

    it('keeps the checkout and its reservation when the app shuts down', async () => {
      const events: string[] = [];
      const registry = preservingHarness(events);
      const gate = deferred<{ id: string; name: string }>();
      const { settled, ready } = startPreservingJob(registry, gate, events);
      await ready;

      await registry.shutdown();

      expect(await settled).toBeInstanceOf(CloneCancelledError);
      expect(events).toEqual([]);
    });

    it('keeps the checkout and its reservation when the clone fails', async () => {
      const events: string[] = [];
      const registry = preservingHarness(events);
      const gate = deferred<{ id: string; name: string }>();
      const { settled, ready } = startPreservingJob(registry, gate, events);
      await ready;
      registry.background('job-1');

      gate.reject(new Error('fatal: controlled authentication failure'));

      expect(await settled).toEqual(
        new Error('fatal: controlled authentication failure'),
      );
      expect(events).toEqual([]);
      expect(registry.list()[0]).toMatchObject({
        status: 'failed',
        destinationPath: '/clones/big-repo',
        error: REPOSITORY_CLONE_FAILURE_MESSAGE,
      });
    });
  });
});

describe('tracked clone destination reservation', () => {
  it('atomically gives concurrent clones different owned directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clone-reservation-'));
    try {
      const [first, second] = await Promise.all([
        reserveUniqueDestination(root, 'repo'),
        reserveUniqueDestination(root, 'repo'),
      ]);
      expect(new Set([first, second])).toEqual(
        new Set([join(root, 'repo'), join(root, 'repo-2')]),
      );
      expect((await readdir(root)).sort()).toEqual(['repo', 'repo-2']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
