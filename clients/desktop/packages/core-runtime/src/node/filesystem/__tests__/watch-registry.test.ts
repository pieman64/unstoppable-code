import { join, resolve, sep } from 'node:path';
import {
  createFilesystemWatchRegistry,
  type FilesystemNativeWatchHandle,
  type FilesystemNativeWatchListener,
  type FilesystemWatchBatch,
  type FilesystemWatchDiagnostic,
  type FilesystemWatchRegistryOptions,
} from '../watch-registry';

interface FakeNative {
  path: string;
  options: unknown;
  emit: FilesystemNativeWatchListener;
  fail(error: unknown): void;
  close: jest.Mock;
}

function harness(overrides: Partial<FilesystemWatchRegistryOptions> = {}): {
  registry: ReturnType<typeof createFilesystemWatchRegistry>;
  natives: FakeNative[];
  bursts: Array<() => void>;
  flush: () => Promise<void>;
  existing: Set<string>;
  watchFailure: { next: Error | null };
  diagnostics: FilesystemWatchDiagnostic[];
} {
  const natives: FakeNative[] = [];
  const bursts: Array<() => void> = [];
  // The anchor exists unless a test deletes it.
  const existing = new Set<string>([ROOT]);
  const watchFailure: { next: Error | null } = { next: null };
  const diagnostics: FilesystemWatchDiagnostic[] = [];
  let epoch = 0;
  const registry = createFilesystemWatchRegistry({
    watch: (path, options, listener) => {
      if (watchFailure.next) {
        const error = watchFailure.next;
        watchFailure.next = null;
        throw error;
      }
      const errorListeners: Array<(error: unknown) => void> = [];
      const native: FakeNative = {
        path,
        options,
        emit: listener,
        fail: (error) => {
          for (const errorListener of errorListeners) errorListener(error);
        },
        close: jest.fn(),
      };
      natives.push(native);
      const handle: FilesystemNativeWatchHandle = {
        close: native.close,
        on: (_event, errorListener): FilesystemNativeWatchHandle => {
          errorListeners.push(errorListener);
          return handle;
        },
      };
      return handle;
    },
    lstat: (path) =>
      existing.has(path)
        ? Promise.resolve({})
        : Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' })),
    scheduleBurst: (flush) => {
      bursts.push(flush);
    },
    createEpoch: () => `epoch-${++epoch}`,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    ...overrides,
  });
  const flush = async (): Promise<void> => {
    for (const burst of bursts.splice(0)) burst();
    for (let index = 0; index < 25; index += 1) await Promise.resolve();
  };
  return {
    registry,
    natives,
    bursts,
    flush,
    existing,
    watchFailure,
    diagnostics,
  };
}

const ROOT = resolve('/watch-root');
const tree = { path: ROOT, recursive: true, release: 'close' } as const;
const treeAnchor = { path: ROOT, recursive: true };

