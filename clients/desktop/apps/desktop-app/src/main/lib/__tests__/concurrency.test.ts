import { mapWithConcurrency, normalizeLimit } from '../concurrency';

describe('normalizeLimit', () => {
  it('keeps a positive integer and floors a fractional one', () => {
    expect(normalizeLimit(4)).toBe(4);
    expect(normalizeLimit(2.9)).toBe(2);
  });

  it('treats anything that is not a positive finite number as one', () => {
    for (const limit of [Number.NaN, 0, -3, Number.POSITIVE_INFINITY, 0.5]) {
      expect(normalizeLimit(limit)).toBe(1);
    }
  });
});

describe('mapWithConcurrency', () => {
  it('runs at most the given number of tasks at once and keeps input order', async () => {
    let running = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const results = mapWithConcurrency([1, 2, 3, 4, 5], 2, (item) => {
      running += 1;
      peak = Math.max(peak, running);
      return new Promise<number>((resolve) => {
        releases.push(() => {
          running -= 1;
          resolve(item * 10);
        });
      });
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(releases).toHaveLength(2);
    // Finish the most recently started task first each time: results must
    // still land in input order, not completion order.
    while (releases.length > 0) {
      releases.pop()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(await results).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
  });

  it('resolves to an empty list for no items', async () => {
    expect(
      await mapWithConcurrency([], 4, () => Promise.resolve('never')),
    ).toEqual([]);
  });

  it('accepts a readonly list', async () => {
    const items: readonly number[] = [1, 2];
    expect(
      await mapWithConcurrency(items, 2, (item) => Promise.resolve(item + 1)),
    ).toEqual([2, 3]);
  });

  it('starts no more workers than there are items', async () => {
    let running = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2], 8, async (item) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setImmediate(resolve));
      running -= 1;
      return item;
    });
    expect(results).toEqual([1, 2]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('treats a limit that is not a positive number as one worker', async () => {
    const seen: number[] = [];
    for (const limit of [Number.NaN, 0, -3]) {
      const results = await mapWithConcurrency([1, 2, 3], limit, (item) => {
        seen.push(item);
        return Promise.resolve(item * 10);
      });
      // Every item is still mapped; nothing silently returns a hole.
      expect(results).toEqual([10, 20, 30]);
    }
    expect(seen).toHaveLength(9);
  });

  it('rejects as a whole when one task rejects', async () => {
    // The contract every caller relies on: tasks handle their own errors;
    // an escaped rejection is a bug and surfaces, never a silent gap.
    await expect(
      mapWithConcurrency([1, 2, 3], 2, (item) =>
        item === 2 ? Promise.reject(new Error('boom')) : Promise.resolve(item),
      ),
    ).rejects.toThrow('boom');
  });
});
