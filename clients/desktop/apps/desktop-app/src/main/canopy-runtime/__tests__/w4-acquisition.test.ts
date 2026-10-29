import {
  acquireW4Within,
  settleW4LateReleases,
  trackW4LateCleanup,
  W4Resources,
  w4Gate,
} from './w4-acquisition';

afterEach(() => settleW4LateReleases());
afterAll(() => settleW4LateReleases());

it('releases late acquisitions after cancellation without publishing them', async () => {
  const scope = new W4Resources();
  const pending = w4Gate<{ close(): void }>();
  const closed = w4Gate<void>();
  const acquisition = scope.acquire(pending.promise, (resource) =>
    resource.close(),
  );
  const rejected = expect(acquisition).rejects.toThrow('cancel setup');
  await scope.cancel(new Error('cancel setup'));
  await rejected;
  pending.resolve({ close: () => closed.resolve() });
  await closed.promise;
  await expect(settleW4LateReleases()).resolves.toBeUndefined();
});

it('attempts every release exactly once even after one throws', async () => {
  const scope = new W4Resources();
  const released: number[] = [];
  await scope.own(1, (value) => {
    released.push(value);
  });
  await scope.own(2, (value) => {
    released.push(value);
    throw new Error('cleanup sentinel');
  });
  const one = scope.close();
  expect(scope.close()).toBe(one);
  await expect(one).rejects.toMatchObject({
    errors: [expect.objectContaining({ message: 'cleanup sentinel' })],
  });
  expect(released).toEqual([2, 1]);
  await expect(
    scope.fail(new Error('primary failure'), 'combined'),
  ).rejects.toMatchObject({
    errors: [
      expect.objectContaining({ message: 'primary failure' }),
      expect.objectContaining({
        errors: [expect.objectContaining({ message: 'cleanup sentinel' })],
      }),
    ],
  });
});

it('runner timeout disposes a backend that arrives late', async () => {
  jest.useFakeTimers();
  const pending = w4Gate<{ close(): void }>();
  const closed = w4Gate<void>();
  try {
    const acquisition = acquireW4Within(
      pending.promise,
      (resource) => resource.close(),
      'late backend',
    );
    const rejected = expect(acquisition).rejects.toThrow(
      'Timed out: late backend',
    );
    await jest.advanceTimersByTimeAsync(2_000);
    await rejected;
    pending.resolve({ close: () => closed.resolve() });
    await closed.promise;
  } finally {
    jest.useRealTimers();
  }
});

it('surfaces a late release failure after the runner timeout', async () => {
  jest.useFakeTimers();
  const pending = w4Gate<number>();
  const released = w4Gate<void>();
  const sentinel = new Error('late release sentinel');
  try {
    const acquisition = acquireW4Within(
      pending.promise,
      () => {
        released.resolve();
        throw sentinel;
      },
      'late backend',
    );
    const rejected = expect(acquisition).rejects.toThrow(
      'Timed out: late backend',
    );
    await jest.advanceTimersByTimeAsync(2_000);
    await rejected;
    pending.resolve(1);
    await released.promise;
  } finally {
    jest.useRealTimers();
  }
  await expect(settleW4LateReleases()).rejects.toMatchObject({
    errors: [
      expect.objectContaining({
        message: 'W4 late release after "Timed out: late backend" failed.',
        cause: sentinel,
      }),
    ],
  });
  // Reported once, so the next teardown starts clean.
  await expect(settleW4LateReleases()).resolves.toBeUndefined();
});

it('reports a late acquisition that is still pending at teardown', async () => {
  const scope = new W4Resources();
  const pending = w4Gate<number>();
  const released = w4Gate<number>();
  const acquisition = scope.acquire(pending.promise, released.resolve);
  const rejected = expect(acquisition).rejects.toThrow('stop setup');
  await scope.cancel(new Error('stop setup'));
  await rejected;
  await expect(settleW4LateReleases(20)).rejects.toMatchObject({
    errors: [
      expect.objectContaining({
        message: '1 W4 late release(s) still pending after 20ms.',
      }),
    ],
  });
  pending.resolve(1);
  await expect(released.promise).resolves.toBe(1);
  await expect(settleW4LateReleases()).resolves.toBeUndefined();
});

it('reports a late failure registered while a settle is already waiting', async () => {
  const outer = w4Gate<void>();
  const inner = w4Gate<void>();
  const nested = new Error('nested late cleanup sentinel');
  trackW4LateCleanup(
    outer.promise.then(() => {
      trackW4LateCleanup(
        inner.promise.then(() => Promise.reject(nested)),
        'nested stop',
      );
    }),
    'outer stop',
  );
  const settling = settleW4LateReleases();
  outer.resolve();
  // The settle sees the outer release finish while the nested one is pending.
  await new Promise<void>((resolve) => setImmediate(resolve));
  inner.resolve();
  await expect(settling).rejects.toMatchObject({
    errors: [
      expect.objectContaining({
        message: 'W4 late release after "nested stop" failed.',
        cause: nested,
      }),
    ],
  });
});

it('reports each late failure once across concurrent settles', async () => {
  const gate = w4Gate<void>();
  const sentinel = new Error('concurrent late cleanup sentinel');
  trackW4LateCleanup(
    gate.promise.then(() => Promise.reject(sentinel)),
    'concurrent stop',
  );
  const settles = Promise.allSettled([
    settleW4LateReleases(),
    settleW4LateReleases(),
  ]);
  gate.resolve();
  const outcomes = await settles;
  const rejected = outcomes.filter(({ status }) => status === 'rejected');
  expect(rejected).toMatchObject([
    { status: 'rejected', reason: { errors: [{ cause: sentinel }] } },
  ]);
  await expect(settleW4LateReleases()).resolves.toBeUndefined();
});

it('preserves cancellation and cleanup failures when acquisition wins the abort race', async () => {
  const scope = new W4Resources();
  const pending = w4Gate<number>();
  const primary = new Error('cancelled after acquisition completed');
  const cleanup = new Error('late cleanup failed');
  const release = jest.fn(() => {
    throw cleanup;
  });
  const acquisition = scope.acquire(pending.promise, release);
  const rejected = expect(acquisition).rejects.toMatchObject({
    errors: [primary, cleanup],
  });
  pending.resolve(1);
  await scope.cancel(primary);
  await rejected;
  expect(release).toHaveBeenCalledTimes(1);
});