describe('createFilesystemWatchRegistry', () => {
  it('shares one native handle between subscribers of an anchor', async () => {
    const { registry, natives, flush } = harness();
    const first: FilesystemWatchBatch[] = [];
    const second: FilesystemWatchBatch[] = [];
    registry.acquire(tree, (batch) => first.push(batch));
    registry.acquire({ ...tree, path: `${ROOT}${sep}` }, (batch) =>
      second.push(batch),
    );
    expect(natives).toHaveLength(1);
    expect(natives[0]?.options).toEqual({ recursive: true });
    natives[0]?.emit('change', 'a.txt');
    await flush();
    expect(first).toEqual(second);
    expect(first).toEqual([
      {
        epoch: 'epoch-1',
        changes: [
          { kind: 'modified', path: 'a.txt', eventCount: 1, sequence: 1 },
        ],
      },
    ]);
    expect(registry.snapshot()).toEqual({
      attached: 1,
      dormant: 0,
      retrying: 0,
      subscribers: 2,
    });
  });

  it('keeps separate handles for recursive and shallow anchors', () => {
    const { registry, natives } = harness();
    registry.acquire(tree, () => undefined);
    registry.acquire(
      { path: ROOT, recursive: false, persistent: false, release: 'retain' },
      () => undefined,
    );
    expect(natives.map((native) => native.options)).toEqual([
      { recursive: true },
      { recursive: false, persistent: false },
    ]);
  });

  it('lets one subscriber leave without closing the handle another uses', async () => {
    const { registry, natives, flush } = harness();
    const kept: FilesystemWatchBatch[] = [];
    const leaving = registry.acquire(tree, () => undefined);
    registry.acquire(tree, (batch) => kept.push(batch));
    leaving.release();
    leaving.release();
    expect(natives[0]?.close).not.toHaveBeenCalled();
    natives[0]?.emit('change', 'b');
    await flush();
    expect(kept).toHaveLength(1);
  });

  it('closes a close-policy handle with its last subscriber', () => {
    const { registry, natives } = harness();
    const subscription = registry.acquire(tree, () => undefined);
    subscription.release();
    expect(natives[0]?.close).toHaveBeenCalledTimes(1);
    expect(registry.position(tree)).toBeNull();
    registry.acquire(tree, () => undefined);
    expect(natives).toHaveLength(2);
  });

  it('keeps a retain-policy handle dormant and reuses it with a new epoch', async () => {
    const { registry, natives, flush } = harness();
    const head = {
      path: ROOT,
      recursive: false,
      persistent: false,
      release: 'retain',
    } as const;
    const first = registry.acquire(head, () => undefined);
    expect(first.position).toEqual({ epoch: 'epoch-1', sequence: 0 });
    first.release();
    expect(natives[0]?.close).not.toHaveBeenCalled();
    expect(registry.snapshot()).toMatchObject({ dormant: 1, attached: 0 });
    expect(registry.position(head)).toBeNull();
    natives[0]?.emit('change', 'HEAD');
    await flush();
    const batches: FilesystemWatchBatch[] = [];
    const second = registry.acquire(head, (batch) => batches.push(batch));
    expect(natives).toHaveLength(1);
    expect(second.position).toEqual({ epoch: 'epoch-2', sequence: 0 });
    natives[0]?.emit('change', 'HEAD');
    await flush();
    expect(batches).toEqual([
      {
        epoch: 'epoch-2',
        changes: [
          { kind: 'modified', path: 'HEAD', eventCount: 1, sequence: 1 },
        ],
      },
    ]);
  });

  it('batches a burst by path and folds the notification count', async () => {
    const { registry, natives, flush, existing } = harness();
    const batches: FilesystemWatchBatch[] = [];
    registry.acquire(tree, (batch) => batches.push(batch));
    existing.add(join(ROOT, 'new.txt'));
    const native = natives[0];
    native?.emit('change', 'a.txt');
    native?.emit('change', 'a.txt');
    native?.emit('rename', 'new.txt');
    native?.emit('rename', `dir${sep}gone.txt`);
    native?.emit('change', Buffer.from('b.txt'));
    await flush();
    expect(batches).toEqual([
      {
        epoch: 'epoch-1',
        changes: [
          { kind: 'modified', path: 'a.txt', eventCount: 2, sequence: 1 },
          { kind: 'created', path: 'new.txt', eventCount: 1, sequence: 2 },
          { kind: 'deleted', path: 'dir/gone.txt', eventCount: 1, sequence: 3 },
          { kind: 'modified', path: 'b.txt', eventCount: 1, sequence: 4 },
        ],
      },
    ]);
    expect(registry.position(tree)).toEqual({
      epoch: 'epoch-1',
      sequence: 4,
    });
  });

  it('reports the anchor itself as deleted once it is gone', async () => {
    const { registry, natives, flush, existing } = harness();
    const batches: FilesystemWatchBatch[] = [];
    registry.acquire(tree, (batch) => batches.push(batch));
    existing.delete(ROOT);
    // macOS names a deleted watched directory by its own basename.
    natives[0]?.emit('rename', 'watch-root');
    natives[0]?.emit('change', 'a.txt');
    await flush();
    expect(batches).toEqual([
      {
        epoch: 'epoch-1',
        changes: [{ kind: 'deleted', path: '', eventCount: 2, sequence: 1 }],
      },
    ]);
  });

  it('reports a re-created anchor as itself, not as a child named after it', async () => {
    const { registry, natives, flush, existing } = harness();
    const batches: FilesystemWatchBatch[] = [];
    registry.acquire(tree, (batch) => batches.push(batch));
    // macOS keeps watching a deleted directory's path and names the
    // re-created directory by its own basename.
    natives[0]?.emit('rename', 'watch-root');
    natives[0]?.emit('change', 'watch-root');
    await flush();
    natives[0]?.emit('change', 'watch-root');
    await flush();
    // A real child that shares the anchor's name stays a child.
    existing.add(join(ROOT, 'watch-root'));
    natives[0]?.emit('rename', 'watch-root');
    await flush();
    expect(batches).toEqual([
      {
        epoch: 'epoch-1',
        changes: [{ kind: 'created', path: '', eventCount: 2, sequence: 1 }],
      },
      {
        epoch: 'epoch-1',
        changes: [{ kind: 'modified', path: '', eventCount: 1, sequence: 2 }],
      },
      {
        epoch: 'epoch-1',
        changes: [
          { kind: 'created', path: 'watch-root', eventCount: 1, sequence: 3 },
        ],
      },
    ]);
  });

  it('turns a burst without a filename into one overflow', async () => {
    const { registry, natives, flush } = harness();
    const batches: FilesystemWatchBatch[] = [];
    registry.acquire(tree, (batch) => batches.push(batch));
    natives[0]?.emit('change', 'a.txt');
    natives[0]?.emit('rename', null);
    natives[0]?.emit('change', 'b.txt');
    await flush();
    expect(batches).toEqual([
      {
        epoch: 'epoch-1',
        changes: [{ kind: 'overflow', path: '', eventCount: 3, sequence: 1 }],
      },
    ]);
  });

  it('overflows a burst above the distinct-path limit', async () => {
    const { registry, natives, flush } = harness({ overflowPathLimit: 2 });
    const batches: FilesystemWatchBatch[] = [];
    registry.acquire(tree, (batch) => batches.push(batch));
    natives[0]?.emit('change', 'a');
    natives[0]?.emit('change', 'b');
    natives[0]?.emit('change', 'a');
    await flush();
    natives[0]?.emit('change', 'a');
    natives[0]?.emit('change', 'b');
    natives[0]?.emit('change', 'c');
    natives[0]?.emit('change', 'd');
    await flush();
    expect(batches.map((batch) => batch.changes)).toEqual([
      [
        { kind: 'modified', path: 'a', eventCount: 2, sequence: 1 },
        { kind: 'modified', path: 'b', eventCount: 1, sequence: 2 },
      ],
      [{ kind: 'overflow', path: '', eventCount: 4, sequence: 3 }],
    ]);
  });

  it('delivers bursts in arrival order when classification is slow', async () => {
    let releaseFirst: () => void = () => undefined;
    const firstLstat = new Promise<void>((resolveLstat) => {
      releaseFirst = resolveLstat;
    });
    const { registry, natives, flush } = harness({
      lstat: (path) => (path.endsWith('slow') ? firstLstat : Promise.resolve()),
    });
    const order: string[] = [];
    registry.acquire(tree, (batch) => {
      for (const change of batch.changes) order.push(change.path);
    });
    natives[0]?.emit('rename', 'slow');
    await flush();
    natives[0]?.emit('change', 'fast');
    await flush();
    expect(order).toEqual([]);
    releaseFirst();
    await flush();
    expect(order).toEqual(['slow', 'fast']);
  });

  it('ignores notifications after the last subscriber left', async () => {
    const { registry, natives, flush, bursts } = harness();
    const batches: FilesystemWatchBatch[] = [];
    const subscription = registry.acquire(tree, (batch) => batches.push(batch));
    natives[0]?.emit('change', 'a');
    subscription.release();
    await flush();
    natives[0]?.emit('change', 'b');
    expect(bursts).toHaveLength(0);
    expect(batches).toEqual([]);
  });

  it('isolates a throwing subscriber', async () => {
    const { registry, natives, flush } = harness();
    const batches: FilesystemWatchBatch[] = [];
    registry.acquire(tree, () => {
      throw new Error('subscriber failed');
    });
    registry.acquire(tree, (batch) => batches.push(batch));
    natives[0]?.emit('change', 'a');
    await flush();
    expect(batches).toHaveLength(1);
  });

  it('throws when the native handle cannot attach and keeps no entry', () => {
    const { registry, watchFailure, natives } = harness();
    watchFailure.next = Object.assign(new Error('missing'), {
      code: 'ENOENT',
    });
    expect(() => registry.acquire(tree, () => undefined)).toThrow('missing');
    expect(registry.snapshot()).toEqual({
      attached: 0,
      dormant: 0,
      retrying: 0,
      subscribers: 0,
    });
    registry.acquire(tree, () => undefined);
    expect(natives).toHaveLength(1);
  });

  it('closes a created handle that fails to finish attaching', () => {
    const close = jest.fn();
    const { registry } = harness({
      watch: (): FilesystemNativeWatchHandle => ({
        close,
        on: (): never => {
          throw new Error('listener rejected');
        },
      }),
    });
    expect(() => registry.acquire(tree, () => undefined)).toThrow(
      'listener rejected',
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(registry.snapshot()).toEqual({
      attached: 0,
      dormant: 0,
      retrying: 0,
      subscribers: 0,
    });
  });

  describe('native errors', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('re-attaches with 1 s to 30 s backoff, then emits one overflow', async () => {
      const { registry, natives, flush, watchFailure, diagnostics } = harness();
      const batches: FilesystemWatchBatch[] = [];
      registry.acquire(tree, (batch) => batches.push(batch));
      natives[0]?.fail(new Error('ENOSPC'));
      expect(natives[0]?.close).toHaveBeenCalledTimes(1);
      expect(registry.snapshot()).toMatchObject({ attached: 0, retrying: 1 });

      const delays: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        watchFailure.next = new Error('still failing');
        const before = diagnostics.length;
        for (let elapsed = 0; diagnostics.length === before; elapsed += 1000) {
          jest.advanceTimersByTime(1000);
          if (elapsed > 60_000) throw new Error('retry never fired');
          delays[attempt] = elapsed + 1000;
        }
      }
      expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
      expect(diagnostics[0]).toMatchObject({ kind: 'error' });
      expect(diagnostics[1]).toMatchObject({
        kind: 'retry-failed',
        nextDelayMs: 2000,
      });
      await flush();
      // The first failed re-attach reports the loss once (the anchor may be
      // gone); later failures stay quiet.
      expect(batches).toEqual([
        {
          epoch: 'epoch-1',
          changes: [{ kind: 'overflow', path: '', eventCount: 1, sequence: 1 }],
        },
      ]);
      jest.advanceTimersByTime(30_000);
      expect(natives).toHaveLength(2);
      expect(diagnostics.at(-1)).toMatchObject({ kind: 'reattached' });
      await flush();
      expect(batches.at(-1)).toEqual({
        epoch: 'epoch-1',
        changes: [{ kind: 'overflow', path: '', eventCount: 1, sequence: 2 }],
      });
      expect(batches).toHaveLength(2);
      natives[1]?.emit('change', 'a');
      await flush();
      expect(batches.at(-1)?.changes).toEqual([
        { kind: 'modified', path: 'a', eventCount: 1, sequence: 3 },
      ]);
    });

    it('reports a handle that cannot re-attach, as when its root was deleted', async () => {
      const { registry, natives, flush, watchFailure } = harness();
      const batches: FilesystemWatchBatch[] = [];
      registry.acquire(tree, (batch) => batches.push(batch));
      natives[0]?.fail(Object.assign(new Error('gone'), { code: 'ENOENT' }));
      await flush();
      // Nothing yet: a transient error that re-attaches reports once, later.
      expect(batches).toEqual([]);
      watchFailure.next = Object.assign(new Error('gone'), { code: 'ENOENT' });
      jest.advanceTimersByTime(1_000);
      await flush();
      expect(batches).toEqual([
        {
          epoch: 'epoch-1',
          changes: [{ kind: 'overflow', path: '', eventCount: 1, sequence: 1 }],
        },
      ]);
    });

    it('closes every errored handle, even one the error left running', () => {
      const { registry, natives } = harness();
      // The fake keeps running after `fail`, as Node's recursive Linux
      // watcher can after a scan error.
      const subscription = registry.acquire(tree, () => undefined);
      natives[0]?.fail(new Error('EMFILE'));
      expect(natives[0]?.close).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1_000);
      expect(natives).toHaveLength(2);
      natives[1]?.fail(new Error('EMFILE'));
      // A repeated error on an already-replaced handle is ignored.
      natives[0]?.fail(new Error('EMFILE'));
      jest.advanceTimersByTime(1_000);
      expect(natives).toHaveLength(3);
      subscription.release();
      expect(natives.map((native) => native.close.mock.calls.length)).toEqual([
        1, 1, 1,
      ]);
      expect(registry.snapshot()).toEqual({
        attached: 0,
        dormant: 0,
        retrying: 0,
        subscribers: 0,
      });
    });

    it('closes an errored retain-policy handle before replacing it', () => {
      const { registry, natives } = harness();
      const head = { path: ROOT, recursive: false, release: 'retain' } as const;
      registry.acquire(head, () => undefined);
      natives[0]?.fail(new Error('EPERM'));
      expect(natives[0]?.close).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1_000);
      expect(natives).toHaveLength(2);
      expect(natives[1]?.close).not.toHaveBeenCalled();
      expect(registry.snapshot()).toMatchObject({ attached: 1, retrying: 0 });
    });

    it('keeps recovering when closing an errored handle throws', () => {
      const { registry, natives } = harness();
      registry.acquire(tree, () => undefined);
      natives[0]?.close.mockImplementation(() => {
        throw new Error('already closed');
      });
      expect(() => natives[0]?.fail(new Error('EPERM'))).not.toThrow();
      expect(registry.snapshot()).toMatchObject({ attached: 0, retrying: 1 });
      jest.advanceTimersByTime(1_000);
      expect(natives).toHaveLength(2);
      expect(registry.snapshot()).toMatchObject({ attached: 1, retrying: 0 });
    });

    it('ignores an error the failed handle emits while closing', () => {
      const { registry, natives, diagnostics } = harness();
      registry.acquire(tree, () => undefined);
      natives[0]?.close.mockImplementation(() => {
        natives[0]?.fail(new Error('EMFILE'));
      });
      natives[0]?.fail(new Error('EMFILE'));
      expect(natives[0]?.close).toHaveBeenCalledTimes(1);
      expect(diagnostics.filter(({ kind }) => kind === 'error')).toHaveLength(
        1,
      );
      expect(registry.snapshot()).toMatchObject({ attached: 0, retrying: 1 });
    });

    it('stops retrying once the last subscriber leaves', () => {
      const { registry, natives } = harness();
      const subscription = registry.acquire(tree, () => undefined);
      natives[0]?.fail(new Error('EPERM'));
      subscription.release();
      jest.advanceTimersByTime(60_000);
      expect(natives).toHaveLength(1);
      expect(registry.snapshot()).toEqual({
        attached: 0,
        dormant: 0,
        retrying: 0,
        subscribers: 0,
      });
    });

    it('forgets a dormant handle that errors', async () => {
      const { registry, natives, flush } = harness();
      const head = { path: ROOT, recursive: false, release: 'retain' } as const;
      registry.acquire(head, () => undefined).release();
      natives[0]?.fail(new Error('gone'));
      expect(natives[0]?.close).toHaveBeenCalledTimes(1);
      expect(registry.snapshot().dormant).toBe(0);
      const batches: FilesystemWatchBatch[] = [];
      registry.acquire(head, (batch) => batches.push(batch));
      expect(natives).toHaveLength(2);
      natives[0]?.emit('change', 'HEAD');
      natives[1]?.emit('change', 'HEAD');
      await flush();
      expect(batches).toEqual([
        {
          epoch: 'epoch-2',
          changes: [
            { kind: 'modified', path: 'HEAD', eventCount: 1, sequence: 1 },
          ],
        },
      ]);
    });

    it('survives a throwing diagnostic hook', () => {
      const { registry, natives } = harness({
        onDiagnostic: () => {
          throw new Error('diagnostic failed');
        },
      });
      registry.acquire(tree, () => undefined);
      expect(() => natives[0]?.fail(new Error('EPERM'))).not.toThrow();
    });
  });

  describe('unavailable policy', () => {
    const coded = (code: string): Error =>
      Object.assign(new Error(code), { code });
    const policy = (): {
      matches: jest.Mock<boolean, [unknown]>;
      report: jest.Mock<void, [unknown, unknown]>;
    } => ({
      matches: jest.fn(
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          (error.code === 'ENOSPC' || error.code === 'EACCES'),
      ),
      report: jest.fn<void, [unknown, unknown]>(),
    });

    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('reports a matching error once per detachment and retries every 30 s after the first attempt', async () => {
      const unavailable = policy();
      const { registry, natives, flush, watchFailure, diagnostics } = harness({
        unavailable,
      });
      const batches: FilesystemWatchBatch[] = [];
      registry.acquire(tree, (batch) => batches.push(batch));
      const limit = coded('ENOSPC');
      natives[0]?.fail(limit);
      expect(unavailable.report).toHaveBeenCalledTimes(1);
      expect(unavailable.report).toHaveBeenCalledWith(limit, treeAnchor);
      expect(diagnostics[0]).toMatchObject({
        kind: 'error',
        unavailable: true,
      });

      const delays: number[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        watchFailure.next = coded('ENOSPC');
        const before = diagnostics.length;
        for (let elapsed = 0; diagnostics.length === before; elapsed += 1000) {
          jest.advanceTimersByTime(1000);
          if (elapsed > 60_000) throw new Error('retry never fired');
          delays[attempt] = elapsed + 1000;
        }
      }
      // The first retry keeps the 1 s rescan signal; repeats use the 30 s
      // native retry of the worktree observers instead of ramping.
      expect(delays).toEqual([1000, 30_000, 30_000]);
      expect(diagnostics[1]).toMatchObject({
        kind: 'retry-failed',
        unavailable: true,
        nextDelayMs: 30_000,
      });
      expect(unavailable.report).toHaveBeenCalledTimes(1);
      await flush();
      expect(batches).toEqual([
        {
          epoch: 'epoch-1',
          changes: [{ kind: 'overflow', path: '', eventCount: 1, sequence: 1 }],
        },
      ]);

      jest.advanceTimersByTime(30_000);
      expect(natives).toHaveLength(2);
      await flush();
      expect(batches).toHaveLength(2);
      natives[1]?.fail(coded('EACCES'));
      expect(unavailable.report).toHaveBeenCalledTimes(2);
    });

    it('reports a matching re-attach failure after a non-matching error', () => {
      const unavailable = policy();
      const { registry, natives, watchFailure, diagnostics } = harness({
        unavailable,
      });
      registry.acquire(tree, () => undefined);
      natives[0]?.fail(coded('EIO'));
      expect(unavailable.report).not.toHaveBeenCalled();
      const limit = coded('ENOSPC');
      watchFailure.next = limit;
      jest.advanceTimersByTime(1_000);
      expect(unavailable.report).toHaveBeenCalledWith(limit, treeAnchor);
      expect(diagnostics.at(-1)).toMatchObject({
        kind: 'retry-failed',
        unavailable: true,
        nextDelayMs: 30_000,
      });
    });

    it('keeps the doubling backoff and stays quiet for other errors', () => {
      const unavailable = policy();
      const { registry, natives, watchFailure, diagnostics } = harness({
        unavailable,
      });
      registry.acquire(tree, () => undefined);
      natives[0]?.fail(coded('EIO'));
      watchFailure.next = coded('ENOENT');
      jest.advanceTimersByTime(1_000);
      expect(unavailable.report).not.toHaveBeenCalled();
      expect(diagnostics).toEqual([
        expect.objectContaining({ kind: 'error', unavailable: false }),
        expect.objectContaining({
          kind: 'retry-failed',
          unavailable: false,
          nextDelayMs: 2_000,
        }),
      ]);
    });

    it('reports a matching initial attach failure, then rethrows it', () => {
      const unavailable = policy();
      const { registry, watchFailure } = harness({ unavailable });
      const limit = coded('ENOSPC');
      watchFailure.next = limit;
      expect(() => registry.acquire(tree, () => undefined)).toThrow(limit);
      expect(unavailable.report).toHaveBeenCalledWith(limit, treeAnchor);
      watchFailure.next = coded('ENOENT');
      expect(() => registry.acquire(tree, () => undefined)).toThrow('ENOENT');
      expect(unavailable.report).toHaveBeenCalledTimes(1);
      expect(registry.snapshot().subscribers).toBe(0);
    });

    it('does not report an error on a dormant handle that nobody watches', () => {
      const unavailable = policy();
      const { registry, natives, diagnostics } = harness({ unavailable });
      const head = { path: ROOT, recursive: false, release: 'retain' } as const;
      registry.acquire(head, () => undefined).release();
      expect(registry.snapshot()).toMatchObject({ dormant: 1 });
      natives[0]?.fail(coded('ENOSPC'));
      expect(unavailable.report).not.toHaveBeenCalled();
      expect(diagnostics).toEqual([
        expect.objectContaining({ kind: 'error', unavailable: true }),
      ]);
      expect(registry.snapshot()).toEqual({
        attached: 0,
        dormant: 0,
        retrying: 0,
        subscribers: 0,
      });
    });

    it('follows the latest error within one detachment and reports it once', () => {
      const unavailable = policy();
      const { registry, natives, watchFailure, diagnostics } = harness({
        unavailable,
      });
      registry.acquire(tree, () => undefined);
      natives[0]?.fail(coded('ENOSPC'));
      watchFailure.next = coded('ENOENT');
      jest.advanceTimersByTime(1_000);
      watchFailure.next = coded('EACCES');
      jest.advanceTimersByTime(2_000);
      watchFailure.next = coded('ENOENT');
      jest.advanceTimersByTime(30_000);
      expect(
        diagnostics.map((diagnostic) =>
          diagnostic.kind === 'retry-failed'
            ? [diagnostic.unavailable, diagnostic.nextDelayMs]
            : diagnostic.kind,
        ),
      ).toEqual(['error', [false, 2_000], [true, 30_000], [false, 30_000]]);
      expect(unavailable.report).toHaveBeenCalledTimes(1);
    });

    it('survives a throwing policy', () => {
      const { registry, natives } = harness({
        unavailable: {
          matches: () => {
            throw new Error('matches failed');
          },
          report: () => undefined,
        },
      });
      registry.acquire(tree, () => undefined);
      expect(() => natives[0]?.fail(coded('ENOSPC'))).not.toThrow();
      expect(registry.snapshot().retrying).toBe(1);
      const reporting = harness({
        unavailable: {
          matches: () => true,
          report: () => {
            throw new Error('report failed');
          },
        },
      });
      const limit = coded('ENOSPC');
      reporting.watchFailure.next = limit;
      expect(() => reporting.registry.acquire(tree, () => undefined)).toThrow(
        limit,
      );
    });

    it('rescans a detached anchor that asks for it until it re-attaches', async () => {
      const unavailable = policy();
      const { registry, natives, flush, watchFailure } = harness({
        unavailable,
      });
      const head = {
        path: ROOT,
        recursive: false,
        release: 'retain',
        rescanWhileUnavailableMs: 2_000,
      } as const;
      const batches: FilesystemWatchBatch[] = [];
      registry.acquire(head, (batch) => batches.push(batch));
      const limit = coded('ENOSPC');
      natives[0]?.fail(limit);
      expect(unavailable.report).toHaveBeenCalledWith(limit, {
        path: ROOT,
        recursive: false,
      });
      const overflows = async (): Promise<number> => {
        for (let round = 0; round < 10; round += 1) await flush();
        return batches.flatMap((batch) => batch.changes).length;
      };
      // 1 s: the failed first re-attach; 2 s and 4 s: the rescans.
      watchFailure.next = coded('ENOSPC');
      jest.advanceTimersByTime(1_000);
      expect(await overflows()).toBe(1);
      jest.advanceTimersByTime(1_000);
      expect(await overflows()).toBe(2);
      jest.advanceTimersByTime(2_000);
      expect(await overflows()).toBe(3);
      // The 30 s re-attach succeeds: one more overflow, then no rescans.
      jest.advanceTimersByTime(27_000);
      const reattached = await overflows();
      expect(natives).toHaveLength(2);
      jest.advanceTimersByTime(10_000);
      expect(await overflows()).toBe(reattached);
      expect(
        batches.flatMap((batch) => batch.changes).map((change) => change.kind),
      ).toEqual(Array(reattached).fill('overflow'));
    });

    it('does not rescan for other errors or anchors that did not ask', async () => {
      const unavailable = policy();
      const head = {
        path: ROOT,
        recursive: false,
        release: 'retain',
        rescanWhileUnavailableMs: 2_000,
      } as const;
      const changes = async (
        anchor: typeof head | typeof tree,
        code: string,
      ): Promise<number> => {
        const { registry, natives, flush, watchFailure } = harness({
          unavailable,
        });
        const batches: FilesystemWatchBatch[] = [];
        registry.acquire(anchor, (batch) => batches.push(batch));
        natives[0]?.fail(coded(code));
        // Every re-attach in the first 7 s fails the same way.
        for (const delayMs of [1_000, 2_000, 4_000]) {
          watchFailure.next = coded(code);
          jest.advanceTimersByTime(delayMs);
        }
        for (let round = 0; round < 10; round += 1) await flush();
        return batches.flatMap((batch) => batch.changes).length;
      };
      // One overflow each for the failed first re-attach, nothing more.
      expect(await changes(head, 'EIO')).toBe(1);
      expect(await changes(tree, 'ENOSPC')).toBe(1);
    });

    it('stops rescanning once the last subscriber leaves', async () => {
      const { registry, natives, flush, watchFailure } = harness({
        unavailable: policy(),
      });
      const batches: FilesystemWatchBatch[] = [];
      const subscription = registry.acquire(
        {
          path: ROOT,
          recursive: false,
          release: 'retain',
          rescanWhileUnavailableMs: 2_000,
        },
        (batch) => batches.push(batch),
      );
      natives[0]?.fail(coded('ENOSPC'));
      subscription.release();
      watchFailure.next = coded('ENOSPC');
      jest.advanceTimersByTime(10_000);
      await flush();
      expect(batches).toEqual([]);
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
