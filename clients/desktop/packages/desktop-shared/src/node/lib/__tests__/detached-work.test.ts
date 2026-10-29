import {
  detachedWorkCallback,
  settleAll,
  settleDetachedWork,
  settleEach,
  trackDetachedWork,
} from '../detached-work';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((done) => setImmediate(done));

describe('settleAll', () => {
  it('resolves with the values Promise.all resolves with, in order', async () => {
    const values = [
      Promise.resolve(1),
      Promise.resolve('two'),
      Promise.resolve({ three: 3 }),
    ];
    await expect(settleAll(values)).resolves.toEqual(await Promise.all(values));
    await expect(settleAll(['plain', 2])).resolves.toEqual(['plain', 2]);
    const [count, label]: [number, string] = await settleAll([
      Promise.resolve(1),
      Promise.resolve('label'),
    ]);
    expect([count, label]).toEqual([1, 'label']);
    await expect(settleAll([])).resolves.toEqual([]);
  });

  it('rejects with the first rejection only after every sibling settles', async () => {
    const slow = deferred();
    const first = new Error('first');
    const settled = jest.fn();
    const result = settleAll([
      slow.promise,
      Promise.reject(first),
      Promise.reject(new Error('second')),
    ]).finally(settled);
    await flush();
    expect(settled).not.toHaveBeenCalled();
    slow.resolve();
    await expect(result).rejects.toBe(first);
  });

  it('keeps the rejection order of Promise.all and non-Error reasons', async () => {
    const early = deferred();
    const late = deferred();
    const result = settleAll([late.promise, early.promise]);
    early.reject('early');
    await flush();
    late.reject(new Error('late'));
    await expect(result).rejects.toBe('early');
  });
});

describe('settleAll with a throwing iterable', () => {
  it('waits for already yielded work before rethrowing the iterator error', async () => {
    const slow = deferred();
    const iteratorFailure = new Error('iterator failed');
    function* work(): Generator<Promise<void>> {
      yield slow.promise;
      throw iteratorFailure;
    }
    const settled = jest.fn();
    const result = settleAll(work()).finally(settled);
    result.catch(() => undefined);
    await flush();
    expect(settled).not.toHaveBeenCalled();
    slow.resolve();
    await expect(result).rejects.toBe(iteratorFailure);
  });
});

describe('settleEach', () => {
  it('resolves with the results Promise.allSettled resolves with', async () => {
    const failure = new Error('failed');
    await expect(
      settleEach([Promise.resolve(1), Promise.reject(failure), 'plain']),
    ).resolves.toEqual([
      { status: 'fulfilled', value: 1 },
      { status: 'rejected', reason: failure },
      { status: 'fulfilled', value: 'plain' },
    ]);
    const [count, label] = await settleEach([
      Promise.resolve(1),
      Promise.resolve('label'),
    ]);
    const typed: [PromiseSettledResult<number>, PromiseSettledResult<string>] =
      [count, label];
    expect(typed).toEqual([
      { status: 'fulfilled', value: 1 },
      { status: 'fulfilled', value: 'label' },
    ]);
    await expect(settleEach([])).resolves.toEqual([]);
  });

  it('resolves each value as it is yielded, like Promise.allSettled', async () => {
    const run = (
      settle: (values: Iterable<unknown>) => Promise<unknown>,
    ): Promise<unknown> => {
      let seen = false;
      const probe = {
        get then(): undefined {
          seen = true;
          return undefined;
        },
      };
      function* values(): Generator<unknown> {
        yield probe;
        yield seen ? 'seen' : 'unseen';
      }
      return settle(values());
    };
    const native = await run((values) => Promise.allSettled(values));
    const tracked = await run((values) => settleEach(values));
    expect(tracked).toEqual(native);
  });

  it('waits for already yielded work before rethrowing the iterator error', async () => {
    const slow = deferred();
    const iteratorFailure = new Error('iterator failed');
    function* work(): Generator<Promise<void>> {
      yield slow.promise;
      throw iteratorFailure;
    }
    const settled = jest.fn();
    const result = settleEach(work()).finally(settled);
    result.catch(() => undefined);
    await flush();
    expect(settled).not.toHaveBeenCalled();
    slow.resolve();
    await expect(result).rejects.toBe(iteratorFailure);
  });
});

describe('trackDetachedWork', () => {
  it('starts work synchronously and tracks it until it settles', async () => {
    const work = deferred();
    const start = jest.fn(() => work.promise);
    trackDetachedWork(start);
    expect(start).toHaveBeenCalledTimes(1);
    const drained = jest.fn();
    const draining = settleDetachedWork().then(drained);
    await flush();
    expect(drained).not.toHaveBeenCalled();
    work.resolve();
    await draining;
    expect(drained).toHaveBeenCalledTimes(1);
  });

  // The unhandled-rejection path is covered in
  // scripts/lib/eslint-w5-detached-work.test.mjs: Jest fails any test that
  // leaves a rejection unhandled.
  it('keeps a handled chain handled', async () => {
    const listener = jest.fn();
    process.on('unhandledRejection', listener);
    try {
      trackDetachedWork(() =>
        Promise.reject(new Error('handled')).catch(() => undefined),
      );
      await settleDetachedWork();
      await flush();
    } finally {
      process.off('unhandledRejection', listener);
    }
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('detachedWorkCallback', () => {
  it('starts tracked work each time it fires, not when created', async () => {
    const work = deferred();
    const start = jest.fn(() => work.promise);
    const callback = detachedWorkCallback(start);
    expect(start).not.toHaveBeenCalled();
    expect(callback()).toBeUndefined();
    expect(start).toHaveBeenCalledTimes(1);
    const drained = jest.fn();
    const draining = settleDetachedWork().then(drained);
    await flush();
    expect(drained).not.toHaveBeenCalled();
    work.resolve();
    await draining;
  });

  it('allows a callback that decides not to start work', async () => {
    const callback = detachedWorkCallback(() => undefined);
    callback();
    await expect(settleDetachedWork()).resolves.toBeUndefined();
  });
});
