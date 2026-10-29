import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  trackFastRefresh,
  waitForFastRefreshQuiet,
} from '../portal/fastRefresh.mjs';

test('tracks only Next.js Fast Refresh console activity', async () => {
  let consoleListener = null;
  const page = {
    on: (event, listener) => {
      assert.equal(event, 'console');
      consoleListener = listener;
    },
  };
  const tracker = trackFastRefresh(page);
  tracker.lastActivityAt = 0;

  consoleListener({ text: () => 'ordinary application log' });
  assert.equal(tracker.lastActivityAt, 0);

  consoleListener({ text: () => '[Fast Refresh] rebuilding' });
  assert.ok(tracker.lastActivityAt > 0);
  assert.equal(
    await waitForFastRefreshQuiet(tracker, { quietMs: 0, capMs: 1 }),
    undefined,
  );
});

test('does not report quiet while a Fast Refresh rebuild is in flight', async () => {
  let consoleListener = null;
  const page = {
    on: (_event, listener) => {
      consoleListener = listener;
    },
  };
  const tracker = trackFastRefresh(page);
  tracker.lastActivityAt = 0;

  consoleListener({ text: () => '[Fast Refresh] rebuilding' });
  let settled = false;
  const quiet = waitForFastRefreshQuiet(tracker, {
    quietMs: 0,
    capMs: 1_000,
  }).then(() => {
    settled = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(settled, false);

  consoleListener({ text: () => '[Fast Refresh] done in 12045ms' });
  await quiet;
  assert.equal(settled, true);
});
