import { KeyedAsyncLock } from '../keyed-async-lock';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

it('withdraws a cancelled waiter without unlocking its active predecessor or running stale work', async () => {
  const lock = new KeyedAsyncLock();
  const held = deferred();
  const started = deferred();
  const owner = lock.run('workspace', async () => {
    started.resolve();
    await held.promise;
  });
  await started.promise;
  const controller = new AbortController();
  const stale = jest.fn(() => Promise.resolve());
  const cancelled = lock.run('workspace', stale, controller.signal);
  const rejected = expect(cancelled).rejects.toThrow('retired');
  controller.abort(new Error('retired'));
  await rejected;
  // Enqueue after cancellation has settled, while the original owner is held.
  const successor = jest.fn(() => Promise.resolve());
  const next = lock.run('workspace', successor);
  let drained = false;
  const drain = lock.wait('workspace').then(() => {
    drained = true;
  });
  try {
    await lock.run('other-workspace', () => Promise.resolve());
    expect(stale).not.toHaveBeenCalled();
    expect(successor).not.toHaveBeenCalled();
    expect(drained).toBe(false);
  } finally {
    held.resolve();
    await Promise.all([owner, next, drain]);
  }
  expect(successor).toHaveBeenCalledTimes(1);
  expect(stale).not.toHaveBeenCalled();
});

it('finishes an active commit before admitting the next operation even if its signal aborts', async () => {
  const lock = new KeyedAsyncLock();
  const held = deferred();
  const started = deferred();
  const controller = new AbortController();
  const owner = lock.run(
    'workspace',
    async () => {
      started.resolve();
      await held.promise;
      return 'committed';
    },
    controller.signal,
  );
  await started.promise;
  const successor = jest.fn(() => Promise.resolve());
  const next = lock.run('workspace', successor);
  controller.abort();
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(successor).not.toHaveBeenCalled();
  } finally {
    held.resolve();
    expect(await owner).toBe('committed');
    await next;
  }
});

it('rejects an already cancelled admission and continues after a failed owner', async () => {
  const lock = new KeyedAsyncLock();
  const controller = new AbortController();
  controller.abort(new Error('retired'));
  const stale = jest.fn(() => Promise.resolve());
  await expect(lock.run('workspace', stale, controller.signal)).rejects.toThrow(
    'retired',
  );
  expect(stale).not.toHaveBeenCalled();
  await expect(
    lock.run('workspace', () => Promise.reject(new Error('failed'))),
  ).rejects.toThrow('failed');
  expect(await lock.run('workspace', () => Promise.resolve('later'))).toBe(
    'later',
  );
});
