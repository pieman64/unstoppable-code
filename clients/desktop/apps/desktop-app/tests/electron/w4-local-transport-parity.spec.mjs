import { test as base } from '@playwright/test';
import { runW4Jest } from './helpers/w4-jest.mjs';

const test = base.extend({
  // Teardown (including a Playwright timeout) cancels the child and awaits it.
  w4Jest: async ({}, use, testInfo) => {
    const controller = new AbortController();
    let running;
    try {
      await use((options) => {
        running = runW4Jest(testInfo, {
          ...options,
          signal: controller.signal,
        });
        return running;
      });
    } finally {
      controller.abort();
      await running?.catch(() => undefined);
    }
  },
});

test('L4 fixture local-transport parity (not L2 persisted-scope production proof)', async ({
  w4Jest,
}) => {
  test.skip(
    process.platform !== 'darwin',
    'Overall W4 fixture integration uses the existing macOS allocation. Native endpoint differences are PlatformServices contracts.',
  );
  test.setTimeout(300_000);
  await w4Jest({ timeoutMs: 240_000 });
});
