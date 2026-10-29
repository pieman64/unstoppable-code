import { retryDynamicImport } from '../retryDynamicImport';

describe('retryDynamicImport', () => {
  it('retries a failed load before resolving', async () => {
    let calls = 0;

    const result = await retryDynamicImport(
      () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(new Error('net::ERR_NETWORK_CHANGED'));
        }
        return Promise.resolve({ default: 'loaded' });
      },
      { delaysMs: [0] },
    );

    expect(result).toEqual({ default: 'loaded' });
    expect(calls).toBe(2);
  });

  it('throws after retries are exhausted', async () => {
    let calls = 0;
    const error = new Error('Failed to fetch dynamically imported module');

    await expect(
      retryDynamicImport(
        () => {
          calls += 1;
          return Promise.reject(error);
        },
        { delaysMs: [0, 0] },
      ),
    ).rejects.toBe(error);

    expect(calls).toBe(3);
  });
});
