import {
  runWithWatcherDeliveryTimeout,
  WatcherDeliveryScheduler,
  WatcherDeliveryTimeoutError,
} from '../watcherDeliveryScheduler';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe('WatcherDeliveryScheduler', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs deliveries for different chats while an earlier chat is still pending', async () => {
    const scheduler = new WatcherDeliveryScheduler({
      maxConcurrent: 2,
      timeoutMs: 60_000,
    });
    const hung = deferred();
    const started: string[] = [];

    void scheduler.schedule('chat-a', async () => {
      started.push('a');
      await hung.promise;
    });
    const healthy = scheduler.schedule('chat-b', () => {
      started.push('b');
      return Promise.resolve();
    });

    await expect(healthy).resolves.toBeUndefined();
    expect(started).toEqual(['a', 'b']);
    hung.resolve();
  });

  it('preserves delivery order within one chat', async () => {
    const scheduler = new WatcherDeliveryScheduler({
      maxConcurrent: 4,
      timeoutMs: 60_000,
    });
    const first = deferred();
    const events: string[] = [];

    const firstDone = scheduler.schedule('chat-a', async () => {
      events.push('first:start');
      await first.promise;
      events.push('first:end');
    });
    const secondDone = scheduler.schedule('chat-a', () => {
      events.push('second');
      return Promise.resolve();
    });

    await flush();
    expect(events).toEqual(['first:start']);
    first.resolve();
    await Promise.all([firstDone, secondDone]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  it('caps concurrent deliveries across chats', async () => {
    const scheduler = new WatcherDeliveryScheduler({
      maxConcurrent: 2,
      timeoutMs: 60_000,
    });
    const gates = [deferred(), deferred(), deferred(), deferred()];
    let running = 0;
    let peak = 0;
    const started: number[] = [];

    const done = gates.map((gate, index) =>
      scheduler.schedule(`chat-${index}`, async () => {
        started.push(index);
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
      }),
    );

    await flush();
    expect(started).toEqual([0, 1]);
    gates[0]?.resolve();
    await flush();
    expect(started).toEqual([0, 1, 2]);
    for (const gate of gates) gate.resolve();
    await Promise.all(done);
    expect(started).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });

  it('times out a hung delivery and releases its chat and its slot', async () => {
    jest.useFakeTimers();
    const scheduler = new WatcherDeliveryScheduler({
      maxConcurrent: 1,
      timeoutMs: 1_000,
    });
    const started: string[] = [];

    const hung = scheduler.schedule('chat-a', async () => {
      started.push('hung');
      await new Promise<void>(() => undefined);
    });
    const sameChat = scheduler.schedule('chat-a', () => {
      started.push('same-chat');
      return Promise.resolve();
    });
    const otherChat = scheduler.schedule('chat-b', () => {
      started.push('other-chat');
      return Promise.resolve();
    });
    const hungResult = hung.catch((error: unknown) => error);

    await flush();
    expect(started).toEqual(['hung']);
    jest.advanceTimersByTime(1_000);

    expect(await hungResult).toBeInstanceOf(WatcherDeliveryTimeoutError);
    await Promise.all([sameChat, otherChat]);
    expect(started).toEqual(['hung', 'other-chat', 'same-chat']);
  });

  it('reports delivery failures without blocking later deliveries', async () => {
    const scheduler = new WatcherDeliveryScheduler({
      maxConcurrent: 1,
      timeoutMs: 60_000,
    });

    await expect(
      scheduler.schedule('chat-a', () =>
        Promise.reject(new Error('Destination unavailable.')),
      ),
    ).rejects.toThrow('Destination unavailable.');
    await expect(
      scheduler.schedule('chat-a', () => Promise.resolve()),
    ).resolves.toBeUndefined();
  });
});

describe('runWithWatcherDeliveryTimeout', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects when the delivery does not settle in time', async () => {
    jest.useFakeTimers();
    const result = runWithWatcherDeliveryTimeout(
      () => new Promise<void>(() => undefined),
      500,
    ).catch((error: unknown) => error);

    jest.advanceTimersByTime(500);

    const error = await result;
    expect(error).toBeInstanceOf(WatcherDeliveryTimeoutError);
    expect(error).toHaveProperty(
      'message',
      'Timed out delivering the watcher message.',
    );
  });

  it('passes through a delivery that settles in time', async () => {
    await expect(
      runWithWatcherDeliveryTimeout(() => Promise.resolve('sent'), 500),
    ).resolves.toBe('sent');
  });
});
