import { singleFlight } from '../lib/single-flight';

describe('singleFlight', () => {
  it('runs one in-flight call and hands the same promise to concurrent callers', async () => {
    let runs = 0;
    const release: { current: (() => void) | null } = { current: null };
    const run = singleFlight(
      () =>
        new Promise<void>((resolve) => {
          runs += 1;
          release.current = resolve;
        }),
    );

    const first = run();
    const second = run();
    expect(second).toBe(first);
    expect(runs).toBe(1);

    release.current?.();
    await first;

    // Once settled, the next call starts a fresh run.
    void run();
    expect(runs).toBe(2);
  });

  it('releases the slot when the run rejects', async () => {
    let attempts = 0;
    const run = singleFlight(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('first fails'))
        : Promise.resolve();
    });

    await expect(run()).rejects.toThrow('first fails');
    await expect(run()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });
});
