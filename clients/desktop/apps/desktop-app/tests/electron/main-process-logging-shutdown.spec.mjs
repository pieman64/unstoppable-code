import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

test('normal owned quit persists renderer burst and OUTER runtime completion tail', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  const marker = `main-log-quit-tail-${Date.now()}`;
  try {
    const window = await electronApp.firstWindow();
    await expect
      .poll(() => window.evaluate(() => typeof window.api?.loadPreferences))
      .toBe('function');
    await window.evaluate(async (id) => {
      for (let index = 0; index < 32; index += 1)
        console.error(`${id}:${index}`);
      await window.api.loadPreferences();
    }, marker);
    // Observe actual exit before any harness fallback/reaping can supply it.
    const closed = electronApp.waitForEvent('close', { timeout: 25_000 });
    await electronApp.evaluate(({ app }) => {
      setImmediate(() => app.quit());
    });
    await closed;
    const text = readFileSync(
      path.join(userDataDir, 'logs', 'main.log'),
      'utf8',
    );
    let previous = -1;
    for (let index = 0; index < 32; index += 1) {
      const offset =
        new RegExp(`${marker}:${index}(?!\\d)`).exec(text)?.index ?? -1;
      expect(offset).toBeGreaterThan(previous);
      previous = offset;
    }
    // inspect output is multiline on some library/Node versions; bound to the
    // last shutdown entry rather than assuming JSON serialization.
    const tail = text.slice(text.lastIndexOf('[shutdown]'));
    expect(tail).toMatch(/cleanupStage: ['"]runtime['"]/);
    expect(tail).toMatch(/cleanupStatus: ['"]completed['"]/);
  } finally {
    // Preserve data/artifacts for root inspection even when assertions fail.
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
  }
});
