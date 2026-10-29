import { mapWithConcurrency } from '../lib/concurrency';

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolveDeferred: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = resolve;
  });

  return {
    promise,
    resolve: (): void => {
      resolveDeferred?.();
    },
  };
}

describe('mapWithConcurrency', () => {
  it('preserves result order while limiting active work', async () => {
    const gates = [createDeferred(), createDeferred(), createDeferred()];
    let active = 0;
    let maxActive = 0;

    const promise = mapWithConcurrency(
      [30, 10, 20],
      2,
      async (value, index): Promise<number> => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const gate = gates[index];
        if (!gate) {
          throw new Error('Missing gate');
        }
        await gate.promise;
        active -= 1;
        return value;
      },
    );

    await Promise.resolve();
    expect(maxActive).toBe(2);
    gates[1]?.resolve();
    await Promise.resolve();
    gates[2]?.resolve();
    gates[0]?.resolve();

    await expect(promise).resolves.toEqual([30, 10, 20]);
    expect(maxActive).toBe(2);
  });

  it('propagates mapper errors', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, (value): Promise<number> => {
        if (value === 2) {
          return Promise.reject(new Error('boom'));
        }
        return Promise.resolve(value);
      }),
    ).rejects.toThrow('boom');
  });

  it('maps explicit undefined values instead of skipping them', async () => {
    const visited: number[] = [];

    await expect(
      mapWithConcurrency(
        ['a', undefined, 'c'],
        2,
        (value, index): Promise<string> => {
          visited.push(index);
          return Promise.resolve(value ?? `missing-${index}`);
        },
      ),
    ).resolves.toEqual(['a', 'missing-1', 'c']);

    expect(visited).toEqual([0, 1, 2]);
  });
});
