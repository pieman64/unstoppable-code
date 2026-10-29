import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Same production initializer and actual renderer console-message forwarding;
// no delay injection and no new IPC. Existing isolation spec stays untouched.
test('renderer error burst and preferences IPC do not append synchronously on main', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  const logPath = path.join(userDataDir, 'logs', 'main.log');
  const marker = `async-main-burst-${test.info().workerIndex}-${Date.now()}`;
  let restore = false;
  try {
    const window = await electronApp.firstWindow();
    await expect
      .poll(() => window.evaluate(() => typeof window.api?.loadPreferences))
      .toBe('function');
    await electronApp.evaluate(async (_, ownedPath) => {
      const fs = process.getBuiltinModule('node:fs');
      const original = fs.writeFileSync;
      globalThis.__mainLogSyncProbe = {
        count: 0,
        restore: () => {
          fs.writeFileSync = original;
        },
      };
      fs.writeFileSync = function (file, data, ...rest) {
        if (file === ownedPath && String(data).includes('async-main-burst-'))
          globalThis.__mainLogSyncProbe.count += 1;
        return original.call(this, file, data, ...rest);
      };
    }, logPath);
    restore = true;
    await window.evaluate(async (id) => {
      for (let index = 0; index < 32; index += 1)
        console.error(`${id}:${index}`);
      await window.api.loadPreferences();
    }, marker);
    await expect
      .poll(() => readFileSync(logPath, 'utf8'))
      .toContain(`${marker}:31`);
    const count = await electronApp.evaluate(
      () => globalThis.__mainLogSyncProbe.count,
    );
    expect(count, 'recurring actual main.log sync appends').toBe(0);
  } finally {
    if (restore)
      await electronApp.evaluate(() => {
        globalThis.__mainLogSyncProbe.restore();
        delete globalThis.__mainLogSyncProbe;
      });
    await closeCanopy(electronApp, userDataDir);
  }
});
