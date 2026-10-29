import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import inventory from '../../../../scripts/lib/windows-pipe-inventory.json';
import {
  runCanopyTransportConformance,
  runCanopyLeaseConformance,
  runCanopyChannelConformance,
} from '@canopy/core-transport';
import { pipeConformanceRegistration } from './fixtures/pipe-conformance-registration';
import {
  FixtureCleanup,
  releaseAll,
  requireCompletedPhases,
} from './fixtures/pipe-test-cleanup';
import { createPublishedDaemonCleanup } from './fixtures/published-daemon-cleanup';
import { ownProber } from './fixtures/prober-completion';

describe('native test resource teardown', () => {
  it.each(['throw', 'false'])(
    'keeps observing closure after kill returns %s without retrying termination',
    async (failure) => {
      jest.useFakeTimers();
      try {
        const scope = new FixtureCleanup();
        const remove = jest.fn(() => Promise.resolve());
        const files = scope.own(remove);
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: jest.fn(() => {
            if (failure === 'throw') throw new Error('secret kill failure');
            return false;
          }),
        });
        const prober = ownProber(
          scope,
          child,
          1_000,
          (value) => value.replaceAll('secret', '[redacted]'),
          [files],
        );
        const first = prober.release.release();
        let settled = false;
        void first.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await jest.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        expect(prober.release.failed).toBe(true);
        expect(prober.release.release()).toBe(first);
        const closing = scope.close(10);
        await jest.advanceTimersByTimeAsync(10);
        expect(await closing).toBe(2);
        expect(remove).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1_000);
        expect(child.kill).toHaveBeenCalledTimes(1);
        child.stdout.write('output after failed kill');
        child.emit('close', 0);
        await first;
        expect(prober.exited()).toBe(true);
        const report = await prober.done;
        expect(report.code).toBeNull();
        expect(report.stdout).toBe('output after failed kill');
        expect(report.stderr).toContain(
          failure === 'throw'
            ? '[redacted] kill failure'
            : 'termination failed',
        );
        expect(await scope.close()).toBe(2);
        expect(remove).toHaveBeenCalledTimes(1);
        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('immediately releases a spawned prober when dependency registration rejects', async () => {
    jest.useFakeTimers();
    try {
      const scope = new FixtureCleanup();
      const files = scope.own(() => Promise.resolve());
      await files.release();
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: jest.fn(() => true),
      });
      expect(() =>
        ownProber(scope, child, 1_000, (value) => value, [files]),
      ).toThrow('already started');
      await jest.advanceTimersByTimeAsync(0);
      expect(child.kill).toHaveBeenCalledTimes(1);
      const closing = scope.close(10);
      await jest.advanceTimersByTimeAsync(10);
      expect(await closing).toBe(1);
      child.emit('error', new Error('kill failed'));
      child.emit('close', 0);
      expect(await scope.close()).toBe(1);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([true, false])(
    'waits for prober close after error, before teardown starts (%s)',
    async (errorBeforeClose) => {
      jest.useFakeTimers();
      try {
        const scope = new FixtureCleanup();
        const remove = jest.fn(() => Promise.resolve());
        const files = scope.own(remove);
        const independent = jest.fn(() => Promise.resolve());
        scope.own(independent);
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: jest.fn(() => true),
        });
        const prober = ownProber(scope, child, 1_000, (s) => s, [files]);
        const error = (): void => {
          child.emit('error', new Error('kill failed'));
        };
        if (errorBeforeClose) error();
        const first = prober.release.release();
        const anotherClose = (): Promise<void> => prober.release.release();
        expect(anotherClose()).toBe(first);
        const hook = scope.close(10);
        await jest.advanceTimersByTimeAsync(0);
        if (!errorBeforeClose) error();
        child.emit('error', new Error('still running'));
        child.stdout.write('late output');
        child.stderr.write('late diagnostics');
        await jest.advanceTimersByTimeAsync(10);
        expect(prober.exited()).toBe(false);
        expect(await hook).toBe(2);
        expect(independent).toHaveBeenCalledTimes(1);
        expect(remove).not.toHaveBeenCalled();
        const repeated = scope.close(10);
        await jest.advanceTimersByTimeAsync(10);
        expect(await repeated).toBe(2);
        expect(child.kill).toHaveBeenCalledTimes(1);
        child.emit('close', 0);
        await first;
        expect(prober.exited()).toBe(true);
        const report = await prober.done;
        expect(report.code).toBeNull();
        expect(report.stdout).toBe('late output');
        expect(report.stderr).toContain('kill failed');
        expect(report.stderr).toContain('late diagnostics');
        expect(await scope.close()).toBe(2);
        expect(remove).toHaveBeenCalledTimes(1);
        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('shares the prober deadline with explicit release and waits for close', async () => {
    jest.useFakeTimers();
    try {
      const scope = new FixtureCleanup();
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: jest.fn(() => true),
      });
      const prober = ownProber(scope, child, 10, (s) => s);
      await jest.advanceTimersByTimeAsync(10);
      const releasing = prober.release.release();
      await jest.advanceTimersByTimeAsync(0);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(prober.exited()).toBe(false);
      child.emit('close', 0);
      await releasing;
      expect((await prober.done).code).toBeNull();
      expect(await scope.close()).toBe(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([true, false])(
    'retains prober error without an observer deadline (%s)',
    async (failed) => {
      jest.useFakeTimers();
      try {
        const scope = new FixtureCleanup();
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: jest.fn(() => true),
        });
        const redact = (value: string): string =>
          value.replaceAll('secret', '[redacted]');
        const prober = ownProber(scope, child, 1_000, redact);
        if (failed) child.emit('error', new Error('secret failure'));
        child.stdout.write('secret output');
        child.stderr.write('secret diagnostic');
        child.emit('close', 0);
        expect(await prober.done).toEqual({
          code: failed ? null : 0,
          stdout: '[redacted] output',
          stderr: failed
            ? '[redacted] diagnostic[redacted] failure'
            : '[redacted] diagnostic',
        });
        expect(await scope.close()).toBe(failed ? 1 : 0);
        expect(await scope.close()).toBe(failed ? 1 : 0);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it.each([true, false])(
    'keeps descriptor-removal evidence until the hook, including omitted removal (%s)',
    async (removeDescriptor) => {
      const parent = new FixtureCleanup();
      const { value: root, release: files } = await parent.acquire(
        () => mkdtemp(join(tmpdir(), 'pipe-evidence-')),
        (root) => rm(root, { recursive: true, force: true }),
      );
      const { scope, close } = createPublishedDaemonCleanup(
        parent,
        files,
        root,
      );
      const descriptor = join(root, 'runtime', 'core.json');
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const unpublish = jest.fn(async () => {
        started.resolve();
        await finish.promise;
        if (removeDescriptor) await rm(descriptor);
      });
      try {
        await mkdir(join(root, 'runtime'));
        await writeFile(descriptor, 'published descriptor');
        const publication = scope.own(unpublish);
        files.dependsOn(publication);
        const closing = Promise.allSettled([close(), close()]);
        await started.promise;
        expect((await stat(root)).isDirectory()).toBe(true);
        expect(await stat(descriptor)).toBeDefined();
        expect(unpublish).toHaveBeenCalledTimes(1);
        finish.resolve();
        const results = await closing;
        if (removeDescriptor) {
          expect(results).toEqual([
            { status: 'fulfilled', value: undefined },
            { status: 'fulfilled', value: undefined },
          ]);
          await close();
        } else {
          for (const result of results) {
            expect(result.status).toBe('rejected');
            if (result.status === 'rejected')
              expect(result.reason).toHaveProperty(
                'message',
                expect.stringContaining('Received promise resolved'),
              );
          }
        }
      } finally {
        finish.resolve();
        expect(await parent.close()).toBe(0);
        expect(await parent.close()).toBe(0);
      }
      expect(unpublish).toHaveBeenCalledTimes(1);
      await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each([0, 15_000])(
    'unwinds nested initialization rejection without self-wait or false failure at %i ms',
    async (elapsed) => {
      jest.useFakeTimers();
      try {
        const scope = new FixtureCleanup();
        const dispose = jest.fn(() => Promise.resolve());
        const error = new Error('kernel start failed');
        let rejected = false;
        const constructing = scope.initialize(async () => {
          scope.own(dispose);
          return scope.initialize(() => Promise.reject(error));
        });
        const rejection = expect(constructing).rejects.toBe(error);
        void constructing.catch(() => {
          rejected = true;
        });
        await jest.advanceTimersByTimeAsync(elapsed);
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(rejected).toBe(true);
        await rejection;
        expect(await scope.close()).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it.each([10, 30_000])(
    'uses only the observing parent budget across child scopes (%i ms)',
    async (budget) => {
      jest.useFakeTimers();
      try {
        const parent = new FixtureCleanup();
        const remove = jest.fn(() => Promise.resolve());
        const files = parent.own(remove);
        const child = parent.fork([files]);
        const stopped = Promise.withResolvers<void>();
        const stop = jest.fn(() => stopped.promise);
        const constructing = child.initialize(async () => {
          child.own(stop);
          await stopped.promise;
        });
        const rejected = expect(constructing).rejects.toThrow(
          'during initialization',
        );
        let reported: number | undefined;
        const closing = parent.close(budget).then((failures) => {
          reported = failures;
          return failures;
        });
        await jest.advanceTimersByTimeAsync(20_000);
        expect(stop).toHaveBeenCalledTimes(1);
        expect(remove).not.toHaveBeenCalled();
        expect(reported).toBe(budget < 20_000 ? 2 : undefined);
        stopped.resolve();
        await rejected;
        await jest.advanceTimersByTimeAsync(0);
        // Completion must unwind files without another close/retry call.
        expect(remove).toHaveBeenCalledTimes(1);
        expect(await closing).toBe(budget < 20_000 ? 2 : 0);
        expect(await parent.close()).toBe(budget < 20_000 ? 2 : 0);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('settles caught nested rejection alongside another same-scope initializer', async () => {
    const scope = new FixtureCleanup();
    const ready = Promise.withResolvers<void>();
    const dispose = jest.fn(() => Promise.resolve());
    const other = scope.initialize(async () => {
      await ready.promise;
      scope.own(dispose);
    });
    const otherRejected = expect(other).rejects.toThrow(
      'during initialization',
    );
    const error = new Error('inner failure');
    const outer = scope.initialize(async () => {
      await scope
        .initialize(() => Promise.reject(error))
        .catch((caught: unknown) => {
          expect(caught).toBe(error);
        });
      ready.resolve();
    });
    await expect(outer).rejects.toThrow('during initialization');
    await otherRejected;
    expect(dispose).toHaveBeenCalledTimes(1);
    // Late work stays disqualified even though its cleanup completed.
    expect(await scope.close()).toBe(1);
  });

  it('rejects new child work after its dependency has started or its parent has closed', async () => {
    const parent = new FixtureCleanup();
    const files = parent.own(() => Promise.resolve());
    await files.release();
    expect(() => parent.fork([files])).toThrow('already started');
    expect(await parent.close()).toBe(0);
    expect(() => parent.fork()).toThrow('already closing');
  });

  it('allows a late initializer to attach dependencies before automatic release starts', async () => {
    jest.useFakeTimers();
    try {
      const parent = new FixtureCleanup();
      const removeFiles = jest.fn(() => Promise.resolve());
      const files = parent.own(removeFiles);
      const child = parent.fork([files]);
      const ready = Promise.withResolvers<void>();
      const stopped = Promise.withResolvers<void>();
      const remove = jest.fn(() => Promise.resolve());
      const constructing = child.initialize(async () => {
        await ready.promise;
        const stop = child.own(() => stopped.promise);
        child.own(remove).dependsOn(stop);
      });
      const rejection = expect(constructing).rejects.toThrow(
        'during initialization',
      );
      const closing = parent.close(10);
      await jest.advanceTimersByTimeAsync(0);
      ready.resolve();
      await jest.advanceTimersByTimeAsync(10);
      expect(await closing).toBe(2);
      expect(remove).not.toHaveBeenCalled();
      expect(removeFiles).not.toHaveBeenCalled();
      stopped.resolve();
      await rejection;
      expect(await parent.close()).toBe(2);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(removeFiles).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports an unfinished constructor even before its first resource arrives', async () => {
    jest.useFakeTimers();
    try {
      const scope = new FixtureCleanup();
      const ready = Promise.withResolvers<void>();
      const disposed = Promise.withResolvers<void>();
      const dispose = jest.fn(() => disposed.promise);
      const constructing = scope.initialize(async () => {
        await ready.promise;
        scope.own(dispose);
        return 'late resource';
      });
      const rejected = expect(constructing).rejects.toThrow(
        'during initialization',
      );
      const closing = scope.close(10);
      await jest.advanceTimersByTimeAsync(10);
      expect(await closing).toBe(1);
      ready.resolve();
      await jest.advanceTimersByTimeAsync(0);
      expect(dispose).toHaveBeenCalledTimes(1);
      disposed.resolve();
      await rejected;
      expect(await scope.close()).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not start an acquisition when its deletion barrier has already started', async () => {
    const scope = new FixtureCleanup();
    const files = scope.own(() => Promise.resolve());
    await files.release();
    const create = jest.fn(() => Promise.resolve('listener'));
    await expect(
      scope.acquire(create, () => Promise.resolve(), [files]),
    ).rejects.toThrow('already started');
    await Promise.resolve();
    expect(create).not.toHaveBeenCalled();
    expect(await scope.close()).toBe(0);
  });

  it('unwinds a rejected child constructor without poisoning sibling fixtures', async () => {
    const parent = new FixtureCleanup();
    const files = parent.own(() => Promise.resolve());
    const first = parent.fork([files]);
    const dispose = jest.fn(() => Promise.resolve());
    await expect(
      first.initialize(async () => {
        await first.acquire(() => Promise.resolve('listener'), dispose);
        throw new Error('bad auth');
      }),
    ).rejects.toThrow('bad auth');
    expect(dispose).toHaveBeenCalledWith('listener');
    const sibling = parent.fork([files]);
    await expect(
      sibling.initialize(() => Promise.resolve('authenticated')),
    ).resolves.toBe('authenticated');
    expect(await parent.close()).toBe(0);
  });

  it('holds parent deletion through late constructor registration and disposal', async () => {
    jest.useFakeTimers();
    try {
      const parent = new FixtureCleanup();
      const remove = jest.fn(() => Promise.resolve());
      const files = parent.own(remove);
      const child = parent.fork([files]);
      const ready = Promise.withResolvers<void>();
      const disposed = Promise.withResolvers<void>();
      const dispose = jest.fn(() => disposed.promise);
      const constructing = child.initialize(async () => {
        await ready.promise;
        child.own(dispose);
      });
      const rejected = expect(constructing).rejects.toThrow(
        'during initialization',
      );
      const closing = parent.close(10);
      await jest.advanceTimersByTimeAsync(0);
      ready.resolve();
      await jest.advanceTimersByTimeAsync(10);
      expect(await closing).toBe(2);
      expect(remove).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledTimes(1);
      disposed.resolve();
      await rejected;
      // Late registration is sticky, even after all resource barriers settle.
      expect(await parent.close()).toBe(2);
      expect(remove).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('propagates a late descendant release after parent completion without recovery to pass', async () => {
    const parent = new FixtureCleanup();
    const child = parent.fork().fork();
    expect(await parent.close()).toBe(0);
    const pending = Promise.withResolvers<void>();
    const dispose = jest.fn(() => pending.promise);
    const late = child.own(dispose);
    await Promise.resolve();
    expect(await parent.close(0)).toBeGreaterThan(0);
    pending.resolve();
    await late.release();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(await parent.close()).toBeGreaterThan(0);
  });

  it.each([
    [0, 'resolved'],
    [2, 'resolved'],
    [2, 'rejected'],
    [2, 'pending'],
  ])(
    'invalidates serialized cleanup after late depth-%i %s disposal',
    async (depth, outcome) => {
      const parent = new FixtureCleanup();
      const child = depth === 0 ? parent : parent.fork().fork();
      if (outcome === 'rejected')
        await expect(
          child.initialize(() => Promise.reject(new Error('bad auth'))),
        ).rejects.toThrow('bad auth');
      let serialized = '';
      const report = (failures: number): void => {
        serialized = JSON.stringify({
          ...inventory.cases[0],
          cleanup: failures ? 'failed' : 'complete',
          failures,
        });
      };
      expect(await parent.close(0, report)).toBe(0);
      const pending = Promise.withResolvers<void>();
      const dispose = jest.fn(() => pending.promise);
      const late = child.own(dispose);
      // Reporting cannot wait for disposal or another close(), even after a case passed.
      expect(JSON.parse(serialized)).toMatchObject({
        id: inventory.cases[0].id,
        cleanup: 'failed',
        failures: 1,
      });
      const first = late.release();
      expect(late.release()).toBe(first);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (outcome === 'rejected') {
        const rejected = expect(first).rejects.toThrow('late disposal');
        pending.reject(new Error('late disposal'));
        await rejected;
      } else if (outcome === 'resolved') {
        pending.resolve();
        await first;
      }
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(JSON.parse(serialized)).toMatchObject({ cleanup: 'failed' });
      // A subsequent case must not steal the old receipt's observer.
      const otherReport = jest.fn();
      expect(await new FixtureCleanup().close(0, otherReport)).toBe(0);
      child.own(() => Promise.resolve());
      expect(JSON.parse(serialized)).toMatchObject({ cleanup: 'failed' });
      expect(otherReport.mock.calls).toEqual([[0]]);
      pending.resolve();
      await first.catch(() => undefined);
    },
  );

  it('shares completion across explicit close callers and hooks, with sticky deadlines', async () => {
    jest.useFakeTimers();
    try {
      const scope = new FixtureCleanup();
      const pending = Promise.withResolvers<void>();
      const dispose = jest.fn(() => pending.promise);
      const resource = scope.own(dispose);
      const removeFiles = jest.fn(() => Promise.resolve());
      scope.own(removeFiles).dependsOn(resource);
      const explicitClose = (): Promise<void> => resource.release();
      const anotherClose = (): Promise<void> => resource.release();
      const first = explicitClose();
      expect(anotherClose()).toBe(first);
      const hook = scope.close(10);
      await jest.advanceTimersByTimeAsync(10);
      expect(await hook).toBe(2);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(removeFiles).not.toHaveBeenCalled();
      const repeatedHook = scope.close(10);
      await jest.advanceTimersByTimeAsync(10);
      expect(await repeatedHook).toBe(2);
      expect(dispose).toHaveBeenCalledTimes(1);
      pending.resolve();
      await first;
      expect(await scope.close()).toBe(2);
      expect(removeFiles).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('blocks deletion after rejection but continues independent cleanup and retains failure after recovery', async () => {
    const scope = new FixtureCleanup();
    const dispose = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValue(undefined);
    const prerequisite = scope.own(dispose);
    const remove = jest.fn(() => Promise.resolve());
    scope.own(remove).dependsOn(prerequisite);
    const independent = jest.fn(() => Promise.resolve());
    scope.own(independent);
    expect(await scope.close()).toBe(2);
    expect(remove).not.toHaveBeenCalled();
    expect(independent).toHaveBeenCalledTimes(1);
    expect(await scope.close()).toBe(2);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('unwinds earlier acquisitions when construction rejects, preserving the constructor error', async () => {
    const scope = new FixtureCleanup();
    const dispose = jest.fn(() => Promise.resolve());
    const error = new Error('start failed');
    await expect(
      scope.initialize(async () => {
        await scope.acquire(() => Promise.resolve('listener'), dispose);
        await scope.acquire(() => Promise.reject(error), dispose);
      }),
    ).rejects.toBe(error);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith('listener');
    expect(await scope.close()).toBe(0);
  });

  it('owns late acquisition before it starts, withholding deletion and refusing use after teardown', async () => {
    jest.useFakeTimers();
    try {
      const scope = new FixtureCleanup();
      const remove = jest.fn(() => Promise.resolve());
      const files = scope.own(remove);
      const pending = Promise.withResolvers<string>();
      const dispose = jest.fn(() => Promise.resolve());
      const initialized = scope.acquire(() => pending.promise, dispose, [
        files,
      ]);
      const rejected =
        expect(initialized).rejects.toThrow('during acquisition');
      const hook = scope.close(10);
      await jest.advanceTimersByTimeAsync(10);
      expect(await hook).toBe(2);
      expect(remove).not.toHaveBeenCalled();
      pending.resolve('late listener');
      await rejected;
      expect(await scope.close()).toBe(2);
      expect(dispose).toHaveBeenCalledWith('late listener');
      expect(remove).toHaveBeenCalledTimes(1);
      const create = jest.fn(() => Promise.resolve('unused'));
      await expect(scope.acquire(create, dispose)).rejects.toThrow(
        'already closing',
      );
      expect(create).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds independent nontermination under one budget and accepts empty scopes', async () => {
    expect(await new FixtureCleanup().close()).toBe(0);
    jest.useFakeTimers();
    try {
      const scope = new FixtureCleanup();
      const calls = jest.fn(() => new Promise<void>(() => undefined));
      for (let index = 0; index < 40; index += 1) scope.own(calls);
      const result = scope.close(100);
      await jest.advanceTimersByTimeAsync(100);
      expect(await result).toBe(40);
      expect(calls).toHaveBeenCalledTimes(40);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('waits for a late start before shutdown and never returns a live fixture after close', async () => {
    jest.useFakeTimers();
    try {
      const scope = new FixtureCleanup();
      const started = Promise.withResolvers<void>();
      const shutdown = jest.fn(() => Promise.resolve());
      const instance = scope.initialize(async () => {
        scope.own(async () => {
          await started.promise;
          await shutdown();
        });
        await started.promise;
        return 'running';
      });
      const rejected = expect(instance).rejects.toThrow(
        'during initialization',
      );
      const hook = scope.close(10);
      await jest.advanceTimersByTimeAsync(10);
      expect(await hook).toBe(2);
      expect(shutdown).not.toHaveBeenCalled();
      started.resolve();
      await rejected;
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(await scope.close()).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });
  it('observes a pending release again without invoking it again', async () => {
    jest.useFakeTimers();
    try {
      const pending = Promise.withResolvers<void>();
      const action = jest.fn(() => pending.promise);
      const actions = [action];
      const first = releaseAll(actions, 10);
      await jest.advanceTimersByTimeAsync(10);
      expect(await first).toBe(1);
      const second = releaseAll(actions, 10);
      await jest.advanceTimersByTimeAsync(10);
      expect(await second).toBe(1);
      expect(action).toHaveBeenCalledTimes(1);
      pending.resolve();
      expect(await releaseAll(actions, 10)).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
  it('attempts independent releases after rejection and synchronous failure', async () => {
    const calls: number[] = [];
    expect(
      await releaseAll([
        (): Promise<void> => {
          calls.push(1);
          return Promise.resolve();
        },
        (): Promise<void> => {
          calls.push(2);
          throw new Error('failed');
        },
        (): Promise<void> => {
          calls.push(3);
          return Promise.reject(new Error('rejected'));
        },
      ]),
    ).toBe(2);
    expect(calls).toEqual([3, 2, 1]);
  });
  it('bounds the entire teardown even with many nonterminating releases', async () => {
    jest.useFakeTimers();
    try {
      const actions = Array.from(
        { length: 40 },
        () => (): Promise<void> => new Promise<void>(() => undefined),
      );
      const result = releaseAll(actions, 100);
      await jest.advanceTimersByTimeAsync(101);
      expect(await result).toBe(40);
      expect(actions).toHaveLength(40);
    } finally {
      jest.useRealTimers();
    }
  });
  it('retains failed releases for a later verified retry', async () => {
    let attempts = 0;
    const calls: string[] = [];
    const actions = [
      (): Promise<void> => {
        calls.push('first');
        return Promise.resolve();
      },
      (): Promise<void> => {
        calls.push('retry');
        return ++attempts === 1
          ? Promise.reject(new Error('transient'))
          : Promise.resolve();
      },
      (): Promise<void> => {
        calls.push('last');
        return Promise.resolve();
      },
    ];
    expect(await releaseAll(actions)).toBe(1);
    expect(actions).toHaveLength(1);
    expect(await releaseAll(actions)).toBe(0);
    expect(actions).toHaveLength(0);
    expect(calls).toEqual(['last', 'retry', 'first', 'retry']);
  });
  it('accepts empty and successful cleanup', async () => {
    expect(await releaseAll([])).toBe(0);
    expect(await releaseAll([(): Promise<void> => Promise.resolve()])).toBe(0);
  });
  it('counts a resolved shutdown report with a failed or timed-out phase as a failed release', async () => {
    const report = (
      ...statuses: string[]
    ): Promise<{ phases: { id: number; status: string }[] }> =>
      Promise.resolve({
        phases: statuses.map((status, index) => ({ id: index + 1, status })),
      });
    await expect(
      requireCompletedPhases(report('completed', 'completed')),
    ).resolves.toBeUndefined();
    await expect(requireCompletedPhases(report())).resolves.toBeUndefined();
    await expect(
      requireCompletedPhases(report('completed', 'failed', 'timed_out')),
    ).rejects.toThrow('phase 2 failed, phase 3 timed_out');
    const calls: string[] = [];
    expect(
      await releaseAll([
        (): Promise<void> => {
          calls.push('files');
          return Promise.resolve();
        },
        (): Promise<void> => {
          calls.push('kernel');
          return requireCompletedPhases(report('timed_out'));
        },
        (): Promise<void> => {
          calls.push('client');
          return Promise.resolve();
        },
      ]),
    ).toBe(1);
    expect(calls).toEqual(['client', 'kernel', 'files']);
  });
});

// Registration runs on every host; these tests do not emulate Windows I/O.
describe('secured-pipe kit registration', () => {
  const unavailable = (): Promise<never> =>
    Promise.reject(new Error('Registration must not execute a target'));
  function registrar(): {
    registration: ReturnType<typeof pipeConformanceRegistration>;
    registered: string[];
  } {
    const registered: string[] = [];
    const registration = pipeConformanceRegistration(
      (_title, body) => body(),
      (title) => {
        registered.push(title);
      },
    );
    return { registration, registered };
  }
  function kits(
    registration: ReturnType<typeof pipeConformanceRegistration>,
  ): void {
    runCanopyTransportConformance({
      name: 'secured-pipe',
      createPair: unavailable,
      ...registration,
    });
    runCanopyLeaseConformance({
      name: 'secured-pipe',
      target: { name: 'control plane', start: unavailable },
      ...registration,
    });
    runCanopyChannelConformance({
      name: 'secured-pipe',
      target: {
        name: 'control plane',
        echoKind: 'echo',
        holdKind: 'hold',
        start: unavailable,
      },
      ...registration,
    });
  }
  it('selects exactly ten transport, two lease and eight channel cases from the existing kits', () => {
    const { registration, registered } = registrar();
    kits(registration);
    expect(registered).toEqual([]);
    registration.complete();
    expect(registered).toEqual(
      inventory.cases
        .filter((entry) => entry.layer !== 'native')
        .map((entry) => entry.title),
    );
    expect(
      inventory.exclusions
        .filter((entry) => entry.kind === 'case')
        .map((entry) => entry.id),
    ).toEqual(['T07', 'T08', 'T09', 'T10', 'T11', 'T16']);
    expect(
      inventory.exclusions.filter((entry) => entry.kind === 'todo'),
    ).toHaveLength(7);
    expect(() => kits(registration)).toThrow('Duplicate');
  });
  it('replays exact suite ancestry and original kit callbacks without invoking them', () => {
    const ancestors: string[] = [];
    const emitted: { ancestorTitles: string[]; title: string }[] = [];
    const bodies = new Map<string, () => Promise<void>>();
    const registration = pipeConformanceRegistration(
      (title, body) => {
        ancestors.push(title);
        try {
          body();
        } finally {
          ancestors.pop();
        }
      },
      (title, body) => {
        expect(body).toBe(bodies.get(title));
        emitted.push({ ancestorTitles: [...ancestors], title });
      },
    );
    kits({
      ...registration,
      it(title, body): void {
        bodies.set(title, body);
        registration.it(title, body);
      },
    });
    registration.complete();
    expect(emitted).toEqual(
      inventory.cases
        .filter((entry) => entry.layer !== 'native')
        .map(({ ancestorTitles, title }) => ({ ancestorTitles, title })),
    );
  });
  it('rejects empty, omitted layers, unknown declarations and wrong ancestry', () => {
    expect(() => registrar().registration.complete()).toThrow('Incomplete');
    const { registration } = registrar();
    runCanopyTransportConformance({
      name: 'secured-pipe',
      createPair: unavailable,
      ...registration,
    });
    expect(() => registration.complete()).toThrow('Incomplete');
    expect(() =>
      registration.describe('unrelated', () =>
        registration.it(inventory.cases[0].title, unavailable),
      ),
    ).toThrow('Unknown');
    expect(() =>
      registration.describe('Canopy transport conformance: secured-pipe', () =>
        registration.it('new unreviewed case', unavailable),
      ),
    ).toThrow('Unknown');
  });
  it.each(['transport', 'lease', 'channel'])(
    'rejects omission of the %s layer before emitting any tests',
    (layer) => {
      const { registration, registered } = registrar();
      const registerWithoutLayer = {
        ...registration,
        it(title: string, body: () => Promise<void>): void {
          if (
            inventory.cases.some(
              (entry) => entry.layer === layer && entry.title === title,
            )
          )
            return;
          registration.it(title, body);
        },
      };
      kits(registerWithoutLayer);
      expect(() => registration.complete()).toThrow('Incomplete');
      expect(registered).toEqual([]);
    },
  );
  it.each(inventory.exclusions)(
    'rejects omission of $id from the reviewed declaration list',
    (omitted) => {
      const { registration } = registrar();
      for (const entry of inventory.cases.filter(
        (entry) => entry.layer !== 'native',
      )) {
        registration.describe(entry.ancestorTitles[0], () =>
          registration.it(entry.title, unavailable),
        );
      }
      registration.describe(
        'Canopy transport conformance: secured-pipe',
        () => {
          for (const entry of inventory.exclusions) {
            if (entry.id === omitted.id) continue;
            if (entry.kind === 'todo') registration.todo(entry.title);
            else registration.it(entry.title, unavailable);
          }
        },
      );
      expect(() => registration.complete()).toThrow('Incomplete');
    },
  );
  it('rejects duplicate excluded and pending declarations as well as duplicate required cases', () => {
    for (const entry of inventory.exclusions) {
      const { registration } = registrar();
      const register = (): void =>
        registration.describe(
          'Canopy transport conformance: secured-pipe',
          () => {
            if (entry.kind === 'todo') registration.todo(entry.title);
            else registration.it(entry.title, unavailable);
          },
        );
      register();
      expect(register).toThrow('Duplicate');
    }
  });
  it.each([
    ...inventory.cases.filter((entry) => entry.layer !== 'native'),
    ...inventory.exclusions.map((entry) => ({
      ...entry,
      ancestorTitles: ['Canopy transport conformance: secured-pipe'],
    })),
  ])(
    'never emits tests after rejecting duplicate $id, even if the caller catches the error',
    (entry) => {
      const { registration, registered } = registrar();
      kits(registration);
      expect(() =>
        registration.describe(entry.ancestorTitles[0], () =>
          'kind' in entry && entry.kind === 'todo'
            ? registration.todo(entry.title)
            : registration.it(entry.title, unavailable),
        ),
      ).toThrow('Duplicate');
      expect(() => registration.complete()).toThrow('Duplicate');
      expect(registered).toEqual([]);
    },
  );
  it.each(inventory.cases.filter((entry) => entry.layer !== 'native'))(
    'rejects a nested ancestry suffix match for $id before emitting any tests',
    (entry) => {
      const { registration, registered } = registrar();
      expect(() =>
        registration.describe('unrelated parent', () =>
          registration.describe(entry.ancestorTitles[0], () =>
            registration.it(entry.title, unavailable),
          ),
        ),
      ).toThrow('Unknown');
      expect(registered).toEqual([]);
    },
  );
  it('never emits tests after rejecting an unrelated declaration', () => {
    const { registration, registered } = registrar();
    kits(registration);
    expect(() =>
      registration.describe('unrelated', () =>
        registration.it(inventory.cases[0].title, unavailable),
      ),
    ).toThrow('Unknown');
    expect(() => registration.complete()).toThrow('Unknown');
    expect(registered).toEqual([]);
  });
  it('keeps native declarations outside the shared-kit registrar', () => {
    const { registration } = registrar();
    const native = inventory.cases.find((entry) => entry.layer === 'native');
    if (!native) throw new Error('Missing native inventory');
    expect(() =>
      registration.describe(native.ancestorTitles[0], () =>
        registration.it(native.title, unavailable),
      ),
    ).toThrow('Unknown');
  });
  it('rejects new suites after completion rather than silently collecting them', () => {
    const { registration } = registrar();
    kits(registration);
    registration.complete();
    expect(() => registration.describe('late suite', () => undefined)).toThrow(
      'completed',
    );
    expect(() => registration.complete()).toThrow('Duplicate');
  });
});
