import { WatcherDeliveryDeduplicator } from '../watcherDeliveryDeduplicator';

describe('WatcherDeliveryDeduplicator', () => {
  it('acknowledges retries immediately without running a pending delivery twice', async () => {
    const acknowledge = jest.fn(() => Promise.resolve());
    const deduplicator = new WatcherDeliveryDeduplicator(acknowledge);
    const delivery = { watcherId: 'watcher-1', deliveryId: 'delivery-1' };

    expect(deduplicator.begin(delivery)).toBe(true);
    expect(deduplicator.begin(delivery)).toBe(false);
    await Promise.resolve();

    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(acknowledge).toHaveBeenNthCalledWith(1, {
      ...delivery,
      stage: 'received',
      ok: true,
    });
    expect(acknowledge).toHaveBeenNthCalledWith(2, {
      ...delivery,
      stage: 'received',
      ok: true,
    });
  });

  it('replays the final acknowledgement when a completed delivery is retried', async () => {
    const acknowledge = jest.fn(() => Promise.resolve());
    const deduplicator = new WatcherDeliveryDeduplicator(acknowledge);
    const delivery = { watcherId: 'watcher-1', deliveryId: 'delivery-1' };

    expect(deduplicator.begin(delivery)).toBe(true);
    deduplicator.complete(delivery, { ok: true });
    await Promise.resolve();
    await Promise.resolve();
    acknowledge.mockClear();

    expect(deduplicator.begin(delivery)).toBe(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(acknowledge.mock.calls).toEqual([
      [
        {
          ...delivery,
          stage: 'received',
          ok: true,
        },
      ],
      [
        {
          ...delivery,
          stage: 'completed',
          ok: true,
        },
      ],
    ]);
  });

  it('reports a failed delivery after its receipt acknowledgement settles', async () => {
    let settleReceipt: (() => void) | undefined;
    const acknowledge = jest
      .fn<Promise<void>, [unknown]>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            settleReceipt = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const deduplicator = new WatcherDeliveryDeduplicator(acknowledge);
    const delivery = { watcherId: 'watcher-1', deliveryId: 'delivery-1' };

    expect(deduplicator.begin(delivery)).toBe(true);
    deduplicator.complete(delivery, { ok: false, error: 'chat unavailable' });
    await Promise.resolve();
    expect(acknowledge).toHaveBeenCalledTimes(1);

    settleReceipt?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(acknowledge).toHaveBeenLastCalledWith({
      ...delivery,
      stage: 'completed',
      ok: false,
      error: 'chat unavailable',
    });

    expect(deduplicator.begin(delivery)).toBe(true);
  });

  it('accepts a pending delivery again after its completion window expires', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-03T00:00:00.000Z'));
    const acknowledge = jest.fn(() => Promise.resolve());
    const deduplicator = new WatcherDeliveryDeduplicator(acknowledge);
    const delivery = { watcherId: 'watcher-1', deliveryId: 'delivery-1' };

    expect(deduplicator.begin(delivery)).toBe(true);
    jest.setSystemTime(new Date('2026-09-03T00:31:00.000Z'));

    expect(deduplicator.begin(delivery)).toBe(true);
    jest.useRealTimers();
  });
});
