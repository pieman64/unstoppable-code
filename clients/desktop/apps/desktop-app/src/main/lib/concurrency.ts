/**
 * A concurrency limit that is not a finite number of at least one means one
 * at a time, never none: `Math.max(1, NaN)` is `NaN`, and a worker count of
 * `NaN` starts no workers at all, which maps nothing and reports no error.
 */
export function normalizeLimit(limit: number): number {
  return Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
}

/**
 * Maps `items` through `mapper` with at most `concurrency` calls in flight,
 * resolving the results in input order regardless of completion order. A
 * mapper that rejects rejects the whole map: callers handle their own
 * errors, and an escaped rejection is a bug that must surface rather than
 * leave a silent gap in the results.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = normalizeLimit(concurrency);
  const indexedItems = items.map((item, index): { item: T; index: number } => ({
    item,
    index,
  }));
  const results: R[] = [];
  results.length = items.length;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < indexedItems.length) {
      const index = nextIndex;
      nextIndex += 1;
      const entry = indexedItems[index];
      if (!entry) {
        continue;
      }
      results[entry.index] = await mapper(entry.item, entry.index);
    }
  }

  const workerCount = Math.min(limit, indexedItems.length);
  await Promise.all(
    Array.from({ length: workerCount }, async (): Promise<void> => {
      await worker();
    }),
  );

  return results;
}
