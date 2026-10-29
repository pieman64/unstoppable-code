import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

test('keeps E2E main-process logging inside the launch data directory', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  const logPath = path.join(userDataDir, 'logs', 'main.log');

  try {
    await expect.poll(() => existsSync(logPath)).toBe(true);
    await expect
      .poll(() => readFileSync(logPath, 'utf8'))
      .toContain('Main process file logging initialized');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
